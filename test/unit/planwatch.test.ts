// Following the subscription: when the plan changes, or the window comes back to the front after a while, the model list is read
// again (a bigger plan can bring models; the host decides which). These are the decisions, kept apart from the editor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanWatch, shouldRefreshCatalog } from "../../src/muse/planWatch.ts";

test("the first plan seen is remembered, not treated as a change", () => {
  const w = new PlanWatch();
  assert.deepEqual(w.observe("Everyday"), { changed: false });
  assert.deepEqual(w.observe("Everyday"), { changed: false });
});

test("a different plan is a change, once, and reports the old one", () => {
  const w = new PlanWatch();
  w.observe("Everyday");
  assert.deepEqual(w.observe("Power"), { changed: true, from: "Everyday", to: "Power" });
  assert.deepEqual(w.observe("Power"), { changed: false });
});

test("a reading without a plan name changes nothing and does not forget the last plan", () => {
  const w = new PlanWatch();
  w.observe("Everyday");
  assert.deepEqual(w.observe(undefined), { changed: false });
  assert.deepEqual(w.observe(""), { changed: false });
  assert.deepEqual(w.observe("Everyday"), { changed: false }, "the same plan after a gap is still the same plan");
  assert.deepEqual(w.observe("Power"), { changed: true, from: "Everyday", to: "Power" });
});

test("shouldRefreshCatalog: only when the last read is old enough, never while a turn runs, never without a host", () => {
  const min = 60_000;
  assert.equal(shouldRefreshCatalog({ lastReadMs: 0, nowMs: 11 * min, minAgeMs: 10 * min, turnRunning: false, hostRunning: true }), true);
  assert.equal(shouldRefreshCatalog({ lastReadMs: 5 * min, nowMs: 11 * min, minAgeMs: 10 * min, turnRunning: false, hostRunning: true }), false, "read recently");
  assert.equal(shouldRefreshCatalog({ lastReadMs: 0, nowMs: 11 * min, minAgeMs: 10 * min, turnRunning: true, hostRunning: true }), false, "a turn is running");
  assert.equal(shouldRefreshCatalog({ lastReadMs: 0, nowMs: 11 * min, minAgeMs: 10 * min, turnRunning: false, hostRunning: false }), false, "no host to ask");
  assert.equal(shouldRefreshCatalog({ lastReadMs: undefined, nowMs: 1, minAgeMs: 10 * min, turnRunning: false, hostRunning: true }), true, "never read");
});
