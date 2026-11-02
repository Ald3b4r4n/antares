// Standard / Contributor: what the settings say, and how sure Antares can be about what is in effect.
// The shapes are the real ones observed from muse 1.4.14 (`settings/read` values, `account/read`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeContributor, mapContributor, readContributor, switchToContributor, switchToStandard } from "../../src/muse/contributor.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("mapContributor reads the saved value and the account label", () => {
  assert.deepEqual(mapContributor({ schemaVersion: 1, values: { contributor_mode_enabled: true } }, { state: "accountLogin", label: "a@b.test" }), { saved: true, account: "a@b.test" });
  assert.deepEqual(mapContributor({ schemaVersion: 1, values: { contributor_mode_enabled: false } }), { saved: false, account: undefined });
  assert.equal(mapContributor({ schemaVersion: 1, values: {} }).saved, undefined, "no saved value is unknown, never assumed off");
  assert.equal(mapContributor({ schemaVersion: 1, values: { contributor_mode_enabled: "yes" } }).saved, undefined, "a non-boolean is not a boolean");
  assert.equal(mapContributor(null).saved, undefined);
});

test("describeContributor: Contributor is shown only when it is the saved value and nothing overrides it", () => {
  const on = describeContributor({ saved: true }, {});
  assert.equal(on.mode, "contributor");
  assert.equal(on.confirmed, true);
  assert.match(on.privacy, /Meta/i);
  const off = describeContributor({ saved: false }, {});
  assert.equal(off.mode, "standard");
  assert.equal(off.confirmed, true);
});

test("an environment override makes the state 'not confirmed': the host's effective value cannot be read back", () => {
  const s = describeContributor({ saved: false }, { MUSE_CONTRIBUTOR_MODE: "1" });
  assert.equal(s.mode, "unconfirmed");
  assert.equal(s.confirmed, false);
  assert.match(s.detail, /MUSE_CONTRIBUTOR_MODE/);
});

test("no saved value is 'not confirmed' and says Muse's default may be Contributor", () => {
  const s = describeContributor({ saved: undefined }, {});
  assert.equal(s.mode, "unconfirmed");
  assert.match(s.detail, /default/i);
});

test("an unreadable setting is 'not confirmed' with the reason, not Standard", () => {
  const s = describeContributor({ saved: undefined, error: "settings/read is not available" }, {});
  assert.equal(s.mode, "unconfirmed");
  assert.match(s.detail, /not available/);
});

test("readContributor asks the host (settings and account) and reports the saved value", async () => {
  const state = await readContributor({ binary: process.execPath, binaryArgs: [fake], cwd: process.cwd(), env: { ...process.env, FAKE_MUSE_SETTINGS: JSON.stringify({ contributor_mode_enabled: true }) } });
  assert.equal(state.saved, true);
  assert.equal(state.account, "person@example.test");
});

test("readContributor survives a host without settings/read", async () => {
  const state = await readContributor({ binary: process.execPath, binaryArgs: [fake], cwd: process.cwd(), env: { ...process.env, FAKE_MUSE_SETTINGS: "error" } });
  assert.equal(state.saved, undefined);
  assert.match(state.error ?? "", /settings\/read/);
});

// ---- switching: only toward Standard. Contributor is switched on in Muse itself, which records the user's
// acknowledgement of the data-use disclosure (a settings key a client cannot write). ----
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReport } from "../fixtures/report.ts";

async function writeWith(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "antares-contrib-"));
  const reportPath = join(dir, "report.json");
  try {
    const outcome = await switchToStandard({ binary: process.execPath, binaryArgs: [fake], cwd: dir, env: { ...process.env, FAKE_MUSE_REPORT: reportPath, ...env } }).then(
      (r) => ({ ok: true as const, r }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    );
    return { outcome, writes: readReport(reportPath).settingsWrite ?? [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("switchToStandard writes exactly contributor_mode_enabled=false and checks the host's answer", async () => {
  const { outcome, writes } = await writeWith({});
  assert.deepEqual(outcome, { ok: true, r: { saved: false } });
  assert.deepEqual(writes, [{ keyPath: "contributor_mode_enabled", value: false }]);
});

test("switchToContributor writes exactly contributor_mode_enabled=true and checks the host's answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-contrib-"));
  const reportPath = join(dir, "report.json");
  try {
    const r = await switchToContributor({ binary: process.execPath, binaryArgs: [fake], cwd: dir, env: { ...process.env, FAKE_MUSE_REPORT: reportPath } });
    assert.deepEqual(r, { saved: true });
    assert.deepEqual(readReport(reportPath).settingsWrite, [{ keyPath: "contributor_mode_enabled", value: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switchToStandard fails loudly when the host refuses", async () => {
  const { outcome } = await writeWith({ FAKE_MUSE_WRITE: "refuse" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /not writable/);
});

test("switchToStandard does not claim success when the host's effective value is not Standard", async () => {
  const { outcome } = await writeWith({ FAKE_MUSE_WRITE: "ignored" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /still/i);
});
