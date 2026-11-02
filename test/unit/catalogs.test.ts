// Suggested catalogs (a plugin marketplace and a skills collection that were checked against the real Muse), the safe way to fetch a
// skills collection (HTTPS Git only, shallow, into a throwaway folder), and finding the skills inside it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchCollection, isFetchableUrl, pendingSuggestions, scanSkills, SUGGESTED } from "../../src/muse/catalogs.ts";
import { addMarketplace } from "../../src/muse/pluginsCli.ts";

const fakeCli = new URL("../fixtures/fake-muse-cli.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("the suggested catalogs are few, named, explained and fetched over HTTPS", () => {
  assert.ok(SUGGESTED.length >= 2 && SUGGESTED.length <= 4, "a short list: it is a starting point, not a store");
  assert.equal(new Set(SUGGESTED.map((s) => s.name)).size, SUGGESTED.length);
  for (const s of SUGGESTED) {
    assert.match(s.source, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
    assert.ok(s.title && s.note && s.verified, "each one says what it is, what to expect and how it was checked");
    assert.ok(s.kind === "plugins" || s.kind === "skills");
  }
  assert.ok(SUGGESTED.some((s) => s.kind === "plugins") && SUGGESTED.some((s) => s.kind === "skills"));
});

test("pendingSuggestions leaves out the plugin catalogs Muse already has", () => {
  const first = SUGGESTED.find((s) => s.kind === "plugins")!;
  const all = pendingSuggestions([]);
  assert.ok(all.some((s) => s.name === first.name));
  const rest = pendingSuggestions([{ name: first.name, kind: "git", source: first.source, pluginCount: 3 }]);
  assert.equal(rest.some((s) => s.name === first.name), false);
  assert.ok(rest.some((s) => s.kind === "skills"), "a skills collection is not a marketplace, so it is always offered");
});

test("only plain HTTPS URLs are fetched: no transports that run commands, no local paths", () => {
  assert.equal(isFetchableUrl("https://github.com/anthropics/skills.git"), true);
  for (const bad of ["ext::sh -c 'calc'", "file:///C:/x", "git://github.com/a/b.git", "http://github.com/a/b.git", "https://github.com/a/b.git --upload-pack=calc", "-oProxyCommand=x", "C:\\repo", ""]) assert.equal(isFetchableUrl(bad), false, bad);
});

function localRepo(): { dir: string; url: string } {
  const dir = mkdtempSync(join(tmpdir(), "antares-coll-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  mkdirSync(join(repo, "skills", "beta", "nested"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: The alpha skill.\n---\nBody.\n");
  writeFileSync(join(repo, "skills", "beta", "SKILL.md"), "no frontmatter here\n");
  writeFileSync(join(repo, "skills", "beta", "nested", "SKILL.md"), "---\nname: nested\ndescription: Deep.\n---\n");
  writeFileSync(join(repo, "node_modules", "ignored", "SKILL.md"), "---\nname: ignored\ndescription: x\n---\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, url: repo };
}

test("scanSkills finds each SKILL.md with its name and description, skipping dependency folders", async () => {
  const { dir, url } = localRepo();
  try {
    const found = await scanSkills(url);
    assert.deepEqual(found.map((s) => s.name).sort(), ["alpha", "beta", "nested"]);
    const alpha = found.find((s) => s.name === "alpha")!;
    assert.equal(alpha.description, "The alpha skill.");
    assert.equal(alpha.relativePath.replace(/\\/g, "/"), "skills/alpha");
    assert.equal(found.find((s) => s.name === "beta")!.description, "", "no frontmatter: the folder name, no invented description");
    assert.equal(found.some((s) => s.name === "ignored"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanSkills reads a description written as a YAML block (> or |), as real skills do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-yaml-"));
  try {
    mkdirSync(join(dir, "folded"), { recursive: true });
    mkdirSync(join(dir, "literal"), { recursive: true });
    writeFileSync(join(dir, "folded", "SKILL.md"), "---\nname: folded\ndescription: >\n  First line\n  second line.\nother: x\n---\n");
    writeFileSync(join(dir, "literal", "SKILL.md"), "---\nname: literal\ndescription: |-\n  Kept as one thought.\n---\n");
    const found = await scanSkills(dir);
    assert.equal(found.find((s) => s.name === "folded")!.description, "First line second line.");
    assert.equal(found.find((s) => s.name === "literal")!.description, "Kept as one thought.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchCollection clones shallowly into a throwaway folder and cleans up (local path allowed only through the test seam)", async () => {
  const { dir, url } = localRepo();
  try {
    const got = await fetchCollection(url, { allowLocal: true });
    assert.ok(existsSync(join(got.dir, "skills", "alpha", "SKILL.md")));
    assert.equal(readFileSync(join(got.dir, "skills", "alpha", "SKILL.md"), "utf8").includes("alpha"), true);
    await got.cleanup();
    assert.equal(existsSync(got.dir), false);
    await assert.rejects(fetchCollection(url), /https/i, "without the seam a local path is refused");
    await assert.rejects(fetchCollection("ext::sh -c calc", { allowLocal: true }), /https|refus/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addMarketplace (CLI) adds a catalog, reports what Muse could use and skipped, and verifies it is listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-addm-"));
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ plugins: [], marketplaces: [] }));
  try {
    const options = { binary: process.execPath, binaryArgs: [fakeCli], cwd: dir, env: { ...process.env, FAKE_PLUGINS_STATE: state, FAKE_MARKET_USABLE: "29", FAKE_MARKET_SKIPPED: "12" } };
    const result = await addMarketplace(options, "demo", "https://github.com/x/y.git");
    assert.deepEqual(result, { name: "demo", pluginCount: 29, skipped: 12 });
    const lying = { ...options, env: { ...options.env, FAKE_PLUGINS_MODE: "ignore" } };
    await assert.rejects(addMarketplace(lying, "other", "https://github.com/x/z.git"), /not listed/);
    await assert.rejects(addMarketplace(options, "bad name!", "https://github.com/x/y.git"), /name/i);
    await assert.rejects(addMarketplace(options, "demo2", "ext::sh -c calc"), /https|folder/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
