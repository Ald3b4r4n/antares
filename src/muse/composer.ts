/**
 * Pure helpers for the composer's "+" menu: what the host's skill, plugin and MCP-server lists look like to
 * the UI, how a typed `/skill args` becomes a `skill` input part, and how a picked file becomes an
 * `@path` mention. No I/O here, so it is all unit-tested.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export type SkillSource = "bundled" | "user" | "project" | "plugin";
const SKILL_SOURCES: readonly string[] = ["bundled", "user", "project", "plugin"];

export interface SkillRow {
  /** The token after the slash, exactly what a `skill` input part submits (bare, or `plugin:skill`). */
  selector: string;
  displayName: string;
  description: string;
  source: string;
  argumentHint?: string;
  pluginId?: string;
}

/** A `skill/list` result as rows for the palette, sorted by selector. Rows without a selector are dropped. */
export function mapSkills(result: unknown): SkillRow[] {
  const rows = isObj(result) && Array.isArray(result.skills) ? result.skills : [];
  const out: SkillRow[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const selector = str(row.selector);
    if (!selector) continue;
    out.push({
      selector,
      displayName: str(row.title) ?? str(row.displayName) ?? selector,
      description: str(row.description) ?? "",
      source: str(row.source) ?? "unknown",
      argumentHint: str(row.argumentHint),
      pluginId: str(row.pluginId),
    });
  }
  return out.sort((a, b) => a.selector.localeCompare(b.selector));
}

export interface SkillInvocation {
  selector: string;
  source?: SkillSource;
  arguments?: string;
}

/**
 * Reads a typed `/selector arguments` as a skill invocation, but only when the selector is in the host's
 * own list: anything else (an unknown word, a path such as `/usr/bin`) stays plain text.
 */
export function parseSlash(text: string, skills: readonly SkillRow[]): SkillInvocation | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const row = skills.find((s) => s.selector === match[1]);
  if (!row) return undefined;
  const args = match[2]?.trim();
  return {
    selector: row.selector,
    ...(SKILL_SOURCES.includes(row.source) ? { source: row.source as SkillSource } : {}),
    ...(args ? { arguments: args } : {}),
  };
}

/** Skills whose selector starts with what was typed after the slash (then those that merely contain it). */
export function filterSkills(skills: readonly SkillRow[], query: string): SkillRow[] {
  const q = query.toLowerCase();
  if (!q) return [...skills];
  const starts = skills.filter((s) => s.selector.toLowerCase().startsWith(q));
  const contains = skills.filter((s) => !s.selector.toLowerCase().startsWith(q) && `${s.selector} ${s.displayName} ${s.description}`.toLowerCase().includes(q));
  return [...starts, ...contains];
}

export interface PluginRow {
  id: string;
  version: string;
  enabled: boolean;
  /** curated, marketplaceUserAdded, foreignImport or nativeLocal (the host's provenance vocabulary). */
  source: string;
}

export function mapPlugins(result: unknown): PluginRow[] {
  const rows = isObj(result) && Array.isArray(result.plugins) ? result.plugins : [];
  const out: PluginRow[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const id = str(row.id);
    if (!id) continue;
    out.push({ id, version: str(row.version) ?? "", enabled: row.enabled === true, source: str(row.source) ?? "unknown" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type ImportSource = "claude" | "codex";

/** What `skill/import` reports, for a preview (`dryRun`) and for the real run alike. */
export interface SkillImportView {
  source: string;
  dryRun: boolean;
  /** Ids installed, or that would be installed in a preview. */
  installed: string[];
  quarantined: { id: string; reasons: string[] }[];
  /** Ids not installed because they are already imported or duplicated. */
  skipped: string[];
  failed: { id: string | null; reason: string }[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function mapSkillImport(result: unknown): SkillImportView {
  const r = isObj(result) ? result : {};
  const quarantined: SkillImportView["quarantined"] = [];
  for (const q of Array.isArray(r.quarantined) ? r.quarantined : []) if (isObj(q) && str(q.id)) quarantined.push({ id: str(q.id)!, reasons: strings(q.reasons) });
  const failed: SkillImportView["failed"] = [];
  for (const f of Array.isArray(r.failed) ? r.failed : []) if (isObj(f)) failed.push({ id: str(f.id) ?? null, reason: str(f.reason) ?? "unknown" });
  return { source: str(r.source) ?? "unknown", dryRun: r.dryRun === true, installed: strings(r.installed), quarantined, skipped: strings(r.skipped), failed };
}

export interface McpRow {
  name: string;
  /** settings, plugin or session. */
  source: string;
  transport: string;
  /** loggedIn, loggedOut or notSupported. */
  oauth: string;
}

export function mapMcpServers(result: unknown): McpRow[] {
  const rows = isObj(result) && Array.isArray(result.servers) ? result.servers : [];
  const out: McpRow[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const name = str(row.name);
    if (!name) continue;
    out.push({ name, source: str(row.source) ?? "unknown", transport: str(row.transport) ?? "unknown", oauth: str(row.oauth) ?? "unknown" });
  }
  return out;
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The image media type for a file name, when it is one Muse accepts. */
export function imageTypeFor(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? undefined : IMAGE_TYPES[fileName.slice(dot + 1).toLowerCase()];
}

/**
 * The `@relative/path` mention for a file, or undefined when the file is outside the workspace roots (the
 * host's file tools refuse those, and a mention that cannot be read would only mislead). A path with
 * spaces is quoted. Muse has no "file" input part: a mention is just text.
 */
export function mentionFor(absolutePath: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const rel = relative(root, absolutePath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const path = rel.split(sep).join("/");
    return /\s/.test(path) ? `@"${path}"` : `@${path}`;
  }
  return undefined;
}

/**
 * The form the host demands for `turn/start.workspaceRoots`: the resolved path with 8.3 short names expanded
 * and, on Windows, the extended-length prefix (`\\?\C:\...`). A path that does not exist is returned as it is
 * (the host then says what it thinks of it).
 */
export function canonicalPath(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    // The file itself may be gone (a scratch file the agent deleted): resolve the folder it was in, so a short or
    // differently-cased spelling of the folder still matches the workspace roots.
    try {
      real = join(realpathSync.native(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
  if (process.platform !== "win32" || real.startsWith("\\\\?\\")) return real;
  return real.startsWith("\\\\") ? `\\\\?\\UNC\\${real.slice(2)}` : `\\\\?\\${real}`;
}

/** The sticky workspace-root set for `turn/start`: the chat's own folder first, then the ones the user added. */
export function rootsFor(primary: string, extras: readonly string[]): string[] {
  return [primary, ...extras.filter((p) => p !== primary)];
}

/** Adds the mentions to the text, one space between pieces and no duplicates. */
export function appendMentions(text: string, mentions: readonly string[]): string {
  const missing = mentions.filter((m) => !text.includes(m));
  if (missing.length === 0) return text;
  const base = text === "" || /\s$/.test(text) ? text : `${text} `;
  return `${base}${missing.join(" ")} `;
}
