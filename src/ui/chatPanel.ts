import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { PROFILES, type ChatEvent } from "../muse/events.ts";
import { cycleMode, DEFAULT_MODE, modeById, modeOfProfile, modeRows } from "../muse/modes.ts";
import { canonicalPath, imageTypeFor, mentionFor, rootsFor } from "../muse/composer.ts";
import { countChanges, normalizeHostPath, readPatch, relativeToRoots, reversePatch, type PatchFile } from "../muse/patches.ts";
import type { OriginalProvider } from "./originalProvider.ts";
import { MAX_IMAGE_BYTES, validateImages, type ImageInput } from "../muse/images.ts";
import { listMcpServers } from "../muse/mcp.ts";
import { locateMuse } from "../muse/locate.ts";
import { MuseSession, READ_ONLY } from "../muse/session.ts";
import { chatHtml } from "./chatHtml.ts";
import type { UsageTracker } from "./usageTracker.ts";
import { VoiceBridge } from "./voiceBridge.ts";

type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; images?: ImageInput[]; mode?: "steer" | "queue" }
  | { type: "pickFiles" }
  | { type: "addFolder" }
  | { type: "removeFolder"; path: string }
  | { type: "listSkills" }
  | { type: "listConnectors" }
  | { type: "listPlugins" }
  | { type: "unqueue"; turnId: string }
  | { type: "openFile"; itemId: string; path: string }
  | { type: "openDiff"; itemId: string; path: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setMode"; modeId: string }
  | { type: "cycleMode" }
  | { type: "refreshUsage" }
  | { type: "voice"; action: "toggle" | "cancel" | "setup" }
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
  voice: { type: string; [k: string]: unknown }[];
}

const KNOWN_PROFILES = new Set(PROFILES.map((p) => p.id));

