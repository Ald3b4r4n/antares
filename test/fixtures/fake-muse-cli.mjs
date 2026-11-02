// A stand-in for `muse skills ...` (the CLI, not the MSP host). State lives in the JSON file named by FAKE_SKILLS_STATE
// so a test can see what the CLI was asked to do. Shapes are the ones printed by muse 1.4.14 with --json. Test fixture only.
//   FAKE_SKILLS_MODE=ignore  accepts enable/disable/user-only but changes nothing (the CLI "succeeds" and lies)
//   FAKE_SKILLS_MODE=fail    exits 1 with a message on stderr for every write
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_SKILLS_STATE;
const mode = process.env.FAKE_SKILLS_MODE ?? "normal";
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(`${statePath}.log`, `${JSON.stringify(entry)}\n`);
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : []);
const save = (rows) => writeFileSync(statePath, JSON.stringify(rows));
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const row = (r) => ({
  id: r.id,
  name: r.name ?? r.id,
  display_name: r.id,
  description: r.description ?? `The ${r.id} skill.`,
  short_description: null,
  scope: r.scope ?? "user",
  source: { type: "local" },
  path: `$HOME/.agents/skills/${r.id}/SKILL.md`,
  activation: r.activation ?? "on",
  diagnostics: r.diagnostics ?? [],
  provenance: null,
  context_cost: { startup_bytes: 100, startup_estimated_tokens: 25, invoke_bytes: null, invoke_estimated_tokens: null },
});


// ---- plugins: state file FAKE_PLUGINS_STATE = { plugins: [...], marketplaces: [...] } (shapes of muse 1.4.14 --json) ----
//   FAKE_PLUGINS_MODE=ignore  accepts approve/reject/enable/disable/remove but changes nothing
if (args[0] === "plugins") {
  const file = process.env.FAKE_PLUGINS_STATE;
  const pmode = process.env.FAKE_PLUGINS_MODE ?? "normal";
  const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { plugins: [], marketplaces: [] };
  const saveState = () => writeFileSync(file, JSON.stringify(state));
  appendFileSync(file + ".log", JSON.stringify({ sub: args[1], args }) + "\n");
  const record = (p) => ({ id: p.id, display_name: p.display_name ?? null, version: p.version ?? "0.0.1", description: p.description ?? "", manifest_family: "claude-compatible", enabled: p.enabled !== false, trust: p.trust ?? "user-local", source: { provenance: p.provenance ?? "foreign-import", path: p.path ?? "C:\\src\\" + p.id }, installed_at: "2026-11-02T00:00:00Z", updated_at: p.updated_at ?? null });
  const caps = (p) => ({
    skills: (p.skills ?? []).map((id) => ({ id, path: "skills/" + id + "/SKILL.md" })),
    hooks: (p.hooks ?? []).map((h) => ({ id: h.id, event: h.event, matcher: null, command: [h.command], shell_command: h.command, timeout_ms: null, async: false })),
    mcp_servers: (p.mcp ?? []).map((m) => ({ id: m.id, transport: m.transport ?? "stdio", command: m.command ?? [], url: m.url ?? null })),
    commands: [],
    reminders: [],
    session_providers: [],
  });
  const runtime = (p) => [
    ...(p.hooks ?? []).map((h) => ({ candidate: { kind: "hook", plugin_id: p.id, capability_id: h.id, stable_id: "plugin:" + p.id + ":hook:" + h.id, definition_hash: "sha256:" + h.id }, status: (p.status ?? {})[h.id] ?? "review_needed", diagnostic: null })),
    ...(p.mcp ?? []).map((m) => ({ candidate: { kind: "mcp_server", plugin_id: p.id, capability_id: m.id, stable_id: "plugin:" + p.id + ":mcp_server:" + m.id, definition_hash: "sha256:" + m.id }, status: (p.status ?? {})[m.id] ?? "review_needed", diagnostic: null })),
  ];
  const full = (p) => ({ record: record(p), warning: "third-party plugin: hooks and MCP servers require review before activation; skills are active without review while the plugin is enabled", plugin: { id: p.id, version: p.version ?? "0.0.1", capabilities: caps(p) }, valid: true, active: p.enabled !== false, active_scope: "installed-plugin", diagnostics: [] });
  const find = (id) => state.plugins.find((p) => p.id === id) ?? fail("plugin not installed: " + id);
  const sub = args[1];
  if (sub === "list") out({ plugins: state.plugins.map(full) });
  else if (sub === "inspect") {
    const p = find(args[2]);
    out({ ...full(p), effective_capabilities_scope: "plugin-capability-snapshot", effective_capabilities: (p.skills ?? []).map((id) => ({ kind: "skill", stable_id: "plugin:" + p.id + ":" + id })), runtime_capabilities: runtime(p) });
  } else if (sub === "approve" || sub === "reject") {
    const [pid, kind, cap] = args[2].split(":");
    if (!["hook", "mcp_server", "reminder", "agent_definition", "invocation_preapproval"].includes(kind)) fail("unknown runtime capability kind " + kind + "; expected one of hook, reminder, mcp_server, agent_definition, invocation_preapproval");
    const p = find(pid);
    if (pmode !== "ignore") (p.status ??= {})[cap] = sub === "approve" ? "trusted_enabled" : "trusted_disabled";
    saveState();
    out({ decision: sub, runtime_capabilities: [{ stable_id: "plugin:" + pid + ":" + kind + ":" + cap, enabled: sub === "approve" }] });
  } else if (sub === "enable" || sub === "disable") {
    const p = find(args[2]);
    if (pmode !== "ignore") p.enabled = sub === "enable";
    saveState();
    out({ [sub]: record(p) });
  } else if (sub === "update") {
    const p = find(args[2]);
    p.updated_at = "2026-11-02T01:00:00Z";
    p.status = {};
    saveState();
    out({ updated: record(p), diagnostics: [] });
  } else if (sub === "remove") {
    find(args[2]);
    if (pmode !== "ignore") state.plugins = state.plugins.filter((p) => p.id !== args[2]);
    saveState();
    out({ removed: args[2], data_path: null, warning: null });
  } else if (sub === "marketplace" && args[2] === "list") out({ marketplaces: state.marketplaces, warnings: [] });
  else if (sub === "marketplace" && args[2] === "add") {
    if (pmode !== "ignore") state.marketplaces.push({ name: args[3], source: { kind: args[4].startsWith("https://") ? "git" : "local-dir", path: args[4] }, plugin_count: Number(process.env.FAKE_MARKET_USABLE ?? 0), skipped: Array.from({ length: Number(process.env.FAKE_MARKET_SKIPPED ?? 0) }, (_, i) => ({ name: "s" + i, reason: "skipped" })) });
    saveState();
    out({ marketplace: { name: args[3], source: { kind: "git", path: args[4] }, plugin_count: Number(process.env.FAKE_MARKET_USABLE ?? 0), skipped: Array.from({ length: Number(process.env.FAKE_MARKET_SKIPPED ?? 0) }, (_, i) => ({ name: "s" + i, reason: "skipped" })) } });
  }
  else if (sub === "marketplace" && (args[2] === "update" || args[2] === "remove")) {
    if (!state.marketplaces.some((m) => m.name === args[3])) fail("no marketplace " + args[3]);
    if (args[2] === "remove" && pmode !== "ignore") state.marketplaces = state.marketplaces.filter((m) => m.name !== args[3]);
    saveState();
    out(args[2] === "update" ? { marketplace: state.marketplaces.find((m) => m.name === args[3]) } : { removed: args[3] });
  } else fail("unsupported plugins subcommand in the fake: " + sub);
  process.exit(0);
}

