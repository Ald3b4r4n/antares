// Phase 2C probe: can a session be continued under a different permission profile (and different host-level
// tool flags) after its host was stopped? Stable API only (session/start, session/resume). NO turn, no model
// call. The session it creates holds no conversation; the throwaway folder is removed afterwards.
//
// Usage: node scripts/probe-resume-profile.ts [path-to-muse]
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
const work = mkdtempSync(join(tmpdir(), "antares-resume-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

async function withHost<T>(flags: string[], body: (host: MuseHost) => Promise<T>): Promise<T> {
  const host = new MuseHost({ binary: binary!, args: ["serve", ...flags], cwd: workspace, env: { ...process.env } });
  host.start();
  try {
    await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
    host.notify("initialized");
    return await body(host);
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
const view = (r: any) => (r.error ? { error: r.error } : { profileId: r.session?.permissionState?.profileId, axes: r.session?.permissionState?.axes, turnCount: r.session?.turnCount, historyMode: r.history?.mode });

const notes: Record<string, unknown> = {};
try {
  const sessionId = await withHost(["--disable-shell", "--disable-write"], async (host) => {
    const started = await ask(host, "session/start", { commandId: uuidv7(), workspaceRoot: workspace, permissionProfile: ":read-only" });
    notes.start = view(started);
    return started.session?.sessionId as string;
  });
  notes.sessionId = Boolean(sessionId);
  notes.resumeAsk = await withHost([], async (host) => view(await ask(host, "session/resume", { commandId: uuidv7(), sessionId, history: "inline", permissionProfile: ":ask-me" })));
  notes.resumeAuto = await withHost([], async (host) => view(await ask(host, "session/resume", { commandId: uuidv7(), sessionId, history: "inline", permissionProfile: ":auto-review" })));
  notes.resumeUnrestricted = await withHost([], async (host) => view(await ask(host, "session/resume", { commandId: uuidv7(), sessionId, history: "inline", permissionProfile: ":unrestricted" })));
  notes.resumeBackReadOnly = await withHost(["--disable-shell", "--disable-write"], async (host) => view(await ask(host, "session/resume", { commandId: uuidv7(), sessionId, history: "inline", permissionProfile: ":read-only" })));
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(new URL("probe-resume-profile.json", outDir), JSON.stringify(notes, null, 2));
console.log(JSON.stringify(notes, null, 2));
