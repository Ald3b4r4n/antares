// "Test this server": Muse itself starts the one server in a throwaway, clean settings file (`muse exec --provider echo`:
// no model, no cost). A required server that cannot start aborts the run, and Muse says why.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { testMcpServer } from "../../src/muse/mcpProbe.ts";

const fakeExec = new URL("../fixtures/fake-muse-exec.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "antares-probe-"));
  const report = join(dir, "report.jsonl");
  const options = { binary: process.execPath, binaryArgs: [fakeExec], env: { ...process.env, FAKE_EXEC_REPORT: report }, timeoutMs: 20_000 };
  return { dir, report, options, seen: () => readFileSync(report, "utf8").trim().split("\n").map((l) => JSON.parse(l)), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a server that starts is reported as started", async () => {
  const t = setup();
  try {
    const r = await testMcpServer("mini", { transport: "stdio", command: "node", args: ["mini.mjs"], mode: "optional", enabled: false }, t.options);
    assert.equal(r.started, true);
  } finally {
    t.done();
  }
});

test("a server that cannot start is reported with Muse's own reason", async () => {
  const t = setup();
  try {
    const r = await testMcpServer("bad", { transport: "stdio", command: "broken-command" }, t.options);
    assert.equal(r.started, false);
    assert.match(r.reason ?? "", /failed during startup: the configured command is unavailable/);
  } finally {
    t.done();
  }
});

test("the probe runs in a clean config holding only that server, forced to required, with the secret in the environment and not in the file", async () => {
  const t = setup();
  try {
    await testMcpServer("tools", { transport: "stdio", command: "node", env: { API_TOKEN: "s3cret" }, mode: "optional" }, t.options);
    const seen = t.seen()[0];
    assert.deepEqual(Object.keys(seen.settings.mcpServers), ["tools"]);
    assert.equal(seen.settings.mcpServers.tools.mode, "required");
    assert.equal(JSON.stringify(seen.settings).includes("s3cret"), false);
    assert.deepEqual(Object.values(seen.secretEnv), ["s3cret"]);
    assert.ok(seen.args.includes("exec") && seen.args.includes("--provider") && seen.args.includes("echo"), "no model is involved");
    assert.notEqual(seen.home, process.env.HOME, "the user's home (and config) is not used");
  } finally {
    t.done();
  }
});

test("the throwaway folder is removed afterwards", async () => {
  const t = setup();
  try {
    await testMcpServer("mini", { transport: "stdio", command: "node" }, t.options);
    const used = t.seen()[0].home as string;
    assert.equal(existsSync(used), false);
  } finally {
    t.done();
  }
});
