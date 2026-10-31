// The approval mapper against REAL payloads, observed from Muse 1.4.14 with scripts/probe-approval.ts
// (a network fetch and a shell command under :ask-me, both denied). The fixture is sanitized: ids are
// placeholders and the user name and temp-folder name are removed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mapApprovalRequest, mapNotification } from "../../src/muse/events.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/real-approvals.json", import.meta.url), "utf8")) as {
  request: { network: Record<string, unknown>; shell: Record<string, unknown> };
  notificationOfNetwork: Record<string, unknown>;
  resolvedAbort: Record<string, unknown>;
};

test("real network approval: subject, tool name and the four offered choices", () => {
  const e = mapApprovalRequest(fixture.request.network);
  assert.ok(e && e.type === "approvalRequested");
  assert.equal(e.subject.kind, "network");
  assert.equal(e.subject.summary, "example.com:443 (https)");
  assert.equal(e.subject.generic, false);
  assert.equal(e.toolName, "network");
  assert.deepEqual(e.choices.map((c) => [c.choiceId, c.decision, c.scope]), [
    ["allow_once", "approved", "once"],
    ["allow_session", "approvedForSession", "session"],
    ["allow_local_network", "approvedPolicyAmendment", "localPersistent"],
    ["abort", "abort", "once"],
  ]);
  assert.equal(e.choices[1]?.rulePreview, "example.com:443 (https)", "the session grant shows what it would allow");
  assert.equal(e.choices[2]?.rulePreview, "example.com:443 (https)");
  assert.equal(e.choices[0]?.rulePreview, undefined);
});

test("real approvals: 'Reject' is the decision `abort`, takes feedback, and the persistent choice is the broad one", () => {
  const e = mapApprovalRequest(fixture.request.network);
  assert.ok(e && e.type === "approvalRequested");
  const reject = e.choices.find((c) => c.label === "Reject");
  assert.equal(reject?.decision, "abort");
  assert.equal(reject?.acceptsFeedback, true);
  assert.equal(e.choices.filter((c) => c.scope === "localPersistent").length, 1);
  assert.ok(e.choices.filter((c) => /^approved/.test(c.decision)).every((c) => !c.acceptsFeedback));
});

test("real approvals: the requirement id is passed back exactly as sent", () => {
  const req = fixture.request.network;
  const e = mapApprovalRequest(req);
  assert.ok(e && e.type === "approvalRequested");
  assert.equal(e.requirementId, req.currentRequirementId, "the very same object");
  assert.deepEqual(e.requirementId, { approvalId: e.approvalId, sourceIndex: 0 });
});

test("real shell approval: the command is the summary, the extended-length prefix is hidden, only two choices", () => {
  const e = mapApprovalRequest(fixture.request.shell);
  assert.ok(e && e.type === "approvalRequested");
  assert.equal(e.subject.kind, "shell");
  assert.match(e.subject.summary, /^\(Invoke-WebRequest -Uri 'https:\/\/example\.com'/);
  assert.equal(e.toolName, "powershell");
  assert.deepEqual(e.subject.detail.length, 1, "stages was empty, so only the folder line");
  assert.match(e.subject.detail[0] ?? "", /^in C:\\Users\\USER\\/);
  assert.equal((e.subject.detail[0] ?? "").includes("\\\\?\\"), false, "no extended-length prefix shown to the user");
  assert.deepEqual(e.choices.map((c) => c.choiceId), ["allow_once", "abort"], "a shell command cannot be allowed for the session or forever");
});

test("real approvals: neither flag is set, so no warning banners", () => {
  for (const req of [fixture.request.network, fixture.request.shell]) {
    const e = mapApprovalRequest(req);
    assert.ok(e && e.type === "approvalRequested");
    assert.equal(e.protectedWrite, false);
    assert.equal(e.judgeEscalated, false);
  }
});

test("the host also broadcasts approval/requested with the same content; both map to the same approval id", () => {
  const viaNotification = mapNotification("approval/requested", fixture.notificationOfNetwork);
  const viaRequest = mapApprovalRequest(fixture.request.network);
  assert.ok(viaNotification?.type === "approvalRequested" && viaRequest?.type === "approvalRequested");
  assert.equal(viaNotification.approvalId, viaRequest.approvalId, "the UI deduplicates by this id");
});

test("real approval/resolved: a rejection by the user", () => {
  const e = mapNotification("approval/resolved", fixture.resolvedAbort);
  assert.deepEqual(e, { type: "approvalResolved", approvalId: fixture.request.network.approvalId, decision: "abort", resolvedBy: "user", policyResult: "deny" });
});
