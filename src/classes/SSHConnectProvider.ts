import * as vscode from 'vscode';
import ConnectionConfig, { PortForwardConfig } from './ConnectionConfig';
import ConnectionsProvider from './ConnectionsProvider';
import { readFileSync } from 'fs';

interface TreeNode {
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
	type: "file" | "sftp"
	connection: string
	autoConnect: boolean
	path: string
}

export default class SSHConnectProvider implements vscode.TreeDataProvider<TreeNode> {

	private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | void> = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | void> = this._onDidChangeTreeData.event;

	private allTreeNodes: { [id: string]: TreeNode } = {};
	private topTreeNodes: TreeNode[] = [];
	private treeNodesLastUpdate: Date = new Date('1970-01-01');
	private configRefresh: boolean = true;
	private externalConfigCache: { [id: string]: ConnectionConfig[] } = {};

	constructor(private readonly context: vscode.ExtensionContext, private readonly connectionsProvider: ConnectionsProvider) {
		vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
			if (event.affectsConfiguration('ssh-connect.connections') || event.affectsConfiguration('ssh-connect.configPaths')) {
				this.configRefresh = true;
				this.refresh();
			}
		});
		connectionsProvider.onDidChange(() => {
			this.refresh();
		});
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	public fullRefresh(): void {
		this.configRefresh = true;
		this._onDidChangeTreeData.fire();
	}

	public async connect(id: string): Promise<void> {
		const node = <ConnectionNode>this.allTreeNodes[id];
		if (node?.id) {
			await this.connectionsProvider.connect(node);
		}
		else {
			throw new Error(`${id} not found`);
		}
	}
	public async disconnect(id: string): Promise<void> {
		const node = <ConnectionNode>this.allTreeNodes[id];
		if (node?.id) {
			await this.connectionsProvider.disconnect(node);
		}
		else {
			throw new Error(`${id} not found`);
		}
	}

	public openLink(node: TreeNode): void {
		if (node.type === 'portForward') {
			let portForward = (<PortForwardNode>node).portForward;
			vscode.env.openExternal(vscode.Uri.parse(`${portForward.type}://localhost:${portForward.srcPort}`));
		}
	}

	public getTreeItem(node: TreeNode): vscode.TreeItem {
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
						iconPath = connectionNode.config.iconPathConnected || this.context.asAbsolutePath('media/server-online.svg');
						break;
					default:
						iconPath = iconPath || this.context.asAbsolutePath('media/server-offline.svg');
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
			icon = 'circle-outline';

			if (!portForwardNode.portForward.srcPort || !portForwardNode.portForward.dstPort) {
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
						color = new vscode.ThemeColor("terminal.ansiGreen");
						icon = 'circle-filled';
						break;
					case 'error':
						color = new vscode.ThemeColor("list.errorForeground");
						break;
				}
			}
			if (portForwardNode.portForward.type) {
				if (['http', 'https'].includes(portForwardNode.portForward.type)) {
					subtype = 'Linked';
				}
			}
		}
		else {
			const folderNode = <FolderNode>node;
			iconPath = folderNode.config.iconPath || this.context.asAbsolutePath('media/folder.svg');
		}

		return {
			label: node.name,
			contextValue: status ? `${node.type}${subtype}.${status}` : node.type,
			collapsibleState,
			iconPath: iconPath || new vscode.ThemeIcon(icon, color),
			description
		};
	}

	public async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (node) {
			return node.children;
		}
		else if (this.configRefresh || this.treeNodesLastUpdate.getTime() + 5000 < new Date().getTime()) {
			await this.loadNodeTree();
			this.configRefresh = false;
		}
		return this.topTreeNodes;
	}

	private async loadNodeTree(): Promise<void> {
		const nodeTree: TreeNode[] = [];
		this.allTreeNodes = {};

		let vsConfigurations: ConnectionConfig[] = vscode.workspace.getConfiguration('ssh-connect').get('connections') || [];
		for (const configuration of vsConfigurations) {
			const node = <ConnectionNode>this.addToNodeTree(nodeTree, configuration.folder?.split('/') || [], configuration);
			if(node?.id) {
				this.allTreeNodes[node!.id] = node!;
			}
		}

		const configFiles: ConfigurationSource[] = vscode.workspace.getConfiguration('ssh-connect').get('configurations') || [];
		for (const configurationSource of configFiles) {
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
						if (this.configRefresh || !(id in this.externalConfigCache)) {
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
				if (json || id in this.externalConfigCache) {
					let configurations;
					if (json) {
						try {
							configurations = JSON.parse(json);
							this.externalConfigCache[id] = configurations;
						}
						catch (e) {
							vscode.window.showErrorMessage(`Could not parse configuration file ${configurationSource.path} - ${e.message}`);
						}
					}
					else {
						configurations = this.externalConfigCache[id];
					}

					for (const configuration of configurations) {
						const node = <ConnectionNode>this.addToNodeTree(nodeTree, configuration.folder?.split('/') || [], configuration);
						if(node.id) {
							this.allTreeNodes[node.id] = node;
						}
					}
				}
			} catch (error) {}
		}

		this.topTreeNodes = this.processNodeTree(nodeTree);
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
					let name = `${portForward.srcPort}`;
					if(portForward.dstAddr && !['localhost', '127.0.0.1', '::1'].includes(portForward.dstAddr)) {
						name += ` ➝ ${portForward.dstAddr}${portForward.dstPort && portForward.dstPort !== portForward.srcPort ? `:${portForward.dstPort}` : ''}`;
					}
					else if (portForward.dstPort && portForward.dstPort !== portForward.srcPort) {
						name += ` ➝ ${portForward.dstPort}`;
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
