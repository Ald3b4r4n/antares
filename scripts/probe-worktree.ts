// Phase 3D probe: `session/start` with `worktree` (experimental) and `worktree/list`. NO model call. A throwaway git
// repository with one commit, an isolated HOME, config and data folder (so any worktree the host allocates lands in
// the temp folder), and everything is removed at the end (git worktrees first). Reports where the host put the
// worktree, the branch, what `git worktree list` says, and what happens when the session closes.
//
// Usage: node scripts/probe-worktree.ts [path-to-muse]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "../src/muse/composer.ts";
import { normalizeHostPath } from "../src/muse/patches.ts";
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { uuidv7 } from "../src/muse/uuidv7.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "antares-worktree-"));
const home = join(work, "home");
const repo = join(work, "repo");
for (const d of [home, repo, join(work, "config"), join(work, "data")]) mkdirSync(d, { recursive: true });
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "p@example.test", GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "p@example.test" } }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "one\n");
git("add", ".");
git("commit", "-q", "-m", "first");

const host = new MuseHost({
  binary,
  args: ["serve", "--disable-shell", "--disable-write"],
  cwd: repo,
  env: { ...process.env, XDG_CONFIG_HOME: join(work, "config"), XDG_DATA_HOME: join(work, "data"), MUSE_AUTH_PATH: join(work, "config", "absent-auth.json"), META_API_KEY: "" },
});
const events: unknown[] = [];
host.on("notification", (method: string, params: any) => {
  if (/worktree/i.test(method) || method === "session/closed") events.push({ method, params: JSON.stringify(params).slice(0, 300) });
});
const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);
const ask = async (method: string, params: unknown): Promise<any> => {
  try {
    return await host.request(method, params, 60_000);
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const notes: Record<string, unknown> = {};
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  notes.listBefore = (await ask("worktree/list", { workspaceRoot: canonicalPath(repo) })).worktrees?.map((w: any) => ({ isMain: w.isMain, branch: w.branch, sessions: w.sessionIds?.length }));

  const started = await ask("session/start", { commandId: uuidv7(), workspaceRoot: normalizeHostPath(canonicalPath(repo)), permissionProfile: ":read-only", worktree: { mode: "create" } });
  notes.start = { error: started.error, sessionKeys: keys(started.session), worktree: started.session?.worktree && { origin: started.session.worktree.origin, pathInTemp: String(started.session.worktree.path).includes("antares-worktree-") }, branch: started.session?.branch, workspaceRootInSession: started.session?.workspaceRoot === repo ? "same as repo" : "different" };
  const wtPath: string | undefined = started.session?.worktree?.path;
  notes.gitWorktrees = git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") || l.startsWith("branch ")).map((l) => l.replace(work, "<work>"));
  const list = await ask("worktree/list", { workspaceRoot: canonicalPath(repo) });
  notes.listAfter = list.worktrees?.map((w: any) => ({ isMain: w.isMain, branch: w.branch, sessions: w.sessionIds?.length, path: String(w.path).replace(work, "<work>") }));
  notes.dirtyMainCheck = git("status", "--porcelain");
  notes.events = events;
  void wtPath;
} catch (e) {
  notes.fatal = (e as Error).message;
} finally {
  await host.stop();
  try {
    notes.afterStop = git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length + " worktree(s) listed after the host stopped";
    for (const line of git("worktree", "list", "--porcelain").split("\n")) if (line.startsWith("worktree ") && !line.endsWith(repo.replace(/\\/g, "/")) && !line.includes("repo")) git("worktree", "remove", "--force", line.slice(9));
  } catch {
    /* the repo may already be gone */
  }
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(notes, null, 2));
