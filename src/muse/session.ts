import { EventEmitter } from "node:events";
import { MuseHost, MspError } from "./host.ts";
import { catalogSource, diffCatalog, mapApprovalRequest, mapModels, mapNotification, mapUsage, sandboxNote, type ChatEvent, type ModelInfo } from "./events.ts";
import { canonicalPath, mapPlugins, mapSkillImport, mapSkills, parseSlash, rootsFor, type ImportSource, type PluginRow, type SkillImportView, type SkillRow } from "./composer.ts";
import { buildInputParts, validateImages, type ImageInput } from "./images.ts";
import { mapSessionRows, readHistory, type SessionRowView } from "./sessions.ts";
import { uuidv7 } from "./uuidv7.ts";

export const READ_ONLY = ":read-only";

export interface MuseSessionOptions {
  binary: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Permission profile for this chat, chosen at `session/start` (default `:read-only`).
   * With `:read-only`, Antares also starts the host with shell and file-write tools disabled as
   * belt and braces. Any other profile is an explicit choice by the user.
   */
  profile?: string;
  /** Model to start with. If the host refuses it, the session starts on the default and says so. */
  modelId?: string;
  /** Reasoning effort sent with each turn; undefined means "the model's default". */
  effort?: string;
  /** Provider id for tests (e.g. "echo"); an ephemeral host cannot take a permission profile. */
  provider?: string;
  clientVersion?: string;
  /** Test seam: arguments placed before `serve` (lets a script stand in for the muse binary). */
  binaryArgs?: string[];
  /** Continue this stored session instead of starting a new one. */
  resumeSessionId?: string;
  /** Start from a fork of this stored session. */
  forkSessionId?: string;
}

interface InitializeResult {
  schema?: { fingerprint?: string };
  serverInfo?: { version?: string };
  sandboxAvailability?: string;
  sessionDurability?: string;
}

/**
 * One chat session over one `muse serve` host. Emits "event" (ChatEvent) for everything the UI
 * shows and "exit" when the host goes away. Approvals are never decided by this class: it only
 * relays the host's offered choices to the UI and the user's pick back to the host.
 *
 * The host can be warmed (started and asked for the model catalog) before any session exists, so
 * the model picker is usable before the first message. No model call is made by warming.
 */
export class MuseSession extends EventEmitter {
  private readonly options: MuseSessionOptions;
  private host?: MuseHost;
  private hostReady?: Promise<MuseHost>;
  private sessionId?: string;
  private currentTurnId?: string;
  private starting?: Promise<void>;
  private catalog: ModelInfo[] = [];
  private catalogFailed = false;
  private catalogFetchedAtMs: number | undefined;
  private modelId?: string;
  private effort?: string;
  private skills?: SkillRow[];
  private extraRoots: string[] = [];
  private rootsDirty = false;
  /**
   * Approval stages already shown, as "approvalId#stage". The host announces each approval twice (as the
   * `approval/request` it expects a receipt for, and as an `approval/requested` notification), and
   * re-sends the request with the same approval id for each later stage of a multi-stage approval.
   * Each (approval, stage) is shown once; a new stage is shown again.
   */
  private readonly announcedApprovals = new Set<string>();

  info: { version?: string; fingerprint?: string; sandbox?: string; durability?: string } = {};

  constructor(options: MuseSessionOptions) {
    super();
    this.options = options;
    this.modelId = options.modelId;
    this.effort = options.effort;
  }

  get profile(): string {
    return this.options.profile ?? READ_ONLY;
  }

  get running(): boolean {
    return this.host?.running === true;
  }

  get busy(): boolean {
    return this.currentTurnId !== undefined;
  }

  private emitEvent(event: ChatEvent): void {
    this.emit("event", event);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emitEvent({ type: "notice", level, text });
  }

  /** Starts the host (no session) and publishes the model catalog. Never makes a model call. */
  async warm(): Promise<void> {
    await this.ensureHost();
    await this.refreshModels();
  }

