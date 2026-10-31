// MuseSession against a fake `muse serve` (test/fixtures/fake-muse.mjs). Checks the approval relay:
// the session answers the host's request with a receipt, hands the offered choices to the UI, and
// sends back exactly the user's pick with the host's own requirementId. It never decides by itself.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "../../src/muse/events.ts";
import { MuseSession } from "../../src/muse/session.ts";
import { readReport } from "../fixtures/report.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function run(profile: string, mode?: string) {
  const dir = mkdtempSync(join(tmpdir(), "antares-fake-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({
    binary: process.execPath,
    binaryArgs: [fake],
    workspaceRoot: dir,
    profile,
    env: { ...process.env, FAKE_MUSE_REPORT: reportPath, ...(mode ? { FAKE_MUSE_MODE: mode } : {}) },
  });
  const events: ChatEvent[] = [];
  session.on("event", (e: ChatEvent) => events.push(e));
  const report = () => readReport(reportPath);
  const done = async () => {
    await session.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { session, events, report, done };
}

test("approval relay: receipt, offered choices, and the exact pick sent back", async () => {
  const t = run(":ask-me");
  try {
    await t.session.send("go");
    await until(() => t.events.some((e) => e.type === "approvalRequested"), "approvalRequested");
    const req = t.events.find((e) => e.type === "approvalRequested");
    assert.ok(req && req.type === "approvalRequested");
    // Nothing is decided until the UI says so.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.report().decides.length, 0, "the session must not decide on its own");
    await until(() => t.report().receipts.length === 1, "the presentation receipt to reach the host");
    assert.deepEqual(t.report().receipts, [{}], "the host got a presentation receipt");

    await t.session.decide(req.approvalId, "c-deny", req.requirementId, "not that folder");
    await until(() => t.events.some((e) => e.type === "turnCompleted"), "turnCompleted");
    const decides = t.report().decides;
    assert.equal(decides.length, 1);
    assert.equal(decides[0]?.choiceId, "c-deny");
    assert.equal(decides[0]?.approvalId, "ap-1");
    assert.deepEqual(decides[0]?.requirementId, { approvalId: "ap-1", sourceIndex: 0 });
    assert.equal(decides[0]?.feedback, "not that folder");
    assert.equal(decides[0]?.sessionId, "s1");
    assert.match(String(decides[0]?.commandId), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/, "commandId is a UUIDv7");
    assert.ok(t.events.some((e) => e.type === "approvalResolved" && e.policyResult === "deny"));
  } finally {
    await t.done();
  }
});

test("profile: :ask-me starts without the hard-disable flags; :read-only adds them", async () => {
  const ask = run(":ask-me");
  try {
    await ask.session.start();
    await until(() => ask.report().startParams.permissionProfile !== undefined, "session/start");
    assert.equal(ask.report().startParams.permissionProfile, ":ask-me");
    assert.ok(!ask.report().argv.includes("--disable-shell"));
  } finally {
    await ask.done();
  }
  const ro = run(":read-only");
  try {
    await ro.session.start();
    await until(() => ro.report().startParams.permissionProfile !== undefined, "session/start");
    assert.equal(ro.report().startParams.permissionProfile, ":read-only");
    assert.ok(ro.report().argv.includes("--disable-shell") && ro.report().argv.includes("--disable-write"));
  } finally {
    await ro.done();
  }
});

test("an approval request that cannot be read stops the turn instead of guessing", async () => {
  const t = run(":ask-me", "bad-approval");
  try {
    await t.session.send("go");
    await until(() => t.events.some((e) => e.type === "turnCompleted"), "turnCompleted after interrupt");
    assert.equal(t.report().interrupts, 1);
    assert.equal(t.report().decides.length, 0);
    assert.ok(t.events.some((e) => e.type === "notice" && e.level === "error"));
    assert.ok(!t.events.some((e) => e.type === "approvalRequested"));
  } finally {
    await t.done();
  }
});

test("host event: the sandbox state the host reports is announced as soon as it starts, before any session", async () => {
  const t = run(":ask-me");
  try {
    await t.session.warm();
    const host = t.events.find((e) => e.type === "host");
    assert.ok(host && host.type === "host");
    assert.equal(host.sandbox, "unavailable", "the fake host reports an unavailable sandbox, as the real one does on the test PC");
    assert.match(host.sandboxNote ?? "", /sandbox is not available/);
    assert.equal(t.events.some((e) => e.type === "session"), false, "warming starts no session");
  } finally {
    await t.done();
  }
});
