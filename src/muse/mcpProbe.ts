import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProbeConfig } from "./mcpSettings.ts";

export interface McpTestOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: arguments placed before `exec`. */
  binaryArgs?: string[];
  timeoutMs?: number;
}

export interface McpTestResult {
  started: boolean;
  /** Muse's own words for why it did not start, when it did not. */
  reason?: string;
}

/**
 * Asks Muse itself to start ONE configured MCP server. It runs `muse exec --provider echo` (the echo provider needs no
 * account and makes no model call) against a throwaway, clean settings file that holds only that server, forced to
 * `required`: Muse then aborts the run with the reason when the server cannot start, and finishes normally when the handshake
 * works. Secrets are passed through the process environment as `${VAR}` references, never written to disk. Antares does
 * not launch the server itself.
 *
 * What this proves: Muse can start the server with this configuration in a clean environment (the handshake completed).
 * What it does not prove: that a tool call works (that needs a model turn), that the server finds files in the user's own
 * home folder, or that an HTTP server accepts the user's saved sign-in (the clean config has none).
 */
export async function testMcpServer(name: string, rawEntry: Record<string, unknown>, options: McpTestOptions): Promise<McpTestResult> {
  const probe = buildProbeConfig(name, rawEntry);
  const dir = await mkdtemp(join(tmpdir(), "antares-mcptest-"));
  try {
    const cfg = join(dir, "config");
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    for (const d of [join(cfg, "muse"), home, workspace, join(dir, "data")]) await mkdir(d, { recursive: true });
    await writeFile(join(cfg, "muse", "settings.json"), probe.settings, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      ...probe.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: cfg,
      XDG_DATA_HOME: join(dir, "data"),
      APPDATA: cfg,
      META_API_KEY: "",
      MUSE_AUTH_PATH: join(cfg, "absent-auth.json"),
    };
    return await new Promise<McpTestResult>((resolve) => {
      execFile(
        options.binary,
        [...(options.binaryArgs ?? []), "exec", "--provider", "echo", "--json", "--workspace", workspace, "connectivity check"],
        { cwd: workspace, env, timeout: options.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve({ started: true });
          const text = `${stderr}\n${stdout}`;
          const named = /Required MCP server `[^`]*` failed during startup: ([^"\n]*)/.exec(text);
          if (named) return resolve({ started: false, reason: `Required MCP server failed during startup: ${named[1]!.trim()}` });
          if ((error as { killed?: boolean }).killed) return resolve({ started: false, reason: "Muse did not finish starting the server in time." });
          const first = text.split("\n").find((l) => l.trim() !== "")?.slice(0, 240);
          resolve({ started: false, reason: first ?? error.message });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
