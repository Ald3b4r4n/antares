// Phase 3C probe: when the model looks at an image file with its tools, what does the host record on the tool call
// (`modelVisibleContent`, `outputRef`) and can the bytes be fetched with `item/readOutput`? ONE real model turn,
// in a throwaway workspace that holds one generated 64x48 PNG; the profile is :ask-me but the prompt only reads,
// and any approval that appears is rejected. Prints field names and sizes, never image bytes.
//
// Usage: node scripts/probe-tool-image.ts [path-to-muse]
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// A solid-red 64x48 PNG, written by hand so the probe needs no image library.
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const work = mkdtempSync(join(tmpdir(), "antares-toolimg-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "picture.png"), png(64, 48, [220, 40, 30]));
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({ binary, args: ["serve"], cwd: workspace, env: { ...process.env } });
const notes: Record<string, unknown> = { items: [] as unknown[], allKeys: [] as unknown[] };
let sessionId = "";
let resolveDone: () => void = () => undefined;
const done = new Promise<void>((r) => (resolveDone = r));
host.on("notification", (method: string, params: any) => {
  if (method === "turn/completed") resolveDone();
  const item = params?.item;
  if (item?.kind === "toolCall") (notes.allKeys as any[]).push({ method, tool: item.tool, keys: Object.keys(item).sort() });
  if (method === "item/completed" && item?.kind === "toolCall") {
    const { args, visibleOutput, ...rest } = item;
    (notes.items as unknown[]).push({ tool: item.tool, status: item.status, extraKeys: Object.keys(rest).sort(), modelVisibleContent: item.modelVisibleContent, outputRef: item.outputRef && { ...item.outputRef, path: undefined }, visibleOutputPreview: typeof visibleOutput === "string" ? visibleOutput.slice(0, 120) : undefined });
  }
});
host.on("request", (id: number | string, method: string, params: any) => {
  if (method !== "approval/request") return;
  host.respond(id, {});
  const deny = params.availableChoices?.find((c: any) => c.decision === "abort" || c.decision === "denied");
  if (deny) void host.request("approval/decide", { commandId: uuidv7(), sessionId, approvalId: params.approvalId, choiceId: deny.choiceId, requirementId: params.currentRequirementId }).catch(() => undefined);
});
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const started: any = await host.request("session/start", { commandId: uuidv7(), workspaceRoot: workspace, permissionProfile: ":ask-me" });
  sessionId = started.session?.sessionId;
  setTimeout(resolveDone, 150_000);
  await host.request("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "text", text: "Use your file tool to look at the image file picture.png in this folder and tell me its dominant colour in one word." }] }, 30_000);
  await done;
  // Fetch whatever the host says is stored, to learn media type and encoding (sizes only).
  const fetched: unknown[] = [];
  for (const it of notes.items as any[]) {
    if (it.outputRef?.id) {
      const r: any = await host.request("item/readOutput", { sessionId, itemId: "?", outputRef: it.outputRef.id }, 20_000).catch((e: Error) => ({ error: e.message }));
      fetched.push({ tool: it.tool, error: r.error, mediaType: r.mediaType, encoding: r.encoding, byteLen: r.byteLen, eof: r.eof });
    }
  }
  notes.fetched = fetched;
  await host.stop();
  const second = new MuseHost({ binary, args: ["serve"], cwd: workspace, env: { ...process.env } });
  try {
    second.start();
    await second.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
    second.notify("initialized");
    const resumed: any = await second.request("session/resume", { commandId: uuidv7(), sessionId, history: "inline", permissionProfile: ":read-only" }, 30_000);
    notes.resumedToolItems = (resumed.history?.items ?? []).filter((i: any) => i.kind === "toolCall").map((i: any) => ({ tool: i.tool, keys: Object.keys(i).sort(), modelVisibleContent: i.modelVisibleContent, outputRef: i.outputRef && { ...i.outputRef, path: undefined } }));
    notes.resumedItemKinds = [...new Set((resumed.history?.items ?? []).map((i: any) => i.kind))];
  } finally {
    await second.stop();
  }
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(new URL("probe-tool-image.json", outDir), JSON.stringify(notes, null, 2));
console.log(JSON.stringify(notes, null, 2));
