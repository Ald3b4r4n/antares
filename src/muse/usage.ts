/**
 * Subscription usage: alert thresholds, a local token ledger, and a one-shot refresh.
 *
 * What the host provides (observed with scripts/probe-usage.ts): percentages of a 5-hour-class window
 * and of a rolling weekly budget, with their reset times and the time the host observed them. There is
 * no money figure. Percentages are point-in-time ("as of"), may exceed 100, and are account-wide.
 * The provider's tier id is never used or stored; only the display name from `usage/refresh`.
 */
import { MuseHost, MspError } from "./host.ts";
import { mapUsage, type ChatEvent } from "./events.ts";

export type UsageEvent = Extract<ChatEvent, { type: "usage" }>;
export type TokensEvent = Extract<ChatEvent, { type: "tokens" }>;

export type WindowKind = "window" | "weekly";

export interface UsageAlert {
  kind: WindowKind;
  threshold: number;
  percent: number;
  resetsAtMs?: number;
}

/** Which (kind, threshold) pairs have already alerted. Persisted so a reopened editor does not repeat. */
export type AlertState = Record<string, boolean>;

const key = (kind: WindowKind, threshold: number) => `${kind}:${threshold}`;

/** Thresholds as a sorted list of distinct integers in 1..100; falls back to [80, 95]. */
export function normalizeThresholds(value: unknown): number[] {
  if (!Array.isArray(value)) return [80, 95];
  const set = new Set<number>();
  for (const v of value) if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100) set.add(v);
  return set.size === 0 ? [80, 95] : [...set].sort((a, b) => a - b);
}

/**
 * Decides which alerts to raise for a new usage observation.
 *
 * - One alert per window kind at most: the highest threshold newly crossed. Crossing 80 and 95 in a
 *   single jump raises one alert, for 95, and marks both as fired.
 * - A threshold re-arms when the percentage falls back below it (the window reset).
 * - A window whose reset time has passed is expired data: it raises nothing and re-arms everything,
 *   because the real percentage is unknown until the host observes a new one.
 */
export function evaluateAlerts(prev: AlertState, usage: UsageEvent, thresholds: number[], now: number = Date.now()): { alerts: UsageAlert[]; state: AlertState } {
  const state: AlertState = { ...prev };
  const alerts: UsageAlert[] = [];
  const sorted = [...thresholds].sort((a, b) => a - b);
  const kinds: [WindowKind, number | undefined, number | undefined][] = [
    ["window", usage.windowPercent, usage.windowResetsAtMs],
    ["weekly", usage.weeklyPercent, usage.weeklyResetsAtMs],
  ];
  for (const [kind, percent, resetsAtMs] of kinds) {
    if (percent === undefined) continue;
    const expired = resetsAtMs !== undefined && resetsAtMs <= now;
    if (expired) {
      for (const t of sorted) state[key(kind, t)] = false;
      continue;
    }
    let newest: number | undefined;
    for (const t of sorted) {
      const k = key(kind, t);
      if (percent >= t) {
        if (!state[k]) {
          state[k] = true;
          newest = t;
        }
      } else {
        state[k] = false;
      }
    }
    if (newest !== undefined) alerts.push({ kind, threshold: newest, percent, resetsAtMs });
  }
  return { alerts, state };
}

/** Human text for an alert, e.g. "5-hour usage is at 96% (alert at 95%), resets in 2 h 5 min". */
export function describeAlert(alert: UsageAlert, now: number = Date.now()): string {
  const name = alert.kind === "window" ? "5-hour usage" : "Weekly usage";
  const reset = alert.resetsAtMs ? `, resets ${formatRelative(alert.resetsAtMs - now)}` : "";
  return `${name} is at ${alert.percent}% (alert at ${alert.threshold}%)${reset}.`;
}

export function formatRelative(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  if (mins < 48 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 || h >= 10 ? `in ${h} h` : `in ${h} h ${m} min`;
  }
  return `in ${Math.round(mins / 1440)} d`;
}

// ---------------------------------------------------------------- token ledger

