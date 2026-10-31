// Phase 1 probe: provoke ONE approval request from a real model turn and record its exact shape.
// DENY-ONLY: this script never approves anything. If the host offers no denying choice, it
// interrupts the turn. Costs one real model turn; runs in the user's normal environment (their
// hooks may run), in an empty throwaway workspace, with the `:ask-me` profile.
//
// Usage: node scripts/probe-approval.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "antares-approval-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

// A folder next to (not inside) the workspace: writing there is outside the workspace roots.
const outside = join(work, "outside");
mkdirSync(outside, { recursive: true });
const profile = process.env.PROBE_PROFILE ?? ":ask-me";
const extraArgs = (process.env.PROBE_ARGS ?? "").split(" ").filter(Boolean);
const host = new MuseHost({ binary, args: ["serve", ...extraArgs], cwd: workspace, env: { ...process.env } });
const log: { at: number; kind: string; method?: string; payload?: unknown }[] = [];
const t0 = Date.now();
const rec = (kind: string, method?: string, payload?: unknown) => log.push({ at: Date.now() - t0, kind, method, payload });

let sessionId = "";
let approvalsSeen = 0;
let decided = 0;
let approvedAnything = false;
let terminal: unknown;
let resolveDone: () => void = () => undefined;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});

interface Choice { choiceId: string; decision: string; label: string; scope: string }
interface Req { approvalId: string; availableChoices: Choice[]; currentRequirementId: unknown }

host.on("notification", (method: string, params: unknown) => {
  rec("notification", method, params);
  if (method === "turn/completed") {
    terminal = (params as { terminal?: unknown }).terminal;
    resolveDone();
  }
});
host.on("stderr", (line: string) => rec("stderr", undefined, line));
host.on("request", (id: number | string, method: string, params: unknown) => {
  rec("serverRequest", method, { id, params });
  if (method !== "approval/request") return;
  host.respond(id, {}); // presentation receipt only
  approvalsSeen++;
  const req = params as Req;
  const deny = req.availableChoices.find((c) => c.decision === "denied") ?? req.availableChoices.find((c) => c.decision === "abort");
  if (!deny || approvalsSeen > 3) {
    rec("note", undefined, "no denying choice (or too many approvals): interrupting");
    void host.request("turn/interrupt", { commandId: uuidv7(), sessionId }).catch(() => undefined);
    return;
  }
  if (/^approved/.test(deny.decision)) approvedAnything = true; // cannot happen: only denied/abort are picked
  void host
    .request("approval/decide", { commandId: uuidv7(), sessionId, approvalId: req.approvalId, choiceId: deny.choiceId, requirementId: req.currentRequirementId })
    .then((r) => {
      decided++;
      rec("result", "approval/decide", r);
    })
    .catch((e: Error) => rec("error", "approval/decide", e.message));
});

try {
  host.start();
  const init = await host.request<Record<string, unknown>>("initialize", {
    clientInfo: { name: "antares", version: "0.0.1" },
    capabilities: { requestedCapabilities: [], userInputDialogs: false },
  });
  rec("result", "initialize", init);
  host.notify("initialized");
  const started = await host.request<{ session?: { sessionId?: string; permissionState?: unknown } }>("session/start", {
    commandId: uuidv7(),
    workspaceRoot: workspace,
    permissionProfile: profile,
  });
  rec("result", "session/start", started);
  sessionId = started.session?.sessionId ?? "";
  if (!sessionId) throw new Error("no sessionId");
  if (process.env.PROBE_APPROVAL_MODE) {
    const changed = await host.request("session/setApprovalMode", { commandId: uuidv7(), sessionId, mode: process.env.PROBE_APPROVAL_MODE });
    rec("result", "session/setApprovalMode", changed);
  }
  console.log("Sending ONE real turn that should trigger a shell approval (it will be DENIED)...");
  setTimeout(resolveDone, 150_000);
  const ack = await host.request("turn/start", {
    commandId: uuidv7(),
    sessionId,
    input: [{ type: "text", text: (process.env.PROBE_PROMPT ?? "Use your shell tool to run exactly this command: echo antares").split("{OUTSIDE}").join(join(outside, "note.txt")) }],
  }, 30_000);
  rec("result", "turn/start", ack);
  await done;
  if (terminal === undefined) await host.request("turn/interrupt", { commandId: uuidv7(), sessionId }).catch(() => undefined);
} catch (error) {
  rec("error", undefined, error instanceof Error ? error.message : String(error));
} finally {
  const code = await host.stop();
  const counts: Record<string, number> = {};
  for (const e of log) if (e.method && (e.kind === "notification" || e.kind === "serverRequest")) counts[e.method] = (counts[e.method] ?? 0) + 1;
  const tools = log
    .filter((e) => e.method === "item/completed" && (e.payload as { item?: { kind?: string } })?.item?.kind === "toolCall")
    .map((e) => {
      const item = (e.payload as { item: { tool?: string; status?: string; failureReason?: string } }).item;
      return { tool: item.tool, status: item.status, failureReason: item.failureReason };
    });
  const summary = { profile, approvalMode: process.env.PROBE_APPROVAL_MODE ?? "(profile default)", turnOutcome: terminal, approvalsSeen, decided, approvedAnything, tools, hostExitCode: code, counts };
  writeFileSync(new URL(process.env.PROBE_LABEL ? `probe-approval-${process.env.PROBE_LABEL}.json` : "probe-approval.json", outDir), JSON.stringify({ summary, log }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  rmSync(work, { recursive: true, force: true });
}
