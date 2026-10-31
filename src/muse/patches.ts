import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/**
 * The host's own record of a file change made by a tool call. For `write_file` and `edit_file` the tool call
 * carries `patchSummary` and a `patchRef` whose file is a JSON `{files: [{path, hunks: [{oldStart, oldLines,
 * newStart, newLines, lines}]}]}`; each line starts with `+`, `-` or a space (observed on Muse 1.4.14). Antares
 * shows it as a diff and can rebuild the file as it was before, to open VS Code's diff editor.
 */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each starts with "+" (added), "-" (removed) or " " (context). */
  lines: string[];
}

export interface PatchFile {
  /** The path as the host wrote it, with any Windows extended-length prefix removed. */
  path: string;
  hunks: PatchHunk[];
}

export interface PatchRef {
  path: string;
  byteLen?: number;
}

const MAX_PATCH_BYTES = 512 * 1024;
const MAX_LINES_PER_FILE = 2000;

/** `\\?\C:\x` becomes `C:\x` (and `\\?\UNC\h\s` becomes `\\h\s`). */
export function normalizeHostPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Reads the patch JSON, dropping anything malformed. Never throws. */
export function parsePatch(text: string): PatchFile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const files = isObj(raw) && Array.isArray(raw.files) ? raw.files : [];
  const out: PatchFile[] = [];
  for (const f of files) {
    if (!isObj(f) || typeof f.path !== "string" || !Array.isArray(f.hunks)) continue;
    const hunks: PatchHunk[] = [];
    let total = 0;
    for (const h of f.hunks) {
      if (!isObj(h) || !Array.isArray(h.lines)) continue;
      const oldStart = int(h.oldStart);
      const oldLines = int(h.oldLines);
      const newStart = int(h.newStart);
      const newLines = int(h.newLines);
      if (oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined) continue;
      const lines = h.lines.filter((l): l is string => typeof l === "string" && /^[+\- ]/.test(l));
      total += lines.length;
      if (total > MAX_LINES_PER_FILE) break;
      hunks.push({ oldStart, oldLines, newStart, newLines, lines });
    }
    out.push({ path: normalizeHostPath(f.path), hunks });
  }
  return out;
}

/**
 * Whether a patch reference may be read at all. It names a file the host wrote under its own session store, in a
 * `tool-outputs` folder, and is small. Anything else is ignored: a tool call's metadata is not a reason to read
 * an arbitrary path.
 */
export function patchRefAllowed(ref: PatchRef | undefined): ref is PatchRef {
  if (!ref || typeof ref.path !== "string" || !isAbsolute(normalizeHostPath(ref.path))) return false;
  const path = normalizeHostPath(ref.path);
  if (!/-tool_patch\.json$/.test(path)) return false;
  if (!path.split(/[\\/]/).includes("tool-outputs")) return false;
  if (ref.byteLen !== undefined && ref.byteLen > MAX_PATCH_BYTES) return false;
  return true;
}

export async function readPatch(ref: PatchRef | undefined): Promise<PatchFile[]> {
  if (!patchRefAllowed(ref)) return [];
  const path = normalizeHostPath(ref.path);
  try {
    if ((await stat(path)).size > MAX_PATCH_BYTES) return [];
    return parsePatch(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

const splitLines = (text: string): { lines: string[]; endsWithNewline: boolean } => {
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: text === "" ? [] : body.split("\n"), endsWithNewline };
};

/**
 * Rebuilds a file as it was before a patch, from the file as it is now. It only does so when every hunk's
 * "new side" (its context and added lines) is found exactly where the hunk says, so a file that changed
 * since is never "reconstructed" into something false: then it returns undefined and the caller shows the
 * file only. Line endings are normalized to "\n" for the match and the result uses "\n".
 */
export function reversePatch(current: string, hunks: readonly PatchHunk[]): string | undefined {
  const normalized = current.replace(/\r\n/g, "\n");
  const { lines, endsWithNewline } = splitLines(normalized);
  const result = [...lines];
  // From the last hunk to the first, so earlier line numbers stay valid.
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const newSide = hunk.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const oldSide = hunk.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    // A hunk with no new-side lines starts "after" its line number (newStart is the line before the gap).
    const at = newSide.length === 0 ? hunk.newStart : hunk.newStart - 1;
    if (at < 0 || at + newSide.length > result.length) return undefined;
    for (let i = 0; i < newSide.length; i++) if (result[at + i] !== newSide[i]) return undefined;
    result.splice(at, newSide.length, ...oldSide);
  }
  if (result.length === 0) return "";
  return result.join("\n") + (endsWithNewline || lines.length === 0 ? "\n" : "");
}

/** Added and removed line counts of one file's hunks. */
export function countChanges(file: PatchFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of file.hunks) for (const l of h.lines) l[0] === "+" ? added++ : l[0] === "-" ? removed++ : undefined;
  return { added, removed };
}

/** The path relative to the first root that contains it, with "/" separators; undefined when none does. */
export function relativeToRoots(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  }
  return undefined;
}
