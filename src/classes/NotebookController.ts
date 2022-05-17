import { Client } from 'ssh2';
import * as vscode from 'vscode';
import { Connection } from './ConnectionsProvider';
import SSHConnectProvider from './SSHConnectProvider';

export class NotebookController {
  readonly id: string = 'sshconnect-notebook-controller';
  readonly notebookType: string = 'sshconnect-notebook';
  readonly label: string = 'SSH Connect Notebook';

  private readonly _controller: vscode.NotebookController;
  private _executionOrder = 0;

  constructor(private readonly sshConnectProvider: SSHConnectProvider) {
    this._controller = vscode.notebooks.createNotebookController(
      this.id,
      this.notebookType,
      this.label
    );

    this._controller.supportedLanguages = ['shellscript', 'python', 'perl'];
    this._controller.supportsExecutionOrder = true;
		this._controller.description = 'A notebook for running scripts on remote host.';
    this._controller.executeHandler = this._execute.bind(this);
  }
  
  dispose(): void {
		this._controller.dispose();
	}

  private async _execute(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    const connection = await this.sshConnectProvider.getNotebookTargetConnection();
    for (let cell of cells) {
      await this._doExecution(cell, connection ? [connection] : undefined);
    }

  }

  private async _stopExecution(execution: vscode.NotebookCellExecution): Promise<void> {
    console.log('todo: stop it');
    // maybe: https://github.com/mscdex/ssh2/issues/704
  }

  private async _doExecution(cell: vscode.NotebookCell, connections: Connection[] | undefined): Promise<void> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this._executionOrder;
    execution.start(Date.now()); // Keep track of elapsed time to execute cell.
    execution.clearOutput();
    if (!connections) {
      execution.appendOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('No script target selected in hosts view.')])
      ]);
      execution.end(false, Date.now());
      return;
    }

    const outputs = connections.map((c) => `Running on ${c.node.name}...\n`);
    const refreshOutput = () => {
      execution.replaceOutput(outputs.map((output, i) => new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(output)])));
    };
    refreshOutput();
    let stillRunning = connections.length;

    // todo: local nodejs scripts? https://github.com/microsoft/vscode-nodebook

    let command = '';
    if (cell.document.languageId === 'shellscript') {
      command = cell.document.getText();
    }
    else if (cell.document.languageId === 'python') {
      command = `python -c "${cell.document.getText().replace(/(["'$`\\])/g,'\\$1')}"`;
    }
    else if (cell.document.languageId === 'perl') {
      command = `perl -e "${cell.document.getText().replace(/(["'$`\\])/g,'\\$1')}"`;
    }

    if (command) {
      connections.map((connection, i) => {
        connection.client.exec(command, (err, stream) => {
          if (err) {
            execution.appendOutput([
              new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error(err)
              ])
            ]);
            return;
          }
          stream.on('close', () => {
            stillRunning--;
            if (stillRunning === 0) {
              execution.end(true, Date.now());
            }
          }).on('data', (data: Buffer) => {
            outputs[i] += data.toString();
            refreshOutput();
          }).stderr.on('data', (data: Buffer) => {
            outputs[i] += data.toString();
            refreshOutput();
          });
        });
      });
    }
  }
}