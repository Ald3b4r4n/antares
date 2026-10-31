// The permission modes: the table is what the selector offers, so what it claims is pinned down here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILES } from "../../src/muse/events.ts";
import { cycleMode, DEFAULT_MODE, MODES, modeById, modeOfProfile, modeRows } from "../../src/muse/modes.ts";

test("modes: five, in the order of the selector, with shortcuts 1 to 5", () => {
  assert.deepEqual(MODES.map((m) => m.id), ["auto", "manual", "acceptEdits", "plan", "bypass"]);
  assert.deepEqual(MODES.map((m) => m.shortcut), [1, 2, 3, 4, 5]);
});

test("modes: each one that can be selected maps to a profile Muse has, and no two share one", () => {
  const known = new Set(PROFILES.map((p) => p.id));
  const profiles = MODES.filter((m) => m.profileId).map((m) => m.profileId!);
  for (const id of profiles) assert.ok(known.has(id), `${id} is not a known profile`);
  assert.equal(new Set(profiles).size, profiles.length, "a profile may belong to one mode only");
  assert.deepEqual(MODES.map((m) => [m.id, m.profileId]), [
    ["auto", ":auto-review"],
    ["manual", undefined],
    ["acceptEdits", ":ask-me"],
    ["plan", ":read-only"],
    ["bypass", ":unrestricted"],
  ]);
});

test("modes: Manual is offered as unavailable with the observed reason, not faked", () => {
  const manual = modeById("manual")!;
  assert.equal(manual.profileId, undefined);
  assert.match(manual.unavailable ?? "", /no profile that asks before every edit/);
  assert.match(manual.unavailable ?? "", /promptUnmatched|strictest prompting mode/);
  for (const m of MODES.filter((x) => x.id !== "manual")) assert.equal(m.unavailable, undefined, `${m.id} should be selectable`);
});

test("modes: everything above Plan asks for confirmation; Plan does not", () => {
  assert.deepEqual(MODES.filter((m) => m.profileId).map((m) => [m.id, m.confirm]), [["auto", true], ["acceptEdits", true], ["plan", false], ["bypass", true]]);
});

test("modes: a chat is in the mode of its profile; the default is Plan (read only)", () => {
  assert.equal(modeOfProfile(":ask-me")?.id, "acceptEdits");
  assert.equal(modeOfProfile(":read-only")?.id, "plan");
  assert.equal(modeOfProfile(":something-managed"), undefined);
  assert.equal(modeOfProfile(undefined), undefined);
  assert.equal(DEFAULT_MODE, "plan");
  assert.equal(modeById(DEFAULT_MODE)?.profileId, ":read-only");
});

test("modes: Shift+Tab visits Auto, Accept edits and Plan, skips Manual, and never lands on Bypass", () => {
  assert.equal(cycleMode("auto"), "acceptEdits");
  assert.equal(cycleMode("acceptEdits"), "plan");
  assert.equal(cycleMode("plan"), "auto");
  assert.equal(cycleMode("manual"), "plan", "an unselectable current mode steps to the safe one");
  assert.equal(cycleMode("bypass"), "plan", "from Bypass it steps down");
  let at = "plan" as ReturnType<typeof cycleMode>;
  for (let i = 0; i < 12; i++) {
    at = cycleMode(at);
    assert.notEqual(at, "bypass");
    assert.notEqual(at, "manual");
  }
});

test("modes: the rows sent to the page carry what it needs and nothing internal", () => {
  const rows = modeRows();
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.ok(r.label && r.short && r.note);
    assert.equal("cycle" in r, false, "the page does not decide the cycle");
  }
  assert.equal(rows.find((r) => r.id === "bypass")?.confirm, true);
});
