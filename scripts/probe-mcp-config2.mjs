// Phase 3B probe (part 2): the host's own message when settings.json holds an MCP server, and which shapes it accepts.
// Throwaway config only. Usage: node scripts/probe-mcp-config2.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateMuse } from "../src/muse/locate.ts";

const binary = locateMuse();
const shapes = {
  "mcpServers.demo {command,args}": { mcpServers: { demo: { command: "node", args: ["demo-server.js"] } } },
  "mcpServers.demo {type:stdio,...}": { mcpServers: { demo: { type: "stdio", command: "node", args: ["demo-server.js"] } } },
  "mcpServers.demo {type:http,url}": { mcpServers: { demo: { type: "http", url: "https://mcp.example.test/mcp" } } },
  "mcp_servers.demo": { mcp_servers: { demo: { command: "node", args: ["demo-server.js"] } } },
  "mcp.servers.demo": { mcp: { servers: { demo: { command: "node", args: ["demo-server.js"] } } } },
};
for (const [label, shape] of Object.entries(shapes)) {
  const work = mkdtempSync(join(tmpdir(), "antares-mcpcfg2-"));
  const config = join(work, "config");
  mkdirSync(join(config, "muse"), { recursive: true });
  mkdirSync(join(work, "home"), { recursive: true });
  mkdirSync(join(work, "workspace"), { recursive: true });
  writeFileSync(join(config, "muse", "settings.json"), JSON.stringify({ schema_version: 1, ...shape }, null, 2));
  const r = spawnSync(binary, ["mcp", "login", "demo", "--headless"], { cwd: join(work, "workspace"), env: { ...process.env, HOME: join(work, "home"), USERPROFILE: join(work, "home"), XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(work, "data"), APPDATA: config, MUSE_AUTH_PATH: join(config, "absent.json") }, encoding: "utf8", timeout: 20000, input: "\n" });
  console.log(`== ${label}\n   exit ${r.status}  ${(r.stdout + r.stderr).trim().replace(/\s+/g, " ").slice(0, 330)}`);
  rmSync(work, { recursive: true, force: true });
}
