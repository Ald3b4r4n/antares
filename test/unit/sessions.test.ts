// Session history: pure mapping (row shape observed with scripts/probe-sessions.ts) and the
// list / resume / fork behavior of MuseSession against the fake MSP host.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "../../src/muse/events.ts";
import { MuseSession } from "../../src/muse/session.ts";
import { ago, historyToEvents, mapSessionRows, normalizePath, oneLine, readHistory, sameFolder } from "../../src/muse/sessions.ts";
import { readReport } from "../fixtures/report.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------- pure mapping

test("folders compare ignoring separators, the extended-length prefix, trailing slash and (on Windows) case", () => {
  assert.equal(normalizePath("C:\\Users\\Me\\Proj\\", true), "c:/users/me/proj");
  assert.equal(normalizePath("\\\\?\\C:\\Users\\Me\\Proj", true), "c:/users/me/proj");
  assert.equal(sameFolder("c:\\users\\me\\PROJ", "C:/Users/Me/proj/", true), true);
  assert.equal(sameFolder("/home/Me/proj", "/home/me/proj", false), false, "case matters off Windows");
  assert.equal(sameFolder(undefined, "C:/x", true), false);
  assert.equal(sameFolder("C:/a", "C:/b", true), false);
});

test("oneLine folds control characters and whitespace and clips", () => {
  assert.equal(oneLine("  hello\n\n  world\t!  "), "hello world !");
  assert.equal(oneLine("x".repeat(200), 10), "xxxxxxxxx…");
  assert.equal(oneLine("a\u0000b\u007fc"), "a b c");
});

const row = (id: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, kind: "root", workspaceRoot: "D:\\work\\proj", turnCount: 3, modelId: "muse-wonder-1.0", forkedFrom: null, updatedAt: "2026-10-31T10:00:00Z", lastActivityAt: "2026-10-31T10:00:00Z", ...extra });

