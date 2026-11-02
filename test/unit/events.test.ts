// Unit tests for the event mapper. Shapes marked "observed" come from real Muse 1.4.14 probes;
// approval shapes come from the exported schema (no real approval request has been seen yet).
import assert from "node:assert/strict";
import { test } from "node:test";
import { failureHint, mapApprovalRequest, mapCua, mapNotification, sandboxNote, shellOutputText, subjectView, summarizeArgs, toolArgLines } from "../../src/muse/events.ts";

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

// Shape from the exported schema (ItemKind "reasoning": `summary` is one string per part, streamed as item/delta field "summary.n").
test("reasoning items and their summary deltas become reasoning events", () => {
  assert.deepEqual(mapNotification("item/started", { item: { itemId: "r1", kind: "reasoning" } }), { type: "reasoning", itemId: "r1", parts: [], status: "started" });
  assert.deepEqual(mapNotification("item/delta", { itemId: "r1", field: "summary.1", delta: "so " }), { type: "reasoningDelta", itemId: "r1", part: 1, delta: "so " });
  assert.deepEqual(mapNotification("item/completed", { item: { itemId: "r1", kind: "reasoning", summary: ["a", "b"] } }), { type: "reasoning", itemId: "r1", parts: ["a", "b"], status: "completed" });
  assert.equal(mapNotification("item/delta", { itemId: "r1", field: "output", delta: "x" }), undefined);
});

test("tool call (observed shape): started, held for a hook", () => {
  const e = mapNotification("item/started", { item: { itemId: "i1", kind: "toolCall", tool: "powershell", callId: "c", args: '{"command":"echo antares","description":"Echo antares"}', held: true, heldFor: "hook", status: "inProgress" } });
  assert.deepEqual(e, { type: "toolCall", itemId: "i1", tool: "powershell", summary: "echo antares", status: "inProgress", held: true, heldFor: "hook", failure: undefined, hint: undefined, output: undefined });
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

test("failure hints: the sandbox failure seen on the real host gets the fix, per platform", () => {
  const seen = "environment failure: sandbox enforcement unavailable: windows_elevated setup_required: windows elevated sandbox setup has not run";
  const win = failureHint(seen, "win32");
  assert.match(win ?? "", /shell commands fail before they start/);
  assert.match(win ?? "", /muse sandbox windows setup/);
  assert.match(win ?? "", /Antares never runs it/);
  const other = failureHint(seen, "linux");
  assert.doesNotMatch(other ?? "", /muse sandbox windows setup/);
  assert.match(other ?? "", /documentation/);
  assert.match(failureHint("approval aborted", "win32") ?? "", /rejected/);
  assert.equal(failureHint("tool failed: file not found", "win32"), undefined);
  assert.equal(failureHint(undefined), undefined);
});

test("failure hints: the tool card carries the hint only when there is a failure it recognizes", () => {
  const failed = mapNotification("item/completed", { item: { itemId: "i2", kind: "toolCall", tool: "powershell", args: '{"command":"git status"}', status: "failed", failureReason: "environment failure: sandbox enforcement unavailable: windows_elevated setup_required" } });
  assert.equal(failed?.type, "toolCall");
  if (failed?.type === "toolCall") assert.match(failed.hint ?? "", /sandbox is not available/);
  const rejected = mapNotification("item/completed", { item: { itemId: "i3", kind: "toolCall", tool: "powershell", args: '{"command":"git status"}', status: "rejected", failureReason: "approval aborted" } });
  if (rejected?.type === "toolCall") assert.match(rejected.hint ?? "", /you chose Reject/);
  const fine = mapNotification("item/completed", { item: { itemId: "i4", kind: "toolCall", tool: "read_file", args: '{"path":"a"}', status: "completed", visibleOutput: "x" } });
  if (fine?.type === "toolCall") assert.equal(fine.hint, undefined);
});

test("sandbox note: only when the host says it cannot enforce a sandbox", () => {
  assert.equal(sandboxNote("available", "win32"), undefined);
  assert.equal(sandboxNote(undefined, "win32"), undefined, "no claim when the host did not say");
  assert.match(sandboxNote("unavailable", "win32") ?? "", /muse sandbox windows setup/);
  assert.doesNotMatch(sandboxNote("unavailable", "darwin") ?? "", /windows/);
});

test("computer use: the card is worded as the contract says, with the page, the window and masked data", () => {
  const cua = mapCua({
    page: { host: "bücher.example", hostAscii: "xn--bcher-kva.example" },
    windowTitle: "Checkout <img src=x onerror=alert(1)>",
    steps: [
      { step: 1, action: "click", roleWord: "button", label: "Pay now", effect: "may place an order", kind: "verb:commit" },
      { step: 2, action: "press", roleWord: "key", chord: "Ctrl+Enter", effect: "may submit the form", kind: "verb:key" },
      { step: 3, action: "click", effect: "may do something", kind: "unlabeled", point: { x: 120, y: 340 } },
      { step: 4, action: "type into", effect: "types text" },
      { action: "broken" },
    ],
    data: [
      { kind: "secret", secretKind: "github_token", mask: { prefix: "ghp_", last4: "3f9a" } },
      { kind: "secret", secretKind: "secret_named_value", mask: { prefix: "password=", chars: 12 } },
      { kind: "secret", mask: { chars: 40 } },
      { kind: "other" },
    ],
  });
  assert.deepEqual(cua?.page, { host: "bücher.example", hostAscii: "xn--bcher-kva.example", idn: true });
  assert.equal(cua?.windowTitle, "Checkout <img src=x onerror=alert(1)>", "kept as plain text for the page to show as text");
  assert.deepEqual(cua?.steps, [
    'Step 1: click button "Pay now" — may place an order',
    'Step 2: press key "Ctrl+Enter" — may submit the form',
    "Step 3: click at 120,340 — may do something",
    "Step 4: type into — types text",
  ]);
  assert.deepEqual(cua?.data, ["a GitHub token: ghp_…3f9a", "a named secret value: password=… (12 chars)", "a secret: (40 chars)", "some other data the host could not describe"]);
});

test("computer use: a plain-ASCII host is not flagged, and a request without facts has no card", () => {
  assert.equal(mapCua({ page: { host: "example.com", hostAscii: "example.com" }, steps: [] })?.page?.idn, false);
  assert.equal(mapCua(undefined), undefined);
  assert.equal(mapCua("x"), undefined);
  const base = { approvalId: "ap", itemId: "i", toolName: "browser", rawArgs: "{}", currentRequirementId: { approvalId: "ap", sourceIndex: 0 }, subject: { kind: "tool", toolName: "browser" }, availableChoices: [{ choiceId: "c", label: "Allow once", decision: "approved", scope: "once" }] };
  const without = mapApprovalRequest(base);
  assert.equal(without?.type === "approvalRequested" && "cua" in without, false);
  const withFacts = mapApprovalRequest({ ...base, cuaCardFacts: { steps: [{ action: "click", effect: "may act" }] } });
  assert.equal(withFacts?.type === "approvalRequested" ? withFacts.cua?.steps[0] : undefined, "Step 1: click — may act");
});

test("tool approvals: the arguments read as name: value lines (a browser tool's url, selector or text)", () => {
  assert.deepEqual(toolArgLines('{"url":"https://example.com/a","newTab":true,"opts":{"x":1}}'), ["url: https://example.com/a", "newTab: true", 'opts: {"x":1}']);
  assert.deepEqual(toolArgLines("not json at all"), ["not json at all"]);
  assert.deepEqual(toolArgLines(""), []);
  const many = toolArgLines(JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]))));
  assert.equal(many.length, 9);
  assert.equal(many[8], "… and 3 more");
  const subject = subjectView({ kind: "tool", toolName: "browser_navigate" }, "browser_navigate", '{"url":"https://example.com"}');
  assert.equal(subject.summary, "browser_navigate");
  assert.deepEqual(subject.detail, ["url: https://example.com"]);
});

