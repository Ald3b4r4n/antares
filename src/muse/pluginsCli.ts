import { execFile } from "node:child_process";
import type { CliOptions } from "./skillsCli.ts";

/**
 * Plugin management through Muse's own CLI (`muse plugins ... --json`). MSP can install and list plugins and manage
 * marketplaces; only the CLI also inspects a plugin's capabilities, approves or rejects the parts that run code (hooks, MCP
 * servers), enables, disables, updates and removes. Official subcommands only, always `--json`, never through a shell.
 * Every write is read back, and nothing is approved except by an explicit decision from the user.
 *
 * Trust model as Muse states it: a plugin's skills are active while the plugin is enabled; its hooks and MCP servers need a
 * review first (`review_needed`), and a changed definition needs a new one.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type CapabilityKind = "hook" | "mcp_server" | "reminder" | "agent_definition" | "invocation_preapproval" | "unknown";
export type CapabilityStatus = "review_needed" | "trusted_enabled" | "trusted_disabled" | "unknown";

export interface RuntimeCapability {
  kind: CapabilityKind;
  capabilityId: string;
  stableId: string;
  status: CapabilityStatus;
  /** What it would run or reach, without anything that could be a secret: a hook's event and command, an MCP command or origin. */
  detail: string;
  definitionHash?: string;
}

export interface ManagedPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** Whether Muse currently loads it (enabled and valid). */
  active: boolean;
  trust: string;
  provenance: string;
  skills: string[];
  commands: number;
  /** Hooks, MCP servers and the like: code that runs on this computer, with the review state of each. */
  runtime: RuntimeCapability[];
  /** How many of those still wait for the user's review. */
  needsReview: number;
  warning?: string;
}

const KINDS: CapabilityKind[] = ["hook", "mcp_server", "reminder", "agent_definition", "invocation_preapproval"];
const kindOf = (v: unknown): CapabilityKind => (KINDS.includes(v as CapabilityKind) ? (v as CapabilityKind) : "unknown");
const STATUSES: CapabilityStatus[] = ["review_needed", "trusted_enabled", "trusted_disabled"];
const statusOf = (v: unknown): CapabilityStatus => (STATUSES.includes(v as CapabilityStatus) ? (v as CapabilityStatus) : "unknown");

function originOf(url: unknown): string | undefined {
  const s = str(url);
  if (!s) return undefined;
  try {
    return new URL(s).origin;
  } catch {
    return undefined;
  }
}

/** Reads the JSON of `muse plugins inspect <id> --json` (also the shape of each row of `list`, which lacks `runtime_capabilities`). */
export function mapInspect(json: unknown): ManagedPlugin {
  const root = isObj(json) ? json : {};
  const record = isObj(root.record) ? root.record : {};
  const caps = isObj(root.plugin) && isObj(root.plugin.capabilities) ? root.plugin.capabilities : {};
  const hooks = new Map<string, Obj>(arr(caps.hooks).filter(isObj).map((h) => [str(h.id) ?? "", h]));
  const servers = new Map<string, Obj>(arr(caps.mcp_servers).filter(isObj).map((m) => [str(m.id) ?? "", m]));
  const runtime: RuntimeCapability[] = [];
  for (const r of arr(root.runtime_capabilities)) {
    if (!isObj(r) || !isObj(r.candidate)) continue;
    const c = r.candidate;
    const capabilityId = str(c.capability_id) ?? "";
    const kind = kindOf(c.kind);
    let detail = "";
    if (kind === "hook") {
      const h = hooks.get(capabilityId);
      detail = h ? `${str(h.event) ?? "hook"}: ${str(h.shell_command) ?? arr(h.command).join(" ")}` : "";
    } else if (kind === "mcp_server") {
      const m = servers.get(capabilityId);
      detail = m ? (originOf(m.url) ?? arr(m.command).filter((p): p is string => typeof p === "string").join(" ")) : "";
    }
    runtime.push({ kind, capabilityId, stableId: str(c.stable_id) ?? "", status: statusOf(r.status), detail, definitionHash: str(c.definition_hash) });
  }
  const id = str(record.id) ?? "unknown";
  return {
    id,
    name: str(record.display_name) ?? id,
    version: str(record.version) ?? "",
    description: str(record.description) ?? "",
    enabled: record.enabled === true,
    active: root.active === true,
    trust: str(record.trust) ?? "unknown",
    provenance: isObj(record.source) ? (str(record.source.provenance) ?? "unknown") : "unknown",
    skills: arr(caps.skills).filter(isObj).map((s) => str(s.id) ?? "").filter(Boolean),
    commands: arr(caps.commands).length,
    runtime,
    needsReview: runtime.filter((r) => r.status === "review_needed").length,
    warning: str(root.warning),
  };
}

