import * as vscode from 'vscode';
import { Client, AuthHandlerResult } from 'ssh2';
import { Server, Socket } from 'net';
import SSHTerminal from './SSHTerminal';
import { readFileSync } from 'fs';
import { ConnectionNode, PortForwardNode } from './SSHConnectProvider';
import * as keytar from 'keytar';
import { PortForwardConfig } from './ConnectionConfig';
import { exec } from 'child_process';
import { vscodeVariables } from '../utils';
const os = require('node:os');


export interface PortForward {
	status: 'offline' | 'connecting' | 'online' | 'error'
	server?: Server
	port?: number
	close: () => void
	promise?: Promise<PortForward>
}

export interface Connection {
	status: 'offline' | 'connecting' | 'online' | 'error'
	client?: Client
	terminals: Set<SSHTerminal | vscode.Terminal>
	ports: { [id: string]: PortForward }
	node: ConnectionNode
	loginContext?: {
		triedMethods: string[]
		enteredPassword?: string
		triedWithStoredPassword: boolean
		neverWithStoredPassword: boolean
		loginCancelCts: vscode.CancellationTokenSource
		abort: () => void
	}
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
  public async connect(node: ConnectionNode): Promise<Connection> {
		if (!node?.id) {
			return Promise.reject(new Error('No connection provided'));
		}
		if (node.id in this.connections === false) {
			this.connections[node.id] = {
				status: 'offline',
				terminals: new Set(),
				ports: {},
				node,
			};
		}

		if(['offline', 'error'].includes(this.connections[node.id].status)) {
			this.connections[node.id].promise = new Promise<Connection>(async (resolve, reject) => {
				try {
					const connection = this.connections[node.id];
					connection.status = 'connecting';
					connection.client = new Client();
					connection.ports = {};
					connection.node = node;
					connection.loginContext = {
						triedMethods: [],
						enteredPassword: undefined,
						triedWithStoredPassword: false,
						neverWithStoredPassword: false,
						loginCancelCts: new vscode.CancellationTokenSource(),
						abort: () => {
							connection.loginContext?.loginCancelCts.cancel();
							connection.client?.end();
							reject(new Error('Connection aborted'));
							this.refresh();
						}
					};

					this.log(connection, `connecting...`);
					
					// display as connecting
					this.refresh();

					// function to call to set status to error and reject promise, displaying error message is up to the caller
					const failedToConnect = (error?: Error) => {
						reject(error);
						connection.status = 'error';
						this.refresh();
					};

					if (!node.config.username) {
						return failedToConnect(new Error('Username required'));
					}
					if (!node.config.host) {
						return failedToConnect(new Error('Host required'));
					}

					// on successfull connection
					connection.client!.on('ready', () => {
						this.log(connection, 'online.');
						connection.status = 'online';
						this.refresh();
						resolve(connection);
						this.autoForwardPorts(node);

						if (connection.loginContext?.enteredPassword) {
							// if there was a stored password but the user had to enter something else
							if (connection.loginContext?.triedWithStoredPassword) {
								keytar.deletePassword('vscode-ssh-connect', node.id);
							}
							vscode.window.showInformationMessage("Do you want to save the password in system keychain?", "Yes", "No", `Never for ${node.name}`).then(answer => {
								if (answer === "Yes") {
									keytar.setPassword('vscode-ssh-connect', node.id, connection.loginContext!.enteredPassword!);
									vscode.window.showInformationMessage("Saved");
								}
								else if (answer === `Never for ${node.name}`)  {
									keytar.setPassword('vscode-ssh-connect', node.id, '%%NEVER%%');
								}
							});
						}
					});
					
					// on failed or closed connection
					connection.client!.on('close', (hadError) => {
						this.log(connection, `closed${hadError ? ' with error' : ''}`);
						connection.status = 'offline';
						this.refresh();
					});
					// on failed or closed connection
					connection.client!.on("end", () => {
						this.log(connection, 'ended.');
					});
					
					// print connection errors
					connection.client!.on('error', (error) => {
						if (connection.status === 'connecting') {
							connection.loginContext?.loginCancelCts?.cancel();
							return failedToConnect(error);
						}
						else {
							this.log(connection, error.message);
							vscode.window.showErrorMessage(`${node.id}: ${error.message}`);
						}
					});
					
					// handle incoming x11 connections
					const x11Port = node.config.x11Port;
					if (x11Port !== undefined) {
						connection.client!.on('x11', (info, accept, reject) => {
							const xserversock = new Socket();
							xserversock.on('connect', () => {
								const xclientsock = accept();
								xclientsock.pipe(xserversock).pipe(xclientsock);
							}).connect(x11Port, 'localhost');
						});
					}

					// create an auth handler function
					const authHandler = await this.makeAuthHandler(connection);

					// connect either via jumpServer or directly
					let parent = node.parent;
					while (parent && parent.type !== 'connection') {
						parent = parent.parent;
					}
					if (parent) {
						this.log(connection, 'requesting parent connection...');
						const parentNode = <ConnectionNode>parent;
						try {
							const parentConnection = await this.connect(parentNode);
							parentConnection.client!.forwardOut('127.0.0.1', 0, node.config.host || 'localhost', node.config.port || 22, async (error, stream) => {
								if (error) {
									return failedToConnect(new Error(`${node.id}: parent failed to forward port - ${error.message}`));
								}
								connection.client!.connect({
									...node.config,
									sock: stream,
									authHandler,
									privateKey: undefined // handled by authHandler
								});
								stream.on('close', () => {
									this.log(connection, 'parent forward stream closed.');
								});
								stream.on('exit', (code, signal) => {
									this.log(connection, `parent forward stream exited. ${code}: ${signal}`);
								});
							});
						}
						catch (error) {
							failedToConnect(new Error(`${node.id}: parent failed to connect - ${error.message}`));
						}
					}
					else {
						connection.client!.connect({
							// tryKeyboard: true,
							...node.config,
							host: node.config.host,
							port: node.config.port,
							authHandler,
							debug: node.config.enableDebug ? (info) => this.log(node, info) : undefined,
							privateKey: undefined // handled by authHandler
						});
					}
				}
				catch (error) {
					reject(error);
				}
			});
		}
		return this.connections[node.id].promise!;
	}