test("rows: root sessions only, titled, flagged for this folder, newest activity first", () => {
  const rows = mapSessionRows(
    {
      sessions: [
        row("old", { title: "Old one", lastActivityAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }),
        row("child", { kind: "subagent", title: "A subagent" }),
        row("other", { title: "Other folder", workspaceRoot: "Z:\\elsewhere", lastActivityAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" }),
        row("new", { title: "", name: "Named", lastActivityAt: "2026-10-31T12:00:00Z", updatedAt: "2026-10-31T12:00:00Z", forkedFrom: { sessionId: "old" } }),
        row("noTitle", { firstUserPrompt: "What is\nthis?", lastActivityAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" }),
        { nope: true },
        null,
      ],
    },
    "d:/work/proj/",
    true,
  );
  assert.deepEqual(rows.map((r) => r.sessionId), ["new", "noTitle", "other", "old"]);
  assert.equal(rows.length, 4, "the subagent child and the malformed entries are dropped");
  assert.equal(rows[0]?.title, "Named", "name wins over an empty title");
  assert.equal(rows[0]?.forked, true);
  assert.equal(rows[1]?.title, "What is this?", "falls back to the first prompt, on one line");
  assert.equal(rows[2]?.sameWorkspace, false);
  assert.equal(rows[3]?.sameWorkspace, true);
  assert.equal(rows[3]?.updatedAtMs, Date.parse("2026-10-02T00:00:00Z"), "the later of updatedAt and lastActivityAt");
  assert.equal(mapSessionRows({ sessions: [{ sessionId: "x", kind: "root" }] }, "/w", false)[0]?.title, "(untitled)");
  assert.deepEqual(mapSessionRows(null, "/w"), []);
});

const items = [
  { itemId: "hk", kind: "hookRun", status: "completed", label: "a hook" },
  { itemId: "u1", kind: "userMessage", status: "completed", text: "hi[Image #1]", attachments: [{ type: "image", mediaType: "image/png", width: 8, height: 8 }] },
  { itemId: "t1", kind: "toolCall", status: "completed", tool: "write_file", args: '{"path":"a.txt","content":"x"}', visibleOutput: "wrote 1 bytes" },
  { itemId: "a1", kind: "agentMessage", status: "completed", text: "done" },
  { itemId: "rc", kind: "reminderChild", status: "completed" },
  { nonsense: true },
];

test("history (observed item kinds): only the conversation is replayed, in order", () => {
  const events = historyToEvents(items);
  assert.deepEqual(events.map((e) => e.type), ["userMessage", "toolCall", "assistantCompleted"]);
  assert.equal(events[0]?.type === "userMessage" && events[0].attachments.length, 1);
  assert.equal(events[1]?.type === "toolCall" && events[1].summary, "a.txt");
  assert.deepEqual(historyToEvents(null), []);
  assert.deepEqual(historyToEvents("nope"), []);
});

test("history envelope: only 'inline' carries items; other modes are reported, not guessed", () => {
  assert.equal(readHistory({ mode: "inline", items }).events.length, 3);
  assert.deepEqual(readHistory({ mode: "snapshot", items: null, snapshot: {} }), { mode: "snapshot", events: [] });
  assert.deepEqual(readHistory({ mode: "none", items: null }), { mode: "none", events: [] });
  assert.deepEqual(readHistory(undefined), { mode: "none", events: [] });
});

test("ago", () => {
  const now = 1_800_000_000_000;
  assert.equal(ago(now - 10_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5 min ago");
  assert.equal(ago(now - 3 * 3600_000, now), "3 h ago");
  assert.equal(ago(now - 26 * 3600_000, now), "yesterday");
  assert.equal(ago(now - 5 * 86400_000, now), "5 d ago");
  assert.equal(ago(0, now), "");
});

// ---------------------------------------------------------------- against the fake host

function run(options: { profile?: string; resumeSessionId?: string; forkSessionId?: string; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-sessions-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({
    binary: process.execPath,
    binaryArgs: [fake],
    workspaceRoot: dir,
    profile: options.profile ?? ":read-only",
    resumeSessionId: options.resumeSessionId,
    forkSessionId: options.forkSessionId,
    env: { ...process.env, FAKE_MUSE_REPORT: reportPath, FAKE_MUSE_WORKSPACE: dir, ...(options.env ?? {}) },
  });
  const events: ChatEvent[] = [];
  session.on("event", (e: ChatEvent) => events.push(e));
  return {
    session,
    events,
    dir,
    report: () => readReport(reportPath),
    done: async () => {
      await session.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("listSessions pages, drops subagent children, and marks this folder's sessions", async () => {
  const t = run();
  try {
    const rows = await t.session.listSessions();
    assert.deepEqual(rows.map((r) => r.sessionId), ["new", "elsewhere", "old"]);
    assert.equal(rows.find((r) => r.sessionId === "new")?.title, "Named session");
    assert.deepEqual(rows.map((r) => r.sameWorkspace), [true, false, true]);
    await until(() => t.report().sessionLists.length === 2, "both list pages");
    assert.equal(t.report().sessionLists[1]?.cursor, "page-2", "the second page used the host's cursor");
    assert.equal(t.report().startAttempts.length, 0, "listing does not start a session");
  } finally {
    await t.done();
  }
});

test("resume always names the permission profile and replays the conversation", async () => {
  const t = run({ profile: ":ask-me", resumeSessionId: "old" });
  try {
    await t.session.start();
    await until(() => t.report().resumes.length === 1, "session/resume");
    const params = t.report().resumes[0];
    assert.equal(params?.sessionId, "old");
    assert.equal(params?.permissionProfile, ":ask-me", "omitting it would restore the session's previous authority");
    assert.equal(params?.history, "inline");
    assert.equal(t.report().startAttempts.length, 0, "a resume is not a new session");
    const history = t.events.find((e) => e.type === "history");
    assert.ok(history && history.type === "history");
    assert.equal(history.source, "resume");
    assert.deepEqual(history.events.map((e) => e.type), ["userMessage", "toolCall", "assistantCompleted"]);
    assert.equal(history.note, undefined);
    const info = t.events.find((e) => e.type === "session");
    assert.equal(info?.type === "session" && info.sessionId, "old");
  } finally {
    await t.done();
  }
});

test("resume in a read-only chat keeps the host-level tool limits", async () => {
  const t = run({ profile: ":read-only", resumeSessionId: "old" });
  try {
    await t.session.start();
    await until(() => t.report().argv.length > 0, "argv");
    assert.ok(t.report().argv.includes("--disable-shell") && t.report().argv.includes("--disable-write"));
    assert.equal(t.report().resumes[0]?.permissionProfile, ":read-only");
  } finally {
    await t.done();
  }
});

test("a session that is not served inline is continued, with a note instead of a guessed history", async () => {
  const t = run({ resumeSessionId: "old", env: { FAKE_MUSE_HISTORY: "snapshot" } });
  try {
    await t.session.start();
    const history = t.events.find((e) => e.type === "history");
    assert.ok(history && history.type === "history");
    assert.equal(history.mode, "snapshot");
    assert.deepEqual(history.events, []);
    assert.match(history.note ?? "", /not shown here/);
  } finally {
    await t.done();
  }
});

test("a failed last turn is reported when a session is resumed", async () => {
  const t = run({ resumeSessionId: "old", env: { FAKE_MUSE_LASTTURN: "1" } });
  try {
    await t.session.start();
    assert.ok(t.events.some((e) => e.type === "notice" && /ended as "failed": crash/.test(e.text)));
  } finally {
    await t.done();
  }
});

test("fork: no permission profile is sent (the contract has none), the new session is used, and a note says so", async () => {
  const t = run({ forkSessionId: "old" });
  try {
    await t.session.start();
    await until(() => t.report().forks.length === 1, "session/fork");
    const params = t.report().forks[0];
    assert.equal(params?.sessionId, "old");
    assert.equal("permissionProfile" in (params ?? {}), false);
    assert.equal(t.report().resumes.length, 0);
    const history = t.events.find((e) => e.type === "history");
    assert.ok(history && history.type === "history");
    assert.equal(history.source, "fork");
    assert.match(history.note ?? "", /This is a fork/);
    assert.equal(t.events.find((e) => e.type === "session")?.type === "session" && (t.events.find((e) => e.type === "session") as { sessionId?: string }).sessionId, "s-fork");
  } finally {
    await t.done();
  }
});