if (args[0] !== "skills") fail(`unexpected command: ${args.join(" ")}`);
const sub = args[1];
log({ sub, args });
if (sub === "list") {
  out({ skills: load().map(row), diagnostics: [] });
} else if (sub === "enable" || sub === "disable" || sub === "user-only") {
  if (mode === "fail") fail("could not write settings: access denied");
  const id = args[2];
  const activation = sub === "enable" ? "on" : sub === "disable" ? "off" : "user-invocable-only";
  const rows = load();
  const wanted = flag("--scope") === "built-in" ? "bundled" : flag("--scope");
  const target = rows.find((r) => r.id === id && (r.scope ?? "user") === wanted);
  if (!target) fail(`no skill ${id} in scope ${flag("--scope")}`);
  if (mode !== "ignore") {
    target.activation = activation;
    save(rows);
  }
  out({ selector: id, scope: flag("--scope"), activation, settings_path: "$CONFIG_DIR/settings.json" });
} else if (sub === "validate") {
  const path = args[2];
  if (path.includes("bad")) {
    process.stdout.write(`${JSON.stringify({ error: { code: "invalid-skill", message: "SKILL.md is missing a description" } })}\n`);
    process.exit(1);
  }
  out({
    valid: true,
    id: path.split(/[\\/]/).pop(),
    diagnostics: [{ severity: "warning", message: "unknown field: foo" }],
    compatibility: { result: "compatible", unknown_fields: ["foo"], unsupported_fields: [], allowed_tools: ["shell"] },
  });
} else if (sub === "install") {
  if (mode === "fail") fail("could not install: access denied");
  const id = args[2].split(/[\\/]/).pop();
  const rows = load();
  if (rows.some((r) => r.id === id) && !args.includes("--force")) fail(`skill ${id} already exists; pass --force to replace it`);
  if (!rows.some((r) => r.id === id)) rows.push({ id, scope: "user" });
  save(rows);
  out({ installed: { id, path: `$CONFIG_DIR/skills/${id}` }, diagnostics: [] });
} else if (sub === "uninstall") {
  const id = args[2];
  save(load().filter((r) => r.id !== id));
  out({ uninstalled: { id, removed_files: ["SKILL.md"], kept_files: [] } });
} else {
  fail(`unsupported in the fake: ${sub}`);
}
