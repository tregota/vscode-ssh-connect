import * as vscode from 'vscode';
import { Client, AuthHandlerResult } from 'ssh2';
import { Server, Socket } from 'net';
import SSHTerminal from './SSHTerminal';
import { readFileSync } from 'fs';
import { ConnectionNode, PortForwardNode } from './SSHConnectProvider';
import * as keytar from 'keytar';
import { PortForwardConfig } from './ConnectionConfig';

export interface PortForward {
	status: 'offline' | 'connecting' | 'online' | 'error'
	server: Server
	port?: number
	close: () => void
}

export interface Connection {
	status: 'offline' | 'connecting' | 'online' | 'error'
	client: Client
	terminals: Set<SSHTerminal | vscode.Terminal>
	ports: { [id: string]: PortForward }
	node: ConnectionNode
	promise?: Promise<Connection>
}

type AuthHandler = (methodsLeft: string[] | null, partialSuccess: boolean | null, callback: (nextAuth: AuthHandlerResult) => void) => void | AuthHandlerResult;

export default class ConnectionsProvider {

	private _onDidChange: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

	public connections: { [id: string]: Connection } = {};
	public ports: { [port: number]: PortForward } = {};

	constructor(private readonly outputChannel: vscode.OutputChannel) {
	}

  public refresh(): void {
    this._onDidChange.fire();
  }

  public getConnection(node: ConnectionNode): Connection | undefined {
		return this.connections[node.id];
	}
  public getPortForward(node: PortForwardNode): PortForward | undefined {
		const parentNode = <ConnectionNode>node.parent;
		const parentConnection = this.getConnection(parentNode);
		return parentConnection?.ports[node.id];
	}

