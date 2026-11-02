// The skills manager's CLI side: reading `muse skills list --json` (which, unlike MSP's skill/list, says whether each
// skill is on, user-invocable-only or off), changing activation and verifying it, and installing from a folder.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findConflicts, installSkill, listManagedSkills, mapSkillList, setSkillActivation, uninstallSkill, validateSkill } from "../../src/muse/skillsCli.ts";

const fakeCli = new URL("../fixtures/fake-muse-cli.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function setup(rows: unknown[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-skills-"));
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify(rows));
  const options = { binary: process.execPath, binaryArgs: [fakeCli], cwd: dir, env: { ...process.env, FAKE_SKILLS_STATE: state, ...env } };
  const calls = () => readFileSync(`${state}.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { sub: string; args: string[] });
  return { dir, options, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("mapSkillList keeps scope, origin, path, activation (CLI spelling mapped to MSP's), diagnostics and cost", () => {
  const skills = mapSkillList({
    skills: [
      { id: "a", name: "a", display_name: "A", description: "d", scope: "user", source: { type: "local" }, path: "$HOME/a/SKILL.md", activation: "user-invocable-only", diagnostics: [{ severity: "warning", message: "careful" }], context_cost: { startup_estimated_tokens: 30 } },
      { id: "b", scope: "plugin", source: { type: "plugin", plugin_id: "p@m" }, activation: "off" },
      { id: "c", scope: "built-in", activation: "something-new" },
      { name: "no-id" },
      "junk",
    ],
  });
  assert.equal(skills.length, 3);
  assert.deepEqual({ id: skills[0]?.id, name: skills[0]?.displayName, scope: skills[0]?.scope, activation: skills[0]?.activation, tokens: skills[0]?.startupTokens, diag: skills[0]?.diagnostics }, { id: "a", name: "A", scope: "user", activation: "userInvocableOnly", tokens: 30, diag: ["warning: careful"] });
  assert.equal(skills[1]?.activation, "off");
  assert.match(skills[1]?.origin ?? "", /plugin/);
  assert.equal(skills[2]?.activation, "unknown", "an activation Antares does not know is shown as unknown, never guessed");
  assert.deepEqual(mapSkillList(null), []);
});

test("findConflicts reports a name offered by more than one skill, with where each lives", () => {
  const skills = mapSkillList({ skills: [{ id: "plan", scope: "built-in" }, { id: "plan", scope: "user" }, { id: "solo", scope: "user" }, { id: "x", name: "plan", scope: "plugin" }] });
  const conflicts = findConflicts(skills);
  assert.deepEqual([...conflicts.keys()], ["plan"]);
  assert.deepEqual(conflicts.get("plan")?.map((s) => s.scope).sort(), ["built-in", "plugin", "user"]);
});

test("listManagedSkills reads the CLI's JSON and passes the workspace (without trusting it)", async () => {
  const t = setup([{ id: "one", activation: "off" }, { id: "two" }]);
  try {
    const skills = await listManagedSkills(t.options);
    assert.deepEqual(skills.map((s) => [s.id, s.activation]), [["one", "off"], ["two", "on"]]);
    const call = t.calls()[0];
    assert.equal(call?.sub, "list");
    assert.ok(call?.args.includes("--json") && call.args.includes("--workspace"));
    assert.equal(call?.args.includes("--trust-workspace"), false, "listing must not trust the workspace");
  } finally {
    t.done();
  }
});

test("setSkillActivation maps the three states to enable / user-only / disable and checks the result", async () => {
  const t = setup([{ id: "s" }]);
  try {
    assert.equal(await setSkillActivation(t.options, { id: "s", scope: "user", activation: "off" }), "off");
    assert.equal(await setSkillActivation(t.options, { id: "s", scope: "user", activation: "userInvocableOnly" }), "userInvocableOnly");
    assert.equal(await setSkillActivation(t.options, { id: "s", scope: "user", activation: "on" }), "on");
    const writes = t.calls().filter((c) => c.sub !== "list").map((c) => [c.sub, c.args[2], c.args[c.args.indexOf("--scope") + 1]]);
    assert.deepEqual(writes, [["disable", "s", "user"], ["user-only", "s", "user"], ["enable", "s", "user"]]);
  } finally {
    t.done();
  }
});

test("a built-in skill is listed as \"bundled\" but the verbs call that scope \"built-in\"", async () => {
  const t = setup([{ id: "plan", scope: "bundled" }]);
  try {
    assert.equal(await setSkillActivation(t.options, { id: "plan", scope: "bundled", activation: "off" }), "off");
    const write = t.calls().find((c) => c.sub === "disable");
    assert.equal(write?.args[write.args.indexOf("--scope") + 1], "built-in");
  } finally {
    t.done();
  }
});

test("setSkillActivation does not claim success when the CLI says yes but the list says otherwise", async () => {
  const t = setup([{ id: "s" }], { FAKE_SKILLS_MODE: "ignore" });
  try {
    await assert.rejects(setSkillActivation(t.options, { id: "s", scope: "user", activation: "off" }), /still/i);
  } finally {
    t.done();
  }
});

test("setSkillActivation surfaces the CLI's own error", async () => {
  const t = setup([{ id: "s" }], { FAKE_SKILLS_MODE: "fail" });
  try {
    await assert.rejects(setSkillActivation(t.options, { id: "s", scope: "user", activation: "off" }), /access denied/);
  } finally {
    t.done();
  }
});

test("validateSkill previews a folder without installing it, and reports an invalid one", async () => {
  const t = setup([]);
  try {
    const ok = await validateSkill(t.options, join(t.dir, "demo"));
    assert.equal(ok.valid, true);
    assert.equal(ok.id, "demo");
    assert.deepEqual(ok.allowedTools, ["shell"]);
    assert.ok(ok.diagnostics.some((d) => /unknown field/.test(d)));
    const bad = await validateSkill(t.options, join(t.dir, "bad-skill"));
    assert.equal(bad.valid, false);
    assert.ok(bad.diagnostics.some((d) => /missing a description/.test(d)));
    assert.equal(t.calls().some((c) => c.sub === "install"), false, "validating installs nothing");
  } finally {
    t.done();
  }
});

test("installSkill installs into the user scope, refuses an existing id unless forced, and uninstallSkill removes it", async () => {
  const t = setup([]);
  try {
    assert.equal((await installSkill(t.options, join(t.dir, "demo"), { force: false })).id, "demo");
    await assert.rejects(installSkill(t.options, join(t.dir, "demo"), { force: false }), /already exists/);
    await installSkill(t.options, join(t.dir, "demo"), { force: true });
    const install = t.calls().filter((c) => c.sub === "install").at(-1);
    assert.ok(install?.args.includes("--force") && install.args.includes("--scope"));
    await uninstallSkill(t.options, "demo");
    assert.deepEqual((await listManagedSkills(t.options)).map((s) => s.id), []);
  } finally {
    t.done();
  }
});
