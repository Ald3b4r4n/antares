// Unit tests for the event mapper. Shapes marked "observed" come from real Muse 1.4.14 probes;
// approval shapes come from the exported schema (no real approval request has been seen yet).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapApprovalRequest, mapNotification, subjectView, summarizeArgs } from "../../src/muse/events.ts";

const requirementId = { approvalId: "ap-1", sourceIndex: 2 };
const base = {
  approvalId: "ap-1",
  itemId: "tool-1",
  toolName: "powershell",
  rawArgs: '{"command":"ls"}',
  currentRequirementId: requirementId,
  availableChoices: [
    { choiceId: "c1", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "c2", label: "Deny", decision: "denied", scope: "once", acceptsFeedback: true, rulePreview: "deny x" },
  ],
  subject: { kind: "shell", command: "ls -la", stages: ["ls -la"], workspaceRoot: "C:\\w" },
};

test("tool call (observed shape): started, held for a hook", () => {
  const e = mapNotification("item/started", { item: { itemId: "i1", kind: "toolCall", tool: "powershell", callId: "c", args: '{"command":"echo antares","description":"Echo antares"}', held: true, heldFor: "hook", status: "inProgress" } });
  assert.deepEqual(e, { type: "toolCall", itemId: "i1", tool: "powershell", summary: "echo antares", status: "inProgress", held: true, heldFor: "hook", failure: undefined, output: undefined });
});

test("tool call (observed shape): failed closed keeps the failure and drops output", () => {
  const e = mapNotification("item/completed", { item: { itemId: "i1", kind: "toolCall", tool: "powershell", args: '{"command":"echo antares"}', status: "failed", failureReason: "environment failure: sandbox enforcement unavailable", visibleOutput: "tool failed: environment failure" } });
  assert.equal(e?.type, "toolCall");
  if (e?.type === "toolCall") {
    assert.equal(e.status, "failed");
    assert.match(e.failure ?? "", /sandbox enforcement unavailable/);
    assert.equal(e.output, undefined);
  }
});

test("tool call (observed shape): completed write_file shows its output", () => {
  const e = mapNotification("item/completed", { item: { itemId: "i2", kind: "toolCall", tool: "write_file", args: '{"path":"antares-note.txt","content":"hello"}', status: "completed", visibleOutput: "wrote 5 bytes" } });
  assert.equal(e?.type === "toolCall" && e.summary, "antares-note.txt");
  assert.equal(e?.type === "toolCall" && e.output, "wrote 5 bytes");
});

test("item/updated for a tool call maps; for other kinds it does not", () => {
  assert.equal(mapNotification("item/updated", { item: { itemId: "i", kind: "toolCall", args: "{}" } })?.type, "toolCall");
  assert.equal(mapNotification("item/updated", { item: { itemId: "i", kind: "agentMessage" } }), undefined);
});

test("approval request: choices mapped, requirementId passed through unchanged (same object)", () => {
  const e = mapApprovalRequest(base);
  assert.equal(e?.type, "approvalRequested");
  if (e?.type !== "approvalRequested") return;
  assert.equal(e.requirementId, requirementId, "must be the very value the host sent");
  assert.deepEqual(e.choices.map((c) => [c.choiceId, c.decision, c.acceptsFeedback]), [["c1", "approved", false], ["c2", "denied", true]]);
  assert.equal(e.choices[1]?.rulePreview, "deny x");
  assert.equal(e.subject.summary, "ls -la");
  assert.equal(e.subject.generic, false);
});

test("approval request: invalid or empty requests are rejected, never guessed", () => {
  assert.equal(mapApprovalRequest(null), undefined);
  assert.equal(mapApprovalRequest({ approvalId: "a" }), undefined);
  assert.equal(mapApprovalRequest({ ...base, availableChoices: [] }), undefined);
  assert.equal(mapApprovalRequest({ ...base, availableChoices: [{ nope: true }] }), undefined);
  assert.equal(mapApprovalRequest({ ...base, currentRequirementId: undefined }), undefined);
});

test("approval request: flags for protected writes and judge escalation", () => {
  const e = mapApprovalRequest({ ...base, protectedWrite: true, judgeEscalated: true, reviewerReason: "touches .git" });
  assert.equal(e?.type === "approvalRequested" && e.protectedWrite, true);
  assert.equal(e?.type === "approvalRequested" && e.judgeEscalated, true);
  assert.equal(e?.type === "approvalRequested" && e.reviewerReason, "touches .git");
});

test("approval/requested notification maps like the request; resolved maps", () => {
  assert.equal(mapNotification("approval/requested", base)?.type, "approvalRequested");
  const r = mapNotification("approval/resolved", { approvalId: "ap-1", decision: "denied", policyResult: "deny", resolvedBy: "user" });
  assert.deepEqual(r, { type: "approvalResolved", approvalId: "ap-1", decision: "denied", resolvedBy: "user", policyResult: "deny" });
});

test("subjects: every known kind has a one-line summary; unknown kinds are generic", () => {
  assert.equal(subjectView({ kind: "fileAccess", access: "write", path: "src/a.ts" }, "write_file", "").summary, "write src/a.ts");
  assert.equal(subjectView({ kind: "network", host: "example.com", port: 443, protocol: "https" }, "web", "").summary, "example.com:443 (https)");
  assert.equal(subjectView({ kind: "network", host: "example.com" }, "web", "").summary, "example.com");
  assert.equal(subjectView({ kind: "unixSocket", path: "/tmp/s.sock" }, "t", "").summary, "/tmp/s.sock");
  assert.equal(subjectView({ kind: "process", target: "pid 4" }, "t", "").summary, "control pid 4");
  assert.equal(subjectView({ kind: "tool", toolName: "mcp__x" }, "mcp__x", "{}").summary, "mcp__x");
  const stages = subjectView({ kind: "shell", command: "a | b", stages: ["a", { command: "b" }] }, "ps", "");
  assert.deepEqual(stages.detail, ["stage 1: a", "stage 2: b"]);
  const unknown = subjectView({ kind: "teleport" }, "mystery", '{"to":"x"}');
  assert.equal(unknown.generic, true);
  assert.match(unknown.detail.join(" "), /teleport/);
});

test("summarizeArgs: JSON string, object, plain text, truncation", () => {
  assert.equal(summarizeArgs('{"command":"ls"}'), "ls");
  assert.equal(summarizeArgs({ path: "a.txt" }), "a.txt");
  assert.equal(summarizeArgs("not json"), "not json");
  assert.equal(summarizeArgs(`{"command":"${"x".repeat(500)}"}`).length, 201);
});

test("turn failure (observed shape): authRequired", () => {
  const e = mapNotification("turn/completed", { turnId: "t", terminal: "failed", reason: "not logged in", durationMs: 99, error: { kind: "authRequired", message: "not logged in: run /login to add an API key", retryable: false } });
  assert.equal(e?.type === "turnCompleted" && e.errorKind, "authRequired");
});
