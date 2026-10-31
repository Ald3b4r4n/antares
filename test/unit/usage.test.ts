// Subscription usage: alert logic, token ledger, mapping (shapes observed with scripts/probe-usage.ts
// and probe-turn.ts) and the one-shot refresh against the fake MSP host.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mapNotification } from "../../src/muse/events.ts";
import { dayKey, describeAlert, evaluateAlerts, formatRelative, normalizeThresholds, refreshUsage, TokenLedger, type AlertState, type UsageEvent } from "../../src/muse/usage.ts";
import { readReport } from "../fixtures/report.ts";

const NOW = 1_800_000_000_000;
const usage = (windowPercent?: number, weeklyPercent?: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  type: "usage",
  windowPercent,
  windowResetsAtMs: NOW + 2 * 3600_000,
  weeklyPercent,
  weeklyResetsAtMs: NOW + 3 * 86400_000,
  ...extra,
});
const T = [80, 95];

test("thresholds are normalized: sorted, distinct, 1..100 integers; bad input falls back", () => {
  assert.deepEqual(normalizeThresholds([95, 80, 80, 50]), [50, 80, 95]);
  assert.deepEqual(normalizeThresholds([0, 101, 1.5, "x", 100]), [100]);
  assert.deepEqual(normalizeThresholds([]), [80, 95]);
  assert.deepEqual(normalizeThresholds("nope"), [80, 95]);
  assert.deepEqual(normalizeThresholds(undefined), [80, 95]);
});

test("below every threshold: no alert", () => {
  const r = evaluateAlerts({}, usage(25, 30), T, NOW);
  assert.deepEqual(r.alerts, []);
});

test("crossing a threshold alerts once; staying above does not repeat", () => {
  const first = evaluateAlerts({}, usage(82, 10), T, NOW);
  assert.equal(first.alerts.length, 1);
  assert.deepEqual([first.alerts[0]?.kind, first.alerts[0]?.threshold, first.alerts[0]?.percent], ["window", 80, 82]);
  const again = evaluateAlerts(first.state, usage(84, 10), T, NOW);
  assert.deepEqual(again.alerts, [], "still above 80: no repeat");
  const higher = evaluateAlerts(again.state, usage(96, 10), T, NOW);
  assert.deepEqual([higher.alerts[0]?.threshold, higher.alerts[0]?.percent], [95, 96], "the next threshold alerts");
});

test("a jump over several thresholds raises one alert, for the highest, and marks all as fired", () => {
  const r = evaluateAlerts({}, usage(97, 0), T, NOW);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0]?.threshold, 95);
  assert.equal(r.state["window:80"], true);
  assert.deepEqual(evaluateAlerts(r.state, usage(97, 0), T, NOW).alerts, []);
});

test("re-arms when the percentage drops back below (the window reset)", () => {
  let s: AlertState = evaluateAlerts({}, usage(90, 0), T, NOW).state;
  s = evaluateAlerts(s, usage(3, 0), T, NOW).state;
  assert.equal(s["window:80"], false);
  assert.equal(evaluateAlerts(s, usage(85, 0), T, NOW).alerts.length, 1, "alerts again in the new window");
});

test("each window alerts on its own; both can alert in one observation", () => {
  const r = evaluateAlerts({}, usage(81, 96), T, NOW);
  assert.deepEqual(r.alerts.map((a) => [a.kind, a.threshold]), [["window", 80], ["weekly", 95]]);
});

test("over 100 percent is valid and alerts at the highest threshold", () => {
  const r = evaluateAlerts({}, usage(130, 0), T, NOW);
  assert.equal(r.alerts[0]?.threshold, 95);
  assert.equal(r.alerts[0]?.percent, 130);
  assert.deepEqual(evaluateAlerts({}, usage(100, 0), [100], NOW).alerts.map((a) => a.threshold), [100]);
});

test("expired data (reset time in the past) raises nothing and re-arms everything", () => {
  const fired = evaluateAlerts({}, usage(90, 0), T, NOW).state;
  const expired = evaluateAlerts(fired, usage(90, 0, { windowResetsAtMs: NOW - 1000 }), T, NOW);
  assert.deepEqual(expired.alerts, []);
  assert.equal(expired.state["window:80"], false);
  assert.equal(expired.state["window:95"], false);
});

test("an observation with only one window does not touch the other", () => {
  const prior: AlertState = { "weekly:80": true };
  const r = evaluateAlerts(prior, usage(10, undefined), T, NOW);
  assert.equal(r.state["weekly:80"], true);
  assert.deepEqual(r.alerts, []);
});

test("alert text and relative times", () => {
  assert.equal(describeAlert({ kind: "window", threshold: 95, percent: 96, resetsAtMs: NOW + 125 * 60_000 }, NOW), "5-hour usage is at 96% (alert at 95%), resets in 2 h 5 min.");
  assert.equal(describeAlert({ kind: "weekly", threshold: 80, percent: 81 }, NOW), "Weekly usage is at 81% (alert at 80%).");
  assert.equal(formatRelative(-5), "now");
  assert.equal(formatRelative(30 * 60_000), "in 30 min");
  assert.equal(formatRelative(3 * 86400_000), "in 3 d");
});

