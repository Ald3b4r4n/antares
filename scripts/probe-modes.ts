// Phase 2C probe: switching the approval mode and the permission profile in the middle of a session.
// NO model call and no turn: a throwaway empty folder, a real (durable) session that never receives a prompt,
// and the host started with shell and file-write tools disabled. It records what the host reports after each
// switch (the session's `approvalMode` and `permissionState`) so the mode selector rests on observation.
//
// Usage: node scripts/probe-modes.ts [path-to-muse]
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
const work = mkdtempSync(join(tmpdir(), "antares-modes-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({ binary, args: ["serve", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
const notifications: { method: string; params: unknown }[] = [];
host.on("notification", (method: string, params: unknown) => {
  if (/approvalModeChanged|permissionProfileChanged|session\//.test(method)) notifications.push({ method, params: slim(params) });
});
const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);
function slim(p: any): unknown {
  if (!p || typeof p !== "object") return p;
  const { viewCursor, sourceRange, commandId, ...rest } = p;
  return rest;
}
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const notes: Record<string, unknown> = {};
try {
  host.start();
  const init: any = await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  notes.initializeKeys = keys(init);
  host.notify("initialized");
  const started = await ask("session/start", { commandId: uuidv7(), workspaceRoot: workspace, permissionProfile: ":ask-me" });
  const sessionId = started.session?.sessionId as string | undefined;
  notes.startSessionKeys = keys(started.session);
  notes.startError = started.error;
  if (!sessionId) throw new Error(`no session: ${started.error}`);
  const state = (s: any) => ({ approvalMode: s?.approvalMode, permissionState: s?.permissionState });
  notes.afterStart = state(started.session);

  const list = await ask("permissionProfile/list", { sessionId });
  notes.profileList = (list.profiles ?? []).map((p: any) => ({ id: p.profileId, label: p.label, available: p.available, reviewer: p.reviewerAuthority, reasons: p.unavailableReasons, description: p.description }));
  notes.profileListError = list.error;

  const read = async () => {
    const r = await ask("session/read", { sessionId });
    return r.error ? { error: r.error } : state(r.session ?? r);
  };
  notes.readShape = keys((await ask("session/read", { sessionId })).session ?? {});

  notes.approvalModes = [];
  for (const mode of ["allowAll", "promptUnmatched", "onRequest", "denyUnmatched", "promptUnmatched"]) {
    const r = await ask("session/setApprovalMode", { commandId: uuidv7(), sessionId, mode });
    (notes.approvalModes as unknown[]).push({ mode, error: r.error, applyOutcome: r.applyOutcome, effectiveMode: r.effectiveMode, after: await read() });
  }

  notes.profiles = [];
  for (const profileId of [":read-only", ":auto-review", ":unrestricted", ":ask-me"]) {
    const r = await ask("session/setPermissionProfile", { commandId: uuidv7(), sessionId, profileId });
    (notes.profiles as unknown[]).push({ profileId, error: r.error, applyOutcome: r.applyOutcome, permissionState: r.permissionState, after: await read() });
  }
  notes.notifications = notifications;
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(new URL("probe-modes.json", outDir), JSON.stringify(notes, null, 2));
console.log(JSON.stringify(notes, null, 2));
