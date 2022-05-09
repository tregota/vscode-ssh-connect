'use strict';

import * as vscode from 'vscode';
import ConnectionsProvider from './classes/ConnectionsProvider';
import SSHConnectProvider, { ConnectionNode, PortForwardNode } from './classes/SSHConnectProvider';

export async function activate(context: vscode.ExtensionContext) {
	try {
		const outputChannel = vscode.window.createOutputChannel("SSH Connect");

		const connectionsProvider = new ConnectionsProvider(outputChannel);
		const sshConnectProvider = new SSHConnectProvider(context, connectionsProvider);
		vscode.window.registerTreeDataProvider('ssh-connect.mainview', sshConnectProvider);

		vscode.commands.registerCommand('ssh-connect.connect', (node: ConnectionNode) => connectionsProvider.connect(node).catch((err) => {})); // ignore errors here
		vscode.commands.registerCommand('ssh-connect.disconnect', (node: ConnectionNode) => connectionsProvider.disconnect(node));
		vscode.commands.registerCommand('ssh-connect.openPort', (node: PortForwardNode) => connectionsProvider.openPort(node));
		vscode.commands.registerCommand('ssh-connect.closePort', (node: PortForwardNode) => connectionsProvider.closePort(node));
		vscode.commands.registerCommand('ssh-connect.openTerminal', (node: ConnectionNode) => connectionsProvider.openTerminal(node));

		vscode.commands.registerCommand('ssh-connect.refresh', () => sshConnectProvider.fullRefresh());
		vscode.commands.registerCommand('ssh-connect.openLink', (node: PortForwardNode) => sshConnectProvider.openLink(node));
	}
	catch (error) {
		console.error(error);
	}
}