// Launches an installed VS Code-compatible editor with Antares loaded as a development extension,
// in a throwaway profile, and runs test/suite inside its extension host.
// Usage: node test/runTests.mjs <path-to-editor-exe> [label]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const editor = process.argv[2];
if (!editor) {
  console.error("usage: node test/runTests.mjs <editor-exe> [label]");
  process.exit(2);
}
const label = process.argv[3] ?? "editor";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), `antares-it-${label}-`));
const workspace = join(work, "workspace");
mkdirSync(join(workspace, ".vscode"), { recursive: true });
writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify({ "antares.dev.provider": "echo", "antares.usage.refreshOnOpen": false, "security.workspace.trust.enabled": false }, null, 2));
const muse = join(work, "muse-home");
mkdirSync(join(muse, "config"), { recursive: true });
mkdirSync(join(muse, "data"), { recursive: true });

let code = 1;
try {
  await runTests({
    vscodeExecutablePath: editor,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "dist-test", "suite.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${join(work, "user-data")}`, `--extensions-dir=${join(work, "extensions")}`],
    extensionTestsEnv: {
      ANTARES_TEST: "1",
      XDG_CONFIG_HOME: join(muse, "config"),
      XDG_DATA_HOME: join(muse, "data"),
      MUSE_AUTH_PATH: join(muse, "config", "absent-auth.json"),
      META_API_KEY: "",
    },
  });
  console.log(`[${label}] integration tests PASSED`);
  code = 0;
} catch (error) {
  console.error(`[${label}] integration tests FAILED:`, error instanceof Error ? error.message : error);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
