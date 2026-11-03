import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { PROFILES, type ChatEvent } from "../muse/events.ts";
import { cycleMode, DEFAULT_MODE, modeById, modeOfProfile, modeRows } from "../muse/modes.ts";
import { canonicalPath, imageTypeFor, mentionFor, rootsFor } from "../muse/composer.ts";
import { countChanges, createdContent, normalizeHostPath, readPatch, relativeToRoots, reversePatch, reverseSeries, type PatchFile } from "../muse/patches.ts";
import type { OriginalProvider } from "./originalProvider.ts";
import { MAX_IMAGE_BYTES, validateImages, type ImageInput } from "../muse/images.ts";
import { loadWorkspaceImage } from "../muse/localImages.ts";
import { listMcpServers } from "../muse/mcp.ts";
import { testMcpServer } from "../muse/mcpProbe.ts";
import { applyEdit, connectorRows, museConfigPath, parseMcpConfig, rawEntry, saveConfig, splitArgs, validateInput, type McpServerInput } from "../muse/mcpSettings.ts";
import { fetchCollection, pendingSuggestions, scanSkills, SUGGESTED } from "../muse/catalogs.ts";
import { extractLocalUrls, isPreviewableUrl, startPreviewServer, type PreviewServer } from "../muse/preview.ts";
import { describeWeb, readWebSettings, setFetchEnabled, setSearchMode, type SearchMode, type WebSettings } from "../muse/webSettings.ts";
import { PlanWatch, shouldRefreshCatalog } from "../muse/planWatch.ts";
import { addMarketplace as addMarketplaceCli, decideCapability, listManagedPlugins, listMarketplaces, removeMarketplace, removePlugin, setPluginEnabled, updateMarketplace, updatePlugin, type CapabilityKind } from "../muse/pluginsCli.ts";
import { findConflicts, installSkill, listManagedSkills, setSkillActivation, uninstallSkill, validateSkill, type CliOptions } from "../muse/skillsCli.ts";
import { describeContributor, readContributor, switchToContributor, switchToStandard, type ContributorState } from "../muse/contributor.ts";
import { httpsOrigin, oauthSignIn, oauthSignOut } from "../muse/mcpLogin.ts";
import { describeCapabilities, listAvailablePlugins, validatePlugin } from "../muse/pluginCli.ts";
import { locateMuse } from "../muse/locate.ts";
import { MuseSession, READ_ONLY } from "../muse/session.ts";
import { chatHtml } from "./chatHtml.ts";
import type { UsageTracker } from "./usageTracker.ts";
import { VoiceBridge } from "./voiceBridge.ts";

type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; images?: ImageInput[]; mode?: "steer" | "queue" }
  | { type: "pickFiles" }
  | { type: "addCurrentFile" }
  | { type: "addSelection" }
  | { type: "dropUris"; uris: string[] }
  | { type: "addFolder" }
  | { type: "removeFolder"; path: string }
  | { type: "listSkills" }
  | { type: "listConnectors" }
  | { type: "listPlugins" }
  | { type: "importSkills" }
  | { type: "installPlugin"; from: "folder" | "marketplace" }
  | { type: "addMarketplace" }
  | { type: "connectorSignIn"; server: string }
  | { type: "connectorSignOut"; server: string }
  | { type: "connectorCancel" }
  | { type: "unqueue"; turnId: string }
  | { type: "loadImage"; path: string }
  | { type: "openChanged"; path: string; diff: boolean }
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
  | { type: "refreshModels" }
  | { type: "prewarm" }
  | { type: "manageSkills" }
  | { type: "pluginDecide"; pluginId: string; kind: string; capabilityId: string; decision: string }
  | { type: "pluginEnable"; id: string; enabled: boolean }
  | { type: "pluginUpdate"; id: string }
  | { type: "pluginRemove"; id: string }
  | { type: "listMarketplaces" }
  | { type: "addSuggested"; name: string }
  | { type: "browseCollection"; name: string }
  | { type: "marketplaceUpdate"; name: string }
  | { type: "marketplaceRemove"; name: string }
  | { type: "mcpAdd"; kind: string }
  | { type: "mcpEdit"; name: string }
  | { type: "mcpRemove"; name: string }
  | { type: "mcpToggle"; name: string; enabled: boolean }
  | { type: "mcpTest"; name: string }
  | { type: "setSkillActivation"; id: string; scope: string; activation: string }
  | { type: "installSkillFolder" }
  | { type: "uninstallSkill"; id: string }
  | { type: "refreshContributor" }
  | { type: "webMenu" }
  | { type: "previewMenu" }
  | { type: "showPrivacy" }
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

const BLANK_LINE = String.fromCharCode(10, 10);
const KNOWN_PROFILES = new Set(PROFILES.map((p) => p.id));

