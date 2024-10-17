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
        info.tooltip = 'previous cell\'s output for all hosts in outputs[host] (e.g. outputs["folder/server1"]), modified outputs will be available to following cells in same run.';
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

    if (cell.metadata['runLocation'] !== 'client' || cell.document.languageId !== 'javascript') {
      if (cell.metadata['echo'] !== 'off') {
        const groupToggle = new vscode.NotebookCellStatusBarItem(
          cell.metadata['output'] === 'groups' ? '$(combine)' : cell.metadata['output'] === 'files' ? '$(save-all)' : '$(multiple-windows)',
          vscode.NotebookCellStatusBarAlignment.Right
        );
        groupToggle.tooltip = cell.metadata['output'] === 'groups' ? 'Grouping outputs' : cell.metadata['output'] === 'files' ? 'Writing outputs to files' : 'Separate outputs',
        groupToggle.command = 'ssh-connect.switchOutputMethod';
        statusBarItems.push(groupToggle);
      }

      const echoToggle = new vscode.NotebookCellStatusBarItem(
        cell.metadata['echo'] === 'off' ? '$(eye-closed)' : '$(eye)',
        vscode.NotebookCellStatusBarAlignment.Right
      );
      echoToggle.tooltip = cell.metadata['echo'] === 'off' ? 'Hiding outputs' : 'Displaying outputs';
      echoToggle.command = 'ssh-connect.toggleEchoOff';
      statusBarItems.push(echoToggle);
    }

    return statusBarItems;
  }
}