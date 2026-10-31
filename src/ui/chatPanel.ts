import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { PROFILES, type ChatEvent } from "../muse/events.ts";
import { validateImages, type ImageInput } from "../muse/images.ts";
import { locateMuse } from "../muse/locate.ts";
import { MuseSession, READ_ONLY } from "../muse/session.ts";
import { chatHtml } from "./chatHtml.ts";
import type { UsageTracker } from "./usageTracker.ts";

type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; images?: ImageInput[] }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setProfile"; profileId: string }
  | { type: "refreshUsage" }
  | { type: "listSessions" }
  | { type: "openSession"; sessionId: string; mode: "resume" | "fork" }
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
  sessionLists: number;
}

const KNOWN_PROFILES = new Set(PROFILES.map((p) => p.id));

/** The Antares chat panel: one webview, one Muse session at a time. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly tracker: UsageTracker;
  private session?: MuseSession;
  private profile: string;
  private currentSessionId?: string;
  /** The user's last model/effort choice (undefined = the host's defaults). Remembered across chats. */
  private modelId?: string;
  private effort?: string;
  readonly testState: TestState = { ready: 0, events: [], sessionLists: 0 };

  static get(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  static show(context: vscode.ExtensionContext, tracker: UsageTracker): ChatPanel {
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
    ChatPanel.current = new ChatPanel(panel, context, tracker);
    return ChatPanel.current;
  }

  static disposeCurrent(): Promise<void> {
    return ChatPanel.current?.dispose() ?? Promise.resolve();
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, tracker: UsageTracker) {
    this.panel = panel;
    this.context = context;
    this.tracker = tracker;
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
    if (process.env.ANTARES_TEST === "1") {
      if ("event" in message) this.testState.events.push((message as { event: ChatEvent }).event);
      if ((message as { type?: string }).type === "sessions") this.testState.sessionLists++;
    }
    void this.panel.webview.postMessage(message);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.post({ type: "event", event: { type: "notice", level, text } satisfies ChatEvent });
  }

  private postConfig(): void {
    this.post({
      type: "config",
      profileId: this.profile,
      profiles: PROFILES,
      modelId: this.modelId,
      effort: this.effort,
      usage: this.tracker.latest(),
      ledger: this.tracker.ledgerSummary(),
      thresholds: this.tracker.thresholds(),
    });
  }

  /** Reads fresh usage and shows it. `quiet` swallows failures (used when the chat opens). */
  private async refreshUsage(quiet: boolean): Promise<void> {
    try {
      const extras = quiet ? await this.tracker.refreshOnOpen() : await this.tracker.refresh();
      const usage = this.tracker.latest();
      if (usage) this.post({ type: "event", event: usage });
      for (const event of extras) this.post({ type: "event", event });
    } catch (error) {
      if (!quiet) this.notice("info", error instanceof Error ? error.message : String(error));
    }
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
        await this.send(message.text, message.images);
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
      case "refreshUsage":
        await this.refreshUsage(false);
        break;
      case "listSessions":
        await this.listSessions();
        break;
      case "openSession":
        if (typeof message.sessionId === "string" && (message.mode === "resume" || message.mode === "fork")) await this.openStored(message.sessionId, message.mode);
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
        void this.refreshUsage(true);
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

  /** Lists this folder's stored sessions (titles come from the user's own history and go only to their panel). */
  private async listSessions(): Promise<void> {
    const session = this.ensureSession(true) ?? this.ensureSession(false);
    if (!session) return;
    try {
      const sessions = await session.listSessions();
      this.post({ type: "sessions", sessions, currentSessionId: this.currentSessionId, canFork: this.profile === READ_ONLY });
    } catch (error) {
      this.post({ type: "sessions", sessions: [], error: error instanceof Error ? error.message : String(error), canFork: this.profile === READ_ONLY });
    }
  }

  /** Continues a stored session, or (read-only chats only) a fork of it. Replaces the current chat. */
  private async openStored(sessionId: string, mode: "resume" | "fork"): Promise<void> {
    if (this.session?.busy) {
      this.notice("warning", "Stop the current turn before opening another session.");
      return;
    }
    if (mode === "fork" && this.profile !== READ_ONLY) {
      this.notice("warning", "A fork cannot be given a permission profile, so forking is only offered in Read-only chats. Switch this chat to Read-only first.");
      return;
    }
    await this.session?.stop();
    this.session = undefined;
    this.currentSessionId = undefined;
    this.post({ type: "reset" });
    this.postConfig();
    const session = this.ensureSession(false, mode === "resume" ? { resumeSessionId: sessionId } : { forkSessionId: sessionId });
    if (!session) return;
    try {
      await session.start();
    } catch (error) {
      this.notice("error", `Could not ${mode === "resume" ? "continue" : "fork"} that session: ${error instanceof Error ? error.message : String(error)}`);
      await session.stop();
      if (this.session === session) this.session = undefined;
    }
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

  private ensureSession(quiet = false, open?: { resumeSessionId?: string; forkSessionId?: string }): MuseSession | undefined {
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
      ...open,
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
      // Usage and token events also feed the shared tracker (status bar, alerts, ledger); the page gets
      // the merged usage, which carries the plan name and the observation time.
      if (event.type === "session") this.currentSessionId = event.sessionId;
      const extras = this.tracker.handle(event);
      this.post({ type: "event", event: event.type === "usage" ? (this.tracker.latest() ?? event) : event });
      for (const extra of extras) this.post({ type: "event", event: extra });
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

  async send(text: string, images?: ImageInput[]): Promise<void> {
    // The webview is untrusted input: check before a host is even started for this message.
    const checked = validateImages(images);
    if (!checked.ok) {
      this.notice("error", checked.error);
      return;
    }
    if (typeof text !== "string" || (text.trim() === "" && checked.images.length === 0)) return;
    const session = this.ensureSession();
    if (!session) return;
    try {
      await session.send(text, checked.images);
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
