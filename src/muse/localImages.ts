import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalPath, imageTypeFor } from "./composer.ts";
import { MAX_IMAGE_BYTES, matchesSignature } from "./images.ts";
import { normalizeHostPath, relativeToRoots } from "./patches.ts";

/**
 * Images the chat shows from disk: a file an assistant message points to (`![alt](path)`) or a file a tool call
 * read. Muse does not hand a client the image a model saw through a tool (observed: no `modelVisibleContent`, no
 * `outputRef`), so the only honest source is the file itself. It is read here, in the extension, never fetched by the
 * page, and only when it is clearly the user's own workspace content:
 *
 * - not a URL or a network path, and no control characters;
 * - a PNG, JPEG, GIF or WebP by name (SVG is left out on purpose);
 * - inside the chat's folders after resolving symlinks and short names;
 * - within the size limit, and its bytes really are that image type.
 */

export type ImageLoad = { ok: true; mediaType: string; dataUrl: string; bytes: number } | { ok: false; reason: string };

const MAX_PATH_LENGTH = 500;

/** `http:`, `data:`, `file:` and the like (two or more letters before the colon); a drive letter such as `C:` is not one. */
export function looksLikeUrl(path: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(path);
}

export async function loadWorkspaceImage(requested: string, roots: readonly string[]): Promise<ImageLoad> {
  const path = typeof requested === "string" ? requested.trim() : "";
  if (path === "" || path.length > MAX_PATH_LENGTH || /[\u0000-\u001f]/.test(path)) return { ok: false, reason: "not a usable file path" };
  if (looksLikeUrl(path) || path.startsWith("//") || path.startsWith("\\\\")) return { ok: false, reason: "only files in the workspace are shown, never addresses" };
  const mediaType = imageTypeFor(path);
  if (!mediaType) return { ok: false, reason: "not a PNG, JPEG, GIF or WebP image" };
  if (roots.length === 0) return { ok: false, reason: "no folder is open" };

  const candidates = isAbsolute(path) ? [path] : roots.map((root) => resolve(root, path));
  let sawOutside = false;
  for (const candidate of candidates) {
    const real = normalizeHostPath(canonicalPath(candidate));
    let size: number;
    try {
      const info = await stat(real);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      continue; // not there: try the next folder
    }
    if (relativeToRoots(real, roots) === undefined) {
      sawOutside = true;
      continue;
    }
    if (size > MAX_IMAGE_BYTES) return { ok: false, reason: `too large to show (${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB)` };
    const bytes = await readFile(real);
    const base64 = bytes.toString("base64");
    if (!matchesSignature(mediaType, base64)) return { ok: false, reason: `the file is not really a ${mediaType.slice(6).toUpperCase()} image` };
    return { ok: true, mediaType, dataUrl: `data:${mediaType};base64,${base64}`, bytes: bytes.length };
  }
  return { ok: false, reason: sawOutside ? "outside this chat's folders" : "file not found in the workspace" };
}
