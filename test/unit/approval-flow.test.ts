// Approval handling that only the REAL host exposed: it announces every approval twice (the request it
// wants a receipt for, plus an `approval/requested` notification), and re-sends the request with the same
// approval id for each later stage of a multi-stage approval. Behavior is checked on MuseSession against
// the fake host, which now mimics both.
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

function run(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-flow-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({ binary: process.execPath, binaryArgs: [fake], workspaceRoot: dir, profile: ":ask-me", env: { ...process.env, FAKE_MUSE_REPORT: reportPath, ...env } });
  const events: ChatEvent[] = [];
  session.on("event", (e: ChatEvent) => events.push(e));
  const requested = () => events.filter((e): e is Extract<ChatEvent, { type: "approvalRequested" }> => e.type === "approvalRequested");
  return {
    session,
    events,
    requested,
    report: () => readReport(reportPath),
    done: async () => {
      await session.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const order of ["request-first", "notification-first"]) {
  test(`an approval announced twice (${order}) is shown once, and the request still gets its receipt`, async () => {
    const t = run({ FAKE_MUSE_ORDER: order });
    try {
      await t.session.send("go");
      await until(() => t.report().receipts.length === 1, "the receipt");
      await new Promise((r) => setTimeout(r, 300)); // let the second announcement arrive too
      assert.equal(t.requested().length, 1, "one approvalRequested event, not two");
      assert.deepEqual(t.report().receipts, [{}]);
      const req = t.requested()[0];
      assert.ok(req);
      // Deciding once works; there is no second event to decide on.
      await t.session.decide(req.approvalId, "c-deny", req.requirementId);
      await until(() => t.events.some((e) => e.type === "turnCompleted"), "turnCompleted");
      assert.equal(t.report().decides.length, 1);
    } finally {
      await t.done();
    }
  });
}

test("a multi-stage approval shows each stage once: the same approval id with a new requirement is a new card", async () => {
  const t = run({ FAKE_MUSE_MODE: "two-stage" });
  try {
    await t.session.send("go");
    await until(() => t.requested().length === 1, "stage 0");
    const first = t.requested()[0];
    assert.ok(first);
    assert.deepEqual(first.requirementId, { approvalId: "ap-1", sourceIndex: 0 });

    await t.session.decide(first.approvalId, "c-once", first.requirementId);
    await until(() => t.requested().length === 2, "stage 1");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.requested().length, 2, "stage 1 appears once, although the host announced it as a request only");
    const second = t.requested()[1];
    assert.ok(second);
    assert.equal(second.approvalId, first.approvalId, "same approval id");
    assert.deepEqual(second.requirementId, { approvalId: "ap-1", sourceIndex: 1 }, "but a new requirement, which the decision must name");
    assert.equal(second.subject.summary, "second stage");

    await t.session.decide(second.approvalId, "c-once", second.requirementId);
    await until(() => t.events.some((e) => e.type === "turnCompleted"), "turnCompleted");
    const decides = t.report().decides;
    assert.deepEqual(decides.map((d) => (d.requirementId as { sourceIndex: number }).sourceIndex), [0, 1], "each decision named its own stage");
    assert.equal(t.report().receipts.length, 2, "both requests were answered with a receipt");
  } finally {
    await t.done();
  }
});

test("once resolved, the same approval id can be announced again (a later approval reusing nothing)", async () => {
  const t = run();
  try {
    await t.session.send("go");
    await until(() => t.requested().length === 1, "the approval");
    const req = t.requested()[0];
    assert.ok(req);
    await t.session.decide(req.approvalId, "c-deny", req.requirementId);
    await until(() => t.events.some((e) => e.type === "approvalResolved"), "resolved");
    // A new turn on the same fake issues the same approval id again; it must be shown again.
    await until(() => !t.session.busy, "the turn to end");
    await t.session.send("again");
    await until(() => t.requested().length === 2, "the approval, shown again after it was resolved");
  } finally {
    await t.done();
  }
});
