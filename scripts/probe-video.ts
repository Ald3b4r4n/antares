// Phase 4 probe: video input. `media/upload` in chunks, then a `video` part in `turn/start`. NO paid model call: the
// echo provider, an ephemeral session and a tiny synthetic file that only has an MP4 `ftyp` box (it is not a playable
// video). Reports what the host accepts and refuses, and what a user message with a video looks like.
//
// Usage: node scripts/probe-video.ts [path-to-muse]
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
const work = mkdtempSync(join(tmpdir(), "antares-video-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const host = new MuseHost({ binary, args: ["serve", "--provider", "echo", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env, XDG_CONFIG_HOME: join(work, "c"), XDG_DATA_HOME: join(work, "d"), MUSE_AUTH_PATH: join(work, "c", "absent.json"), META_API_KEY: "" } });
const seen: unknown[] = [];
host.on("notification", (method: string, params: any) => {
  const item = params?.item;
  if (item?.kind === "userMessage" && method === "item/completed") seen.push({ method, text: String(item.text).slice(0, 120), attachments: item.attachments });
});
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
// 32 bytes: size, "ftyp", brand "isom", minor version, compatible brands.
const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2")]);
const notes: Record<string, unknown> = {};
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const started = await ask("session/start", { commandId: uuidv7(), workspaceRoot: workspace });
  const sessionId = started.session?.sessionId;
  const upload = async (uploadId: string, chunks: Buffer[], mediaType: string, totalBytes?: number) => {
    let last: any;
    for (let i = 0; i < chunks.length; i++) last = await ask("media/upload", { commandId: uuidv7(), sessionId, uploadId, mediaType, chunkIndex: i, chunkCount: chunks.length, totalBytes: totalBytes ?? chunks.reduce((n, c) => n + c.length, 0), chunkBase64: chunks[i]!.toString("base64") });
    return last;
  };
  const id1 = uuidv7();
  notes.uploadTwoChunks = await upload(id1, [ftyp.subarray(0, 12), ftyp.subarray(12)], "video/mp4");
  notes.turnWithVideo = await ask("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "text", text: "what is in this clip?" }, { type: "video", uploadId: id1 }] });
  await new Promise((r) => setTimeout(r, 1500));
  notes.userMessage = seen;
  notes.wrongTotal = await upload(uuidv7(), [ftyp], "video/mp4", ftyp.length + 5);
  notes.badMediaType = await upload(uuidv7(), [ftyp], "video/webm");
  notes.unknownUploadId = await ask("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "video", uploadId: uuidv7() }] });
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(notes, null, 2));
