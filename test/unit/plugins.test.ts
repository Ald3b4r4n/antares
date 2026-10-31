// Plugin bundles and marketplaces: the CLI's read-only answers (shapes observed on Muse 1.4.14 in a throwaway
// home), the capability wording of the install dialog, and the session's install calls against the fake host.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeCapabilities, mapAvailable, mapValidate } from "../../src/muse/pluginCli.ts";
import { MuseSession } from "../../src/muse/session.ts";
import { readReport } from "../fixtures/report.ts";

const validObserved = {
  valid: true,
  source_path: "C:\\x\\demo",
  plugin: { id: "antares-demo", display_name: null, version: "0.0.1", description: "A harmless demo bundle.", manifest_family: "claude-compatible", capabilities: { skills: [{ id: "hello" }], hooks: [], mcp_servers: [], commands: [], reminders: [], session_providers: [] } },
  capabilities: { skills: [{ id: "hello" }], hooks: [], mcp_servers: [], commands: [], reminders: [] },
  diagnostics: [],
};
const invalidObserved = { error: { code: "missing-manifest", message: "plugin root must contain one supported plugin manifest", details: { valid: false, plugin: null, capabilities: { skills: [], hooks: [], mcp_servers: [], commands: [], reminders: [] }, diagnostics: [{ code: "missing-manifest", severity: "error", message: "plugin root must contain one supported plugin manifest" }] } } };

test("validate: a valid bundle reports its id, version and what it brings", () => {
  const p = mapValidate(validObserved);
  assert.equal(p.valid, true);
  assert.deepEqual([p.id, p.version, p.description], ["antares-demo", "0.0.1", "A harmless demo bundle."]);
  assert.deepEqual([p.skills, p.hooks, p.mcpServers, p.commands, p.reminders], [1, 0, 0, 0, 0]);
  assert.deepEqual(p.diagnostics, []);
});

test("validate: an invalid bundle is refused with the reason, never treated as installable", () => {
  const p = mapValidate(invalidObserved);
  assert.equal(p.valid, false);
  assert.equal(p.id, undefined);
  assert.match(p.diagnostics[0] ?? "", /^error: plugin root must contain/);
  assert.equal(mapValidate("nonsense").valid, false);
  assert.equal(mapValidate({ valid: true }).id, undefined, "a 'valid' answer with no plugin is not enough to install");
});

test("validate: hooks and MCP servers are counted and called out as code", () => {
  const p = mapValidate({ valid: true, plugin: { id: "p", version: "1", capabilities: { skills: [{}, {}], hooks: [{}], mcp_servers: [{}, {}], commands: [], reminders: [] } }, diagnostics: [{ severity: "warning", message: "unusual" }] });
  assert.deepEqual([p.skills, p.hooks, p.mcpServers], [2, 1, 2]);
  assert.equal(describeCapabilities(p), "Brings: 2 skills, 1 HOOK (code that runs on this computer), 2 MCP SERVERS (programs that run on this computer).");
  assert.deepEqual(p.diagnostics, ["warning: unusual"]);
  assert.equal(describeCapabilities(mapValidate({ valid: true, plugin: { id: "p" } })), "Brings nothing Muse recognizes.");
  assert.equal(describeCapabilities(mapValidate(validObserved)), "Brings: 1 skill.");
});

test("available: the marketplace listing is mapped with its install source", () => {
  const rows = mapAvailable({ available: [{ marketplace: "demo-market", name: "antares-demo", version: "0.0.1", status: "available", install: { transport: "local-path", source: "C:\\market\\plugins\\antares-demo" }, digest: "sha256:abc" }, { name: "no marketplace" }], skipped: [], warnings: [] });
  assert.deepEqual(rows, [{ name: "antares-demo", marketplace: "demo-market", version: "0.0.1", source: "C:\\market\\plugins\\antares-demo", status: "available" }]);
  assert.deepEqual(mapAvailable({ available: [], skipped: [], warnings: [] }), []);
  assert.deepEqual(mapAvailable(null), []);
});

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("session: a plugin is installed from a folder or a marketplace with the shapes the host expects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-plug-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({ binary: process.execPath, binaryArgs: [fake], workspaceRoot: dir, profile: ":ask-me", env: { ...process.env, FAKE_MUSE_REPORT: reportPath } });
  try {
    const local = await session.installPlugin({ localPath: "C:\\plugins\\mine" });
    assert.deepEqual(local, { id: "local-demo", version: "1.0.0", enabled: true, warning: "demo caveat" });
    const market = await session.installPlugin({ marketplace: "demo-market", name: "antares-demo" });
    assert.equal(market.id, "antares-demo");
    const installs = readReport(reportPath).pluginInstalls;
    assert.deepEqual(installs[0]?.target, { localPath: { path: "C:\\plugins\\mine" } });
    assert.deepEqual(installs[1]?.target, { marketplace: { marketplace: "demo-market", name: "antares-demo" } });
    assert.equal(installs[0]?.sessionId, "s1");
    const added = await session.addMarketplace("demo-market", "owner/repo");
    assert.deepEqual(added, { name: "demo-market", pluginCount: 2 });
    assert.deepEqual(readReport(reportPath).marketplaceAdds[0] && { name: readReport(reportPath).marketplaceAdds[0]!.name, source: readReport(reportPath).marketplaceAdds[0]!.source }, { name: "demo-market", source: "owner/repo" });
  } finally {
    await session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
