// A stand-in for `muse exec --provider echo` as far as MCP startup goes: it reads the settings file it is given (through
// XDG_CONFIG_HOME), records what it saw to FAKE_EXEC_REPORT, and fails like Muse does when a required server cannot start.
// A server whose command contains "broken" fails; anything else starts. Test fixture only.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME, "muse", "settings.json"), "utf8"));
const seen = { args: process.argv.slice(2), settings, secretEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ANTARES_PROBE_"))), home: process.env.HOME };
if (process.env.FAKE_EXEC_REPORT) appendFileSync(process.env.FAKE_EXEC_REPORT, `${JSON.stringify(seen)}\n`);
const servers = settings.mcpServers ?? settings.mcp_servers ?? {};
for (const [name, server] of Object.entries(servers)) {
  if (server.enabled === false) continue;
  if (String(server.command ?? server.url ?? "").includes("broken")) {
    process.stderr.write(`{"error":"invalid run configuration: Required MCP server \`${name}\` failed during startup: the configured command is unavailable."}\n`);
    process.exit(1);
  }
}
process.stdout.write('{"payload_type":"runtime.command.accepted"}\n');
