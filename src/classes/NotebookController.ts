import * as vscode from 'vscode';
import * as vm from 'vm';
import { ClientChannel } from 'ssh2';
import { Connection } from './ConnectionsProvider';
import SSHConnectProvider from './SSHConnectProvider';

export class NotebookController {
  readonly id: string = 'ssh-connect.notebook-controller';
  readonly notebookType: string = 'ssh-connect.notebook';
  readonly label: string = 'SSH Connect Notebook';

  private readonly _controller: vscode.NotebookController;
	private readonly _associations = new Map<string, vscode.NotebookDocument>();
  private _executionOrder = 0;
  private terminalCss = "";

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

    this._controller.onDidChangeSelectedNotebooks(({notebook, selected}) => {
      const docKey = notebook.uri.toString();
      if (selected && !this._associations.has(docKey)) {
        this._associations.set(docKey, notebook);
        if (this._associations.size === 1) {
          vscode.commands.executeCommand('setContext', 'ssh-connect.notebookActive', true);
          this.sshConnectProvider.notebookActive = true;
          this.sshConnectProvider.refresh();
        }
      }
      else if (!selected && this._associations.has(docKey)) {
        this._associations.delete(docKey);
        if (this._associations.size === 0) {
          vscode.commands.executeCommand('setContext', 'ssh-connect.notebookActive', false);
          this.sshConnectProvider.notebookActive = false;
          this.sshConnectProvider.refresh();
        }
      }
    });

