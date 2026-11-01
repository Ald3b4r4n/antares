// The host's patch artifacts: parsing, safe reading, and rebuilding the "before" side of a file edit.
// The patch shapes are the ones observed from a real Muse 1.4.14 turn (write_file and edit_file).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mapNotification } from "../../src/muse/events.ts";
import { countChanges, normalizeHostPath, parsePatch, patchRefAllowed, readPatch, relativeToRoots, reversePatch, reverseSeries, createdContent } from "../../src/muse/patches.ts";

const observedWrite = { files: [{ path: "\\\\?\\C:\\work\\plan.txt", hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ["+alpha", "+beta", "+gamma"] }] }] };
const observedEdit = { files: [{ path: "\\\\?\\C:\\work\\plan.txt", hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" alpha", "-beta", "+BETA", " gamma"] }] }] };

test("patch: the extended-length prefix is removed from host paths", () => {
  assert.equal(normalizeHostPath("\\\\?\\C:\\work\\a.txt"), "C:\\work\\a.txt");
  assert.equal(normalizeHostPath("\\\\?\\UNC\\srv\\share\\a.txt"), "\\\\srv\\share\\a.txt");
  assert.equal(normalizeHostPath("C:\\work\\a.txt"), "C:\\work\\a.txt");
  assert.equal(normalizeHostPath("/home/a.txt"), "/home/a.txt");
});

test("patch: the observed shapes parse, with counts", () => {
  const [write] = parsePatch(JSON.stringify(observedWrite));
  assert.equal(write?.path, "C:\\work\\plan.txt");
  assert.deepEqual(countChanges(write!), { added: 3, removed: 0 });
  const [edit] = parsePatch(JSON.stringify(observedEdit));
  assert.deepEqual(countChanges(edit!), { added: 1, removed: 1 });
});

