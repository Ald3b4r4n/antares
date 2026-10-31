// Does the host's sandbox report depend on the binary or network mode it is launched with? Read-only, no session.
import { MuseHost } from "../src/muse/host.ts";
const dir = "C:/Users/Antonio Rafael/AppData/Local/Programs/muse/";
const variants = [
  ["muse.exe serve", dir + "muse.exe", ["serve"]],
  ["muse.exe serve --sandbox-network restricted", dir + "muse.exe", ["serve", "--sandbox-network", "restricted"]],
  ["muse-bin-1.4.14 serve", dir + "muse-bin-1.4.14-R7309.1.exe", ["serve"]],
];
for (const [label, binary, args] of variants) {
  const host = new MuseHost({ binary, args, cwd: process.cwd(), env: { ...process.env } });
  try {
    host.start();
    const init = await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
    console.log(label, "->", init.sandboxAvailability, init.sandboxUnavailableReason ?? "");
  } catch (e) { console.log(label, "-> error", e.message); } finally { await host.stop(); }
}
