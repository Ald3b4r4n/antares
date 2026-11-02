// Web access: Muse's own tools `web_fetch` (read a page) and `web_search`, switched by two host settings
// (`tools.web_fetch.enabled`, `tools.web_search.mode`: client | hosted | off). Read and write through MSP's settings methods.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeWeb, mapWebSettings, readWebSettings, setFetchEnabled, setSearchMode } from "../../src/muse/webSettings.ts";
import { readReport } from "../fixtures/report.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("mapWebSettings reads the two keys and leaves anything unexpected undefined", () => {
  assert.deepEqual(mapWebSettings({ values: { "tools.web_fetch.enabled": true, "tools.web_search.mode": "client" } }), { fetchEnabled: true, searchMode: "client" });
  assert.deepEqual(mapWebSettings({ values: { "tools.web_fetch.enabled": false, "tools.web_search.mode": "off" } }), { fetchEnabled: false, searchMode: "off" });
  assert.deepEqual(mapWebSettings({ values: { "tools.web_search.mode": "hosted" } }), { fetchEnabled: undefined, searchMode: "hosted" });
  assert.deepEqual(mapWebSettings({ values: { "tools.web_fetch.enabled": "yes", "tools.web_search.mode": "turbo" } }), { fetchEnabled: undefined, searchMode: undefined });
  assert.deepEqual(mapWebSettings(null), { fetchEnabled: undefined, searchMode: undefined });
});

test("describeWeb gives one short label and says what each part does", () => {
  assert.equal(describeWeb({ fetchEnabled: true, searchMode: "client" }).label, "Web: on");
  assert.equal(describeWeb({ fetchEnabled: false, searchMode: "off" }).label, "Web: off");
  assert.equal(describeWeb({ fetchEnabled: true, searchMode: "off" }).label, "Web: pages only");
  assert.equal(describeWeb({ fetchEnabled: false, searchMode: "client" }).label, "Web: search only");
  assert.equal(describeWeb({ fetchEnabled: undefined, searchMode: undefined }).label, "Web: not reported");
  const d = describeWeb({ fetchEnabled: true, searchMode: "hosted" });
  assert.match(d.detail, /web_fetch/);
  assert.match(d.detail, /hosted/);
  assert.match(d.detail, /approval|asks/i, "it says that reaching a site can still ask for approval");
});

function env(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-web-"));
  const report = join(dir, "report.json");
  return { dir, report, options: { binary: process.execPath, binaryArgs: [fake], cwd: dir, env: { ...process.env, FAKE_MUSE_REPORT: report, ...extra } }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readWebSettings asks the host (a short-lived one, settings are experimental)", async () => {
  const t = env({ FAKE_MUSE_SETTINGS: JSON.stringify({ "tools.web_fetch.enabled": true, "tools.web_search.mode": "client" }) });
  try {
    assert.deepEqual(await readWebSettings(t.options), { fetchEnabled: true, searchMode: "client" });
  } finally {
    t.done();
  }
});

test("setFetchEnabled and setSearchMode write exactly their key and check the host's answer", async () => {
  const t = env();
  try {
    assert.equal(await setFetchEnabled(t.options, false), false);
    assert.equal(await setSearchMode(t.options, "hosted"), "hosted");
    assert.deepEqual(readReport(t.report).settingsWrite, [{ keyPath: "tools.web_fetch.enabled", value: false }, { keyPath: "tools.web_search.mode", value: "hosted" }]);
    await assert.rejects(setSearchMode(t.options, "turbo" as never), /client, hosted or off/);
    assert.equal(readReport(t.report).settingsWrite?.length, 2, "an invalid mode never reaches the host");
  } finally {
    t.done();
  }
});

test("a refusal, or a host that answers with the old value, is an error", async () => {
  const refuse = env({ FAKE_MUSE_WRITE: "refuse" });
  try {
    await assert.rejects(setFetchEnabled(refuse.options, false), /not writable/);
  } finally {
    refuse.done();
  }
  const ignored = env({ FAKE_MUSE_WRITE: "ignored" });
  try {
    await assert.rejects(setFetchEnabled(ignored.options, false), /still/);
    await assert.rejects(setSearchMode(ignored.options, "off"), /still/);
  } finally {
    ignored.done();
  }
});
