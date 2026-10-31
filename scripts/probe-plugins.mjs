// Phase 3A probe: plugin bundles, marketplaces and the "available plugins" listing, through Muse's own CLI and
// MSP. NO model call. Everything runs against a throwaway HOME, Muse config and data folder with one demo plugin
// and one local marketplace, so nothing of the user's is read or changed. The demo plugin only contributes a
// skill (no hooks, no MCP servers), so installing it runs no code.
//
// Usage: node scripts/probe-plugins.mjs [path-to-muse]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateMuse } from "../src/muse/locate.ts";

const binary = locateMuse(process.argv[2]);
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-plugins-"));
const home = join(work, "home");
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data"), MUSE_AUTH_PATH: join(work, "config", "absent-auth.json") };
for (const d of [home, join(work, "config"), join(work, "data")]) mkdirSync(d, { recursive: true });

// One plugin that only brings a skill, in a marketplace folder.
const market = join(work, "market");
const plugin = join(market, "plugins", "antares-demo");
mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
mkdirSync(join(plugin, "skills", "hello"), { recursive: true });
writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "antares-demo", version: "0.0.1", description: "A harmless demo bundle." }));
writeFileSync(join(plugin, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello. Demo only.\n---\nSay hello.\n");
mkdirSync(join(market, ".claude-plugin"), { recursive: true });
writeFileSync(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "demo-market", owner: { name: "Antares probe" }, plugins: [{ name: "antares-demo", source: "./plugins/antares-demo", description: "A harmless demo bundle." }] }));

const run = (...args) => {
  try {
    return { ok: true, out: execFileSync(binary, args, { env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 1500) };
  }
};
const notes = {};
try {
  notes.availableBefore = run("plugins", "list", "--available", "--json");
  notes.marketAdd = run("plugins", "marketplace", "add", "demo-market", market, "--json");
  notes.marketList = run("plugins", "marketplace", "list", "--json");
  notes.availableAfter = run("plugins", "list", "--available", "--json");
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(notes, null, 2));
