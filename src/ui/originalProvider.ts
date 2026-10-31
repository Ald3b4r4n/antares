import * as vscode from "vscode";

export const ORIGINAL_SCHEME = "antares-original";
const KEEP = 60;

/**
 * Serves the "before" side of a file edit to VS Code's diff editor. The text is rebuilt from the host's own patch
 * (see patches.ts) and held in memory only; nothing is written to disk.
 */
export class OriginalProvider implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.path) ?? "";
  }

  /** Remembers `text` and returns the URI that serves it; the file name is kept so the editor picks the language. */
  add(fileName: string, text: string): vscode.Uri {
    const key = `/${++this.counter}/${fileName}`;
    this.texts.set(key, text);
    for (const old of [...this.texts.keys()].slice(0, Math.max(0, this.texts.size - KEEP))) this.texts.delete(old);
    return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: key });
  }
}
