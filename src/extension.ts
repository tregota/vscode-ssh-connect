'use strict';

import * as vscode from 'vscode';
import ConnectionsProvider from './classes/ConnectionsProvider';
import { NotebookController } from './classes/NotebookController';
import { NotebookSerializer } from './classes/NotebookSerializer';
import SSHConnectProvider, { ConnectionNode, PortForwardNode } from './classes/SSHConnectProvider';

export async function activate(context: vscode.ExtensionContext) {
	try {
		const outputChannel = vscode.window.createOutputChannel("SSH Connect");

		const connectionsProvider = new ConnectionsProvider(outputChannel);
		const sshConnectProvider = new SSHConnectProvider(context, connectionsProvider);
		vscode.window.registerTreeDataProvider('ssh-connect.mainview', sshConnectProvider);

		context.subscriptions.push(new NotebookController(sshConnectProvider));
		context.subscriptions.push(vscode.workspace.registerNotebookSerializer('sshconnect-notebook', new NotebookSerializer(), {
			// transientOutputs: false,
			// transientCellMetadata: {
			// 	inputCollapsed: true,
			// 	outputCollapsed: true,
			// }
		}));

		vscode.commands.registerCommand('ssh-connect.connect', async (node: ConnectionNode | string[]) => {
			try {
				if (node.constructor === Array) {
					await sshConnectProvider.connect(node[0]);
					await sshConnectProvider.setNotebookTarget(node[0], true);
				}
				else  {
					await connectionsProvider.connect(<ConnectionNode>node);
					await sshConnectProvider.setNotebookTarget((<ConnectionNode>node).id, true);
				}
			} catch (e) {
				if (e) {
					outputChannel.appendLine(e.message);
					vscode.window.showErrorMessage(e.message);
				}
			}
		}); 
		vscode.commands.registerCommand('ssh-connect.disconnect', async (node: ConnectionNode | string[]) => {
			try {
				if (node.constructor === Array) {
					await sshConnectProvider.disconnect(node[0]);
				}
				else {
					await connectionsProvider.disconnect(<ConnectionNode>node);
				}
			} catch (e) {
				outputChannel.appendLine(e.message);
				vscode.window.showErrorMessage(e.message);
			}
		});
		vscode.commands.registerCommand('ssh-connect.openPort', (node: PortForwardNode) => connectionsProvider.openPort(node));
		vscode.commands.registerCommand('ssh-connect.closePort', (node: PortForwardNode) => connectionsProvider.closePort(node));
		vscode.commands.registerCommand('ssh-connect.openTerminal', (node: ConnectionNode) => connectionsProvider.openTerminal(node));

		vscode.commands.registerCommand('ssh-connect.refresh', () => sshConnectProvider.fullRefresh());
		vscode.commands.registerCommand('ssh-connect.openLink', (node: PortForwardNode) => sshConnectProvider.openLink(node));
		vscode.commands.registerCommand('ssh-connect.setScriptTarget', (targetPath: string) => sshConnectProvider.setNotebookTarget(targetPath));
	}
	catch (error) {
		console.error(error);
	}
}