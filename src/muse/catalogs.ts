import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { MarketplaceRow } from "./pluginsCli.ts";

/**
 * Catalogs Antares suggests so a new user has something to start from. They are SUGGESTIONS: the extension never adds one to
 * Muse's configuration by itself; the user is asked once and can decline, and can always add their own. Each entry was checked
 * against the real Muse 1.4.14 (see docs/EVOLUCAO.md): the plugin marketplace was added and its plugins counted; the skills
 * collection was cloned and its SKILL.md files found. What is third-party code stays behind Muse's own approvals.
 */
export interface SuggestedCatalog {
  /** The name used if the catalog is added to Muse. */
  name: string;
  title: string;
  /** `plugins`: a marketplace Muse reads. `skills`: a repository of SKILL.md folders Antares fetches and installs from. */
  kind: "plugins" | "skills";
  source: string;
  /** What to expect, including limits. */
  note: string;
  /** How it was checked, and when. */
  verified: string;
}

export const SUGGESTED: SuggestedCatalog[] = [
  {
    name: "claude-plugins-official",
    title: "Anthropic's official plugins",
    kind: "plugins",
    source: "https://github.com/anthropics/claude-plugins-official.git",
    note: "29 plugins load with Muse. Many others in the list point to other repositories or use a layout Muse does not support, and Muse skips them. Adding it downloads the catalog (about 20 seconds). Installing any plugin is a separate step with its own review of hooks and MCP servers.",
    verified: "Added with muse plugins marketplace add in an isolated config on 2026-11-02: 29 usable plugins.",
  },
  {
    name: "anthropic-skills",
    title: "Anthropic's Agent Skills",
    kind: "skills",
    source: "https://github.com/anthropics/skills.git",
    note: "A collection of skills (SKILL.md folders), not a Muse marketplace. Antares downloads it, lists the skills, and installs the ones you pick, after Muse validates each. A skill is a set of instructions the model follows: read what you install.",
    verified: "Cloned and scanned on 2026-11-02; installing is the same validated path as any skill folder.",
  },
];

/** The suggestions not yet in Muse. A skills collection is not a marketplace, so it is always offered. */
export function pendingSuggestions(existing: MarketplaceRow[]): SuggestedCatalog[] {
  const have = new Set(existing.map((m) => m.name));
  return SUGGESTED.filter((s) => s.kind === "skills" || !have.has(s.name));
}

/** Only plain HTTPS URLs ending in .git are fetched. No git transport that runs commands (`ext::`), no `file:`, no options, no local paths. */
export function isFetchableUrl(url: string): boolean {
  return /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+$/.test(url) && !url.includes("..") && !/\s/.test(url);
}

function git(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 180_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:file" } }, (error, _out, stderr) => {
      if (error) reject(new Error(stderr.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) || error.message));
      else resolve();
    });
  });
}

export interface FetchedCollection {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Downloads a skills collection: a shallow clone into a new, empty, throwaway folder. Nothing in it is run. `allowLocal` is a
 * test seam only (a local repository instead of a URL).
 */
export async function fetchCollection(url: string, opts: { allowLocal?: boolean } = {}): Promise<FetchedCollection> {
  const local = opts.allowLocal === true && !url.startsWith("ext::") && !url.startsWith("-");
  if (!local && !isFetchableUrl(url)) throw new Error("Only plain https:// Git URLs can be downloaded.");
  const parent = await mkdtemp(join(tmpdir(), "antares-collection-"));
  const dir = join(parent, "repo");
  try {
    await git(["clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, dir]);
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`Could not download the collection: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { dir, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

export interface FoundSkill {
  name: string;
  description: string;
  /** The skill's folder, relative to the collection's root. */
  relativePath: string;
  /** The skill's folder on disk (inside the throwaway clone). */
  dir: string;
}

const SKIP = new Set(["node_modules", ".git", ".venv", "dist", "build", "__pycache__"]);

function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1]!.split(/\r?\n/);
  // A value is on the key's line, or (YAML block scalars `>` and `|`) on the indented lines that follow it.
  const pick = (key: string): string | undefined => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const inline = lines[at]!.slice(key.length + 1).trim();
    if (!/^[>|][+-]?$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== "" && !/^\s/.test(l)) break;
      body.push(l.trim());
    }
    return body.filter(Boolean).join(" ");
  };
  return { name: pick("name"), description: pick("description") };
}

/** Finds each folder holding a SKILL.md (up to five levels deep), with the name and description its frontmatter gives. */
export async function scanSkills(root: string): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const meta = frontmatter(await readFile(join(dir, "SKILL.md"), "utf8").catch(() => ""));
      const folder = dir.split(/[\\/]/).pop() ?? dir;
      found.push({ name: meta.name ?? folder, description: meta.description ?? "", relativePath: relative(root, dir), dir });
    }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name), depth + 1);
  };
  await walk(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
