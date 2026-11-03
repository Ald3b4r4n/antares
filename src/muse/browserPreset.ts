/**
 * The "browser" preset: Microsoft's Playwright MCP server (`@playwright/mcp`), added to Muse's settings as an ordinary MCP
 * server so that the agent can open a page, look at it, click, type and take a screenshot. Pure helpers plus the npm
 * install, with the process runner injected so both can be tested; the questions and the settings write are in chatPanel.ts.
 *
 * It is third-party code from npm: it is installed at a pinned version with install scripts off, into the extension's own
 * storage, and it drives the browser that is already installed (Edge or Chrome), headless, in a throwaway profile (no
 * cookies, no logins, nothing kept). Muse starts an MCP server with only the environment written in its entry, so the entry
 * carries the few variables a program needs to run on Windows, with their values at the time it was added.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Pinned: the version that was tested elsewhere (Capella, with another host) and is more than two weeks old. Updating it is a decision, not a side effect. */
export const PLAYWRIGHT_MCP_VERSION = "0.0.83";

export type BrowserScope = "local" | "web";
export type BrowserChannel = "msedge" | "chrome";

/** Only this computer: the browser may load pages served from here. */
export const LOCAL_ORIGINS = "http://127.0.0.1:*;http://localhost:*;http://[::1]:*";

/** The installed browser Playwright can drive without downloading one: Edge, else Chrome on Windows; Chrome elsewhere. Undefined when neither is installed. */
export function browserChannel(platform: string, exists: (path: string) => boolean, env: Record<string, string | undefined> = process.env): BrowserChannel | undefined {
  if (platform === "win32") {
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]].filter((r): r is string => !!r);
    const has = (rel: string) => roots.some((root) => exists(`${root}\\${rel}`));
    if (has("Microsoft\\Edge\\Application\\msedge.exe")) return "msedge";
    if (has("Google\\Chrome\\Application\\chrome.exe")) return "chrome";
    return undefined;
  }
  if (platform === "darwin") return exists("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "chrome" : undefined;
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].some(exists) ? "chrome" : undefined;
}

/** The arguments after `node`: the installed CLI and its options. Isolated (in-memory profile), headless, service workers blocked, screenshots written to a folder Antares owns. */
export function browserArgs(cli: string, channel: BrowserChannel, scope: BrowserScope, outDir: string): string[] {
  return [cli, "--browser", channel, "--isolated", "--headless", "--block-service-workers", ...(scope === "local" ? ["--allowed-origins", LOCAL_ORIGINS] : []), "--output-dir", outDir];
}

/** The only variables copied into the server's entry: what a program needs to run and to find an installed browser. No secrets, no PATH. */
const ENV_NAMES = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "COMSPEC", "PATHEXT", "HOME"];

/** The environment written into the entry: the allowed names that are set now. */
export function browserEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value !== "" && /^[A-Za-z_][A-Za-z0-9_()]*$/.test(name)) out[name] = value;
  }
  return out;
}

/** The absolute path of `node` on this PATH. Muse does not search a PATH for an MCP server's command, so the entry needs the full path. */
export function findNode(env: Record<string, string | undefined> = process.env, platform: string = process.platform, exists: (path: string) => boolean = existsSync): string | undefined {
  const file = platform === "win32" ? "node.exe" : "node";
  const raw = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of raw.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^"|"$/g, ""), file);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** npm's own script, found next to node (both the installer and the zip put it there). Running it with node avoids a shell. */
export function findNpmCli(node: string, exists: (path: string) => boolean = existsSync): string | undefined {
  const dir = dirname(node);
  return [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(exists);
}

export type Run = (file: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; output: string }>;

/** The real runner: execFile, never a shell, output kept short. */
export const run: Run = (file, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(-4000);
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      resolve({ code, output: error && output === "" ? String(error) : output });
    });
  });

/** The CLI file of the installed package, and whether the installed version is the pinned one. */
export function installedCli(dir: string, read: (path: string) => string | undefined): { cli: string; ok: boolean } {
  const base = join(dir, "node_modules", "@playwright", "mcp");
  const text = read(join(base, "package.json"));
  let version: unknown;
  try {
    version = text ? (JSON.parse(text) as { version?: unknown }).version : undefined;
  } catch {
    version = undefined;
  }
  return { cli: join(base, "cli.js"), ok: version === PLAYWRIGHT_MCP_VERSION };
}

/** Installs the pinned package into `dir` with npm's install scripts off. Every argument is fixed here; none comes from the user or a page. */
export async function installBrowserServer(dir: string, node: string, npmCli: string, exec: Run = run): Promise<{ ok: boolean; output: string }> {
  const result = await exec(node, [npmCli, "install", "--prefix", ".", "--ignore-scripts", "--no-audit", "--no-fund", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`], { cwd: dir, timeoutMs: 180_000 });
  return { ok: result.code === 0, output: result.output };
}
