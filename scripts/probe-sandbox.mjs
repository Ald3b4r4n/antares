// Reports which muse binary Antares launches and what the host says about its sandbox. Read-only, no session.
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
const binary = locateMuse();
console.log("binary:", binary);
const host = new MuseHost({ binary, args: ["serve"], cwd: process.cwd(), env: { ...process.env } });
try {
  host.start();
  const init = await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  console.log(JSON.stringify({ sandboxAvailability: init.sandboxAvailability, reason: init.sandboxUnavailableReason, version: init.serverInfo?.version, platform: init.platformOs }));
} finally { await host.stop(); }