test("patch: malformed input never throws and keeps only what is well formed", () => {
  assert.deepEqual(parsePatch("not json"), []);
  assert.deepEqual(parsePatch("{}"), []);
  assert.deepEqual(parsePatch(JSON.stringify({ files: [{ path: 1 }, { path: "a", hunks: "x" }] })), []);
  const odd = parsePatch(JSON.stringify({ files: [{ path: "a", hunks: [{ oldStart: -1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] }, { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+ok", 5, "no prefix"] }] }] }));
  assert.equal(odd[0]?.hunks.length, 1, "the hunk with a negative number is dropped");
  assert.deepEqual(odd[0]?.hunks[0]?.lines, ["+ok"], "non-string lines and lines without a +, - or space prefix are dropped");
});

test("patch: a reference is read only when it names a host tool-output patch, and is small", () => {
  const good = "C:\\Users\\me\\.local\\share\\muse\\sessions\\2026\\10\\31\\s1\\tool-outputs\\t1\\call_1-tool_patch.json";
  assert.equal(patchRefAllowed({ path: good }), true);
  assert.equal(patchRefAllowed({ path: `\\\\?\\${good}` }), true, "the host's extended-length form is accepted");
  assert.equal(patchRefAllowed({ path: good, byteLen: 600 * 1024 }), false, "too big");
  assert.equal(patchRefAllowed({ path: "C:\\Users\\me\\.ssh\\id_rsa" }), false, "an arbitrary file is never read");
  assert.equal(patchRefAllowed({ path: "C:\\Users\\me\\notes\\call_1-tool_patch.json" }), false, "outside a tool-outputs folder");
  assert.equal(patchRefAllowed({ path: "tool-outputs/x-tool_patch.json" }), false, "relative paths are refused");
  assert.equal(patchRefAllowed(undefined), false);
});

test("patch: readPatch reads an allowed file and ignores anything else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-patch-"));
  try {
    const folder = join(dir, "tool-outputs", "t1");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "call_1-tool_patch.json");
    writeFileSync(file, JSON.stringify(observedEdit));
    const files = await readPatch({ path: file });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.hunks[0]?.lines.length, 4);
    assert.deepEqual(await readPatch({ path: join(folder, "missing-tool_patch.json") }), []);
    const decoy = join(dir, "secret.txt");
    writeFileSync(decoy, "secret");
    assert.deepEqual(await readPatch({ path: decoy }), [], "not a patch path: never read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reverse: an edit is undone from the file as it is now", () => {
  const edit = parsePatch(JSON.stringify(observedEdit))[0]!;
  assert.equal(reversePatch("alpha\nBETA\ngamma\n", edit.hunks), "alpha\nbeta\ngamma\n");
});

test("reverse: a created file goes back to empty", () => {
  const write = parsePatch(JSON.stringify(observedWrite))[0]!;
  assert.equal(reversePatch("alpha\nbeta\ngamma\n", write.hunks), "");
});

test("reverse: CRLF files are matched, and a file without a final newline keeps none", () => {
  const edit = parsePatch(JSON.stringify(observedEdit))[0]!;
  assert.equal(reversePatch("alpha\r\nBETA\r\ngamma\r\n", edit.hunks), "alpha\nbeta\ngamma\n");
  assert.equal(reversePatch("alpha\nBETA\ngamma", edit.hunks), "alpha\nbeta\ngamma");
});

test("reverse: several hunks are undone from the last to the first", () => {
  const hunks = [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" one", "+inserted", " two"] },
    { oldStart: 9, oldLines: 2, newStart: 10, newLines: 2, lines: ["-nine", "+NINE", " ten"] },
  ];
  const now = ["one", "inserted", "two", "3", "4", "5", "6", "7", "8", "NINE", "ten"].join("\n") + "\n";
  assert.equal(reversePatch(now, hunks), ["one", "two", "3", "4", "5", "6", "7", "8", "nine", "ten"].join("\n") + "\n");
});

test("reverse: a pure deletion with no context is put back where it was", () => {
  const hunks = [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, lines: ["-beta"] }];
  assert.equal(reversePatch("alpha\ngamma\n", hunks), "alpha\nbeta\ngamma\n");
});

test("reverse: a file that changed since is never 'reconstructed'", () => {
  const edit = parsePatch(JSON.stringify(observedEdit))[0]!;
  assert.equal(reversePatch("alpha\nSOMETHING ELSE\ngamma\n", edit.hunks), undefined, "the new side is not where the patch says");
  assert.equal(reversePatch("alpha\n", edit.hunks), undefined, "the file is now shorter than the hunk");
  assert.equal(reversePatch("", edit.hunks), undefined);
});

test("paths: shown relative to the first root that holds the file", () => {
  const root = join(tmpdir(), "ws");
  const extra = join(tmpdir(), "lib");
  assert.equal(relativeToRoots(join(root, "src", "a.ts"), [root]), "src/a.ts");
  assert.equal(relativeToRoots(join(extra, "b.ts"), [root, extra]), "b.ts");
  assert.equal(relativeToRoots(join(tmpdir(), "elsewhere", "c.ts"), [root]), undefined);
  assert.equal(relativeToRoots(root, [root]), undefined);
});

test("tool calls: write_todos becomes a checklist, with the statuses normalized", () => {
  const e = mapNotification("item/completed", { item: { itemId: "t", kind: "toolCall", tool: "write_todos", status: "completed", args: JSON.stringify({ todos: [{ text: "Create plan.txt", status: "completed" }, { text: "Edit it", status: "in_progress" }, { text: "Read it", status: "pending" }, { status: "pending" }] }) } });
  assert.equal(e?.type, "toolCall");
  if (e?.type === "toolCall") {
    assert.deepEqual(e.todos, [{ text: "Create plan.txt", status: "completed" }, { text: "Edit it", status: "inProgress" }, { text: "Read it", status: "pending" }], "an item without text is dropped");
    assert.equal(e.summary, "3 tasks, 1 done");
  }
});

test("tool calls: write_file and edit_file carry the file, the counts and the patch reference", () => {
  const e = mapNotification("item/completed", {
    item: { itemId: "w", kind: "toolCall", tool: "edit_file", status: "completed", args: '{"path":"plan.txt","find":"beta","replace":"BETA"}', patchSummary: { files: 1, added: 1, removed: 1 }, patchRef: { id: "p", kind: "tool_patch", path: "C:\\x\\tool-outputs\\1\\c-tool_patch.json", byteLen: 231, availability: "available" } },
  });
  assert.equal(e?.type, "toolCall");
  if (e?.type === "toolCall") {
    assert.deepEqual(e.file, { op: "edit", path: "plan.txt", added: 1, removed: 1 });
    assert.deepEqual(e.patchRef, { path: "C:\\x\\tool-outputs\\1\\c-tool_patch.json", byteLen: 231 });
    assert.equal(e.summary, "plan.txt");
  }
  const started = mapNotification("item/started", { item: { itemId: "w2", kind: "toolCall", tool: "write_file", status: "inProgress", args: '{"path":"a.txt","content":"x"}' } });
  if (started?.type === "toolCall") {
    assert.equal(started.file?.op, "write");
    assert.equal(started.patchRef, undefined, "no patch until the call has finished");
  }
});

test("tool calls: other tools keep the plain summary and gain no extra fields", () => {
  const e = mapNotification("item/completed", { item: { itemId: "r", kind: "toolCall", tool: "read_file", status: "completed", args: '{"path":"plan.txt"}', visibleOutput: "1|alpha" } });
  assert.equal(e?.type, "toolCall");
  if (e?.type === "toolCall") {
    assert.equal(e.summary, "plan.txt");
    assert.equal("todos" in e, false);
    assert.equal("file" in e, false);
    assert.equal("patchRef" in e, false);
  }
});

// Three successive edits of one file, as separate patches: create it, change line 2, append a line.
const e1 = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ["+one", "+two", "+three"] }];
const e2 = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] }];
const e3 = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [" three", "+four"] }];

