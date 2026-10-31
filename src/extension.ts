import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { locateMuse } from "./muse/locate.ts";
import { runSelfTest } from "./muse/selftest.ts";
import { ChatPanel } from "./ui/chatPanel.ts";

export interface AntaresApi {
  chat(): ChatPanel | undefined;
}

export function activate(context: vscode.ExtensionContext): AntaresApi {
  const output = vscode.window.createOutputChannel("Antares");

  const selfTest = async (): Promise<void> => {
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    if (!binary) {
      void vscode.window.showErrorMessage("Antares: Muse executable not found. Set antares.musePath in Settings.");
      return;
    }
    const workDir = mkdtempSync(join(tmpdir(), "antares-selftest-"));
    try {
      const version = (context.extension.packageJSON as { version?: string }).version;
      const result = await runSelfTest(binary, workDir, version);
      output.appendLine(JSON.stringify(result, null, 2));
      output.show(true);
      const message = result.ok
        ? `Antares self-test passed (Muse ${result.serverVersion}${result.fingerprintKnown ? "" : ", UNKNOWN schema fingerprint"}).`
        : "Antares self-test failed. See the Antares output channel.";
      void (result.ok ? vscode.window.showInformationMessage(message) : vscode.window.showErrorMessage(message));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("antares.open", () => ChatPanel.show(context)),
    vscode.commands.registerCommand("antares.selfTest", selfTest),
  );
  return { chat: () => ChatPanel.get() };
}

export async function deactivate(): Promise<void> {
  await ChatPanel.disposeCurrent();
}
