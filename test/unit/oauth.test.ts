// OAuth sign-in and sign-out for MCP servers against the fake host. The host owns the flow and the credential;
// these tests pin down what Antares does around it: what it shows, when it cancels, and that it never keeps a URL.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { httpsOrigin, oauthSignIn, oauthSignOut } from "../../src/muse/mcpLogin.ts";
import { readReport } from "../fixtures/report.ts";

const fake = new URL("../fixtures/fake-muse.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function setup(oauth?: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "antares-oauth-"));
  const reportPath = join(dir, "report.json");
  const options = { binary: process.execPath, binaryArgs: [fake], cwd: dir, env: { ...process.env, FAKE_MUSE_REPORT: reportPath, ...(oauth ? { FAKE_MUSE_OAUTH: oauth } : {}), ...extraEnv } };
  return { options, report: () => readReport(reportPath), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("origin: only https counts, and only the origin is kept (the rest of the URL carries a state value)", () => {
  assert.equal(httpsOrigin("https://auth.example.test/authorize?state=secret-state&x=1"), "https://auth.example.test");
  assert.equal(httpsOrigin("http://auth.example.test/authorize"), undefined);
  assert.equal(httpsOrigin("javascript:alert(1)"), undefined);
  assert.equal(httpsOrigin("file:///C:/x"), undefined);
  assert.equal(httpsOrigin("not a url"), undefined);
});

test("sign-in: the user agrees, the provider grants, and Antares only ever saw the URL it was asked about", async () => {
  const t = setup("grant");
  try {
    const seen: string[] = [];
    const result = await oauthSignIn(t.options, "demo", async (url) => {
      seen.push(url);
      return true;
    });
    assert.deepEqual(result, { outcome: "granted", message: undefined });
    assert.equal(seen.length, 1);
    assert.equal(httpsOrigin(seen[0]!), "https://auth.example.test");
    const kinds = t.report().oauth.map((o) => o.kind);
    assert.deepEqual(kinds, ["oauth-login"], "no cancel after a grant");
    assert.deepEqual(t.report().oauth[0]?.data, { server: "demo" });
  } finally {
    t.done();
  }
});

test("sign-in: when the user declines the page, the pending flow is cancelled at the host", async () => {
  const t = setup("grant");
  try {
    const result = await oauthSignIn(t.options, "demo", async () => false);
    assert.equal(result.outcome, "cancelled");
    assert.deepEqual(t.report().oauth.map((o) => o.kind), ["oauth-login", "oauth-cancel"]);
    assert.deepEqual(t.report().oauth[1]?.data, { server: "demo" });
  } finally {
    t.done();
  }
});

test("sign-in: a provider that says no is reported as denied, with its message", async () => {
  const t = setup("denied");
  try {
    const result = await oauthSignIn(t.options, "demo", async () => true);
    assert.deepEqual(result, { outcome: "denied", message: "The provider said no." });
  } finally {
    t.done();
  }
});

test("sign-in: giving up waiting cancels the flow and says so", async () => {
  const t = setup(); // the fake host never completes the flow
  try {
    const result = await oauthSignIn({ ...t.options, timeoutMs: 400 }, "demo", async () => true);
    assert.equal(result.outcome, "expired");
    assert.match(result.message ?? "", /stopped waiting/);
    assert.deepEqual(t.report().oauth.map((o) => o.kind), ["oauth-login", "oauth-cancel"]);
  } finally {
    t.done();
  }
});

test("sign-in: aborting while waiting cancels the flow", async () => {
  const t = setup();
  try {
    const abort = new AbortController();
    const result = await oauthSignIn({ ...t.options, signal: abort.signal }, "demo", async () => {
      setTimeout(() => abort.abort(), 200);
      return true;
    });
    assert.equal(result.outcome, "cancelled");
    assert.deepEqual(t.report().oauth.map((o) => o.kind), ["oauth-login", "oauth-cancel"]);
  } finally {
    t.done();
  }
});

test("sign-out: the host deletes the credential and reports the revocation", async () => {
  const t = setup();
  try {
    const result = await oauthSignOut(t.options, "demo");
    assert.deepEqual(result, { removed: true, revocation: "notAttempted" });
    assert.deepEqual(t.report().oauth.map((o) => o.kind), ["oauth-logout"]);
    assert.deepEqual(t.report().oauth[0]?.data, { server: "demo" });
  } finally {
    t.done();
  }
});
