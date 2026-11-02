import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * MCP servers in Muse's own `settings.json`. MSP has no method to read or write them (`mcpServer/list` only shows servers
 * a session supplies, and was empty for servers defined here), so the only way to manage them is the file itself, which
 * the official clients also edit. Measured on muse 1.4.14: both `mcpServers` and `mcp_servers` are read (Muse started a
 * test server from either, over `muse exec` and over `muse serve`); entries are `{transport: "stdio" | "streamable_http",
 * command/args/env/framing | url/headers, mode: "required" | "optional", enabled}`.
 *
 * Rules kept here: a secret (an env value, a header value) is never returned by the reader; an edit changes only the
 * server it names and keeps every other setting, key order and unknown field; a save is atomic, backs up what it
 * replaces, and refuses when the file changed since it was read.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export type McpTransport = "stdio" | "streamable_http" | "unknown";

export interface McpEntry {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  /** `required`: a server that fails to start aborts the run. `optional`: it is skipped with a warning. */
  mode: "required" | "optional";
  enabled: boolean;
  /** Names only. The values are secrets and stay in the file. */
  envKeys: string[];
  headerKeys: string[];
  framing?: string;
  problems: string[];
}

export interface McpConfig {
  path: string;
  exists: boolean;
  /** Which spelling the file uses. */
  key: "mcpServers" | "mcp_servers" | "both" | "none";
  entries: McpEntry[];
  warnings: string[];
  /** sha256 of the file's text, to detect that another program changed it. */
  fingerprint: string;
  parseError?: string;
}

/** Where Muse keeps its user settings: `$XDG_CONFIG_HOME/muse/settings.json`, else `~/.config/muse/settings.json`. */
export function museConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "muse", "settings.json");
}

const fingerprintOf = (text: string | undefined): string => createHash("sha256").update(text ?? "\u0000absent").digest("hex");
const NAME = /^[A-Za-z0-9_.-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readEntry(name: string, raw: unknown): McpEntry {
  const e = isObj(raw) ? raw : {};
  const problems: string[] = [];
  const transport: McpTransport = e.transport === "stdio" || e.transport === "streamable_http" ? e.transport : "unknown";
  if (transport === "unknown") problems.push(`transport must be "stdio" or "streamable_http"${str(e.transport) ? ` (found "${str(e.transport)}")` : ""}`);
  const command = str(e.command);
  const url = str(e.url);
  if (transport === "stdio" && !command) problems.push("a stdio server needs a command");
  if (transport === "streamable_http") {
    if (!url) problems.push("an HTTP server needs a url");
    else if (!/^https?:\/\//i.test(url)) problems.push("the url must be http(s)");
    if (str(e.framing)) problems.push("framing applies to stdio servers only");
  }
  const mode = e.mode === "required" || e.mode === undefined ? "required" : e.mode === "optional" ? "optional" : undefined;
  if (!mode) problems.push(`mode must be "required" or "optional" (found "${String(e.mode)}")`);
  return {
    name,
    transport,
    command,
    args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [],
    url,
    mode: mode ?? "required",
    enabled: e.enabled !== false,
    envKeys: isObj(e.env) ? Object.keys(e.env) : [],
    headerKeys: isObj(e.headers) ? Object.keys(e.headers) : [],
    framing: str(e.framing),
    problems,
  };
}

/** Reads the MCP part of a settings file's text. Never throws and never returns a secret value. */
export function parseMcpConfig(text: string | undefined, path: string): McpConfig {
  const base = { path, warnings: [] as string[], fingerprint: fingerprintOf(text) };
  if (text === undefined) return { ...base, exists: false, key: "none", entries: [] };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return { ...base, exists: true, key: "none", entries: [], parseError: `The settings file is not valid JSON (${error instanceof Error ? error.message : String(error)}).` };
  }
  if (!isObj(root)) return { ...base, exists: true, key: "none", entries: [], parseError: "The settings file is not a JSON object." };
  const camel = isObj(root.mcpServers) ? root.mcpServers : undefined;
  const snake = isObj(root.mcp_servers) ? root.mcp_servers : undefined;
  const key = camel && snake ? "both" : camel ? "mcpServers" : snake ? "mcp_servers" : "none";
  const warnings: string[] = [];
  const entries: McpEntry[] = [];
  if (camel && snake) {
    const clash = Object.keys(camel).filter((n) => n in snake);
    warnings.push(`The file has both "mcpServers" and "mcp_servers"${clash.length ? `; these names are in both: ${clash.join(", ")}` : ""}. Muse reads both, so keep one.`);
  }
  for (const group of [camel, snake]) for (const [name, raw] of Object.entries(group ?? {})) entries.push(readEntry(name, raw));
  return { ...base, exists: true, key, entries, warnings };
}

export type McpServerInput =
  | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; framing?: string; mode?: "required" | "optional"; enabled?: boolean }
  | { name: string; transport: "streamable_http"; url: string; headers?: Record<string, string>; mode?: "required" | "optional"; enabled?: boolean };

