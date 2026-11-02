// MCP servers in Muse's own settings.json: read without ever returning a secret, validate, edit with everything else
// preserved, and save atomically with a backup. Shapes are the ones in the user's real file and the ones the CLI
// accepted on muse 1.4.14 (`mcpServers` and `mcp_servers`, entries `{transport, command|url, mode, ...}`).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdit, buildProbeConfig, museConfigPath, parseMcpConfig, saveConfig, validateInput } from "../../src/muse/mcpSettings.ts";

const REAL_SHAPE = JSON.stringify({
  schema_version: 1,
  model_reasoning_efforts: { "muse-wonder-1.0": "medium" },
  mcpServers: {
    "ai-memory": { mode: "optional", transport: "streamable_http", url: "http://127.0.0.1:49374/mcp" },
    tools: { mode: "optional", transport: "stdio", command: "C:\\py\\python.exe", args: ["-m", "tools.server"], env: { API_TOKEN: "s3cret-token-value" } },
  },
  contributor_mode_enabled: true,
  permissions: { schema_version: 1, default_profile: ":unrestricted" },
}, null, 2);

test("museConfigPath follows XDG_CONFIG_HOME, else ~/.config/muse", () => {
  assert.equal(museConfigPath({ XDG_CONFIG_HOME: "C:\\cfg" }), join("C:\\cfg", "muse", "settings.json"));
  assert.equal(museConfigPath({}), join(homedir(), ".config", "muse", "settings.json"));
});

test("parseMcpConfig reads the real shape and never returns a secret", () => {
  const config = parseMcpConfig(REAL_SHAPE, "p");
  assert.equal(config.key, "mcpServers");
  assert.deepEqual(config.entries.map((e) => [e.name, e.transport, e.mode, e.enabled]), [["ai-memory", "streamable_http", "optional", true], ["tools", "stdio", "optional", true]]);
  const tools = config.entries[1]!;
  assert.deepEqual(tools.envKeys, ["API_TOKEN"]);
  assert.deepEqual(tools.args, ["-m", "tools.server"]);
  assert.equal(JSON.stringify(config).includes("s3cret-token-value"), false, "a secret must never leave the parser");
});

test("parseMcpConfig finds problems instead of throwing", () => {
  const config = parseMcpConfig(JSON.stringify({ mcp_servers: { a: { transport: "stdio" }, b: { transport: "streamable_http" }, c: { transport: "carrier-pigeon" }, d: { transport: "streamable_http", url: "ftp://x", framing: "auto" }, e: { transport: "stdio", command: "x", mode: "sometimes" } } }), "p");
  assert.equal(config.key, "mcp_servers");
  const by = (n: string) => config.entries.find((e) => e.name === n)!;
  assert.match(by("a").problems.join(" "), /command/);
  assert.match(by("b").problems.join(" "), /url/);
  assert.match(by("c").problems.join(" "), /transport/);
  assert.match(by("d").problems.join(" "), /http\(s\)/);
  assert.match(by("d").problems.join(" "), /framing/);
  assert.match(by("e").problems.join(" "), /mode/);
});

test("both spellings in one file is reported, with the names that clash", () => {
  const config = parseMcpConfig(JSON.stringify({ mcpServers: { x: { transport: "stdio", command: "a" } }, mcp_servers: { x: { transport: "stdio", command: "b" }, y: { transport: "stdio", command: "c" } } }), "p");
  assert.equal(config.key, "both");
  assert.match(config.warnings.join(" "), /both/);
  assert.match(config.warnings.join(" "), /x/);
});

test("a missing file and a malformed file are states, not exceptions", () => {
  const missing = parseMcpConfig(undefined, "p");
  assert.deepEqual([missing.exists, missing.key, missing.entries.length], [false, "none", 0]);
  const broken = parseMcpConfig("{ not json", "p");
  assert.equal(broken.exists, true);
  assert.match(broken.parseError ?? "", /JSON/i);
  assert.equal(broken.entries.length, 0);
});

test("validateInput rejects what Muse would reject, and bad names", () => {
  assert.deepEqual(validateInput({ name: "ok-1.x_y", transport: "stdio", command: "node" }), []);
  assert.deepEqual(validateInput({ name: "web", transport: "streamable_http", url: "https://example.test/mcp" }), []);
  assert.match(validateInput({ name: "", transport: "stdio", command: "x" }).join(" "), /name/);
  assert.match(validateInput({ name: "has space", transport: "stdio", command: "x" }).join(" "), /name/);
  assert.match(validateInput({ name: "a", transport: "stdio", command: "" }).join(" "), /command/);
  assert.match(validateInput({ name: "a", transport: "streamable_http", url: "file:///x" }).join(" "), /http\(s\)/);
  assert.match(validateInput({ name: "a", transport: "stdio", command: "x", env: { "bad key": "v" } }).join(" "), /variable name/);
});

