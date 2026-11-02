import { execFile } from "node:child_process";

/**
 * Skill management through Muse's own CLI (`muse skills ... --json`). MSP's `skill/list` rows carry no activation state;
 * the CLI's do (`on`, `user-invocable-only`, `off`), together with scope, path, diagnostics and the startup context cost.
 * Only official subcommands are used, always with `--json`, never through a shell, and every write is read back.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** MSP's spelling of the three activation states, plus `unknown` for anything else (never guessed). */
export type Activation = "on" | "userInvocableOnly" | "off" | "unknown";

export interface ManagedSkill {
  id: string;
  /** The name the skill is invoked by (`/name`); usually the id. */
  name: string;
  displayName: string;
  description: string;
  /** `user`, `project`, `built-in` or `plugin` (as the CLI spells them). */
  scope: string;
  /** Where it comes from, as one phrase ("local", "plugin p@m"). */
  origin: string;
  path?: string;
  activation: Activation;
  diagnostics: string[];
  /** Estimated tokens the skill costs at the start of every conversation. */
  startupTokens?: number;
}

export interface CliOptions {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: arguments placed before the subcommand. */
  binaryArgs?: string[];
}

function activationOf(value: unknown): Activation {
  switch (value) {
    case "on":
      return "on";
    case "off":
      return "off";
    case "user-invocable-only":
    case "userInvocableOnly":
      return "userInvocableOnly";
    default:
      return "unknown";
  }
}

function originOf(source: unknown): string {
  if (!isObj(source)) return "unknown";
  const type = str(source.type) ?? "unknown";
  const plugin = str(source.plugin_id) ?? str(source.plugin);
  return plugin ? `${type} ${plugin}` : type;
}

function diagnosticsOf(value: unknown): string[] {
  const out: string[] = [];
  for (const d of Array.isArray(value) ? value : []) {
    if (typeof d === "string") out.push(d);
    else if (isObj(d) && str(d.message)) out.push(`${str(d.severity) ?? "note"}: ${str(d.message)}`);
  }
  return out;
}

/** Reads the JSON of `muse skills list --json`. Rows without an id are dropped. */
export function mapSkillList(json: unknown): ManagedSkill[] {
  const rows = isObj(json) && Array.isArray(json.skills) ? json.skills : [];
  const out: ManagedSkill[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const id = str(r.id);
    if (!id) continue;
    const cost = isObj(r.context_cost) ? r.context_cost : undefined;
    out.push({
      id,
      name: str(r.name) ?? id,
      displayName: str(r.display_name) ?? str(r.name) ?? id,
      description: str(r.description) ?? "",
      scope: str(r.scope) ?? "unknown",
      origin: originOf(r.source),
      path: str(r.path),
      activation: activationOf(r.activation),
      diagnostics: diagnosticsOf(r.diagnostics),
      startupTokens: typeof cost?.startup_estimated_tokens === "number" ? cost.startup_estimated_tokens : undefined,
    });
  }
  return out;
}

/** Names offered by more than one skill: the user sees which one `/name` reaches, so the others are worth knowing about. */
export function findConflicts(skills: ManagedSkill[]): Map<string, ManagedSkill[]> {
  const byName = new Map<string, ManagedSkill[]>();
  for (const s of skills) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  return new Map([...byName].filter(([, rows]) => rows.length > 1));
}

function run(options: CliOptions, args: string[]): Promise<{ json: unknown; stderr: string; failed: boolean }> {
  return new Promise((resolve, reject) => {
    execFile(options.binary, [...(options.binaryArgs ?? []), ...args], { cwd: options.cwd, env: options.env ?? process.env, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A refusal can still print its JSON (`validate` does): read stdout first.
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      if (json === undefined && error) reject(new Error(stderr.trim().split("\n")[0]?.slice(0, 300) || error.message));
      else if (json === undefined) reject(new Error("Muse printed something that is not JSON."));
      else resolve({ json, stderr, failed: error !== null });
    });
  });
}

/** Lists every skill Muse knows for this folder. The workspace is passed but NOT trusted: project skills load only once it is trusted. */
export async function listManagedSkills(options: CliOptions): Promise<ManagedSkill[]> {
  const { json } = await run(options, ["skills", "list", "--json", "--workspace", options.cwd]);
  return mapSkillList(json);
}

const VERB: Record<Exclude<Activation, "unknown">, string> = { on: "enable", userInvocableOnly: "user-only", off: "disable" };

/** Sets one skill's activation in one scope, then reads the list back: success is claimed only if the list agrees. */
export async function setSkillActivation(options: CliOptions, change: { id: string; scope: string; activation: Exclude<Activation, "unknown"> }): Promise<Activation> {
  // The list calls the built-in scope "bundled"; the verbs spell it "built-in".
  const cliScope = change.scope === "bundled" ? "built-in" : change.scope;
  const { json, failed } = await run(options, ["skills", VERB[change.activation], change.id, "--scope", cliScope, "--workspace", options.cwd, "--json"]);
  if (failed || (isObj(json) && isObj(json.error))) throw new Error(isObj(json) && isObj(json.error) ? (str(json.error.message) ?? "Muse refused the change.") : "Muse refused the change.");
  const now = (await listManagedSkills(options)).find((s) => s.id === change.id && s.scope === change.scope);
  if (!now) throw new Error(`Muse accepted the change, but ${change.id} is no longer listed in the ${change.scope} scope.`);
  if (now.activation !== change.activation) throw new Error(`Muse accepted the change, but ${change.id} is still ${now.activation}.`);
  return now.activation;
}

export interface SkillPreview {
  valid: boolean;
  id?: string;
  /** Tools the skill asks to be allowed to use, when it says. */
  allowedTools: string[];
  diagnostics: string[];
}

/** Checks a skill folder without installing or running anything (`muse skills validate`). */
export async function validateSkill(options: CliOptions, path: string): Promise<SkillPreview> {
  const { json } = await run(options, ["skills", "validate", path, "--json"]);
  const root = isObj(json) ? json : {};
  const failure = isObj(root.error) ? root.error : undefined;
  const compat = isObj(root.compatibility) ? root.compatibility : {};
  const diagnostics = diagnosticsOf(root.diagnostics);
  if (failure && str(failure.message)) diagnostics.unshift(`error: ${str(failure.message)}`);
  return {
    valid: !failure && root.valid === true,
    id: str(root.id),
    allowedTools: Array.isArray(compat.allowed_tools) ? compat.allowed_tools.filter((t): t is string => typeof t === "string") : [],
    diagnostics,
  };
}

/** Installs a validated folder into the user scope. An existing id is refused unless `force` says to replace it. */
export async function installSkill(options: CliOptions, path: string, opts: { force: boolean }): Promise<{ id: string }> {
  const { json, failed } = await run(options, ["skills", "install", path, "--scope", "user", ...(opts.force ? ["--force"] : []), "--json"]);
  const installed = isObj(json) && isObj(json.installed) ? json.installed : undefined;
  if (failed || !str(installed?.id)) throw new Error(isObj(json) && isObj(json.error) ? (str(json.error.message) ?? "Muse refused the install.") : "Muse refused the install.");
  return { id: str(installed?.id)! };
}

/** Removes a skill that was installed with `muse skills install` (it does not touch skills found in other folders). */
export async function uninstallSkill(options: CliOptions, id: string): Promise<void> {
  const { json, failed } = await run(options, ["skills", "uninstall", id, "--json"]);
  if (failed || !isObj(json) || !isObj(json.uninstalled)) throw new Error(isObj(json) && isObj(json.error) ? (str(json.error.message) ?? "Muse refused the removal.") : "Muse refused the removal.");
}
