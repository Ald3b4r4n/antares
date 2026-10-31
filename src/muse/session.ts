import { EventEmitter } from "node:events";
import { MuseHost } from "./host.ts";
import { mapApprovalRequest, mapModels, mapNotification, mapUsage, type ChatEvent } from "./events.ts";
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
  /** Provider id for tests (e.g. "echo"); an ephemeral host cannot take a permission profile. */
  provider?: string;
  clientVersion?: string;
  /** Test seam: arguments placed before `serve` (lets a script stand in for the muse binary). */
  binaryArgs?: string[];
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
 */
export class MuseSession extends EventEmitter {
  private readonly options: MuseSessionOptions;
  private host?: MuseHost;
  private sessionId?: string;
  private currentTurnId?: string;
  private starting?: Promise<void>;
  private readonly pendingApprovals = new Set<string>();

  info: { version?: string; fingerprint?: string; sandbox?: string; durability?: string } = {};

  constructor(options: MuseSessionOptions) {
    super();
    this.options = options;
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

  /** Starts the host and a session if not already started. Safe to call repeatedly. */
  start(): Promise<void> {
    this.starting ??= this.doStart().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private emitEvent(event: ChatEvent): void {
    this.emit("event", event);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emitEvent({ type: "notice", level, text });
  }

  private async doStart(): Promise<void> {
    const { binary, workspaceRoot, env, provider } = this.options;
    const profile = this.profile;
    const args = [...(this.options.binaryArgs ?? []), "serve"];
    if (profile === READ_ONLY) args.push("--disable-shell", "--disable-write");
    if (provider) args.push("--provider", provider, "--no-session-log");
    const host = new MuseHost({ binary, args, cwd: workspaceRoot, env: env ?? process.env });
    this.host = host;
    host.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
    host.on("request", (id: number | string, method: string, params: unknown) => this.onServerRequest(id, method, params));
    host.on("exit", (code: number | null) => {
      this.currentTurnId = undefined;
      this.sessionId = undefined;
      this.starting = undefined;
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

    const started = await host.request<{ session?: { sessionId?: string } }>("session/start", {
      commandId: uuidv7(),
      workspaceRoot,
      ...(provider ? {} : { permissionProfile: profile }),
    });
    this.sessionId = started.session?.sessionId;
    if (!this.sessionId) throw new Error("Muse did not return a session id.");
    this.emitEvent({ type: "session", profileId: provider ? undefined : profile, sandbox: this.info.sandbox, version: this.info.version, durability: this.info.durability });

    // Best-effort, read-only extras for the header; failures never block chatting.
    host.request("model/list", {}).then((r) => this.emitEvent({ type: "models", models: mapModels(r) })).catch(() => undefined);
    host.request<{ usage?: unknown }>("usage/read", {}).then((r) => {
      const usage = mapUsage(r.usage);
      if (usage) this.emitEvent(usage);
    }).catch(() => undefined);
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

  /** Sends one user prompt. Resolves when the host accepted it, not when the turn ends. */
  async send(text: string): Promise<void> {
    await this.start();
    if (!this.host || !this.sessionId) throw new Error("Muse session is not available.");
    await this.host.request("turn/start", {
      commandId: uuidv7(),
      sessionId: this.sessionId,
      input: [{ type: "text", text }],
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
    if (host) await host.stop();
  }
}
