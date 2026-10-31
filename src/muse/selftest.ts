import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, MuseHost } from "./host.ts";
import { uuidv7 } from "./uuidv7.ts";

/**
 * Stable-surface schema fingerprints this build of Antares was written against.
 * A different fingerprint is not an error, but the UI should warn: the contract changed.
 */
export const KNOWN_SCHEMA_FINGERPRINTS: Record<string, string> = {
  "1.4.14": "sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6",
};

export interface SelfTestResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail?: string }[];
  serverVersion?: string;
  userAgent?: string;
  platform?: string;
  schemaVersion?: number;
  schemaFingerprint?: string;
  fingerprintKnown?: boolean;
  grantedCapabilities?: string[];
  sessionDurability?: string;
  sandboxAvailability?: string;
  sessionProvider?: string;
  hostExitCode?: number | null;
  stderr: string[];
}

interface InitializeResult {
  serverInfo?: { name?: string; version?: string };
  userAgent?: string;
  platformFamily?: string;
  schema?: { version?: number; fingerprint?: string };
  grantedCapabilities?: string[];
  sessionDurability?: string;
  sandboxAvailability?: string;
}

interface SessionStartResult {
  session?: { sessionId?: string; providerId?: string };
}

/**
 * Offline end-to-end check: starts `muse serve` with the `echo` provider in a fully
 * isolated config/data tree (no real credentials, no session log, restricted network),
 * performs the MSP handshake, opens one ephemeral session and closes the host.
 * No model call is made and nothing outside `workDir` is written.
 */
export async function runSelfTest(binary: string, workDir: string, clientVersion = "0.0.1"): Promise<SelfTestResult> {
  const workspace = join(workDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const result: SelfTestResult = { ok: false, steps: [], stderr: [] };
  const host = new MuseHost({
    binary,
    args: ["serve", "--provider", "echo", "--no-session-log", "--sandbox-network", "restricted"],
    cwd: workspace,
    env: isolatedEnv(join(workDir, "muse-home")),
  });
  host.on("stderr", (line: string) => result.stderr.push(line));
  const step = (name: string, ok: boolean, detail?: string) => result.steps.push({ name, ok, detail });
  try {
    host.start();
    const init = await host.request<InitializeResult>("initialize", {
      clientInfo: { name: "antares", version: clientVersion },
      capabilities: { requestedCapabilities: [], userInputDialogs: false },
    });
    result.serverVersion = init.serverInfo?.version;
    result.userAgent = init.userAgent;
    result.platform = init.platformFamily;
    result.schemaVersion = init.schema?.version;
    result.schemaFingerprint = init.schema?.fingerprint;
    result.grantedCapabilities = init.grantedCapabilities;
    result.sessionDurability = init.sessionDurability;
    result.sandboxAvailability = init.sandboxAvailability;
    result.fingerprintKnown =
      result.serverVersion !== undefined && KNOWN_SCHEMA_FINGERPRINTS[result.serverVersion] === result.schemaFingerprint;
    step("initialize", true, result.serverVersion);
    host.notify("initialized");

    const started = await host.request<SessionStartResult>("session/start", {
      commandId: uuidv7(),
      workspaceRoot: workspace,
      approvalMode: "onRequest",
    });
    result.sessionProvider = started.session?.providerId;
    const hasSession = typeof started.session?.sessionId === "string";
    step("session/start", hasSession, result.sessionProvider);
    result.ok = hasSession;
  } catch (error) {
    step("error", false, error instanceof Error ? error.message : String(error));
  } finally {
    result.hostExitCode = await host.stop();
    step("host stopped", result.hostExitCode === 0, `exit code ${result.hostExitCode}`);
  }
  return result;
}
