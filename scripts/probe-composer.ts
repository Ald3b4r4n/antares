// Phase 2B probe: skills, plugins, hooks, MCP servers and turn queueing. NO model call (echo provider,
// ephemeral session, empty throwaway workspace). Prints counts, field names and the names of bundled
// skills only; the user's own skill, plugin and server names go to the output file's counts, not the console.
//
// Usage: node scripts/probe-composer.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-composer-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);
const notes: Record<string, unknown> = {};

async function withHost<T>(experimental: boolean, body: (host: MuseHost, notifications: string[]) => Promise<T>): Promise<T> {
  const host = new MuseHost({ binary: binary!, args: ["serve", "--provider", "echo", "--no-session-log", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
  const notifications: string[] = [];
  host.on("notification", (method: string) => notifications.push(method));
  host.on("request", (_id: number | string, method: string) => notifications.push(`serverRequest:${method}`));
  host.start();
  try {
    await host.request("initialize", {
      clientInfo: { name: "antares_probe", version: "0.0.1" },
      capabilities: { ...(experimental ? { experimentalApi: true } : {}), requestedCapabilities: [], userInputDialogs: false },
    });
    host.notify("initialized");
    return await body(host, notifications);
  } finally {
    await host.stop();
  }
}

const ask = async (host: MuseHost, method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};

try {
  await withHost(false, async (host, notifications) => {
    const started = await ask(host, "session/start", { commandId: uuidv7(), workspaceRoot: workspace });
    const sessionId = started.session?.sessionId as string | undefined;
    notes.sessionStart = { ok: Boolean(sessionId), error: started.error };
    if (!sessionId) return;

    const skills = await ask(host, "skill/list", { sessionId });
    const rows: any[] = skills.skills ?? [];
    notes.skills = {
      error: skills.error,
      count: rows.length,
      rowKeys: keys(rows[0]),
      bySource: rows.reduce((acc: Record<string, number>, r) => ({ ...acc, [r.source]: (acc[r.source] ?? 0) + 1 }), {}),
      bundledSelectors: rows.filter((r) => r.source === "bundled").map((r) => r.selector),
      withArgumentHint: rows.filter((r) => r.argumentHint).length,
    };
    const plugins = await ask(host, "plugin/list", { sessionId });
    const prows: any[] = plugins.plugins ?? [];
    notes.plugins = { error: plugins.error, count: prows.length, rowKeys: keys(prows[0]), enabled: prows.filter((p) => p.enabled).length, sourceKeys: keys(prows[0]?.source) };
    const hooks = await ask(host, "hook/list", { sessionId });
    const hrows: any[] = hooks.hooks ?? [];
    notes.hooks = { error: hooks.error, topKeys: keys(hooks), count: hrows.length, rowKeys: keys(hrows[0]) };
    const mcpStable = await ask(host, "mcpServer/list", { sessionId });
    notes.mcpWithoutExperimental = { error: mcpStable.error, keys: keys(mcpStable) };

    // Queueing against the echo provider: a first turn, then immediately a second with each disposition.
    const turn = async (text: string, ifBusy?: string) =>
      ask(host, "turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "text", text }], ...(ifBusy ? { ifBusy } : {}) });
    const first = await turn("one");
    const second = await turn("two"); // default ifBusy
    const third = await turn("three", "steer");
    notes.turns = {
      first: { keys: keys(first), disposition: first.disposition, error: first.error },
      second: { disposition: second.disposition, error: second.error, startedNewTurn: second.startedNewTurn },
      third: { disposition: third.disposition, error: third.error },
    };
    await new Promise((r) => setTimeout(r, 2500));
    notes.turnNotifications = [...new Set(notifications)].filter((n) => /turn|queue|steer|user/i.test(n));
  });

  await withHost(true, async (host) => {
    const mcp = await ask(host, "mcpServer/list", {});
    const rows: any[] = mcp.servers ?? [];
    notes.mcpServers = {
      error: mcp.error,
      count: rows.length,
      rowKeys: keys(rows[0]),
      bySource: rows.reduce((acc: Record<string, number>, r) => ({ ...acc, [r.source]: (acc[r.source] ?? 0) + 1 }), {}),
      byOAuth: rows.reduce((acc: Record<string, number>, r) => ({ ...acc, [r.oauth]: (acc[r.oauth] ?? 0) + 1 }), {}),
      byTransport: rows.reduce((acc: Record<string, number>, r) => ({ ...acc, [r.transport]: (acc[r.transport] ?? 0) + 1 }), {}),
    };
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(new URL("probe-composer.json", outDir), JSON.stringify(notes, null, 2));
console.log(JSON.stringify(notes, null, 2));