test("sandbox failure: the tool call offers the switch to Bypass, and says what Bypass is", () => {
  const e = mapNotification("item/completed", { item: { itemId: "s", kind: "toolCall", tool: "powershell", args: '{"command":"git status"}', status: "failed", failureReason: "environment failure: sandbox enforcement unavailable: windows_elevated setup_required" } });
  assert.equal(e?.type, "toolCall");
  if (e?.type === "toolCall") {
    assert.equal(e.hintAction, "bypass");
    assert.match(e.hint ?? "", /switch the mode to Bypass permissions/);
    assert.match(e.hint ?? "", /no sandbox and no approval prompts/);
  }
  const other = mapNotification("item/completed", { item: { itemId: "o", kind: "toolCall", tool: "powershell", args: '{"command":"x"}', status: "failed", failureReason: "exit code 1" } });
  if (other?.type === "toolCall") assert.equal("hintAction" in other, false, "no offer for an ordinary failure");
  assert.match(sandboxNote("unavailable", "win32") ?? "", /Bypass permissions/);
});

test("shell output: a failed command keeps its own output, shown as text with the exit code", () => {
  const record = (extra: object) => JSON.stringify({ chunk_id: "exec-1-1", command: "python -m unittest", description: "tests", exit_code: 1, terminal_status: "completed", output: "FAIL: test_a\r\nAssertionError\r\n", original_output_bytes: 30, truncated: false, ...extra });
  assert.equal(shellOutputText(record({})), "exit code 1\nFAIL: test_a\nAssertionError");
  assert.equal(shellOutputText(record({ exit_code: 0, output: "ok\r\n" })), "ok", "no exit-code line for a success");
  assert.equal(shellOutputText(record({ truncated: true })), "exit code 1\nFAIL: test_a\nAssertionError\n[the host cut the output here]");
  assert.equal(shellOutputText(record({ output: "" })), "exit code 1, no output");
  assert.equal(shellOutputText("plain text"), "plain text", "another shape is shown as it came");
  const e = mapNotification("item/completed", { item: { itemId: "p", kind: "toolCall", tool: "powershell", args: '{"command":"python -m unittest"}', status: "failed", failureReason: "process exited with status 1", visibleOutput: record({}) } });
  assert.equal(e?.type, "toolCall");
  if (e?.type === "toolCall") {
    assert.equal(e.failure, "process exited with status 1");
    assert.equal(e.output, "exit code 1\nFAIL: test_a\nAssertionError");
  }
});
