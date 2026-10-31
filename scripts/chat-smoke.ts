// Offline check of MuseSession + the event mapper using the `echo` provider (no login, no model call).
// Usage: node scripts/chat-smoke.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import type { ChatEvent } from "../src/muse/events.ts";
import { MuseSession } from "../src/muse/session.ts";

const binary = locateMuse(process.argv[2]);
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-chat-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const session = new MuseSession({ binary, workspaceRoot: workspace, provider: "echo", env: isolatedEnv(join(work, "muse-home")) });
const events: ChatEvent[] = [];
session.on("event", (e: ChatEvent) => events.push(e));
let ok = false;
try {
  await session.start();
  await session.send("hello antares");
  const deadline = Date.now() + 20_000;
  while (!events.some((e) => e.type === "turnCompleted") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const types = events.map((e) => e.type);
  console.log("event types:", types.join(", "));
  const user = events.find((e) => e.type === "userMessage");
  const done = events.find((e) => e.type === "turnCompleted");
  console.log("user message:", user && "text" in user ? user.text : undefined);
  console.log("assistant:", JSON.stringify(events.filter((e) => e.type === "assistantCompleted")));
  console.log("turnCompleted:", JSON.stringify(done));
  ok = Boolean(user && done);
} finally {
  await session.stop();
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exitCode = ok ? 0 : 1;
