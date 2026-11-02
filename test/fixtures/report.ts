import { readFileSync } from "node:fs";

/** What the fake `muse serve` observed, aggregated from its append-only report file. */
export interface FakeReport {
  argv: string[];
  /** Every session/start the fake received, including refused ones. */
  startAttempts: Record<string, unknown>[];
  /** Params of the session/start it accepted ({} until one was accepted). */
  startParams: Record<string, unknown>;
  receipts: unknown[];
  decides: Record<string, unknown>[];
  interrupts: number;
  setModels: { model: Record<string, unknown>; sessionId: string }[];
  turnStarts: Record<string, unknown>[];
  listParams: Record<string, unknown>[];
  initializes: Record<string, unknown>[];
  refreshes: number;
  sessionLists: Record<string, unknown>[];
  resumes: Record<string, unknown>[];
  forks: Record<string, unknown>[];
  skillLists: Record<string, unknown>[];
  pluginLists: Record<string, unknown>[];
  unqueues: Record<string, unknown>[];
  skillImports: Record<string, unknown>[];
  pluginInstalls: Record<string, unknown>[];
  marketplaceAdds: Record<string, unknown>[];
  oauth: { kind: string; data: Record<string, unknown> }[];
  settingsWrite?: Record<string, unknown>[];
}

/** Reads the report. A missing file or a half-written last line is "not yet": callers poll. */
export function readReport(path: string): FakeReport {
  const report: FakeReport = { argv: [], startAttempts: [], startParams: {}, receipts: [], decides: [], interrupts: 0, setModels: [], turnStarts: [], listParams: [], initializes: [], refreshes: 0, sessionLists: [], resumes: [], forks: [], skillLists: [], pluginLists: [], unqueues: [], skillImports: [], pluginInstalls: [], marketplaceAdds: [], oauth: [] };
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return report;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: { kind: string; data: never };
    try {
      entry = JSON.parse(line) as { kind: string; data: never };
    } catch {
      continue; // a line still being written
    }
    const data = entry.data as unknown;
    switch (entry.kind) {
      case "argv":
        report.argv = data as string[];
        break;
      case "startAttempt":
        report.startAttempts.push(data as Record<string, unknown>);
        break;
      case "start":
        report.startParams = data as Record<string, unknown>;
        break;
      case "receipt":
        report.receipts.push(data);
        break;
      case "decide":
        report.decides.push(data as Record<string, unknown>);
        break;
      case "interrupt":
        report.interrupts++;
        break;
      case "setModel":
        report.setModels.push(data as { model: Record<string, unknown>; sessionId: string });
        break;
      case "turnStart":
        report.turnStarts.push(data as Record<string, unknown>);
        break;
      case "list":
        report.listParams.push(data as Record<string, unknown>);
        break;
      case "initialize":
        report.initializes.push(data as Record<string, unknown>);
        break;
      case "refresh":
        report.refreshes++;
        break;
      case "list-sessions":
        report.sessionLists.push(data as Record<string, unknown>);
        break;
      case "resume":
        report.resumes.push(data as Record<string, unknown>);
        break;
      case "fork":
        report.forks.push(data as Record<string, unknown>);
        break;
      case "skill-list":
        report.skillLists.push(data as Record<string, unknown>);
        break;
      case "plugin-list":
        report.pluginLists.push(data as Record<string, unknown>);
        break;
      case "oauth-login":
      case "oauth-cancel":
      case "oauth-logout":
        report.oauth.push({ kind: entry.kind, data: data as Record<string, unknown> });
        break;
      case "plugin-install":
        report.pluginInstalls.push(data as Record<string, unknown>);
        break;
      case "marketplace-add":
        report.marketplaceAdds.push(data as Record<string, unknown>);
        break;
      case "settingsWrite":
        (report.settingsWrite ??= []).push(data as Record<string, unknown>);
        break;
      case "skill-import":
        report.skillImports.push(data as Record<string, unknown>);
        break;
      case "unqueue":
        report.unqueues.push(data as Record<string, unknown>);
        break;
    }
  }
  return report;
}
