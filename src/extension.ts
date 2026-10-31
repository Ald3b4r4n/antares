import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { locateMuse } from "./muse/locate.ts";
import { runSelfTest } from "./muse/selftest.ts";
import { AntaresPanel } from "./ui/panel.ts";

export function activate(context: vscode.ExtensionContext): void {
  const open = (): AntaresPanel => AntaresPanel.show(context.extensionUri, () => void selfTest());

  const selfTest = async (): Promise<void> => {
    const panel = open();
    const configured = vscode.workspace.getConfiguration("antares").get<string>("musePath");
    const binary = locateMuse(configured);
    if (!binary) {
      panel.showResult(context.extensionUri, undefined, "Muse executable not found. Set antares.musePath in Settings.");
      return;
    }
    panel.showResult(context.extensionUri, undefined, "Running offline self-test…");
    const workDir = mkdtempSync(join(tmpdir(), "antares-selftest-"));
    try {
      const version = (context.extension.packageJSON as { version?: string }).version;
      panel.showResult(context.extensionUri, await runSelfTest(binary, workDir, version));
    } catch (error) {
      panel.showResult(context.extensionUri, undefined, `Self-test failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("antares.open", open),
    vscode.commands.registerCommand("antares.selfTest", selfTest),
  );
}

export function deactivate(): void {}
