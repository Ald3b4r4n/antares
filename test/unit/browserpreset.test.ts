// The browser preset: pure helpers and the install step, with the process runner replaced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdit, parseMcpConfig, validateInput } from "../../src/muse/mcpSettings.ts";
import { browserArgs, browserChannel, browserEnv, findNode, findNpmCli, installBrowserServer, installedCli, LOCAL_ORIGINS, PLAYWRIGHT_MCP_VERSION, type Run } from "../../src/muse/browserPreset.ts";

test("browserChannel prefers Edge, then Chrome, and says nothing when neither is installed", () => {
  const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  assert.equal(browserChannel("win32", (p) => p === "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", env), "msedge");
  assert.equal(browserChannel("win32", (p) => p === "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", env), "chrome");
  assert.equal(browserChannel("win32", () => false, env), undefined);
  assert.equal(browserChannel("linux", (p) => p === "/usr/bin/google-chrome", {}), "chrome");
});

test("browserArgs: isolated, headless, no service workers, the origin filter only for 'local', screenshots to the owned folder", () => {
  const local = browserArgs("C:\\s\\cli.js", "msedge", "local", "C:\\out");
  assert.deepEqual(local, ["C:\\s\\cli.js", "--browser", "msedge", "--isolated", "--headless", "--block-service-workers", "--allowed-origins", LOCAL_ORIGINS, "--output-dir", "C:\\out"]);
  const web = browserArgs("C:\\s\\cli.js", "chrome", "web", "C:\\out");
  assert.ok(!web.includes("--allowed-origins"));
  assert.ok(web.includes("--isolated") && web.includes("--headless"));
});

test("browserEnv copies only the allowed system variables and never a secret or the PATH", () => {
  const out = browserEnv({ SystemRoot: "C:\\Windows", TEMP: "C:\\t", LOCALAPPDATA: "C:\\L", OPENAI_API_KEY: "sk-secret", PATH: "C:\\bin", ANTHROPIC_API_KEY: "x", "ProgramFiles(x86)": "C:\\PF86", EMPTY: "" });
  assert.deepEqual(out, { SystemRoot: "C:\\Windows", TEMP: "C:\\t", LOCALAPPDATA: "C:\\L", "ProgramFiles(x86)": "C:\\PF86" });
});

test("findNode returns the absolute path of node on the PATH, findNpmCli the script next to it", () => {
  const exists = (p: string) => p === "C:\\tools\\node\\node.exe" || p === "C:\\tools\\node\\node_modules\\npm\\bin\\npm-cli.js";
  const node = findNode({ PATH: "C:\\x;\"C:\\tools\\node\";C:\\y" }, "win32", exists);
  assert.equal(node, "C:\\tools\\node\\node.exe");
  assert.equal(findNpmCli(node!, exists), "C:\\tools\\node\\node_modules\\npm\\bin\\npm-cli.js");
  assert.equal(findNode({ PATH: "C:\\x" }, "win32", () => false), undefined);
});

test("installedCli accepts only the pinned version", () => {
  const read = (v: string) => () => JSON.stringify({ version: v });
  assert.equal(installedCli("D:\\d", read(PLAYWRIGHT_MCP_VERSION)).ok, true);
  assert.equal(installedCli("D:\\d", read("9.9.9")).ok, false);
  assert.equal(installedCli("D:\\d", () => undefined).ok, false);
  assert.equal(installedCli("D:\\d", () => "{not json").ok, false);
});

test("the install runs npm through node (no shell) with scripts off and the exact pinned package", async () => {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  const exec: Run = async (file, args, o) => {
    calls.push({ file, args, cwd: o.cwd });
    return { code: 0, output: "" };
  };
  const r = await installBrowserServer("D:\\store\\pw", "C:\\n\\node.exe", "C:\\n\\npm-cli.js", exec);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [{ file: "C:\\n\\node.exe", args: ["C:\\n\\npm-cli.js", "install", "--prefix", ".", "--ignore-scripts", "--no-audit", "--no-fund", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`], cwd: "D:\\store\\pw" }]);
  const failed = await installBrowserServer("D:\\d", "n", "c", async () => ({ code: 1, output: "ENOTFOUND" }));
  assert.deepEqual(failed, { ok: false, output: "ENOTFOUND" });
});

test("the entry the preset builds passes validation and lands in settings.json as a stdio server in 'optional' mode", () => {
  const input = { name: "browser", transport: "stdio" as const, command: "C:\\n\\node.exe", args: browserArgs("C:\\s\\cli.js", "msedge", "local", "C:\\out"), env: { TEMP: "C:\\t" }, mode: "optional" as const };
  assert.deepEqual(validateInput(input), []);
  const text = applyEdit(undefined, { op: "upsert", input });
  const config = parseMcpConfig(text, "x");
  const entry = config.entries.find((e) => e.name === "browser");
  assert.equal(entry?.transport, "stdio");
  assert.equal(entry?.mode, "optional");
  assert.equal(entry?.command, "C:\\n\\node.exe");
  assert.ok(entry?.args.includes("--isolated"));
});