test("applyEdit adds a server under the existing key and leaves every other setting exactly as it was", () => {
  const next = applyEdit(REAL_SHAPE, { op: "upsert", input: { name: "mini", transport: "stdio", command: "node", args: ["mini.mjs"], mode: "optional" } });
  const before = JSON.parse(REAL_SHAPE);
  const after = JSON.parse(next);
  assert.deepEqual(Object.keys(after), Object.keys(before), "top-level keys and their order are kept");
  assert.deepEqual({ ...after, mcpServers: undefined }, { ...before, mcpServers: undefined });
  assert.deepEqual(Object.keys(after.mcpServers), ["ai-memory", "tools", "mini"]);
  assert.deepEqual(after.mcpServers.mini, { transport: "stdio", command: "node", args: ["mini.mjs"], mode: "optional" });
  assert.deepEqual(after.mcpServers["ai-memory"], before.mcpServers["ai-memory"]);
});

test("applyEdit on a new file creates mcpServers; on mcp_servers it keeps that spelling", () => {
  assert.deepEqual(Object.keys(JSON.parse(applyEdit(undefined, { op: "upsert", input: { name: "a", transport: "stdio", command: "x" } }))), ["schema_version", "mcpServers"]);
  const kept = JSON.parse(applyEdit(JSON.stringify({ schema_version: 1, mcp_servers: {} }), { op: "upsert", input: { name: "a", transport: "stdio", command: "x" } }));
  assert.ok(kept.mcp_servers.a && !kept.mcpServers);
});

test("editing a server keeps its secrets unless new ones are given, and its unknown fields", () => {
  const withExtra = JSON.stringify({ schema_version: 1, mcpServers: { tools: { transport: "stdio", command: "old", env: { API_TOKEN: "keep-me" }, custom_note: "x" } } });
  const kept = JSON.parse(applyEdit(withExtra, { op: "upsert", input: { name: "tools", transport: "stdio", command: "new" } }));
  assert.equal(kept.mcpServers.tools.command, "new");
  assert.deepEqual(kept.mcpServers.tools.env, { API_TOKEN: "keep-me" });
  assert.equal(kept.mcpServers.tools.custom_note, "x");
  const replaced = JSON.parse(applyEdit(withExtra, { op: "upsert", input: { name: "tools", transport: "stdio", command: "new", env: { OTHER: "1" } } }));
  assert.deepEqual(replaced.mcpServers.tools.env, { OTHER: "1" });
});

test("applyEdit removes a server and switches one on or off", () => {
  const removed = JSON.parse(applyEdit(REAL_SHAPE, { op: "remove", name: "tools" }));
  assert.deepEqual(Object.keys(removed.mcpServers), ["ai-memory"]);
  const off = JSON.parse(applyEdit(REAL_SHAPE, { op: "setEnabled", name: "tools", enabled: false }));
  assert.equal(off.mcpServers.tools.enabled, false);
  assert.throws(() => applyEdit(REAL_SHAPE, { op: "remove", name: "nope" }), /no server/i);
  assert.throws(() => applyEdit("{ not json", { op: "remove", name: "x" }), /JSON/i);
});

