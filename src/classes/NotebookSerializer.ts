import * as vscode from 'vscode';
const stringify = require('json-stringify-safe');

interface RawNotebookCell {
  language: string;
  value: string;
  kind: vscode.NotebookCellKind;
  editable?: boolean;
  outputs: RawCellOutput[];
  metadata: { [key: string]: any; } | undefined;
}

interface RawCellOutput {
  mime: string;
  value: any;
}

export class NotebookSerializer implements vscode.NotebookSerializer {
  
  async deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): Promise<vscode.NotebookData> {
    var contents = new TextDecoder().decode(content);    // convert to String to make JSON object

    // Read file contents
    let raw: RawNotebookCell[];
    try {
      raw = <RawNotebookCell[]>JSON.parse(contents);
    } catch {
      raw = [];
    }
    
    // Create array of Notebook cells for the VS Code API from file contents
    const cells = raw.map(item => {
      const cell = new vscode.NotebookCellData(
        item.kind,
        item.value,
        item.language
      );
      cell.metadata = item.metadata;
      return cell;
    });

    // Pass read and formatted Notebook Data to VS Code to display Notebook with saved cells
    return new vscode.NotebookData(cells);
  }
      
  async serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Promise<Uint8Array> {
    let contents: RawNotebookCell[] = [];
    
    for (const cell of data.cells) {
      contents.push({
        kind: cell.kind,
        language: cell.languageId,
        value: cell.value,
        metadata: cell.metadata,
        outputs: []
      });
    }
    
    // Give a string of all the data to save and VS Code will handle the rest 
    return new TextEncoder().encode(stringify(contents));
  }    
}


// NEEDED Declaration to silence errors
declare class TextDecoder {
  decode(data: Uint8Array): string;
}

declare class TextEncoder {
  encode(data: string): Uint8Array;
}