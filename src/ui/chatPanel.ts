import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatEvent } from "../muse/events.ts";
import { locateMuse } from "../muse/locate.ts";
import { MuseSession } from "../muse/session.ts";
import { chatHtml } from "./chatHtml.ts";

type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "copy"; text: string };

/** The Antares chat panel: one webview, one Muse session at a time. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private session?: MuseSession;

  static show(context: vscode.ExtensionContext): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("antares.chat", "Antares", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "antares.svg");
    ChatPanel.current = new ChatPanel(panel, context);
    return ChatPanel.current;
  }

  static disposeCurrent(): Promise<void> {
    return ChatPanel.current?.dispose() ?? Promise.resolve();
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(message));
    panel.onDidDispose(() => {
      ChatPanel.current = undefined;
      void this.session?.stop();
    });
  }

  private async dispose(): Promise<void> {
    await this.session?.stop();
    this.session = undefined;
  }

  private post(message: object): void {
    void this.panel.webview.postMessage(message);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.post({ type: "event", event: { type: "notice", level, text } satisfies ChatEvent });
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        this.post({ type: "copied" });
        break;
      case "send":
        await this.send(message.text);
        break;
      case "stop":
        await this.session?.interrupt();
        break;
      case "newChat":
        await this.session?.stop();
        this.session = undefined;
        this.post({ type: "reset" });
        break;
      case "ready":
        break;
    }
  }

  private ensureSession(): MuseSession | undefined {
    if (this.session?.running) return this.session;
    const config = vscode.workspace.getConfiguration("antares");
    const binary = locateMuse(config.get<string>("musePath"));
    if (!binary) {
      this.notice("error", "Muse executable not found. Install Muse Code or set antares.musePath in Settings.");
      return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.notice("error", "Open a folder first: Muse works inside a workspace.");
      return undefined;
    }
    const version = (this.context.extension.packageJSON as { version?: string }).version;
    const session = new MuseSession({
      binary,
      workspaceRoot: folder.uri.fsPath,
      safeMode: config.get<boolean>("safeMode", true),
      clientVersion: version,
    });
    session.on("event", (event: ChatEvent) => this.post({ type: "event", event }));
    session.on("exit", (code: number | null) => {
      if (this.session === session) {
        this.session = undefined;
        this.notice("warning", `The Muse host stopped (exit code ${code}). It will restart on your next message.`);
      }
    });
    this.session = session;
    return session;
  }

  private async send(text: string): Promise<void> {
    const session = this.ensureSession();
    if (!session) return;
    try {
      await session.send(text);
    } catch (error) {
      this.notice("error", `Could not send the message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();
    return chatHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      mediaUri: media,
      safeMode: vscode.workspace.getConfiguration("antares").get<boolean>("safeMode", true),
    });
  }
}
