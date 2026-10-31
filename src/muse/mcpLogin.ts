import { MuseHost, MspError } from "./host.ts";
import type { McpListOptions } from "./mcp.ts";

/**
 * OAuth sign-in and sign-out for MCP servers, through the host (experimental `mcpServer/oauthLogin`,
 * `oauthLoginCancel`, `oauthLogout`). The host owns the whole flow and the stored credential: Antares only gets the
 * provider's authorization URL, opens it after the user agrees, and hears how the flow ended. It never sees a
 * token. A login completes through a notification on the SAME connection that started it, so unlike the list this
 * uses one host for the whole flow, and stops it when the flow ends.
 */

export interface LoginResult {
  /** granted, denied, expired, cancelled or failed (the host's words; "expired" is also used when Antares gives up waiting). */
  outcome: string;
  message?: string;
}

export interface LoginOptions extends McpListOptions {
  /** How long to wait for the user to finish in the browser. Default five minutes. */
  timeoutMs?: number;
  /** Aborting cancels the pending flow. */
  signal?: AbortSignal;
}

/** The origin (scheme and host) of a URL when it is https, else undefined. A dialog shows this, never the full URL (it carries a state value). */
export function httpsOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function startHost(options: McpListOptions): MuseHost {
  return new MuseHost({
    binary: options.binary,
    args: [...(options.binaryArgs ?? []), "serve", "--disable-shell", "--disable-write"],
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
}

async function connect(host: MuseHost, version: string | undefined): Promise<void> {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares", version: version ?? "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
}

/**
 * Starts the login, then asks `decide` whether to go on, handing it the authorization URL. When `decide` says no
 * (or the user aborts, or the wait runs out) the pending flow is cancelled at the host. Resolves with how it ended.
 */
export async function oauthSignIn(options: LoginOptions, server: string, decide: (authorizationUrl: string) => Promise<boolean>): Promise<LoginResult> {
  const host = startHost(options);
  let finished: ((r: LoginResult) => void) | undefined;
  const done = new Promise<LoginResult>((resolve) => {
    finished = resolve;
  });
  host.on("notification", (method: string, params: unknown) => {
    if (method !== "mcpServer/oauthLoginCompleted" || typeof params !== "object" || params === null) return;
    const p = params as { server?: unknown; outcome?: unknown; message?: unknown };
    if (p.server !== server) return;
    finished?.({ outcome: typeof p.outcome === "string" ? p.outcome : "failed", message: typeof p.message === "string" ? p.message : undefined });
  });
  host.on("exit", () => finished?.({ outcome: "failed", message: "The Muse host stopped during the sign-in." }));
  const cancel = async (): Promise<void> => {
    await host.request("mcpServer/oauthLoginCancel", { server }, 10_000).catch(() => undefined);
  };
  try {
    await connect(host, options.clientVersion);
    const started = await host.request<{ authorizationUrl?: unknown }>("mcpServer/oauthLogin", { server }, 30_000);
    const url = typeof started.authorizationUrl === "string" ? started.authorizationUrl : undefined;
    if (!url) return { outcome: "failed", message: "Muse did not return a sign-in address." };
    if (!(await decide(url))) {
      await cancel();
      return { outcome: "cancelled" };
    }
    const onAbort = (): void => {
      void cancel().then(() => finished?.({ outcome: "cancelled" }));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      void cancel().then(() => finished?.({ outcome: "expired", message: "Antares stopped waiting for the sign-in to finish." }));
    }, options.timeoutMs ?? 300_000);
    try {
      return await done;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (error instanceof MspError) return { outcome: "failed", message: error.message };
    throw error;
  } finally {
    await host.stop(3000);
  }
}

export interface LogoutResult {
  removed: boolean;
  /** succeeded, failed or notAttempted: what the provider-side revocation did. Best effort; the local delete is what counts. */
  revocation: string;
}

export async function oauthSignOut(options: McpListOptions, server: string): Promise<LogoutResult> {
  const host = startHost(options);
  try {
    await connect(host, options.clientVersion);
    const r = await host.request<{ removed?: unknown; revocation?: unknown }>("mcpServer/oauthLogout", { server }, 30_000);
    return { removed: r.removed === true, revocation: typeof r.revocation === "string" ? r.revocation : "notAttempted" };
  } catch (error) {
    if (error instanceof MspError) throw new Error(`The host refused the sign-out: ${error.message}`);
    throw error;
  } finally {
    await host.stop(3000);
  }
}
