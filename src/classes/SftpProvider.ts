// import * as vscode from 'vscode';
// import { basename, dirname, join } from 'path';

// export interface FtpNode {
// 	resource: vscode.Uri;
// 	isDirectory: boolean;
// }

// export class FtpTreeDataProvider implements vscode.TreeDataProvider<FtpNode>, vscode.TextDocumentContentProvider {

// 	private _onDidChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
// 	readonly onDidChangeTreeData: vscode.Event<any> = this._onDidChangeTreeData.event;

// 	constructor(private readonly model: FtpModel) { }

// 	public refresh(): any {
// 		this._onDidChangeTreeData.fire(undefined);
// 	}


// 	public getTreeItem(element: FtpNode): vscode.TreeItem {
// 		return {
// 			resourceUri: element.resource,
// 			collapsibleState: element.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : void 0,
// 			command: element.isDirectory ? void 0 : {
// 				command: 'ftpExplorer.openFtpResource',
// 				arguments: [element.resource],
// 				title: 'Open FTP Resource'
// 			}
// 		};
// 	}

// 	public getChildren(element?: FtpNode): FtpNode[] | Thenable<FtpNode[]> {
// 		return element ? this.model.getChildren(element) : this.model.roots;
// 	}

// 	public getParent(element: FtpNode): FtpNode {
// 		const parent = element.resource.with({ path: dirname(element.resource.path) });
// 		return parent.path !== '//' ? { resource: parent, isDirectory: true } : null;
// 	}

// 	public provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
// 		return this.model.getContent(uri).then(content => content);
// 	}
// }

// export class FtpExplorer {

// 	private ftpViewer: vscode.TreeView<FtpNode>;

// 	constructor(context: vscode.ExtensionContext) {
// 		/* Please note that login information is hardcoded only for this example purpose and recommended not to do it in general. */
// 		const ftpModel = new FtpModel('mirror.switch.ch', 'anonymous', 'anonymous@anonymous.de');
// 		const treeDataProvider = new FtpTreeDataProvider(ftpModel);
// 		context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ftp', treeDataProvider));

// 		this.ftpViewer = vscode.window.createTreeView('ftpExplorer', { treeDataProvider });

// 		vscode.commands.registerCommand('ftpExplorer.refresh', () => treeDataProvider.refresh());
// 		vscode.commands.registerCommand('ftpExplorer.openFtpResource', resource => this.openResource(resource));
// 		vscode.commands.registerCommand('ftpExplorer.revealResource', () => this.reveal());
// 	}

// 	private openResource(resource: vscode.Uri): void {
// 		vscode.window.showTextDocument(resource);
// 	}

// 	private reveal(): Thenable<void> {
// 		const node = this.getNode();
// 		if (node) {
// 			return this.ftpViewer.reveal(node);
// 		}
// 		return null;
// 	}

// 	private getNode(): FtpNode {
// 		if (vscode.window.activeTextEditor) {
// 			if (vscode.window.activeTextEditor.document.uri.scheme === 'ftp') {
// 				return { resource: vscode.window.activeTextEditor.document.uri, isDirectory: false };
// 			}
// 		}
// 		return null;
// 	}
// }