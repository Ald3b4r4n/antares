// Phase 1 probe: session list, resume and fork. NO model call.
// Privacy: the user's history holds real conversations. This probe lists sessions but prints only
// counts and field NAMES. It resumes and forks ONLY sessions whose first prompt starts with one of
// the known test prompts used by this project's own probes; no other session is opened or read.
//
// Usage: node scripts/probe-sessions.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const OWN_PROMPTS = ["Reply with exactly: ok", "Use your shell tool to run exactly this command: echo antares", "Create a file named antares-note.txt", "Reply with exactly one word: the dominant colour"];

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-sessions-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({ binary, args: ["serve", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
const notes: Record<string, unknown> = {};
const notifications: string[] = [];
host.on("notification", (method: string) => notifications.push(method));
host.on("request", (_id: number | string, method: string) => notifications.push(`serverRequest:${method}`));

const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object) : []);
const ask = async <T>(method: string, params: unknown): Promise<T | { error: string }> => {
  try {
    return await host.request<T>(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
interface Row { sessionId: string; kind?: string; firstUserPrompt?: string; workspaceRoot?: string; turnCount?: number; status?: string; name?: string; title?: string; updatedAt?: string }

try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");

  const page = await ask<{ sessions: Row[]; nextCursor: string | null }>("session/list", { limit: 200 });
  if ("error" in page) throw new Error(page.error);
  const kinds: Record<string, number> = {};
  for (const s of page.sessions) kinds[s.kind ?? "?"] = (kinds[s.kind ?? "?"] ?? 0) + 1;
  notes.list = { count: page.sessions.length, hasNextPage: page.nextCursor !== null, kinds, rowKeys: keys(page.sessions[0]), sortedByUpdatedDesc: page.sessions.every((s, i, a) => i === 0 || (a[i - 1]?.updatedAt ?? "") >= (s.updatedAt ?? "")) };
  const own = page.sessions.filter((s) => OWN_PROMPTS.some((p) => s.firstUserPrompt?.startsWith(p)) && s.kind === "root");
  notes.ownTestSessions = own.length;
  console.log("list:", JSON.stringify(notes.list), "| own test sessions found:", own.length);

  // A workspace filter, using the throwaway workspace (expected: nothing).
  const filtered = await ask<{ sessions: Row[] }>("session/list", { workspaceRoot: workspace, limit: 5 });
  notes.filteredByEmptyWorkspace = "sessions" in filtered ? filtered.sessions.length : filtered;

  // Pick the own test session with a turn, if any.
  const target = own.find((s) => (s.turnCount ?? 0) > 0) ?? own[0];
  if (target) {
    const read = await ask<{ history?: { mode?: string; items?: unknown[] | null }; session?: Row }>("session/read", { sessionId: target.sessionId });
    notes.read = "error" in read ? read : { historyMode: read.history?.mode, itemKinds: kindCounts(read.history?.items), sessionKeys: keys(read.session) };
    console.log("read (own session):", JSON.stringify(notes.read));

    const resumed = await ask<{ history?: { mode?: string; items?: unknown[] | null }; session?: Row; viewCursor?: string; pendingRequests?: unknown[]; lastTurn?: unknown }>("session/resume", { commandId: uuidv7(), sessionId: target.sessionId, permissionProfile: ":read-only" });
    notes.resume = "error" in resumed ? resumed : { historyMode: resumed.history?.mode, itemKinds: kindCounts(resumed.history?.items), firstItemKeys: keys(resumed.history?.items?.[0]), pending: resumed.pendingRequests?.length, hasLastTurn: resumed.lastTurn !== undefined, sessionStatus: resumed.session?.status };
    console.log("resume (own session):", JSON.stringify(notes.resume));

    const forked = await ask<{ session?: Row & { forkedFrom?: unknown }; history?: { mode?: string; items?: unknown[] | null } }>("session/fork", { commandId: uuidv7(), sessionId: target.sessionId });
    notes.fork = "error" in forked ? forked : { newSessionDiffers: forked.session?.sessionId !== target.sessionId, forkedFromKeys: keys(forked.session?.forkedFrom), historyMode: forked.history?.mode, itemKinds: kindCounts(forked.history?.items) };
    console.log("fork (own session):", JSON.stringify(notes.fork));
    if (!("error" in forked) && forked.session?.sessionId) {
      const renamed = await ask<object>("session/rename", { commandId: uuidv7(), sessionId: forked.session.sessionId, name: "antares-probe-fork" });
      notes.rename = "error" in renamed ? renamed : "accepted";
      const left = await ask<object>("session/leave", { commandId: uuidv7(), sessionId: forked.session.sessionId });
      notes.leaveFork = "error" in left ? left : "ok";
    }
    const left = await ask<object>("session/leave", { commandId: uuidv7(), sessionId: target.sessionId });
    notes.leaveResumed = "error" in left ? left : "ok";
    console.log("rename / leave:", JSON.stringify({ rename: notes.rename, leaveFork: notes.leaveFork, leaveResumed: notes.leaveResumed }));
  } else {
    console.log("no own test session found; resume/fork not exercised");
  }
  await new Promise((r) => setTimeout(r, 300));
  notes.notifications = [...new Set(notifications)];
} catch (error) {
  notes.error = error instanceof Error ? error.message : String(error);
  console.log("error:", notes.error);
} finally {
  await host.stop();
  writeFileSync(new URL("probe-sessions.json", outDir), JSON.stringify(notes, null, 2));
  console.log("notifications:", JSON.stringify(notes.notifications));
  rmSync(work, { recursive: true, force: true });
}

function kindCounts(items: unknown[] | null | undefined): Record<string, number> | null {
  if (!Array.isArray(items)) return null;
  const out: Record<string, number> = {};
  for (const it of items) {
    const kind = it && typeof it === "object" ? String((it as { kind?: unknown }).kind ?? "?") : "?";
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}
