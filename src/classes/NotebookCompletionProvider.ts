import * as vscode from 'vscode';

export class NotebookCompletionProvider implements vscode.CompletionItemProvider {

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
    if (!document.fileName.endsWith('.sshbook')) {
      return undefined;
    }

    // validate that the javascript cell has runLocation set to client
    const completionItems: vscode.CompletionItem[] = [];
    const notebook: vscode.NotebookDocument = (<any>document).notebook;
    const cell = notebook.getCells().find((cell) => cell.document.uri === document.uri);
    if (!cell || cell.metadata.runLocation !== 'client') {
      return undefined;
    }

    // const linePrefix = document.lineAt(position).text.substring(0, position.character);
    // if (linePrefix.endsWith('ssh.')) {
    //   completionItems.push({
    //     label: 'connect',
    //     detail: 'tell ssh-connect to connect to one or more remote host',
    //     documentation: 'ssh.connect(...hostIds: string[])',
    //     kind: vscode.CompletionItemKind.Function,
    //     sortText: '0'
    //   });
    // }

    completionItems.push({
      label: 'sshconnect',
      detail: 'sshconnect(...hostIds: (string | RegExp)[])',
      documentation: "Connect to one or more host.\nWill be used by following cells in a multi cell run.\nSupports regex.\ssshconnect('Folder/Host');",
      kind: vscode.CompletionItemKind.Function,
      sortText: '0'
    });

    completionItems.push({
      label: 'outputs',
      insertText: 'outputs',
      detail: 'var outputs: {[key: string]: string}',
      documentation: 'Object with all host outputs from last cell, indexed by host id',
      kind: vscode.CompletionItemKind.Variable,
      sortText: '0'
    });
    completionItems.push({
      label: 'forofhosts',
      insertText: "for (const [hostId, output] of Object.entries(outputs)) {\n\t\n}",
      detail: 'For-Of Outputs from last cell',
      kind: vscode.CompletionItemKind.Snippet,
      sortText: '0'
    });

    return completionItems;
  }
}