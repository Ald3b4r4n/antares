// Phase 3 probe: which host settings can a client read and write over MSP, and can MCP servers be configured
// that way? READ-ONLY: `settings/readSchema` and `settings/read` only, no write, no session, no model call.
// It runs against an isolated Muse config and home (temp folders), so none of the user's settings are read.
//
// Usage: node scripts/probe-settings.ts [path-to-muse]
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
const work = mkdtempSync(join(tmpdir(), "antares-settings-"));
const home = join(work, "home");
const workspace = join(work, "workspace");
for (const d of [home, workspace, join(work, "config"), join(work, "data")]) mkdirSync(d, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({
  binary,
  args: ["serve", "--disable-shell", "--disable-write"],
  cwd: workspace,
  env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data"), MUSE_AUTH_PATH: join(work, "config", "absent-auth.json"), META_API_KEY: "" },
});
const notes: Record<string, unknown> = {};
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const schema = await ask("settings/readSchema", {});
  notes.schemaError = schema.error;
  notes.schemaTopKeys = Object.keys(schema).slice(0, 10);
  const entries: any[] = schema.keys ?? schema.entries ?? schema.settings ?? [];
  notes.schemaCount = Array.isArray(entries) ? entries.length : Object.keys(entries).length;
  notes.schemaSample = JSON.stringify(schema).slice(0, 2500);
  const read = await ask("settings/read", {});
  notes.readError = read.error;
  notes.readKeys = JSON.stringify(read).slice(0, 1800);
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(new URL("probe-settings.json", outDir), JSON.stringify(notes, null, 2));
console.log(JSON.stringify(notes, null, 2));
