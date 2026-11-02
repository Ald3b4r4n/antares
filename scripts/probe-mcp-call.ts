// Phase D proof: does a real turn discover AND call a tool of an MCP server defined in settings.json?
// Costs ONE small real model turn on the user's subscription (run only with their authorization). Everything else is isolated:
// a throwaway config holding only the harmless mini server (test/fixtures/mini-mcp-server.mjs: one tool, `antares_ping`,
// which answers "pong:<text>" and touches nothing), a throwaway workspace, Standard mode forced for this run so nothing is
// contributed, and the user's login hard-linked (not copied) into the throwaway config. The server logs every request it gets, which is the proof.
//
// Usage: node scripts/probe-mcp-call.ts [path-to-muse]
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { locateMuse } from "../src/muse/locate.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const mini = resolve(import.meta.dirname, "../test/fixtures/mini-mcp-server.mjs");
const realAuth = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse", "auth.json");
if (!existsSync(realAuth)) {
  console.error(`No Muse login found at ${realAuth}.`);
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-mcpcall-"));
const cfg = join(work, "config");
for (const d of [join(cfg, "muse"), join(work, "home"), join(work, "data"), join(work, "ws")]) mkdirSync(d, { recursive: true });
// The login is hard-linked (not copied) into the throwaway config, so the credential is never duplicated on disk.
linkSync(realAuth, join(cfg, "muse", "auth.json"));
const log = join(work, "mini.log");
writeFileSync(join(cfg, "muse", "settings.json"), JSON.stringify({ schema_version: 1, contributor_mode_enabled: false, mcpServers: { mini: { transport: "stdio", command: process.execPath, args: [mini], mode: "required", env: { MINI_MCP_LOG: log } } } }));
const env = { ...process.env, HOME: join(work, "home"), USERPROFILE: join(work, "home"), XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: join(work, "data"), APPDATA: cfg};
try {
  const r = spawnSync(binary, ["exec", "--json", "--contributor-mode", "off", "--permission-profile", ":unrestricted", "--reasoning-effort", "minimal", "--workspace", join(work, "ws"), "Call the tool antares_ping with the text abc123 and reply with only the tool's answer."], { env, cwd: join(work, "ws"), encoding: "utf8", timeout: 180_000 });
  const methods = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; params?: { name?: string; arguments?: unknown } }) : [];
  const call = methods.find((m) => m.method === "tools/call");
  console.log("exit:", r.status);
  console.log("server saw:", methods.map((m) => m.method).join(", ") || "(nothing)");
  console.log("tools/call:", call ? JSON.stringify(call.params) : "NOT CALLED");
  const said = /pong:abc123/.test(r.stdout) ? "the reply carries pong:abc123" : "the reply does not carry the tool answer";
  console.log("reply:", said);
  if (r.status !== 0) console.log((r.stderr || r.stdout).slice(0, 400));
} finally {
  rmSync(work, { recursive: true, force: true });
}