test("series: the file before a whole run of edits is rebuilt from the file as it is now", () => {
  assert.equal(reverseSeries("one\nTWO\nthree\nfour\n", [e2, e3]), "one\ntwo\nthree\n", "two edits undone, latest first");
  assert.equal(reverseSeries("one\nTWO\nthree\nfour\n", [e1, e2, e3]), "", "a file created in the series goes back to empty");
  assert.equal(reverseSeries("one\nTWO\nthree\nfour\n", [e3]), "one\nTWO\nthree\n", "one edit");
  assert.equal(reverseSeries("anything\n", []), "anything\n", "no edits: nothing to undo");
});

test("series: a file that changed outside the chat, or an edit that is missing, gives no false 'before'", () => {
  assert.equal(reverseSeries("one\nTWO\nTHREE\nfour\n", [e2, e3]), undefined, "a line inside the region an edit touched was changed since");
  assert.equal(reverseSeries("one\nTWO\nthree\nfour\nfive\n", [e2, e3]), "one\ntwo\nthree\nfive\n", "a change elsewhere in the file is kept: only the chat's edits are undone");
  assert.equal(reverseSeries("one\nTWO\nthree\nfour\n", [e1, e3]), undefined, "the middle edit is missing: undoing e3 then e1 does not fit");
  assert.equal(reverseSeries("one\nTWO\nthree\nfour\n", [e3, e2]), "one\ntwo\nthree\n", "edits to different lines commute, so the order does not change the answer");
});

test("created content: what an edit that created the file wrote, for a file that was deleted afterwards", () => {
  assert.equal(createdContent(parsePatch(JSON.stringify(observedWrite))[0]!.hunks), "alpha\nbeta\ngamma\n");
  assert.equal(createdContent(e1), "one\ntwo\nthree\n");
  assert.equal(createdContent(parsePatch(JSON.stringify(observedEdit))[0]!.hunks), undefined, "an edit of an existing file is not a creation");
  assert.equal(createdContent([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+a", "+b"] }]), undefined, "removing a line means it was not a creation");
  assert.equal(createdContent([]), undefined);
});
