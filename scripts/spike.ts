// Phase 0 spike: offline MSP handshake against the locally installed `muse` binary.
// Usage: node scripts/spike.ts [path-to-muse]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateMuse } from "../src/muse/locate.ts";
import { runSelfTest } from "../src/muse/selftest.ts";

const binary = locateMuse(process.argv[2]);
if (!binary) {
  console.error("muse executable not found. Pass its path as the first argument.");
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "antares-spike-"));
try {
  const result = await runSelfTest(binary, workDir);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