/** The Antares chat panel: one webview, one Muse session at a time. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  /** Serves the "before" side of a diff; set when the extension activates. */
  static originals: OriginalProvider | undefined;
  /** The host's patch for each file tool call shown in this chat, by item id (read by this class, never by the page). */
  private readonly patches = new Map<string, PatchFile[]>();
  /** Whether this chat has any conversation yet (a turn ran here, or a stored session was replayed). */
  private hasConversation = false;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly tracker: UsageTracker;
  private readonly voice: VoiceBridge;
  private session?: MuseSession;
  private profile: string;
  private currentSessionId?: string;
  /** The user's last model/effort choice (undefined = the host's defaults). Remembered across chats. */
  private modelId?: string;
  private effort?: string;
  /** Folders the user added to this chat besides the workspace; they end with the chat. */
  private extraRoots: string[] = [];
  readonly testState: TestState = { ready: 0, events: [], sessionLists: 0, voice: [] };

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
    this.voice = new VoiceBridge(context, (m) => this.post(m));
    const configured = vscode.workspace.getConfiguration("antares").get<string>("initialProfile", READ_ONLY);
    this.profile = KNOWN_PROFILES.has(configured) ? configured : READ_ONLY;
    this.modelId = context.globalState.get<string>("antares.modelId") || undefined;
    this.effort = context.globalState.get<string>("antares.effort") || undefined;
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(message));
    panel.onDidDispose(() => {
      ChatPanel.current = undefined;
      this.voice.dispose();
      void this.session?.stop();
    });
  }

  private async dispose(): Promise<void> {
    this.voice.dispose();
    await this.session?.stop();
    this.session = undefined;
  }

  private post(message: object): void {
    if (process.env.ANTARES_TEST === "1") {
      if ("event" in message) this.testState.events.push((message as { event: ChatEvent }).event);
      if ((message as { type?: string }).type === "sessions") this.testState.sessionLists++;
      if (/^voice/.test((message as { type?: string }).type ?? "")) this.testState.voice.push(message as { type: string });
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
      modeId: modeOfProfile(this.profile)?.id,
      modes: modeRows(),
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
        await this.send(message.text, message.images, message.mode === "steer" || message.mode === "queue" ? message.mode : undefined);
        break;
      case "pickFiles":
        await this.pickFiles();
        break;
      case "addFolder":
        await this.addFolder();
        break;
      case "removeFolder":
        this.removeFolder(message.path);
        break;
      case "listSkills":
        await this.listSkills();
        break;
      case "listConnectors":
        await this.listConnectors();
        break;
      case "listPlugins":
        await this.listPlugins();
        break;
      case "unqueue":
        await this.unqueue(message.turnId);
        break;
      case "openFile":
        await this.openPatchedFile(message.itemId, message.path, false);
        break;
      case "openDiff":
        await this.openPatchedFile(message.itemId, message.path, true);
        break;
      case "stop":
        await this.session?.interrupt();
        break;
      case "newChat":
        await this.restart(this.profile);
        break;
      case "setMode":
        await this.setMode(message.modeId);
        break;
      case "cycleMode":
        await this.setMode(cycleMode(modeOfProfile(this.profile)?.id ?? DEFAULT_MODE));
        break;
      case "voice":
        await this.voice.handle(message.action);
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
        this.devToolDemo();
        break;
      case "rendered":
        this.testState.rendered = { messages: message.messages, userMessages: message.userMessages, codeBlocks: message.codeBlocks, copyButtons: message.copyButtons };
        break;
    }
  }

  private async restart(profile: string, keepFolders = false): Promise<void> {
    await this.session?.stop();
    this.session = undefined;
    this.profile = profile;
    this.patches.clear();
    this.hasConversation = false;
    if (!keepFolders) this.extraRoots = []; // folders added to a chat end with it
    this.post({ type: "reset" });
    this.postFolders();
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

  /**
   * Continues a stored session, or (read-only chats only) a fork of it. Replaces the current chat. Returns
   * whether the session is open. `keepFolders` is for a mode switch, which continues the same conversation.
   */
  private async openStored(sessionId: string, mode: "resume" | "fork", keepFolders = false): Promise<boolean> {
    if (this.session?.busy) {
      this.notice("warning", "Stop the current turn before opening another session.");
      return false;
    }
    if (mode === "fork" && this.profile !== READ_ONLY) {
      this.notice("warning", "A fork cannot be given a permission profile, so forking is only offered in Read-only chats. Switch this chat to Read-only first.");
      return false;
    }
    await this.session?.stop();
    this.session = undefined;
    this.currentSessionId = undefined;
    this.patches.clear();
    this.hasConversation = false;
    if (!keepFolders) this.extraRoots = [];
    this.post({ type: "reset" });
    this.postFolders();
    this.postConfig();
    const session = this.ensureSession(false, mode === "resume" ? { resumeSessionId: sessionId } : { forkSessionId: sessionId });
    if (!session) return false;
    try {
      await session.start();
      return true;
    } catch (error) {
      this.notice("error", `Could not ${mode === "resume" ? "continue" : "fork"} that session: ${error instanceof Error ? error.message : String(error)}`);
      await session.stop();
      if (this.session === session) this.session = undefined;
      return false;
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

  /**
   * Switches the permission mode. A chat that has a stored session is continued under the new profile: the
   * host is stopped and the same session resumed (verified: resume accepts the profile and the host reports
   * it back), so the conversation is kept and the host-level tool limits follow the new mode. A live
   * `session/setPermissionProfile` is not used because it is experimental and cannot lift the shell and
   * write limits a read-only host was started with. With no stored session (nothing said yet, or the
   * offline test provider) the chat simply restarts. Never while a turn runs.
   */
  private async setMode(modeId: string): Promise<void> {
    const mode = modeById(modeId);
    if (!mode) {
      this.postConfig();
      return;
    }
    if (!mode.profileId || mode.unavailable) {
      this.notice("info", `${mode.label} mode is not available. ${mode.unavailable ?? ""}`.trim());
      this.postConfig();
      return;
    }
    if (mode.profileId === this.profile) {
      this.postConfig();
      return;
    }
    if (this.session?.busy) {
      this.notice("warning", "Stop the current turn before switching the permission mode.");
      this.postConfig();
      return;
    }
    const resumable = this.currentSessionId !== undefined && !vscode.workspace.getConfiguration("antares").get<string>("dev.provider");
    if (mode.confirm) {
      const action = resumable ? "Switch mode" : "Start new chat";
      const choice = await vscode.window.showWarningMessage(
        `Switch to ${mode.label} (${mode.profileId})?`,
        { modal: true, detail: `${mode.note}

${resumable ? "Muse is restarted and this conversation continues under the new mode." : "Switching mode ends the current chat."}` },
        action,
      );
      if (choice !== action) {
        this.postConfig();
        return;
      }
    }
    if (!resumable) {
      await this.restart(mode.profileId, true);
      return;
    }
    const before = this.profile;
    const sessionId = this.currentSessionId!;
    const hadConversation = this.hasConversation;
    this.profile = mode.profileId;
    if (await this.openStored(sessionId, "resume", true)) {
      this.notice("info", `Switched to ${mode.label} (${mode.profileId}). The conversation continued from Muse's stored history.`);
    } else if (!hadConversation) {
      // Nothing was said yet, and the host may not have written an empty session before it stopped (seen: "session not
      // found" on resume about one run in five). There is nothing to continue, so start fresh in the new mode.
      await this.restart(mode.profileId, true);
      this.notice("info", `Switched to ${mode.label} (${mode.profileId}). This chat had no messages yet, so it started fresh.`);
    } else {
      // The conversation matters: put it back under the mode it had, instead of leaving an empty chat.
      this.profile = before;
      if (await this.openStored(sessionId, "resume", true)) this.notice("warning", `Could not switch to ${mode.label}. The conversation is back under ${modeOfProfile(before)?.label ?? before}.`);
      else this.notice("error", `Could not switch to ${mode.label}, and the conversation could not be reopened. It is in History.`);
    }
    this.postConfig();
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
      if (event.type === "turnStarted" || (event.type === "history" && event.events.length > 0)) this.hasConversation = true;
      const extras = this.tracker.handle(event);
      this.post({ type: "event", event: event.type === "usage" ? (this.tracker.latest() ?? event) : event });
      for (const extra of extras) this.post({ type: "event", event: extra });
      this.afterEvent(event);
    });
    session.on("exit", (code: number | null) => {
      if (this.session === session) {
        this.session = undefined;
        this.notice("warning", `The Muse host stopped (exit code ${code}). It will restart on your next message.`);
      }
    });
    if (this.extraRoots.length > 0) session.setExtraRoots(this.extraRoots);
    this.session = session;
    return session;
  }

  async send(text: string, images?: ImageInput[], mode?: "steer" | "queue"): Promise<void> {
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
      await session.send(text, checked.images, mode ? { ifBusy: mode } : {});
    } catch (error) {
      this.notice("error", `Could not send the message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- file edits: the host's patch, shown as a diff ----

  /** The folders whose files this chat may open from a tool card: the workspace and the folders added to it. */
  private openableRoots(): string[] {
    const root = this.workspaceFolder();
    return root ? rootsFor(root, this.extraRoots).map((r) => normalizeHostPath(canonicalPath(r))) : [];
  }

  /** Reads the patch of a finished file tool call (also those replayed from history) and sends it to the page. */
  private afterEvent(event: ChatEvent): void {
    if (event.type === "toolCall" && event.patchRef && event.status === "completed") void this.showPatch(event.itemId, event.patchRef);
    if (event.type === "history") for (const past of event.events) if (past.type === "toolCall" && past.patchRef && past.status === "completed") void this.showPatch(past.itemId, past.patchRef);
  }

  private async showPatch(itemId: string, ref: { path: string; byteLen?: number }): Promise<void> {
    const files = await readPatch(ref);
    if (files.length === 0) return;
    this.patches.set(itemId, files);
    const roots = this.openableRoots();
    this.post({
      type: "patch",
      itemId,
      files: files.map((f) => {
        const rel = relativeToRoots(normalizeHostPath(canonicalPath(f.path)), roots);
        return { path: f.path, rel, openable: rel !== undefined, hunks: f.hunks, ...countChanges(f) };
      }),
    });
  }

  /**
   * Opens a file a tool call changed, or VS Code's diff of it. Only a file named by the host's patch for that call
   * and inside this chat's folders can be opened. The "before" side is rebuilt from the patch and the file as it
   * is now; if the file changed since, that is not possible and the file is shown instead, with a note.
   */
  private async openPatchedFile(itemId: string, path: string, diff: boolean): Promise<void> {
    const file = this.patches.get(itemId)?.find((f) => f.path === path);
    if (!file) return;
    const disk = normalizeHostPath(canonicalPath(file.path));
    if (relativeToRoots(disk, this.openableRoots()) === undefined) {
      this.notice("warning", "That file is outside this chat's folders, so Antares does not open it from here.");
      return;
    }
    const uri = vscode.Uri.file(disk);
    try {
      if (diff) {
        const current = await readFile(disk, "utf8");
        const before = reversePatch(current, file.hunks);
        const originals = ChatPanel.originals;
        if (before !== undefined && originals) {
          await vscode.commands.executeCommand("vscode.diff", originals.add(basename(disk), before), uri, `${basename(disk)} (before ↔ after this edit)`);
          return;
        }
        this.notice("info", "The file changed after this edit, so its earlier version cannot be rebuilt. Showing the file itself.");
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    } catch (error) {
      this.notice("warning", `Could not open the file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Development only (`antares.dev.patch`): shows a todo list and an edit_file call for a given patch file. */
  private devToolDemo(): void {
    const patch = vscode.workspace.getConfiguration("antares").get<string>("dev.patch", "");
    if (!patch) return;
    const demo: ChatEvent[] = [
      { type: "toolCall", itemId: "demo-todos", tool: "write_todos", summary: "2 tasks, 1 done", status: "completed", held: false, todos: [{ text: "Create plan.txt", status: "completed" }, { text: "Change line 2 to BETA", status: "inProgress" }] },
      { type: "toolCall", itemId: "demo-edit", tool: "edit_file", summary: "plan.txt", status: "completed", held: false, file: { op: "edit", path: "plan.txt", added: 1, removed: 1 }, patchRef: { path: patch } },
    ];
    for (const event of demo) {
      this.post({ type: "event", event });
      this.afterEvent(event);
    }
  }

  // ---- the composer's "+" menu ----

  private workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Test seam: `antares.dev.picks` stands in for the native dialogs so a real-window check can drive them. */
  private devPicks(): string[] {
    return vscode.workspace.getConfiguration("antares").get<string[]>("dev.picks", []).filter((p) => typeof p === "string" && p !== "");
  }

  /**
   * "Add files or photos": images (PNG, JPEG, GIF, WebP within the size limit) become attachments; any other
   * file becomes an `@path` mention in the message, because Muse has no file input part. A file outside the
   * workspace folders cannot be mentioned (the host's file tools refuse it): the user is told to add its folder.
   */
  private async pickFiles(): Promise<void> {
    const root = this.workspaceFolder();
    if (!root) {
      this.notice("error", "Open a folder first: Muse works inside a workspace.");
      return;
    }
    const dev = this.devPicks();
    const uris = dev.length > 0
      ? dev.map((p) => vscode.Uri.file(p))
      : await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, defaultUri: vscode.Uri.file(root), openLabel: "Add", title: "Add files or photos" });
    if (!uris || uris.length === 0) return;
    const roots = rootsFor(root, this.extraRoots);
    const images: { name: string; mediaType: string; base64Data: string }[] = [];
    const mentions: string[] = [];
    const skipped: string[] = [];
    for (const uri of uris) {
      const name = basename(uri.fsPath);
      const imageType = imageTypeFor(name);
      try {
        if (imageType) {
          const size = (await stat(uri.fsPath)).size;
          if (size > MAX_IMAGE_BYTES) {
            skipped.push(`${name} is too large (${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB).`);
            continue;
          }
          images.push({ name, mediaType: imageType, base64Data: (await readFile(uri.fsPath)).toString("base64") });
        } else {
          const mention = mentionFor(uri.fsPath, roots);
          if (mention) mentions.push(mention);
          else skipped.push(`${name} is outside this chat's folders, so Muse's file tools would refuse it. Use "Add folder" for its folder first.`);
        }
      } catch (error) {
        skipped.push(`${name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.post({ type: "picked", images, mentions, skipped });
  }

  /**
   * "Add folder": lets the agent's file tools reach another folder in this chat. That is a grant of access, so
   * it asks first and says what it does. Antares does not grant Project Trust for the folder. The host takes
   * the new set with the next message.
   */
  private async addFolder(): Promise<void> {
    const root = this.workspaceFolder();
    if (!root) {
      this.notice("error", "Open a folder first: Muse works inside a workspace.");
      return;
    }
    const dev = this.devPicks();
    const picked = dev.length > 0 ? vscode.Uri.file(dev[0]!) : (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.Uri.file(root), openLabel: "Add folder", title: "Add a folder to this chat" }))?.[0];
    if (!picked) return;
    const path = picked.fsPath;
    if (rootsFor(root, this.extraRoots).includes(path)) {
      this.notice("info", `${path} is already part of this chat.`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Give Muse access to ${path}?`,
      {
        modal: true,
        detail: `In this chat, the agent's file tools will be able to read this folder${this.profile === READ_ONLY ? "" : " and, depending on the profile, change it"}. Antares does not grant Project Trust for it.\n\nIt takes effect with your next message and ends with this chat.`,
      },
      "Add folder",
    );
    if (choice !== "Add folder") return;
    this.extraRoots = [...this.extraRoots, path];
    this.session?.setExtraRoots(this.extraRoots);
    this.postFolders();
  }

  private removeFolder(path: string): void {
    if (!this.extraRoots.includes(path)) return;
    this.extraRoots = this.extraRoots.filter((p) => p !== path);
    this.session?.setExtraRoots(this.extraRoots);
    this.postFolders();
  }

  private postFolders(): void {
    this.post({ type: "folders", folders: this.extraRoots });
  }

  /** Reads the skills for the slash palette. This starts the session (no model call). */
  private async listSkills(): Promise<void> {
    const session = this.ensureSession(true) ?? this.ensureSession(false);
    if (!session) return;
    try {
      this.post({ type: "skills", skills: await session.listSkills() });
    } catch (error) {
      this.post({ type: "skills", skills: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async listPlugins(): Promise<void> {
    const session = this.ensureSession(true) ?? this.ensureSession(false);
    if (!session) return;
    try {
      this.post({ type: "extras", kind: "plugins", rows: await session.listPlugins() });
    } catch (error) {
      this.post({ type: "extras", kind: "plugins", rows: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async listConnectors(): Promise<void> {
    const config = vscode.workspace.getConfiguration("antares");
    const binary = locateMuse(config.get<string>("musePath"));
    const root = this.workspaceFolder();
    if (!binary || !root) {
      this.post({ type: "extras", kind: "connectors", rows: [], error: !binary ? "Muse executable not found." : "Open a folder first." });
      return;
    }
    try {
      this.post({ type: "extras", kind: "connectors", rows: await listMcpServers({ binary, cwd: root, clientVersion: (this.context.extension.packageJSON as { version?: string }).version }) });
    } catch (error) {
      this.post({ type: "extras", kind: "connectors", rows: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Takes a queued message back. If it already launched, the host refuses and the message stays in the chat. */
  private async unqueue(turnId: string): Promise<void> {
    if (typeof turnId !== "string" || !this.session) return;
    try {
      await this.session.unqueue(turnId);
      this.post({ type: "event", event: { type: "unqueued", turnId } satisfies ChatEvent });
    } catch (error) {
      this.notice("warning", `That message could not be taken back (it may have started already): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();
    return chatHtml({ cspSource: webview.cspSource, nonce: randomBytes(16).toString("hex"), mediaUri: media });
  }
}
