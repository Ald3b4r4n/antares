import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { locateMuse } from "./muse/locate.ts";
import { runSelfTest } from "./muse/selftest.ts";
import { ChatPanel } from "./ui/chatPanel.ts";
import { ORIGINAL_SCHEME, OriginalProvider } from "./ui/originalProvider.ts";
import { UsageTracker } from "./ui/usageTracker.ts";
import { setupVoice } from "./ui/voiceBridge.ts";

export interface AntaresApi {
  chat(): ChatPanel | undefined;
  usage(): UsageTracker;
}

export function activate(context: vscode.ExtensionContext): AntaresApi {
  const output = vscode.window.createOutputChannel("Antares");
  const tracker = new UsageTracker(context);

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

  const originals = new OriginalProvider();
  ChatPanel.originals = originals;
  context.subscriptions.push(
    output,
    tracker,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originals),
    vscode.commands.registerCommand("antares.open", () => ChatPanel.show(context, tracker)),
    vscode.commands.registerCommand("antares.refreshUsage", async () => {
      try {
        await tracker.refresh();
        void vscode.window.showInformationMessage(`Antares usage
${tracker.summary()}`);
      } catch (error) {
        void vscode.window.showInformationMessage(`Antares: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("antares.showUsage", async () => {
      const choice = await vscode.window.showInformationMessage(`Antares usage
${tracker.summary()}`, "Refresh usage", "Open Antares");
      if (choice === "Refresh usage") await vscode.commands.executeCommand("antares.refreshUsage");
      if (choice === "Open Antares") await vscode.commands.executeCommand("antares.open");
    }),
    vscode.commands.registerCommand("antares.selfTest", selfTest),
    vscode.commands.registerCommand("antares.setupVoice", () => setupVoice(context)),
  );
  return { chat: () => ChatPanel.get(), usage: () => tracker };
}

export async function deactivate(): Promise<void> {
  await ChatPanel.disposeCurrent();
}
