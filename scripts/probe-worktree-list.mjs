// Phase 3D probe (part 2): worktree/list is read-only, so ask it about a repository that exists (this project's own).
// Usage: node scripts/probe-worktree-list.mjs <repo-path>
import { MuseHost } from "../src/muse/host.ts";
import { locateMuse } from "../src/muse/locate.ts";

const repo = process.argv[2];
const host = new MuseHost({ binary: locateMuse(), args: ["serve", "--disable-shell", "--disable-write"], cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
try {
  host.start();
  await host.request("initialize", { clientInfo: { name: "antares_probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
  host.notify("initialized");
  const r = await host.request("worktree/list", { workspaceRoot: repo }, 30000).catch((e) => ({ error: e.message }));
  console.log(JSON.stringify(r.error ? r : { count: r.worktrees.length, rows: r.worktrees.map((w) => ({ isMain: w.isMain, branch: w.branch, sessions: w.sessionIds.length })) }));
} finally {
  await host.stop();
}
