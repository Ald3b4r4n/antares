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
      rec("initialize", msg.params);
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
    case "session/list": {
      rec("list-sessions", msg.params);
      const here = process.env.FAKE_MUSE_WORKSPACE ?? "";
      const row = (id, extra) => ({ sessionId: id, path: "", status: "idle", activeTurnId: null, createdAt: "2026-10-31T10:00:00Z", updatedAt: "2026-10-31T10:00:00Z", lastActivityAt: "2026-10-31T10:00:00Z", workspaceRoot: here, providerId: "meta", modelId: "muse-wonder-1.0", turnCount: 2, forkedFrom: null, sideFrom: null, kind: "root", title: `Session ${id}`, ...extra });
      if (!msg.params.cursor) {
        send({ id: msg.id, result: { nextCursor: "page-2", sessions: [row("old", { lastActivityAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-31T09:00:00Z" }), row("child", { kind: "subagent" }), row("elsewhere", { workspaceRoot: "Z:\\\\other\\\\repo", lastActivityAt: "2026-10-20T10:00:00Z" })] } });
      } else {
        send({ id: msg.id, result: { nextCursor: null, sessions: [row("new", { lastActivityAt: "2026-10-31T12:00:00Z", title: "", name: "Named session", forkedFrom: { sessionId: "old" } })] } });
      }
      break;
    }
    case "session/resume":
    case "session/fork": {
      const isFork = msg.method === "session/fork";
      rec(isFork ? "fork" : "resume", msg.params);
      const sessionId = isFork ? "s-fork" : msg.params.sessionId;
      const inline = process.env.FAKE_MUSE_HISTORY !== "snapshot";
      const items = isFork
        ? [{ itemId: "a1", kind: "agentMessage", status: "completed", text: "Forked answer" }]
        : [
            { itemId: "hk", kind: "hookRun", status: "completed", label: "a hook" },
            { itemId: "u1", kind: "userMessage", status: "completed", text: "Look at this[Image #1]", attachments: [{ type: "image", mediaType: "image/png", width: 8, height: 8, attachmentId: "x/1" }] },
            { itemId: "t1", kind: "toolCall", status: "completed", tool: "read_file", args: '{"path":"a.txt"}', visibleOutput: "contents" },
            { itemId: "a1", kind: "agentMessage", status: "completed", text: "I looked." },
            { itemId: "rc", kind: "reminderChild", status: "completed" },
          ];
      send({ id: msg.id, result: { session: { sessionId, modelId: "muse-wonder-1.0", status: "idle" }, viewCursor: "v4:x:1", pendingRequests: [], history: inline ? { mode: "inline", items, snapshot: null } : { mode: "snapshot", items: null, snapshot: {} }, ...(process.env.FAKE_MUSE_LASTTURN ? { lastTurn: { terminal: "failed", turnId: "t9", reason: "crash" } } : {}) } });
      break;
    }
    case "usage/refresh":
      rec("refresh", {});
      send({ id: msg.id, result: { subscriptionActive: true, tierName: "Test Plan", usage: { observedAtMs: Date.now(), tier: "opaque-tier-id", window: { usedPercent: 42, windowDurationMins: 300, resetsAtMs: Date.now() + 3600000 }, weekly: { usedPercent: 7, resetsAtMs: Date.now() + 86400000 } } } });
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
      // The real host announces an approval twice: as the request it wants a receipt for and as a
      // notification. Both orders were possible, so FAKE_MUSE_ORDER picks one.
      if (mode !== "bad-approval" && process.env.FAKE_MUSE_ORDER === "notification-first") send({ method: "approval/requested", params: goodApproval });
      send({ id: SERVER_REQUEST_ID, method: "approval/request", params: mode === "bad-approval" ? { approvalId: "ap-bad" } : goodApproval });
      if (mode !== "bad-approval" && process.env.FAKE_MUSE_ORDER !== "notification-first") send({ method: "approval/requested", params: goodApproval });
      break;
    case "approval/decide":
      rec("decide", msg.params);
      if (mode === "two-stage" && msg.params.requirementId?.sourceIndex === 0) {
        // Stage 0 is satisfied but a second stage remains: the same approval id comes again with a new requirement.
        send({ id: msg.id, result: { approvalId: msg.params.approvalId, commandId: msg.params.commandId, status: "accepted", terminal: false } });
        send({ id: SERVER_REQUEST_ID, method: "approval/request", params: { ...goodApproval, currentRequirementId: { approvalId: "ap-1", sourceIndex: 1 }, subject: { ...goodApproval.subject, command: "second stage" } } });
        break;
      }
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
