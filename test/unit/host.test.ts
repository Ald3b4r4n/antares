// Robustness of the JSON-RPC host client when the process cannot be started.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MuseHost } from "../../src/muse/host.ts";
import { MuseSession } from "../../src/muse/session.ts";

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))]);

test("a binary that cannot be started fails the request and stop() still returns", async () => {
  const host = new MuseHost({ binary: join(tmpdir(), "antares-no-such-muse.exe"), args: ["serve"] });
  const exits: unknown[] = [];
  host.on("exit", (code: unknown) => exits.push(code));
  host.start();
  await assert.rejects(within(host.request("initialize", {}, 5000), 6000, "request"), /ENOENT|not running/);
  assert.equal(await within(host.stop(), 3000, "stop()"), null);
  assert.equal(host.running, false);
  assert.equal(exits.length, 1, "exit is announced once");
  await assert.rejects(host.request("anything", {}), /not running/);
});

test("a bad working directory is handled the same way", async () => {
  const host = new MuseHost({ binary: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], cwd: join(tmpdir(), "antares-no-such-dir-xyz") });
  host.start();
  await assert.rejects(within(host.request("initialize", {}, 5000), 6000, "request"), /ENOENT|not running/);
  await within(host.stop(), 3000, "stop()");
});

test("a session whose host cannot start reports the failure and can be stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-host-"));
  const session = new MuseSession({ binary: join(dir, "missing-muse.exe"), workspaceRoot: dir });
  try {
    await assert.rejects(within(session.start(), 6000, "start()"), /ENOENT|not running/);
    await within(session.stop(), 3000, "stop()");
    assert.equal(session.running, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
