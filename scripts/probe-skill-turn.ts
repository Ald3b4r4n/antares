// Phase 2B probe: does the real host accept a `skill` input part, `workspaceRoots` and a mention? NO model
// call: the echo provider, an ephemeral session and throwaway folders. Prints what came back.
//
// Usage: node scripts/probe-skill-turn.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "../src/muse/composer.ts";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-skillturn-"));
const workspace = join(work, "workspace");
const extra = join(work, "extra");
mkdirSync(workspace, { recursive: true });
mkdirSync(extra, { recursive: true });
writeFileSync(join(extra, "note.txt"), "hello");

const host = new MuseHost({ binary, args: ["serve", "--provider", "echo", "--no-session-log", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
const seen: { method: string; item?: unknown }[] = [];
host.on("notification", (method: string, params: any) => {
  if (/^item\/|^turn\//.test(method)) seen.push({ method, item: params?.item ? { kind: params.item.kind, text: String(params.item.text ?? "").slice(0, 160), attachments: params.item.attachments?.length } : undefined });
});
const out: Record<string, unknown> = {};
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 30_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const started = await ask("session/start", { commandId: uuidv7(), workspaceRoot: workspace });
  const sessionId = started.session?.sessionId;
  out.session = Boolean(sessionId);
  const waitIdle = () => new Promise((r) => setTimeout(r, 2500));

  out.skillTurn = await ask("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "skill", selector: "plan", source: "bundled", arguments: "tidy the README" }] });
  await waitIdle();
  out.rootsTurn = await ask("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "text", text: "hello @note.txt" }], workspaceRoots: [canonicalPath(workspace), canonicalPath(extra)] });
  out.canonicalExample = canonicalPath(extra).replace(/antares-skillturn-[^\\]+/, "antares-skillturn-X");
  await waitIdle();
  out.badSkill = await ask("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "skill", selector: "definitely-not-a-skill" }] });
  await waitIdle();
  out.events = seen.filter((s) => s.item).map((s) => ({ method: s.method, ...(s.item as object) }));
} finally {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
