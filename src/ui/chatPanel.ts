import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { PROFILES, type ChatEvent } from "../muse/events.ts";
import { locateMuse } from "../muse/locate.ts";
import { MuseSession, READ_ONLY } from "../muse/session.ts";
import { chatHtml } from "./chatHtml.ts";

type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setProfile"; profileId: string }
  | { type: "setModel"; modelId: string }
  | { type: "setEffort"; effort?: string }
  | { type: "decide"; approvalId: string; choiceId: string; requirementId: unknown; feedback?: string }
  | { type: "copy"; text: string }
  | { type: "rendered"; messages: number; userMessages: number; codeBlocks: number; copyButtons: number };

/** Recorded only when ANTARES_TEST=1, so integration tests can observe the real webview. */
export interface TestState {
  ready: number;
  events: ChatEvent[];
  rendered?: { messages: number; userMessages: number; codeBlocks: number; copyButtons: number };
}

const KNOWN_PROFILES = new Set(PROFILES.map((p) => p.id));

/** The Antares chat panel: one webview, one Muse session at a time. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private session?: MuseSession;
  private profile: string;
  /** The user's last model/effort choice (undefined = the host's defaults). Remembered across chats. */
  private modelId?: string;
  private effort?: string;
  readonly testState: TestState = { ready: 0, events: [] };

  static get(): ChatPanel | undefined {
    return ChatPanel.current;
  }

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
    const configured = vscode.workspace.getConfiguration("antares").get<string>("initialProfile", READ_ONLY);
    this.profile = KNOWN_PROFILES.has(configured) ? configured : READ_ONLY;
    this.modelId = context.globalState.get<string>("antares.modelId") || undefined;
    this.effort = context.globalState.get<string>("antares.effort") || undefined;
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
    if (process.env.ANTARES_TEST === "1" && "event" in message) this.testState.events.push((message as { event: ChatEvent }).event);
    void this.panel.webview.postMessage(message);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.post({ type: "event", event: { type: "notice", level, text } satisfies ChatEvent });
  }

  private postConfig(): void {
    this.post({ type: "config", profileId: this.profile, profiles: PROFILES, modelId: this.modelId, effort: this.effort });
  }

  private remember(): void {
    void this.context.globalState.update("antares.modelId", this.modelId);
    void this.context.globalState.update("antares.effort", this.effort);
  }

  private async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    this.effort = undefined; // tiers differ per model; go back to the new model's default
    this.remember();
    this.session?.setEffort(undefined);
    try {
      await this.session?.setModel(modelId);
    } catch (error) {
      this.notice("error", `The host did not accept the model change: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.postConfig();
  }

  private setEffort(effort: string | undefined): void {
    this.effort = effort || undefined;
    this.remember();
    this.session?.setEffort(this.effort);
    this.postConfig();
  }

  /** Public for tests and for the webview bridge. */
  async onMessage(message: FromWebview): Promise<void> {
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
        await this.restart(this.profile);
        break;
      case "setProfile":
        await this.setProfile(message.profileId);
        break;
      case "setModel":
        await this.setModel(message.modelId);
        break;
      case "setEffort":
        this.setEffort(message.effort);
        break;
      case "decide":
        await this.decide(message);
        break;
      case "ready":
        this.testState.ready++;
        this.postConfig();
        void this.warm();
        break;
      case "rendered":
        this.testState.rendered = { messages: message.messages, userMessages: message.userMessages, codeBlocks: message.codeBlocks, copyButtons: message.copyButtons };
        break;
    }
  }

  private async restart(profile: string): Promise<void> {
    await this.session?.stop();
    this.session = undefined;
    this.profile = profile;
    this.post({ type: "reset" });
    this.postConfig();
    void this.warm();
  }

  /** Starts the host quietly so the model picker has a catalog before the first message. No model call. */
  private async warm(): Promise<void> {
    const session = this.ensureSession(true);
    if (!session) return;
    try {
      await session.warm();
    } catch {
      /* the first message reports any real problem */
    }
  }

  private async setProfile(profileId: string): Promise<void> {
    if (!KNOWN_PROFILES.has(profileId) || profileId === this.profile) {
      this.postConfig();
      return;
    }
    if (profileId !== READ_ONLY) {
      const strong = profileId === ":unrestricted";
      const detail = strong
        ? "Per the Muse contract this profile starts without sandbox or approval prompts. The agent can then act with your user's permissions."
        : "The agent may use shell and file-write tools. Read what the profile note says about what it does and does not ask for.";
      const choice = await vscode.window.showWarningMessage(
        `Start a new chat with the ${profileId} profile?`,
        { modal: true, detail: `${detail}\n\nSwitching profile ends the current chat.` },
        "Start new chat",
      );
      if (choice !== "Start new chat") {
        this.postConfig();
        return;
      }
    }
    await this.restart(profileId);
  }

  private async decide(message: Extract<FromWebview, { type: "decide" }>): Promise<void> {
    if (!this.session) {
      this.notice("error", "There is no active session to receive that decision.");
      return;
    }
    try {
      await this.session.decide(message.approvalId, message.choiceId, message.requirementId, message.feedback);
    } catch (error) {
      this.notice("error", `The host did not accept the decision: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private ensureSession(quiet = false): MuseSession | undefined {
    if (this.session) return this.session;
    const config = vscode.workspace.getConfiguration("antares");
    const binary = locateMuse(config.get<string>("musePath"));
    if (!binary) {
      if (!quiet) this.notice("error", "Muse executable not found. Install Muse Code or set antares.musePath in Settings.");
      return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      if (!quiet) this.notice("error", "Open a folder first: Muse works inside a workspace.");
      return undefined;
    }
    const version = (this.context.extension.packageJSON as { version?: string }).version;
    const session = new MuseSession({
      binary,
      workspaceRoot: folder.uri.fsPath,
      profile: this.profile,
      modelId: this.modelId,
      effort: this.effort,
      provider: config.get<string>("dev.provider") || undefined,
      clientVersion: version,
    });
    session.on("event", (event: ChatEvent) => {
      if (event.type === "models" && this.modelId && event.models.length > 0 && !event.models.some((m) => m.modelId === this.modelId)) {
        // The remembered model is gone from the catalog: forget it rather than show a stale choice.
        this.modelId = undefined;
        this.effort = undefined;
        this.remember();
        this.postConfig();
      }
      if (event.type === "modelChanged" && event.modelId !== this.modelId) {
        this.modelId = event.modelId;
        this.remember();
        this.postConfig();
      }
      this.post({ type: "event", event });
    });
    session.on("exit", (code: number | null) => {
      if (this.session === session) {
        this.session = undefined;
        this.notice("warning", `The Muse host stopped (exit code ${code}). It will restart on your next message.`);
      }
    });
    this.session = session;
    return session;
  }

  async send(text: string): Promise<void> {
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
    return chatHtml({ cspSource: webview.cspSource, nonce: randomBytes(16).toString("hex"), mediaUri: media });
  }
}
