// Reads the host's projected credential state (no secrets, no model call) using the same
// isolated-config + existing-auth-path setup as probe-turn.ts. Needs the experimental API.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv, MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";

const real = process.argv.includes("--real-env");
const binary = locateMuse(process.argv.slice(2).find((x) => !x.startsWith("--")));
if (!binary) process.exit(2);
const xdg = process.env.XDG_CONFIG_HOME;
const auth = process.env.MUSE_AUTH_PATH ?? join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "muse", "auth.json");
console.log("auth file present at default location:", existsSync(auth));

const work = mkdtempSync(join(tmpdir(), "antares-acct-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const env = real ? { ...process.env } : isolatedEnv(join(work, "muse-home"));
if (!real) env.MUSE_AUTH_PATH = auth;
const host = new MuseHost({ binary, args: ["serve", "--no-session-log", "--disable-shell", "--disable-write"], cwd: workspace, env });
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const account = await host.request<Record<string, unknown>>("account/read", {}).catch((e: Error) => ({ error: e.message }));
  // Never print a display label; keep only the structural fields.
  const { label: _label, ...safe } = account as Record<string, unknown>;
  console.log("account/read:", JSON.stringify(safe));
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
