import { EventEmitter } from "node:events";
import { MuseHost, MspError } from "./host.ts";
import { mapApprovalRequest, mapModels, mapNotification, mapUsage, type ChatEvent, type ModelInfo } from "./events.ts";
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
  private modelId?: string;
  private effort?: string;
  private readonly pendingApprovals = new Set<string>();

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
      this.pendingApprovals.clear();
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
      this.catalog = mapModels(result);
      this.emitEvent({ type: "models", models: this.catalog });
    } catch {
      /* the picker simply stays as it was */
    }
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
      this.pendingApprovals.clear();
    }
    if (event.type === "approvalRequested") this.pendingApprovals.add(event.approvalId);
    if (event.type === "approvalResolved") this.pendingApprovals.delete(event.approvalId);
    if (event.type === "modelChanged") {
      this.modelId = event.modelId;
      this.catalog = this.catalog.map((m) => ({ ...m, isActive: m.modelId === event.modelId }));
      this.emitEvent({ type: "models", models: this.catalog });
    }
    this.emitEvent(event);
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
      this.host?.respond(id, {});
      this.pendingApprovals.add(event.approvalId);
      this.emitEvent(event);
      return;
    }
    this.notice("warning", `The agent asked for "${method}", which this build of Antares cannot answer yet. Stopping the turn.`);
    void this.interrupt();
  }

  /**
   * Sends one user prompt (text and/or images). Resolves when the host accepted it, not when the
   * turn ends. Images are validated here as well, because they come from the webview.
   */
  async send(text: string, images: ImageInput[] = []): Promise<void> {
    const checked = validateImages(images);
    if (!checked.ok) throw new Error(checked.error);
    const input = buildInputParts(text, checked.images);
    if (input.length === 0) throw new Error("There is nothing to send.");
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    await this.host.request("turn/start", {
      commandId: uuidv7(),
      sessionId: this.sessionId,
      input,
      ...(this.effort ? { reasoningEffort: this.effort } : {}),
    }, 30_000);
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
