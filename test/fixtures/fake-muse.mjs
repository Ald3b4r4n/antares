// A stand-in for `muse serve` that speaks just enough MSP to exercise Antares' approval relay.
// It records what it observed to the JSON file named by FAKE_MUSE_REPORT. Test fixture only.
//   FAKE_MUSE_MODE=bad-approval  sends an approval request the client cannot read.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const report = { argv: process.argv.slice(2), startParams: undefined, receipts: [], decides: [], interrupts: 0 };
const flush = () => process.env.FAKE_MUSE_REPORT && writeFileSync(process.env.FAKE_MUSE_REPORT, JSON.stringify(report));
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const mode = process.env.FAKE_MUSE_MODE ?? "normal";

const requirementId = { approvalId: "ap-1", sourceIndex: 0 };
const goodApproval = {
  approvalId: "ap-1",
  itemId: "tool-1",
  sessionId: "s1",
  turnId: "t1",
  taskId: "task-1",
  toolCallId: "call-1",
  toolName: "powershell",
  rawArgs: '{"command":"Remove-Item -Recurse build"}',
  viewCursor: "v4:s1:3",
  sourceRange: {},
  judgeEscalated: false,
  protectedWrite: false,
  currentRequirementId: requirementId,
  subject: { kind: "shell", command: "Remove-Item -Recurse build", stages: ["Remove-Item -Recurse build"], workspaceRoot: "C:\\work" },
  availableChoices: [
    { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once", acceptsFeedback: true },
  ],
};

let srvId = 1000;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id === srvId) {
    report.receipts.push(msg.result);
    flush();
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { serverInfo: { name: "muse", version: "0.0.0-fake" }, schema: { version: 1, fingerprint: "sha256:fake" }, grantedCapabilities: [], experimentalApi: false, sessionDurability: "durable", sandboxAvailability: "unavailable" } });
      break;
    case "session/start":
      report.startParams = msg.params;
      send({ id: msg.id, result: { session: { sessionId: "s1" }, viewCursor: "" } });
      break;
    case "model/list":
      send({ id: msg.id, result: { models: [] } });
      break;
    case "usage/read":
      send({ id: msg.id, result: {} });
      break;
    case "turn/start":
      send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted", turnId: "t1", startedNewTurn: true, disposition: "started" } });
      send({ method: "turn/started", params: { sessionId: "s1", turnId: "t1", commandId: msg.params.commandId, viewCursor: "v4:s1:1", sourceRange: {} } });
      srvId = 1000;
      send({ id: srvId, method: "approval/request", params: mode === "bad-approval" ? { approvalId: "ap-bad" } : goodApproval });
      break;
    case "approval/decide":
      report.decides.push(msg.params);
      send({ id: msg.id, result: { approvalId: msg.params.approvalId, commandId: msg.params.commandId, status: "accepted", terminal: true } });
      send({ method: "approval/resolved", params: { approvalId: msg.params.approvalId, decision: "denied", policyResult: "deny", resolvedBy: "user", itemId: "tool-1", sessionId: "s1", turnId: "t1", stageEvidence: [], sourceRange: {}, viewCursor: "v4:s1:4" } });
      send({ method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "completed", durationMs: 5, viewCursor: "v4:s1:5", sourceRange: {} } });
      break;
    case "turn/interrupt":
      report.interrupts++;
      send({ id: msg.id, result: { status: "accepted" } });
      send({ method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "cancelled", viewCursor: "v4:s1:6", sourceRange: {} } });
      break;
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
  flush();
});
rl.on("close", () => {
  flush();
  process.exit(0);
});
