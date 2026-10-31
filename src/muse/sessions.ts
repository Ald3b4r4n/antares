/**
 * Session history: turning the host's session rows and stored items into what the UI shows.
 * Shapes observed with scripts/probe-sessions.ts (Muse 1.4.14); see docs/PROTOCOL-NOTES.md.
 * Session titles and prompts are the user's private conversations: nothing here logs or stores them.
 */
import { mapNotification, type ChatEvent } from "./events.ts";

export interface SessionRowView {
  sessionId: string;
  /** What to show as the session's name: the host's title, else a clipped first prompt. */
  title: string;
  updatedAtMs: number;
  turnCount: number;
  modelId?: string;
  workspaceRoot?: string;
  /** True when the session belongs to the folder open in the editor. */
  sameWorkspace: boolean;
  forked: boolean;
  status?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One line of display text: control characters and runs of whitespace folded, clipped to `max`. */
export function oneLine(text: string, max = 90): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Normalizes a folder path for comparison: separators, the `\\?\` prefix, trailing slash, and case on Windows. */
export function normalizePath(path: string, windows: boolean = process.platform === "win32"): string {
  let p = path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (windows) p = p.toLowerCase();
  return p;
}

export function sameFolder(a: string | undefined, b: string, windows?: boolean): boolean {
  return a !== undefined && normalizePath(a, windows) === normalizePath(b, windows);
}

const timeOf = (v: unknown): number => {
  const s = str(v);
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Maps `session/list` rows. Only root sessions are kept (a child of a subagent is not a chat), and the
 * result is sorted by the latest activity, newest first, because the host's own order was not strictly
 * by `updatedAt` in testing.
 */
export function mapSessionRows(result: unknown, workspaceRoot: string, windows?: boolean): SessionRowView[] {
  if (!isObj(result) || !Array.isArray(result.sessions)) return [];
  const rows: SessionRowView[] = [];
  for (const raw of result.sessions) {
    if (!isObj(raw)) continue;
    const sessionId = str(raw.sessionId);
    if (!sessionId) continue;
    if (str(raw.kind) !== undefined && str(raw.kind) !== "root") continue;
    const title = str(raw.name) ?? str(raw.title) ?? str(raw.firstUserPrompt);
    rows.push({
      sessionId,
      title: title ? oneLine(title) : "(untitled)",
      updatedAtMs: Math.max(timeOf(raw.lastActivityAt), timeOf(raw.updatedAt)),
      turnCount: num(raw.turnCount) ?? 0,
      modelId: str(raw.modelId),
      workspaceRoot: str(raw.workspaceRoot),
      sameWorkspace: sameFolder(str(raw.workspaceRoot), workspaceRoot, windows),
      forked: isObj(raw.forkedFrom),
      status: str(raw.status),
    });
  }
  return rows.sort((x, y) => y.updatedAtMs - x.updatedAtMs);
}

/** Item kinds that make up a transcript. Hooks and reminder children are background activity, not conversation. */
const TRANSCRIPT_EVENTS = new Set<ChatEvent["type"]>(["userMessage", "assistantCompleted", "toolCall"]);

/** Turns a served history (`history.items`) into the events that redraw the conversation. */
export function historyToEvents(items: unknown): ChatEvent[] {
  if (!Array.isArray(items)) return [];
  const events: ChatEvent[] = [];
  for (const item of items) {
    const event = mapNotification("item/completed", { item });
    if (event && TRANSCRIPT_EVENTS.has(event.type)) events.push(event);
  }
  return events;
}

export interface ServedHistory {
  mode: string;
  events: ChatEvent[];
}

/** Reads the `history` envelope of a resume/fork result. Only `inline` carries items. */
export function readHistory(history: unknown): ServedHistory {
  if (!isObj(history)) return { mode: "none", events: [] };
  const mode = str(history.mode) ?? "none";
  return { mode, events: mode === "inline" ? historyToEvents(history.items) : [] };
}

/** "3 min ago", "2 h ago", "yesterday", or a date. */
export function ago(ms: number, now: number = Date.now()): string {
  if (!ms) return "";
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} d ago`;
  return new Date(ms).toLocaleDateString();
}
