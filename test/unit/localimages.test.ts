// Workspace images shown in the chat: what may be read from disk and what is refused. The page never reads a file;
// the extension does, with these checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalPath } from "../../src/muse/composer.ts";
import { mapNotification } from "../../src/muse/events.ts";
import { MAX_IMAGE_BYTES } from "../../src/muse/images.ts";
import { loadWorkspaceImage, looksLikeUrl } from "../../src/muse/localImages.ts";
import { normalizeHostPath } from "../../src/muse/patches.ts";

// A real 1x1 PNG, and a JPEG signature with a few bytes after it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "antares-img-"));
  const workspace = join(dir, "workspace");
  const outside = join(dir, "outside");
  mkdirSync(join(workspace, "docs"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, "pic.png"), PNG);
  writeFileSync(join(workspace, "docs", "shot.jpg"), JPEG);
  writeFileSync(join(workspace, "fake.png"), "this is not a png");
  writeFileSync(join(workspace, "vector.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(outside, "secret.png"), PNG);
  const roots = [normalizeHostPath(canonicalPath(workspace))];
  return { dir, workspace, outside, roots, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("images: a PNG in the workspace is shown, by relative or absolute path", async () => {
  const t = setup();
  try {
    const rel = await loadWorkspaceImage("pic.png", t.roots);
    assert.ok(rel.ok);
    assert.ok(rel.ok && rel.dataUrl.startsWith("data:image/png;base64,"));
    assert.ok(rel.ok && rel.bytes === PNG.length);
    assert.ok((await loadWorkspaceImage("./docs/shot.jpg", t.roots)).ok, "a JPEG in a subfolder");
    assert.ok((await loadWorkspaceImage(join(t.workspace, "pic.png"), t.roots)).ok, "an absolute path inside the workspace");
    assert.ok((await loadWorkspaceImage("  pic.png  ", t.roots)).ok, "surrounding spaces are ignored");
  } finally {
    t.done();
  }
});

test("images: addresses and network paths are never fetched", async () => {
  const t = setup();
  try {
    for (const bad of ["https://example.com/a.png", "http://localhost/a.png", "data:image/png;base64,AAAA", "file:///C:/x.png", "javascript:alert(1).png", "//server/share/a.png", "\\\\server\\share\\a.png"]) {
      const r = await loadWorkspaceImage(bad, t.roots);
      assert.equal(r.ok, false, bad);
      assert.match(r.ok ? "" : r.reason, /never addresses/, bad);
    }
    assert.equal(looksLikeUrl("C:\\work\\a.png"), false, "a drive letter is not a URL scheme");
    assert.equal(looksLikeUrl("C:/work/a.png"), false);
    assert.equal(looksLikeUrl("https://x"), true);
  } finally {
    t.done();
  }
});

test("images: a path that climbs out of the workspace, or points elsewhere, is refused", async () => {
  const t = setup();
  try {
    const up = await loadWorkspaceImage("../outside/secret.png", t.roots);
    assert.deepEqual(up, { ok: false, reason: "outside this chat's folders" });
    const abs = await loadWorkspaceImage(join(t.outside, "secret.png"), t.roots);
    assert.deepEqual(abs, { ok: false, reason: "outside this chat's folders" });
    const missing = await loadWorkspaceImage("nope.png", t.roots);
    assert.deepEqual(missing, { ok: false, reason: "file not found in the workspace" });
  } finally {
    t.done();
  }
});

test("images: a symlink inside the workspace that points outside is refused (where links can be made)", async () => {
  const t = setup();
  try {
    try {
      symlinkSync(join(t.outside, "secret.png"), join(t.workspace, "link.png"));
    } catch {
      return; // creating symlinks needs a privilege on some Windows setups: nothing to check there
    }
    assert.deepEqual(await loadWorkspaceImage("link.png", t.roots), { ok: false, reason: "outside this chat's folders" });
  } finally {
    t.done();
  }
});

test("images: only PNG, JPEG, GIF and WebP are shown, and the bytes must really be that type", async () => {
  const t = setup();
  try {
    const svg = await loadWorkspaceImage("vector.svg", t.roots);
    assert.deepEqual(svg, { ok: false, reason: "not a PNG, JPEG, GIF or WebP image" });
    assert.deepEqual(await loadWorkspaceImage("notes.txt", t.roots), { ok: false, reason: "not a PNG, JPEG, GIF or WebP image" });
    const fake = await loadWorkspaceImage("fake.png", t.roots);
    assert.equal(fake.ok, false);
    assert.match(fake.ok ? "" : fake.reason, /not really a PNG image/);
  } finally {
    t.done();
  }
});

test("images: a file over the size limit is refused with the sizes", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.workspace, "big.png"), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_IMAGE_BYTES + 10)]));
    const r = await loadWorkspaceImage("big.png", t.roots);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /too large to show \(5\.0 MB; the limit is 5 MB\)/);
  } finally {
    t.done();
  }
});

test("images: odd input is refused before any disk access", async () => {
  const t = setup();
  try {
    for (const bad of ["", "   ", "a\u0000b.png", "x".repeat(600) + ".png"]) assert.equal((await loadWorkspaceImage(bad, t.roots)).ok, false);
    assert.deepEqual(await loadWorkspaceImage("pic.png", []), { ok: false, reason: "no folder is open" });
    assert.equal((await loadWorkspaceImage(undefined as unknown as string, t.roots)).ok, false);
  } finally {
    t.done();
  }
});

test("tool calls: a read_file of an image carries its path; other files and tools do not", () => {
  const read = mapNotification("item/completed", { item: { itemId: "r", kind: "toolCall", tool: "read_file", status: "completed", args: '{"path":"picture.png"}', visibleOutput: "Read image file `picture.png` as model-visible image output.\nmedia_type: image/png\nsource_bytes: 158" } });
  assert.equal(read?.type, "toolCall");
  if (read?.type === "toolCall") {
    assert.equal(read.imagePath, "picture.png");
    assert.equal(read.summary, "picture.png");
  }
  const text = mapNotification("item/completed", { item: { itemId: "t", kind: "toolCall", tool: "read_file", status: "completed", args: '{"path":"notes.txt"}' } });
  if (text?.type === "toolCall") assert.equal("imagePath" in text, false);
  const write = mapNotification("item/completed", { item: { itemId: "w", kind: "toolCall", tool: "write_file", status: "completed", args: '{"path":"a.png","content":"x"}' } });
  if (write?.type === "toolCall") assert.equal("imagePath" in write, false, "only reads are shown as images");
});