  /** Starts the host and a session if not already started. Safe to call repeatedly. */
  start(): Promise<void> {
    this.starting ??= this.doStart().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private ensureHost(): Promise<MuseHost> {
    this.hostReady ??= this.spawnHost().catch((error: unknown) => {
      this.hostReady = undefined;
      throw error;
    });
    return this.hostReady;
  }

  private async spawnHost(): Promise<MuseHost> {
    const { binary, workspaceRoot, env, provider } = this.options;
    const args = [...(this.options.binaryArgs ?? []), "serve"];
    if (this.profile === READ_ONLY) args.push("--disable-shell", "--disable-write");
    if (provider) args.push("--provider", provider, "--no-session-log");
    const host = new MuseHost({ binary, args, cwd: workspaceRoot, env: env ?? process.env });
    this.host = host;
    host.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
    host.on("request", (id: number | string, method: string, params: unknown) => this.onServerRequest(id, method, params));
    host.on("exit", (code: number | null) => {
      this.currentTurnId = undefined;
      this.sessionId = undefined;
      this.starting = undefined;
      this.hostReady = undefined;
      this.skills = undefined;
      this.announcedApprovals.clear();
      this.emit("exit", code);
    });
    host.start();
    const init = await host.request<InitializeResult>("initialize", {
      clientInfo: { name: "antares", version: this.options.clientVersion ?? "0.0.1" },
      capabilities: { requestedCapabilities: [], userInputDialogs: false },
    });
    this.info = {
      version: init.serverInfo?.version,
      fingerprint: init.schema?.fingerprint,
      sandbox: init.sandboxAvailability,
      durability: init.sessionDurability,
    };
    host.notify("initialized");
    this.emitEvent({ type: "host", version: this.info.version, sandbox: this.info.sandbox, sandboxNote: sandboxNote(this.info.sandbox) });
    return host;
  }

  private async doStart(): Promise<void> {
    const host = await this.ensureHost();
    const { workspaceRoot, provider, resumeSessionId, forkSessionId } = this.options;
    const profile = this.profile;
    let started: { session?: { sessionId?: string }; history?: unknown; lastTurn?: unknown };
    let source: "resume" | "fork" | undefined;
    if (resumeSessionId) {
      // Always name the profile: omitting it would restore whatever authority the session had before,
      // which could be broader than what the user picked in this chat.
      source = "resume";
      started = await host.request("session/resume", { commandId: uuidv7(), sessionId: resumeSessionId, history: "inline", ...(provider ? {} : { permissionProfile: profile }) }, 30_000);
    } else if (forkSessionId) {
      // A fork cannot be given a permission profile (the contract does not admit one); Antares therefore
      // only offers it for :read-only chats, where the host-level tool limits apply regardless.
      source = "fork";
      started = await host.request("session/fork", { commandId: uuidv7(), sessionId: forkSessionId }, 30_000);
    } else {
      const base = { workspaceRoot, ...(provider ? {} : { permissionProfile: profile }) };
      try {
        started = await host.request("session/start", { commandId: uuidv7(), ...base, ...(this.modelId ? { modelId: this.modelId } : {}) });
      } catch (error) {
        if (!(error instanceof MspError) || !this.modelId) throw error;
        // A remembered model can disappear from the subscription; fall back instead of failing the chat.
        this.notice("warning", `Model ${this.modelId} is not available; using the default model instead.`);
        this.modelId = undefined;
        started = await host.request("session/start", { commandId: uuidv7(), ...base });
      }
    }
    this.sessionId = started.session?.sessionId;
    if (!this.sessionId) throw new Error("Muse did not return a session id.");
    this.emitEvent({ type: "session", sessionId: this.sessionId, profileId: provider ? undefined : profile, sandbox: this.info.sandbox, version: this.info.version, durability: this.info.durability });
    if (source) this.emitHistory(source, started);

    // Best-effort, read-only extras for the header; failures never block chatting.
    void this.refreshModels();
    host.request<{ usage?: unknown }>("usage/read", {}).then((r) => {
      const usage = mapUsage(r.usage);
      if (usage) this.emitEvent(usage);
    }).catch(() => undefined);
  }

  /** Replays a resumed or forked session's stored conversation, saying so when it was not served inline. */
  private emitHistory(source: "resume" | "fork", result: { history?: unknown; lastTurn?: unknown }): void {
    const served = readHistory(result.history);
    let note: string | undefined;
    if (served.mode !== "inline") note = "Muse did not send this session's earlier messages inline (it is long). You can continue it, but they are not shown here.";
    else if (source === "fork") note = "This is a fork. The history shown is what Muse returned for the fork; the source conversation is unchanged.";
    this.emitEvent({ type: "history", source, mode: served.mode, events: served.events, note });
    const last = result.lastTurn as { terminal?: unknown; reason?: unknown } | undefined;
    if (last && typeof last.terminal === "string" && last.terminal !== "completed") {
      this.notice("info", `The last turn of this session ended as "${last.terminal}"${typeof last.reason === "string" ? `: ${last.reason}` : ""}.`);
    }
  }

  /** Lists stored sessions (root sessions only, newest first) with the host's own index; reads no conversation. */
  async listSessions(): Promise<SessionRowView[]> {
    const host = await this.ensureHost();
    const rows: SessionRowView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const result: { nextCursor?: string | null } = await host.request("session/list", { limit: 200, ...(cursor ? { cursor } : {}) }, 30_000);
      rows.push(...mapSessionRows(result, this.options.workspaceRoot));
      cursor = result.nextCursor ?? null;
      if (!cursor) break;
    }
    return rows.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /** Reads the catalog (with the session's active model flagged when a session exists). */
  async refreshModels(): Promise<ModelInfo[]> {
    const host = this.host;
    if (!host || !host.running) return this.catalog;
    try {
      const result = await host.request("model/list", this.sessionId ? { sessionId: this.sessionId } : {});
      const next = mapModels(result);
      // An empty answer after a good catalog is not "the subscription has no models": keep what worked and say so.
      if (next.length === 0 && this.catalog.length > 0) throw new Error("the host returned an empty model list");
      const changes = diffCatalog(this.catalog, next);
      this.catalog = next;
      this.catalogFailed = false;
      this.catalogFetchedAtMs = Date.now();
      this.emitEvent({ type: "models", models: this.catalog });
      this.emitEvent({ type: "modelsStatus", stale: false, fetchedAtMs: this.catalogFetchedAtMs, source: catalogSource(result) });
      if (changes.added.length > 0 || changes.removed.length > 0) {
        const parts = [changes.added.length ? `new: ${changes.added.join(", ")}` : "", changes.removed.length ? `no longer available: ${changes.removed.join(", ")}` : ""].filter(Boolean);
        this.notice("info", `The model catalog changed (${parts.join("; ")}).`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: "modelsStatus", stale: true, fetchedAtMs: this.catalogFetchedAtMs, error: reason });
      if (!this.catalogFailed) this.notice("warning", `Could not refresh the model list (${reason}). The models shown may be out of date.`);
      this.catalogFailed = true;
    }
    return this.catalog;
  }

  /** When the catalog was last read successfully (ms since the epoch), or undefined if never. */
  lastCatalogReadMs(): number | undefined {
    return this.catalogFetchedAtMs;
  }

  /** The last good catalog (what the picker shows). */
  currentCatalog(): ModelInfo[] {
    return this.catalog;
  }

  /** Switches the model: before a session exists it is remembered for the start; after, `session/setModel`. */
  async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    if (!this.sessionId || !this.host) return;
    const row = this.catalog.find((m) => m.modelId === modelId);
    await this.host.request("session/setModel", {
      commandId: uuidv7(),
      sessionId: this.sessionId,
      model: { modelId, ...(row?.providerId ? { providerId: row.providerId } : {}), ...(row?.profileId ? { profileId: row.profileId } : {}), ...(row ? { displayLabel: row.label } : {}) },
    });
  }

