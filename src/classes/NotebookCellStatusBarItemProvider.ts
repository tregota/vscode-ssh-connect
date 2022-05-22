import * as vscode from 'vscode';

export class NotebookCellStatusBarItemProvider implements vscode.NotebookCellStatusBarItemProvider {
  provideCellStatusBarItems(cell: vscode.NotebookCell, token: vscode.CancellationToken): vscode.ProviderResult<vscode.NotebookCellStatusBarItem | vscode.NotebookCellStatusBarItem[]> {
    const statusBarItems: vscode.NotebookCellStatusBarItem[] = [];

    const info = new vscode.NotebookCellStatusBarItem(
      '$(info)',
      vscode.NotebookCellStatusBarAlignment.Left
    );
    statusBarItems.push(info);

    if (cell.document.languageId === 'javascript') {
      if (cell.metadata['runLocation'] === 'client') {
        info.tooltip = 'previous cell\'s output for all hosts in output[host] (e.g. output["folder/server1"]), returned output object will be available to the following cell.';
      }
      else {
        info.tooltip = 'previous cell\'s output for host inserted at placeholder {{output}}';
      }

      const runLocation = new vscode.NotebookCellStatusBarItem(
        cell.metadata['runLocation'] === 'client' ? '$(home) local' : '$(globe) remote',
        vscode.NotebookCellStatusBarAlignment.Left
      );
      runLocation.tooltip = `Javascript can run on client or server.`;
      runLocation.command = 'ssh-connect.toggleRunLocation';
      statusBarItems.push(runLocation);
    }
    else {
      info.tooltip = 'previous cell\'s output for host inserted at placeholder {{output}}';
    }

    return statusBarItems;
  }
}