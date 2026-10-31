// Phase 3A probe: plugin/marketplaceAdd, plugin/install (marketplace and local path), plugin/list and the skills a
// plugin brings, over MSP. NO model call. Throwaway HOME, config, data and workspace; the demo plugin only
// contributes a skill (no hooks, no MCP servers), so installing it executes nothing.
//
// Usage: node scripts/probe-plugins-msp.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-plugmsp-"));
const home = join(work, "home");
const workspace = join(work, "workspace");
for (const d of [home, workspace, join(work, "config"), join(work, "data")]) mkdirSync(d, { recursive: true });
const market = join(work, "market");
const plugin = join(market, "plugins", "antares-demo");
mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
mkdirSync(join(plugin, "skills", "hello"), { recursive: true });
writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "antares-demo", version: "0.0.1", description: "A harmless demo bundle." }));
writeFileSync(join(plugin, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello. Demo only.\n---\nSay hello.\n");
mkdirSync(join(market, ".claude-plugin"), { recursive: true });
writeFileSync(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "demo-market", owner: { name: "Antares probe" }, plugins: [{ name: "antares-demo", source: "./plugins/antares-demo", description: "A harmless demo bundle." }] }));

const host = new MuseHost({
  binary,
  args: ["serve", "--provider", "echo", "--no-session-log", "--disable-shell", "--disable-write"],
  cwd: workspace,
  env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data"), MUSE_AUTH_PATH: join(work, "config", "absent-auth.json"), META_API_KEY: "" },
});
const notifications: string[] = [];
host.on("notification", (method: string) => {
  if (/plugin|skill|marketplace/i.test(method)) notifications.push(method);
});
const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 60_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const notes: Record<string, unknown> = {};
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const started = await ask("session/start", { commandId: uuidv7(), workspaceRoot: workspace });
  const sessionId = started.session?.sessionId;
  if (!sessionId) throw new Error(`no session: ${started.error}`);

  const add = await ask("plugin/marketplaceAdd", { commandId: uuidv7(), sessionId, name: "demo-market", source: market });
  notes.marketplaceAdd = { error: add.error, keys: keys(add), result: add };
  const install = await ask("plugin/install", { commandId: uuidv7(), sessionId, target: { marketplace: { marketplace: "demo-market", name: "antares-demo" } } });
  notes.installFromMarketplace = { error: install.error, result: install };
  const list = await ask("plugin/list", { sessionId });
  notes.pluginList = { error: list.error, plugins: list.plugins };
  const skills = (await ask("skill/list", { sessionId })).skills ?? [];
  notes.skillsFromPlugin = skills.filter((s: any) => s.source === "plugin").map((s: any) => ({ selector: s.selector, pluginId: s.pluginId }));
  const again = await ask("plugin/install", { commandId: uuidv7(), sessionId, target: { localPath: { path: plugin } } });
  notes.installAgainLocal = { error: again.error, result: again };
  const update = await ask("plugin/marketplaceUpdate", { commandId: uuidv7(), sessionId, name: "demo-market" });
  notes.marketplaceUpdate = { error: update.error, keys: keys(update) };
  const remove = await ask("plugin/marketplaceRemove", { commandId: uuidv7(), sessionId, name: "demo-market" });
  notes.marketplaceRemove = { error: remove.error, result: remove };
  notes.notifications = [...new Set(notifications)];
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(notes, null, 2));
