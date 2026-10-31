// The composer's "+" menu: pure helpers, then the session against the fake host (test/fixtures/fake-muse.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendMentions, canonicalPath, filterSkills, imageTypeFor, mapMcpServers, mapPlugins, mapSkills, mentionFor, parseSlash, rootsFor } from "../../src/muse/composer.ts";
import type { ChatEvent } from "../../src/muse/events.ts";
import { mapNotification } from "../../src/muse/events.ts";
import { buildInputParts } from "../../src/muse/images.ts";
import { MuseSession } from "../../src/muse/session.ts";
import { readReport } from "../fixtures/report.ts";

const skills = mapSkills({
  skills: [
    { selector: "plan", displayName: "plan", description: "Write a plan.", source: "bundled" },
    { selector: "fix-bug", displayName: "fix-bug", title: "Fix a bug", description: "Reproduce and fix.", source: "user", argumentHint: "<issue>" },
    { selector: "acme:deploy", displayName: "deploy", description: "Deploy.", source: "plugin", pluginId: "acme" },
    { displayName: "no selector", description: "dropped", source: "user" },
  ],
});

test("skills: rows without a selector are dropped, the rest sorted, the declared title preferred", () => {
  assert.deepEqual(skills.map((s) => s.selector), ["acme:deploy", "fix-bug", "plan"]);
  assert.equal(skills.find((s) => s.selector === "fix-bug")?.displayName, "Fix a bug");
  assert.equal(skills.find((s) => s.selector === "fix-bug")?.argumentHint, "<issue>");
  assert.deepEqual(mapSkills(undefined), []);
  assert.deepEqual(mapSkills({ skills: "nope" }), []);
});

test("slash: only a skill the host listed becomes a skill part; anything else stays text", () => {
  assert.deepEqual(parseSlash("/plan", skills), { selector: "plan", source: "bundled" });
  assert.deepEqual(parseSlash("  /fix-bug  the build is red\nsecond line ", skills), { selector: "fix-bug", source: "user", arguments: "the build is red\nsecond line" });
  assert.deepEqual(parseSlash("/acme:deploy staging", skills), { selector: "acme:deploy", source: "plugin", arguments: "staging" });
  assert.equal(parseSlash("/unknown thing", skills), undefined, "an unknown selector is plain text");
  assert.equal(parseSlash("/usr/bin/env", skills), undefined, "a path is plain text");
  assert.equal(parseSlash("please /plan this", skills), undefined, "the slash must start the message");
  assert.equal(parseSlash("/plan", []), undefined, "no list, no skill");
});

test("slash: the palette filter lists prefix matches first, then other matches", () => {
  assert.deepEqual(filterSkills(skills, "").map((s) => s.selector), ["acme:deploy", "fix-bug", "plan"]);
  assert.deepEqual(filterSkills(skills, "fi").map((s) => s.selector), ["fix-bug"]);
  assert.deepEqual(filterSkills(skills, "reproduce").map((s) => s.selector), ["fix-bug"], "the description matches too");
  assert.deepEqual(filterSkills(skills, "zzz"), []);
});

test("input parts: a skill invocation replaces the text, images still follow", () => {
  const image = { mediaType: "image/png", base64Data: "AAAA" };
  assert.deepEqual(buildInputParts("/fix-bug red", [], { selector: "fix-bug", source: "user", arguments: "red" }), [{ type: "skill", selector: "fix-bug", source: "user", arguments: "red" }]);
  assert.deepEqual(buildInputParts("/plan", [image], { selector: "plan" }), [{ type: "skill", selector: "plan" }, { type: "image", ...image }]);
  assert.deepEqual(buildInputParts("hello", [], undefined), [{ type: "text", text: "hello" }]);
});

