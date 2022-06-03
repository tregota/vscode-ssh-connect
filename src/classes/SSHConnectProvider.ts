import * as vscode from 'vscode';
import ConnectionConfig, { PortForwardConfig } from './ConnectionConfig';
import ConnectionsProvider, { Connection, PortForward } from './ConnectionsProvider';
import { readFileSync, existsSync } from 'fs';
import { exec } from 'child_process';

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
	private externalConfigCache: { [id: string]: ConnectionConfig[] } = {};
	public notebookActive: boolean = false;

	constructor(private readonly context: vscode.ExtensionContext, private readonly connectionsProvider: ConnectionsProvider) {
		vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
			if (event.affectsConfiguration('ssh-connect.hosts') || event.affectsConfiguration('ssh-connect.sources')) {
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

				if (node.portForward.srcPort) {
					await this.connectionsProvider.openPort(node);
					srcPort = node.portForward.srcPort;
				}
				else {
					const connection = await this.connectionsProvider.connect(<ConnectionNode>node.parent);
					portForward = await this.connectionsProvider.forwardPortAndWait(connection, { dstPort: node.portForward.dstPort });
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
					const command = node.portForward.link.replace('%port%', srcPort.toString());
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
		let collapsibleState = node.children.length ? (node.children.find(c => c.type === 'connection') ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None;

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
			description = portForwardNode.portForward.description;
			color = new vscode.ThemeColor("list.deemphasizedForeground");

			if (!portForwardNode.portForward.srcPort && !!portForwardNode.portForward.link) {
				status = 'adhoc';
			}
			else if (!portForwardNode.portForward.srcPort || !portForwardNode.portForward.dstPort) {
				color = new vscode.ThemeColor("list.errorForeground");
				status = 'error';
				description = 'bad config';
			}
			else {
				status = this.connectionsProvider.getPortStatus(portForwardNode);
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
					case 'offline':
						iconPath = this.context.asAbsolutePath('media/port-offline.svg');
					case 'error':
						color = new vscode.ThemeColor("list.errorForeground");
						icon = 'circle-outline';
						break;
				}
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
		let externalConfigSources: ConfigurationSource[] = [];

    if (vscode.workspace.workspaceFolders !== undefined) {
			for (const workspaceFolder of vscode.workspace.workspaceFolders) {
				const path = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'sshconnect.json').fsPath;
				if (existsSync(path)) {
					try {
						const json = readFileSync(path, 'utf8');
						const configuration = JSON.parse(json);
						for (const connectionConfig of (configuration.hosts || [])) {
							const node = <ConnectionNode>this.addToNodeTree(nodeTree, connectionConfig.folder?.split('/') || [], connectionConfig);
							if(node?.id) {
								this.allTreeNodes[node.id] = node;
							}
						}
						if (configuration.sources) {
							externalConfigSources = [...externalConfigSources, ...(<ConfigurationSource[]>configuration.sources || [])];
						}
					}
					catch (e) {
						vscode.window.showErrorMessage(`Could not parse configuration file - ${e.message}`);
					}
				}
			}
		}

		let vsConfigurations: ConnectionConfig[] = vscode.workspace.getConfiguration('ssh-connect').get('hosts') || [];
		for (const configuration of vsConfigurations) {
			const node = <ConnectionNode>this.addToNodeTree(nodeTree, configuration.folder?.split('/') || [], configuration);
			if(node?.id) {
				this.allTreeNodes[node!.id] = node!;
			}
		}

		externalConfigSources = [...externalConfigSources, ...(vscode.workspace.getConfiguration('ssh-connect').get<ConfigurationSource[]>('sources') || [])];
		for (const configurationSource of externalConfigSources) {
			const configurations = await this.loadConfigsFromFile(configurationSource);
			for (const configuration of configurations) {
				const node = <ConnectionNode>this.addToNodeTree(nodeTree, configuration.folder?.split('/') || [], configuration);
				if(node?.id) {
					this.allTreeNodes[node.id] = node;
				}
			}
		}

		this.topTreeNodes = this.processNodeTree(nodeTree);
	}

	private async loadConfigsFromFile(configurationSource: ConfigurationSource): Promise<ConnectionConfig[]> {
		try {
			let json;
			let id;
			switch (configurationSource.type) {
				case 'file':
					id = `file/${configurationSource.path}`;
					if (this.configRefresh || !(id in this.externalConfigCache)) {
						json = readFileSync(configurationSource.path, 'utf8');
					}
					break;
				case 'sftp':
					id = `sftp/${configurationSource.connection}/${configurationSource.path}`;
					if (configurationSource.connection && (this.configRefresh || !(id in this.externalConfigCache))) {
						if (configurationSource.connection in this.allTreeNodes) {
							const node = <ConnectionNode>this.allTreeNodes[configurationSource.connection];
							const status = this.connectionsProvider.getConnectionStatus(node);
							if (configurationSource.autoConnect || status === 'online') {
								await this.connectionsProvider.connect(node);
								json = await this.connectionsProvider.readRemoteFile(node, configurationSource.path);
								if (status === 'offline') {
									await this.connectionsProvider.disconnect(node);
								}
							}
						}
					}
					break;
			}
			if (id && (json || id in this.externalConfigCache)) {
				let configurations;
				if (json) {
					try {
						configurations = JSON.parse(json);
						this.externalConfigCache[id] = configurations;
					}
					catch (e) {
						vscode.window.showErrorMessage(`Could not parse configuration file - ${e.message}`);
					}
				}
				return this.externalConfigCache[id];
			}
		} catch (e) {}
		return [];
	}

	private addToNodeTree(tree: TreeNode[], path: string[], config: ConnectionConfig, parent?: TreeNode): TreeNode | undefined {
		const folder = path.shift();
		if (folder) {
			let folderNode: FolderNode | undefined = <FolderNode>tree.find(n => n.name === folder && n.type === 'folder');
			if (!folderNode) {
				folderNode = {
					name: folder,
					type: 'folder',
					parent,
					children: [],
					config: config.id ? <ConnectionConfig>{} : config
				};
				tree.push(folderNode);
			}
			if(path.length === 0 && !config.id) {
				folderNode.config = config;
			}
			return this.addToNodeTree(folderNode.children, path, config, folderNode);
		}
		else if (config.id) {
			const connectionNode: ConnectionNode = {
				id: `${config.folder}/${config.id}`,
				name: config.id,
				type: 'connection',
				config,
				parent,
				children: []
			};

			tree.push(connectionNode);
			
			// port forwards
			if (config.portForwards) {
				for (const portForward of config.portForwards) {
					let name = portForward.srcPort?.toString() || '';
					if(portForward.dstAddr && !['localhost', '127.0.0.1', '::1'].includes(portForward.dstAddr)) {
						name = `${name?name+' ':''}➝ ${portForward.dstAddr}${portForward.dstPort && portForward.dstPort !== portForward.srcPort ? `:${portForward.dstPort}` : ''}`;
					}
					else if (portForward.dstPort && portForward.dstPort !== portForward.srcPort) {
						name = `${name?name+' ':''}➝ ${portForward.dstPort}`;
					}

					const portForwardNode = <PortForwardNode>{
						id: `${portForward.srcAddr}:${portForward.srcPort}:${portForward.dstAddr}:${portForward.dstPort}`,
						name,
						type: 'portForward',
						parent: connectionNode,
						portForward,
						children: []
					};
					connectionNode.children.push(portForwardNode);
				}
			}

			return connectionNode;
		}
		return undefined;
	}

	private processNodeTree(tree: TreeNode[], parent?: TreeNode): TreeNode[] {
		const newNodes: TreeNode[] = [];
		const { iconPath, iconPathConnected, folder, ...filteredConfig } = (<FolderNode>parent)?.config || {};

		for (const node of tree) {
			if (node.type === 'connection') {
				const connectionNode = <ConnectionNode>node;
				if (parent) {
					connectionNode.config = { ...filteredConfig, ...connectionNode.config };
				}
				if (connectionNode.config.jumpServer) {
					const jumpServer = tree.find((n) => n.type === 'connection' && (<ConnectionNode>n).name === connectionNode.config.jumpServer);
					if (jumpServer) {
						jumpServer.children.push(connectionNode);
						connectionNode.parent = jumpServer;
					}
					else {
						newNodes.push(node);
					}
				}
				else {
					newNodes.push(node);
				}
			}
			else if (node.type === 'folder') {
				const folderNode = <FolderNode>node;
				folderNode.config = { ...filteredConfig, ...folderNode.config };
				node.children = this.processNodeTree(node.children, node);
				newNodes.push(node);
			}
			else {
				newNodes.push(node);
			}
		}
		return newNodes;
	}
}
