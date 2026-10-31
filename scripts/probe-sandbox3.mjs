// Captures the host's own stderr while it decides sandbox availability. Read-only, no session.
import { MuseHost } from "../src/muse/host.ts";
const host = new MuseHost({ binary: "C:/Users/Antonio Rafael/AppData/Local/Programs/muse/muse.exe", args: ["serve"], cwd: process.cwd(), env: { ...process.env, RUST_LOG: "debug", MUSE_LOG: "debug" } });
const lines = [];
host.on("stderr", (l) => lines.push(l));
try {
  host.start();
  const init = await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  console.log("availability:", init.sandboxAvailability, JSON.stringify(Object.keys(init)));
} finally { await host.stop(); }
console.log(lines.filter((l) => /sandbox|elevat|wfp|runner|trust|setup/i.test(l)).slice(0, 20).join("\n") || `(${lines.length} stderr lines, none about the sandbox)`);
