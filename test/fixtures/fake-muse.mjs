// A stand-in for `muse serve` that speaks just enough MSP to exercise Antares' session logic.
// It appends what it observed, one JSON object per line, to the file named by FAKE_MUSE_REPORT
// (append-only, so a test can read it at any time without racing a writer). Test fixture only.
//   FAKE_MUSE_MODE=bad-approval  sends an approval request the client cannot read.
//   FAKE_MUSE_MODE=no-approval   completes each turn immediately, with no approval.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const reportPath = process.env.FAKE_MUSE_REPORT;
const rec = (kind, data) => {
  if (reportPath) appendFileSync(reportPath, `${JSON.stringify({ kind, data })}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const mode = process.env.FAKE_MUSE_MODE ?? "normal";
rec("argv", process.argv.slice(2));

let activeModel = "muse-wonder-1.0";
const CATALOG = [
  { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", providerId: "meta", profileId: "tbh", releaseDate: "2026-10-12", description: null, contextLimit: 1007997, outputLimit: 128000, cost: null, isDefault: true, variants: ["minimal", "low", "high", "max"], reasoningEffortVariants: [], defaultReasoningEffort: "high" },
  { modelId: "muse-spark-1.2", displayLabel: "muse-spark-1.2", providerId: "meta", profileId: "tbh", releaseDate: "2026-08-05", description: null, contextLimit: 1007997, outputLimit: 128000, cost: null, isDefault: false, variants: ["minimal", "high", "xhigh"], reasoningEffortVariants: [{ tier: "xhigh", description: "Use this for deepest analysis and complex fixes." }], defaultReasoningEffort: "high" },
];

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

const SERVER_REQUEST_ID = 1000;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id === SERVER_REQUEST_ID) {
    rec("receipt", msg.result);
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { serverInfo: { name: "muse", version: "0.0.0-fake" }, schema: { version: 1, fingerprint: "sha256:fake" }, grantedCapabilities: [], experimentalApi: false, sessionDurability: "durable", sandboxAvailability: "unavailable" } });
      break;
    case "session/start":
      rec("startAttempt", msg.params);
      if (msg.params.modelId === "gone") {
        send({ id: msg.id, error: { code: -32030, message: "model_unavailable" } });
        break;
      }
      rec("start", msg.params);
      if (msg.params.modelId) activeModel = msg.params.modelId;
      send({ id: msg.id, result: { session: { sessionId: "s1", modelId: activeModel }, viewCursor: "" } });
      break;
    case "model/list":
      rec("list", msg.params);
      send({ id: msg.id, result: { providerId: "meta", profileId: "tbh", source: "providerCatalog", models: CATALOG.map((m) => ({ ...m, isActive: Boolean(msg.params.sessionId) && m.modelId === activeModel })) } });
      break;
    case "usage/read":
      send({ id: msg.id, result: {} });
      break;
    case "session/setModel":
      rec("setModel", msg.params);
      activeModel = msg.params.model.modelId;
      send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted" } });
      send({ method: "session/modelChanged", params: { sessionId: msg.params.sessionId, modelId: activeModel, providerId: "meta", source: "user", viewCursor: "v4:s1:2", sourceRange: {} } });
      break;
    case "turn/start":
      rec("turnStart", msg.params);
      send({ id: msg.id, result: { commandId: msg.params.commandId, status: "accepted", turnId: "t1", startedNewTurn: true, disposition: "started" } });
      if (mode === "no-approval") {
        send({ method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "completed", durationMs: 1, viewCursor: "v4:s1:9", sourceRange: {} } });
        break;
      }
      send({ method: "turn/started", params: { sessionId: "s1", turnId: "t1", commandId: msg.params.commandId, viewCursor: "v4:s1:1", sourceRange: {} } });
      send({ id: SERVER_REQUEST_ID, method: "approval/request", params: mode === "bad-approval" ? { approvalId: "ap-bad" } : goodApproval });
      break;
    case "approval/decide":
      rec("decide", msg.params);
      send({ id: msg.id, result: { approvalId: msg.params.approvalId, commandId: msg.params.commandId, status: "accepted", terminal: true } });
      send({ method: "approval/resolved", params: { approvalId: msg.params.approvalId, decision: "denied", policyResult: "deny", resolvedBy: "user", itemId: "tool-1", sessionId: "s1", turnId: "t1", stageEvidence: [], sourceRange: {}, viewCursor: "v4:s1:4" } });
      send({ method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "completed", durationMs: 5, viewCursor: "v4:s1:5", sourceRange: {} } });
      break;
    case "turn/interrupt":
      rec("interrupt", msg.params);
      send({ id: msg.id, result: { status: "accepted" } });
      send({ method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "cancelled", viewCursor: "v4:s1:6", sourceRange: {} } });
      break;
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
rl.on("close", () => process.exit(0));
