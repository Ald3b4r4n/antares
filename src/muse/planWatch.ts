/**
 * Following the subscription's plan. Muse returns the models the account may use each time its catalog is read, so a bigger plan shows
 * up on the next read. Antares reads it when the plan name changes (usage readings carry the tier name), when the window comes back to
 * the front after a while, and nothing else: it cannot show a model the host does not return (there is no "locked by plan" row).
 */
export class PlanWatch {
  private last: string | undefined;

  /** Feed each plan name seen. A missing or empty name is ignored (it neither changes nor clears what is remembered). */
  observe(plan: string | undefined): { changed: false } | { changed: true; from: string; to: string } {
    if (!plan) return { changed: false };
    const before = this.last;
    this.last = plan;
    return before !== undefined && before !== plan ? { changed: true, from: before, to: plan } : { changed: false };
  }
}

/** Whether to read the model catalog again now (on window focus or on a timer). */
export function shouldRefreshCatalog(s: { lastReadMs: number | undefined; nowMs: number; minAgeMs: number; turnRunning: boolean; hostRunning: boolean }): boolean {
  if (!s.hostRunning || s.turnRunning) return false;
  return s.lastReadMs === undefined || s.nowMs - s.lastReadMs >= s.minAgeMs;
}