  /** Sets the reasoning effort sent with each turn; undefined restores the model's default. */
  setEffort(effort: string | undefined): void {
    this.effort = effort;
  }

  private onNotification(method: string, params: unknown): void {
    const event = mapNotification(method, params);
    if (!event) return;
    if (event.type === "turnStarted") this.currentTurnId = event.turnId;
    if (event.type === "turnCompleted") {
      this.currentTurnId = undefined;
      this.announcedApprovals.clear();
    }
    if (event.type === "approvalRequested" && !this.announce(event)) return;
    if (event.type === "approvalResolved") this.forgetApproval(event.approvalId);
    if (event.type === "modelChanged") {
      this.modelId = event.modelId;
      this.catalog = this.catalog.map((m) => ({ ...m, isActive: m.modelId === event.modelId }));
      this.emitEvent({ type: "models", models: this.catalog });
    }
    this.emitEvent(event);
  }

  /** True the first time a given (approval, stage) is seen. */
  private announce(event: Extract<ChatEvent, { type: "approvalRequested" }>): boolean {
    const stage = (event.requirementId as { sourceIndex?: unknown } | null)?.sourceIndex;
    const key = `${event.approvalId}#${typeof stage === "number" ? stage : 0}`;
    if (this.announcedApprovals.has(key)) return false;
    this.announcedApprovals.add(key);
    return true;
  }

