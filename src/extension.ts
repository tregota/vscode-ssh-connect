'use strict';

import * as vscode from 'vscode';
import ConnectionsProvider from './classes/ConnectionsProvider';
import SSHConnectProvider, { ConnectionNode, PortForwardNode, ConnectionCommandNode, PortCommandNode } from './classes/SSHConnectProvider';

export async function activate(context: vscode.ExtensionContext) {
	try {
		const outputChannel = vscode.window.createOutputChannel("SSH Connect");

		const connectionsProvider = new ConnectionsProvider(outputChannel);
		const sshConnectProvider = new SSHConnectProvider(context, connectionsProvider);
		vscode.window.registerTreeDataProvider('ssh-connect.mainview', sshConnectProvider);

		vscode.commands.registerCommand('ssh-connect.connect', async (node: ConnectionNode | string[]) => {
			try {
				if (node.constructor === Array) {
					await sshConnectProvider.connect(node[0]);
				}
				else  {
					await connectionsProvider.connect(<ConnectionNode>node);
				}
			} catch (e) {
				outputChannel.appendLine(e.message);
				vscode.window.showErrorMessage(e.message);
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
		vscode.commands.registerCommand('ssh-connect.runCommand', (node: ConnectionCommandNode | PortCommandNode) => {
			if(node.type === 'portCommand') {
				sshConnectProvider.runPortCommand(<PortCommandNode>node);
			}
			else {
				connectionsProvider.runCommand(<ConnectionCommandNode>node);
			}
		});
	}
	catch (error) {
		console.error(error);
	}
}