export interface LedgerData {
  /** Tokens per local calendar day, YYYY-MM-DD. */
  days: Record<string, number>;
  /** Recently counted event ids, so a replayed event is not counted twice. */
  seen: string[];
}

const KEEP_DAYS = 35;
const KEEP_SEEN = 500;

export const dayKey = (at: Date = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
};

/**
 * A local sum of the tokens the host reports for chats run through Antares. It is not the account's
 * usage: other clients, and any work the host does that it does not report (such as background
 * reminder sessions), are not in it.
 */
export class TokenLedger {
  private data: LedgerData;

  constructor(data?: Partial<LedgerData>) {
    this.data = { days: { ...(data?.days ?? {}) }, seen: [...(data?.seen ?? [])] };
  }

  /** Adds one report. Returns false (and counts nothing) for a repeated event id or an empty report. */
  record(eventId: string | undefined, tokens: number, at: Date = new Date()): boolean {
    if (!Number.isFinite(tokens) || tokens <= 0) return false;
    if (eventId) {
      if (this.data.seen.includes(eventId)) return false;
      this.data.seen.push(eventId);
      if (this.data.seen.length > KEEP_SEEN) this.data.seen.splice(0, this.data.seen.length - KEEP_SEEN);
    }
    const day = dayKey(at);
    this.data.days[day] = (this.data.days[day] ?? 0) + Math.round(tokens);
    this.prune(at);
    return true;
  }

  today(at: Date = new Date()): number {
    return this.data.days[dayKey(at)] ?? 0;
  }

  /** Sum over the last `n` local days including today. */
  lastDays(n: number, at: Date = new Date()): number {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() - i);
      total += this.data.days[dayKey(d)] ?? 0;
    }
    return total;
  }

  private prune(at: Date): void {
    const oldest = dayKey(new Date(at.getFullYear(), at.getMonth(), at.getDate() - KEEP_DAYS));
    for (const day of Object.keys(this.data.days)) if (day < oldest) delete this.data.days[day];
  }

  toJSON(): LedgerData {
    return { days: { ...this.data.days }, seen: [...this.data.seen] };
  }
}

// ---------------------------------------------------------------- one-shot refresh

export interface RefreshResult {
  usage?: UsageEvent;
  subscriptionActive?: boolean;
  /** The plan's display name (never the tier id). */
  plan?: string;
}

/** The host's documented bound is one refresh per 60 s; Antares keeps at least that gap. */
export const REFRESH_COOLDOWN_MS = 60_000;

export interface RefreshOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seam: arguments placed before `serve`. */
  binaryArgs?: string[];
  clientVersion?: string;
}

/**
 * Reads fresh usage with `usage/refresh`, which is experimental and therefore needs the experimental
 * API negotiated. To keep the chat host on the stable surface, this uses a short-lived host of its own
 * with no session (so no hooks and no model call). The host performs the mint; Antares never sees
 * credentials.
 */
export async function refreshUsage(options: RefreshOptions): Promise<RefreshResult> {
  const host = new MuseHost({
    binary: options.binary,
    args: [...(options.binaryArgs ?? []), "serve", "--disable-shell", "--disable-write"],
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  try {
    host.start();
    await host.request("initialize", {
      clientInfo: { name: "antares", version: options.clientVersion ?? "0.0.1" },
      capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false },
    });
    host.notify("initialized");
    const result = await host.request<{ usage?: unknown; subscriptionActive?: unknown; tierName?: unknown }>("usage/refresh", {}, 20_000);
    const mapped = mapUsage(result.usage);
    return {
      usage: mapped?.type === "usage" ? mapped : undefined,
      subscriptionActive: typeof result.subscriptionActive === "boolean" ? result.subscriptionActive : undefined,
      plan: typeof result.tierName === "string" && result.tierName !== "" ? result.tierName : undefined,
    };
  } catch (error) {
    if (error instanceof MspError) throw new Error(`The host refused the usage refresh: ${error.message}`);
    throw error;
  } finally {
    await host.stop(3000);
  }
}
