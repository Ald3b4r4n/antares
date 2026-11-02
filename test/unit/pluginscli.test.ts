// The plugin manager's CLI side (`muse plugins ... --json`): what each installed plugin brings, which of its code-running
// parts (hooks, MCP servers) are still waiting for review, and the lifecycle verbs. Every write is read back, and nothing is
// ever approved except by an explicit call.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideCapability, listManagedPlugins, listMarketplaces, mapInspect, removeMarketplace, removePlugin, setPluginEnabled, updateMarketplace, updatePlugin } from "../../src/muse/pluginsCli.ts";

const fakeCli = new URL("../fixtures/fake-muse-cli.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const DEMO = { id: "antares-demo", version: "0.0.1", description: "A demo.", skills: ["hello"], hooks: [{ id: "hook-1", event: "SessionStart", command: "echo hi" }], mcp: [{ id: "demo-mini", transport: "stdio", command: ["node", "mini.mjs"] }] };

function setup(state: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-plugins-"));
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify(state));
  const options = { binary: process.execPath, binaryArgs: [fakeCli], cwd: dir, env: { ...process.env, FAKE_PLUGINS_STATE: file, ...env } };
  const calls = () => readFileSync(`${file}.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { sub: string; args: string[] });
  return { options, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("mapInspect reads what a plugin brings and the review state of each code-running part", () => {
  const view = mapInspect({
    record: { id: "p", display_name: "Pretty", version: "1.2.3", description: "d", enabled: true, trust: "user-local", source: { provenance: "marketplace", path: "x" } },
    warning: "third-party plugin: hooks and MCP servers require review before activation",
    plugin: { capabilities: { skills: [{ id: "s1" }, { id: "s2" }], hooks: [{ id: "h", event: "PreToolUse", shell_command: "lint --fix" }], mcp_servers: [{ id: "m", transport: "stdio", command: ["node", "srv.js"] }, { id: "web", transport: "streamable_http", url: "https://example.test/mcp?token=abc" }], commands: [{ id: "c" }], reminders: [], session_providers: [] } },
    active: true,
    runtime_capabilities: [
      { candidate: { kind: "hook", capability_id: "h", stable_id: "plugin:p:hook:h", definition_hash: "sha256:1" }, status: "review_needed" },
      { candidate: { kind: "mcp_server", capability_id: "m", stable_id: "plugin:p:mcp_server:m", definition_hash: "sha256:2" }, status: "trusted_enabled" },
      { candidate: { kind: "mcp_server", capability_id: "web", stable_id: "plugin:p:mcp_server:web", definition_hash: "sha256:3" }, status: "trusted_disabled" },
    ],
  });
  assert.deepEqual({ id: view.id, name: view.name, version: view.version, enabled: view.enabled, active: view.active, trust: view.trust, from: view.provenance }, { id: "p", name: "Pretty", version: "1.2.3", enabled: true, active: true, trust: "user-local", from: "marketplace" });
  assert.deepEqual(view.skills, ["s1", "s2"]);
  assert.equal(view.commands, 1);
  const byId = Object.fromEntries(view.runtime.map((r) => [r.capabilityId, r]));
  assert.deepEqual([byId.h?.kind, byId.h?.status, byId.h?.detail], ["hook", "review_needed", "PreToolUse: lint --fix"]);
  assert.deepEqual([byId.m?.kind, byId.m?.status, byId.m?.detail], ["mcp_server", "trusted_enabled", "node srv.js"]);
  assert.equal(byId.web?.detail, "https://example.test", "an HTTP target shows its origin only: a query may carry a token");
  assert.equal(view.needsReview, 1);
  assert.match(view.warning ?? "", /require review/);
});

test("a status Antares does not know is kept as 'unknown', never read as trusted", () => {
  const view = mapInspect({ record: { id: "p" }, plugin: { capabilities: { hooks: [{ id: "h", event: "Stop", shell_command: "x" }] } }, runtime_capabilities: [{ candidate: { kind: "hook", capability_id: "h", stable_id: "s" }, status: "something_new" }] });
  assert.equal(view.runtime[0]?.status, "unknown");
  assert.equal(view.needsReview, 0);
});

test("listManagedPlugins reads the list and inspects each plugin; it approves nothing", async () => {
  const t = setup({ plugins: [DEMO, { id: "second", skills: ["x"] }], marketplaces: [] });
  try {
    const plugins = await listManagedPlugins(t.options);
    assert.deepEqual(plugins.map((p) => p.id), ["antares-demo", "second"]);
    const demo = plugins[0]!;
    assert.deepEqual(demo.runtime.map((r) => [r.kind, r.status]), [["hook", "review_needed"], ["mcp_server", "review_needed"]]);
    assert.equal(demo.needsReview, 2);
    assert.equal(plugins[1]!.needsReview, 0);
    assert.equal(t.calls().some((c) => c.sub === "approve" || c.sub === "reject"), false, "listing must never decide anything");
  } finally {
    t.done();
  }
});

test("decideCapability approves one named part with the CLI's own spelling and checks the status afterwards", async () => {
  const t = setup({ plugins: [DEMO], marketplaces: [] });
  try {
    assert.equal(await decideCapability(t.options, { pluginId: "antares-demo", kind: "mcp_server", capabilityId: "demo-mini", decision: "approve" }), "trusted_enabled");
    assert.equal(await decideCapability(t.options, { pluginId: "antares-demo", kind: "hook", capabilityId: "hook-1", decision: "reject" }), "trusted_disabled");
    const decisions = t.calls().filter((c) => c.sub === "approve" || c.sub === "reject").map((c) => [c.sub, c.args[2]]);
    assert.deepEqual(decisions, [["approve", "antares-demo:mcp_server:demo-mini"], ["reject", "antares-demo:hook:hook-1"]]);
    const after = (await listManagedPlugins(t.options))[0]!;
    assert.equal(after.needsReview, 0);
  } finally {
    t.done();
  }
});

test("decideCapability does not claim success when the status did not change", async () => {
  const t = setup({ plugins: [DEMO], marketplaces: [] }, { FAKE_PLUGINS_MODE: "ignore" });
  try {
    await assert.rejects(decideCapability(t.options, { pluginId: "antares-demo", kind: "hook", capabilityId: "hook-1", decision: "approve" }), /still review_needed/);
  } finally {
    t.done();
  }
});

test("setPluginEnabled switches a plugin and verifies it; a CLI that ignores the request is caught", async () => {
  const t = setup({ plugins: [DEMO], marketplaces: [] });
  try {
    await setPluginEnabled(t.options, "antares-demo", false);
    assert.equal((await listManagedPlugins(t.options))[0]!.enabled, false);
    await setPluginEnabled(t.options, "antares-demo", true);
    assert.equal((await listManagedPlugins(t.options))[0]!.enabled, true);
  } finally {
    t.done();
  }
  const lying = setup({ plugins: [DEMO], marketplaces: [] }, { FAKE_PLUGINS_MODE: "ignore" });
  try {
    await assert.rejects(setPluginEnabled(lying.options, "antares-demo", false), /still enabled/);
  } finally {
    lying.done();
  }
});

test("after an update the parts show the review state the CLI reports (a changed definition needs a new review)", async () => {
  const t = setup({ plugins: [{ ...DEMO, status: { "hook-1": "trusted_enabled", "demo-mini": "trusted_enabled" } }], marketplaces: [] });
  try {
    assert.equal((await listManagedPlugins(t.options))[0]!.needsReview, 0);
    const result = await updatePlugin(t.options, "antares-demo");
    assert.equal(result.updated, true);
    assert.equal((await listManagedPlugins(t.options))[0]!.needsReview, 2, "a changed definition must be reviewed again");
  } finally {
    t.done();
  }
});

test("removePlugin removes the record and verifies it is gone (data is kept unless asked)", async () => {
  const t = setup({ plugins: [DEMO], marketplaces: [] });
  try {
    await removePlugin(t.options, "antares-demo", { deleteData: false });
    assert.deepEqual(await listManagedPlugins(t.options), []);
    assert.equal(t.calls().find((c) => c.sub === "remove")?.args.includes("--delete-data"), false);
  } finally {
    t.done();
  }
  const lying = setup({ plugins: [DEMO], marketplaces: [] }, { FAKE_PLUGINS_MODE: "ignore" });
  try {
    await assert.rejects(removePlugin(lying.options, "antares-demo", { deleteData: false }), /still installed/);
  } finally {
    lying.done();
  }
});

test("marketplaces: list, refresh, remove", async () => {
  const t = setup({ plugins: [], marketplaces: [{ name: "demo-market", source: { kind: "local-dir", path: "C:\\m" }, plugin_count: 2, skipped: 0 }] });
  try {
    assert.deepEqual((await listMarketplaces(t.options)).map((m) => [m.name, m.kind, m.pluginCount]), [["demo-market", "local-dir", 2]]);
    await updateMarketplace(t.options, "demo-market");
    await removeMarketplace(t.options, "demo-market");
    assert.deepEqual(await listMarketplaces(t.options), []);
  } finally {
    t.done();
  }
});
