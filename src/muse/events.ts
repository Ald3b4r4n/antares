/**
 * Maps raw MSP notifications to the small set of events the chat UI understands.
 * Pure and dependency-free so it can be tested without a host. Shapes were observed with
 * `scripts/probe-*.ts` (see docs/PROTOCOL-NOTES.md); unknown shapes map to `undefined`.
 * The approval shapes come from the exported schema only: no real approval request has been
 * observed yet.
 */

export interface ModelInfo {
  modelId: string;
  label: string;
  providerId?: string;
  profileId?: string;
  isDefault: boolean;
  isActive: boolean;
  contextLimit?: number;
  /** Selectable reasoning-effort tiers, in the catalog's order. */
  variants: string[];
  /** Catalog display strings for some tiers (tier -> description). */
  effortNotes: Record<string, string>;
  defaultReasoningEffort?: string;
}

/** Metadata the host reports for an attachment. The bytes are NOT sent back, only this. */
export interface AttachmentInfo {
  type: string;
  mediaType?: string;
  width?: number;
  height?: number;
  attachmentId?: string;
}

export interface ApprovalChoiceView {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  rulePreview?: string;
  acceptsFeedback: boolean;
}

export interface ApprovalSubjectView {
  kind: string;
  /** One line a person can judge: the command, the path, the host... */
  summary: string;
  detail: string[];
  /** True when the host sent a subject kind this build does not know how to present. */
  generic: boolean;
}

/** Permission profiles built into the Muse contract. Notes state only what was observed or published. */
export const PROFILES: { id: string; label: string; note: string }[] = [
  { id: ":read-only", label: "Read-only", note: "Reading only. Antares also disables shell and file-write tools at the host." },
  {
    id: ":ask-me",
    label: "Ask me",
    note: "Human review profile. Observed once: a file write inside the workspace ran without a prompt, and the shell failed closed because the sandbox was not set up.",
  },
  { id: ":auto-review", label: "Auto-review", note: "An automated reviewer decides first and escalates to you." },
  { id: ":unrestricted", label: "Unrestricted", note: "Per the contract this starts without sandbox or approval prompts. Use with care." },
];

