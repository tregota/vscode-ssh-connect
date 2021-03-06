import * as vscode from 'vscode';

export class NotebookCompletionProvider implements vscode.CompletionItemProvider {

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
    if (!document.fileName.endsWith('.sshbook')) {
      return undefined;
    }
    const completionItems: vscode.CompletionItem[] = [];

    // checking for run location doesn't work right now since document no longer have a notebook reference
    // see: https://github.com/microsoft/vscode/issues/102091

    // validate that the javascript cell has runLocation set to client
    // const notebook: vscode.NotebookDocument = (<any>document).notebook;
    // const cell = notebook.getCells().find((cell) => cell.document.uri === document.uri);
    // if (!cell || cell.metadata.runLocation !== 'client') {
    //   return undefined;
    // }

    // const linePrefix = document.lineAt(position).text.substring(0, position.character);

    completionItems.push({
      label: 'sshconnect',
      insertText: new vscode.SnippetString('sshconnect($0);'),
      detail: 'sshconnect(...hostIds: (string | RegExp)[])',
      documentation: "Connect to one or more host.\nWill be used by following cells in a multi cell run.\nSupports regex.\nsshconnect('Folder/Host');",
      kind: vscode.CompletionItemKind.Function,
      sortText: '0'
    });
    // if (linePrefix.endsWith('sshconnect(')) {
    //   completionItems.push({
    //     label: 'connect',
    //     detail: 'tell ssh-connect to connect to one or more remote host',
    //     documentation: 'ssh.connect(...hostIds: string[])',
    //     kind: vscode.CompletionItemKind.Function,
    //     sortText: '0'
    //   });
    // }

    completionItems.push({
      label: 'sshdisconnect',
      insertText: new vscode.SnippetString('sshdisconnect($0);'),
      detail: 'sshdisconnect(hostId: string)',
      documentation: "Disconnect from a host.\nRemaining will be used by following cells in a multi cell run.\nsshdisconnect('Folder/Host');",
      kind: vscode.CompletionItemKind.Function,
      sortText: '0'
    });

    completionItems.push({
      label: 'outputs',
      insertText: 'outputs',
      detail: 'var outputs: {[key: string]: string}',
      documentation: 'Object with all host outputs from last cell in multi cell run, indexed by host id',
      kind: vscode.CompletionItemKind.Variable,
      sortText: '0'
    });

    completionItems.push({
      label: 'forofhosts',
      insertText: new vscode.SnippetString('for (const [hostId, output] of Object.entries(outputs)) {\n\t${0}\n}'),
      detail: 'For-Of Outputs from last cell in multi cell run',
      kind: vscode.CompletionItemKind.Snippet,
      sortText: '0'
    });

    return completionItems;
  }
}