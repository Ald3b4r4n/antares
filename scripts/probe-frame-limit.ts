// Measures the host's inbound frame limit: a turn/start for a session that does not exist, with a text part of a given
// size. An oversized frame is refused with -32002 before anything runs; a frame within the limit fails on the unknown
// session instead. No model turn is ever started.
//
// Usage: node scripts/probe-frame-limit.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-frame-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const host = new MuseHost({ binary, args: ["serve", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });

async function tryBytes(bytes: number): Promise<string> {
  try {
    await host.request("turn/start", { commandId: uuidv7(), sessionId: "00000000-0000-7000-8000-000000000000", input: [{ type: "text", text: "a".repeat(bytes) }] }, 30_000);
    return "accepted";
  } catch (error) {
    const message = (error as Error).message;
    return /inbound limit|-32002/.test(message) ? "TOO BIG" : "within limit (" + message.slice(0, 80) + ")";
  }
}

try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  for (const kb of [10240, 12288, 14336, 15872, 16000, 16300]) console.log(`${kb} KiB:`, await tryBytes(kb * 1024));
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
