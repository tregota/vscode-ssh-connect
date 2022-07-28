import * as vscode from 'vscode';
import ConnectionConfig, { PortForwardConfig } from './ConnectionConfig';
import ConnectionsProvider, { Connection, PortForward } from './ConnectionsProvider';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { exec } from 'child_process';
import { parse as jsoncParse } from 'jsonc-parser';
import { vscodeVariables } from '../utils';

export interface TreeNode {
	name: string
	type: string
	parent?: TreeNode
	children: TreeNode[]
}
export interface ConnectionNode extends TreeNode {
	id: string
	folder?: string
	config: ConnectionConfig
}

export interface PortForwardNode extends TreeNode {
	id: string
	portForward: PortForwardConfig
}
export interface FolderNode extends TreeNode {
	config: ConnectionConfig
}

interface ConfigurationSource {
	type: "uri" | "file" | "sftp"
	connection?: string
	autoConnect?: boolean
	path: string
}

export default class SSHConnectProvider implements vscode.TreeDataProvider<TreeNode> {

	private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | void> = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | void> = this._onDidChangeTreeData.event;

	private selectedNodes: ConnectionNode[] = [];
	private multiSelect: boolean = false;
	private allTreeNodes: { [id: string]: ConnectionNode } = {};
	private topTreeNodes: TreeNode[] = [];
	private configRefresh: boolean = false;
	public notebookActive: boolean = false;