export type ChatEvent =
  | { type: "turnStarted"; turnId: string }
  | { type: "userMessage"; itemId: string; text: string; attachments: AttachmentInfo[] }
  | { type: "assistantStarted"; itemId: string }
  | { type: "assistantDelta"; itemId: string; delta: string }
  | { type: "assistantCompleted"; itemId: string; text: string }
  | { type: "foregroundCompleted"; turnId: string }
  | {
      type: "turnCompleted";
      turnId: string;
      terminal: string;
      reason?: string;
      errorKind?: string;
      errorMessage?: string;
      durationMs?: number;
      timeToFirstTokenMs?: number;
    }
  | { type: "status"; status: string }
  | {
      type: "tokens";
      modelId?: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      /** The host's id for this report (its last source record), used to count it once. */
      eventId?: string;
      /** Running total the host reports for the session. */
      cumulativeTotal?: number;
    }
  | { type: "context"; usedTokens: number; windowTokens: number; pressure?: string }
  | {
      type: "usage";
      windowPercent?: number;
      windowResetsAtMs?: number;
      weeklyPercent?: number;
      weeklyResetsAtMs?: number;
      /** When the host observed these numbers (epoch ms): render "as of", never "live". */
      observedAtMs?: number;
      /** The plan's display name, only known from `usage/refresh`. */
      plan?: string;
      subscriptionActive?: boolean;
    }
  | { type: "models"; models: ModelInfo[] }
  | { type: "modelChanged"; modelId: string; providerId?: string; source: string }
  | { type: "ledger"; todayTokens: number; weekTokens: number }
  | { type: "effortChanged"; effort: string; source: string }
  | { type: "activity"; itemId: string; kind: string; label?: string; status: string }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "session"; sessionId?: string; profileId?: string; sandbox?: string; version?: string; durability?: string }
  | { type: "history"; source: "resume" | "fork"; mode: string; events: ChatEvent[]; note?: string }
  | {
      type: "toolCall";
      itemId: string;
      tool: string;
      summary: string;
      status: string;
      held: boolean;
      heldFor?: string;
      failure?: string;
      output?: string;
    }
  | {
      type: "approvalRequested";
      approvalId: string;
      itemId: string;
      toolName: string;
      subject: ApprovalSubjectView;
      choices: ApprovalChoiceView[];
      /** Sent back unchanged as `requirementId` in approval/decide. */
      requirementId: unknown;
      protectedWrite: boolean;
      judgeEscalated: boolean;
      reviewerReason?: string;
    }
  | { type: "approvalResolved"; approvalId: string; decision: string; resolvedBy: string; policyResult: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Item kinds shown as quiet background activity rather than chat messages. */
const ACTIVITY_KINDS = new Set(["hookRun", "reminderChild"]);

export function mapNotification(method: string, params: unknown): ChatEvent | undefined {
  if (!isObj(params)) return undefined;
  switch (method) {
    case "turn/started": {
      const turnId = str(params.turnId);
      return turnId ? { type: "turnStarted", turnId } : undefined;
    }
    case "turn/foregroundCompleted": {
      const turnId = str(params.turnId);
      return turnId ? { type: "foregroundCompleted", turnId } : undefined;
    }
    case "turn/completed": {
      const turnId = str(params.turnId);
      const terminal = str(params.terminal);
      if (!turnId || !terminal) return undefined;
      const error = isObj(params.error) ? params.error : undefined;
      return {
        type: "turnCompleted",
        turnId,
        terminal,
        reason: str(params.reason),
        errorKind: str(error?.kind),
        errorMessage: str(error?.message),
        durationMs: num(params.durationMs),
        timeToFirstTokenMs: num(params.timeToFirstTokenMs),
      };
    }
    case "item/started":
    case "item/completed": {
      const item = isObj(params.item) ? params.item : undefined;
      const itemId = str(item?.itemId);
      const kind = str(item?.kind);
      if (!item || !itemId || !kind) return undefined;
      const started = method === "item/started";
      if (kind === "userMessage" && !started) return { type: "userMessage", itemId, text: str(item.text) ?? "", attachments: mapAttachments(item.attachments) };
      if (kind === "agentMessage") {
        return started
          ? { type: "assistantStarted", itemId }
          : { type: "assistantCompleted", itemId, text: str(item.text) ?? "" };
      }
      if (kind === "toolCall") return mapToolCall(item, itemId);
      if (ACTIVITY_KINDS.has(kind)) {
        return { type: "activity", itemId, kind, label: str(item.label), status: started ? "started" : "completed" };
      }
      return undefined;
    }
    case "item/updated": {
      const item = isObj(params.item) ? params.item : undefined;
      const itemId = str(item?.itemId);
      if (item && itemId && str(item.kind) === "toolCall") return mapToolCall(item, itemId);
      return undefined;
    }
    case "item/delta": {
      const itemId = str(params.itemId);
      const delta = str(params.delta);
      if (str(params.field) !== "text" || !itemId || delta === undefined) return undefined;
      return { type: "assistantDelta", itemId, delta };
    }
    case "session/modelChanged": {
      const modelId = str(params.modelId);
      return modelId ? { type: "modelChanged", modelId, providerId: str(params.providerId), source: str(params.source) ?? "unknown" } : undefined;
    }
    case "session/reasoningEffortChanged": {
      const effort = str(params.reasoningEffort);
      return effort ? { type: "effortChanged", effort, source: str(params.source) ?? "unknown" } : undefined;
    }
    case "approval/requested":
      return mapApprovalRequest(params);
    case "approval/resolved": {
      const approvalId = str(params.approvalId);
      const decision = str(params.decision);
      if (!approvalId || !decision) return undefined;
      return {
        type: "approvalResolved",
        approvalId,
        decision,
        resolvedBy: str(params.resolvedBy) ?? "unknown",
        policyResult: str(params.policyResult) ?? "unknown",
      };
    }
    case "session/statusChanged": {
      const status = str(params.status);
      return status ? { type: "status", status } : undefined;
    }
    case "session/tokenUsage": {
      const usage = isObj(params.usage) ? params.usage : undefined;
      return {
        type: "tokens",
        modelId: str(params.modelId),
        inputTokens: num(usage?.inputTokens) ?? num(params.promptTokens) ?? 0,
        outputTokens: num(usage?.outputTokens) ?? 0,
        reasoningTokens: num(usage?.reasoningTokens) ?? 0,
        totalTokens: num(params.totalTokens) ?? 0,
        eventId: sourceEventId(params.sourceRange),
        cumulativeTotal: isObj(params.cumulative) ? num(params.cumulative.totalTokens) : undefined,
      };
    }
    case "session/contextUsage": {
      const usedTokens = num(params.usedTokens);
      const windowTokens = num(params.windowTokens);
      if (usedTokens === undefined || windowTokens === undefined) return undefined;
      return { type: "context", usedTokens, windowTokens, pressure: str(params.pressure) };
    }
    case "usage/changed":
      return mapUsage(params);
    default:
      return undefined;
  }
}

function sourceEventId(range: unknown): string | undefined {
  if (!isObj(range) || !isObj(range.last)) return undefined;
  return str(range.last.id);
}

/** Maps the body of `usage/changed` and of the `usage` member of a `usage/read` result. */
export function mapUsage(body: unknown): ChatEvent | undefined {
  if (!isObj(body)) return undefined;
  const windowObj = isObj(body.window) ? body.window : undefined;
  const weekly = isObj(body.weekly) ? body.weekly : undefined;
  if (!windowObj && !weekly) return undefined;
  return {
    type: "usage",
    windowPercent: num(windowObj?.usedPercent),
    windowResetsAtMs: num(windowObj?.resetsAtMs),
    weeklyPercent: num(weekly?.usedPercent),
    weeklyResetsAtMs: num(weekly?.resetsAtMs),
    observedAtMs: num(body.observedAtMs),
  };
}

/** Maps a `model/list` result. */
export function mapModels(result: unknown): ModelInfo[] {
  if (!isObj(result) || !Array.isArray(result.models)) return [];
  const models: ModelInfo[] = [];
  for (const row of result.models) {
    if (!isObj(row)) continue;
    const modelId = str(row.modelId);
    if (!modelId) continue;
    const effortNotes: Record<string, string> = {};
    if (Array.isArray(row.reasoningEffortVariants)) {
      for (const v of row.reasoningEffortVariants) {
        if (isObj(v) && str(v.tier) && str(v.description)) effortNotes[str(v.tier) as string] = str(v.description) as string;
      }
    }
    models.push({
      modelId,
      label: str(row.displayLabel) ?? modelId,
      providerId: str(row.providerId),
      profileId: str(row.profileId),
      isDefault: row.isDefault === true,
      isActive: row.isActive === true,
      contextLimit: num(row.contextLimit),
      variants: Array.isArray(row.variants) ? row.variants.filter((v): v is string => typeof v === "string") : [],
      effortNotes,
      defaultReasoningEffort: str(row.defaultReasoningEffort),
    });
  }
  return models;
}

export function mapAttachments(value: unknown): AttachmentInfo[] {
  if (!Array.isArray(value)) return [];
  const out: AttachmentInfo[] = [];
  for (const a of value) {
    if (!isObj(a)) continue;
    out.push({ type: str(a.type) ?? "unknown", mediaType: str(a.mediaType), width: num(a.width), height: num(a.height), attachmentId: str(a.attachmentId) });
  }
  return out;
}

/** Short, human-judgeable summary of a tool call's arguments (a JSON string or an object). */
export function summarizeArgs(args: unknown): string {
  let value: unknown = args;
  if (typeof args === "string") {
    try {
      value = JSON.parse(args);
    } catch {
      return clip(args, 200);
    }
  }
  if (isObj(value)) {
    for (const key of ["command", "path", "url", "query", "pattern"]) {
      const v = str(value[key]);
      if (v) return clip(v, 200);
    }
    const first = Object.values(value).find((v) => typeof v === "string");
    if (typeof first === "string") return clip(first, 200);
  }
  return clip(typeof args === "string" ? args : (JSON.stringify(args) ?? ""), 200);
}

function mapToolCall(item: Obj, itemId: string): ChatEvent {
  const failure = str(item.failureReason);
  const output = str(item.visibleOutput);
  return {
    type: "toolCall",
    itemId,
    tool: str(item.tool) ?? "tool",
    summary: summarizeArgs(item.args),
    status: str(item.status) ?? "inProgress",
    held: item.held === true,
    heldFor: str(item.heldFor),
    failure: failure ? clip(failure, 600) : undefined,
    output: output && !failure ? clip(output, 600) : undefined,
  };
}

export function subjectView(subject: unknown, toolName: string, rawArgs: string): ApprovalSubjectView {
  const s = isObj(subject) ? subject : {};
  const kind = str(s.kind) ?? "unknown";
  const via = `tool: ${str(s.toolName) ?? toolName}`;
  switch (kind) {
    case "shell": {
      const detail: string[] = [];
      const stages = Array.isArray(s.stages) ? s.stages : [];
      if (stages.length > 1) {
        stages.forEach((stage, i) => {
          const text = typeof stage === "string" ? stage : isObj(stage) ? (str(stage.command) ?? str(stage.text) ?? JSON.stringify(stage)) : String(stage);
          detail.push(`stage ${i + 1}: ${clip(text, 200)}`);
        });
      }
      const root = str(s.workspaceRoot);
      if (root) detail.push(`in ${root}`);
      return { kind, summary: str(s.command) ?? clip(rawArgs, 200), detail, generic: false };
    }
    case "fileAccess":
      return { kind, summary: `${str(s.access) ?? "access"} ${str(s.path) ?? "?"}`, detail: [via], generic: false };
    case "network": {
      const port = typeof s.port === "number" ? `:${s.port}` : "";
      const proto = str(s.protocol) ? ` (${str(s.protocol)})` : "";
      return { kind, summary: `${str(s.host) ?? "?"}${port}${proto}`, detail: [via], generic: false };
    }
    case "unixSocket":
      return { kind, summary: str(s.path) ?? "?", detail: [via], generic: false };
    case "process":
      return { kind, summary: `control ${str(s.target) ?? "?"}`, detail: [via], generic: false };
    case "tool":
      return { kind, summary: str(s.toolName) ?? toolName, detail: rawArgs ? [clip(rawArgs, 300)] : [], generic: false };
    default:
      // Unknown kinds are shown generically and are never auto-approved (contract, SS5.2).
      return { kind, summary: `${toolName}: ${clip(rawArgs, 200)}`, detail: [`unrecognized approval kind "${kind}"`], generic: true };
  }
}

/** Maps the params shared by `approval/request` (server request) and `approval/requested` (notification). */
export function mapApprovalRequest(params: unknown): ChatEvent | undefined {
  if (!isObj(params)) return undefined;
  const approvalId = str(params.approvalId);
  const itemId = str(params.itemId);
  if (!approvalId || !itemId || !Array.isArray(params.availableChoices) || params.currentRequirementId === undefined) return undefined;
  const choices: ApprovalChoiceView[] = [];
  for (const c of params.availableChoices) {
    if (!isObj(c)) continue;
    const choiceId = str(c.choiceId);
    const label = str(c.label);
    if (!choiceId || !label) continue;
    choices.push({
      choiceId,
      label,
      decision: str(c.decision) ?? "unknown",
      scope: str(c.scope) ?? "once",
      rulePreview: str(c.rulePreview),
      acceptsFeedback: c.acceptsFeedback === true,
    });
  }
  if (choices.length === 0) return undefined;
  const toolName = str(params.toolName) ?? "tool";
  const rawArgs = str(params.rawArgs) ?? "";
  return {
    type: "approvalRequested",
    approvalId,
    itemId,
    toolName,
    subject: subjectView(params.subject, toolName, rawArgs),
    choices,
    requirementId: params.currentRequirementId,
    protectedWrite: params.protectedWrite === true,
    judgeEscalated: params.judgeEscalated === true,
    reviewerReason: str(params.reviewerReason),
  };
}
