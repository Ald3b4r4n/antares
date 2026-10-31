/**
 * Maps raw MSP notifications to the small set of events the chat UI understands.
 * Pure and dependency-free so it can be tested without a host. Shapes were observed with
 * `scripts/probe-turn.ts` (see docs/PROTOCOL-NOTES.md); unknown shapes map to `undefined`.
 */

export interface ModelInfo {
  modelId: string;
  label: string;
  isDefault: boolean;
  contextLimit?: number;
  variants: string[];
  defaultReasoningEffort?: string;
}

export type ChatEvent =
  | { type: "turnStarted"; turnId: string }
  | { type: "userMessage"; itemId: string; text: string }
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
    }
  | { type: "context"; usedTokens: number; windowTokens: number; pressure?: string }
  | {
      type: "usage";
      windowPercent?: number;
      windowResetsAtMs?: number;
      weeklyPercent?: number;
      weeklyResetsAtMs?: number;
    }
  | { type: "models"; models: ModelInfo[] }
  | { type: "activity"; itemId: string; kind: string; label?: string; status: string }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

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
      if (kind === "userMessage" && !started) return { type: "userMessage", itemId, text: str(item.text) ?? "" };
      if (kind === "agentMessage") {
        return started
          ? { type: "assistantStarted", itemId }
          : { type: "assistantCompleted", itemId, text: str(item.text) ?? "" };
      }
      if (ACTIVITY_KINDS.has(kind)) {
        return { type: "activity", itemId, kind, label: str(item.label), status: started ? "started" : "completed" };
      }
      return undefined;
    }
    case "item/delta": {
      const itemId = str(params.itemId);
      const delta = str(params.delta);
      if (str(params.field) !== "text" || !itemId || delta === undefined) return undefined;
      return { type: "assistantDelta", itemId, delta };
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
    models.push({
      modelId,
      label: str(row.displayLabel) ?? modelId,
      isDefault: row.isDefault === true,
      contextLimit: num(row.contextLimit),
      variants: Array.isArray(row.variants) ? row.variants.filter((v): v is string => typeof v === "string") : [],
      defaultReasoningEffort: str(row.defaultReasoningEffort),
    });
  }
  return models;
}