function run(options: CliOptions, args: string[]): Promise<{ json: unknown; failed: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    execFile(options.binary, [...(options.binaryArgs ?? []), ...args], { cwd: options.cwd, env: options.env ?? process.env, timeout: 90_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      const message = stderr.trim().split("\n")[0]?.slice(0, 300);
      if (json === undefined && error) reject(new Error(message || error.message));
      else if (json === undefined) reject(new Error("Muse printed something that is not JSON."));
      else resolve({ json, failed: error !== null, message });
    });
  });
}

/** Every installed plugin, each inspected so the review state of its hooks and MCP servers is known. Decides nothing. */
export async function listManagedPlugins(options: CliOptions): Promise<ManagedPlugin[]> {
  const { json } = await run(options, ["plugins", "list", "--json"]);
  const ids = arr(isObj(json) ? json.plugins : []).filter(isObj).map((p) => str(isObj(p.record) ? p.record.id : undefined)).filter((id): id is string => id !== undefined);
  const out: ManagedPlugin[] = [];
  for (const id of ids) out.push(await inspectPlugin(options, id));
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function inspectPlugin(options: CliOptions, id: string): Promise<ManagedPlugin> {
  const { json, failed, message } = await run(options, ["plugins", "inspect", id, "--json"]);
  if (failed) throw new Error(message || `Muse could not inspect ${id}.`);
  return mapInspect(json);
}

async function expectPlugin(options: CliOptions, id: string): Promise<ManagedPlugin | undefined> {
  return (await listManagedPlugins(options)).find((p) => p.id === id);
}

/** Approves or rejects ONE named code-running part of a plugin. Approve trusts and enables its current definition; reject trusts and disables it. */
export async function decideCapability(options: CliOptions, d: { pluginId: string; kind: Exclude<CapabilityKind, "unknown">; capabilityId: string; decision: "approve" | "reject" }): Promise<CapabilityStatus> {
  const { failed, message } = await run(options, ["plugins", d.decision, `${d.pluginId}:${d.kind}:${d.capabilityId}`, "--json"]);
  if (failed) throw new Error(message || `Muse refused to ${d.decision} it.`);
  const plugin = await inspectPlugin(options, d.pluginId);
  const part = plugin.runtime.find((r) => r.kind === d.kind && r.capabilityId === d.capabilityId);
  const wanted: CapabilityStatus = d.decision === "approve" ? "trusted_enabled" : "trusted_disabled";
  if (!part) throw new Error(`Muse accepted the decision, but ${d.capabilityId} is no longer listed for ${d.pluginId}.`);
  if (part.status !== wanted) throw new Error(`Muse accepted the decision, but ${d.capabilityId} is still ${part.status}.`);
  return part.status;
}

export async function setPluginEnabled(options: CliOptions, id: string, enabled: boolean): Promise<void> {
  const { failed, message } = await run(options, ["plugins", enabled ? "enable" : "disable", id, "--json"]);
  if (failed) throw new Error(message || `Muse refused to ${enabled ? "enable" : "disable"} ${id}.`);
  const now = await expectPlugin(options, id);
  if (!now) throw new Error(`Muse accepted the change, but ${id} is no longer listed.`);
  if (now.enabled !== enabled) throw new Error(`Muse accepted the change, but ${id} is still ${now.enabled ? "enabled" : "disabled"}.`);
}

/** Refreshes an installed local plugin from its source. A changed definition of a hook or MCP server needs a new review. */
export async function updatePlugin(options: CliOptions, id: string): Promise<{ updated: boolean }> {
  const { json, failed, message } = await run(options, ["plugins", "update", id, "--json"]);
  if (failed || !isObj(json) || !isObj(json.updated)) throw new Error(message || (isObj(json) && isObj(json.error) ? (str(json.error.message) ?? "Muse refused the update.") : "Muse refused the update."));
  return { updated: true };
}

export async function removePlugin(options: CliOptions, id: string, opts: { deleteData: boolean }): Promise<void> {
  const { failed, message } = await run(options, ["plugins", "remove", id, ...(opts.deleteData ? ["--delete-data"] : []), "--json"]);
  if (failed) throw new Error(message || `Muse refused to remove ${id}.`);
  if (await expectPlugin(options, id)) throw new Error(`Muse accepted the removal, but ${id} is still installed.`);
}

export interface MarketplaceRow {
  name: string;
  kind: string;
  /** A folder path or a Git URL, as configured. */
  source: string;
  pluginCount: number;
}

export async function listMarketplaces(options: CliOptions): Promise<MarketplaceRow[]> {
  const { json } = await run(options, ["plugins", "marketplace", "list", "--json"]);
  const rows: MarketplaceRow[] = [];
  for (const m of arr(isObj(json) ? json.marketplaces : [])) {
    if (!isObj(m) || !str(m.name)) continue;
    const source = isObj(m.source) ? m.source : {};
    rows.push({ name: str(m.name)!, kind: str(source.kind) ?? "unknown", source: str(source.path) ?? str(source.url) ?? "", pluginCount: typeof m.plugin_count === "number" ? m.plugin_count : 0 });
  }
  return rows;
}

/** Refreshes a marketplace's snapshot (the CLI does it only when asked; nothing is installed). */
export async function updateMarketplace(options: CliOptions, name: string): Promise<void> {
  const { failed, message } = await run(options, ["plugins", "marketplace", "update", name, "--json"]);
  if (failed) throw new Error(message || `Muse could not refresh ${name}.`);
}

export async function removeMarketplace(options: CliOptions, name: string): Promise<void> {
  const { failed, message } = await run(options, ["plugins", "marketplace", "remove", name, "--json"]);
  if (failed) throw new Error(message || `Muse refused to remove ${name}.`);
  if ((await listMarketplaces(options)).some((m) => m.name === name)) throw new Error(`Muse accepted the removal, but ${name} is still configured.`);
}

/**
 * Adds a marketplace to Muse (`muse plugins marketplace add`): a local folder or an HTTPS Git URL. Muse reads the catalog and says how
 * many plugins it can use and how many it had to skip. Success is claimed only when the marketplace is then listed.
 */
export async function addMarketplace(options: CliOptions, name: string, source: string): Promise<{ name: string; pluginCount: number; skipped: number }> {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("The marketplace name may use letters, digits, dot, dash and underscore only.");
  const isUrl = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+$/.test(source) && !source.includes("..");
  const isFolder = /^(?:[A-Za-z]:[\/]|\/|\\)/.test(source) && !source.startsWith("ext::");
  if (!isUrl && !isFolder) throw new Error("The source must be an https:// Git URL or a folder on this computer.");
  const { json, failed, message } = await run(options, ["plugins", "marketplace", "add", name, source, "--json"]);
  if (failed || !isObj(json) || !isObj(json.marketplace)) throw new Error(message || (isObj(json) && isObj(json.error) ? (str(json.error.message) ?? "Muse refused the marketplace.") : "Muse refused the marketplace."));
  if (!(await listMarketplaces(options)).some((m) => m.name === name)) throw new Error(`Muse accepted the marketplace, but ${name} is not listed.`);
  const m = json.marketplace;
  return { name, pluginCount: typeof m.plugin_count === "number" ? m.plugin_count : 0, skipped: arr(m.skipped).length };
}
