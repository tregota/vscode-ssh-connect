'use strict';

import * as vscode from 'vscode';
import ConnectionsProvider from './classes/ConnectionsProvider';
import { NotebookCellStatusBarItemProvider } from './classes/NotebookCellStatusBarItemProvider';
import { NotebookCompletionProvider } from './classes/NotebookCompletionProvider';
import { NotebookController } from './classes/NotebookController';
import { NotebookSerializer } from './classes/NotebookSerializer';
import SSHConnectProvider, { ConnectionNode, PortForwardNode, TreeNode } from './classes/SSHConnectProvider';
import * as keytar from 'keytar';

export async function activate(context: vscode.ExtensionContext) {
	try {
		const outputChannel = vscode.window.createOutputChannel("SSH Connect");

		const connectionsProvider = new ConnectionsProvider(outputChannel);
		const sshConnectProvider = new SSHConnectProvider(context, connectionsProvider);
		vscode.window.registerTreeDataProvider('ssh-connect.mainview', sshConnectProvider);

		// notebook
		context.subscriptions.push(
			new NotebookController(sshConnectProvider),
			vscode.workspace.registerNotebookSerializer('ssh-connect.notebook', new NotebookSerializer()),
			vscode.notebooks.registerNotebookCellStatusBarItemProvider('ssh-connect.notebook', new NotebookCellStatusBarItemProvider()),
			vscode.languages.registerCompletionItemProvider('javascript', new NotebookCompletionProvider(), '.')
		);

		vscode.commands.registerCommand('ssh-connect.connect', async (node: ConnectionNode | string[]) => {
			try {
				if (Array.isArray(node)) {
					const connectionNode = await sshConnectProvider.connect(node[0]);
					await sshConnectProvider.selectNode(connectionNode);
				}
				else  {
					await connectionsProvider.connect(<ConnectionNode>node);
					await sshConnectProvider.selectNode(<ConnectionNode>node);
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
				if (Array.isArray(node)) {
					const connectionNode = await sshConnectProvider.disconnect(node[0]);
					sshConnectProvider.unselectNode(connectionNode);
				}
				else {
					await connectionsProvider.disconnect(<ConnectionNode>node);
					sshConnectProvider.unselectNode(<ConnectionNode>node);
				}
			} catch (e) {
				outputChannel.appendLine(e.message);
				vscode.window.showErrorMessage(e.message);
			}
		});
		vscode.commands.registerCommand('ssh-connect.openPort', async (node: PortForwardNode) => {
			try {
				const connection = await connectionsProvider.connect(<ConnectionNode>node.parent);
				connectionsProvider.forwardPort(connection, node);
			} catch (e) {
				outputChannel.appendLine(e.message);
				vscode.window.showErrorMessage(e.message);
			}
		});
		vscode.commands.registerCommand('ssh-connect.closePort', (node: PortForwardNode) => connectionsProvider.closePort(node));
		vscode.commands.registerCommand('ssh-connect.openTerminal', (node: ConnectionNode) => connectionsProvider.openTerminal(node));

		vscode.commands.registerCommand('ssh-connect.refresh', () => sshConnectProvider.fullRefresh());
		vscode.commands.registerCommand('ssh-connect.openLink', (node: PortForwardNode) => sshConnectProvider.openLink(node));

		vscode.commands.registerCommand('ssh-connect.selectNode', (node: TreeNode) => sshConnectProvider.selectNode(node));
		vscode.commands.registerCommand('ssh-connect.enableMultiSelect', () => sshConnectProvider.setMultiSelect(true));
		vscode.commands.registerCommand('ssh-connect.disableMultiSelect', () => sshConnectProvider.setMultiSelect(false));

		vscode.commands.registerCommand('ssh-connect.toggleRunLocation', (cell: vscode.NotebookCell) => {
			const edit = new vscode.WorkspaceEdit();
			edit.set(cell.notebook.uri, [
				vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, runLocation: cell.metadata.runLocation !== 'client' ? 'client' : 'server' })
			]);
			vscode.workspace.applyEdit(edit);
		});
		vscode.commands.registerCommand('ssh-connect.toggleEchoOff', (cell: vscode.NotebookCell) => {
			const edit = new vscode.WorkspaceEdit();
			edit.set(cell.notebook.uri, [
				vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, echo: cell.metadata.echo !== 'off' ? 'off' : 'on' })
			]);
			vscode.workspace.applyEdit(edit);
		});
		vscode.commands.registerCommand('ssh-connect.toggleGroupOutputs', (cell: vscode.NotebookCell) => {
			const edit = new vscode.WorkspaceEdit();
			edit.set(cell.notebook.uri, [
				vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, group: cell.metadata.group !== 'on' ? 'on' : 'off' })
			]);
			vscode.workspace.applyEdit(edit);
		});

		vscode.commands.registerCommand('ssh-connect.clearStoredPassword', (node: ConnectionNode) => {
			keytar.deletePassword('vscode-ssh-connect', node.id);
		});
	}
	catch (error) {
		console.error(error);
	}
}