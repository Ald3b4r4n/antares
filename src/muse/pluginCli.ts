import { execFile } from "node:child_process";

/**
 * The two read-only plugin questions MSP cannot answer, asked of Muse's own CLI: what is inside a bundle before it
 * is installed (`muse plugins validate`, which installs and executes nothing) and which plugins the configured
 * marketplaces offer (`muse plugins list --available`). Both read; neither changes anything.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export interface PluginPreview {
  valid: boolean;
  id?: string;
  version?: string;
  description?: string;
  /** What the bundle contributes. Hooks and MCP servers are code that runs on this computer. */
  skills: number;
  hooks: number;
  mcpServers: number;
  commands: number;
  reminders: number;
  /** Problems found, worst first: the reason a bundle is refused, or advisories about a valid one. */
  diagnostics: string[];
}

/** Reads the JSON of `muse plugins validate --json` (valid bundle, or the `{error: {...}}` of an invalid one). */
export function mapValidate(json: unknown): PluginPreview {
  const root = isObj(json) ? json : {};
  const failure = isObj(root.error) ? root.error : undefined;
  const body = failure && isObj(failure.details) ? failure.details : root;
  const plugin = isObj(body.plugin) ? body.plugin : undefined;
  const caps = isObj(plugin?.capabilities) ? (plugin!.capabilities as Obj) : isObj(body.capabilities) ? (body.capabilities as Obj) : {};
  const diagnostics: string[] = [];
  for (const d of Array.isArray(body.diagnostics) ? body.diagnostics : []) if (isObj(d) && str(d.message)) diagnostics.push(`${str(d.severity) ?? "note"}: ${str(d.message)}`);
  if (failure && diagnostics.length === 0 && str(failure.message)) diagnostics.push(`error: ${str(failure.message)}`);
  return {
    valid: !failure && body.valid === true,
    id: str(plugin?.id),
    version: str(plugin?.version),
    description: str(plugin?.description),
    skills: count(caps.skills),
    hooks: count(caps.hooks),
    mcpServers: count(caps.mcp_servers),
    commands: count(caps.commands),
    reminders: count(caps.reminders),
    diagnostics,
  };
}

export interface AvailablePlugin {
  name: string;
  marketplace: string;
  version?: string;
  /** Where the plugin comes from, as the marketplace states it (a path or a URL). */
  source?: string;
  status?: string;
}

export function mapAvailable(json: unknown): AvailablePlugin[] {
  const rows = isObj(json) && Array.isArray(json.available) ? json.available : [];
  const out: AvailablePlugin[] = [];
  for (const r of rows) {
    if (!isObj(r) || !str(r.name) || !str(r.marketplace)) continue;
    out.push({ name: str(r.name)!, marketplace: str(r.marketplace)!, version: str(r.version), source: isObj(r.install) ? str(r.install.source) : undefined, status: str(r.status) });
  }
  return out;
}

function runJson(binary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env: env ?? process.env, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // `validate` exits non-zero for an invalid bundle but still prints its JSON: read stdout first.
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(error ? `${error.message}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}` : "Muse printed something that is not JSON."));
      }
    });
  });
}

export async function validatePlugin(binary: string, path: string, env?: NodeJS.ProcessEnv): Promise<PluginPreview> {
  return mapValidate(await runJson(binary, ["plugins", "validate", path, "--json"], env));
}

export async function listAvailablePlugins(binary: string, env?: NodeJS.ProcessEnv): Promise<AvailablePlugin[]> {
  return mapAvailable(await runJson(binary, ["plugins", "list", "--available", "--json"], env));
}

/** The lines of a dialog that say what a bundle brings, with the code-running parts called out. */
export function describeCapabilities(p: PluginPreview): string {
  const parts = [
    p.skills ? `${p.skills} skill${p.skills === 1 ? "" : "s"}` : "",
    p.commands ? `${p.commands} command${p.commands === 1 ? "" : "s"}` : "",
    p.reminders ? `${p.reminders} reminder${p.reminders === 1 ? "" : "s"}` : "",
    p.hooks ? `${p.hooks} HOOK${p.hooks === 1 ? "" : "S"} (code that runs on this computer)` : "",
    p.mcpServers ? `${p.mcpServers} MCP SERVER${p.mcpServers === 1 ? "" : "S"} (programs that run on this computer)` : "",
  ].filter(Boolean);
  return parts.length ? `Brings: ${parts.join(", ")}.` : "Brings nothing Muse recognizes.";
}
