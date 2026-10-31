import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Finds the Muse executable. Order: explicit path, PATH, default install location.
 * Returns undefined when nothing is found; callers decide how to report that.
 */
export function locateMuse(explicit?: string): string | undefined {
  if (explicit && explicit.trim() !== "") {
    return existsSync(explicit) ? explicit : undefined;
  }
  const isWindows = process.platform === "win32";
  const names = isWindows ? ["muse.exe"] : ["muse"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (isWindows && localAppData) {
    const candidate = join(localAppData, "Programs", "muse", "muse.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
