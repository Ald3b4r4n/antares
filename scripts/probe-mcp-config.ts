// Phase 3B probe: where does Muse read MCP servers from, in what format, and does `mcpServer/list` show a stdio
// server defined there? NO model call. Throwaway HOME, config, data and workspace. The demo server is a tiny
// local Node script that is never started (listing does not start it). Candidate config locations are tried one
// at a time and the first that makes the server appear is reported.
//
// Usage: node scripts/probe-mcp-config.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}

async function listWith(place: (dirs: { home: string; workspace: string; config: string }) => void): Promise<unknown> {
  const work = mkdtempSync(join(tmpdir(), "antares-mcpcfg-"));
  const dirs = { home: join(work, "home"), workspace: join(work, "workspace"), config: join(work, "config") };
  for (const d of [dirs.home, dirs.workspace, dirs.config, join(work, "data")]) mkdirSync(d, { recursive: true });
  place(dirs);
  const host = new MuseHost({
    binary: binary!,
    args: ["serve"],
    cwd: dirs.workspace,
    env: { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.config, APPDATA: dirs.config, XDG_DATA_HOME: join(work, "data"), MUSE_AUTH_PATH: join(dirs.config, "absent-auth.json"), META_API_KEY: "" },
  });
  try {
    host.start();
    await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
    host.notify("initialized");
    const r: any = await host.request("mcpServer/list", {}, 20_000);
    return (r.servers ?? []).map((s: any) => ({ name: s.name, source: s.source, transport: s.transport, oauth: s.oauth }));
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    await host.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

const server = { command: "node", args: ["demo-server.js"] };
const body = JSON.stringify({ schema_version: 1, mcpServers: { demo: server, remote: { type: "http", url: "https://mcp.example.test/mcp" } } }, null, 2);
const write = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const places: Record<string, (d: { home: string; workspace: string; config: string }) => void> = {
  "workspace/.muse/settings.json": (d) => write(join(d.workspace, ".muse", "settings.json"), body),
  "workspace/.muse/mcp.json": (d) => write(join(d.workspace, ".muse", "mcp.json"), body),
  "workspace/.mcp.json": (d) => write(join(d.workspace, ".mcp.json"), body),
  "config/muse/settings.json": (d) => write(join(d.config, "muse", "settings.json"), body),
  "home/.muse/settings.json": (d) => write(join(d.home, ".muse", "settings.json"), body),
};
const out: Record<string, unknown> = {};
for (const [label, place] of Object.entries(places)) out[label] = await listWith(place);
console.log(JSON.stringify(out, null, 2));
