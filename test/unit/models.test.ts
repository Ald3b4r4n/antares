// Model catalog, switching and reasoning effort. The row shape is the real one observed with
// scripts/probe-model.ts; the session behavior is checked against the fake MSP host.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffCatalog, mapModels, mapNotification, type ChatEvent } from "../../src/muse/events.ts";
import { MuseSession } from "../../src/muse/session.ts";
import { readReport } from "../fixtures/report.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function run(options: { modelId?: string; effort?: string; mode?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-models-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({
    binary: process.execPath,
    binaryArgs: [fake],
    workspaceRoot: dir,
    profile: ":ask-me",
    modelId: options.modelId,
    effort: options.effort,
    env: { ...process.env, FAKE_MUSE_REPORT: reportPath, ...(options.mode ? { FAKE_MUSE_MODE: options.mode } : {}) },
  });
  const events: ChatEvent[] = [];
  session.on("event", (e: ChatEvent) => events.push(e));
  const report = () => readReport(reportPath);
  const done = async () => {
    await session.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { session, events, report, done };
}

test("mapModels (observed row shape): ids, context, tiers and their notes", () => {
  const models = mapModels({
    providerId: "meta",
    profileId: "tbh",
    source: "providerCatalog",
    models: [
      { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", providerId: "meta", profileId: "tbh", releaseDate: "2026-10-12", description: null, contextLimit: 1007997, outputLimit: 128000, cost: null, isActive: true, isDefault: true, variants: ["minimal", "low", "medium", "high", "xhigh", "max"], reasoningEffortVariants: [], defaultReasoningEffort: "high" },
      { modelId: "muse-spark-1.2", displayLabel: "muse-spark-1.2", providerId: "meta", profileId: "tbh", contextLimit: 1007997, isActive: false, isDefault: false, variants: ["minimal", "xhigh"], reasoningEffortVariants: [{ tier: "xhigh", description: "Use this for deepest analysis and complex fixes." }], defaultReasoningEffort: "high" },
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0]?.isActive, true);
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[0]?.providerId, "meta");
  assert.deepEqual(models[0]?.variants, ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(models[1]?.effortNotes, { xhigh: "Use this for deepest analysis and complex fixes." });
  assert.deepEqual(mapModels({ models: [] }), []);
  assert.deepEqual(mapModels(null), []);
});

test("session/modelChanged and reasoningEffortChanged (observed shapes) map", () => {
  assert.deepEqual(mapNotification("session/modelChanged", { modelId: "muse-spark-1.3", providerId: "meta", source: "user" }), { type: "modelChanged", modelId: "muse-spark-1.3", providerId: "meta", source: "user" });
  assert.deepEqual(mapNotification("session/reasoningEffortChanged", { reasoningEffort: "low", source: "user" }), { type: "effortChanged", effort: "low", source: "user" });
});

test("warm: the catalog is available before any session exists, and no session is started", async () => {
  const t = run();
  try {
    await t.session.warm();
    const models = t.events.find((e) => e.type === "models");
    assert.ok(models && models.type === "models" && models.models.length === 2);
    assert.ok(models.models.every((m) => !m.isActive), "nothing is active before a session exists");
    assert.equal(t.report().startAttempts.length, 0, "warming must not start a session");
    await until(() => t.report().listParams.length >= 1, "model/list to be recorded");
    assert.deepEqual(t.report().listParams[0], {});
  } finally {
    await t.done();
  }
});

test("a remembered model is used at session start and flagged active", async () => {
  const t = run({ modelId: "muse-spark-1.2" });
  try {
    await t.session.warm();
    await t.session.start();
    await until(() => t.report().startParams.modelId === "muse-spark-1.2", "start with the remembered model");
    await until(() => t.events.some((e) => e.type === "models" && e.models.some((m) => m.isActive)), "active flag");
    const last = [...t.events].reverse().find((e) => e.type === "models");
    assert.equal(last?.type === "models" && last.models.find((m) => m.isActive)?.modelId, "muse-spark-1.2");
  } finally {
    await t.done();
  }
});

test("a remembered model that is gone falls back to the default with a notice", async () => {
  const t = run({ modelId: "gone" });
  try {
    await t.session.start();
    await until(() => t.report().startAttempts.length === 2, "both start attempts");
    const attempts = t.report().startAttempts;
    assert.equal(attempts[0]?.modelId, "gone");
    assert.equal("modelId" in (attempts[1] ?? {}), false, "the retry must not name the missing model");
    assert.ok(t.events.some((e) => e.type === "notice" && e.level === "warning" && /not available/.test(e.text)));
  } finally {
    await t.done();
  }
});

test("setModel before a session is remembered for the start; after, it uses session/setModel with the full selection", async () => {
  const t = run();
  try {
    await t.session.warm();
    await t.session.setModel("muse-spark-1.2");
    assert.equal(t.report().setModels.length, 0, "no session yet, so nothing to send");
    await t.session.start();
    await until(() => t.report().startParams.modelId === "muse-spark-1.2", "start with the remembered model");

    await t.session.setModel("muse-wonder-1.0");
    await until(() => t.report().setModels.length === 1, "session/setModel");
    const sent = t.report().setModels[0];
    assert.deepEqual(sent?.model, { modelId: "muse-wonder-1.0", providerId: "meta", profileId: "tbh", displayLabel: "muse-wonder-1.0" });
    await until(() => t.events.some((e) => e.type === "modelChanged" && e.modelId === "muse-wonder-1.0"), "modelChanged event");
  } finally {
    await t.done();
  }
});

test("reasoning effort rides on each turn only when chosen", async () => {
  const t = run({ mode: "no-approval" });
  try {
    await t.session.send("one");
    t.session.setEffort("low");
    await until(() => t.events.some((e) => e.type === "turnCompleted"), "first turn");
    await t.session.send("two");
    t.session.setEffort(undefined);
    await t.session.send("three");
    await until(() => t.report().turnStarts.length === 3, "three turns");
    const [a, b, c] = t.report().turnStarts;
    assert.equal("reasoningEffort" in (a ?? {}), false, "default: nothing sent");
    assert.equal(b?.reasoningEffort, "low");
    assert.equal("reasoningEffort" in (c ?? {}), false, "back to default: nothing sent");
  } finally {
    await t.done();
  }
});

// ---- B1: a catalog that can be refreshed, that says when it is out of date, and that reports changes ----


function runCatalog(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "antares-models-"));
  const session = new MuseSession({ binary: process.execPath, binaryArgs: [fake], workspaceRoot: dir, profile: ":ask-me", env: { ...process.env, FAKE_MUSE_REPORT: join(dir, "report.json"), ...env } });
  const events: ChatEvent[] = [];
  session.on("event", (e: ChatEvent) => events.push(e));
  const statuses = () => events.filter((e) => e.type === "modelsStatus");
  return { session, events, statuses, done: async () => { await session.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("diffCatalog names what was added and what is gone", () => {
  const row = (modelId: string) => ({ modelId, label: modelId, isDefault: false, isActive: false, variants: [], effortNotes: {} });
  assert.deepEqual(diffCatalog([row("a"), row("b")], [row("b"), row("c")]), { added: ["c"], removed: ["a"] });
  assert.deepEqual(diffCatalog([row("a")], [row("a")]), { added: [], removed: [] });
  assert.deepEqual(diffCatalog([], [row("a")]), { added: [], removed: [] }, "the first catalog is not a change");
});

test("a successful refresh says the catalog is current and where it came from", async () => {
  const t = runCatalog({});
  try {
    await t.session.warm();
    const s = t.statuses().at(-1);
    assert.ok(s && s.type === "modelsStatus");
    assert.equal(s.stale, false);
    assert.equal(s.source, "providerCatalog");
    assert.equal(typeof s.fetchedAtMs, "number");
  } finally {
    await t.done();
  }
});

test("a refresh that fails keeps the last good catalog, marks it out of date and says why (once)", async () => {
  const t = runCatalog({ FAKE_MUSE_LIST: "fail" });
  try {
    await t.session.warm();
    const before = t.session.currentCatalog().length;
    assert.equal(before, 2);
    await t.session.refreshModels();
    await t.session.refreshModels();
    const s = t.statuses().at(-1);
    assert.ok(s && s.type === "modelsStatus" && s.stale === true);
    assert.match(s.error ?? "", /catalog backend unavailable/);
    assert.equal(t.session.currentCatalog().length, 2, "the last good catalog stays");
    const warnings = t.events.filter((e) => e.type === "notice" && e.level === "warning" && /model list/i.test(e.text));
    assert.equal(warnings.length, 1, "one warning, not one per failed refresh");
  } finally {
    await t.done();
  }
});

test("an empty reply after a good catalog is treated as out of date, not as 'no models'", async () => {
  const t = runCatalog({ FAKE_MUSE_LIST: "empty" });
  try {
    await t.session.warm();
    await t.session.refreshModels();
    const s = t.statuses().at(-1);
    assert.ok(s && s.type === "modelsStatus" && s.stale === true);
    assert.match(s.error ?? "", /empty/i);
    assert.equal(t.session.currentCatalog().length, 2);
  } finally {
    await t.done();
  }
});

test("a catalog that gains or loses a model is announced, and the picker gets the new rows", async () => {
  const dropped = runCatalog({ FAKE_MUSE_LIST: "drop" });
  try {
    await dropped.session.warm();
    await dropped.session.refreshModels();
    const note = dropped.events.find((e) => e.type === "notice" && /catalog changed/i.test(e.text));
    assert.ok(note && note.type === "notice" && /no longer available: muse-spark-1\.2/.test(note.text), JSON.stringify(note));
    assert.equal(dropped.session.currentCatalog().length, 1);
  } finally {
    await dropped.done();
  }
  const added = runCatalog({ FAKE_MUSE_LIST: "add" });
  try {
    await added.session.warm();
    await added.session.refreshModels();
    const note = added.events.find((e) => e.type === "notice" && /catalog changed/i.test(e.text));
    assert.ok(note && note.type === "notice" && /new: muse-spark-2\.0/.test(note.text), JSON.stringify(note));
  } finally {
    await added.done();
  }
});

test("a refresh that works again after a failure clears the out-of-date mark", async () => {
  const t = runCatalog({ FAKE_MUSE_LIST: "fail", FAKE_MUSE_LIST_AFTER: "1" });
  try {
    await t.session.warm();
    await t.session.refreshModels();
    assert.equal((t.statuses().at(-1) as { stale: boolean }).stale, true);
  } finally {
    await t.done();
  }
  const ok = runCatalog({});
  try {
    await ok.session.warm();
    await ok.session.refreshModels();
    assert.equal((ok.statuses().at(-1) as { stale: boolean }).stale, false);
  } finally {
    await ok.done();
  }
});