  private forgetApproval(approvalId: string): void {
    for (const key of this.announcedApprovals) if (key.startsWith(`${approvalId}#`)) this.announcedApprovals.delete(key);
  }

  private onServerRequest(id: number | string, method: string, params: unknown): void {
    if (method === "approval/request") {
      // The reply is only a presentation receipt; the decision travels as `approval/decide`.
      const event = mapApprovalRequest(params);
      if (!event || event.type !== "approvalRequested") {
        this.notice("error", "The agent asked for an approval Antares could not read. Stopping the turn instead of guessing.");
        void this.interrupt();
        return;
      }
      this.host?.respond(id, {}); // always answer the request, even when the notification already showed it
      if (this.announce(event)) this.emitEvent(event);
      return;
    }
    this.notice("warning", `The agent asked for "${method}", which this build of Antares cannot answer yet. Stopping the turn.`);
    void this.interrupt();
  }

  /**
   * Sends one user prompt (text and/or images). Resolves when the host accepted it, not when the
   * turn ends. Images are validated here as well, because they come from the webview.
   *
   * `ifBusy` says what to do when a turn is already running: `steer` folds the prompt into it, `queue`
   * holds it until the turn ends. Left out, the host's default (queue) applies. A typed `/skill args` is
   * sent as a `skill` part when the selector is in the host's own list. What the host did with the
   * prompt is announced as a "submitted" event.
   */
  async send(text: string, images: ImageInput[] = [], options: { ifBusy?: "queue" | "steer" } = {}): Promise<void> {
    const checked = validateImages(images);
    if (!checked.ok) throw new Error(checked.error);
    if (text.trim() === "" && checked.images.length === 0) throw new Error("There is nothing to send.");
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    // The skill list is read once per session (a typed "/" in the first message needs it); a failure just
    // means the text goes as plain text.
    if (text.trim().startsWith("/") && this.skills === undefined) await this.listSkills().catch(() => undefined);
    const skill = parseSlash(text, this.skills ?? []);
    const input = buildInputParts(text, checked.images, skill);
    if (input.length === 0) throw new Error("There is nothing to send.");
    const roots = this.rootsDirty ? { workspaceRoots: rootsFor(this.options.workspaceRoot, this.extraRoots).map(canonicalPath) } : {};
    const result = await this.host.request<{ turnId?: unknown; disposition?: unknown }>("turn/start", {
      commandId: uuidv7(),
      sessionId: this.sessionId,
      input,
      ...(options.ifBusy ? { ifBusy: options.ifBusy } : {}),
      ...(this.effort ? { reasoningEffort: this.effort } : {}),
      ...roots,
    }, 30_000);
    this.rootsDirty = false;
    const disposition = result.disposition === "queued" || result.disposition === "steered" ? result.disposition : "started";
    if (typeof result.turnId === "string") this.emitEvent({ type: "submitted", turnId: result.turnId, disposition, text });
  }