  public getConnectionStatus(node: ConnectionNode): string {
		return this.getConnection(node)?.status || 'offline';
	}
  public getPortStatus(node: PortForwardNode): string {
		return this.getPortForward(node)?.status || 'offline';
	}

	
	/**
	 * Connect to a server
	 * @param node 
	 */
  public connect(node: ConnectionNode): Promise<Connection> {
		if (!node?.id) {
			return Promise.reject(new Error('No connection provided'));
		}
		if (node.id in this.connections && ['online', 'connecting'].includes(this.connections[node.id].status)) {
			const existingPromise = this.connections[node.id].promise;
			if(existingPromise) {
				return existingPromise;
			}
		}

		const promise = new Promise<Connection>((resolve, reject) => {
			// reconnect or new connection?
			this.outputChannel.appendLine(`${node.id}: connecting...`);
			if (node.id in this.connections) {
				this.connections[node.id].status = 'connecting';
				this.connections[node.id].client = new Client();
				this.connections[node.id].terminals = new Set();
				this.connections[node.id].ports = {};
			}
			else {
				this.connections[node.id] = {
					status: 'connecting',
					client: new Client(),
					terminals: new Set(),
					ports: {},
					node
				};
			}
			this.refresh();

			const failedToConnect = (error?: Error) => {
				reject(error);
				this.connections[node.id].status = 'offline';
				this.refresh();
			};

			if (!node.config.username) {
				return failedToConnect(new Error('Username required'));
			}
			if (!node.config.host) {
				return failedToConnect(new Error('Host required'));
			}

			let loginCancelCts = new vscode.CancellationTokenSource();
			const client = this.connections[node.id].client;
			let enteredPassword: string;
			let triedWithStoredPassword = false;
			let neverWithStoredPassword = false;

			// on successfull connection
			client.on('ready', () => {
				this.outputChannel.appendLine(`${node.id}: online.`);
				this.connections[node.id].status = 'online';
				this.refresh();
				resolve(this.connections[node.id]);
				this.autoForwardPorts(node);
				if (enteredPassword && !neverWithStoredPassword) {
					// if there was a stored password but the user had to enter something else
					if (triedWithStoredPassword) {
						keytar.deletePassword('vscode-ssh-connect', node.id);
					}
					vscode.window.showInformationMessage("Do you want to save the password in system keychain?", "Yes", "No", `Never for ${node.name}`).then(answer => {
						if (answer === "Yes") {
							keytar.setPassword('vscode-ssh-connect', node.id, enteredPassword);
							vscode.window.showInformationMessage("Saved");
						}
						else if (answer === `Never for ${node.name}`)  {
							keytar.setPassword('vscode-ssh-connect', node.id, '%%NEVER%%');
						}
  				});
				}
			});
			
			// on failed or closed connection
			client.on('close', (hadError) => {
				this.outputChannel.appendLine(`${node.id}: closed${hadError ? ' with error' : ''}`);
				this.connections[node.id].status = 'offline';
				this.refresh();
			});
			// on failed or closed connection
			client.on("end", () => {
				this.outputChannel.appendLine(`${node.id}: ended.`);
			});
			
			// print connection errors
			client.on('error', (error) => {
				if (this.connections[node.id].status === 'connecting') {
					loginCancelCts.cancel();
					return failedToConnect(error);
				}
				else {
					this.outputChannel.appendLine(`${node.id}: ${error.message}`);
					vscode.window.showErrorMessage(`${node.id}: ${error.message}`);
				}
			});
			
      // handle incoming x11 connections
			const x11Port = node.config.x11Port;
			if (x11Port !== undefined) {
				client.on('x11', (info, accept, reject) => {
					const xserversock = new Socket();
					xserversock.on('connect', () => {
						const xclientsock = accept();
						xclientsock.pipe(xserversock).pipe(xclientsock);
					}).connect(x11Port, 'localhost');
				});
			}

			// auth handler to try various auth methods
			let triedMethods: string[] = [];
			const authHandler: AuthHandler = (methodsLeft, partialSuccess, callback) => {
				if (methodsLeft === null) {
					return callback({
						type: 'none',
						username: node.config.username!
					});
				}
				if (methodsLeft.includes('publickey') && (node.config.privateKey || node.config.agent)) {
					if (node.config.privateKey && !triedMethods.includes('publickey')){
						triedMethods.push('publickey');
						try {
							const key = readFileSync(node.config.privateKey);
							return callback({
								type: 'publickey',
								username: node.config.username!,
								key,
								passphrase: node.config.passphrase
							});
						}
						catch(error) {
							this.outputChannel.appendLine(`${node.id}: privateKey error - ${error.message}`);
							vscode.window.showErrorMessage(`${node.id}: privateKey error - ${error.message}`);
							// continue to next method
						}
					}
					else if (node.config.agent && !triedMethods.includes('agent')) {
						triedMethods.push('agent');
						return callback({
							type: 'agent',
							username: node.config.username!,
							agent: node.config.agent
						});
					}
				}
				
				if (methodsLeft.includes('hostbased') && node.config.localUsername && !triedMethods.includes('hostbased')) {
					// I'm not sure how this works and the docs and AuthHandlerResult type doesn't agree, so we'll have to see what happens if someone tries it
					triedMethods.push('hostbased');
					if (node.config.privateKey) {
						try {
							const key = readFileSync(node.config.privateKey);
							callback(<any>{
								type: 'hostbased',
								username: node.config.username!,
								key,
								passphrase: node.config.passphrase,
								localUsername: node.config.localUsername,
								localHostname: node.config.localHostname
							});
						}
						catch(error) {
							this.outputChannel.appendLine(`${node.id}: hostbased error - ${error.message}`);
							vscode.window.showErrorMessage(`${node.id}: hostbased error - ${error.message}`);
							callback(false);
						}
					}
					else {
						callback(<any>{
							type: 'hostbased',
							username: node.config.username!,
							localUsername: node.config.localUsername,
							localHostname: node.config.localHostname
						});
					}
				}
				else if (methodsLeft.includes('password') && (!triedMethods.includes('password') || triedWithStoredPassword)) {
					triedMethods.push('password');
					if(node.config.password) {
						callback({
							type: 'password',
							username: node.config.username!,
							password: node.config.password
						});
					}
					else {
						let storedPassword: string | null;
						keytar.getPassword('vscode-ssh-connect', node.id).then((setStoredPassword: string | null) => storedPassword = setStoredPassword).finally(() => {
							if (storedPassword && !triedWithStoredPassword) {
								neverWithStoredPassword = storedPassword === '%%NEVER%%';
								if (!neverWithStoredPassword) {
									triedWithStoredPassword = true;
									return callback({
										type: 'password',
										username: node.config.username!,
										password: storedPassword
									});
								}
							}
							triedWithStoredPassword = false; // so it doesn't try password auth 3 times
							const inputOptions = {
								title: `${node.name} - password`,
								placeHolder: 'Enter password',
								password: true,
								ignoreFocusOut: true
							};
							vscode.window.showInputBox(inputOptions, loginCancelCts.token).then(
								(password) => {
									if (password === undefined) {
										client.end();
										return failedToConnect(new Error('Login canceled'));
									}
									enteredPassword = password;
									callback({
										type: 'password',
										username: node.config.username!,
										password
									});
								}
							);
							return;
						});
					}
				}
				else if (methodsLeft.includes('keyboard-interactive') && (!triedMethods.includes('keyboard-interactive') || triedWithStoredPassword)) {
					triedMethods.push('keyboard-interactive');
					callback({
						type: 'keyboard-interactive',
						username: node.config.username!,
						prompt: async (name, instructions, instructionsLang, prompts, finish) => {
							const responses: string[] = [];
							for (const prompt of prompts) {
								const requested = prompt.prompt.replace(': ', '').toLowerCase();
								const storedPassword = await keytar.getPassword('vscode-ssh-connect', node.id);
								neverWithStoredPassword = storedPassword === '%%NEVER%%';
								if (requested === "password" && node.config.password) {
									responses.push(node.config.password);
								}
								else if (requested === "password" && storedPassword && !neverWithStoredPassword && !triedWithStoredPassword) {
									triedWithStoredPassword = true;
									responses.push(storedPassword!);
								}
								else {
									triedWithStoredPassword = false;
									const inputOptions = {
										title: `${node.name} - ${requested}`,
										placeHolder: `Enter ${requested}`,
										password: requested === 'password',
										ignoreFocusOut: true
									};
									const response = await vscode.window.showInputBox(inputOptions, loginCancelCts.token);
									if (response === undefined) {
										client.end();
										return failedToConnect(new Error('Login canceled'));
									}
									if (requested === 'password') {
										enteredPassword = response;
									}
									responses.push(response);
								}
							}
							finish(responses);
						}
					});
				}
				else {
					callback(false);
				}
			};

			// connect either via jumpServer or directly
			if (node.parent?.type === 'connection') {
				this.outputChannel.appendLine(`${node.id}: requesting parent connection...`);
				const parentNode = <ConnectionNode>node.parent;
				this.connect(parentNode).then(
					(connection) => {
						connection.client.forwardOut('127.0.0.1', 0, node.config.host || 'localhost', node.config.port || 22, (error, stream) => {
							if (error) {
								return failedToConnect(error);
							}
							client.connect({
								...node.config,
								sock: stream,
								authHandler,
								privateKey: undefined // handled by authHandler
							});
							stream.on('close', () => {
								this.outputChannel.appendLine(`${node.id}: parent stream closed.`);
							});
							stream.on('exit', (code, signal) => {
								this.outputChannel.appendLine(`${node.id}: parent stream exited. ${code}: ${signal}`);
							});
						});
					},
					(error) => {
						this.outputChannel.appendLine(`${node.id}: parent failed to connect.`);
						failedToConnect(error);
					}
				);
			}
			else {
				client.connect({
					// tryKeyboard: true,
					...node.config,
					host: node.config.host,
					port: node.config.port,
					authHandler,
					debug: node.config.enableDebug ? (info) => this.outputChannel.appendLine(`${node.id}: ${info}`) : undefined,
					privateKey: undefined // handled by authHandler
				});
			}
		});
		this.connections[node.id].promise = promise;
		return promise;
	}

