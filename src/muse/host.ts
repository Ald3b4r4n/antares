import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface MuseHostOptions {
  binary: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class MspError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, error: JsonRpcError) {
    super(`${method}: ${error.message} (code ${error.code})`);
    this.name = "MspError";
    this.code = error.code;
    this.data = error.data;
  }
}

/**
 * Thin JSON-RPC 2.0 client over the stdio of a `muse serve` child process.
 * One JSON object per line in each direction.
 *
 * Events: "notification" (method, params), "request" (id, method, params; server-to-client),
 * "stderr" (line), "exit" (code, signal), "protocolError" (line, error).
 */
export class MuseHost extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private exited = false;

  private readonly options: MuseHostOptions;

  constructor(options: MuseHostOptions) {
    super();
    this.options = options;
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  start(): void {
    if (this.child) throw new Error("host already started");
    const child = spawn(this.options.binary, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line !== "") this.emit("stderr", line);
      }
    });
    // A write to a host that is already gone must not crash the extension host with an unhandled EPIPE.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      // A failed spawn (missing binary, bad working directory) never produces an "exit" event, so treat
      // the host as gone here: otherwise stop() would wait for an exit that cannot come.
      if (!this.exited) {
        this.exited = true;
        this.failAll(error);
        this.emit("exit", null, null);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      this.failAll(new Error(`muse host exited (code ${code}, signal ${signal})`));
      this.emit("exit", code, signal);
    });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    const child = this.child;
    if (!child || this.exited) return Promise.reject(new Error("muse host is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Answers a server-to-client request received through the "request" event. */
  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Closes stdin (the host exits cleanly) and escalates to terminate/kill if it lingers. */
  async stop(graceMs = 5000): Promise<number | null> {
    const child = this.child;
    // A child that never started has no pid; its exitCode would be a libuv error number, not an exit code.
    if (!child || this.exited) return child && child.pid !== undefined ? child.exitCode : null;
    const done = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdin.end();
    const timeout = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
    if ((await Promise.race([done, timeout(graceMs)])) !== "timeout") return done;
    child.kill();
    if ((await Promise.race([done, timeout(graceMs)])) !== "timeout") return done;
    child.kill("SIGKILL");
    return done;
  }

  private write(message: object): void {
    const child = this.child;
    if (!child || this.exited) throw new Error("muse host is not running");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.emit("protocolError", line, error);
      return;
    }
    const id = message.id;
    const method = message.method;
    if (typeof method === "string") {
      if (id === undefined) this.emit("notification", method, message.params);
      else this.emit("request", id, method, message.params);
      return;
    }
    if (typeof id === "number") {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new MspError(entry.method, message.error as JsonRpcError));
      else entry.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

/**
 * Environment for a self-contained host that cannot reach the user's real Muse
 * configuration, data or credentials. Used by the offline self-test only.
 */
export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const config = join(root, "config");
  const data = join(root, "data");
  mkdirSync(config, { recursive: true });
  mkdirSync(data, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.META_API_KEY;
  delete env.MUSE_TRANSPORT_TRACE;
  env.XDG_CONFIG_HOME = config;
  env.XDG_DATA_HOME = data;
  env.MUSE_AUTH_PATH = join(config, "absent-auth.json");
  return env;
}