	constructor(private readonly context: vscode.ExtensionContext, private readonly connectionsProvider: ConnectionsProvider) {
		vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
			if (event.affectsConfiguration('ssh-connect.hosts') || event.affectsConfiguration('ssh-connect.sources')) {
				this.configRefresh = true;
				this.refresh();
			}
		});
		vscode.workspace.createFileSystemWatcher('**/sshconnect*.json*').onDidChange((uri) => {
			if (uri.path.match(/\.vscode.sshconnect.*\.jsonc?$/)) {
				this.configRefresh = true;
				this.refresh();
			}
		});

		connectionsProvider.onDidChange(() => {
			this.refresh();
		});

		this.loadNodeTree();
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	public fullRefresh(): void {
		this.configRefresh = true;
		this._onDidChangeTreeData.fire();
	}
	public async connect(id: string): Promise<ConnectionNode> {
		const node = this.allTreeNodes[id];
		if (node?.id) {
			await this.connectionsProvider.connect(node);
			return node;
		}
		else {
			throw new Error(`${id} not found`);
		}
	}
	public async disconnect(id: string): Promise<ConnectionNode> {
		const node = this.allTreeNodes[id];
		if (node?.id) {
			await this.connectionsProvider.disconnect(node);
			return node;
		}
		else {
			throw new Error(`${id} not found`);
		}
	}
	public async connectAndSelect(...hostIds: (string | RegExp)[]): Promise<Connection[]> {
		this.selectedNodes = [];
		this.setMultiSelect(true);
		for (const hostId of hostIds) {
			let connectionNode: ConnectionNode | undefined;
			if (typeof hostId === 'string') {
				connectionNode = this.allTreeNodes[hostId];
				if (!connectionNode?.id) {
					throw new Error(`${hostId} not found`);
				}
				await this.connectionsProvider.connect(connectionNode);
				this.selectedNodes.push(connectionNode);
				this.refresh();
			}
			else {
				for (const id in this.allTreeNodes) {
					if (id.match(hostId)) {
						connectionNode = this.allTreeNodes[id];
						await this.connectionsProvider.connect(connectionNode);
						this.selectedNodes.push(connectionNode);
						this.refresh();
					}
				}
			}
		}
		if (this.selectedNodes.length === 0) {
			throw new Error('No hosts found');
		}
		return this.getSelectedNodeConnections();
	}
	public async selectNode(node: TreeNode | undefined = undefined): Promise<void>  {
		if(node === undefined) {
			this.selectedNodes = [];
			this.refresh();
			return;
		}
		try {
			if (!this.multiSelect) {
				if (node.type === 'connection') {
					const connectionNode = <ConnectionNode>node;
					const status = await this.connectionsProvider.getConnectionStatus(connectionNode);
					if (status === 'online') {
						this.selectedNodes = [connectionNode];
					}
				}
			}
			else if (node.type === 'connection') {
				const connectionNode = <ConnectionNode>node;
				if (this.selectedNodes.find((t) => t.id === connectionNode.id)) {
					this.selectedNodes = this.selectedNodes.filter((t) => t.id !== connectionNode.id);
				}
				else {
					this.selectedNodes.push(connectionNode);
				}
			}
		}
		catch (e) {
			vscode.window.showErrorMessage(e.message);
		}
		this.refresh();
	}
	public unselectNode(node: TreeNode): void  {
		if (node.type === 'connection') {
			const connectionNode = <ConnectionNode>node;
			if (this.selectedNodes.find((t) => t.id === connectionNode.id)) {
				this.selectedNodes = this.selectedNodes.filter((t) => t.id !== connectionNode.id);
			}
		}
		this.refresh();
	}
	public setMultiSelect(value: boolean): void {
		this.multiSelect = value;
		vscode.commands.executeCommand('setContext', 'ssh-connect.multiSelect', this.multiSelect);
		if (!this.multiSelect) {
			const onlineNodes = this.selectedNodes.filter((node) => this.connectionsProvider.getConnectionStatus(node) === 'online');
			if (onlineNodes.length > 0) {
				this.selectedNodes = [onlineNodes[0]];
			}
			else {
				this.selectedNodes = [];
			}
		}
		this.refresh();
	}
	public async getSelectedNodeConnections(): Promise<Connection[]> {
		if (this.selectedNodes.length > 0) {
			const connections = await Promise.all(this.selectedNodes.map((node: ConnectionNode) => this.connectionsProvider.getConnection(node)));
			const validConnections = <Connection[]>connections.filter((connection) => connection && connection.status === 'online');
			if(validConnections.length < connections.length) {
				this.selectedNodes = this.selectedNodes.filter((node) => validConnections.find((connection) => connection.node.id === node.id));
				this.refresh();
			}
			return validConnections;
		}
		return [];
	}

	public async openLink(node: PortForwardNode): Promise<void> {
		try {
			if (node.type === 'portForward' && node.portForward.dstPort) {
				let portForward: PortForward;
				let srcPort: number;
				const connection = await this.connectionsProvider.connect(<ConnectionNode>node.parent);

				if (node.portForward.srcPort) {
					await this.connectionsProvider.forwardPort(connection, node);
					srcPort = node.portForward.srcPort;
				}
				else {
					portForward = await this.connectionsProvider.forwardPort(connection, node);
					if (!portForward.port) {
						portForward.close();
						throw new Error('Port forwarding failed');
					}
					srcPort = portForward.port;
				}

				let matches = /^(https?)(.*)$/.exec(node.portForward.link);
				if (matches !== null) {
					vscode.env.openExternal(vscode.Uri.parse(`${matches[1]}://localhost:${srcPort}${matches[2]}`));
				}
				else {
					const command = vscodeVariables(node.portForward.link.replace('${port}', srcPort.toString()));
					const process = exec(command, (error, stdout, stderr) => {
						if (error) {
							vscode.window.showErrorMessage(`${node.name}: ${error.message}`);
						}
						stdout && vscode.window.showInformationMessage(`${node.name}: ${stdout}`);
						stderr && vscode.window.showErrorMessage(`${node.name}: ${stderr}`);
					});
					process.on('close', () => {
						portForward.close();
					});
				}
			}
			else {
				throw new Error('No destination port configured');
			}
		}
		catch (e) {
			vscode.window.showErrorMessage(`${node.name}: ${e.message}`);
		}
	}

	public getTreeItem(node: TreeNode): vscode.TreeItem {
		let label: string | vscode.TreeItemLabel = node.name;
		let icon = 'question';
		let iconPath;
		let color;
		let status;
		let description: string | undefined;
		let subtype = '';
		let collapsibleState = node.children.length ? (node.children.find(c => c.type !== 'portForward') ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None;

		if (node.type === 'connection') {
			const connectionNode = <ConnectionNode>node;
			status = this.connectionsProvider.getConnectionStatus(connectionNode);
			description = connectionNode.config.description;
			iconPath = connectionNode.config.iconPath;

			if (connectionNode.config.host && connectionNode.config.username) {
				switch (status) {
					case 'connecting':
						icon = 'loading~spin';
						break;
					case 'online':
						if (this.notebookActive && !!this.selectedNodes.find((node) => node.id === connectionNode.id)) {
							iconPath = connectionNode.config.iconPathConnected || {
								dark: this.context.asAbsolutePath('media/server-active.svg'),
								light: this.context.asAbsolutePath('media/server-active-light.svg')
							};
							subtype = 'Selected';
						}
						else {
							iconPath = connectionNode.config.iconPathConnected || {
								dark: this.context.asAbsolutePath('media/server-online.svg'),
								light: this.context.asAbsolutePath('media/server-online-light.svg')
							};
						}
						break;
					default:
						iconPath = iconPath || {
							dark: this.context.asAbsolutePath('media/server-offline.svg'),
							light: this.context.asAbsolutePath('media/server-offline-light.svg')
						};
						break;
				}
			}
			else {
				icon = 'server';
				color = new vscode.ThemeColor("terminal.ansiRed");
				status = 'unconfigured';
			}
		}
		else if (node.type === 'portForward' && node.parent) {
			const portForwardNode = <PortForwardNode>node;
			color = new vscode.ThemeColor("list.deemphasizedForeground");

			if (!portForwardNode.portForward.srcPort && !!portForwardNode.portForward.link && !portForwardNode.portForward.link.startsWith('http')) {
				const portForward = this.connectionsProvider.getPortForward(portForwardNode);
				status = 'adhoc';
				if (portForward?.status === 'online') {
					status = 'online';
					description = portForward.port?.toString();
				}
			}
			else if (!portForwardNode.portForward.srcPort || !portForwardNode.portForward.dstPort) {
				color = new vscode.ThemeColor("list.errorForeground");
				status = 'error';
				description = 'bad config';
			}
			else if (status !== 'error') {
				status = this.connectionsProvider.getPortStatus(portForwardNode);
			}

			switch (status) {
				case 'connecting':
					icon = 'loading~spin';
					break;
				case 'online':
					iconPath = {
						dark: this.context.asAbsolutePath('media/port-online.svg'),
						light: this.context.asAbsolutePath('media/port-online-light.svg')
					};
					break;
				case 'adhoc':
				case 'offline':
					iconPath = this.context.asAbsolutePath('media/port-offline.svg');
				case 'error':
					color = new vscode.ThemeColor("list.errorForeground");
					icon = 'circle-outline';
					break;
			}
			
			if (!!portForwardNode.portForward.link) {
				subtype = 'Linked';
			}
		}
		else {
			const folderNode = <FolderNode>node;
			iconPath = folderNode.config.iconPath || this.context.asAbsolutePath('media/folder.svg');
		}
	
		return {
			label,
			contextValue: status ? `${node.type}${subtype}.${status}` : node.type,
			collapsibleState,
			iconPath: iconPath || new vscode.ThemeIcon(icon, color),
			description,
			command: { title: 'select', command: 'ssh-connect.selectNode', arguments: [node] }
		};
	}

	public async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (node) {
			return node.children;
		}
		else if (this.configRefresh) {
			await this.loadNodeTree();
			this.configRefresh = false;
		}
		return this.topTreeNodes;
	}

	private async loadNodeTree(): Promise<void> {
		const nodeTree: TreeNode[] = [];
		this.allTreeNodes = {};

    if (vscode.workspace.workspaceFolders !== undefined) {
			for (const workspaceFolder of vscode.workspace.workspaceFolders) {
				const folderPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode').fsPath;
				if (existsSync(folderPath)) {
					const paths = readdirSync(folderPath);
					for (const path of paths) {
						if (path.match(/^sshconnect.*\.jsonc?$/)) {
							try {
								const json = readFileSync(vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', path).fsPath, 'utf8');
								const configuration = jsoncParse(json);
								for (const connectionConfig of (configuration.hosts || [])) {
									const node = <ConnectionNode>this.addToNodeTree(nodeTree, connectionConfig.id.split('/'), connectionConfig);
									if(node?.id) {
										this.allTreeNodes[node.id] = node;
									}
								}
							}
							catch (e) {
								vscode.window.showErrorMessage(`Could not parse configuration file - ${e.message}`);
							}
						}
					}
				}
			}
		}

		let vsConfigurations: ConnectionConfig[] = vscode.workspace.getConfiguration('ssh-connect').get('hosts') || [];
		for (const configuration of vsConfigurations) {
			const node = <ConnectionNode>this.addToNodeTree(nodeTree, configuration.id.split('/'), configuration);
			if(node?.id) {
				this.allTreeNodes[node!.id] = node!;
			}
		}

		this.processNodeTreeConfig(nodeTree);
		this.topTreeNodes = nodeTree;
	}

	private addToNodeTree(tree: TreeNode[], path: string[], config: ConnectionConfig, parent?: TreeNode): TreeNode | undefined {
		const name = path.shift()!;
		const isLeaf = path.length === 0;
		if (!isLeaf || 'host' in config === false) {
			let node = tree.find(n => n.name === name);
			if (!node) {
				node = <FolderNode>{
					name,
					type: 'folder',
					parent,
					children: [],
					config: isLeaf ? config : <ConnectionConfig>{}
				};
				tree.push(node);
			}
			else if (isLeaf && node.type === 'folder') {
				(<FolderNode>node).config = config;
			}
			if (!isLeaf) {
				return this.addToNodeTree((<FolderNode>node).children, path, config, node);
			}
			return node;
		}
		else {
			const connectionNode = <ConnectionNode>{
				id: config.id,
				name,
				type: 'connection',
				config,
				parent,
				children: []
			};

			let node = tree.find(n => n.name === name);
			if (!node) {
				tree.push(connectionNode);
			}
			else {
				connectionNode.children = node.children;
				tree[tree.indexOf(node)] = connectionNode;
			}
			
			return connectionNode;
		}
	}

	private processNodeTreeConfig(tree: TreeNode[], config?: ConnectionConfig): void {
		const { id, description, iconPath, iconPathConnected, ...filteredConfig } = config || {};
		for (const node of tree) {
			if (node.type === 'portForward') {
				continue;
			}
			const configNode = <ConnectionNode|FolderNode>node;
			if ('loginPromptCommands' in filteredConfig && configNode.config.loginPromptCommands) {
				configNode.config.loginPromptCommands.push(...filteredConfig.loginPromptCommands!);
			}
			if (config) {
				configNode.config = { ...filteredConfig, ...configNode.config };
			}
			// interpolation that isn't dependent on real time stuff
			if (configNode.config.iconPath) {
				configNode.config.iconPath = vscodeVariables(configNode.config.iconPath);
			}
			if (configNode.config.iconPathConnected) {
				configNode.config.iconPathConnected = vscodeVariables(configNode.config.iconPathConnected);
			}

			this.processNodeTreeConfig(configNode.children, configNode.type === 'folder' ? configNode.config : config);

			// port forwards
			if (configNode.config.portForwards && configNode.type === 'connection') {
				const portForwards: PortForwardNode[] = [];
				for (const portForward of configNode.config.portForwards) {
					let name = portForward.srcPort?.toString() || '';
					if (portForward.description) {
						name = portForward.description;
					}
					else if (portForward.dstAddr && !['localhost', '127.0.0.1', '::1'].includes(portForward.dstAddr)) {
						name = `${name?name+' ':''}➝ ${portForward.dstAddr}${portForward.dstPort && portForward.dstPort !== portForward.srcPort ? `:${portForward.dstPort}` : ''}`;
					}
					else if (portForward.dstPort && portForward.dstPort !== portForward.srcPort) {
						name = `${name?name+' ':''}➝ ${portForward.dstPort}`;
					}

					const portForwardNode = <PortForwardNode>{
						id: `${portForward.srcAddr || ''}:${portForward.srcPort || ''}:${portForward.dstAddr || ''}:${portForward.dstPort}`,
						name,
						type: 'portForward',
						parent: configNode,
						portForward,
						children: []
					};
					portForwards.push(portForwardNode);
				}
				configNode.children.unshift(...portForwards);
			}

		}
	}
}