    // workaround since vscode doesn't recognize empty notebooks as a notebook. it's just undefined
    // this enables notebook selection mode when creating a cell in an empty notebook
    vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      if (editor?.document.uri.scheme === 'vscode-notebook-cell' && !this.sshConnectProvider.notebookActive) {
        this.sshConnectProvider.notebookActive = true;
        vscode.commands.executeCommand('setContext', 'ssh-connect.notebookActive', true);
        this.sshConnectProvider.refresh();
      }
    });

    const fontFamily: string | undefined = vscode.workspace.getConfiguration('terminal').get('integrated.fontFamily');
    const fontSize: string | undefined = vscode.workspace.getConfiguration('terminal').get('integrated.fontSize');
    this.terminalCss = (!fontFamily?'':`font-family: ${fontFamily};`)+(!fontSize?'':`font-size: ${fontSize}px;`);
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
    try {
      for (let cell of cells) {
        if (cell.metadata.runLocation === 'client' && cell.document.languageId === 'javascript') {
          let newConnections = await this._doLocalExecution(cell, connections);
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

    let outputs: { [key: string]: string } = {};
    try {
      if (cell.index > 0) {
        const aboveCell = cell.notebook.cellAt(cell.index-1);
        if (aboveCell && aboveCell.outputs.length > 0) {
          // is it a local javascript cell?
          if (aboveCell.outputs[aboveCell.outputs.length-1].items.length === 1 && aboveCell.outputs[aboveCell.outputs.length-1].items[0].mime === 'text/x-json') {
            outputs = <{ [key: string]: string }>JSON.parse(aboveCell.outputs[aboveCell.outputs.length-1].items[0].data.toString());
          }
          else if (aboveCell.outputs[0].items[1]?.mime === 'text/x-json') {
            outputs = <{ [key: string]: string }>JSON.parse(aboveCell.outputs[0].items[1].data.toString());
          }
        }
      }

      let interpreter: string | undefined;
      let targets: (string | RegExp)[] | undefined;
      let rawscript = cell.document.getText();
      if (rawscript.startsWith('#@') || rawscript.startsWith('#!')) {
        const lines = rawscript.split('\n');
        if (lines[0].startsWith('#@')) {
          targets = [];
          const targetString = lines.shift()!.substring(2);
          for (const target of targetString.split('@').map((t) => t.trim())) {
            const match = target.match(/^\/(.+)\/([^/]*)$/);
            if (match) {
              targets.push(new RegExp(match[1], match[2]));
            }
            else {
              targets.push(target);
            }
          }
        }
        if (lines[0].startsWith('#!')) {
          interpreter = lines.shift()?.substring(2);
        }
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

      if (targets) {
        connections = await this.sshConnectProvider.connectAndSelect(...targets);
      }

      if (!connections.length) {
        execution.appendOutput([
          new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('No script target selected in SSH Connect Hosts view, connect to a host or click on the row of one that is already connected.')])
        ]);
        execution.end(false, Date.now());
        throw new Error('No script target');
      }

      const errors: { [key: string]: Error } = {};
      const nameById: { [key: string]: string } = connections.reduce((acc, connection) => ({ ...acc, [connection.node.id]: connection.node.name }), {});

      const renewOutputs = async () => {
        const trimmedOutputs : { [key: string]: string } = {};
        for (const [id, text] of Object.entries(outputs)) {
          trimmedOutputs[id] = text.trimEnd();
        }

        await execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.stdout(`Running on ${connections.map(c => `"${c.node.name}"`).join(', ')}...`),
            vscode.NotebookCellOutputItem.json(trimmedOutputs)
          ]),
          ...(cell.metadata.echo !== 'off' ? Object.entries(nameById).filter(([id]) => !!outputs[id]).map(([id, name]) => this.cssTerminal(name, outputs[id], errors[id])) : [])
        ]);
      };
      const print = (id: string, text: string) => {
          outputs[id] = outputs[id] ? outputs[id] + text : text;
          renewOutputs();
      };

      const streams = new Set<ClientChannel>();
      let canceled = false;

      if (rawscript) {
        const promises = connections.map((connection, i) => {
          let command: string;
          if (interpreter) {
            command = `${interpreter} "${rawscript.replace('{{output}}', outputs[connection.node.id] || '').replace(/(["$`\\])/g,'\\$1')}"`;
          }
          else {
            command = rawscript.replace('{{output}}', outputs[connection.node.id] || '').replace(/\r\n/g, '\n');
          }

          outputs[connection.node.id] = '';

          return new Promise<string>((resolve, reject) => {
            connection.client!.exec(command, { pty: { cols: 200 } }, (err, stream) => {
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
        await renewOutputs();
        const failed = resolvedPromises.find(({ status }) => status === 'rejected');
        if (failed) {
          execution.end(false, Date.now());
          throw (failed as PromiseRejectedResult).reason;
        }
        
        if (targets) {
          await this.sshConnectProvider.selectNode();
        }

        execution.end(true, Date.now());
        return undefined;
      }

      throw new Error('Empty script');
    }
    catch (error) {
      execution.appendOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(`Error parsing output for cell at index ${cell.index-1}: ${error.message}`)])
      ]);
      execution.end(false, Date.now());
      return;
    }
  }

  private async _doLocalExecution(cell: vscode.NotebookCell, connections: Connection[]): Promise<Connection[] | undefined> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this._executionOrder;
    execution.start(Date.now()); // Keep track of elapsed time to execute cell.
    execution.clearOutput();

    let outputs: { [key: string]: string } = {};
    try {
      if (cell.index > 0) {
        const aboveCell = cell.notebook.cellAt(cell.index-1);
        if (aboveCell && aboveCell.outputs.length > 0) {
          // is it a local javascript cell?
          if (aboveCell.outputs[aboveCell.outputs.length-1].items.length === 1 && aboveCell.outputs[aboveCell.outputs.length-1].items[0].mime === 'text/x-json') {
            outputs = <{ [key: string]: string }>JSON.parse(aboveCell.outputs[aboveCell.outputs.length-1].items[0].data.toString());
          }
          else if (aboveCell.outputs[0].items[1]?.mime === 'text/x-json') {
            outputs = <{ [key: string]: string }>JSON.parse(aboveCell.outputs[0].items[1].data.toString());
          }
        }
      }
    }
    catch (e) {
      execution.appendOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(`Error parsing output for cell at index ${cell.index-1}: ${e.message}`)])
      ]);
      execution.end(false, Date.now());
      return;
    }

    let newHosts: (string | RegExp)[] = [];
    let textOutput = '';
    const print = (...args: any[]) => {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg === 'object') {
          textOutput += (i > 0 && (typeof args[i-1] === 'object' || !args[i-1].startsWith('\u001b')) ? ' ' : '') + JSON.stringify(arg);
        } else {
          textOutput += (i > 0 && (typeof args[i-1] === 'object' || !args[i-1].startsWith('\u001b')) ? ' ' : '') + arg;
        }
      }
      textOutput += '\n';
      // TODO: figure out why this results in the last replaceOutput removes stdout output completely
      // execution.replaceOutput(new vscode.NotebookCellOutput([
      //   vscode.NotebookCellOutputItem.stdout(textOutput)
      // ]));
    };

    const context = {
      outputs,
      console: {
        ...console,
        log: (...args: any[]) => print(...args),
        error: (...args: any[]) => print("\u001b[31m", ...args, "\u001b[39m")
      },
      sshconnect: (...hostIds: (string | RegExp)[]) => {
        newHosts = hostIds;
      },
      sshdisconnect: (hostId: string) => {
        newHosts = (newHosts.length > 0 ? newHosts : connections.map(c => c.node.id)).filter(id => id !== hostId);
      }
    };

    try {
      const script = new vm.Script(execution.cell.document.getText());
      script.runInNewContext(context, {
        filename: execution.cell.document.uri.toString(),
        breakOnSigint: true,
        timeout: 1000 * 10,
        microtaskMode: 'afterEvaluate',
      });

      const newOutput = [vscode.NotebookCellOutputItem.stdout(textOutput)];
      if (Object.keys(context.outputs).length > 0) {
        newOutput.push(vscode.NotebookCellOutputItem.json(context.outputs));
      }
      await execution.replaceOutput(new vscode.NotebookCellOutput(newOutput));

      const newConnections = newHosts.length > 0 ? await this.sshConnectProvider.connectAndSelect(...newHosts) : undefined;

      execution.end(true, Date.now());
      return newConnections;
    } 
    catch (error) {
      execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(error)]));
      execution.end(false, Date.now());
      throw error;
    }
  }

  private cssTerminal(name: string, text: string | undefined, error: Error | undefined): vscode.NotebookCellOutput {
    const windowColorVar = error ? '#a5060659' : 'var(--vscode-notebook-cellEditorBackground)';
    const headerTextColorVar = 'var(--vscode-editor-foreground)';
    const html = `<div style="background-color: var(--vscode-terminal-background); border-radius: 3px; outline: 1px solid var(--vscode-notebook-inactiveFocusedCellBorder); outline-offset: -1px">
      <div style="padding: 4px 11px; background-color: ${windowColorVar}; color: ${headerTextColorVar}; font-weight: 500">${name}</div>
      ${text ? '<div style="overflow:auto; display:flex; flex-direction:column-reverse;max-height: 500px;"><pre style="padding: 10px 10px 11px 12px; margin: 0; font-size: 11pt; color: var(--vscode-terminal-foreground); '+this.terminalCss+'">'+text+'</pre></div>' : ''}
      ${error ? '<div style="padding: 4px 11px; background-color: '+windowColorVar+'; color: '+headerTextColorVar+'; font-weight: 500">'+error.message+'</div>' : ''}
    </div>`;
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(html, 'text/html')]);
  }
}