test("saveConfig writes atomically, backs up the previous file, and leaves no temp file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-mcpset-"));
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, REAL_SHAPE);
    const fingerprint = parseMcpConfig(REAL_SHAPE, path).fingerprint;
    const next = applyEdit(REAL_SHAPE, { op: "remove", name: "tools" });
    const { backup } = await saveConfig(path, next, fingerprint);
    assert.equal(readFileSync(path, "utf8"), next);
    assert.ok(backup && readFileSync(backup, "utf8") === REAL_SHAPE, "the backup holds the previous content");
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig refuses when the file changed since it was read, and refuses invalid JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-mcpset-"));
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, REAL_SHAPE);
    const fingerprint = parseMcpConfig(REAL_SHAPE, path).fingerprint;
    writeFileSync(path, REAL_SHAPE.replace("medium", "high")); // someone else edited it
    await assert.rejects(saveConfig(path, REAL_SHAPE, fingerprint), /changed/i);
    assert.match(readFileSync(path, "utf8"), /high/, "the other program's edit is untouched");
    await assert.rejects(saveConfig(path, "{ nope", parseMcpConfig(readFileSync(path, "utf8"), path).fingerprint), /JSON/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig creates a missing file (and its folder) without a backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-mcpset-"));
  try {
    const path = join(dir, "nested", "muse", "settings.json");
    const next = applyEdit(undefined, { op: "upsert", input: { name: "a", transport: "stdio", command: "x" } });
    const result = await saveConfig(path, next, parseMcpConfig(undefined, path).fingerprint);
    assert.equal(result.backup, undefined);
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildProbeConfig makes a settings file holding only that server, required, with secrets moved out of the file", () => {
  const probe = buildProbeConfig("tools", { transport: "stdio", command: "node", args: ["x"], env: { API_TOKEN: "s3cret", PLAIN: "${ALREADY_A_REF}" }, mode: "optional", enabled: false });
  const file = JSON.parse(probe.settings);
  assert.deepEqual(Object.keys(file.mcpServers), ["tools"]);
  assert.equal(file.mcpServers.tools.mode, "required");
  assert.equal(file.mcpServers.tools.enabled, true);
  assert.equal(probe.settings.includes("s3cret"), false, "the secret is not written to the file");
  const ref = file.mcpServers.tools.env.API_TOKEN as string;
  assert.match(ref, /^\$\{[A-Z0-9_]+\}$/);
  assert.equal(probe.env[ref.slice(2, -1)], "s3cret", "the secret travels in the process environment");
  assert.equal(file.mcpServers.tools.env.PLAIN, "${ALREADY_A_REF}", "an existing reference is left alone");
});

// ---- the connectors list: settings entries first (what the file says), the host's rows only for what they add ----
import { connectorRows, rawEntry, splitArgs } from "../../src/muse/mcpSettings.ts";

test("splitArgs splits like a shell would for simple cases, keeping quoted groups together", () => {
  assert.deepEqual(splitArgs("-m tools.server --port 8080"), ["-m", "tools.server", "--port", "8080"]);
  assert.deepEqual(splitArgs('--name "two words" \'single quoted\' plain'), ["--name", "two words", "single quoted", "plain"]);
  assert.deepEqual(splitArgs("   "), []);
  assert.deepEqual(splitArgs('a "unterminated b'), ["a", "unterminated b"]);
});

test("connectorRows lists the file's servers (the host's list does not show them) and adds the host's OAuth state by name", () => {
  const config = parseMcpConfig(REAL_SHAPE, "p");
  const rows = connectorRows(config, [{ name: "ai-memory", source: "settings", transport: "streamableHttp", oauth: "loggedOut" }, { name: "from-plugin", source: "plugin", transport: "stdio", oauth: "notSupported" }, { name: "sess", source: "session", transport: "stdio", oauth: "notSupported" }]);
  assert.deepEqual(rows.map((r) => [r.name, r.source, r.editable]), [["ai-memory", "settings", true], ["tools", "settings", true], ["from-plugin", "plugin", false], ["sess", "session", false]]);
  assert.equal(rows[0]!.oauth, "loggedOut", "the host's state is used when it has one");
  assert.equal(rows[1]!.oauth, "notSupported", "a stdio server has no sign-in");
  assert.equal(rows[0]!.target, "http://127.0.0.1:49374", "an HTTP target shows its origin only (a path or query may carry a token)");
  assert.equal(rows[1]!.target, String.raw`C:\py\python.exe (2 arguments)`);
  assert.equal(JSON.stringify(rows).includes("s3cret-token-value"), false);
});

test("an HTTP server the host does not report has an unknown sign-in state, never a guessed one", () => {
  const rows = connectorRows(parseMcpConfig(REAL_SHAPE, "p"), []);
  assert.equal(rows.find((r) => r.name === "ai-memory")!.oauth, "unknown");
});

test("rawEntry returns the stored entry (with its secrets, for Antares' own use) from either spelling", () => {
  assert.equal((rawEntry(REAL_SHAPE, "tools") as { command: string }).command, String.raw`C:\py\python.exe`);
  assert.equal(rawEntry(JSON.stringify({ mcp_servers: { a: { transport: "stdio", command: "x" } } }), "a")?.command, "x");
  assert.equal(rawEntry(REAL_SHAPE, "missing"), undefined);
  assert.equal(rawEntry("{ not json", "x"), undefined);
});
