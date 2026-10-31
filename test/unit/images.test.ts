// Image input: validation (the webview is untrusted), the input parts sent to the host, and the
// host's reporting of attachments (shape observed with scripts/probe-image.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mapNotification } from "../../src/muse/events.ts";
import { buildInputParts, decodedSize, MAX_IMAGES, MAX_IMAGE_BYTES, matchesSignature, validateImages } from "../../src/muse/images.ts";
import { MuseSession } from "../../src/muse/session.ts";
import { readReport } from "../fixtures/report.ts";
import { makeSolidPng } from "../fixtures/png.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const png = makeSolidPng(8, 6, [255, 0, 0]);
const pngB64 = png.toString("base64");
const png1 = { mediaType: "image/png", base64Data: pngB64, width: 8, height: 6 };

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("a valid PNG passes and keeps its size; no images is fine", () => {
  const r = validateImages([png1]);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.images, [png1]);
  assert.deepEqual(validateImages(undefined), { ok: true, images: [] });
  assert.deepEqual(validateImages([]), { ok: true, images: [] });
});

test("width and height are optional but must come together and be positive integers", () => {
  const noDims = validateImages([{ mediaType: "image/png", base64Data: pngB64 }]);
  assert.ok(noDims.ok && noDims.images[0] && !("width" in noDims.images[0]));
  assert.equal(validateImages([{ ...png1, height: undefined }]).ok, false);
  assert.equal(validateImages([{ ...png1, width: 0 }]).ok, false);
  assert.equal(validateImages([{ ...png1, width: 1.5 }]).ok, false);
});

test("untrusted input is rejected with a readable reason", () => {
  const bad = (input: unknown, re: RegExp) => {
    const r = validateImages(input);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, re);
  };
  bad("nope", /list/);
  bad([null], /not valid/);
  bad([{ ...png1, mediaType: "image/bmp" }], /unsupported type/);
  bad([{ ...png1, mediaType: "text/html" }], /unsupported type/);
  bad([{ ...png1, base64Data: "" }], /base64/);
  bad([{ ...png1, base64Data: "data:image/png;base64," + pngB64 }], /base64/);
  bad([{ ...png1, base64Data: "not base64 !!" }], /base64/);
  bad([{ ...png1, mediaType: "image/jpeg" }], /not a image\/jpeg/); // content is PNG, declared JPEG
  bad(Array.from({ length: MAX_IMAGES + 1 }, () => png1), /At most/);
});

test("size limits: one image and the total", () => {
  const huge = Buffer.concat([png.subarray(0, 8), Buffer.alloc(MAX_IMAGE_BYTES + 10)]).toString("base64");
  const one = validateImages([{ mediaType: "image/png", base64Data: huge }]);
  assert.equal(one.ok, false);
  assert.match(one.ok ? "" : one.error, /too large/);
  const big = Buffer.concat([png.subarray(0, 8), Buffer.alloc(4 * 1024 * 1024)]).toString("base64");
  const total = validateImages(Array.from({ length: 5 }, () => ({ mediaType: "image/png", base64Data: big })));
  assert.equal(total.ok, false);
  assert.match(total.ok ? "" : total.error, /together/);
});

test("signatures: each supported type is recognised and mismatches are not", () => {
  const b = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  assert.ok(matchesSignature("image/png", pngB64));
  assert.ok(matchesSignature("image/jpeg", b([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])));
  assert.ok(matchesSignature("image/gif", b([...Buffer.from("GIF89a"), 0, 0])));
  assert.ok(matchesSignature("image/webp", b([...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBPVP8 ")])));
  assert.equal(matchesSignature("image/png", b([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(matchesSignature("image/bmp", pngB64), false);
  assert.equal(decodedSize(pngB64), png.length);
});

test("input parts: text first, then images in order; blank text is omitted", () => {
  const two = [png1, { ...png1, width: 9, height: 9 }];
  assert.deepEqual(buildInputParts("hello", two), [{ type: "text", text: "hello" }, { type: "image", ...two[0] }, { type: "image", ...two[1] }]);
  assert.deepEqual(buildInputParts("   ", [png1]), [{ type: "image", ...png1 }]);
  assert.deepEqual(buildInputParts("", []), []);
});

test("user message with an attachment (observed shape): metadata only, marker kept in the text", () => {
  const e = mapNotification("item/completed", {
    item: { itemId: "u1", kind: "userMessage", status: "completed", text: "Reply with one word.[Image #1]", attachments: [{ type: "image", mediaType: "image/png", width: 64, height: 64, attachmentId: "bf8d/1" }] },
  });
  assert.equal(e?.type, "userMessage");
  if (e?.type !== "userMessage") return;
  assert.equal(e.text, "Reply with one word.[Image #1]");
  assert.deepEqual(e.attachments, [{ type: "image", mediaType: "image/png", width: 64, height: 64, attachmentId: "bf8d/1" }]);
  const plain = mapNotification("item/completed", { item: { itemId: "u2", kind: "userMessage", text: "hi" } });
  assert.deepEqual(plain?.type === "userMessage" && plain.attachments, []);
});

function run() {
  const dir = mkdtempSync(join(tmpdir(), "antares-img-"));
  const reportPath = join(dir, "report.json");
  const session = new MuseSession({ binary: process.execPath, binaryArgs: [fake], workspaceRoot: dir, profile: ":ask-me", env: { ...process.env, FAKE_MUSE_REPORT: reportPath, FAKE_MUSE_MODE: "no-approval" } });
  return {
    session,
    report: () => readReport(reportPath),
    done: async () => {
      await session.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("session.send puts the image parts on turn/start, text first; image-only works", async () => {
  const t = run();
  try {
    await t.session.send("what colour?", [png1]);
    await t.session.send("", [png1]);
    await until(() => t.report().turnStarts.length === 2, "two turns");
    const [a, b] = t.report().turnStarts;
    assert.deepEqual(a?.input, [{ type: "text", text: "what colour?" }, { type: "image", ...png1 }]);
    assert.deepEqual(b?.input, [{ type: "image", ...png1 }]);
  } finally {
    await t.done();
  }
});

test("session.send refuses bad images and empty messages before touching the host", async () => {
  const t = run();
  try {
    await assert.rejects(t.session.send("x", [{ ...png1, mediaType: "image/bmp" }]), /unsupported type/);
    await assert.rejects(t.session.send("   ", []), /nothing to send/);
    assert.equal(t.report().turnStarts.length, 0);
    assert.equal(t.report().startAttempts.length, 0, "the host was not even started for a refused message");
  } finally {
    await t.done();
  }
});
