import { window, Event, EventEmitter, Pseudoterminal, Terminal, TerminalDimensions, TerminalLocation } from 'vscode';
import { Client, ClientChannel } from 'ssh2';
import ConnectionsProvider, { Connection } from './ConnectionsProvider';

export default class SSHTerminal implements Pseudoterminal {

	private _onDidWrite: EventEmitter<string> = new EventEmitter<string>();
  readonly onDidWrite: Event<string> = this._onDidWrite.event;
  private _onDidOverrideDimensions: EventEmitter<TerminalDimensions | undefined> = new EventEmitter<TerminalDimensions | undefined>();
  readonly onDidOverrideDimensions: Event<TerminalDimensions | undefined> = this._onDidOverrideDimensions.event;
  private _onDidClose: EventEmitter<number | void> = new EventEmitter<number | void>();
  readonly onDidClose: Event<number | void> = this._onDidClose.event;

	private stream: ClientChannel | undefined;
	public terminal: Terminal | undefined;

  constructor(private readonly connectionsProvider: ConnectionsProvider, private connection : Connection) {
    this.connect();
	}

  connect() {
    this.connection.client.shell((err, stream) => {
      if (err) {
        this._onDidWrite.fire("Failed to open shell: " + err.message);
      }
      else {
        this.stream = stream;
        stream.on('close', () => {
          this.stream = undefined;
          if (this.connection) {
            this._onDidWrite.fire('\r\n\r\nDisconnected, press R to reconnect or C to close terminal...');
          }
        }).on('data', (data: Buffer) => {
          this._onDidWrite.fire(data.toString());
        }).on('window-change', (data: any) => {
          this._onDidOverrideDimensions.fire({
            columns: data.width,
            rows: data.height
          });
        });

        if(!this.terminal) {
          this.terminal = window.createTerminal({
            name: this.connection.node.name, 
            location: TerminalLocation.Editor,
            pty: this
          });
        }
      }
    });
  }

  async reconnect() {
    try {
      await this.connectionsProvider.connect(this.connection.node);
      this.connect();
      this._onDidWrite.fire(`\r\n\r\n`);
    }
    catch(error) {
      this._onDidWrite.fire(`failed: ${error.message}\r\n\r\n`);
    }
  }

  handleInput(data: string): void {
    if (this.stream) {
      this.stream.write(data);
    }
    else if (data === 'r') {
      this._onDidWrite.fire(`\r\nReconnecting... `);
      if (this.connection.status === 'online') {
        this.connect();
        this._onDidWrite.fire(`\r\n\r\n`);
      }
      else {
        this.reconnect();
      }
    }
    else if (data === 'c') {
      this._onDidClose.fire();
    }
  }

  open(initialDimensions: TerminalDimensions | undefined): void {
    this.stream?.setWindow(initialDimensions?.rows || 24, initialDimensions?.columns || 80, 0, 0);
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
    }
  }

  setDimensions(dimensions: TerminalDimensions): void {
    this.stream?.setWindow(dimensions?.rows || 24, dimensions?.columns || 80, 0, 0);
  }

}