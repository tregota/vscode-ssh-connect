import * as vscode from 'vscode';
import * as vm from 'vm';
import { ClientChannel } from 'ssh2';
import { Connection } from './ConnectionsProvider';
import SSHConnectProvider from './SSHConnectProvider';
import { KeyObject } from 'crypto';

interface ConnectionOutputs {
  [key: string]: string;
}

export class NotebookController {
  readonly id: string = 'ssh-connect.notebook-controller';
  readonly notebookType: string = 'ssh-connect.notebook';
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
    let connectionsChangedForMulti = false;
    let runAll = false;
    let runData: {[key: string]: any} = {};
    try {
      for (let cell of cells) {
        if (cell.metadata.runLocation === 'client') {
          let newConnections = await this._doLocalExecution(cell, connections, runData);
          if (newConnections) {
            connections = newConnections; 
            if (cells.length > 1) {
              connectionsChangedForMulti = true;
              runAll = true;
            }
          }
        }
        else {
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
    }
    catch (err) {
      vscode.window.showInformationMessage(`Execution interupted: ${err.message}`);
    }
    if (connectionsChangedForMulti) {
      await this.sshConnectProvider.setMultiSelect(false);
    }
  }

  private async _doExecution(cell: vscode.NotebookCell, connections: Connection[]): Promise<Connection[] | undefined> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this._executionOrder;
    execution.start(Date.now()); // Keep track of elapsed time to execute cell.
    execution.clearOutput();

    if (!connections.length) {
      execution.appendOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('No script target selected in SSH Connect Hosts view, connect to a host or click on the row of one that is already connected.')])
      ]);
      execution.end(false, Date.now());
      throw new Error('No script target');
    }

    let aboveOutputs: { [key: string]: string } = {};
    if (cell.index > 0) {
      const aboveCell = cell.notebook.cellAt(cell.index-1);
      if (aboveCell && aboveCell.outputs.length > 0) {
        aboveOutputs = <{ [key: string]: string }>JSON.parse(aboveCell.outputs[0].items[1].data.toString());
      }
    }

    const outputs: ConnectionOutputs = {};
    const errors: { [key: string]: Error } = {};
    const nameById: { [key: string]: string } = connections.reduce((acc, connection) => ({ ...acc, [connection.node.id]: connection.node.name }), {});
    const fontFamily: string | undefined = vscode.workspace.getConfiguration('terminal').get('integrated.fontFamily');

    const renewOutputs = () => {
      const trimmedOutputs : { [key: string]: string } = {};
      for (const [id, text] of Object.entries(outputs)) {
        trimmedOutputs[id] = text.trimEnd();
      }

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.stdout(`Running on ${connections.map(c => `"${c.node.name}"`).join(', ')}...`),
          vscode.NotebookCellOutputItem.json(trimmedOutputs)
        ]),
        ...Object.entries(nameById).map(([id, name]) => this.cssTerminal(name, outputs[id], errors[id], fontFamily))
      ]);
    };
    const print = (id: string, text: string) => {
      outputs[id] = outputs[id] ? outputs[id] + text : text;
      renewOutputs();
    };

    const streams = new Set<ClientChannel>();
    let canceled = false;

    let interpreter: string | undefined;
    let rawscript = cell.document.getText();
    if (rawscript.startsWith('#!')) {
      const lines = rawscript.split('\n');
      interpreter = lines.shift()?.substring(2);
      rawscript = lines.join("\n");
    }

    if (!interpreter) {
      if (cell.document.languageId === 'plaintext') {
        execution.appendOutput([
          new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('Plaintext needs shebang to tell which interpreter to call, escaped script string will be added as last argument')])
        ]);
        execution.end(false, Date.now());
        throw new Error('Plaintext needs shebang');
      }
      else if (cell.document.languageId === 'python') {
        interpreter = 'python -c';
      }
      else if (cell.document.languageId === 'perl') {
        interpreter = 'perl -e';
      }
      else if (cell.document.languageId === 'javascript') {
        interpreter = 'node -e';
      }
      else if (cell.document.languageId === 'php') {
        interpreter = 'php -r';
      }
    }

    if (rawscript) {
      const promises = connections.map((connection, i) => {
        let command: string;
        if (interpreter) {
          command = `${interpreter} "${rawscript.replace('{{output}}', aboveOutputs[connection.node.id] || '').replace(/(["$`\\])/g,'\\$1')}"`;
        }
        else {
          command = rawscript.replace('{{output}}', aboveOutputs[connection.node.id] || '');
        }
        return new Promise<string>((resolve, reject) => {
          connection.client.exec(command, { pty: true }, (err, stream) => {
            if (err) {
              print(connection.node.id, err.message);
              return reject(err);
            }
            streams.add(stream);
            
            stream.on('close', (code: number) => {
              streams.delete(stream);
              if (code) {
                errors[connection.node.id] = new Error('Code: '+code);
                renewOutputs();
                reject(new Error('exit code: ' + code));
              }
              else if (canceled) {
                reject(new Error('canceled'));
              }
              else {
                resolve(outputs[i]);
              }
            }).on('data', (data: Buffer) => {
              // cannot activate pty without ONLCR mode (for some reason) which converts NL to CR-NL so to fix that we remove all CR from result and hope nothing breaks
              print(connection.node.id, data.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
            }).stderr.on('data', (data: Buffer) => {
              print(connection.node.id, data.toString());
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
      const failed = resolvedPromises.find(({ status }) => status === 'rejected');
      if (failed) {
        execution.end(false, Date.now());
        throw (failed as PromiseRejectedResult).reason;
      }
      execution.end(true, Date.now());
      return undefined;
    }
    execution.end(false, Date.now());
    throw new Error('Empty script');
  }

  private async _doLocalExecution(cell: vscode.NotebookCell, connections: Connection[], runData: {[key: string]: any}): Promise<Connection[] | undefined> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this._executionOrder;
    execution.start(Date.now()); // Keep track of elapsed time to execute cell.
    execution.clearOutput();

    let aboveOutputs: { [key: string]: string } = {};
    if (cell.index > 0) {
      const aboveCell = cell.notebook.cellAt(cell.index-1);
      if (aboveCell && aboveCell.outputs.length > 0) {
        aboveOutputs = <{ [key: string]: string }>JSON.parse(aboveCell.outputs[0].items[1].data.toString());
      }
    }

    let newHosts: (string | RegExp)[] = [];
    let textOutput = '';
    const print = (text: string) => {
      textOutput += text;
      execution.replaceOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(textOutput, 'text/html')])]);
    };

    const context = {
      runData,
      outputs: aboveOutputs,
      console: {
        ...console,
        log: (...args: any[]) => print(args.join(' ')+'<br />'),
        error: (...args: any[]) => print('<span style="color: #ff4b4b">'+args.join(' ')+'</span><br />'),
      },
      sshconnect: (...hostIds: (string | RegExp)[]) => {
        newHosts = hostIds;
      },
      sshdisconnect: (hostId: string) => {
        newHosts = (newHosts.length > 0 ? newHosts : connections.map(c => c.node.id)).filter(id => id !== hostId);
        delete aboveOutputs[hostId];
      }
    };

    try {
      const script = new vm.Script(execution.cell.document.getText());
      vm.createContext(context);
      script.runInContext(context, {
        filename: execution.cell.document.uri.toString(),
        breakOnSigint: true,
        timeout: 1000 * 10,
        microtaskMode: 'afterEvaluate',
      });

      console.log(context);

      const newOutput = [];
      if (textOutput) {
        newOutput.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(textOutput, 'text/html')]));
      }
      if (Object.keys(context.outputs).length > 0) {
        newOutput.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(context.outputs)]));
      }
      execution.replaceOutput(newOutput);

      const newConnections = newHosts.length > 0 ? await this.sshConnectProvider.connectAndSelect(...newHosts) : undefined;

      execution.end(true, Date.now());
      return newConnections;
    } 
    catch (error) {
      execution.replaceOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(error)])]);
      execution.end(false, Date.now());
      throw error;
    }
  }

  private cssTerminal(name: string, text: string | undefined, error: Error | undefined, fontFamily: string | undefined): vscode.NotebookCellOutput {
    const html = `<div style="background-color: #151515; border-radius: 5px;">
      <div style="padding: 4px 16px; background-color: ${error ? '#ed4337' : '#80aac266'}; color: #151515; font-weight: 500; border-top-left-radius: 5px; border-top-right-radius: 5px">${name}</div>
      <div style="padding: 16px;${!fontFamily?'':'font-family: '+fontFamily}">${text ? text.replace(/\n/g,'<br />') : ''}</div>
    </div>`;
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(html, 'text/html')]);
  }
}