	/**
	 * Disconnects a connection
	 * @param node 
	 */
	public async disconnect(node: ConnectionNode): Promise<void> {
		if (!node?.id) {
			return Promise.reject(new Error('No connection provided'));
		}
		this.outputChannel.appendLine(`${node.id}: disconnecting...`);
		const connection = this.getConnection(node);
		if (connection && connection.status === 'online') {
			connection.client.end();
		}
	}

	/**
	 * Forward ports configured to auto connect
	 * @param node 
	 */
	 private async autoForwardPorts(node: ConnectionNode): Promise<void> {
		for (const childNode of node.children.filter((child) => child.type === 'portForward' && (<PortForwardNode>child).portForward.autoConnect)) {
			await this.openPort(<PortForwardNode>childNode);
		}
	}

	/**
	 * Opens a port and forwards according to the configuration
	 * @param node 
	 * @returns 
	 */
	public async openPort(node: PortForwardNode): Promise<void> {
		const parentNode = <ConnectionNode>node.parent;
		try {
			const connection = await this.connect(parentNode);

			if (connection.ports[node.id]?.status === 'online') {
				return;
			}

			if (node.portForward.srcPort! in this.ports) {
				this.ports[node.portForward.srcPort!].close();
			}

			connection.ports[node.id] = this.forwardPort(connection, node.portForward);
			this.refresh();
			connection.ports[node.id].server.on('close', () => { this.refresh(); });
			connection.ports[node.id].server.on('listening', () => { this.refresh(); });
		}
		catch (error) {
			this.outputChannel.appendLine(`${parentNode.id}: ${error.message}`);
			vscode.window.showErrorMessage(`${parentNode.id}: ${error.message}`);
		}
	}

