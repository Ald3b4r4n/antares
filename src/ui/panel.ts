import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { SelfTestResult } from "../muse/selftest.ts";
import { ANTARES_ASCII, ANTARES_TAGLINE } from "./banner.ts";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Single Antares panel. Phase 0 shows the banner and the offline self-test result only. */
export class AntaresPanel {
  private static current: AntaresPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly onSelfTest: () => void;

  static show(extensionUri: vscode.Uri, onSelfTest: () => void): AntaresPanel {
    if (AntaresPanel.current) {
      AntaresPanel.current.panel.reveal();
      return AntaresPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("antares", "Antares", vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    AntaresPanel.current = new AntaresPanel(panel, extensionUri, onSelfTest);
    return AntaresPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, onSelfTest: () => void) {
    this.panel = panel;
    this.onSelfTest = onSelfTest;
    panel.onDidDispose(() => {
      AntaresPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === "selfTest") this.onSelfTest();
    });
    this.render(extensionUri, undefined, undefined);
  }

  showResult(extensionUri: vscode.Uri, result: SelfTestResult | undefined, note?: string): void {
    this.render(extensionUri, result, note);
  }

  private render(extensionUri: vscode.Uri, result: SelfTestResult | undefined, note: string | undefined): void {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("hex");
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "antares.svg"));
    const rows = result
      ? result.steps
          .map((s) => `<li class="${s.ok ? "ok" : "bad"}">${s.ok ? "✔" : "✘"} ${escapeHtml(s.name)}${s.detail ? ` — ${escapeHtml(s.detail)}` : ""}</li>`)
          .join("")
      : "";
    const facts = result
      ? [
          ["Muse", result.serverVersion],
          ["Schema", result.schemaFingerprint ? `${result.schemaFingerprint.slice(0, 23)}… ${result.fingerprintKnown ? "(known)" : "(UNKNOWN — contract changed)"}` : undefined],
          ["Sandbox", result.sandboxAvailability],
          ["Durability", result.sessionDurability],
        ]
          .filter((r): r is [string, string] => r[1] !== undefined)
          .map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`)
          .join("")
      : "";
    webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; }
  .hero { display: flex; align-items: center; gap: 20px; }
  .hero img { width: 72px; height: 72px; }
  pre.logo { font-family: var(--vscode-editor-font-family, monospace); color: #ff5a3c; margin: 0; line-height: 1.1; }
  .tag { opacity: .7; margin: 4px 0 0; }
  button { margin-top: 20px; padding: 6px 14px; }
  ul { list-style: none; padding: 0; } li.ok { color: var(--vscode-testing-iconPassed, #3fb950); } li.bad { color: var(--vscode-errorForeground); }
  th { text-align: left; padding-right: 16px; opacity: .7; font-weight: normal; }
  .note { margin-top: 16px; opacity: .8; }
</style></head><body>
<div class="hero"><img src="${logo}" alt="">
<div><pre class="logo">${escapeHtml(ANTARES_ASCII)}</pre><p class="tag">${escapeHtml(ANTARES_TAGLINE)}</p></div></div>
<p class="note">${note ? escapeHtml(note) : "Phase 0: this build only verifies the connection to your local Muse install, offline (echo provider, no login, no model call)."}</p>
<button id="run">Run offline self-test</button>
${result ? `<ul>${rows}</ul><table>${facts}</table>` : ""}
<script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.getElementById("run").addEventListener("click", () => vscode.postMessage({ type: "selfTest" }));</script>
</body></html>`;
  }
}