test("usage/changed (observed shape) maps with its observation time; tier id is dropped", () => {
  const e = mapNotification("usage/changed", { window: { usedPercent: 25, windowDurationMins: 300, resetsAtMs: 1793459543000 }, weekly: { usedPercent: 30, resetsAtMs: 1793577600000 }, tier: "27681527378179523", observedAtMs: 1793458930529 });
  assert.deepEqual(e, { type: "usage", windowPercent: 25, windowResetsAtMs: 1793459543000, weeklyPercent: 30, weeklyResetsAtMs: 1793577600000, observedAtMs: 1793458930529 });
  assert.equal(JSON.stringify(e).includes("27681527378179523"), false, "the provider's tier id is never carried");
  assert.equal(mapNotification("usage/changed", {}), undefined);
});

test("session/tokenUsage (observed shape) carries an event id for counting once, and the running total", () => {
  const e = mapNotification("session/tokenUsage", { modelId: "muse-wonder-1.0", usage: { inputTokens: 41910, outputTokens: 13, reasoningTokens: 3 }, promptTokens: 41910, totalTokens: 41923, cumulative: { promptTokens: 41910, outputTokens: 13, totalTokens: 41923 }, sourceRange: { stream: { kind: "session", id: "s" }, first: { id: "ev-1", sequence: 68 }, last: { id: "ev-1", sequence: 68 } } });
  assert.equal(e?.type === "tokens" && e.eventId, "ev-1");
  assert.equal(e?.type === "tokens" && e.cumulativeTotal, 41923);
  assert.equal(e?.type === "tokens" && e.totalTokens, 41923);
});

test("ledger: sums per local day and counts an event id only once", () => {
  const day1 = new Date(2026, 9, 31, 10, 0);
  const l = new TokenLedger();
  assert.equal(l.record("a", 1000, day1), true);
  assert.equal(l.record("a", 1000, day1), false, "a replayed event is not counted twice");
  assert.equal(l.record("b", 500, day1), true);
  assert.equal(l.today(day1), 1500);
  assert.equal(l.record(undefined, 10, day1), true, "no id: counted (cannot be deduplicated)");
  assert.equal(l.record("c", 0, day1), false);
  assert.equal(l.record("d", -5, day1), false);
  assert.equal(l.record("e", Number.NaN, day1), false);
  assert.equal(l.today(day1), 1510);
});

test("ledger: new day starts at zero; last-N-days spans days; old days are pruned", () => {
  const d0 = new Date(2026, 9, 31, 23, 50);
  const d1 = new Date(2026, 10, 1, 0, 10);
  const l = new TokenLedger();
  l.record("a", 100, d0);
  l.record("b", 50, d1);
  assert.equal(l.today(d0), 100);
  assert.equal(l.today(d1), 50);
  assert.equal(l.lastDays(2, d1), 150);
  assert.equal(l.lastDays(1, d1), 50);
  const far = new Date(2026, 11, 31);
  l.record("c", 1, far);
  assert.equal(Object.keys(l.toJSON().days).includes(dayKey(d0)), false, "days older than the retention window are dropped");
});

test("ledger: persists and restores; the seen list is bounded", () => {
  const at = new Date(2026, 9, 31, 12, 0);
  const a = new TokenLedger();
  for (let i = 0; i < 600; i++) a.record(`e${i}`, 1, at);
  const saved = a.toJSON();
  assert.equal(saved.seen.length, 500);
  assert.equal(saved.days[dayKey(at)], 600);
  const b = new TokenLedger(JSON.parse(JSON.stringify(saved)));
  assert.equal(b.today(at), 600);
  assert.equal(b.record("e599", 1, at), false, "still remembers recent ids after a restore");
});

test("refreshUsage negotiates the experimental API on its own host and maps the result without the tier id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-usage-"));
  const reportPath = join(dir, "report.json");
  const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  try {
    const r = await refreshUsage({ binary: process.execPath, binaryArgs: [fake], cwd: dir, env: { ...process.env, FAKE_MUSE_REPORT: reportPath } });
    assert.equal(r.plan, "Test Plan");
    assert.equal(r.subscriptionActive, true);
    assert.equal(r.usage?.windowPercent, 42);
    assert.equal(r.usage?.weeklyPercent, 7);
    assert.equal(JSON.stringify(r).includes("opaque-tier-id"), false);
    const report = readReport(reportPath);
    assert.equal(report.refreshes, 1);
    assert.deepEqual((report.initializes[0]?.capabilities as { experimentalApi?: boolean }).experimentalApi, true);
    assert.equal(report.startAttempts.length, 0, "refreshing must not start a session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