/** What would make Muse refuse this server, in words for the user. Empty means acceptable. */
export function validateInput(input: McpServerInput): string[] {
  const problems: string[] = [];
  if (!NAME.test(input.name)) problems.push("The name may use letters, digits, dot, dash and underscore only (and cannot be empty).");
  if (input.transport === "stdio") {
    if (!input.command || input.command.trim() === "") problems.push("A stdio server needs a command.");
    for (const key of Object.keys(input.env ?? {})) if (!ENV_NAME.test(key)) problems.push(`"${key}" is not a valid environment variable name.`);
  } else if (input.transport === "streamable_http") {
    if (!/^https?:\/\/\S+$/i.test(input.url ?? "")) problems.push("The url must be http(s).");
    for (const key of Object.keys(input.headers ?? {})) if (!/^[A-Za-z0-9-]+$/.test(key)) problems.push(`"${key}" is not a valid header name.`);
  } else {
    problems.push("The transport must be stdio or streamable_http.");
  }
  return problems;
}

export type McpEdit = { op: "upsert"; input: McpServerInput } | { op: "remove"; name: string } | { op: "setEnabled"; name: string; enabled: boolean };

function parseRoot(text: string | undefined): Obj {
  if (text === undefined) return { schema_version: 1 };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new Error(`The settings file is not valid JSON (${error instanceof Error ? error.message : String(error)}), so Antares will not edit it.`);
  }
  if (!isObj(root)) throw new Error("The settings file is not a JSON object, so Antares will not edit it.");
  return root;
}

/**
 * The file's text after one edit. Everything the edit does not name is kept: other settings, their order, other servers,
 * and the unknown fields and secrets of the server being edited (unless the edit supplies new `env` or `headers`).
 */