	/**
	 * Disconnects a connection
	 * @param node 
	 */
	public async disconnect(node: ConnectionNode): Promise<void> {
		if (!node?.id) {
			return Promise.reject(new Error('No connection provided'));
		}
		const connection = this.getConnection(node);
		if (connection && connection.status === 'online') {
			this.log(connection, 'disconnecting...');
			connection.client?.end();
		}
	}

	/**
	 * Forward ports configured to auto connect
	 * @param node 
	 */
	 private async autoForwardPorts(node: ConnectionNode): Promise<void> {
		const connection = await this.connect(node);
		for (const childNode of node.children.filter((child) => child.type === 'portForward' && (<PortForwardNode>child).portForward.autoConnect)) {
			await this.forwardPort(connection, <PortForwardNode>childNode);
		}
	}

	/**
	 * Opens a port and forwards according to the configuration
	 * @param node 
	 * @returns 
	 */
	public async forwardPort(connection: Connection, node: PortForwardNode): Promise<PortForward> {
		if (node.id in connection.ports === false) {
			connection.ports[node.id] = {
				status: 'offline',
				close: () => {}
			};
		}

		if(['offline', 'error'].includes(connection.ports[node.id].status)) {
			connection.ports[node.id].promise = new Promise<PortForward>((resolve, reject) => {	
				const portForwardSockets = new Set<Socket>();
				const portForward = connection.ports[node.id];
				portForward.status = 'connecting';
				portForward.port = node.portForward.srcPort;
				portForward.server = new Server();
				portForward.close = () => {
					if (portForward.server!.listening) {
						for (const socket of portForwardSockets) {
							socket.destroy();
						}
						portForward.server!.close();
					}
				};
				this.refresh();

				// setup a forward streams for each new connection
				portForward.server!.on('connection', (socket) => {
					portForwardSockets.add(socket);
					connection.client!.forwardOut(socket.remoteAddress || '', socket.remotePort || 0, node.portForward.dstAddr || 'localhost', node.portForward.dstPort || 22, (error, stream) => {
						if (error) {
							portForward.status = 'error';
							this.refresh();
							portForward.server!.close();

							this.log(connection, `forwardPort: ${error.message}`);
							vscode.window.showErrorMessage(`forwardPort: ${error.message}`);
							
							return;
						}
						socket.pipe(stream).pipe(socket);
					});
					socket.on("close", () => {
						portForwardSockets.delete(socket);
					});
				});
				
				portForward.server!.on('error', (error) => {
					if (portForward.status === 'connecting') {
						portForward.status = 'error';
						this.refresh();
						portForward.server!.close();
						reject(error);
					}
					this.log(connection, `forwardPort: ${error.message}`);
					vscode.window.showErrorMessage(`forwardPort: ${error.message}`);
				});

				portForward.server!.on('close', () => {
					if (portForward.status !== 'error') {
						portForward.status = 'offline';
					}
					this.refresh();
					if (portForward.port) {
						delete this.ports[portForward.port];
					}
				});

				// if successful in opening port. setup a event listener to close the port forward server and its sockets when the connection is closed
				portForward.server!.on('listening', () => {
					portForward.status = 'online';
					this.refresh();
					resolve(portForward);

					connection.client!.on('close', () => {
						if (portForward.server!.listening) {
							for (const socket of portForwardSockets) {
								socket.destroy();
							}
							portForward.server!.close();
						}
					});

					const address = portForward.server!.address();
					if (address && typeof address !== 'string') {
						portForward.port = address.port;
					}
					
					if (portForward.port) {
						this.ports[portForward.port] = portForward;
					}
				});

				// listen 
				portForward.server!.listen(node.portForward.srcPort);
			});
		}
		return connection.ports[node.id].promise!;
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
			this.log(node, error.message);
			vscode.window.showErrorMessage(`${node.id}: ${error.message}`);
		}
	}

	public readRemoteFile(node: ConnectionNode, filePath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const connection = this.getConnection(node);
			if (connection?.status !== 'online') {
				return reject(new Error('Connection is not online'));
			}
			connection.client!.sftp((error, sftp) => {
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

	private async makeAuthHandler(connection: Connection): Promise<AuthHandler> {
		const context = connection.loginContext!;

		let storedPassword = await keytar.getPassword('vscode-ssh-connect', connection.node.id);
		context.neverWithStoredPassword = (storedPassword === '%%NEVER%%');
		if (context.neverWithStoredPassword) {
			storedPassword = null;
		}

		return (methodsLeft, partialSuccess, callback) => {
			this.log(connection, `AuthHandler: methodsLeft: ${methodsLeft}`);
			if (methodsLeft === null) {
				return {
					type: 'none',
					username: connection.node.config.username!
				};
			}
			if (methodsLeft.includes('publickey') && (connection.node.config.privateKey || connection.node.config.agent)) {
				if (connection.node.config.privateKey && !context.triedMethods.includes('publickey')){
					context.triedMethods.push('publickey');
					try {
						const key = readFileSync(vscodeVariables(connection.node.config.privateKey.toString()));
						this.log(connection, `AuthHandler: Private Key from file ${connection.node.config.privateKey}`);
						return {
							type: 'publickey',
							username: connection.node.config.username!,
							key,
							passphrase: connection.node.config.passphrase
						};
					}
					catch(error) {
						this.log(connection, `AuthHandler: Private Key file read error - ${error.message}`);
					}
				}
				else if (connection.node.config.agent && !context.triedMethods.includes('agent')) {
					context.triedMethods.push('agent');
					this.log(connection, `AuthHandler: Private Key from Agent`);
					return {
						type: 'agent',
						username: connection.node.config.username!,
						agent: vscodeVariables(connection.node.config.agent.toString())
					};
				}
			}
			
			if (methodsLeft.includes('hostbased') && connection.node.config.localUsername && !context.triedMethods.includes('hostbased')) {
				// I'm not sure how this works and the docs and AuthHandlerResult type doesn't agree, so we'll have to see what happens if someone tries it
				context.triedMethods.push('hostbased');
				if (connection.node.config.privateKey) {
					try {
						const key = readFileSync(connection.node.config.privateKey);
						this.log(connection, `AuthHandler: Hostbased auth with private key: ${connection.node.config.privateKey}`);
						return <any>{
							type: 'hostbased',
							username: connection.node.config.username!,
							key,
							passphrase: connection.node.config.passphrase,
							localUsername: connection.node.config.localUsername,
							localHostname: connection.node.config.localHostname
						};
					}
					catch(error) {
						this.log(connection, `AuthHandler: Private Key file read error - ${error.message}`);
						callback(false);
					}
				}
				else {
					this.log(connection, `AuthHandler: Hostbased auth with no private key`);
					return <any>{
						type: 'hostbased',
						username: connection.node.config.username!,
						localUsername: connection.node.config.localUsername,
						localHostname: connection.node.config.localHostname
					};
				}
			}

			if (methodsLeft.includes('password') && (!context.triedMethods.includes('password') || context.triedWithStoredPassword)) {
				if(connection.node.config.password) {
					context.triedMethods.push('password');
					this.log(connection, 'AuthHandler: Password auth');
					return {
						type: 'password',
						username: connection.node.config.username!,
						password: connection.node.config.password
					};
				}
				else if (connection.node.config.loginPromptCommands?.find(c => c.prompt.toLowerCase() === 'password' && (!c.os || c.os.toLowerCase() === os.platform()))) {
					const command = vscodeVariables(connection.node.config.loginPromptCommands.find(c => c.prompt.toLowerCase() === 'password' && (!c.os || c.os.toLowerCase() === os.platform()))!.command.replace('${prompt}', 'password').replace('${host}', connection.node.name));
					this.log(connection, `AuthHandler: Password auth using command: ${command}`);
					exec(command, (error, stdout) => {
						if (error) {
							this.log(connection, `AuthHandler: Error executing command for password - ${error.message}`);
							return callback({
								type: 'none',
								username: connection.node.config.username!
							});
						}
						callback({
							type: 'password',
							username: connection.node.config.username!,
							password: stdout
						});
					});
					return;
				}
				else {
					context.triedMethods.push('password');
					if (storedPassword && !context.triedWithStoredPassword) {
						context.triedWithStoredPassword = true;
						this.log(connection, 'AuthHandler: Password auth using stored password');
						return {
							type: 'password',
							username: connection.node.config.username!,
							password: storedPassword
						};
					}
					context.triedWithStoredPassword = false; // so it doesn't try password auth 3 times
					this.log(connection, 'AuthHandler: Password auth using prompt');
					const inputOptions = {
						title: `${connection.node.name} - password`,
						placeHolder: 'Enter password',
						password: true,
						ignoreFocusOut: true
					};
					vscode.window.showInputBox(inputOptions, context.loginCancelCts.token).then((password) => {
						if (password === undefined) {
							this.log(connection, 'AuthHandler: Login canceled');
							return context.abort();
						}
						if (!context.neverWithStoredPassword) {
							context.enteredPassword = password;
						}
						callback({
							type: 'password',
							username: connection.node.config.username!,
							password
						});
					});
					return;
				}
			}
			
			if (methodsLeft.includes('keyboard-interactive') && (!context.triedMethods.includes('keyboard-interactive') || context.triedWithStoredPassword)) {
				context.triedMethods.push('keyboard-interactive');
				this.log(connection, 'AuthHandler: Keyboard-interactive auth');
				return {
					type: 'keyboard-interactive',
					username: connection.node.config.username!,
					prompt: async (name, instructions, instructionsLang, prompts, finish) => {
						const responses: string[] = [];
						for (const prompt of prompts) {
							const requested = prompt.prompt.replace(': ', '').toLowerCase();
							if (requested === "password" && connection.node.config.password) {
								this.log(connection, 'AuthHandler: Keyboard-interactive auth get password from config');
								responses.push(connection.node.config.password);
								continue;
							}
							if (connection.node.config.loginPromptCommands?.find(c => c.prompt.toLowerCase() === requested && (!c.os || c.os.toLowerCase() === os.platform()))) {
								const command = vscodeVariables(connection.node.config.loginPromptCommands.find(c => c.prompt.toLowerCase() === requested && (!c.os || c.os.toLowerCase() === os.platform()))!.command.replace('${prompt}', requested).replace('${host}', connection.node.name));
								this.log(connection, `AuthHandler: Keyboard-interactive auth get ${requested} using command: ${command}`);
								try {
									const response = await new Promise<string>((resolve, reject) => {
										exec(command, (error, stdout) => {
											if (error) {
												return reject(error);
											}
											resolve(stdout);
										});
									});
									responses.push(response);
									continue;
								}
								catch(error) {
									this.log(connection, `AuthHandler: error executing command for ${requested} - ${error.message}`);
								}
							}
							if (requested === "password" && storedPassword) {
								if (context.triedWithStoredPassword) {
									// if we have tried with stored password and failed and keyboard-interactive is tried again because context.triedWithStoredPassword is true, then reset it to false so keyboard-interactive isn't attempted a third time because of it
									context.triedWithStoredPassword = false;
								}
								else {
									this.log(connection, 'AuthHandler: Keyboard-interactive auth using stored password');
									context.triedWithStoredPassword = true;
									responses.push(storedPassword!);
									continue;
								}
							}
							// if we get here, we need to ask the user for the requested input
							const inputOptions = {
								title: `${connection.node.name} - ${requested}`,
								placeHolder: `Enter ${requested}`,
								password: requested === 'password',
								ignoreFocusOut: true
							};
							this.log(connection, `AuthHandler: Keyboard-interactive auth prompting for ${requested}`);
							const response = await vscode.window.showInputBox(inputOptions, context.loginCancelCts.token);
							if (response === undefined) {
								this.log(connection, 'AuthHandler: Login canceled');
								return context.abort();
							}
							else {
								responses.push(response);
								if (requested === 'password' && !context.neverWithStoredPassword) {
									context.enteredPassword = response;
								}
							}
						}
						finish(responses);
					}
				};
			}
			else {
				return false;
			}
		};
	};

	private log(node: Connection | ConnectionNode, message: string) {
		if ('node' in node) {
			node = (<Connection>node).node;
		}
		if (node.config.enableDebug) {
			this.outputChannel.appendLine(`${node.id}: ${message}`);
		}
	}
}