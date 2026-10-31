// Phase 3A probe: skill activation and the Claude/Codex import preview. NO model call. Everything runs in a
// throwaway home, Muse config and workspace, with one fake foreign skill, so none of the user's skills or
// settings are read or changed. Only the import PREVIEW (dryRun) is called; nothing is imported.
//
// Usage: node scripts/probe-skills.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-skills-"));
const home = join(work, "home");
const workspace = join(work, "workspace");
for (const d of [home, workspace, join(work, "config"), join(work, "data"), join(home, ".claude", "skills", "demo-import")]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, ".claude", "skills", "demo-import", "SKILL.md"), "---\nname: demo-import\ndescription: A fake skill used only by the Antares probe.\n---\nSay hello.\n");
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({
  binary,
  args: ["serve", "--provider", "echo", "--no-session-log", "--disable-shell", "--disable-write"],
  cwd: workspace,
  env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data"), MUSE_AUTH_PATH: join(work, "config", "absent-auth.json"), META_API_KEY: "" },
});
const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const notes: Record<string, unknown> = {};
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const started = await ask("session/start", { commandId: uuidv7(), workspaceRoot: workspace });
  const sessionId = started.session?.sessionId;
  if (!sessionId) throw new Error(`no session: ${started.error}`);

  const list = await ask("skill/list", { sessionId });
  const rows: any[] = list.skills ?? [];
  notes.list = { count: rows.length, rowKeys: keys(rows[0]), sources: rows.reduce((a: any, r) => ({ ...a, [r.source]: (a[r.source] ?? 0) + 1 }), {}) };

  const bundled = rows.find((r) => r.source === "bundled");
  notes.target = bundled?.selector;
  if (bundled) {
    const off = await ask("skill/setActivation", { commandId: uuidv7(), sessionId, selector: bundled.selector, scope: "bundled", activation: "off" });
    notes.off = { error: off.error, activation: off.activation, previous: off.previous, status: off.status };
    const after = (await ask("skill/list", { sessionId })).skills ?? [];
    notes.afterOff = { count: after.length, stillListed: after.some((r: any) => r.selector === bundled.selector), rowKeys: keys(after[0]) };
    const on = await ask("skill/setActivation", { commandId: uuidv7(), sessionId, selector: bundled.selector, scope: "bundled", activation: "on" });
    notes.on = { error: on.error, activation: on.activation, previous: on.previous };
    const again = (await ask("skill/list", { sessionId })).skills ?? [];
    notes.afterOn = { count: again.length, listed: again.some((r: any) => r.selector === bundled.selector) };
  }

  const preview = await ask("skill/import", { commandId: uuidv7(), sessionId, source: "claude", dryRun: true });
  notes.importPreview = { error: preview.error, keys: keys(preview), counts: preview.counts, dryRun: preview.dryRun, installed: preview.installed, quarantined: preview.quarantined, skipped: preview.skipped, failed: preview.failed };
  const afterPreview = (await ask("skill/list", { sessionId })).skills ?? [];
  notes.afterPreview = { count: afterPreview.length, demoListed: afterPreview.some((r: any) => r.selector === "demo-import") };
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(new URL("probe-skills.json", outDir), JSON.stringify(notes, null, 2));
console.log(JSON.stringify(notes, null, 2));