test("mentions: a file inside a root becomes @relative/path; outside, none", () => {
  const root = join(tmpdir(), "ws");
  const extra = join(tmpdir(), "shared");
  assert.equal(mentionFor(join(root, "src", "a.ts"), [root]), "@src/a.ts");
  assert.equal(mentionFor(join(extra, "lib", "b.ts"), [root, extra]), "@lib/b.ts", "an added folder counts as a root");
  assert.equal(mentionFor(join(root, "docs", "my notes.md"), [root]), '@"docs/my notes.md"', "spaces are quoted");
  assert.equal(mentionFor(join(tmpdir(), "elsewhere", "c.ts"), [root]), undefined);
  assert.equal(mentionFor(root, [root]), undefined, "the root itself is not a file");
  assert.equal(mentionFor(join(tmpdir(), "ws-sibling", "d.ts"), [root]), undefined, "a sibling that shares a name prefix is outside");
});

test("mentions: appended once, with a space between", () => {
  assert.equal(appendMentions("", ["@a"]), "@a ");
  assert.equal(appendMentions("look at", ["@a", "@b"]), "look at @a @b ");
  assert.equal(appendMentions("look at @a ", ["@a", "@b"]), "look at @a @b ");
  assert.equal(appendMentions("x", []), "x");
});

test("images: the media type comes from the extension, case-insensitively", () => {
  assert.equal(imageTypeFor("a.PNG"), "image/png");
  assert.equal(imageTypeFor("a.jpeg"), "image/jpeg");
  assert.equal(imageTypeFor("a.webp"), "image/webp");
  assert.equal(imageTypeFor("a.svg"), undefined);
  assert.equal(imageTypeFor("noext"), undefined);
});

test("roots: the chat's own folder first, extras after, no duplicates", () => {
  assert.deepEqual(rootsFor("/ws", ["/a", "/ws", "/b"]), ["/ws", "/a", "/b"]);
  assert.deepEqual(rootsFor("/ws", []), ["/ws"]);
});