	public forwardPortAndWait(connection: Connection, options: Partial<PortForwardConfig>): Promise<PortForward> {
		return new Promise((resolve, reject) => {
			const portForward = this.forwardPort(connection, options);
			portForward.server.on('listening', () => {
				resolve(portForward);
			});
			portForward.server.on('error', (error) => {
				reject(error);
			});
		});
	}

	private forwardPort(connection: Connection, options: Partial<PortForwardConfig>): PortForward {
		const portForwardSockets = new Set<Socket>();
		const portForward: PortForward = {
			status: 'connecting',
			port: options.srcPort,
			server: new Server(),
			close: () => {
				if (portForward.server.listening) {
					for (const socket of portForwardSockets) {
						socket.destroy();
					}
					portForward.server.close();
				}
			}
		};

		// setup a forward streams for each new connection
		portForward.server.on('connection', (socket) => {
			portForwardSockets.add(socket);
			connection.client.forwardOut(socket.remoteAddress || '', socket.remotePort || 0, options.dstAddr || 'localhost', options.dstPort || 22, (error, stream) => {
				if (error) {
					this.outputChannel.appendLine(`forwardPort: ${error.message}`);
					vscode.window.showErrorMessage(`forwardPort: ${error.message}`);
					socket.destroy();
					return;
				}
				socket.pipe(stream).pipe(socket);
			});
			socket.on("close", () => {
				portForwardSockets.delete(socket);
			});
		});
		
		portForward.server.on('error', (error) => {
			if (portForward.status === 'connecting') {
				portForward.status = 'error';
				portForward.server.close();
			}
			this.outputChannel.appendLine(`forwardPort: ${error.message}`);
			vscode.window.showErrorMessage(`forwardPort: ${error.message}`);
		});

		portForward.server.on('close', () => {
			if (portForward.status !== 'error') {
				portForward.status = 'offline';
			}
		});

		// if successful in opening port. setup a event listener to close the port forward server and its sockets when the connection is closed
		portForward.server.on('listening', () => {
			portForward.status = 'online';
			connection.client.on('close', () => {
				if (portForward.server.listening) {
					for (const socket of portForwardSockets) {
						socket.destroy();
					}
					portForward.server.close();
				}
			});

			const address = portForward.server.address();
			if (address && typeof address !== 'string') {
				portForward.port = address.port;
			}
			if (portForward.port) {
				this.ports[portForward.port] = portForward;
			}
		});

		// listen 
		portForward.server.listen(options.srcPort);

		return portForward;
	}

	/**
	 * Discconnects a port forwarding
	 * @param node 
	 */
	public async closePort(node: PortForwardNode): Promise<void> {
		const portForward = this.getPortForward(node);
		if (portForward?.status === 'online') {
			portForward.close();
		}
	}

	public async openTerminal(node: ConnectionNode): Promise<void> {
		try {
			const connection = await this.connect(node);
			const terminal = new SSHTerminal(this, connection);
			connection.terminals.add(terminal);
			terminal.onDidClose(() => {
				connection.terminals.delete(terminal);
			});
		}
		catch (error) {
			this.outputChannel.appendLine(`${node.id}: ${error.message}`);
			vscode.window.showErrorMessage(`${node.id}: ${error.message}`);
		}
	}

	// public async openRemoteSSH(node: ConnectionNode): Promise<void> {
	// 	try {
		
	// 	this doesn't work nearly good enough
	// 	since it cannot handle login
	// 	if only it could be done via a ssh2 shell session

	// 			const connection = await this.connect(node);
	// 			const portForward = await this.forwardPortAndWait(connection, { dstPort: node.config.port });
	// 			vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`vscode-remote://ssh-remote+${node.config.username}@localhost:${portForward.port}/root/`), {
	// 				forceNewWindow: true
	// 			});
	// 	}
	// 	catch (error) {
	// 		this.outputChannel.appendLine(`${node.name}: ${error.message}`);
	// 		vscode.window.showErrorMessage(`${node.name}: ${error.message}`);
	// 	}
	// }

	public readRemoteFile(node: ConnectionNode, filePath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const connection = this.getConnection(node);
			if (connection?.status !== 'online') {
				return reject(new Error('Connection is not online'));
			}
			connection.client.sftp((error, sftp) => {
				if (error) {
					return reject(error);
				}
				sftp.readFile(filePath, (error, buffer) => {
					if (error) {
						return reject(error);
					}
					resolve(buffer.toString());
				});
			});
		});
	}
}