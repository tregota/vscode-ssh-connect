import { Client, ClientChannel } from 'ssh2';
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
    let connections = await this.sshConnectProvider.getSelectedNodeConnections();
    let runAll = false;
    try {
      for (let cell of cells) {
        if (!runAll && cells.length > 1) {
          const answer = await vscode.window.showInformationMessage("Are you sure you want to run multiple cells?", "Yes", "No");
          if (answer === "Yes") {
            runAll = true;
          }
          else {
            break;
          }
        }
        await this._doExecution(cell, connections);
      }
    }
    catch (e) {
      vscode.window.showInformationMessage(`Execution interupted: ${e.message}`);
    }
  }

  private async _doExecution(cell: vscode.NotebookCell, connections: Connection[]): Promise<Connection[]> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this._executionOrder;
    execution.start(Date.now()); // Keep track of elapsed time to execute cell.
    execution.clearOutput();
    if (!connections.length) {
      execution.appendOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('No script target selected in SSH Connect Hosts view, connect to a host or click on the row of one that is already connected.')])
      ]);
      execution.end(false, Date.now());
      return Promise.reject();
    }

    const outputs = connections.map((c) => `Running on ${c.node.name}...\n`);
    const refreshOutput = () => {
      execution.replaceOutput(outputs.map((output, i) => new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(output)])));
    };
    refreshOutput();
    const streams = new Set<ClientChannel>();
    let canceled = false;

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
      const promises = connections.map((connection, i) => {
        return new Promise<Connection>((resolve, reject) => {
          connection.client.exec(command, (err, stream) => {
            if (err) {
              execution.appendOutput([
                new vscode.NotebookCellOutput([
                  vscode.NotebookCellOutputItem.error(err)
                ])
              ]);
              return reject(err);
            }
            streams.add(stream);
            
            stream.on('close', () => {
              streams.delete(stream);
              if (streams.size === 0) {
                execution.end(!canceled, Date.now());
                if (canceled) {
                  reject(new Error('canceled'));
                }
                else {
                  resolve(connection);
                }
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
      });

      execution.token.onCancellationRequested(() => {
        canceled = true;
        for (const stream of streams) {
          stream.destroy();
        }
      });
      
      return Promise.all(promises);
    }
    return Promise.reject('Invalid command');
  }
}