test("roots: the host wants canonical paths (long names, extended-length prefix on Windows)", () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-canon-"));
  try {
    const canonical = canonicalPath(dir);
    if (process.platform === "win32") {
      assert.ok(canonical.startsWith("\\\\?\\"), canonical);
      assert.ok(!canonical.includes("~"), "8.3 short names are expanded");
      assert.equal(canonicalPath(canonical), canonical, "already canonical stays as it is");
    } else {
      assert.ok(canonical.startsWith("/"));
    }
    const missing = join(dir, "does-not-exist");
    assert.equal(canonicalPath(missing), missing, "a missing path is returned unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugins and connectors: rows are mapped defensively", () => {
  assert.deepEqual(mapPlugins({ plugins: [{ id: "b", version: "1", enabled: false, source: "curated" }, { id: "a", enabled: true, source: "nativeLocal" }, { nope: 1 }] }), [
    { id: "a", version: "", enabled: true, source: "nativeLocal" },
    { id: "b", version: "1", enabled: false, source: "curated" },
  ]);
  assert.deepEqual(mapMcpServers({ servers: [{ name: "gh", source: "settings", transport: "streamableHttp", oauth: "loggedOut" }, { transport: "stdio" }] }), [{ name: "gh", source: "settings", transport: "streamableHttp", oauth: "loggedOut" }]);
  assert.deepEqual(mapMcpServers(null), []);
});

test("events: the host's turn/unqueued notification becomes an unqueued event", () => {
  assert.deepEqual(mapNotification("turn/unqueued", { turnId: "tq1", sessionId: "s1" }), { type: "unqueued", turnId: "tq1" });
  assert.equal(mapNotification("turn/unqueued", { sessionId: "s1" }), undefined);
});

// ---- the session against the fake host ----

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function run(profile = ":ask-me") {
  const dir = mkdtempSync(join(tmpdir(), "antares-composer-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({ binary: process.execPath, binaryArgs: [fake], workspaceRoot: dir, profile, env: { ...process.env, FAKE_MUSE_REPORT: reportPath } });
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

test("session: skills and plugins are read from the host for the session", async () => {
  const t = run();
  try {
    const list = await t.session.listSkills();
    assert.deepEqual(list.map((s) => s.selector), ["acme:deploy", "fix-bug", "plan"]);
    assert.equal(t.report().skillLists[0]?.sessionId, "s1");
    const plugins = await t.session.listPlugins();
    assert.deepEqual(plugins, [{ id: "acme", version: "1.2.0", enabled: true, source: "marketplaceUserAdded" }]);
  } finally {
    await t.done();
  }
});

test("session: a typed /skill goes as a skill part (the list is read first), plain text otherwise", async () => {
  const t = run();
  try {
    await t.session.send("/fix-bug the build is red");
    await until(() => t.report().turnStarts.length === 1, "turn/start");
    assert.deepEqual(t.report().turnStarts[0]?.input, [{ type: "skill", selector: "fix-bug", source: "user", arguments: "the build is red" }]);
    assert.equal(t.report().skillLists.length, 1, "the skill list is read once");
    await t.session.interrupt();
    await until(() => t.events.some((e) => e.type === "turnCompleted"), "turnCompleted");

    await t.session.send("/not-a-skill hello");
    await until(() => t.report().turnStarts.length === 2, "second turn/start");
    assert.deepEqual(t.report().turnStarts[1]?.input, [{ type: "text", text: "/not-a-skill hello" }]);
    assert.equal(t.report().skillLists.length, 1, "no second read");
  } finally {
    await t.done();
  }
});

test("session: a message sent while a turn runs is steered or queued, and the host's answer is announced", async () => {
  const t = run();
  try {
    await t.session.send("first");
    await until(() => t.events.some((e) => e.type === "approvalRequested"), "the first turn to be running");
    await t.session.send("and also this", [], { ifBusy: "steer" });
    await t.session.send("later", [], { ifBusy: "queue" });
    const starts = t.report().turnStarts;
    assert.equal(starts[0]?.ifBusy, undefined, "an idle send leaves ifBusy out");
    assert.equal(starts[1]?.ifBusy, "steer");
    assert.equal(starts[2]?.ifBusy, "queue");
    const submitted = t.events.filter((e): e is Extract<ChatEvent, { type: "submitted" }> => e.type === "submitted");
    assert.deepEqual(submitted.map((e) => [e.disposition, e.text]), [["started", "first"], ["steered", "and also this"], ["queued", "later"]]);
    const queued = submitted[2]!;
    assert.match(queued.turnId, /^tq/);

    await t.session.unqueue(queued.turnId);
    assert.equal(t.report().unqueues[0]?.turnId, queued.turnId);
    assert.equal(t.report().unqueues[0]?.sessionId, "s1");
    await until(() => t.events.some((e) => e.type === "unqueued" && e.turnId === queued.turnId), "the unqueued event");
  } finally {
    await t.done();
  }
});

test("session: added folders are sent as the whole sticky root set, once, with the chat's own folder first", async () => {
  const t = run();
  try {
    t.session.setExtraRoots(["/added/one"]);
    await t.session.send("go");
    await until(() => t.report().turnStarts.length === 1, "turn/start");
    assert.deepEqual(t.report().turnStarts[0]?.workspaceRoots, [canonicalPath(t.dir), "/added/one"], "canonical paths (the host refuses the short 8.3 form); a path that does not exist is left alone");
    await t.session.interrupt();
    await until(() => t.events.some((e) => e.type === "turnCompleted"), "turnCompleted");

    await t.session.send("again");
    await until(() => t.report().turnStarts.length === 2, "second turn/start");
    assert.equal(t.report().turnStarts[1]?.workspaceRoots, undefined, "the host keeps the set; it is not re-sent");
    await t.session.interrupt();
    await until(() => t.events.filter((e) => e.type === "turnCompleted").length === 2, "second turnCompleted");

    t.session.setExtraRoots([]);
    await t.session.send("alone again");
    await until(() => t.report().turnStarts.length === 3, "third turn/start");
    assert.deepEqual(t.report().turnStarts[2]?.workspaceRoots, [canonicalPath(t.dir)], "removing the folder replaces the set");
  } finally {
    await t.done();
  }
});