export function applyEdit(text: string | undefined, edit: McpEdit): string {
  const root = parseRoot(text);
  const hasCamel = isObj(root.mcpServers);
  const hasSnake = isObj(root.mcp_servers);
  const keyOf = (name: string): "mcpServers" | "mcp_servers" | undefined => (hasCamel && name in (root.mcpServers as Obj) ? "mcpServers" : hasSnake && name in (root.mcp_servers as Obj) ? "mcp_servers" : undefined);
  if (edit.op === "upsert") {
    const { input } = edit;
    const key = keyOf(input.name) ?? (hasCamel ? "mcpServers" : hasSnake ? "mcp_servers" : "mcpServers");
    const group = isObj(root[key]) ? (root[key] as Obj) : {};
    const previous = isObj(group[input.name]) ? (group[input.name] as Obj) : {};
    const entry: Obj = { ...previous, transport: input.transport };
    if (input.transport === "stdio") {
      entry.command = input.command;
      if (input.args) entry.args = input.args;
      if (input.env) entry.env = input.env;
      if (input.framing) entry.framing = input.framing;
      delete entry.url;
      delete entry.headers;
    } else {
      entry.url = input.url;
      if (input.headers) entry.headers = input.headers;
      delete entry.command;
      delete entry.args;
      delete entry.env;
      delete entry.framing;
    }
    if (input.mode) entry.mode = input.mode;
    if (input.enabled !== undefined) entry.enabled = input.enabled;
    root[key] = { ...group, [input.name]: entry };
  } else {
    const key = keyOf(edit.name);
    if (!key) throw new Error(`There is no server named "${edit.name}" in the settings file.`);
    const group = { ...(root[key] as Obj) };
    if (edit.op === "remove") delete group[edit.name];
    else group[edit.name] = { ...(group[edit.name] as Obj), enabled: edit.enabled };
    root[key] = group;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/**
 * Saves a settings file: the text must be valid JSON; the file must be unchanged since `expectedFingerprint` was taken;
 * the previous content is kept in `settings.json.antares-bak-<time>`; the new content is written to a temporary file in
 * the same folder and renamed over the original, so a reader never sees half a file.
 */
export async function saveConfig(path: string, text: string, expectedFingerprint: string): Promise<{ backup?: string }> {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`Refusing to save: the new settings are not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  let current: string | undefined;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (fingerprintOf(current) !== expectedFingerprint) throw new Error("The settings file changed since Antares read it (another program edited it). Reload the list and try again.");
  await mkdir(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (current !== undefined) {
    backup = `${path}.antares-bak-${stamp()}`;
    await writeFile(backup, current, { mode: 0o600 });
  }
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { backup };
}

/**
 * A throwaway settings file holding only the one server, set to `required` (so a failure to start aborts the run and shows),
 * with every env and header value replaced by a `${VAR}` reference whose value travels in the process environment. Values that
 * already are references are left alone. The secret never touches the disk.
 */
export function buildProbeConfig(name: string, raw: Obj): { settings: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  let n = 0;
  const lift = (group: unknown): Obj | undefined => {
    if (!isObj(group)) return undefined;
    const out: Obj = {};
    for (const [k, v] of Object.entries(group)) {
      if (typeof v !== "string" || /^\$\{[A-Za-z0-9_]+\}$/.test(v)) {
        out[k] = v;
        continue;
      }
      const ref = `ANTARES_PROBE_${n++}`;
      env[ref] = v;
      out[k] = `\${${ref}}`;
    }
    return out;
  };
  const entry: Obj = { ...raw, mode: "required", enabled: true };
  if (raw.env !== undefined) entry.env = lift(raw.env);
  if (raw.headers !== undefined) entry.headers = lift(raw.headers);
  return { settings: JSON.stringify({ schema_version: 1, mcpServers: { [name]: entry } }), env };
}

/** Splits a typed argument string the way a shell would for simple cases: spaces separate, quotes group. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current !== "") out.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (has || current !== "") out.push(current);
  return out;
}

export interface HostMcpRow {
  name: string;
  source: string;
  transport: string;
  oauth: string;
}

export interface ConnectorRow {
  name: string;
  /** `settings` (editable here), `plugin` or `session` (reported by the host). */
  source: string;
  transport: string;
  /** loggedIn, loggedOut, notSupported, or unknown (the host did not report this server). */
  oauth: string;
  mode?: "required" | "optional";
  enabled: boolean;
  problems: string[];
  /** Where it points, without anything that could be a secret: the command, or an HTTP origin. */
  target?: string;
  envKeys: string[];
  headerKeys: string[];
  editable: boolean;
}

function targetOf(e: McpEntry): string | undefined {
  if (e.transport === "streamable_http" && e.url) {
    try {
      return new URL(e.url).origin;
    } catch {
      return undefined;
    }
  }
  if (e.command) return e.args.length ? `${e.command} (${e.args.length} argument${e.args.length === 1 ? "" : "s"})` : e.command;
  return undefined;
}

/**
 * The connectors list. The host's `mcpServer/list` does not show servers defined in settings.json, so the file is the
 * source for those; the host's rows supply the OAuth state when it has one and add what comes from plugins and sessions.
 */
export function connectorRows(config: McpConfig, hostRows: HostMcpRow[]): ConnectorRow[] {
  const byName = new Map(hostRows.map((r) => [r.name, r]));
  const rows: ConnectorRow[] = config.entries.map((e) => {
    const host = byName.get(e.name);
    return {
      name: e.name,
      source: "settings",
      transport: e.transport,
      oauth: host ? host.oauth : e.transport === "streamable_http" ? "unknown" : "notSupported",
      mode: e.mode,
      enabled: e.enabled,
      problems: e.problems,
      target: targetOf(e),
      envKeys: e.envKeys,
      headerKeys: e.headerKeys,
      editable: true,
    };
  });
  const have = new Set(config.entries.map((e) => e.name));
  for (const h of hostRows) if (!have.has(h.name)) rows.push({ name: h.name, source: h.source, transport: h.transport, oauth: h.oauth, enabled: true, problems: [], envKeys: [], headerKeys: [], editable: false });
  return rows;
}

/** The stored entry for a server, exactly as in the file (secrets included: for Antares' own use, never for the page). */
export function rawEntry(text: string | undefined, name: string): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(root)) return undefined;
  for (const key of ["mcpServers", "mcp_servers"]) {
    const group = root[key];
    if (isObj(group) && isObj(group[name])) return group[name] as Record<string, unknown>;
  }
  return undefined;
}
