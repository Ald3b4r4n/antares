// Phase 1 probe: ONE minimal real turn, to record the shape of model/list, usage/read and the
// streaming notifications. Costs a tiny slice of the user's subscription; run it deliberately.
//
// Safety: shell and file writes are disabled, the profile is :read-only (picked at session/start; an
// ephemeral host would refuse it, so the session log goes to the throwaway data dir), and the Muse
// config tree is isolated so the user's MCP servers and hooks are NOT started. Authentication is
// the official client's own: MUSE_AUTH_PATH points at the existing auth file, whose contents this
// script never reads.
//
// Usage: node scripts/probe-turn.ts [path-to-muse]
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv, MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const real = process.argv.includes("--real-env");
const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found. Pass its path as the first argument.");
  process.exit(2);
}

const xdg = process.env.XDG_CONFIG_HOME;
const authCandidate = process.env.MUSE_AUTH_PATH ?? join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "muse", "auth.json");
if (!real && !existsSync(authCandidate)) {
  console.error("No Muse login found (auth file missing). Log in with the official client first.");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "antares-turn-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

// --real-env: run in the user's normal environment (real login). Shell and writes stay disabled and
// the profile is :read-only, but the user's configured MCP servers and hooks may start.
const env = real ? { ...process.env } : isolatedEnv(join(work, "muse-home"));
if (!real) env.MUSE_AUTH_PATH = authCandidate;

const host = new MuseHost({
  binary,
  args: ["serve", "--disable-shell", "--disable-write"],
  cwd: workspace,
  env,
});

const log: { at: number; kind: string; method?: string; payload?: unknown }[] = [];
const t0 = Date.now();
const rec = (kind: string, method?: string, payload?: unknown) => log.push({ at: Date.now() - t0, kind, method, payload });
host.on("notification", (method: string, params: unknown) => rec("notification", method, params));
host.on("request", (id: number | string, method: string, params: unknown) => rec("serverRequest", method, { id, params }));
host.on("stderr", (line: string) => rec("stderr", undefined, line));

const TERMINAL = /^turn\/(completed|failed|cancelled|canceled|interrupted|aborted)/;
let finished = false;
let terminal: unknown;
let summary: Record<string, unknown> = {};

try {
  host.start();
  const init = await host.request<Record<string, unknown>>("initialize", {
    clientInfo: { name: "antares", version: "0.0.1" },
    capabilities: { requestedCapabilities: [], userInputDialogs: false },
  });
  rec("result", "initialize", init);
  host.notify("initialized");

  const models = await host.request("model/list", {}).catch((e: Error) => ({ error: e.message }));
  rec("result", "model/list", models);
  const usageBefore = await host.request("usage/read", {}).catch((e: Error) => ({ error: e.message }));
  rec("result", "usage/read(before)", usageBefore);

  const started = await host.request<{ session?: { sessionId?: string } }>("session/start", {
    commandId: uuidv7(),
    workspaceRoot: workspace,
    permissionProfile: ":read-only",
  });
  rec("result", "session/start", started);
  const sessionId = started.session?.sessionId;
  if (!sessionId) throw new Error("no sessionId in session/start result");

  const done = new Promise<void>((resolve) => {
    host.on("notification", (method: string, params: unknown) => {
      if (TERMINAL.test(method)) {
        finished = true;
        terminal = (params as { terminal?: unknown } | undefined)?.terminal;
        resolve();
      }
    });
    setTimeout(resolve, 120_000);
  });

  console.log("Sending ONE real turn (minimal prompt)...");
  const ack = await host.request("turn/start", {
    commandId: uuidv7(),
    sessionId,
    input: [{ type: "text", text: "Reply with exactly: ok" }],
  }, 30_000);
  rec("result", "turn/start", ack);
  await done;
  if (!finished) {
    rec("note", undefined, "no terminal turn notification within 120 s; interrupting");
    await host.request("turn/interrupt", { commandId: uuidv7(), sessionId }).catch(() => undefined);
  }
  const usageAfter = await host.request("usage/read", {}).catch((e: Error) => ({ error: e.message }));
  rec("result", "usage/read(after)", usageAfter);
} catch (error) {
  rec("error", undefined, error instanceof Error ? error.message : String(error));
} finally {
  const code = await host.stop();
  rec("exit", undefined, code);
  const counts: Record<string, number> = {};
  for (const e of log) if (e.kind === "notification" && e.method) counts[e.method] = (counts[e.method] ?? 0) + 1;
  summary = { terminalSeen: finished, turnOutcome: terminal, hostExitCode: code, notificationCounts: counts, serverRequests: log.filter((e) => e.kind === "serverRequest").map((e) => e.method), errors: log.filter((e) => e.kind === "error").map((e) => e.payload) };
  writeFileSync(new URL("probe-turn.json", outDir), JSON.stringify({ summary, log }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  rmSync(work, { recursive: true, force: true });
}