/** The Antares chat panel: one webview, one Muse session at a time. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  /** Serves the "before" side of a diff; set when the extension activates. */
  static originals: OriginalProvider | undefined;
  /** The host's patch for each file tool call shown in this chat, by item id (read by this class, never by the page). */
  private readonly patches = new Map<string, PatchFile[]>();
  /** The order the edits happened in, by item id: a patch is read asynchronously, so arrival order is not edit order. */
  private readonly patchOrder = new Map<string, number>();
  private patchSeq = 0;
  /** Set while a connector sign-in waits for the browser; aborting it cancels the flow at the host. */
  private loginAbort: AbortController | undefined;
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
    this.lastEditor = vscode.window.activeTextEditor;
    this.editorTracker = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) this.lastEditor = e;
    });
    // Following the subscription: a bigger plan can bring models, and the host only says so when asked. Read the list again when the
    // window comes back to the front after ten minutes or more.
    this.focusWatcher = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      const session = this.session;
      if (session && shouldRefreshCatalog({ lastReadMs: session.lastCatalogReadMs(), nowMs: Date.now(), minAgeMs: 10 * 60_000, turnRunning: session.busy, hostRunning: session.running })) void session.refreshModels();
    });
    panel.onDidDispose(() => {
      this.focusWatcher?.dispose();
      void this.previewServer?.close();
      this.editorTracker?.dispose();
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
      case "prewarm":
        // The first typing of a chat: bring the session up now so the first send skips that wait. No model call.
        void this.ensureSession(true)?.start().catch(() => undefined);
        break;
      case "pickFiles":
        await this.pickFiles();
        break;
      case "addCurrentFile":
        await this.addCurrentFile();
        break;
      case "addSelection":
        await this.addSelection();
        break;
      case "dropUris":
        await this.dropUris(message.uris);
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
      case "importSkills":
        await this.importSkills();
        break;
      case "installPlugin":
        await (message.from === "folder" ? this.installPluginFromFolder() : this.installPluginFromMarketplace());
        break;
      case "addMarketplace":
        await this.addMarketplace();
        break;
      case "connectorSignIn":
        await this.connectorSignIn(message.server);
        break;
      case "connectorSignOut":
        await this.connectorSignOut(message.server);
        break;
      case "connectorCancel":
        this.loginAbort?.abort();
        break;
      case "unqueue":
        await this.unqueue(message.turnId);
        break;
      case "loadImage":
        await this.loadImage(message.path);
        break;
      case "openChanged":
        if (typeof message.path === "string") await this.openChanged(message.path, message.diff === true);
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
      case "refreshModels":
        await this.refreshModels();
        break;
      case "manageSkills":
        await this.manageSkills();
        break;
      case "pluginDecide":
        await this.pluginDecide(message.pluginId, message.kind, message.capabilityId, message.decision);
        break;
      case "pluginEnable":
        await this.pluginEnable(message.id, message.enabled === true);
        break;
      case "pluginUpdate":
        await this.pluginUpdate(message.id);
        break;
      case "pluginRemove":
        await this.pluginRemove(message.id);
        break;
      case "listMarketplaces":
        await this.showMarketplaces();
        break;
      case "addSuggested":
        await this.addSuggested(message.name);
        break;
      case "browseCollection":
        await this.browseCollection(message.name);
        break;
      case "marketplaceUpdate":
        await this.marketplaceUpdate(message.name);
        break;
      case "marketplaceRemove":
        await this.marketplaceRemove(message.name);
        break;
      case "mcpAdd":
        await this.mcpAdd(message.kind === "http" ? "streamable_http" : "stdio");
        break;
      case "mcpEdit":
        await this.mcpEdit(message.name);
        break;
      case "mcpRemove":
        await this.mcpRemove(message.name);
        break;
      case "mcpToggle":
        await this.mcpToggle(message.name, message.enabled === true);
        break;
      case "mcpTest":
        await this.mcpTest(message.name);
        break;
      case "setSkillActivation":
        await this.changeSkillActivation(message.id, message.scope, message.activation);
        break;
      case "installSkillFolder":
        await this.installSkillFolder();
        break;
      case "uninstallSkill":
        await this.removeSkill(message.id);
        break;
      case "refreshContributor":
        await this.refreshContributor();
        break;
      case "webMenu":
        await this.webMenu();
        break;
      case "previewMenu":
        await this.previewMenu();
        break;
      case "showPrivacy":
        await this.showPrivacy();
        break;
      case "decide":
        await this.decide(message);
        break;
      case "ready":
        this.testState.ready++;
        this.postConfig();
        void this.warm();
        void this.refreshContributor();
        void this.refreshWeb();
        void this.offerCatalogs();
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
    this.patchOrder.clear();
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
    this.patchOrder.clear();
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

  /** "↻ Models": asks the host for the catalog again (starting the host if needed). Failures are shown by the page, not thrown. */
  private async refreshModels(): Promise<void> {
    const session = this.ensureSession(true);
    if (!session) return;
    try {
      if (session.running) await session.refreshModels();
      else await session.warm();
    } catch (error) {
      this.notice("warning", `Could not refresh the model list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Where `muse skills ...` runs: the located executable, in the open folder. Undefined (with the reason) when it cannot. */
  private skillsCli(): { options: CliOptions } | { error: string } {
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    const cwd = this.workspaceFolder();
    if (!binary) return { error: "Muse executable not found." };
    if (!cwd) return { error: "Open a folder first." };
    return { options: { binary, cwd } };
  }

  /** The skills manager: every skill Muse knows (scope, origin, activation) read from its own CLI. No model call. */
  private async manageSkills(): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli) {
      this.post({ type: "skillsManage", rows: [], conflicts: [], error: cli.error });
      return;
    }
    try {
      const rows = await listManagedSkills(cli.options);
      this.post({ type: "skillsManage", rows, conflicts: [...findConflicts(rows).keys()] });
    } catch (error) {
      this.post({ type: "skillsManage", rows: [], conflicts: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Turns one skill on, user-invocable-only or off. The result is read back; a skill change reaches new chats (an open one keeps its list). */
  private async changeSkillActivation(id: unknown, scope: unknown, activation: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof id !== "string" || typeof scope !== "string" || (activation !== "on" && activation !== "userInvocableOnly" && activation !== "off")) {
      this.notice("error", "Could not change the skill: " + ("error" in cli ? cli.error : "the request was not valid."));
      return;
    }
    try {
      await setSkillActivation(cli.options, { id, scope, activation });
      this.notice("info", `${id} is now ${activation === "on" ? "on" : activation === "off" ? "off" : "user-invocable only"}. It applies to new chats; one already open keeps the skills it started with.`);
    } catch (error) {
      this.notice("error", `Could not change ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.manageSkills();
  }

  /** Installs a skill folder for the user: Muse checks it first, the user sees what it asks for and confirms. */
  private async installSkillFolder(): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli) {
      this.notice("error", cli.error);
      return;
    }
    const dev = this.devPicks();
    const picked = dev.length > 0 ? dev[0] : (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Check this skill", title: "Pick a skill folder (it holds a SKILL.md)" }))?.[0]?.fsPath;
    if (!picked) return;
    try {
      const preview = await validateSkill(cli.options, picked);
      if (!preview.valid) {
        this.notice("error", `Muse does not accept this folder as a skill: ${preview.diagnostics.join("; ") || "no reason given"}.`);
        return;
      }
      const existing = (await listManagedSkills(cli.options)).some((s) => s.id === preview.id && s.scope === "user");
      const detail = [
        `Muse checked ${basename(picked)}: it is a valid skill${preview.id ? ` (${preview.id})` : ""}.`,
        preview.allowedTools.length ? `It asks to use these tools: ${preview.allowedTools.join(", ")}.` : "",
        preview.diagnostics.length ? `Notes: ${preview.diagnostics.join("; ")}.` : "",
        existing ? "A skill with this name is already installed for you: installing replaces it." : "",
        "A skill is a set of instructions the model follows: read its SKILL.md before you install it. Nothing has been installed yet.",
      ].filter(Boolean).join(BLANK_LINE);
      const go = existing ? "Replace" : "Install";
      if ((await vscode.window.showInformationMessage(`Install the skill ${preview.id ?? basename(picked)}?`, { modal: true, detail }, go)) !== go) return;
      const done = await installSkill(cli.options, picked, { force: existing });
      this.notice("info", `Installed the skill ${done.id}. It appears in new chats.`);
    } catch (error) {
      this.notice("error", `Could not install the skill: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.manageSkills();
  }

  /** Removes a skill that was installed for the user, after a confirmation. */
  private async removeSkill(id: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof id !== "string") return;
    const go = "Remove";
    if ((await vscode.window.showWarningMessage(`Remove the skill ${id}?`, { modal: true, detail: "This deletes the installed copy from Muse's skills folder. The folder you installed it from is not touched." }, go)) !== go) return;
    try {
      await uninstallSkill(cli.options, id);
      this.notice("info", `Removed the skill ${id}.`);
    } catch (error) {
      this.notice("error", `Could not remove ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.manageSkills();
  }

  private web: WebSettings | undefined;

  /** Reads the two web settings (a short-lived host, no model call) and shows them. */
  private async refreshWeb(): Promise<void> {
    const cli = this.skillsCli();
    const read: WebSettings = "error" in cli ? { fetchEnabled: undefined, searchMode: undefined } : await readWebSettings(cli.options).catch(() => ({ fetchEnabled: undefined, searchMode: undefined }));
    this.web = read;
    this.post({ type: "web", ...describeWeb(read) });
  }

  /** Switches the agent's web tools. Each change is confirmed and checked against the host's answer. */
  private async webMenu(): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli) {
      this.notice("error", cli.error);
      return;
    }
    if (!this.web) await this.refreshWeb();
    const w = this.web ?? { fetchEnabled: undefined, searchMode: undefined };
    const d = describeWeb(w);
    type Item = vscode.QuickPickItem & { run: () => Promise<string> };
    const items: Item[] = [
      { label: w.fetchEnabled === false ? "Turn page reading on" : "Turn page reading off", description: "web_fetch: the agent reads a page you or it names", run: async () => { await setFetchEnabled(cli.options, w.fetchEnabled === false); return `Page reading is now ${w.fetchEnabled === false ? "on" : "off"}.`; } },
      ...(["client", "hosted", "off"] as SearchMode[]).filter((m) => m !== w.searchMode).map((m) => ({ label: m === "off" ? "Turn searching off" : `Searching: ${m}`, description: `web_search mode "${m}" (the names are Muse's)`, run: async () => { await setSearchMode(cli.options, m); return `Searching is now "${m}".`; } })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: `${d.label}`, placeHolder: "Pick a change (it applies to new chats; the stricter permission modes still ask before reaching a site)" });
    if (!picked) return;
    const go = "Change";
    if ((await vscode.window.showWarningMessage(`${picked.label}?`, { modal: true, detail: "This changes Muse's own setting, saved on this computer, for every Muse client here. It applies to new chats." }, go)) !== go) return;
    try {
      this.notice("info", await picked.run());
    } catch (error) {
      this.notice("error", `Could not change it: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refreshWeb();
  }

  private contributor: ContributorState | undefined;

  /** Reads the saved Standard/Contributor mode (a short-lived host, no model call, nothing written) and shows it. */
  private async refreshContributor(): Promise<void> {
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    const root = this.workspaceFolder();
    if (!binary || !root) {
      this.contributor = describeContributor({ saved: undefined, error: !binary ? "the Muse executable was not found" : "no folder is open" }, process.env);
    } else {
      const read = await readContributor({ binary, cwd: root, clientVersion: (this.context.extension.packageJSON as { version?: string }).version }).catch((error: unknown) => ({ saved: undefined, error: error instanceof Error ? error.message : String(error) }));
      this.contributor = describeContributor(read, process.env);
    }
    this.post({ type: "contributor", state: this.contributor });
  }

  /** Explains the mode and what it rests on. Read-only: Antares does not change the mode (change it in Muse: /settings, Contributor mode). */
  private async showPrivacy(): Promise<void> {
    if (!this.contributor) await this.refreshContributor();
    const s = this.contributor;
    if (!s) return;
    const lines = [s.account ? `Account: ${s.account}` : "", `${s.label}. ${s.detail}`, s.privacy, "Either switch asks for one more confirmation before anything is saved."].filter(Boolean);
    const toStandard = "Switch to Standard…";
    const toContributor = "Switch to Contributor…";
    const choice = await vscode.window.showInformationMessage(`Muse usage mode: ${s.label}`, { modal: true, detail: lines.join(BLANK_LINE) }, ...(s.mode === "standard" ? [] : [toStandard]), ...(s.mode === "contributor" ? [] : [toContributor]), "Read the terms");
    if (choice === "Read the terms") void vscode.env.openExternal(vscode.Uri.parse("https://dev.meta.ai/docs/muse-code/subscriptions"));
    else if (choice === toStandard) await this.confirmStandard();
    else if (choice === toContributor) await this.confirmContributor();
  }

  /** Turning Contributor on lets Meta train on the user's content, so it asks first and says so plainly. */
  private async confirmContributor(): Promise<void> {
    const confirm = "Switch to Contributor";
    const answer = await vscode.window.showWarningMessage(
      "Switch Muse to Contributor mode?",
      { modal: true, detail: ["Contributor mode lets Meta use your content (prompts, code and files Muse reads) to train future Meta models, in exchange for more usage from your plan.", "This changes the setting saved on this computer in Muse's own settings, so it applies to every Muse client here.", "If Muse has never shown you its data-use disclosure, accept it in Muse itself (/settings, Contributor mode); Antares cannot record that acknowledgement for you."].join(BLANK_LINE) },
      confirm,
    );
    if (answer !== confirm) return;
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    const root = this.workspaceFolder();
    if (!binary || !root) {
      this.notice("error", "Could not switch the mode: " + (!binary ? "the Muse executable was not found." : "open a folder first."));
      return;
    }
    try {
      await switchToContributor({ binary, cwd: root, clientVersion: (this.context.extension.packageJSON as { version?: string }).version });
      this.notice("info", "Muse is now saved as Contributor mode. It applies from your next request.");
    } catch (error) {
      this.notice("error", `Could not switch the mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refreshContributor();
  }

  /** The only switch Antares offers is toward Standard, after an explicit confirmation. Turning Contributor on happens in Muse. */
  private async confirmStandard(): Promise<void> {
    const confirm = "Switch to Standard";
    const answer = await vscode.window.showWarningMessage(
      "Switch Muse to Standard mode?",
      { modal: true, detail: ["This changes the setting saved on this computer in Muse's own settings, so it applies to every Muse client here (the terminal and other editors too).", "Standard mode keeps your content from being used to train Meta models; your plan may give you less usage than Contributor mode does.", "Muse's documentation says the change applies from your next request. Antares has not verified what an already open session does."].join(BLANK_LINE) },
      confirm,
    );
    if (answer !== confirm) return;
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    const root = this.workspaceFolder();
    if (!binary || !root) {
      this.notice("error", "Could not switch the mode: " + (!binary ? "the Muse executable was not found." : "open a folder first."));
      return;
    }
    try {
      await switchToStandard({ binary, cwd: root, clientVersion: (this.context.extension.packageJSON as { version?: string }).version });
      this.notice("info", "Muse is now saved as Standard mode. It applies from your next request.");
    } catch (error) {
      this.notice("error", `Could not switch the mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refreshContributor();
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
      // Only a chat that has said something and cannot be resumed (the offline test provider) really starts over.
      const startsOver = !resumable && this.hasConversation;
      const action = startsOver ? "Start new chat" : "Switch mode";
      const choice = await vscode.window.showWarningMessage(
        `Switch to ${mode.label} (${mode.profileId})?`,
        { modal: true, detail: `${mode.note}

${resumable ? "Muse is restarted and this conversation continues under the new mode." : startsOver ? "Switching mode ends the current chat." : "This chat has no messages yet, so the new mode simply applies."}` },
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
        // The remembered model is gone from the catalog: forget it rather than show a stale choice, and say so.
        this.notice("warning", `The model ${this.modelId} you used before is no longer available to this account; the default model is selected instead.`);
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
      if (event.type === "usage") {
        const seen = this.planWatch.observe(this.tracker.latest()?.plan);
        if (seen.changed) {
          this.notice("info", `Your Muse plan changed (${seen.from} to ${seen.to}). Reading the model list again: models your new plan includes will appear in the picker.`);
          void session.refreshModels();
        }
      }
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
      this.post({ type: "sendFailed" });
      return;
    }
    if (typeof text !== "string" || (text.trim() === "" && checked.images.length === 0)) {
      this.post({ type: "sendFailed" });
      return;
    }
    const session = this.ensureSession();
    if (!session) {
      this.post({ type: "sendFailed" });
      return;
    }
    try {
      await session.send(text, checked.images, mode ? { ifBusy: mode } : {});
    } catch (error) {
      this.post({ type: "sendFailed" });
      const reason = error instanceof Error ? error.message : String(error);
      const tooBig = /exceeds the inbound limit|-32002/.test(reason);
      this.notice("error", tooBig
        ? "Could not send the message: it is bigger than Muse accepts in one request (about 8 MB). Remove some images or send them in separate messages."
        : `Could not send the message: ${reason}`);
    }
  }

  // ---- file edits: the host's patch, shown as a diff ----

  /** The folders whose files this chat may open from a tool card: the workspace and the folders added to it. */
  private openableRoots(): string[] {
    const root = this.workspaceFolder();
    return root ? rootsFor(root, this.extraRoots).map((r) => normalizeHostPath(canonicalPath(r))) : [];
  }

  /** Reads a workspace image the page asked to show, with every check in localImages.ts, and answers with the data or the reason. */
  private async loadImage(path: string): Promise<void> {
    if (typeof path !== "string") return;
    const result = await loadWorkspaceImage(path, this.openableRoots());
    this.post(result.ok ? { type: "image", path, ok: true, dataUrl: result.dataUrl, bytes: result.bytes } : { type: "image", path, ok: false, reason: result.reason });
  }

  /** Reads the patch of a finished file tool call (also those replayed from history) and sends it to the page. */
  /** Local addresses a tool printed (a dev server's banner), newest last, so Preview can offer them. */
  private localUrls: string[] = [];
  private previewServer: PreviewServer | undefined;
  private previewConfirmed = false;

  private noteLocalUrls(output: string | undefined): void {
    if (!output) return;
    const fresh = extractLocalUrls(output).filter((u) => !this.localUrls.includes(u));
    if (fresh.length === 0) return;
    this.localUrls = [...this.localUrls, ...fresh].slice(-5);
    this.post({ type: "previewUrls", urls: this.localUrls });
  }

  /** Opens an address in the editor's built-in browser (Simple Browser); in an editor without it, in the system browser. */
  private async openPreview(url: string): Promise<void> {
    if (!isPreviewableUrl(url)) {
      this.notice("error", "Only http and https addresses can be previewed.");
      return;
    }
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", url);
      this.notice("info", `Opened ${url} in the editor's browser.`);
    } catch {
      this.notice("warning", "This editor has no built-in browser, so the page opens in your system browser.");
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  /** Preview: a dev server address the agent printed, an address you type, or an HTML file of this folder (served read-only on 127.0.0.1). */
  private async previewMenu(): Promise<void> {
    type Item = vscode.QuickPickItem & { act: "url" | "type" | "file"; url?: string };
    const items: Item[] = [
      ...[...this.localUrls].reverse().map((u): Item => ({ label: u, description: "printed by the agent's tools", act: "url", url: u })),
      { label: "Open an address…", description: "any http or https address", act: "type" },
      { label: "Preview an HTML file from this folder…", description: "served read-only on 127.0.0.1 while this chat is open", act: "file" },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: "Preview a page in the editor", placeHolder: "Pick what to open" });
    if (!picked) return;
    if (picked.act === "url" && picked.url) return this.openPreview(picked.url);
    if (picked.act === "type") {
      const url = await vscode.window.showInputBox({ title: "Open an address in the editor", prompt: "http or https", value: this.localUrls.at(-1) ?? "http://localhost:3000/", validateInput: (v) => (isPreviewableUrl(v) ? undefined : "Use an http:// or https:// address.") });
      if (url) await this.openPreview(url);
      return;
    }
    const root = this.workspaceFolder();
    if (!root) {
      this.notice("error", "Open a folder first.");
      return;
    }
    const files = await vscode.workspace.findFiles("**/*.{html,htm}", "**/{node_modules,.git,dist-test}/**", 200);
    if (files.length === 0) {
      this.notice("info", "There is no HTML file in this folder to preview.");
      return;
    }
    const rels = files.map((f) => vscode.workspace.asRelativePath(f, false).replace(/\\/g, "/")).sort();
    const rel = await vscode.window.showQuickPick(rels, { title: "Which page?", placeHolder: "The whole folder is served, so the page's CSS, scripts and images load" });
    if (!rel) return;
    if (!this.previewConfirmed) {
      const go = "Serve and preview";
      if ((await vscode.window.showInformationMessage("Serve this folder for the preview?", { modal: true, detail: `Antares will serve ${root} read-only on 127.0.0.1 (this computer only) while this chat is open, so the page's own files load. Dotfiles such as .env and .git are never served.` }, go)) !== go) return;
      this.previewConfirmed = true;
    }
    try {
      this.previewServer ??= await startPreviewServer(root);
      await this.openPreview(this.previewServer.baseUrl + rel.split("/").map(encodeURIComponent).join("/"));
    } catch (error) {
      this.notice("error", `Could not start the preview: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private afterEvent(event: ChatEvent): void {
    if (event.type === "toolCall" && event.status === "completed") this.noteLocalUrls(event.output);
    if (event.type === "toolCall" && event.patchRef && event.status === "completed") void this.showPatch(event.itemId, event.patchRef);
    if (event.type === "history") for (const past of event.events) if (past.type === "toolCall" && past.patchRef && past.status === "completed") void this.showPatch(past.itemId, past.patchRef);
  }

  /** Every file changed in this chat, once, with the totals of all its edits (and how many edits that was). */
  private changedFiles(): { path: string; rel: string | undefined; openable: boolean; added: number; removed: number; edits: number }[] {
    const roots = this.openableRoots();
    const byPath = new Map<string, { path: string; added: number; removed: number; edits: number }>();
    for (const [itemId, files] of [...this.patches].sort((a, b) => (this.patchOrder.get(a[0]) ?? 0) - (this.patchOrder.get(b[0]) ?? 0))) {
      void itemId;
      for (const f of files) {
        const key = normalizeHostPath(canonicalPath(f.path)).toLowerCase();
        const row = byPath.get(key) ?? { path: f.path, added: 0, removed: 0, edits: 0 };
        const c = countChanges(f);
        byPath.set(key, { path: f.path, added: row.added + c.added, removed: row.removed + c.removed, edits: row.edits + 1 });
      }
    }
    return [...byPath.values()].map((r) => {
      const rel = relativeToRoots(normalizeHostPath(canonicalPath(r.path)), roots);
      return { ...r, rel, openable: rel !== undefined };
    });
  }

  private postChanges(): void {
    this.post({ type: "changes", files: this.changedFiles() });
  }

  /**
   * A message the user will actually see. The chat's own notices sit behind the Changes panel and the diff views, so
   * anything that explains why a button did nothing is also shown by the editor.
   */
  private tell(level: "info" | "warning", text: string): void {
    this.notice(level, text);
    void (level === "info" ? vscode.window.showInformationMessage(`Antares: ${text}`) : vscode.window.showWarningMessage(`Antares: ${text}`));
  }

  /** Opens a changed file, or one diff from before the first edit of this chat to the file as it is now. */
  private async openChanged(path: string, diff: boolean): Promise<void> {
    const key = normalizeHostPath(canonicalPath(path)).toLowerCase();
    const edits: { seq: number; hunks: PatchFile["hunks"] }[] = [];
    for (const [itemId, files] of this.patches) {
      for (const f of files) if (normalizeHostPath(canonicalPath(f.path)).toLowerCase() === key) edits.push({ seq: this.patchOrder.get(itemId) ?? 0, hunks: f.hunks });
    }
    if (edits.length === 0) return;
    edits.sort((a, b) => a.seq - b.seq);
    const disk = normalizeHostPath(canonicalPath(path));
    if (relativeToRoots(disk, this.openableRoots()) === undefined) {
      this.tell("warning", "That file is outside this chat's folders, so Antares does not open it from here.");
      return;
    }
    const uri = vscode.Uri.file(disk);
    // The agent may have deleted the file after writing it (a scratch file, say). Say so, and for a file the chat
    // created, still show what was written.
    const exists = await stat(disk).then(() => true, () => false);
    if (!exists) {
      const written = edits.length === 1 ? createdContent(edits[0]!.hunks) : undefined;
      const originals = ChatPanel.originals;
      if (diff && written !== undefined && originals) {
        await vscode.commands.executeCommand("vscode.diff", originals.add(basename(disk), ""), originals.add(basename(disk), written), `${basename(disk)} (as the agent wrote it; the file no longer exists)`);
        return;
      }
      this.tell("info", `${basename(disk)} no longer exists: it was deleted or moved after the agent changed it.`);
      return;
    }
    try {
      if (diff) {
        const before = reverseSeries(await readFile(disk, "utf8"), edits.map((e) => e.hunks));
        const originals = ChatPanel.originals;
        if (before !== undefined && originals) {
          await vscode.commands.executeCommand("vscode.diff", originals.add(basename(disk), before), uri, `${basename(disk)} (before this chat ↔ now, ${edits.length} edit${edits.length === 1 ? "" : "s"})`);
          return;
        }
        this.tell("info", "The file changed in a way the chat's edits do not explain, so its version before them cannot be rebuilt. Showing the file itself.");
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    } catch (error) {
      this.tell("warning", `Could not open the file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async showPatch(itemId: string, ref: { path: string; byteLen?: number }): Promise<void> {
    const seq = this.patchSeq++; // taken before the read, so the order is the order the calls were announced in
    const files = await readPatch(ref);
    if (files.length === 0) return;
    this.patches.set(itemId, files);
    this.patchOrder.set(itemId, seq);
    this.postChanges();
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
      this.tell("warning", "That file is outside this chat's folders, so Antares does not open it from here.");
      return;
    }
    const uri = vscode.Uri.file(disk);
    // A scratch file the agent wrote and then deleted: say so, and still show what it wrote when this edit created it.
    if (!(await stat(disk).then(() => true, () => false))) {
      const written = createdContent(file.hunks);
      const originals = ChatPanel.originals;
      if (diff && written !== undefined && originals) {
        await vscode.commands.executeCommand("vscode.diff", originals.add(basename(disk), ""), originals.add(basename(disk), written), `${basename(disk)} (as the agent wrote it; the file no longer exists)`);
        return;
      }
      this.tell("info", `${basename(disk)} no longer exists: it was deleted or moved after the agent changed it.`);
      return;
    }
    try {
      if (diff) {
        const current = await readFile(disk, "utf8");
        const before = reversePatch(current, file.hunks);
        const originals = ChatPanel.originals;
        if (before !== undefined && originals) {
          await vscode.commands.executeCommand("vscode.diff", originals.add(basename(disk), before), uri, `${basename(disk)} (before ↔ after this edit)`);
          return;
        }
        this.tell("info", "The file changed after this edit, so its earlier version cannot be rebuilt. Showing the file itself.");
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    } catch (error) {
      this.tell("warning", `Could not open the file: ${error instanceof Error ? error.message : String(error)}`);
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
    const series = vscode.workspace.getConfiguration("antares").get<string[]>("dev.patchSeries", []);
    series.forEach((p, i) => {
      const event: ChatEvent = { type: "toolCall", itemId: `demo-series-${i}`, tool: "edit_file", summary: "series.txt", status: "completed", held: false, file: { op: "edit", path: "series.txt" }, patchRef: { path: p } };
      this.post({ type: "event", event });
      this.afterEvent(event);
    });
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
    await this.addPaths(uris.map((u) => u.fsPath));
  }

  /**
   * Adds files to the message, whatever way they came (the dialog, a drop from the Explorer, the current file): photos
   * become attachments, other files become @mentions when they are inside this chat's folders, the rest is explained.
   */
  private async addPaths(paths: string[]): Promise<void> {
    const root = this.workspaceFolder();
    if (!root) {
      this.notice("error", "Open a folder first: Muse works inside a workspace.");
      return;
    }
    const roots = rootsFor(root, this.extraRoots);
    const images: { name: string; mediaType: string; base64Data: string }[] = [];
    const mentions: string[] = [];
    const skipped: string[] = [];
    for (const path of paths) {
      const name = basename(path);
      const imageType = imageTypeFor(name);
      try {
        if (imageType) {
          const size = (await stat(path)).size;
          if (size > MAX_IMAGE_BYTES) {
            skipped.push(`${name} is too large (${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB).`);
            continue;
          }
          images.push({ name, mediaType: imageType, base64Data: (await readFile(path)).toString("base64") });
        } else {
          const mention = mentionFor(path, roots);
          if (mention) mentions.push(mention);
          else skipped.push(`${name} is outside this chat's folders, so Muse's file tools would refuse it. Use "Add folder" for its folder first.`);
        }
      } catch (error) {
        skipped.push(`${name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.post({ type: "picked", images, mentions, skipped });
  }

  /** The last text editor the user looked at: the chat's own webview takes focus away from the active one. */
  private lastEditor: vscode.TextEditor | undefined;
  private editorTracker: vscode.Disposable | undefined;
  private focusWatcher: vscode.Disposable | undefined;
  private readonly planWatch = new PlanWatch();

  private editorForContext(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor ?? this.lastEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file");
  }

  /** "Add current file": the file open in the editor becomes an @mention (or is explained when it is outside the chat's folders). */
  private async addCurrentFile(): Promise<void> {
    const editor = this.editorForContext();
    if (!editor || editor.document.uri.scheme !== "file") {
      this.notice("info", "There is no file open in the editor to add.");
      return;
    }
    await this.addPaths([editor.document.uri.fsPath]);
  }

  /**
   * "Add selection": the selected text of the current editor goes into the message as a quoted block that says which
   * file and lines it came from, so the model sees exactly what you saw. Capped, because a message is not a file.
   */
  private async addSelection(): Promise<void> {
    const editor = this.editorForContext();
    const sel = editor?.selection;
    if (!editor || !sel || sel.isEmpty) {
      this.notice("info", "Select some text in an editor first, then choose Add selection.");
      return;
    }
    const MAX = 20_000;
    let text = editor.document.getText(sel);
    const cut = text.length > MAX;
    if (cut) text = text.slice(0, MAX);
    const root = this.workspaceFolder();
    const rel = root ? relativeToRoots(normalizeHostPath(canonicalPath(editor.document.uri.fsPath)), rootsFor(root, this.extraRoots).map((r) => normalizeHostPath(canonicalPath(r)))) : undefined;
    const where = `${rel ?? basename(editor.document.uri.fsPath)}:${sel.start.line + 1}-${sel.end.line + 1}`;
    const fence = text.includes("```") ? "~~~~" : "```";
    this.post({ type: "picked", images: [], mentions: [], skipped: cut ? [`The selection was longer than ${MAX} characters; the first ${MAX} were added.`] : [], snippet: `${where}\n${fence}\n${text}\n${fence}\n` });
  }

  /** Files dropped on the chat from the Explorer (they arrive as file: URIs); anything else is ignored. */
  private async dropUris(uris: string[]): Promise<void> {
    if (!Array.isArray(uris)) return;
    const paths: string[] = [];
    for (const raw of uris.slice(0, 20)) {
      try {
        const uri = vscode.Uri.parse(String(raw));
        if (uri.scheme === "file") paths.push(uri.fsPath);
      } catch {
        /* not a URI */
      }
    }
    if (paths.length > 0) await this.addPaths(paths);
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

  /**
   * "Import skills": copies skills from Claude's or Codex's folders into Muse, through the host. It always shows
   * the host's own preview first and changes nothing until the user confirms; skills are instructions the model
   * follows, so the dialog says to read them. Afterwards the slash palette is refreshed.
   */
  private async importSkills(): Promise<void> {
    const session = this.ensureSession(true) ?? this.ensureSession(false);
    if (!session) return;
    const dev = this.devPicks();
    const pick = dev.length > 0 ? dev[0] : (await vscode.window.showQuickPick(["Claude", "Codex"], { title: "Import skills from…", placeHolder: "Where are the skills now?" }))?.toLowerCase();
    if (pick !== "claude" && pick !== "codex") return;
    const label = pick === "claude" ? "Claude" : "Codex";
    try {
      const preview = await session.importSkills(pick, true);
      if (preview.installed.length === 0) {
        const why = [preview.skipped.length ? `${preview.skipped.length} already imported` : "", preview.quarantined.length ? `${preview.quarantined.length} held back` : "", preview.failed.length ? `${preview.failed.length} could not be read` : ""].filter(Boolean).join(", ");
        this.notice("info", `Nothing new to import from ${label}${why ? ` (${why})` : ""}.`);
        return;
      }
      const shown = preview.installed.slice(0, 15).join(", ") + (preview.installed.length > 15 ? `, and ${preview.installed.length - 15} more` : "");
      const extra = [preview.skipped.length ? `${preview.skipped.length} already imported (left alone)` : "", preview.quarantined.length ? `${preview.quarantined.length} held back by Muse` : "", preview.failed.length ? `${preview.failed.length} could not be read` : ""].filter(Boolean).join("; ");
      const choice = await vscode.window.showWarningMessage(
        `Import ${preview.installed.length} skill${preview.installed.length === 1 ? "" : "s"} from ${label}?`,
        { modal: true, detail: `${shown}${extra ? `\n\n${extra}.` : ""}\n\nThis copies them into Muse's skills so they appear under / in every chat. A skill is a set of instructions the model follows: read what you import. Nothing has been changed yet.` },
        "Import",
      );
      if (choice !== "Import") return;
      const done = await session.importSkills(pick, false);
      this.notice("info", `Imported ${done.installed.length} skill${done.installed.length === 1 ? "" : "s"} from ${label}${done.quarantined.length ? `; ${done.quarantined.length} held back by Muse` : ""}${done.failed.length ? `; ${done.failed.length} could not be imported` : ""}.`);
      this.post({ type: "skills", skills: await session.listSkills() });
    } catch (error) {
      this.notice("error", `Could not import skills: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- plugins: install and marketplaces (each step shows what it does and asks first) ----

  private museBinary(): string | undefined {
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    if (!binary) this.notice("error", "Muse executable not found. Install Muse Code or set antares.musePath in Settings.");
    return binary;
  }

  private static readonly CODE_WARNING = "Hooks and MCP servers are programs that run on this computer. Install only plugins you trust. Antares never approves what a plugin brings; review it in a terminal with muse plugins inspect before you rely on it.";

  /** Refreshes the plugin list the page shows, when it is open. */
  private async refreshPluginList(session: MuseSession): Promise<void> {
    this.post({ type: "extras", kind: "plugins", rows: await session.listPlugins().catch(() => []) });
  }

  /** Install from a folder: Muse's own read-only validation first (it installs and executes nothing), then the dialog. */
  private async installPluginFromFolder(): Promise<void> {
    const binary = this.museBinary();
    const session = binary ? (this.ensureSession(true) ?? this.ensureSession(false)) : undefined;
    if (!binary || !session) return;
    const dev = this.devPicks();
    const picked = dev.length > 0 ? vscode.Uri.file(dev[0]!) : (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, openLabel: "Check this plugin", title: "Choose a plugin folder" }))?.[0];
    if (!picked) return;
    try {
      const preview = await validatePlugin(binary, picked.fsPath);
      if (!preview.valid || !preview.id) {
        this.notice("warning", `That folder is not an installable plugin: ${preview.diagnostics[0] ?? "Muse could not read it."}`);
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Install plugin ${preview.id}${preview.version ? ` ${preview.version}` : ""}?`,
        { modal: true, detail: `${preview.description ?? ""}${preview.description ? "\n\n" : ""}From the folder ${picked.fsPath}\n${describeCapabilities(preview)}${preview.diagnostics.length ? `\n\nMuse noted: ${preview.diagnostics.slice(0, 3).join("; ")}` : ""}\n\n${ChatPanel.CODE_WARNING}` },
        "Install",
      );
      if (choice !== "Install") return;
      const done = await session.installPlugin({ localPath: picked.fsPath });
      this.notice("info", `Installed ${done.id} ${done.version} (${done.enabled ? "enabled" : "disabled"}). Its skills and commands appear in new chats.${done.warning ? ` Muse says: ${done.warning}` : ""}`);
      await this.refreshPluginList(session);
    } catch (error) {
      this.notice("error", `Could not install the plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Install from a marketplace already configured in Muse: pick from what it offers, see where it comes from, confirm. */
  private async installPluginFromMarketplace(): Promise<void> {
    const binary = this.museBinary();
    const session = binary ? (this.ensureSession(true) ?? this.ensureSession(false)) : undefined;
    if (!binary || !session) return;
    try {
      const available = await listAvailablePlugins(binary);
      if (available.length === 0) {
        this.notice("info", "No marketplace offers a plugin yet. Use Add marketplace first.");
        return;
      }
      const dev = this.devPicks();
      let chosen = dev.length > 0 ? available.find((p) => `${p.name}@${p.marketplace}` === dev[0]) : undefined;
      if (!chosen && dev.length === 0) {
        const item = await vscode.window.showQuickPick(available.map((p) => ({ label: p.name, description: `${p.version ?? ""} · from ${p.marketplace}`.trim(), detail: p.source, plugin: p })), { title: "Install a plugin from a marketplace", placeHolder: "Pick a plugin" });
        chosen = item?.plugin;
      }
      if (!chosen) return;
      const choice = await vscode.window.showWarningMessage(
        `Install plugin ${chosen.name}${chosen.version ? ` ${chosen.version}` : ""} from ${chosen.marketplace}?`,
        { modal: true, detail: `Source: ${chosen.source ?? "the marketplace's snapshot"}\n\nAntares cannot look inside a marketplace plugin before it is installed.\n\n${ChatPanel.CODE_WARNING}` },
        "Install",
      );
      if (choice !== "Install") return;
      const done = await session.installPlugin({ marketplace: chosen.marketplace, name: chosen.name });
      this.notice("info", `Installed ${done.id} ${done.version} (${done.enabled ? "enabled" : "disabled"}). Its skills and commands appear in new chats.${done.warning ? ` Muse says: ${done.warning}` : ""}`);
      await this.refreshPluginList(session);
    } catch (error) {
      this.notice("error", `Could not install the plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Add a marketplace: a catalog (a folder or a Git repository). It installs nothing by itself. */
  private async addMarketplace(): Promise<void> {
    const session = this.ensureSession(true) ?? this.ensureSession(false);
    if (!session) return;
    const dev = this.devPicks();
    const name = dev.length >= 2 ? dev[0] : await vscode.window.showInputBox({ title: "Add a marketplace", prompt: "A short name for it", validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? undefined : "Use letters, digits, dot, dash or underscore") });
    if (!name) return;
    const source = dev.length >= 2 ? dev[1] : await vscode.window.showInputBox({ title: `Add marketplace ${name}`, prompt: "A local folder, owner/repo, or a Git URL" });
    if (!source) return;
    const choice = await vscode.window.showWarningMessage(
      `Add marketplace ${name}?`,
      { modal: true, detail: `Source: ${source}\n\nThis adds a catalog to Muse. It installs no plugin by itself. For a Git source, Muse downloads the repository to read its list.` },
      "Add marketplace",
    );
    if (choice !== "Add marketplace") return;
    try {
      const done = await session.addMarketplace(name, source);
      this.notice("info", `Added marketplace ${done.name}: ${done.pluginCount} plugin${done.pluginCount === 1 ? "" : "s"} offered. Nothing was installed.`);
    } catch (error) {
      this.notice("error", `Could not add the marketplace: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.showMarketplaces();
  }

  private async listPlugins(): Promise<void> {
    const session = this.ensureSession(true) ?? this.ensureSession(false);
    if (!session) return;
    // Muse's own CLI says far more than MSP (what each plugin brings, the review state of its hooks and MCP servers); MSP's list is the fallback.
    const cli = this.skillsCli();
    if (!("error" in cli)) {
      try {
        this.post({ type: "extras", kind: "plugins", rich: true, rows: await listManagedPlugins(cli.options) });
        return;
      } catch {
        /* fall back to the host's list below */
      }
    }
    try {
      this.post({ type: "extras", kind: "plugins", rows: await session.listPlugins() });
    } catch (error) {
      this.post({ type: "extras", kind: "plugins", rows: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Runs one plugin change after the user confirmed it, reports the outcome, and redraws the list. */
  private async pluginChange(confirm: { title: string; detail: string; button: string; warn?: boolean }, act: () => Promise<string>): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli) {
      this.notice("error", cli.error);
      return;
    }
    const show = confirm.warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    if ((await show(confirm.title, { modal: true, detail: confirm.detail }, confirm.button)) !== confirm.button) return;
    try {
      this.notice("info", await act());
    } catch (error) {
      this.notice("error", `${confirm.title.replace(/\?$/, "")} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.listPlugins();
  }

  /** Approves or rejects ONE code-running part of a plugin, after showing exactly what it is. Nothing is ever approved automatically. */
  private async pluginDecide(pluginId: unknown, kind: unknown, capabilityId: unknown, decision: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof pluginId !== "string" || typeof capabilityId !== "string" || (decision !== "approve" && decision !== "reject") || (kind !== "hook" && kind !== "mcp_server")) return;
    const plugin = (await listManagedPlugins(cli.options).catch(() => [])).find((p) => p.id === pluginId);
    const part = plugin?.runtime.find((r) => r.kind === kind && r.capabilityId === capabilityId);
    if (!plugin || !part) {
      this.notice("error", `Could not find ${capabilityId} in ${pluginId}. Reload the list.`);
      return;
    }
    const what = kind === "hook" ? "hook" : "MCP server";
    const approve = decision === "approve";
    await this.pluginChange(
      {
        title: `${approve ? "Approve" : "Reject"} the ${what} of ${plugin.name}?`,
        detail: [
          `${what[0]!.toUpperCase()}${what.slice(1)}: ${part.detail || part.capabilityId}`,
          approve
            ? `Approving lets Muse run this on your computer, with your permissions and outside Muse's sandbox, every time it applies. Approve only what you have read and trust. The approval covers this exact definition: if the plugin changes it, you are asked again.`
            : `Rejecting keeps it from running. You can approve it later.`,
        ].join(BLANK_LINE),
        button: approve ? "Approve" : "Reject",
        warn: approve,
      },
      async () => {
        await decideCapability(cli.options, { pluginId, kind: kind as Exclude<CapabilityKind, "unknown">, capabilityId, decision });
        return `${approve ? "Approved" : "Rejected"} the ${what} of ${pluginId}. It applies to new chats.`;
      },
    );
  }

  private async pluginEnable(id: unknown, enabled: boolean): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof id !== "string") return;
    await this.pluginChange(
      { title: `${enabled ? "Enable" : "Disable"} the plugin ${id}?`, detail: enabled ? "Its skills become available in new chats, and any hooks or MCP servers you already approved run again." : "Muse stops loading it in new chats. It stays installed with your approvals.", button: enabled ? "Enable" : "Disable" },
      async () => {
        await setPluginEnabled(cli.options, id, enabled);
        return `${id} is now ${enabled ? "enabled" : "disabled"}. It applies to new chats.`;
      },
    );
  }

  private async pluginUpdate(id: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof id !== "string") return;
    await this.pluginChange(
      { title: `Update the plugin ${id}?`, detail: "Muse copies it again from the place it was installed from. If a hook or MCP server changed, it must be approved again before it runs.", button: "Update" },
      async () => {
        await updatePlugin(cli.options, id);
        return `Updated ${id}. Check the list: a changed hook or MCP server waits for your review.`;
      },
    );
  }

  private async pluginRemove(id: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof id !== "string") return;
    await this.pluginChange(
      { title: `Remove the plugin ${id}?`, detail: "Muse removes the installed plugin and its cached copy. Its own data folder is kept. The folder it was installed from is not touched.", button: "Remove", warn: true },
      async () => {
        await removePlugin(cli.options, id, { deleteData: false });
        return `Removed ${id}.`;
      },
    );
  }

  /** The marketplaces view: the catalogs plugins can be installed from. */
  private async showMarketplaces(): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli) {
      this.post({ type: "extras", kind: "marketplaces", rows: [], error: cli.error });
      return;
    }
    try {
      const rows = await listMarketplaces(cli.options);
      this.post({ type: "extras", kind: "marketplaces", rows, suggested: pendingSuggestions(rows).map((s) => ({ name: s.name, title: s.title, kind: s.kind, note: s.note, source: s.source })) });
    } catch (error) {
      this.post({ type: "extras", kind: "marketplaces", rows: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Shown once per install (and never if the user turned it off): the suggested catalogs are offered, never added silently. */
  private async offerCatalogs(): Promise<void> {
    if (!vscode.workspace.getConfiguration("antares").get<boolean>("offerCatalogs", true)) return;
    if (this.context.globalState.get<boolean>("antares.catalogsOffered")) return;
    await this.context.globalState.update("antares.catalogsOffered", true);
    const choice = await vscode.window.showInformationMessage(
      "Antares can start you off with two catalogs: Anthropic's official plugins marketplace and Anthropic's Agent Skills. Nothing is added unless you choose, and you can add your own anytime.",
      "Look at them",
      "Not now",
    );
    if (choice === "Look at them") this.post({ type: "openExtras", kind: "marketplaces" });
  }

  /** Adds one suggested plugin marketplace to Muse, after a confirmation that says where it comes from and what to expect. */
  private async addSuggested(name: unknown): Promise<void> {
    const cli = this.skillsCli();
    const s = SUGGESTED.find((x) => x.name === name && x.kind === "plugins");
    if ("error" in cli || !s) return;
    const go = "Add catalog";
    if ((await vscode.window.showInformationMessage(`Add ${s.title}?`, { modal: true, detail: [`Source: ${s.source}`, s.note, "This adds a catalog to Muse's configuration. It installs no plugin by itself."].join(BLANK_LINE) }, go)) !== go) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding ${s.title}…` }, async () => {
      try {
        const done = await addMarketplaceCli(cli.options, s.name, s.source);
        this.notice("info", `Added ${s.title}: ${done.pluginCount} plugin${done.pluginCount === 1 ? "" : "s"} Muse can use, ${done.skipped} skipped by Muse. Nothing was installed.`);
      } catch (error) {
        this.notice("error", `Could not add ${s.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    await this.showMarketplaces();
  }

  /** A skills collection: downloaded into a throwaway folder, the skills listed, the chosen ones validated by Muse and installed after a confirmation. */
  private async browseCollection(name: unknown): Promise<void> {
    const cli = this.skillsCli();
    const s = SUGGESTED.find((x) => x.name === name && x.kind === "skills");
    if ("error" in cli || !s) return;
    let fetched: Awaited<ReturnType<typeof fetchCollection>> | undefined;
    try {
      fetched = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${s.title}…` }, () => fetchCollection(s.source));
      const skills = await scanSkills(fetched.dir);
      if (skills.length === 0) {
        this.notice("info", "No skills were found in that collection.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        skills.map((k) => ({ label: k.name, description: k.relativePath.replace(/\\/g, "/"), detail: k.description, skill: k })),
        { title: `${s.title}: pick the skills to install`, placeHolder: "Nothing is installed until you confirm on the next step", canPickMany: true, matchOnDetail: true },
      );
      if (!picked || picked.length === 0) return;
      const checks = [];
      for (const p of picked) checks.push({ p, preview: await validateSkill(cli.options, p.skill.dir) });
      const bad = checks.filter((c) => !c.preview.valid);
      const good = checks.filter((c) => c.preview.valid);
      if (good.length === 0) {
        this.notice("error", `Muse does not accept any of the chosen skills: ${bad.map((c) => `${c.p.label} (${c.preview.diagnostics[0] ?? "no reason"})`).join("; ")}.`);
        return;
      }
      const detail = [
        `Muse checked them and accepts: ${good.map((c) => c.p.label).join(", ")}.`,
        bad.length ? `Muse does not accept: ${bad.map((c) => c.p.label).join(", ")}. They are left out.` : "",
        ...good.filter((c) => c.preview.allowedTools.length).map((c) => `${c.p.label} asks to use: ${c.preview.allowedTools.join(", ")}.`),
        "A skill is a set of instructions the model follows. These come from a public repository you do not control: read a skill before relying on it. Nothing has been installed yet.",
      ].filter(Boolean).join(BLANK_LINE);
      const go = `Install ${good.length}`;
      if ((await vscode.window.showInformationMessage(`Install ${good.length} skill${good.length === 1 ? "" : "s"} from ${s.title}?`, { modal: true, detail }, go)) !== go) return;
      const done: string[] = [];
      const skipped: string[] = [];
      for (const c of good) {
        try {
          await installSkill(cli.options, c.p.skill.dir, { force: false });
          done.push(c.p.label);
        } catch (error) {
          skipped.push(`${c.p.label} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      this.notice(skipped.length ? "warning" : "info", `Installed ${done.length} skill${done.length === 1 ? "" : "s"}${done.length ? `: ${done.join(", ")}` : ""}.${skipped.length ? ` Not installed: ${skipped.join("; ")}.` : ""} They appear in new chats.`);
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error));
    } finally {
      await fetched?.cleanup();
    }
  }

  private async marketplaceUpdate(name: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof name !== "string") return;
    try {
      await updateMarketplace(cli.options, name);
      this.notice("info", `Refreshed the marketplace ${name}. Nothing was installed.`);
    } catch (error) {
      this.notice("error", `Could not refresh ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.showMarketplaces();
  }

  private async marketplaceRemove(name: unknown): Promise<void> {
    const cli = this.skillsCli();
    if ("error" in cli || typeof name !== "string") return;
    const go = "Remove";
    if ((await vscode.window.showWarningMessage(`Remove the marketplace ${name}?`, { modal: true, detail: "Muse forgets this catalog and its snapshot. Plugins already installed from it stay installed." }, go)) !== go) return;
    try {
      await removeMarketplace(cli.options, name);
      this.notice("info", `Removed the marketplace ${name}.`);
    } catch (error) {
      this.notice("error", `Could not remove ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.showMarketplaces();
  }

  // ---- connectors: OAuth sign-in and sign-out, run by the host; Antares never sees a credential ----

  private mcpOptions() {
    const binary = this.museBinary();
    const cwd = this.workspaceFolder();
    if (!binary || !cwd) {
      if (binary) this.notice("error", "Open a folder first.");
      return undefined;
    }
    return { binary, cwd, clientVersion: (this.context.extension.packageJSON as { version?: string }).version };
  }

  private async connectorSignIn(server: string): Promise<void> {
    const options = this.mcpOptions();
    if (!options || typeof server !== "string" || this.loginAbort) return;
    const abort = new AbortController();
    this.loginAbort = abort;
    this.post({ type: "extras", kind: "connectors", progress: `Starting the sign-in to ${server}…` });
    try {
      const result = await oauthSignIn({ ...options, signal: abort.signal }, server, async (url) => {
        const origin = httpsOrigin(url);
        if (!origin) {
          this.notice("error", `Muse returned a sign-in address that is not https, so Antares did not open it.`);
          return false;
        }
        const choice = await vscode.window.showWarningMessage(
          `Sign in to ${server}?`,
          { modal: true, detail: `Your browser will open ${origin}, the provider's sign-in page for this connector. Muse runs the sign-in and keeps the credential; Antares never sees it. Only continue if you expect this page.` },
          "Open the sign-in page",
        );
        if (choice !== "Open the sign-in page") return false;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        this.post({ type: "extras", kind: "connectors", progress: `Waiting for you to finish signing in to ${server} in the browser…`, cancellable: true });
        return true;
      });
      if (result.outcome === "granted") this.notice("info", `Signed in to ${server}.`);
      else if (result.outcome === "cancelled") this.notice("info", `The sign-in to ${server} was cancelled.`);
      else this.notice("warning", `The sign-in to ${server} did not finish (${result.outcome})${result.message ? `: ${result.message}` : ""}.`);
    } catch (error) {
      this.notice("error", `Could not sign in: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.loginAbort = undefined;
      await this.listConnectors();
    }
  }

  private async connectorSignOut(server: string): Promise<void> {
    const options = this.mcpOptions();
    if (!options || typeof server !== "string") return;
    const choice = await vscode.window.showWarningMessage(
      `Sign out of ${server}?`,
      { modal: true, detail: "Muse deletes its stored credential for this connector, and asks the provider to revoke it (best effort). The connector will need a new sign-in to work." },
      "Sign out",
    );
    if (choice !== "Sign out") return;
    try {
      const result = await oauthSignOut(options, server);
      this.notice("info", result.removed ? `Signed out of ${server}. The provider's revocation: ${result.revocation}.` : `There was no stored credential for ${server}.`);
    } catch (error) {
      this.notice("error", `Could not sign out: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.listConnectors();
  }

  private async listConnectors(): Promise<void> {
    const config = vscode.workspace.getConfiguration("antares");
    const binary = locateMuse(config.get<string>("musePath"));
    const root = this.workspaceFolder();
    if (!binary || !root) {
      this.post({ type: "extras", kind: "connectors", rows: [], error: !binary ? "Muse executable not found." : "Open a folder first." });
      return;
    }
    // The file is the source for the servers it defines (the host's list does not show them); the host adds the sign-in
    // state and the servers that come from plugins and sessions. A host that cannot answer does not hide the file's servers.
    const file = await this.readMcpFile();
    const hostRows = await listMcpServers({ binary, cwd: root, clientVersion: (this.context.extension.packageJSON as { version?: string }).version }).catch(() => []);
    this.post({ type: "extras", kind: "connectors", rows: connectorRows(file.config, hostRows), file: { path: file.config.path, key: file.config.key, warnings: file.config.warnings, parseError: file.config.parseError } });
  }

  /** The user's Muse settings file and what it says about MCP servers. */
  private async readMcpFile(): Promise<{ text: string | undefined; config: ReturnType<typeof parseMcpConfig> }> {
    const path = museConfigPath(process.env);
    let text: string | undefined;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { text, config: parseMcpConfig(text, path) };
  }

  /** Shows what will change (never a secret value), asks, then saves with a backup. Returns whether it was saved. */
  private async confirmAndSave(title: string, detail: string[], build: (text: string | undefined) => string): Promise<boolean> {
    const file = await this.readMcpFile();
    if (file.config.parseError) {
      this.notice("error", `${file.config.parseError} Fix the file first: ${file.config.path}`);
      return false;
    }
    let next: string;
    try {
      next = build(file.text);
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error));
      return false;
    }
    const go = "Save";
    const body = [...detail, `This edits Muse's settings file for every Muse client on this computer: ${file.config.path}`, file.config.exists ? "A backup of the current file is kept next to it." : "The file does not exist yet and will be created."].join(BLANK_LINE);
    if ((await vscode.window.showWarningMessage(title, { modal: true, detail: body }, go)) !== go) return false;
    try {
      const { backup } = await saveConfig(file.config.path, next, file.config.fingerprint);
      this.notice("info", `Saved to Muse's settings${backup ? ` (backup: ${basename(backup)})` : ""}. It applies to new chats; one already open keeps the servers it started with.`);
      return true;
    } catch (error) {
      this.notice("error", `Could not save: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Asks for KEY / value pairs one at a time. Values are typed in a masked box and never shown again. */
  private async askPairs(what: "environment variable" | "header"): Promise<Record<string, string> | undefined> {
    const out: Record<string, string> = {};
    for (;;) {
      const key = await vscode.window.showInputBox({ title: `Add a ${what}? (optional)`, prompt: `${what[0]!.toUpperCase()}${what.slice(1)} name. Leave empty to finish.`, ignoreFocusOut: true });
      if (key === undefined) return undefined;
      if (key.trim() === "") return out;
      const value = await vscode.window.showInputBox({ title: `Value of ${key}`, prompt: "Typed hidden and stored in Muse's settings file. To keep the secret out of the file, type a reference such as ${MY_VARIABLE} that Muse resolves from the environment.", password: true, ignoreFocusOut: true });
      if (value === undefined) return undefined;
      out[key.trim()] = value;
    }
  }

  private async mcpAdd(transport: "stdio" | "streamable_http"): Promise<void> {
    const file = await this.readMcpFile();
    const taken = new Set(file.config.entries.map((e) => e.name));
    const name = await vscode.window.showInputBox({ title: "New MCP server: name", prompt: "Letters, digits, dot, dash and underscore.", ignoreFocusOut: true, validateInput: (v) => (taken.has(v) ? "A server with this name already exists." : validateInput({ name: v, transport: "stdio", command: "x" }).find((p) => /name/.test(p))) });
    if (!name) return;
    let input: McpServerInput;
    if (transport === "stdio") {
      const command = await vscode.window.showInputBox({ title: `${name}: command`, prompt: "The program Muse will start (a path or a name on your PATH).", ignoreFocusOut: true });
      if (!command) return;
      const args = await vscode.window.showInputBox({ title: `${name}: arguments (optional)`, prompt: "Separated by spaces; use quotes for an argument with spaces.", ignoreFocusOut: true });
      if (args === undefined) return;
      const env = await this.askPairs("environment variable");
      if (!env) return;
      input = { name, transport: "stdio", command, ...(args.trim() ? { args: splitArgs(args) } : {}), ...(Object.keys(env).length ? { env } : {}) };
    } else {
      const url = await vscode.window.showInputBox({ title: `${name}: URL`, prompt: "The server's streamable-HTTP endpoint (http or https).", ignoreFocusOut: true });
      if (!url) return;
      const headers = await this.askPairs("header");
      if (!headers) return;
      input = { name, transport: "streamable_http", url, ...(Object.keys(headers).length ? { headers } : {}) };
    }
    const mode = await vscode.window.showQuickPick([{ label: "optional", description: "if it cannot start, Muse skips it with a warning (recommended)" }, { label: "required", description: "if it cannot start, the chat run stops" }], { title: `${name}: what if it cannot start?`, ignoreFocusOut: true });
    if (!mode) return;
    input = { ...input, mode: mode.label as "optional" | "required" };
    const problems = validateInput(input);
    if (problems.length) {
      this.notice("error", problems.join(" "));
      return;
    }
    const detail = [
      input.transport === "stdio"
        ? `This program will run on this computer, with your permissions, every time Muse starts a chat: ${input.command}${input.args?.length ? ` (${input.args.length} argument${input.args.length === 1 ? "" : "s"})` : ""}. MCP tools are not sandboxed. Only add servers you trust.`
        : `Muse will connect to ${(() => { try { return new URL(input.url).origin; } catch { return input.url; } })()}. MCP tools are not sandboxed. Only add servers you trust.`,
      `Mode: ${input.mode}.`,
      input.transport === "stdio" && input.env ? `Environment variables: ${Object.keys(input.env).join(", ")} (values hidden).` : "",
      input.transport === "streamable_http" && input.headers ? `Headers: ${Object.keys(input.headers).join(", ")} (values hidden).` : "",
    ].filter(Boolean);
    if (await this.confirmAndSave(`Add the MCP server "${name}"?`, detail, (text) => applyEdit(text, { op: "upsert", input }))) await this.listConnectors();
  }

  private async mcpEdit(name: unknown): Promise<void> {
    if (typeof name !== "string") return;
    const file = await this.readMcpFile();
    const entry = file.config.entries.find((e) => e.name === name);
    const raw = rawEntry(file.text, name);
    if (!entry || !raw) {
      this.notice("error", `There is no server named "${name}" in the settings file.`);
      return;
    }
    let input: McpServerInput;
    if (entry.transport === "stdio") {
      const command = await vscode.window.showInputBox({ title: `${name}: command`, value: entry.command ?? "", ignoreFocusOut: true });
      if (!command) return;
      const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
      const args = await vscode.window.showInputBox({ title: `${name}: arguments`, value: entry.args.map(quote).join(" "), prompt: "Environment variables are kept as they are.", ignoreFocusOut: true });
      if (args === undefined) return;
      input = { name, transport: "stdio", command, args: splitArgs(args) };
    } else if (entry.transport === "streamable_http") {
      const url = await vscode.window.showInputBox({ title: `${name}: URL`, value: entry.url ?? "", prompt: "Headers are kept as they are.", ignoreFocusOut: true });
      if (!url) return;
      input = { name, transport: "streamable_http", url };
    } else {
      this.notice("error", `"${name}" has no valid transport, so Antares cannot edit it safely. Fix it in the settings file: ${file.config.path}`);
      return;
    }
    const mode = await vscode.window.showQuickPick([{ label: "optional" }, { label: "required" }], { title: `${name}: what if it cannot start?`, placeHolder: `now: ${entry.mode}`, ignoreFocusOut: true });
    if (!mode) return;
    input = { ...input, mode: mode.label as "optional" | "required" };
    const problems = validateInput(input);
    if (problems.length) {
      this.notice("error", problems.join(" "));
      return;
    }
    const target = input.transport === "stdio" ? input.command : (() => { try { return new URL(input.url).origin; } catch { return input.url; } })();
    if (await this.confirmAndSave(`Change the MCP server "${name}"?`, [`New target: ${target}. Mode: ${input.mode}.`, "Environment variables, headers and any other fields of this server are kept."], (text) => applyEdit(text, { op: "upsert", input }))) await this.listConnectors();
  }

  private async mcpRemove(name: unknown): Promise<void> {
    if (typeof name !== "string") return;
    if (await this.confirmAndSave(`Remove the MCP server "${name}"?`, ["The server's entry, including any secrets stored in it, is removed from Muse's settings. The backup keeps the old file."], (text) => applyEdit(text, { op: "remove", name }))) await this.listConnectors();
  }

  private async mcpToggle(name: unknown, enabled: boolean): Promise<void> {
    if (typeof name !== "string") return;
    if (await this.confirmAndSave(`${enabled ? "Enable" : "Disable"} the MCP server "${name}"?`, [enabled ? "Muse will start it again in new chats." : "Muse will not start it in new chats. Its configuration stays in the file."], (text) => applyEdit(text, { op: "setEnabled", name, enabled }))) await this.listConnectors();
  }

  /** Asks Muse to start this one server in a clean config (no model call). It runs the configured program, so it asks first. */
  private async mcpTest(name: unknown): Promise<void> {
    if (typeof name !== "string") return;
    const binary = locateMuse(vscode.workspace.getConfiguration("antares").get<string>("musePath"));
    const file = await this.readMcpFile();
    const raw = rawEntry(file.text, name);
    if (!binary || !raw) {
      this.notice("error", !binary ? "Muse executable not found." : `There is no server named "${name}" in the settings file.`);
      return;
    }
    const stdio = raw.transport === "stdio";
    const go = "Test";
    const detail = stdio
      ? `Muse will start this program on your computer, in a clean configuration: ${String(raw.command)}. It makes no model call. It checks that the server starts and answers; it does not prove a tool call works, and it cannot see files or sign-ins in your own home folder.`
      : "Muse will try to connect to this server in a clean configuration, so a saved sign-in is not used. It makes no model call.";
    if ((await vscode.window.showWarningMessage(`Test the MCP server "${name}"?`, { modal: true, detail }, go)) !== go) return;
    this.post({ type: "mcpTestResult", name, running: true });
    const result = await testMcpServer(name, raw, { binary });
    this.post({ type: "mcpTestResult", name, started: result.started, reason: result.reason });
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
