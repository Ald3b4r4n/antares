// Phase 1 probe: does the host accept an `image` input part, and how does it report it?
// Costs ONE real model turn (about 45k tokens). Runs in the user's normal environment (the login
// lives there; their hooks may run), in an empty throwaway workspace, with shell and writes disabled
// and the :read-only profile. The image is a 64x64 solid red PNG generated here: nothing personal.
//
// Usage: node scripts/probe-image.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSolidPng } from "../test/fixtures/png.ts";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-image-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({ binary, args: ["serve", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
const log: { at: number; kind: string; method?: string; payload?: unknown }[] = [];
const t0 = Date.now();
const rec = (kind: string, method?: string, payload?: unknown) => log.push({ at: Date.now() - t0, kind, method, payload });
let terminal: unknown;
let resolveDone: () => void = () => undefined;
const done = new Promise<void>((resolve) => (resolveDone = resolve));
host.on("notification", (method: string, params: unknown) => {
  rec("notification", method, params);
  if (method === "turn/completed") {
    terminal = (params as { terminal?: unknown }).terminal;
    resolveDone();
  }
});
host.on("request", (id: number | string, method: string, params: unknown) => rec("serverRequest", method, { id, params }));

const png = makeSolidPng(64, 64, [255, 0, 0]);
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const started = await host.request<{ session?: { sessionId?: string } }>("session/start", { commandId: uuidv7(), workspaceRoot: workspace, permissionProfile: ":read-only" });
  const sessionId = started.session?.sessionId ?? "";
  if (!sessionId) throw new Error("no session id");
  console.log(`Sending ONE real turn with a ${png.length}-byte red PNG...`);
  setTimeout(resolveDone, 150_000);
  try {
    const ack = await host.request("turn/start", {
      commandId: uuidv7(),
      sessionId,
      input: [
        { type: "text", text: "Reply with exactly one word: the dominant colour of the attached image." },
        { type: "image", mediaType: "image/png", base64Data: png.toString("base64"), width: 64, height: 64 },
      ],
    }, 30_000);
    rec("result", "turn/start", ack);
    await done;
  } catch (error) {
    rec("error", "turn/start", (error as Error).message);
    console.log("turn/start refused:", (error as Error).message);
  }
} catch (error) {
  rec("error", undefined, error instanceof Error ? error.message : String(error));
} finally {
  const code = await host.stop();
  writeFileSync(new URL("probe-image.json", outDir), JSON.stringify({ terminal, hostExitCode: code, log }, null, 2));
  const reply = log.find((e) => e.method === "item/completed" && (e.payload as { item?: { kind?: string } }).item?.kind === "agentMessage");
  console.log("turn outcome:", terminal, "| agent said:", JSON.stringify(((reply?.payload as { item?: { text?: string } } | undefined)?.item?.text ?? "").slice(0, 120)));
  rmSync(work, { recursive: true, force: true });
}
