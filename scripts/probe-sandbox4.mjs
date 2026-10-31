// Does any serve option change the sandbox report? Read-only, no session, no model call.
import { MuseHost } from "../src/muse/host.ts";
const bin = "C:/Users/Antonio Rafael/AppData/Local/Programs/muse/muse.exe";
const variants = [["serve", "--sandbox-network", "enabled"], ["serve", "--sandbox-network", "restricted"]];
for (const args of variants) {
  const host = new MuseHost({ binary: bin, args, cwd: "C:/Users/Antonio Rafael", env: { ...process.env } });
  try {
    host.start();
    const init = await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
    console.log(args.slice(1).join(" ") || "(default)", "->", init.sandboxAvailability);
  } catch (e) { console.log(args.slice(1).join(" "), "-> error", String(e.message).slice(0, 100)); } finally { await host.stop(); }
}
