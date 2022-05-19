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

    this._controller.supportedLanguages = ['shellscript', 'python', 'perl', 'javascript', 'php', 'plaintext'];
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
      e && vscode.window.showInformationMessage(`Execution interupted: ${e.message}`);
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


    let interpreter: string | undefined;
    let command = '';
    let rawscript = cell.document.getText();
    if (rawscript.startsWith('#!')) {
      const lines = rawscript.split('\n');
      interpreter = lines.shift()?.substring(2);
      rawscript = lines.join("\n");
    }
    if (cell.document.languageId === 'plaintext') {
      if(interpreter) {
        command = `${interpreter} "${rawscript.replace(/(["$`\\])/g,'\\$1')}"`;
      }
      else {
        execution.appendOutput([
          new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('Plaintext needs shebang to tell which interpreter to call, escaped script string will be added as last argument')])
        ]);
        execution.end(false, Date.now());
        return Promise.reject();
      }
    }
    else if (cell.document.languageId === 'shellscript') {
      if(interpreter) {
        command = `${interpreter} "${rawscript.replace(/(["$`\\])/g,'\\$1')}"`;
      }
      else {
        command = rawscript;
      }
    }
    else if (cell.document.languageId === 'python') {
      command = `${interpreter||'python'} -c "${rawscript.replace(/(["$`\\])/g,'\\$1')}"`;
    }
    else if (cell.document.languageId === 'perl') {
      command = `${interpreter||'perl'} -e "${rawscript.replace(/(["$`\\])/g,'\\$1')}"`;
    }
    else if (cell.document.languageId === 'javascript') {
      command = `${interpreter||'node'} -e "${rawscript.replace(/(["$`\\])/g,'\\$1')}"`;
    }
    else if (cell.document.languageId === 'php') {
      command = `${interpreter||'php'} -r "${rawscript.replace(/(["$`\\])/g,'\\$1')}"`;
    }

    if (command) {
      const promises = connections.map((connection, i) => {
        return new Promise<Connection>((resolve, reject) => {
          connection.client.exec(command, { pty: true }, (err, stream) => {
            if (err) {
              outputs[i] += err.message;
              refreshOutput();
              return reject(err);
            }
            streams.add(stream);
            
            stream.on('close', () => {
              streams.delete(stream);
              if (canceled) {
                reject(new Error('canceled'));
              }
              else {
                resolve(connection);
              }
            }).on('data', (data: Buffer) => {
              // cannot activate pty without ONLCR mode (for some reason) which converts NL to CR-NL so to fix that we remove all CR from result and hope nothing breaks
              outputs[i] += data.toString().replace(/\n/g, '');
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
      
      const resolvedPromises = await Promise.allSettled(promises);
      execution.end(true, Date.now());
      if (resolvedPromises.find(({ status }) => status === 'rejected')) {
        throw new Error('Failure');
      }
      return resolvedPromises.filter(({ status }) => status === 'fulfilled').map((p) => (<any>p).value);
    }
    execution.end(false, Date.now());
    return Promise.reject();
  }
}