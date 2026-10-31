import * as vscode from "vscode";
import type { ChatEvent } from "../muse/events.ts";
import { locateMuse } from "../muse/locate.ts";
import {
  describeAlert,
  evaluateAlerts,
  formatRelative,
  normalizeThresholds,
  refreshUsage,
  REFRESH_COOLDOWN_MS,
  TokenLedger,
  type AlertState,
  type LedgerData,
  type UsageAlert,
  type UsageEvent,
} from "../muse/usage.ts";

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Keeps defined values only, so a partial observation never erases a known number. */
function merge(prev: UsageEvent | undefined, next: UsageEvent): UsageEvent {
  const out: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) out[k] = v;
  return out as UsageEvent;
}

/**
 * Owns what is shared by every chat panel: the last subscription usage the host reported, the alert
 * state, the local token ledger and the status bar item. The numbers are "as of" the host's
 * observation, never live; Antares does not poll.
 */
export class UsageTracker implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly item: vscode.StatusBarItem;
  private alertState: AlertState;
  private readonly ledger: TokenLedger;
  private usage?: UsageEvent;
  private lastRefreshAt = 0;
  private refreshing?: Promise<ChatEvent[]>;
  /** Recorded for integration tests. */
  readonly testState: { alerts: UsageAlert[]; statusText: string } = { alerts: [], statusText: "" };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.alertState = context.globalState.get<AlertState>("antares.usageAlertState") ?? {};
    this.ledger = new TokenLedger(context.globalState.get<LedgerData>("antares.tokenLedger"));
    this.item = vscode.window.createStatusBarItem("antares.usage", vscode.StatusBarAlignment.Right, 90);
    this.item.name = "Antares usage";
    this.update();
    if (this.config().get<boolean>("usage.statusBar", true)) this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("antares");
  }

  thresholds(): number[] {
    return normalizeThresholds(this.config().get<unknown>("usage.alertThresholds"));
  }

  latest(): UsageEvent | undefined {
    return this.usage;
  }

  ledgerSummary(): { todayTokens: number; weekTokens: number } {
    return { todayTokens: this.ledger.today(), weekTokens: this.ledger.lastDays(7) };
  }

  /** Feeds one chat event in. Returns extra events for the chat to show (alert notices, ledger totals). */
  handle(event: ChatEvent): ChatEvent[] {
    if (event.type === "usage") return this.onUsage(event);
    if (event.type === "tokens") {
      if (this.ledger.record(event.eventId, event.totalTokens)) {
        void this.context.globalState.update("antares.tokenLedger", this.ledger.toJSON());
        this.update();
        return [{ type: "ledger", ...this.ledgerSummary() }];
      }
    }
    return [];
  }

  private onUsage(event: UsageEvent): ChatEvent[] {
    this.usage = merge(this.usage, event);
    const extra: ChatEvent[] = [];
    if (this.config().get<boolean>("usage.alerts", true)) {
      const { alerts, state } = evaluateAlerts(this.alertState, this.usage, this.thresholds());
      this.alertState = state;
      void this.context.globalState.update("antares.usageAlertState", state);
      for (const alert of alerts) {
        const text = describeAlert(alert);
        this.testState.alerts.push(alert);
        extra.push({ type: "notice", level: "warning", text });
        void vscode.window.showWarningMessage(`Antares: ${text}`, "Open Antares", "Refresh usage").then((choice) => {
          if (choice === "Open Antares") void vscode.commands.executeCommand("antares.open");
          if (choice === "Refresh usage") void vscode.commands.executeCommand("antares.refreshUsage");
        });
      }
    }
    this.update();
    return extra;
  }

  /**
   * Reads fresh usage from the host (`usage/refresh`, experimental). At most one per minute, the
   * host's own bound. Resolves with the events to show; rejects with a readable error.
   */
  refresh(): Promise<ChatEvent[]> {
    if (this.refreshing) return this.refreshing;
    const wait = this.lastRefreshAt + REFRESH_COOLDOWN_MS - Date.now();
    if (wait > 0) return Promise.reject(new Error(`Usage was read less than a minute ago. Try again in ${Math.ceil(wait / 1000)} s.`));
    const binary = locateMuse(this.config().get<string>("musePath"));
    if (!binary) return Promise.reject(new Error("Muse executable not found. Set antares.musePath in Settings."));
    this.lastRefreshAt = Date.now();
    this.refreshing = refreshUsage({ binary, clientVersion: (this.context.extension.packageJSON as { version?: string }).version })
      .then((result) => {
        if (!result.usage) {
          return [{ type: "notice", level: "info", text: result.subscriptionActive === false ? "No subscription is active for this login, so there are no usage windows to show." : "Muse reported no usage numbers." } satisfies ChatEvent];
        }
        return this.onUsage({ ...result.usage, plan: result.plan, subscriptionActive: result.subscriptionActive });
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  /** Quiet refresh when a chat opens: failures (logged out, offline) are not worth interrupting for. */
  async refreshOnOpen(): Promise<ChatEvent[]> {
    if (!this.config().get<boolean>("usage.refreshOnOpen", true)) return [];
    try {
      return await this.refresh();
    } catch {
      return [];
    }
  }

  /** A short summary for the "show usage" command. */
  summary(): string {
    const u = this.usage;
    if (!u) return "No usage has been read yet. Use “Refresh usage”, or send a message.";
    const now = Date.now();
    const line = (name: string, p: number | undefined, resets: number | undefined) =>
      p === undefined ? undefined : resets !== undefined && resets <= now ? `${name}: reset since ${clock(resets)} (new value not read yet)` : `${name}: ${p}%${resets ? `, resets ${formatRelative(resets - now)}` : ""}`;
    const lines = [line("5-hour window", u.windowPercent, u.windowResetsAtMs), line("Weekly", u.weeklyPercent, u.weeklyResetsAtMs)].filter((l): l is string => l !== undefined);
    if (u.plan) lines.unshift(`Plan: ${u.plan}`);
    if (u.observedAtMs) lines.push(`As of ${clock(u.observedAtMs)}`);
    const t = this.ledgerSummary();
    lines.push(`Tokens through Antares: ${t.todayTokens.toLocaleString()} today, ${t.weekTokens.toLocaleString()} in the last 7 days (not the account total)`);
    return lines.join("\n");
  }

  private update(): void {
    const u = this.usage;
    const now = Date.now();
    const shown = (p: number | undefined, resets: number | undefined) => (p === undefined ? "–" : resets !== undefined && resets <= now ? "reset" : `${p}%`);
    if (!u) {
      this.item.text = "$(star-full) Antares";
      this.item.tooltip = "Open Antares";
      this.item.command = "antares.open";
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(star-full) 5h ${shown(u.windowPercent, u.windowResetsAtMs)} · wk ${shown(u.weeklyPercent, u.weeklyResetsAtMs)}`;
      const tip = new vscode.MarkdownString();
      tip.appendText(this.summary());
      tip.appendMarkdown("\n\n_Click for details. Percentages are as of the last read, not live._");
      this.item.tooltip = tip;
      this.item.command = "antares.showUsage";
      const live = [u.windowResetsAtMs !== undefined && u.windowResetsAtMs <= now ? undefined : u.windowPercent, u.weeklyResetsAtMs !== undefined && u.weeklyResetsAtMs <= now ? undefined : u.weeklyPercent].filter((p): p is number => p !== undefined);
      const peak = live.length ? Math.max(...live) : 0;
      const t = this.thresholds();
      this.item.backgroundColor = peak >= (t[t.length - 1] ?? 100) ? new vscode.ThemeColor("statusBarItem.errorBackground") : peak >= (t[0] ?? 80) ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    }
    this.testState.statusText = this.item.text;
  }
}
