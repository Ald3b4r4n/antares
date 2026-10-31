// Phase 1 probe: subscription usage. NO model call and NO session. Runs `muse serve` in the user's
// normal environment (the login lives there), reads `usage/read`, then `usage/refresh` (experimental:
// the host mints once to read fresh usage; it is rate-bounded by the host to one per 60 s), then reads again.
// The provider's tier id is never printed or stored; only percentages, reset/observation times and
// whether a subscription is active.
//
// Usage: node scripts/probe-usage.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-usage-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });

const host = new MuseHost({ binary, args: ["serve", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
const notifications: string[] = [];
host.on("notification", (method: string) => notifications.push(method));

interface Usage { observedAtMs?: number; tier?: string; window?: { usedPercent?: number; windowDurationMins?: number; resetsAtMs?: number }; weekly?: { usedPercent?: number; resetsAtMs?: number } }
const safe = (u: Usage | undefined) =>
  u
    ? { observedAtMs: u.observedAtMs, ageSeconds: u.observedAtMs ? Math.round((Date.now() - u.observedAtMs) / 1000) : undefined, window: u.window, weekly: u.weekly, tierPresent: typeof u.tier === "string" }
    : undefined;
const ask = async (method: string, params: unknown) => {
  try {
    return (await host.request<Record<string, unknown>>(method, params)) as { usage?: Usage; subscriptionActive?: boolean; tierName?: string };
  } catch (e) {
    return { error: (e as Error).message } as { error: string };
  }
};

try {
  host.start();
  const init = await host.request<{ experimentalApi?: boolean }>("initialize", { clientInfo: { name: "antares", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  console.log("experimentalApi negotiated:", init.experimentalApi);
  const before = await ask("usage/read", {});
  console.log("usage/read (before):", JSON.stringify("error" in before ? before : { usage: safe(before.usage) }));
  const refreshed = await ask("usage/refresh", {});
  console.log("usage/refresh:", JSON.stringify("error" in refreshed ? refreshed : { subscriptionActive: refreshed.subscriptionActive, tierName: refreshed.tierName, usage: safe(refreshed.usage) }));
  const after = await ask("usage/read", {});
  console.log("usage/read (after):", JSON.stringify("error" in after ? after : { usage: safe(after.usage) }));
  await new Promise((r) => setTimeout(r, 300));
  console.log("notifications seen:", notifications.join(", ") || "(none)");
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
