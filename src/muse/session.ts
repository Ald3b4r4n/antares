import { EventEmitter } from "node:events";
import { MuseHost } from "./host.ts";
import { mapModels, mapNotification, mapUsage, type ChatEvent } from "./events.ts";
import { uuidv7 } from "./uuidv7.ts";

export interface MuseSessionOptions {
  binary: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Safe mode (default): shell and file-write tools are disabled and the session starts in the
   * `:read-only` profile. Approvals are not implemented in the UI yet, so tools that would need
   * them stay off. Turning it off is a deliberate, explicit choice made by the caller.
   */
  safeMode?: boolean;
  /** Provider id for tests (e.g. "echo"); an ephemeral host cannot take a permission profile. */
  provider?: string;
  clientVersion?: string;
}

interface InitializeResult {
  schema?: { fingerprint?: string };
  serverInfo?: { version?: string };
  sandboxAvailability?: string;
  sessionDurability?: string;
}

/**
 * One chat session over one `muse serve` host. Emits "event" (ChatEvent) for everything the UI
 * shows and "exit" when the host goes away.
 */
export class MuseSession extends EventEmitter {
  private readonly options: MuseSessionOptions;
  private host?: MuseHost;
  private sessionId?: string;
  private currentTurnId?: string;
  private starting?: Promise<void>;

  info: { version?: string; fingerprint?: string; sandbox?: string; durability?: string } = {};

  constructor(options: MuseSessionOptions) {
    super();
    this.options = options;
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

  private async doStart(): Promise<void> {
    const { binary, workspaceRoot, env, provider } = this.options;
    const safe = this.options.safeMode !== false;
    const args = ["serve"];
    if (safe) args.push("--disable-shell", "--disable-write");
    if (provider) args.push("--provider", provider, "--no-session-log");
    const host = new MuseHost({ binary, args, cwd: workspaceRoot, env: env ?? process.env });
    this.host = host;
    host.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
    host.on("request", (id: number | string, method: string) => {
      // Approvals and user-input dialogs are not implemented yet: say so instead of hanging.
      this.emitEvent({ type: "notice", level: "warning", text: `The agent asked for "${method}", which this build of Antares cannot answer yet. Stopping the turn.` });
      void this.interrupt();
      void id;
    });
    host.on("exit", (code: number | null) => {
      this.currentTurnId = undefined;
      this.sessionId = undefined;
      this.starting = undefined;
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
      ...(safe && !provider ? { permissionProfile: ":read-only" } : {}),
    });
    this.sessionId = started.session?.sessionId;
    if (!this.sessionId) throw new Error("Muse did not return a session id.");

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
    if (event.type === "turnCompleted") this.currentTurnId = undefined;
    this.emitEvent(event);
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
