// Phase 1 probe: model catalog and model switching. NO model call (no turn is sent, no tokens spent).
// Runs `muse serve` in the user's normal environment (the login lives there) with shell and writes
// disabled and the :read-only profile, in an empty throwaway workspace. It starts one session
// (written to the user's session history, like any session), lists models, switches the model
// with session/setModel, and lists again.
//
// Usage: node scripts/probe-model.ts [path-to-muse]
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
const work = mkdtempSync(join(tmpdir(), "antares-model-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });
const outDir = new URL("../spike-output/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const host = new MuseHost({ binary, args: ["serve", "--disable-shell", "--disable-write"], cwd: workspace, env: { ...process.env } });
const log: { at: number; kind: string; method?: string; payload?: unknown }[] = [];
const t0 = Date.now();
const rec = (kind: string, method?: string, payload?: unknown) => log.push({ at: Date.now() - t0, kind, method, payload });
host.on("notification", (method: string, params: unknown) => rec("notification", method, params));
host.on("request", (id: number | string, method: string, params: unknown) => rec("serverRequest", method, { id, params }));

interface Row { modelId: string; providerId: string; profileId: string | null; displayLabel: string; isActive: boolean; isDefault: boolean; variants?: string[] }
const ask = async <T>(method: string, params: unknown): Promise<T | { error: string }> => {
  try {
    const r = await host.request<T>(method, params);
    rec("result", method, r);
    return r;
  } catch (e) {
    rec("error", method, (e as Error).message);
    return { error: (e as Error).message };
  }
};

try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares", version: "0.0.1" }, capabilities: { requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");

  const before = await ask<{ models: Row[] }>("model/list", {}); // no session yet: allowed by the contract
  const started = await ask<{ session?: { sessionId?: string; modelId?: string | null } }>("session/start", { commandId: uuidv7(), workspaceRoot: workspace, permissionProfile: ":read-only" });
  const sessionId = "session" in started ? started.session?.sessionId : undefined;
  if (!sessionId) throw new Error("no session id");
  const listed = await ask<{ models: Row[] }>("model/list", { sessionId });
  const rows = "models" in listed ? listed.models : [];
  const active = rows.find((r) => r.isActive);
  const target = rows.find((r) => !r.isActive && !r.isDefault) ?? rows.find((r) => !r.isActive);
  console.log("catalog:", rows.map((r) => `${r.modelId}${r.isActive ? " [active]" : ""}${r.isDefault ? " [default]" : ""}`).join(", "));
  if (target) {
    console.log("switching model to", target.modelId, "(no turn is sent)");
    await ask("session/setModel", { commandId: uuidv7(), sessionId, model: { modelId: target.modelId, providerId: target.providerId, profileId: target.profileId ?? undefined, displayLabel: target.displayLabel } });
    await new Promise((r) => setTimeout(r, 500));
    const after = await ask<{ models: Row[] }>("model/list", { sessionId });
    console.log("after switch, active:", ("models" in after ? after.models : []).filter((r) => r.isActive).map((r) => r.modelId).join(", ") || "(none)");
    // Restore the previous selection so the session ends where it started.
    if (active) await ask("session/setModel", { commandId: uuidv7(), sessionId, model: { modelId: active.modelId, providerId: active.providerId, profileId: active.profileId ?? undefined } });
  }
  await ask("session/setReasoningEffort", { commandId: uuidv7(), sessionId, reasoningEffort: rows[0]?.variants?.includes("low") ? "low" : "high" });
  rec("note", undefined, { catalogBeforeSessionCount: "models" in before ? before.models.length : null });
} catch (error) {
  rec("error", undefined, error instanceof Error ? error.message : String(error));
} finally {
  const code = await host.stop();
  writeFileSync(new URL("probe-model.json", outDir), JSON.stringify({ hostExitCode: code, log }, null, 2));
  console.log("done; host exit code", code);
  rmSync(work, { recursive: true, force: true });
}