  /**
   * The folders the user added to this chat besides the workspace. The host takes the whole set at the next
   * turn (a sticky replacement), so the chat's own folder is always part of it. Takes effect on the next
   * message; a folder that is removed again is dropped the same way.
   */
  setExtraRoots(roots: string[]): void {
    this.extraRoots = [...roots];
    this.rootsDirty = true;
  }

  /** The session's user-invocable skills (starts the session, which is a host-side record but no model call). */
  async listSkills(): Promise<SkillRow[]> {
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    this.skills = mapSkills(await this.host.request("skill/list", { sessionId: this.sessionId }, 20_000));
    return this.skills;
  }

  /**
   * Imports skills from another assistant's folders through the host (`skill/import`). With `dryRun` it only
   * reports what would happen. A real import changes Muse's skills, so callers ask the user first, and it
   * refreshes the skill list this session keeps for the slash palette.
   */
  async importSkills(source: ImportSource, dryRun: boolean): Promise<SkillImportView> {
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    const result = mapSkillImport(await this.host.request("skill/import", { commandId: uuidv7(), sessionId: this.sessionId, source, dryRun }, 60_000));
    if (!dryRun) await this.listSkills().catch(() => undefined);
    return result;
  }

  /**
   * Installs a plugin (`plugin/install`): from a folder or from a configured marketplace. A plugin can bring hooks
   * and MCP servers, which run code, so callers show what it brings and ask first. Antares never approves what a
   * plugin brings; that is a separate step in Muse.
   */
  async installPlugin(target: { localPath: string } | { marketplace: string; name: string }): Promise<{ id: string; version: string; enabled: boolean; warning?: string }> {
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    const wire = "localPath" in target ? { localPath: { path: target.localPath } } : { marketplace: { marketplace: target.marketplace, name: target.name } };
    const r = await this.host.request<{ id?: unknown; version?: unknown; enabled?: unknown; warning?: unknown }>("plugin/install", { commandId: uuidv7(), sessionId: this.sessionId, target: wire }, 120_000);
    return { id: String(r.id ?? ""), version: String(r.version ?? ""), enabled: r.enabled === true, warning: typeof r.warning === "string" && r.warning ? r.warning : undefined };
  }

  /** Adds a marketplace (`plugin/marketplaceAdd`): a catalog to install from. It installs nothing. */
  async addMarketplace(name: string, source: string): Promise<{ name: string; pluginCount: number }> {
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    const r = await this.host.request<{ name?: unknown; pluginCount?: unknown }>("plugin/marketplaceAdd", { commandId: uuidv7(), sessionId: this.sessionId, name, source }, 120_000);
    return { name: String(r.name ?? name), pluginCount: typeof r.pluginCount === "number" ? r.pluginCount : 0 };
  }

  async listPlugins(): Promise<PluginRow[]> {
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    return mapPlugins(await this.host.request("plugin/list", { sessionId: this.sessionId }, 20_000));
  }

  /** Takes a queued prompt back before it launches. Admission is the race: a launched turn is not stopped. */
  async unqueue(turnId: string): Promise<void> {
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    await this.host.request("turn/unqueue", { commandId: uuidv7(), sessionId: this.sessionId, turnId }, 15_000);
  }

  /**
   * Relays the user's pick. `choiceId` must be one the host offered and `requirementId` is the
   * value the host sent with the request; neither is invented here.
   */
  async decide(approvalId: string, choiceId: string, requirementId: unknown, feedback?: string): Promise<void> {
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    await this.host.request("approval/decide", {
      commandId: uuidv7(),
      sessionId: this.sessionId,
      approvalId,
      choiceId,
      requirementId,
      ...(feedback ? { feedback } : {}),
    });
  }

  async interrupt(): Promise<void> {
    if (!this.host || !this.sessionId || !this.host.running) return;
    await this.host.request("turn/interrupt", { commandId: uuidv7(), sessionId: this.sessionId }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    this.hostReady = undefined;
    if (host) await host.stop();
  }
}
