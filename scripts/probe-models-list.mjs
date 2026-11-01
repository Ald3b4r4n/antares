// Lists the model catalog the real host serves (model/list, read-only, no session, no model call).
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
const host = new MuseHost({ binary: locateMuse(), args: ["serve", "--disable-shell", "--disable-write"], cwd: process.cwd(), env: { ...process.env } });
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const r = await host.request("model/list", {}, 30000);
  console.log("source:", r.source, "| provider:", r.providerId, "| profile:", r.profileId);
  for (const m of r.models) console.log(`- ${m.modelId} | default=${m.isDefault} | released ${m.releaseDate} | ctx ${m.contextLimit} | efforts: ${(m.variants || []).join(",")}`);
  console.log("count:", r.models.length);
} finally { await host.stop(); }
