// End-to-end check inside a REAL editor window (VS Code or a fork), driven over the Chrome DevTools
// Protocol (the editors are Electron). It launches the editor with Antares as a development extension
// in a throwaway profile, with the offline `echo` provider and an isolated Muse config (no login, no
// model call), opens the panel from the command palette, drives the real webview and saves
// screenshots of the real window to spike-output/e2e/.
//
// Usage: node scripts/e2e-editor.mjs <path-to-editor-exe> [label]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { locateMuse } from "../src/muse/locate.ts";

const exe = process.argv[2];
const REAL = process.env.E2E_REAL === "1";
// E2E_MODES=1: the real host, no model call. A session is opened (the slash palette needs one) and the permission
// mode is switched through the real UI, which continues that session under the new profile.
const MODES = process.env.E2E_MODES === "1";
// E2E_IMPORT=1: the real host with no model call, in a throwaway HOME that holds one fake Claude skill, so the
// "Import skills" flow (source, preview, confirmation, real import, nothing left to import) touches only that.
const IMPORT = process.env.E2E_IMPORT === "1";
// E2E_PLUGINS=1: the real host with no model call, in a throwaway HOME. Two demo plugins that only bring a skill
// (no hooks, no MCP servers, so nothing runs) and a local marketplace; checks the install and marketplace dialogs.
const PLUGINS = process.env.E2E_PLUGINS === "1";
// Voice mode: fake (no microphone, no engine), error (engine not set up: the setup offer), real (the real
// microphone and the real faster-whisper from ANTARES_VOICE_HOME; records about 2.5 s and keeps nothing).
const VOICE = process.env.E2E_VOICE ?? "fake";
const label = process.argv[3] ?? "editor";
if (!exe) {
  console.error("usage: node scripts/e2e-editor.mjs <editor-exe> [label]");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const shots = join(root, "spike-output", "e2e");
mkdirSync(shots, { recursive: true });
const port = 9340 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), `antares-e2e-${label}-`));
const workspace = join(work, "workspace");
const userData = join(work, "user-data");
const muse = join(work, "muse-home");
for (const d of [join(workspace, ".vscode"), join(userData, "User"), join(muse, "config"), join(muse, "data")]) mkdirSync(d, { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({ "workbench.startupEditor": "none", "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoCheckUpdates": false, "workbench.tips.enabled": false, "window.restoreWindows": "none", "workbench.colorTheme": "Default Dark Modern", "chat.disableAIFeatures": true, "window.dialogStyle": "custom", "workbench.secondarySideBar.defaultVisibility": "hidden" }, null, 2),
);
// A host patch for the tool-presentation check (echo flow only): plan.txt as it is after the edit, and the patch
// that produced it, in the folder layout the host uses. The extension is told to show it with antares.dev.patch.
const patchFile = join(work, "tool-outputs", "t1", "call_1-tool_patch.json");
mkdirSync(join(work, "tool-outputs", "t1"), { recursive: true });
writeFileSync(join(workspace, "plan.txt"), "alpha\nBETA\ngamma\n");
writeFileSync(patchFile, JSON.stringify({ files: [{ path: join(workspace, "plan.txt"), hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" alpha", "-beta", "+BETA", " gamma"] }] }] }));
// Two successive edits of one file for the cumulative "Changes" check: before them it was one/two/three.
mkdirSync(join(work, "tool-outputs", "t2"), { recursive: true });
mkdirSync(join(work, "tool-outputs", "t3"), { recursive: true });
writeFileSync(join(workspace, "series.txt"), "one\nTWO\nthree\nfour\n");
const seriesA = join(work, "tool-outputs", "t2", "call_2-tool_patch.json");
const seriesB = join(work, "tool-outputs", "t3", "call_3-tool_patch.json");
writeFileSync(seriesA, JSON.stringify({ files: [{ path: join(workspace, "series.txt"), hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] }] }] }));
writeFileSync(seriesB, JSON.stringify({ files: [{ path: join(workspace, "series.txt"), hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [" three", "+four"] }] }] }));
mkdirSync(join(work, "tool-outputs", "t4"), { recursive: true });
const goneFile = join(work, "tool-outputs", "t4", "call_4-tool_patch.json");
writeFileSync(goneFile, JSON.stringify({ files: [{ path: join(workspace, "gone.txt"), hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ["+ghost line one", "+ghost line two"] }] }] }));
writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify(PLUGINS ? { "antares.usage.refreshOnOpen": false } : IMPORT ? { "antares.usage.refreshOnOpen": false, "antares.dev.picks": ["claude"] } : MODES ? { "antares.usage.refreshOnOpen": false } : REAL ? { "antares.initialProfile": ":ask-me", "antares.usage.refreshOnOpen": false } : { "antares.dev.provider": "echo", "antares.dev.patch": patchFile, "antares.dev.patchSeries": [seriesA, seriesB, goneFile], "antares.usage.refreshOnOpen": false, ...(VOICE === "fake" ? { "antares.dev.voice": true } : VOICE === "error" ? { "antares.voice.engine": "faster-whisper", "antares.voice.home": join(work, "empty-voice") } : {}) }, null, 2));
{ const sf = join(workspace, ".vscode", "settings.json"); writeFileSync(sf, JSON.stringify({ ...JSON.parse(readFileSync(sf, "utf8")), "antares.offerCatalogs": false }, null, 2)); }
writeFileSync(join(workspace, "hello.txt"), "hello\n");
// Images for the workspace-image check: one inside the workspace, one outside it (a real 1x1 PNG each).
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(workspace, "shot.png"), tinyPng);
writeFileSync(join(work, "outside.png"), tinyPng);
const fakeHome = join(work, "home");
mkdirSync(join(fakeHome, ".claude", "skills", "demo-import"), { recursive: true });
writeFileSync(join(fakeHome, ".claude", "skills", "demo-import", "SKILL.md"), "---\nname: demo-import\ndescription: A fake skill used only by the Antares end-to-end check.\n---\nSay hello.\n");

const child = spawn(
  exe,
  [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${join(work, "extensions")}`, `--extensionDevelopmentPath=${root}`, `--remote-debugging-port=${port}`, "--disable-workspace-trust", "--skip-release-notes", "--skip-welcome", "--new-window"],
  { stdio: "ignore", env: REAL ? { ...process.env } : { ...process.env, XDG_CONFIG_HOME: join(muse, "config"), XDG_DATA_HOME: join(muse, "data"), ...(IMPORT || PLUGINS ? { HOME: fakeHome, USERPROFILE: fakeHome } : {}), MUSE_AUTH_PATH: join(muse, "config", "absent-auth.json"), META_API_KEY: "" } },
);
child.on("error", (e) => console.error("launch error:", e.message));

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("websocket error"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(h) {
    this.handlers.push(h);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitFor(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

let browser;
let evalWebSafe = async () => undefined; // set once the page is reachable; used only to describe a failure
try {
  const targets = await waitFor("the debugging endpoint", async () => (await fetch(`http://127.0.0.1:${port}/json`)).json(), 40000);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.ready;
  console.log(`[${label}] connected to`, version.Browser);

  // The workbench page.
  const page = await waitFor("the workbench page", async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return list.find((t) => t.type === "page" && /workbench/.test(t.url));
  }, 60000);
  const attach = async (targetId) => (await browser.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const pageSession = await attach(page.id);
  const evalPage = async (expression) => {
    const r = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, pageSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  };
  await waitFor("the workbench to load", () => evalPage("!!document.querySelector('.monaco-workbench .part.editor')"), 60000);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  await sleep(800);

  const shot = async (name, session = pageSession) => {
    const r = await browser.send("Page.captureScreenshot", { format: "png" }, session);
    const file = join(shots, `${label}-${name}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  };
  await shot("01-workbench");

  // A first-run welcome overlay (seen in Antigravity IDE) can sit on top of the workbench. Step through
  // plain "next" buttons only; never sign in or create an account on the user's behalf.
  for (let step = 0; step < 4; step++) {
    const buttons = await evalPage("[...document.querySelectorAll('button, .monaco-button, a.monaco-button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(Boolean).slice(0, 12)");
    const advance = buttons.find((b) => /^(get started|skip|continue|next|got it|close)$/i.test(b));
    console.log(`[${label}] visible buttons:`, JSON.stringify(buttons));
    if (!advance || buttons.some((b) => /sign in|log in|create account|sign up/i.test(b) && !/skip/i.test(advance))) {
      if (!advance) break;
    }
    await evalPage(`(() => { const b = [...document.querySelectorAll('button, .monaco-button, a.monaco-button')].find(x => x.offsetParent !== null && x.textContent.trim().toLowerCase() === ${JSON.stringify(advance.toLowerCase())}); if (b) b.click(); return !!b; })()`);
    await sleep(1500);
    await shot(`01b-onboarding-${step + 1}`);
  }

  // Open the command palette with a real key event and run "Antares: Open".
  const key = (type, k, extra = {}) => browser.send("Input.dispatchKeyEvent", { type, key: k, code: k, ...extra }, pageSession);
  const openFromPalette = async (shotName) => {
    await key("rawKeyDown", "F1", { windowsVirtualKeyCode: 112 });
    await key("keyUp", "F1", { windowsVirtualKeyCode: 112 });
    await waitFor("the command palette", () => evalPage("!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')"), 10000);
    await browser.send("Input.insertText", { text: ">Antares: Open" }, pageSession);
    await sleep(700);
    if (shotName) await shot(shotName);
    await key("rawKeyDown", "Enter", { windowsVirtualKeyCode: 13, text: "\r" });
    await key("keyUp", "Enter", { windowsVirtualKeyCode: 13 });
  };
  await openFromPalette("02-palette");

  // Find the Antares webview among all webview targets (editors can host several webviews of their
  // own), and reach its inner document. The content may sit in an inner iframe or in the target itself.
  const evalIn = async (session, expression) => {
    const wrapped = "(async () => { const f = document.getElementById('active-frame') || document.querySelector('iframe'); const d = (f && f.contentDocument) || document; const w = (f && f.contentWindow) || window; return (" + expression + "); })()";
    const r = await browser.send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  };
  let webSession;
  const findWebview = async () => {
    const { targetInfos } = await browser.send("Target.getTargets");
    for (const t of targetInfos.filter((x) => x.type === "iframe" && x.url.startsWith("vscode-webview://"))) {
      let session;
      try {
        session = await attach(t.targetId);
        if (await evalIn(session, "!!d.getElementById('historyPanel') && !!d.getElementById('meta')")) {
          webSession = session;
          return true;
        }
      } catch {
        /* not ours */
      }
      if (session) await browser.send("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
    }
    return false;
  };
  try {
    await waitFor("the Antares webview", findWebview, 20000);
  } catch {
    // The palette sometimes opens before the workbench is ready to run the command; ask once more.
    await key("rawKeyDown", "Escape", { windowsVirtualKeyCode: 27 });
    await key("keyUp", "Escape", { windowsVirtualKeyCode: 27 });
    await sleep(500);
    await openFromPalette();
    await waitFor("the Antares webview (second attempt)", findWebview, 30000);
  }
  const evalWeb = (expression) => evalIn(webSession, expression);
  evalWebSafe = (expression) => evalWeb(expression).catch((e) => ({ unreachable: e.message }));
  await waitFor("chat.js to start inside the real webview", () => evalWeb("!!d.getElementById('input') && d.getElementById('meta').children.length > 0"), 30000);
  await sleep(1500);
  check("panel opens from the command palette in the real editor", true);
  await shot("03-panel-open");

  const dom = await evalWeb(`({
    title: d.title,
    hero: !!d.querySelector('.hero img') && d.querySelector('pre.logo')?.textContent.split(String.fromCharCode(10)).length === 5,
    logoLoaded: d.querySelector('.hero img')?.naturalWidth > 0,
    modes: [...d.querySelectorAll('#modeMenu .menu-item')].map(o => o.dataset.mode + (o.classList.contains('unavailable') ? '(unavailable)' : '')),
    modeLabel: d.getElementById('modeLabel').textContent,
    modelControls: !!d.getElementById('model') && !!d.getElementById('effort'),
    footer: d.getElementById('meta').textContent,
    hint: d.getElementById('hint').textContent.slice(0, 60),
    cssLoaded: getComputedStyle(d.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
    fontFromTheme: getComputedStyle(d.body).fontFamily.slice(0, 30)
  })`);
  console.log("DOM:", JSON.stringify(dom));
  check("banner and logo render (SVG loaded through the webview URI)", dom.hero && dom.logoLoaded);
  check("the mode selector lists Auto, Manual (unavailable), Accept edits, Plan and Bypass, starting in Plan", JSON.stringify(dom.modes) === JSON.stringify(["auto", "manual(unavailable)", "acceptEdits", "plan", "bypass"]) && dom.modeLabel === "Plan", JSON.stringify({ modes: dom.modes, label: dom.modeLabel }));
  check("model and effort controls exist", dom.modelControls);
  check("page styles loaded", dom.cssLoaded);
  const credit = await evalWeb("({ text: d.querySelector('.hero .tag').textContent, href: d.getElementById('authorLink')?.getAttribute('href') })");
  check("the banner credits the author with a link to their site", /an open interface for Muse Code by Antonio Rafael Souza Cruz de Noronha$/.test(credit.text) && credit.href === "https://www.antoniorafael.com.br/", JSON.stringify(credit));

  if (!MODES && !REAL && !IMPORT && !PLUGINS) {
    // Tool presentation: a checklist instead of JSON, and a file edit as a diff with buttons to open VS Code's diff.
    await waitFor("the demo tool cards", () => evalWeb("d.querySelectorAll('.tool').length >= 2 && d.querySelectorAll('.patch-line').length > 0"), 20000);
    const cards = await evalWeb("({ todos: [...d.querySelectorAll('.todo')].map(x => x.className.replace('todo ', '') + ':' + x.querySelector('.todo-text').textContent), todoSummary: d.querySelector('.tool .tool-summary').textContent, edit: (() => { const p = [...d.querySelectorAll('.tool')].find(c => c.querySelector('.tool-summary')?.textContent === 'plan.txt'); return { summary: p.querySelector('.tool-summary').textContent, changed: p.querySelector('.patch-head .tool-changed')?.textContent, lines: [...p.querySelectorAll('.patch-line')].map(x => x.className.replace('patch-line ', '') + ':' + x.textContent), buttons: [...p.querySelectorAll('.patch-head button')].map(b => b.textContent) }; })() })");
    check("write_todos shows a checklist with done and in-progress items, not JSON", JSON.stringify(cards.todos) === JSON.stringify(["completed:Create plan.txt", "inProgress:Change line 2 to BETA"]) && cards.todoSummary === "2 tasks, 1 done", JSON.stringify({ todos: cards.todos, summary: cards.todoSummary }));
    check("edit_file shows the file relative to the workspace, the counts and the host's diff lines", cards.edit.summary === "plan.txt" && cards.edit.changed === "+1 \u22121" && JSON.stringify(cards.edit.lines) === JSON.stringify(["ctx: alpha", "del:-beta", "add:+BETA", "ctx: gamma"]), JSON.stringify(cards.edit));
    check("the diff card offers Open diff and Open file for a file inside the workspace", JSON.stringify(cards.edit.buttons) === JSON.stringify(["Open diff", "Open file"]), JSON.stringify(cards.edit.buttons));
    await shot("26-tool-cards");
    await evalWeb("(() => { const p = [...d.querySelectorAll('.tool')].find(c => c.querySelector('.tool-summary')?.textContent === 'plan.txt'); [...p.querySelectorAll('.patch-head button')].find(b => b.textContent === 'Open diff').click(); return true; })()");
    const diffTab = await waitFor("VS Code's diff editor", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before/.test(x.textContent)); return !!document.querySelector('.monaco-diff-editor') && tab ? tab.textContent.trim() : null; })()"), 20000);
    check("Open diff opens VS Code's diff editor on the file before and after the edit", /plan\.txt \(before/.test(diffTab), JSON.stringify(diffTab));
    await waitFor("the diff editor to paint its lines", () => evalPage("document.querySelectorAll('.monaco-diff-editor .editor.original .view-line').length > 1 && document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1"), 15000).catch(() => undefined);
    const sides = await evalPage("(() => ({ original: [...document.querySelectorAll('.monaco-diff-editor .editor.original .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')), modified: [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')) }))()");
    check("the before side was rebuilt from the patch (beta) and the after side is the file (BETA)", sides.original.some((l) => /beta/.test(l)) && !sides.original.some((l) => /BETA/.test(l)) && sides.modified.some((l) => /BETA/.test(l)), JSON.stringify(sides));
    await shot("27-diff-editor");
    await evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before/.test(x.textContent)); const close = tab?.querySelector('.codicon-close, .action-label.codicon'); close?.click(); return true; })()");

    // Every file changed in this chat: one row per file with the totals, and one diff from before the first edit.
    await waitFor("the Changes button", () => evalWeb("!d.getElementById('changesBtn').hidden && d.getElementById('changesBtn').textContent === 'Changes (3)'"), 15000);
    await evalWeb("(() => { d.getElementById('changesBtn').click(); return true; })()");
    const changes = await evalWeb("({ title: d.getElementById('extrasTitle').textContent, status: d.getElementById('extrasStatus').textContent, rows: [...d.querySelectorAll('#extrasList li')].map(li => li.querySelector('.session-title').textContent + ' | ' + li.querySelector('.session-meta').textContent) })");
    check("the Changes panel lists each changed file once, with its edits and totals", changes.title === "Changes in this chat" && /3 files changed in 4 edits/.test(changes.status) && changes.rows.some((r) => r === "plan.txt | 1 edit · +1 \u22121") && changes.rows.some((r) => r === "series.txt | 2 edits · +2 \u22121"), JSON.stringify(changes));
    await shot("34-changes-panel");
    await evalWeb("(() => { const li = [...d.querySelectorAll('#extrasList li')].find(x => /series.txt/.test(x.textContent)); [...li.querySelectorAll('button')].find(b => b.textContent === 'Open diff').click(); return true; })()");
    const seriesTab = await waitFor("the cumulative diff editor", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before this chat/.test(x.textContent)); return !!document.querySelector('.monaco-diff-editor') && tab ? tab.textContent.trim() : null; })()"), 20000);
    check("Open diff on a file edited twice compares it before the first edit with now", /series\.txt \(before this chat .* now, 2 edits\)/.test(seriesTab), JSON.stringify(seriesTab));
    await waitFor("the cumulative diff to paint", () => evalPage("document.querySelectorAll('.monaco-diff-editor .editor.original .view-line').length > 1 && document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1"), 15000).catch(() => undefined);
    const seriesSides = await evalPage("(() => ({ original: [...document.querySelectorAll('.monaco-diff-editor .editor.original .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')), modified: [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')) }))()");
    check("the before side holds the original lines (two, no four) and the after side the final ones (TWO, four)", seriesSides.original.some((l) => /two/.test(l)) && !seriesSides.original.some((l) => /four|TWO/.test(l)) && seriesSides.modified.some((l) => /TWO/.test(l)) && seriesSides.modified.some((l) => /four/.test(l)), JSON.stringify(seriesSides));
    await shot("35-cumulative-diff");
    await evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before this chat/.test(x.textContent)); const close = tab?.querySelector('.codicon-close, .action-label.codicon'); close?.click(); return true; })()");
    // A file the agent created and then deleted: the buttons must not fail silently.
    check("the Changes panel lists the deleted scratch file too", changes.rows.some((r) => r === "gone.txt | 1 edit \u00b7 +2 \u22120"), JSON.stringify(changes.rows));
    await evalWeb("(() => { const li = [...d.querySelectorAll('#extrasList li')].find(x => /gone.txt/.test(x.textContent)); [...li.querySelectorAll('button')].find(b => b.textContent === 'Open diff').click(); return true; })()");
    const goneTab = await waitFor("the diff of the deleted file", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /no longer exists/.test(x.textContent)); return !!document.querySelector('.monaco-diff-editor') && tab ? tab.textContent.trim() : null; })()"), 20000);
    check("Open diff on a file that no longer exists shows what the agent wrote and says the file is gone", /gone\.txt \(as the agent wrote it; the file no longer exists\)/.test(goneTab), JSON.stringify(goneTab));
    await waitFor("the deleted file's diff to paint", () => evalPage("document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1"), 15000).catch(() => undefined);
    const goneSides = await evalPage("(() => ({ modified: [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')) }))()");
    check("the written lines are shown", goneSides.modified.some((l) => /ghost line one/.test(l)) && goneSides.modified.some((l) => /ghost line two/.test(l)), JSON.stringify(goneSides));
    await evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /no longer exists/.test(x.textContent)); const close = tab?.querySelector('.codicon-close, .action-label.codicon'); close?.click(); return true; })()");
    await evalWeb("(() => { const li = [...d.querySelectorAll('#extrasList li')].find(x => /gone.txt/.test(x.textContent)); [...li.querySelectorAll('button')].find(b => b.textContent === 'Open file').click(); return true; })()");
    await waitFor("the visible explanation", () => evalPage("[...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notification-toast')].some(x => /gone\\.txt no longer exists/.test(x.textContent))"), 15000);
    check("Open file on a file that no longer exists explains it in an editor notification, not only in the hidden chat", true);
    await evalWeb("(() => { d.getElementById('extrasClose').click(); return true; })()");

    // A real answer streams token by token: the message is repainted on every token (its height briefly shrinks and
    // grows) and tool cards are rebuilt as they finish. The view must keep following through all of it.
    await evalWeb(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      w.postMessage({ type: 'event', event: { type: 'turnStarted', turnId: 'stream-1' } }, '*');
      w.postMessage({ type: 'event', event: { type: 'assistantStarted', itemId: 'stream-msg' } }, '*');
      for (let i = 0; i < 220; i++) {
        w.postMessage({ type: 'event', event: { type: 'assistantDelta', itemId: 'stream-msg', delta: 'word' + i + ' with **bold** and a long tail of words ' + (i % 9 === 0 ? '\\n\\n' : '') } }, '*');
        if (i % 25 === 0) {
          w.postMessage({ type: 'event', event: { type: 'toolCall', itemId: 'stream-tool-' + i, tool: 'powershell', summary: 'step ' + i, status: 'inProgress', held: false } }, '*');
          await sleep(15);
          w.postMessage({ type: 'event', event: { type: 'toolCall', itemId: 'stream-tool-' + i, tool: 'powershell', summary: 'step ' + i, status: 'completed', held: false, output: 'line one\\nline two\\nline three' } }, '*');
        }
        if (i % 30 === 0) {
          let pad = d.getElementById('e2e-pad');
          if (!pad) { pad = d.createElement('div'); pad.id = 'e2e-pad'; d.querySelector('footer').prepend(pad); }
          pad.style.height = pad.style.height === '70px' ? '0px' : '70px';
        }
        await sleep(8);
      }
      return true; })()`);
    const streamed = await evalWeb("(() => { const m = d.getElementById('messages'); return { gap: m.scrollHeight - m.scrollTop - m.clientHeight, jump: !d.getElementById('jumpBottom').hidden }; })()");
    check("while a message streams token by token and tool cards are rebuilt, the view keeps following (no jump button), even while the footer changes height", streamed.gap < 5 && !streamed.jump, JSON.stringify(streamed));
    await evalWeb("(() => { const p = d.getElementById('e2e-pad'); if (p) p.remove(); return true; })()");

    // Scrolling: the view follows growing output, stops when the user scrolls up, and offers a button back down.
    const postMsgs = (from, to) => evalWeb(`(() => { for (let i = ${from}; i < ${to}; i++) w.postMessage({ type: 'event', event: { type: 'assistantCompleted', itemId: 'scroll-' + i, text: 'Scroll line ' + i + '\\n\\nMore text so each message is a few lines tall, number ' + i + '.' } }, '*'); return true; })()`);
    const scrollState = () => evalWeb("(() => { const m = d.getElementById('messages'); return { gap: m.scrollHeight - m.scrollTop - m.clientHeight, top: m.scrollTop, tall: m.scrollHeight > m.clientHeight + 200, jump: !d.getElementById('jumpBottom').hidden }; })()");
    await postMsgs(0, 30);
    await sleep(700);
    const following = await scrollState();
    check("while following, new output keeps the latest message in view and there is no jump button", following.tall && following.gap < 5 && !following.jump, JSON.stringify(following));
    await evalWeb("(() => { const m = d.getElementById('messages'); m.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -200, bubbles: true })); m.scrollTop = 0; m.dispatchEvent(new w.Event('scroll')); return true; })()");
    await sleep(200);
    await postMsgs(30, 40);
    await sleep(700);
    const reading = await scrollState();
    check("after the user scrolls up, new output does not move the view, and the jump-to-latest button appears", reading.top < 30 && reading.jump, JSON.stringify(reading));
    await shot("36-jump-to-latest");
    await evalWeb("(() => { d.getElementById('jumpBottom').click(); return true; })()");
    await sleep(500);
    const back = await scrollState();
    check("the button returns to the latest message, hides, and following resumes", back.gap < 5 && !back.jump, JSON.stringify(back));
    await postMsgs(40, 43);
    await sleep(500);
    check("following resumed: output after the jump stays in view", (await scrollState()).gap < 5);

    // The copy button: none on an assistant message in the middle of work, one under the last message once the turn ends.
    const copyState = await evalWeb("({ assistantHeadCopies: d.querySelectorAll('.msg.assistant .msg-head .copy').length, foot: d.querySelectorAll('.msg.assistant .msg-foot .copy').length })");
    check("an assistant message has no copy button in its header, and none under it while no turn has finished", copyState.assistantHeadCopies === 0 && copyState.foot === 0, JSON.stringify(copyState));
    await evalWeb("(() => { w.postMessage({ type: 'event', event: { type: 'turnStarted', turnId: 'tt1' } }, '*'); w.postMessage({ type: 'event', event: { type: 'assistantCompleted', itemId: 'final-answer', text: 'The final answer.' } }, '*'); w.postMessage({ type: 'event', event: { type: 'turnCompleted', turnId: 'tt1', terminal: 'completed', durationMs: 1000 } }, '*'); return true; })()");
    await waitFor("the copy button under the final answer", () => evalWeb("!!d.querySelector('.msg-foot .copy')"), 10000);
    const finalCopy = await evalWeb("({ foot: d.querySelectorAll('.msg.assistant .msg-foot .copy').length, onLast: [...d.querySelectorAll('.msg.assistant')].pop().querySelector('.msg-foot .copy') !== null })");
    check("when the turn ends, one copy button appears under its last message", finalCopy.foot === 1 && finalCopy.onLast, JSON.stringify(finalCopy));

    // Browser and Computer Use approvals: a synthetic request through the real page and CSP. The window title is
    // hostile on purpose (markup in the page's own words must stay text), and the host is not plain ASCII.
    await evalWeb(`(() => { w.postMessage({ type: 'event', event: { type: 'approvalRequested', approvalId: 'cua-1', itemId: 'i-cua', toolName: 'browser_click',
      subject: { kind: 'tool', summary: 'browser_click', detail: ['selector: #pay', 'text: hello'], generic: false },
      choices: [{ choiceId: 'once', label: 'Allow once', decision: 'approved', scope: 'once' }, { choiceId: 'no', label: 'Reject', decision: 'abort', scope: 'once' }],
      requirementId: { approvalId: 'cua-1', sourceIndex: 0 }, protectedWrite: false, judgeEscalated: false,
      cua: { page: { host: 'b\\u00fccher.example', hostAscii: 'xn--bcher-kva.example', idn: true }, windowTitle: 'Checkout <img src=x onerror=window.__pwned=1>',
        steps: ['Step 1: click button "Pay now" \\u2014 may place an order', 'Step 2: press key "Ctrl+Enter" \\u2014 may submit the form'], data: ['a GitHub token: ghp_\\u20263f9a'] } } }, '*'); return true; })()`);
    await waitFor("the browser approval card", () => evalWeb("!!d.querySelector('.approval .cua')"), 10000);
    const cua = await evalWeb("({ flags: [...d.querySelectorAll('.approval .approval-flag')].map(x => x.textContent.slice(0, 90)), rows: [...d.querySelectorAll('.cua-row')].map(x => x.textContent), steps: [...d.querySelectorAll('.cua-steps li')].map(x => x.textContent), data: [...d.querySelectorAll('.cua-data li')].map(x => x.textContent), detail: [...d.querySelectorAll('.approval-detail li')].map(x => x.textContent), injected: !!d.querySelector('.cua img') || !!w.__pwned, buttons: [...d.querySelectorAll('.approval button.choice .choice-label')].map(x => x.textContent) })");
    check("a browser approval shows the page, the window title as plain text, every step and the masked data", /Page: b\u00fccher\.example/.test(cua.rows[0]) && /Checkout <img src=x onerror/.test(cua.rows[1]) && cua.steps.length === 2 && /Pay now/.test(cua.steps[0]) && /may place an order/.test(cua.steps[0]) && cua.data[0] === "a GitHub token: ghp_\u20263f9a", JSON.stringify(cua));
    check("a non-ASCII host is called out with its plain form, and hostile markup in the title stays text", cua.flags.some((f) => /xn--bcher-kva\.example/.test(f)) && cua.injected === false, JSON.stringify({ flags: cua.flags, injected: cua.injected }));
    check("the tool arguments read as name: value lines and the host's own choices are offered", cua.detail.join("|") === "selector: #pay|text: hello" && cua.buttons.includes("Allow once") && cua.buttons.includes("Reject"), JSON.stringify({ detail: cua.detail, buttons: cua.buttons }));
    await shot("32-browser-approval");

    // Images from the workspace: the page asks, the extension reads the file with its checks. One valid file, one
    // outside the workspace and one web address in an assistant message, plus a read_file of an image.
    await evalWeb(`(() => {
      w.postMessage({ type: 'event', event: { type: 'assistantCompleted', itemId: 'a-img', text: 'Here it is: ![the shot](shot.png) and ![secret](../outside.png) and ![web](https://example.com/x.png) done.' } }, '*');
      w.postMessage({ type: 'event', event: { type: 'toolCall', itemId: 'tc-img', tool: 'read_file', summary: 'shot.png', status: 'completed', held: false, imagePath: 'shot.png' } }, '*');
      return true; })()`);
    await waitFor("the images to resolve", () => evalWeb("d.querySelectorAll('.inline-img').length >= 2 && d.querySelectorAll('.img-denied').length >= 2"), 15000);
    const imgs = await evalWeb("({ shown: [...d.querySelectorAll('.inline-img')].map(i => ({ w: i.naturalWidth, src: i.src.slice(0, 22), alt: i.alt })), denied: [...d.querySelectorAll('.img-denied')].map(x => x.textContent), remote: [...d.querySelectorAll('img')].filter(i => /example.com/.test(i.src)).length, inTool: !!d.querySelector('.tool-image .inline-img') })");
    check("a workspace image in an assistant message and a read_file of an image are shown from the file", imgs.shown.length === 2 && imgs.shown.every((i) => i.w === 1 && i.src === "data:image/png;base64,") && imgs.inTool, JSON.stringify(imgs));
    check("an image outside the workspace and a web address are not shown, each with its reason, and nothing is fetched", imgs.denied.some((x) => /secret.*outside this chat's folders/.test(x)) && imgs.denied.some((x) => /web.*never addresses/.test(x)) && imgs.remote === 0, JSON.stringify(imgs.denied));
    await shot("33-workspace-images");
    await evalWeb("(() => { w.postMessage({ type: 'reset' }, '*'); return true; })()");
  }

  if (PLUGINS) {
    const settingsFile = join(workspace, ".vscode", "settings.json");
    const setPicks = async (paths) => {
      writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, "utf8")), "antares.dev.picks": paths }, null, 2));
      await sleep(2500);
    };
    const makePlugin = (root, name) => {
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      mkdirSync(join(root, "skills", "hello"), { recursive: true });
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "0.0.1", description: "A harmless demo bundle that only brings a skill." }));
      writeFileSync(join(root, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello. Demo only.\n---\nSay hello.\n");
    };
    const folderPlugin = join(work, "plugin-folder");
    makePlugin(folderPlugin, "antares-folder-demo");
    const market = join(work, "market");
    makePlugin(join(market, "plugins", "antares-market-demo"), "antares-market-demo");
    mkdirSync(join(market, ".claude-plugin"), { recursive: true });
    writeFileSync(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "demo-market", owner: { name: "Antares e2e" }, plugins: [{ name: "antares-market-demo", source: "./plugins/antares-market-demo", description: "Demo." }] }));
    const emptyDir = join(work, "not-a-plugin");
    mkdirSync(emptyDir, { recursive: true });

    const dialogNow = () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return b ? { text: b.textContent.slice(0, 900), buttons: [...b.querySelectorAll('.dialog-buttons .monaco-button')].map(x => x.textContent.trim()) } : null; })()");
    const clickDialog = (label) => evalPage("(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === " + JSON.stringify(label) + "); btn.click(); return true; })()");
    const notices = () => evalWeb("[...d.querySelectorAll('.notice')].map(n => n.textContent.slice(0, 200))");
    const act = (label) => evalWeb("(() => { [...d.querySelectorAll('#extrasActions button')].find(b => b.textContent === " + JSON.stringify(label) + ").click(); return true; })()");

    await evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=plugins]').click(); return true; })()");
    await waitFor("the plugin list", () => evalWeb("!d.getElementById('extrasPanel').hidden && d.getElementById('extrasStatus').textContent !== 'Reading from Muse…'"), 60000);
    const buttons = await evalWeb("[...d.querySelectorAll('#extrasActions button')].map(b => b.textContent)");
    check("the plugin list offers install from a folder, install from a marketplace, the marketplaces view and add marketplace", JSON.stringify(buttons) === JSON.stringify(["Install from folder\u2026", "Install from marketplace\u2026", "Marketplaces\u2026", "Add marketplace\u2026"]), JSON.stringify(buttons));

    // An empty folder is refused by Muse's own validation, with the reason.
    await setPicks([emptyDir]);
    await act("Install from folder\u2026");
    await waitFor("the refusal", async () => (await notices()).some((n) => /not an installable plugin/.test(n)), 60000);
    check("a folder that is not a plugin is refused with Muse's reason, no dialog", (await notices()).some((n) => /not an installable plugin: error: plugin root must contain/.test(n)) && (await dialogNow()) === null, JSON.stringify(await notices()));

    // A valid folder: the dialog says what it brings and warns about code; cancelling installs nothing.
    await setPicks([folderPlugin]);
    await act("Install from folder\u2026");
    const ask = await waitFor("the install dialog", dialogNow, 60000);
    check("the install dialog names the plugin, what it brings, the source and the code warning", /Install plugin antares-folder-demo 0\.0\.1\?/.test(ask.text) && /Brings: 1 skill\./.test(ask.text) && /plugin-folder/.test(ask.text) && /never approves what a plugin brings/.test(ask.text) && ask.buttons.includes("Install"), JSON.stringify(ask));
    await shot("30-plugin-install-dialog");
    await clickDialog("Cancel");
    await sleep(800);
    check("cancelling installs nothing", !(await notices()).some((n) => /Installed antares-folder-demo/.test(n)));
    await act("Install from folder\u2026");
    await waitFor("the dialog again", dialogNow, 60000);
    await clickDialog("Install");
    await waitFor("the install result", async () => (await notices()).some((n) => /Installed antares-folder-demo 0\.0\.1/.test(n)), 90000);
    await waitFor("the list to show it", () => evalWeb("[...d.querySelectorAll('#extrasList .session-title')].some(x => x.textContent === 'antares-folder-demo')"), 30000);
    check("confirming installs the plugin and the list shows it", true);

    // A marketplace: adding it installs nothing; then a plugin from it is installed after its own dialog.
    await setPicks(["demo-market", market]);
    await act("Add marketplace\u2026");
    const addAsk = await waitFor("the marketplace dialog", dialogNow, 30000);
    check("adding a marketplace says it installs nothing by itself", /Add marketplace demo-market\?/.test(addAsk.text) && /installs no plugin by itself/.test(addAsk.text), JSON.stringify(addAsk.text.slice(0, 200)));
    await clickDialog("Add marketplace");
    await waitFor("the marketplace result", async () => (await notices()).some((n) => /Added marketplace demo-market: 1 plugin offered\. Nothing was installed\./.test(n)), 90000);
    check("the marketplace was added and nothing was installed", true);

    await setPicks(["antares-market-demo@demo-market"]);
    await act("Install from marketplace\u2026");
    const mAsk = await waitFor("the marketplace install dialog", dialogNow, 60000);
    check("a marketplace plugin's dialog names where it comes from and admits it cannot look inside", /Install plugin antares-market-demo 0\.0\.1 from demo-market\?/.test(mAsk.text) && /cannot look inside a marketplace plugin/.test(mAsk.text), JSON.stringify(mAsk.text.slice(0, 260)));
    await clickDialog("Install");
    await waitFor("the marketplace install result", async () => (await notices()).some((n) => /Installed antares-market-demo 0\.0\.1/.test(n)), 90000);
    check("the marketplace plugin was installed", true);
    await waitFor("both plugins in the list", () => evalWeb("[...d.querySelectorAll('#extrasList .session-title')].length === 2"), 30000);
    await shot("31-plugins-installed");
  } else if (IMPORT) {
    const dialogNow = () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return b ? { text: b.textContent.slice(0, 600), buttons: [...b.querySelectorAll('.dialog-buttons .monaco-button')].map(x => x.textContent.trim()) } : null; })()");
    const clickDialog = (label) => evalPage("(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === " + JSON.stringify(label) + "); btn.click(); return true; })()");
    const startImport = () => evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=importSkills]').click(); return true; })()");
    const notices = () => evalWeb("[...d.querySelectorAll('.notice')].map(n => n.textContent.slice(0, 160))");

    await evalWeb("(() => { d.getElementById('plus').click(); return true; })()");
    const items = await evalWeb("[...d.querySelectorAll('#plusMenu .menu-item span:first-child')].map(s => s.textContent)");
    check("the + menu offers Import skills", items.includes("Import skills\u2026"), JSON.stringify(items));
    await evalWeb("(() => { d.getElementById('plus').click(); return true; })()");

    await startImport();
    const ask = await waitFor("the import confirmation", dialogNow, 60000);
    check("the preview comes first: the dialog names the skill and says nothing has been changed yet", /Import 1 skill from Claude/.test(ask.text) && /demo-import/.test(ask.text) && /Nothing has been changed yet/.test(ask.text) && /read what you import/.test(ask.text) && ask.buttons.includes("Import"), JSON.stringify(ask));
    await shot("28-import-confirm");
    await clickDialog("Cancel");
    await sleep(800);
    check("cancelling the dialog imports nothing", !(await notices()).some((n) => /Imported/.test(n)), JSON.stringify(await notices()));

    await startImport();
    await waitFor("the import confirmation again", dialogNow, 60000);
    await clickDialog("Import");
    await waitFor("the import result", async () => (await notices()).some((n) => /Imported 1 skill from Claude/.test(n)), 60000);
    check("confirming imports the skill and reports it", (await notices()).some((n) => /Imported 1 skill from Claude/.test(n)), JSON.stringify(await notices()));

    await startImport();
    await waitFor("the nothing-left notice", async () => (await notices()).some((n) => /Nothing new to import from Claude/.test(n)), 60000);
    check("running it again finds nothing new (already imported)", (await notices()).some((n) => /Nothing new to import from Claude \(1 already imported\)/.test(n)), JSON.stringify(await notices()));

    await evalWeb("(() => { const i = d.getElementById('input'); i.focus(); i.value = '/demo'; i.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()");
    await waitFor("the slash palette", () => evalWeb("[...d.querySelectorAll('#slashMenu .slash-name')].some(n => n.textContent === '/demo-import')"), 30000);
    check("the imported skill is in the slash palette", true);
    await shot("29-import-done");
  } else if (MODES) {
    const openMenu = () => evalWeb("(() => { d.getElementById('modeBtn').click(); return true; })()");
    const pick = (id) => evalWeb("(() => { d.querySelector('#modeMenu [data-mode=" + id + "]').click(); return true; })()");
    const modeState = () => evalWeb("({ label: d.getElementById('modeLabel').textContent, footer: d.getElementById('meta').textContent.slice(0, 60), notices: [...d.querySelectorAll('.notice')].map(n => n.textContent.slice(0, 130)), errors: d.querySelectorAll('.notice.error').length, planNote: !d.getElementById('modeNote').hidden })");
    const dialogNow = () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return b ? { text: b.textContent.slice(0, 420), buttons: [...b.querySelectorAll('.dialog-buttons .monaco-button')].map(x => x.textContent.trim()) } : null; })()");
    const clickDialog = (label) => evalPage("(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === " + JSON.stringify(label) + "); btn.click(); return true; })()");
    const slashOpen = () => evalWeb("(() => { const i = d.getElementById('input'); i.focus(); i.value = '/'; i.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()");
    const slashClear = () => evalWeb("(() => { const i = d.getElementById('input'); i.value = ''; i.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()");
    const slashAnswered = "d.querySelectorAll('#slashMenu .slash-item').length > 0 || /Could not/.test(d.getElementById('slashMenu').textContent)";

    const start = await modeState();
    check("Plan mode shows its note and the button that carries the plan out", start.label === "Plan" && start.planNote, JSON.stringify(start));
    await openMenu();
    await shot("22-mode-menu");
    await pick("manual");
    await sleep(500);
    const manual = await modeState();
    check("Manual is refused with the observed reason and the mode does not change", manual.label === "Plan" && manual.notices.some((n) => /Manual mode is not available/.test(n)), JSON.stringify(manual.notices));

    // A session must exist to be continued: opening the slash palette starts one (no model call).
    await slashOpen();
    await waitFor("the session to start (the skill list)", () => evalWeb(slashAnswered), 60000);
    const opened = await evalWeb("({ items: d.querySelectorAll('#slashMenu .slash-item').length, text: d.getElementById('slashMenu').textContent.slice(0, 100) })");
    check("a real session is open (the host answered the skill list)", opened.items > 0, JSON.stringify(opened));
    await slashClear();

    // Plan -> Accept edits: asks first, then the same session is resumed under :ask-me.
    await openMenu();
    await pick("acceptEdits");
    const ask = await waitFor("the mode confirmation", dialogNow, 15000);
    check("switching to Accept edits asks first and says the conversation continues", /Accept edits/.test(ask.text) && /ask-me/.test(ask.text) && /continues/.test(ask.text) && ask.buttons.includes("Switch mode"), JSON.stringify(ask));
    await shot("23-mode-confirm");
    await clickDialog("Switch mode");
    await waitFor("the switch to finish", () => evalWeb("d.getElementById('modeLabel').textContent === 'Accept edits' && [...d.querySelectorAll('.notice')].some(n => /Switched to Accept edits/.test(n.textContent))"), 60000);
    const accepted = await modeState();
    check("the session continued under :ask-me (label, footer and notice agree, no error)", accepted.label === "Accept edits" && /:ask-me/.test(accepted.footer) && accepted.errors === 0 && !accepted.planNote, JSON.stringify(accepted));
    await shot("24-accept-edits");
    // The sandbox note follows what the host reported: shown in a mode that runs commands in the sandbox only
    // when the host says it cannot enforce one (this depends on the machine, so the check compares the two).
    await waitFor("the host's sandbox report", () => evalWeb("/sandbox (un)?available/.test(d.getElementById('meta').textContent)"), 30000);
    const sb = await evalWeb("({ shown: !d.getElementById('sandboxNote').hidden, text: d.getElementById('sandboxNote').textContent.slice(0, 140), bypass: !!d.querySelector('#sandboxNote button'), unavailable: /sandbox unavailable/.test(d.getElementById('meta').textContent) })");
    check("the sandbox note appears in Accept edits exactly when the host reports no sandbox", sb.shown === sb.unavailable && (!sb.shown || (/fail before they start/.test(sb.text) && sb.bypass)), JSON.stringify(sb));

    // The resumed session works: its skill list answers again.
    await slashOpen();
    await waitFor("the resumed session to answer", () => evalWeb(slashAnswered), 60000);
    const resumed = await evalWeb("d.querySelectorAll('#slashMenu .slash-item').length");
    check("the resumed session answers requests", resumed > 0, String(resumed));
    await slashClear();

    // Shift+Tab: Accept edits -> Plan (stepping down needs no confirmation).
    await evalWeb("(() => { const i = d.getElementById('input'); i.focus(); i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); return true; })()");
    await waitFor("Shift+Tab to reach Plan", () => evalWeb("d.getElementById('modeLabel').textContent === 'Plan' && [...d.querySelectorAll('.notice')].some(n => /Switched to Plan/.test(n.textContent))"), 60000);
    const back = await modeState();
    const planSb = await evalWeb("!d.getElementById('sandboxNote').hidden");
    check("the sandbox note is not shown in Plan (nothing runs there)", planSb === false);
    check("Shift+Tab steps from Accept edits to Plan with no dialog, and the footer follows", back.label === "Plan" && /:read-only/.test(back.footer) && back.errors === 0, JSON.stringify(back));

    // Bypass has to be chosen on purpose and says what it removes; cancelling leaves the mode alone.
    await openMenu();
    await pick("bypass");
    const strong = await waitFor("the bypass confirmation", dialogNow, 15000);
    check("Bypass permissions warns that there is no sandbox and no prompts", /No filesystem sandbox/.test(strong.text) && /no approval prompts/.test(strong.text), JSON.stringify(strong.text.slice(0, 160)));
    await shot("25-bypass-confirm");
    await clickDialog("Cancel");
    await sleep(800);
    const cancelled = await modeState();
    check("cancelling the Bypass dialog leaves the mode as it was", cancelled.label === "Plan", JSON.stringify(cancelled));
  } else if (REAL) {
    // REAL mode: the user's own Muse login and config, a real model turn, a REAL approval request.
    // Safety policy, enforced here and not by the page: the only thing ever allowed is a one-time fetch of
    // example.com (a public page); every other approval is rejected.
    const decision = process.env.E2E_DECISION === "reject" ? "reject" : "allow";
    const prompt = "Use your web fetch tool to retrieve https://example.com and tell me the page title in one short sentence.";
    await evalWeb(`(() => { const i = d.getElementById('input'); i.value = ${JSON.stringify(prompt)}; i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    const seen = [];
    let sawWaiting = false;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const state = await evalWeb(`(() => {
        const c = d.querySelector('.approval.pending');
        const idle = d.getElementById('stop').hidden && d.querySelectorAll('.msg.assistant').length > 0;
        return { idle, status: d.getElementById('meta').textContent.slice(0, 60), card: c ? { kind: c.querySelector('.badge').textContent, subject: c.querySelector('.approval-subject').textContent, choices: [...c.querySelectorAll('button.choice')].map(b => b.querySelector('.choice-label').textContent), previews: [...c.querySelectorAll('.rule-preview')].map(x => x.textContent), flags: [...c.querySelectorAll('.approval-flag')].map(x => x.textContent), feedback: !!c.querySelector('.approval-feedback') } : null };
      })()`);
      if (state.card) {
        if (/Waiting for your approval/.test(state.status)) sawWaiting = true;
        const allowThis = decision === "allow" && state.card.kind === "network" && state.card.subject === "example.com:443 (https)";
        const label = allowThis ? "Allow once" : "Reject";
        await shot(`12-real-approval-card-${seen.length + 1}`);
        seen.push({ ...state.card, clicked: label });
        if (label === "Reject" && state.card.feedback) await evalWeb(`(() => { const f = d.querySelector('.approval.pending .approval-feedback'); f.value = 'Not now, thanks.'; f.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()`);
        await evalWeb(`(() => { const b = [...d.querySelectorAll('.approval.pending button.choice')].find(x => x.querySelector('.choice-label').textContent === ${JSON.stringify(label)}); b.click(); return true; })()`);
        await sleep(1200);
        continue;
      }
      if (state.idle) break;
      await sleep(400);
    }
    await sleep(800);
    await shot("13-real-approval-done");
    const end = await evalWeb(`({
      pending: d.querySelectorAll('.approval.pending').length,
      resolved: [...d.querySelectorAll('.approval.resolved')].map(c => c.className.replace('approval ', '') + ' | ' + c.querySelector('.approval-outcome')?.textContent),
      tools: [...d.querySelectorAll('.tool')].map(t => t.className.replace('tool ', '') + ' | ' + t.querySelector('.tool-name')?.textContent),
      assistant: [...d.querySelectorAll('.msg.assistant .body')].map(b => b.textContent.slice(0, 100)),
      idle: d.getElementById('stop').hidden
    })`);
    console.log("REAL:", JSON.stringify({ seen, end }));
    const first = seen[0];
    check("a real approval request appears as a card in the real webview", !!first && first.kind === "network" && first.subject === "example.com:443 (https)", JSON.stringify(first && { kind: first.kind, subject: first.subject }));
    check("the card offers the host's own choices (Allow once / session / always / Reject)", !!first && ["Allow once", "Allow for this session", "Always allow this network destination", "Reject"].every((l) => first.choices.includes(l)), JSON.stringify(first?.choices));
    check("session and persistent choices show what they would allow", !!first && first.previews.length === 2 && first.previews.every((p) => p === "example.com:443 (https)"), JSON.stringify(first?.previews));
    check("the footer says it is waiting for the approval", sawWaiting);
    check("every decision was made by an explicit click; no approval is left pending", end.pending === 0 && end.idle, JSON.stringify({ pending: end.pending, idle: end.idle }));
    if (decision === "allow") {
      check("allowed once: the card resolves as Allowed and the fetch completes", end.resolved.some((r) => /allowed/.test(r) && /approved/.test(r)) && end.tools.some((t) => /^done \| web_fetch/.test(t)), JSON.stringify({ resolved: end.resolved, tools: end.tools }));
      check("the model answered from the fetched page", end.assistant.some((a) => /Example Domain/i.test(a)), JSON.stringify(end.assistant));
    } else {
      check("rejected: the card resolves as Denied and the fetch fails", end.resolved.length > 0 && end.resolved.every((r) => /denied/.test(r)) && !end.tools.some((t) => /^done \| web_fetch/.test(t)), JSON.stringify({ resolved: end.resolved, tools: end.tools }));
    }
    check("approvals other than example.com were rejected, never allowed", seen.filter((s) => s.clicked === "Allow once").every((s) => s.subject === "example.com:443 (https)"), JSON.stringify(seen.map((s) => [s.kind, s.subject.slice(0, 50), s.clicked])));
  } else {
  // Send a message through the real UI path and watch the reply stream in.
  await evalWeb(`(() => { const i = d.getElementById('input'); i.value = 'hello from the real editor'; i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await waitFor("the reply", () => evalWeb("d.querySelectorAll('.msg.assistant').length > 0 && d.getElementById('stop').hidden"), 30000);
  await sleep(600);
  const chat = await evalWeb(`({ user: d.querySelector('.msg.user .body')?.textContent, assistant: d.querySelector('.msg.assistant .body')?.textContent, copyButtons: d.querySelectorAll('button.copy').length, status: d.getElementById('meta').textContent.slice(0, 60) })`);
  console.log("CHAT:", JSON.stringify(chat));
  check("a message round-trips through the real webview and host", chat.user === "hello from the real editor" && /echo: hello from the real editor/.test(chat.assistant ?? ""));
  check("copy buttons are present on both messages", chat.copyButtons === 2);
  await shot("04-chat");

  // Copy button reaches the real system clipboard through the extension host.
  await evalWeb(`(() => { d.querySelector('.msg.assistant .copy').click(); return true; })()`);
  await sleep(700);
  const copied = await evalWeb(`d.querySelector('.msg.assistant .copy').className + '|' + d.querySelector('.msg.assistant .copy .label').textContent`);
  check("copy button confirms ('Copied') after the extension host wrote the clipboard", /done/.test(copied) && /Copied/.test(copied), copied);

  // Microphone: informational (it depends on the machine and the editor's permission policy). Records
  // what a webview can do today, which decides how voice input must be built.
  const mic = await evalWeb(`(async () => {
    const md = w.navigator.mediaDevices;
    const out = { hasMediaDevices: !!md, hasGetUserMedia: !!(md && md.getUserMedia), secure: w.isSecureContext, hasMediaRecorder: typeof w.MediaRecorder === 'function', hasAudioContext: typeof w.AudioContext === 'function', hasWorklet: typeof w.AudioWorkletNode === 'function' };
    try { out.devices = md ? (await md.enumerateDevices()).filter(x => x.kind === 'audioinput').length : null; } catch (e) { out.devices = 'error ' + e.name; }
    try { const s = await md.getUserMedia({ audio: true }); out.getUserMedia = 'granted'; s.getTracks().forEach(t => t.stop()); } catch (e) { out.getUserMedia = e.name + ': ' + String(e.message).slice(0, 80); }
    try { out.permissionState = (await w.navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { out.permissionState = 'n/a ' + e.name; }
    out.iframeAllow = (document.querySelector('iframe')?.getAttribute('allow')) ?? null;
    return out;
  })()`).catch((e) => ({ error: e.message }));
  console.log(`MIC[${label}]:`, JSON.stringify(mic));

  // Voice dictation through the real extension host. The page cannot use the microphone, so the host records.
  const micState = () => evalWeb("({ recording: d.getElementById('mic').classList.contains('recording'), busy: d.getElementById('mic').classList.contains('busy'), status: d.getElementById('voiceStatus').hidden ? '' : d.getElementById('voiceStatus').textContent, input: d.getElementById('input').value, notices: [...d.querySelectorAll('.notice')].map(n => n.textContent), setupButton: !!d.querySelector('.notice .link') })");
  const clickMic = () => evalWeb("(() => { d.getElementById('mic').click(); return true; })()");
  if (VOICE === "fake") {
    await clickMic();
    await waitFor("the recording state", async () => (await micState()).recording, 10000);
    const rec = await micState();
    check("the microphone button shows a recording state with a timer", /Recording 0:0\d/.test(rec.status), rec.status);
    await shot("14-voice-recording");
    await sleep(700);
    await clickMic();
    await waitFor("the dictated text", async () => (await micState()).input.includes("texto ditado de teste"), 15000);
    const done = await micState();
    check("the dictated text lands in the box for review (it is not sent)", done.input.trim() === "texto ditado de teste" && !done.recording && !done.busy, JSON.stringify({ input: done.input, recording: done.recording }));
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = ''; return true; })()");
  } else if (VOICE === "error") {
    await clickMic();
    await waitFor("the voice notice", async () => (await micState()).notices.some((n) => /voice|engine/i.test(n)), 15000);
    const err = await micState();
    check("with no engine set up, a clear message with a setup button appears and nothing is recorded", err.setupButton && !err.recording && err.notices.some((n) => /faster-whisper/.test(n)), JSON.stringify(err.notices.filter((n) => /voice|engine/i.test(n)).map((n) => n.slice(0, 110))));
    await shot("14-voice-needs-setup");
  } else if (VOICE === "real") {
    await clickMic();
    await waitFor("the real recording state", async () => (await micState()).recording, 30000);
    await shot("14-voice-real-recording");
    await sleep(2500);
    await clickMic();
    await waitFor("the transcription to finish", async () => { const m = await micState(); return !m.recording && !m.busy; }, 120000);
    const real = await micState();
    const speech = real.input.trim().length;
    const errs = real.notices.filter((n) => /speech|transcri|record|engine|voice/i.test(n));
    console.log("VOICE-REAL:", JSON.stringify({ insertedChars: speech, notices: errs.map((n) => n.slice(0, 120)) }));
    check("the real microphone and local Whisper ran inside the editor; the result is text or 'no speech', never a crash", speech > 0 || errs.some((n) => /No speech was recognized/.test(n)), JSON.stringify({ insertedChars: speech, notices: errs.length }));
    check("no engine or recorder error was shown", !errs.some((n) => /failed|could not|Python|Traceback|stopped/i.test(n)), JSON.stringify(errs.map((n) => n.slice(0, 100))));
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = ''; return true; })()");
  }

  // Model/profile/history UI.
  await evalWeb(`(() => { d.getElementById('historyBtn').click(); return true; })()`);
  await sleep(1500);
  await shot("05-history");
  const hist = await evalWeb(`({ open: !d.getElementById('historyPanel').hidden, status: d.getElementById('historyStatus').textContent })`);
  console.log("HISTORY:", JSON.stringify(hist));
  check("history panel opens and answers (rows or a readable message)", hist.open && hist.status.length > 0 && hist.status !== "Loading…");
  await evalWeb(`(() => { d.getElementById('historyClose').click(); return true; })()`);

  // Real keyboard: focus the textarea and type with real key events (Enter sends, Shift+Enter does not).
  await evalWeb(`(() => { d.getElementById('input').focus(); return true; })()`);
  await browser.send("Input.insertText", { text: "typed with real keys" }, webSession).catch(() => browser.send("Input.insertText", { text: "typed with real keys" }, pageSession));
  await sleep(300);
  let typed = await evalWeb("d.getElementById('input').value");
  if (typed !== "typed with real keys") {
    // Routing to the webview's focused element differs between editors; fall back to the page session.
    await browser.send("Input.insertText", { text: "typed with real keys" }, pageSession);
    await sleep(300);
    typed = await evalWeb("d.getElementById('input').value");
  }
  check("real typed text reaches the webview textarea", typed.includes("typed with real keys"), JSON.stringify(typed));
  await key("rawKeyDown", "Enter", { windowsVirtualKeyCode: 13, text: "\r", modifiers: 8 }); // Shift+Enter: newline, no send
  await key("keyUp", "Enter", { windowsVirtualKeyCode: 13, modifiers: 8 });
  await sleep(300);
  const afterShift = await evalWeb("({ users: d.querySelectorAll('.msg.user').length, value: d.getElementById('input').value })");
  check("Shift+Enter does not send", afterShift.users === 1, JSON.stringify(afterShift));
  await key("rawKeyDown", "Enter", { windowsVirtualKeyCode: 13, text: "\r" });
  await key("keyUp", "Enter", { windowsVirtualKeyCode: 13 });
  await waitFor("the second reply", () => evalWeb("d.querySelectorAll('.msg.assistant').length >= 2 && d.getElementById('stop').hidden"), 20000).catch(() => undefined);
  const afterEnter = await evalWeb("({ users: d.querySelectorAll('.msg.user').length, last: [...d.querySelectorAll('.msg.user')].pop()?.querySelector('.body').textContent })");
  check("Enter sends the typed message", afterEnter.users === 2, JSON.stringify(afterEnter));

  // Model catalog (B1): the refresh button asks the host again (no model call), and a failed refresh is flagged on the
  // page without hiding the models already listed.
  const modelsBefore = await evalWeb("d.getElementById('model').options.length");
  await evalWeb("(() => { d.getElementById('refreshModels').click(); return true; })()");
  await sleep(1500);
  const modelsAfter = await evalWeb("({ n: d.getElementById('model').options.length, stale: !d.getElementById('modelsStale').hidden, title: d.getElementById('refreshModels').title })");
  check("the refresh button re-reads the catalog and keeps the models", modelsAfter.n === modelsBefore && modelsAfter.n > 0 && !modelsAfter.stale, JSON.stringify({ modelsBefore, ...modelsAfter }));
  await evalWeb("(() => { w.postMessage({ type: 'event', event: { type: 'modelsStatus', stale: true, error: 'catalog backend unavailable', fetchedAtMs: Date.now() } }, '*'); return true; })()");
  const flagged = await evalWeb("({ n: d.getElementById('model').options.length, text: d.getElementById('modelsStale').textContent, hidden: d.getElementById('modelsStale').hidden, title: d.getElementById('modelsStale').title })");
  check("a failed refresh is flagged and the models stay listed", !flagged.hidden && /out of date/.test(flagged.text) && /backend unavailable/.test(flagged.title) && flagged.n === modelsBefore, JSON.stringify(flagged));
  await evalWeb("(() => { w.postMessage({ type: 'event', event: { type: 'modelsStatus', stale: false, fetchedAtMs: Date.now(), source: 'providerCatalog' } }, '*'); return true; })()");
  check("a good refresh clears the flag", await evalWeb("d.getElementById('modelsStale').hidden"));

  // Standard / Contributor (B2): a read-only indicator. The page shows the host's reading as it is, and "not confirmed" is
  // never drawn as Standard.
  const modeReal = await evalWeb("({ text: d.getElementById('modeInfo').textContent, mode: d.getElementById('modeInfo').dataset.mode || '' })");
  check("the usage-mode indicator shows a reading from the real host", /^(Contributor|Standard|Mode: not confirmed)$/.test(modeReal.text), JSON.stringify(modeReal));
  for (const [state, expectText, expectMode] of [
    [{ mode: 'contributor', confirmed: true, label: 'Contributor', detail: 'Saved.', privacy: 'p' }, 'Contributor', 'contributor'],
    [{ mode: 'standard', confirmed: true, label: 'Standard', detail: 'Saved.', privacy: 'p' }, 'Standard', 'standard'],
    [{ mode: 'unconfirmed', confirmed: false, label: 'Mode: not confirmed', detail: 'Override may apply.', privacy: 'p' }, 'Mode: not confirmed', 'unconfirmed'],
  ]) {
    await evalWeb(`(() => { w.postMessage({ type: 'contributor', state: ${JSON.stringify(state)} }, '*'); return true; })()`);
    const shown = await evalWeb("({ text: d.getElementById('modeInfo').textContent, mode: d.getElementById('modeInfo').dataset.mode, title: d.getElementById('modeInfo').title })");
    check("usage mode " + expectMode + " is drawn as such", shown.text === expectText && shown.mode === expectMode && shown.title.includes(state.detail), JSON.stringify(shown));
  }

  // Skills manager (Phase C): read from Muse's own CLI (isolated config here), searchable and filterable; an activation change is
  // written by the CLI and read back. Muse's built-in skills are what an empty config has.
  if (!REAL) {
    await evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('[data-act=manageSkills]').click(); return true; })()");
    await waitFor("the skills list", () => evalWeb("!d.getElementById('skillsPanel').hidden && d.querySelectorAll('#skillsList .skill-row').length > 0"), 30000);
    const first = await evalWeb("(() => { const r = d.querySelector('#skillsList .skill-row'); return { count: d.querySelectorAll('#skillsList .skill-row').length, title: r.querySelector('.session-title').textContent, select: r.querySelector('select.skill-activation').value, status: d.getElementById('skillsStatus').textContent.slice(0, 80) }; })()");
    check("the skills manager lists what Muse knows, with an activation state", first.count > 0 && ["on", "userInvocableOnly", "off"].includes(first.select), JSON.stringify(first));
    await evalWeb("(() => { const s = d.getElementById('skillsSearch'); s.value = 'zzz-no-such-skill'; s.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()");
    check("searching narrows the list", await evalWeb("d.querySelectorAll('#skillsList .skill-row').length === 0"));
    await evalWeb("(() => { const s = d.getElementById('skillsSearch'); s.value = ''; s.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()");
    // Change one skill's activation through the real CLI and see it read back.
    const target = await evalWeb("(() => { const r = d.querySelector('#skillsList .skill-row select.skill-activation'); return r.getAttribute('aria-label'); })()");
    await evalWeb("(() => { const sel = d.querySelector('#skillsList .skill-row select.skill-activation'); sel.value = 'off'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); return true; })()");
    await waitFor("the activation to be read back", () => evalWeb("(() => { const sel = d.querySelector('#skillsList .skill-row select.skill-activation'); return !!sel && sel.value === 'off' && !sel.disabled; })()"), 30000);
    const afterOff = await evalWeb("({ aria: d.querySelector('#skillsList .skill-row select.skill-activation').getAttribute('aria-label'), useDisabled: d.querySelector('#skillsList .skill-row .extra-badges button').disabled })");
    check("turning a skill off is written by Muse and read back (its Use button is disabled)", afterOff.aria === target && afterOff.useDisabled === true, JSON.stringify({ target, ...afterOff }));
    await evalWeb("(() => { const sel = d.querySelector('#skillsList .skill-row select.skill-activation'); sel.value = 'on'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); return true; })()");
    await waitFor("the skill to be back on", () => evalWeb("(() => { const sel = d.querySelector('#skillsList .skill-row select.skill-activation'); return !!sel && sel.value === 'on' && !sel.disabled; })()"), 30000);
    // A name offered twice is called out; an activation Muse did not state is shown as unknown, never as on.
    await evalWeb(`(() => { w.postMessage({ type: 'skillsManage', conflicts: ['plan'], rows: [
      { id: 'plan', name: 'plan', displayName: 'plan', description: 'built-in', scope: 'bundled', origin: 'bundled', activation: 'on', diagnostics: [] },
      { id: 'plan', name: 'plan', displayName: 'plan', description: 'yours', scope: 'user', origin: 'local', path: '$CONFIG_DIR/skills/plan/SKILL.md', activation: 'unknown', diagnostics: ['warning: unknown field'] } ] }, '*'); return true; })()`);
    const synth = await evalWeb("({ warns: [...d.querySelectorAll('#skillsList .skill-warn')].map(n => n.textContent), unknown: d.querySelectorAll('#skillsList .skill-row')[1].querySelector('select').value, remove: !!d.querySelectorAll('#skillsList .skill-row')[1].querySelector('.extra-badges button:last-child') && d.querySelectorAll('#skillsList .skill-row')[1].querySelector('.extra-badges button:last-child').textContent })");
    check("a duplicated name and a diagnostic are called out, an unstated activation shows as unknown, an installed skill can be removed", synth.warns.some((x) => /Another skill has the name \/plan/.test(x)) && synth.warns.some((x) => /unknown field/.test(x)) && synth.unknown === 'unknown' && synth.remove === 'Remove', JSON.stringify(synth));
    await evalWeb("(() => { d.getElementById('skillsClose').click(); return true; })()");
    check("the skills panel closes", await evalWeb("d.getElementById('skillsPanel').hidden"));
  }

  // Web access (Phase H) and Preview (Phase I). The web indicator reads Muse's real settings (isolated config: the defaults);
  // Preview opens the editor's built-in browser, on a page served read-only from this folder.
  if (!REAL) {
    const web = await evalWeb("({ text: d.getElementById('webInfo').textContent, title: d.getElementById('webInfo').title })");
    check("the web indicator shows Muse's web-tool settings (defaults: on) and says the stricter modes still ask", web.text === "Web: on" && /web_fetch/.test(web.title) && /approval/i.test(web.title), JSON.stringify(web));
    const quick = async (what) => waitFor(what, () => evalPage("(() => { const w = document.querySelector('.quick-input-widget'); if (!w || w.style.display === 'none') return null; const rows = [...w.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.textContent.trim().replace(/\\s+/g, ' ')); return rows.length ? rows : null; })()"), 20000);
    const escapeQuick = async () => { await evalPage("(() => { const w = document.querySelector('.quick-input-widget input'); if (w) { w.focus(); } return true; })()"); await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession); await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession); await sleep(300); };
    await evalWeb("(() => { d.getElementById('webInfo').click(); return true; })()");
    const webItems = await quick("the web menu");
    check("the web menu offers the changes that are possible from the current state (and nothing already in effect)", webItems.some((r) => /Turn page reading off/.test(r)) && webItems.some((r) => /Searching: hosted/.test(r)) && webItems.some((r) => /Turn searching off/.test(r)) && !webItems.some((r) => /Searching: client/.test(r)), JSON.stringify(webItems));
    await escapeQuick();

    writeFileSync(join(workspace, "landing.html"), "<!doctype html><title>Landing</title><link rel=stylesheet href=style.css><h1>Hello landing</h1>");
    writeFileSync(join(workspace, "style.css"), "h1{color:#e8412b}");
    await evalWeb("(() => { w.postMessage({ type: 'previewUrls', urls: ['http://localhost:5173/'] }, '*'); return true; })()");
    check("when the agent prints a local address the Preview button says so", await evalWeb("d.getElementById('previewBtn').textContent === 'Preview ●' && d.getElementById('previewBtn').title.includes('http://localhost:5173/')"));
    await evalWeb("(() => { d.getElementById('previewBtn').click(); return true; })()");
    const prevItems = await quick("the preview menu");
    check("the preview menu offers typing an address and serving an HTML file of this folder", prevItems.some((r) => /Open an address/.test(r)) && prevItems.some((r) => /Preview an HTML file from this folder/.test(r)), JSON.stringify(prevItems));
    await evalPage("(() => { const r = [...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].find(x => /Preview an HTML file/.test(x.textContent)); r.click(); return true; })()");
    await waitFor("the html file list", () => evalPage("(() => { const w = document.querySelector('.quick-input-widget'); return !!w && w.style.display !== 'none' && [...w.querySelectorAll('.quick-input-list .monaco-list-row')].some(x => /landing\\.html/.test(x.textContent)); })()"), 20000);
    await evalPage("(() => { const r = [...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].find(x => /landing\\.html/.test(x.textContent)); r.click(); return true; })()");
    await waitFor("the serve confirmation", () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return !!b && [...b.querySelectorAll('.dialog-buttons .monaco-button')].some(x => x.textContent.trim() === 'Serve and preview'); })()"), 20000);
    await evalPage("(() => { [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === 'Serve and preview').click(); return true; })()");
    // VS Code opens its Simple Browser (the tab is titled by the page and carries the address); Antigravity opens its own browser tab ("Jetski Preview").
    const opened = await waitFor("the built-in browser tab", () => evalPage("(() => { const hit = [...document.querySelectorAll('.tab')].map(x => (x.getAttribute('aria-label') || '').trim()).find(x => x.includes('127.0.0.1') || /Jetski Preview/.test(x)); return hit || null; })()"), 30000);
    check("Preview opens the page in the editor's own browser tab", (/^Landing/.test(opened) && /127\.0\.0\.1:\d+/.test(opened)) || /Jetski Preview/.test(opened), JSON.stringify(opened));
    const notices = await waitFor("the address in the chat", async () => { const all = await evalWeb("[...d.querySelectorAll('.notice')].map(n => n.textContent)"); return all.some((x) => /Opened http:\/\/127\.0\.0\.1:\d+\/landing\.html in the editor/.test(x)) ? all : null; }, 20000);
    const previewPort = /127\.0\.0\.1:(\d+)/.exec(notices.find((x) => /Opened http:\/\/127\.0\.0\.1/.test(x)))[1];
    const probe = async (path) => { try { const r = await fetch("http://127.0.0.1:" + previewPort + path); return { status: r.status, body: (await r.text()).slice(0, 200) }; } catch (e) { return { error: e.message }; } };
    const served = { page: await probe("/landing.html"), css: await probe("/style.css"), dot: await probe("/.vscode/settings.json"), up: await probe("/..%2f..%2fpackage.json") };
    check("the folder is served read-only: the page and its CSS load, dotfiles and paths outside the folder do not", served.page.status === 200 && /Hello landing/.test(served.page.body) && served.css.status === 200 && served.dot.status === 404 && served.up.status !== 200, JSON.stringify(served));
    await shot("24-preview");
  }

  // Images: a pasted image shows a thumbnail (the page's CSP must allow data: images) and is sent.
  await evalWeb(`(async () => {
    const c = d.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d'); g.fillStyle = '#e8412b'; g.fillRect(0, 0, 64, 48);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new w.DataTransfer(); dt.items.add(new w.File([blob], 'shot.png', { type: 'image/png' }));
    d.getElementById('input').dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true; })()`);
  await waitFor("the thumbnail", () => evalWeb("d.querySelectorAll('#attachments .thumb').length === 1"), 8000);
  await sleep(300);
  const thumb = await evalWeb("({ loaded: d.querySelector('#attachments .thumb img').naturalWidth > 0, w: d.querySelector('#attachments .thumb img').naturalWidth, dims: d.querySelector('.thumb-dims').textContent })");
  check("pasted image shows a thumbnail under the real webview CSP", thumb.loaded && thumb.w === 64, JSON.stringify(thumb));
  await shot("07-image-attached");
  await evalWeb(`(() => { const i = d.getElementById('input'); i.value = 'image check'; i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await waitFor("the image reply", () => evalWeb("d.querySelectorAll('.msg.assistant').length >= 3 && d.getElementById('stop').hidden"), 20000);
  const sent = await evalWeb("({ text: [...d.querySelectorAll('.msg.user')].pop()?.querySelector('.body').textContent, chips: [...d.querySelectorAll('.msg.user')].pop()?.querySelectorAll('.chip').length, thumbOk: [...d.querySelectorAll('.msg.user')].pop()?.querySelector('.sent-thumb')?.naturalWidth > 0 })");
  check("the image is sent and shown as a chip with its thumbnail", sent.chips === 1 && sent.thumbOk, JSON.stringify(sent));
  await shot("08-image-sent");

  // Big pictures (noisy 2000 px screenshots, several MB each as PNG) are re-encoded so the whole message stays under
  // what the host accepts in one request.
  await evalWeb(`(async () => {
    for (let n = 0; n < 4; n++) {
      const c = d.createElement('canvas'); c.width = 2000; c.height = 1500; const g = c.getContext('2d');
      const px = g.createImageData(2000, 1500); for (let i = 0; i < px.data.length; i += 4) { px.data[i] = Math.random() * 255; px.data[i + 1] = Math.random() * 255; px.data[i + 2] = Math.random() * 255; px.data[i + 3] = 255; }
      g.putImageData(px, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new w.DataTransfer(); dt.items.add(new w.File([blob], 'big' + n + '.png', { type: 'image/png' }));
      d.getElementById('input').dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 1500));
    }
    return true; })()`);
  await waitFor("the big images", () => evalWeb("d.querySelectorAll('#attachments .thumb').length >= 3"), 30000);
  const big = await evalWeb("({ thumbs: d.querySelectorAll('#attachments .thumb').length, notices: [...d.querySelectorAll('.notice')].slice(-2).map(n => n.textContent.slice(0, 90)) })");
  const bigBytes = await evalWeb("w.__antaresAttachmentBytes ? w.__antaresAttachmentBytes() : -1");
  check("large pictures are re-encoded to fit the host's request limit", big.thumbs >= 3 && (bigBytes === -1 || bigBytes <= 5.5 * 1048576), JSON.stringify({ ...big, bigBytes }));
  await evalWeb("(() => { let b; while ((b = d.querySelector('#attachments .thumb-remove'))) b.click(); return true; })()");

  // The composer's "+" menu, in the real window: files and photos, a folder, slash commands, connectors and
  // plugins. The host-side dialogs are replaced by `antares.dev.picks` (a native file dialog is not in the
  // DOM). The echo provider answers, so this costs nothing; the skill list, the connector list and the
  // plugin list come from the real `muse serve` of this machine.
  if (!REAL) {
    const settingsFile = join(workspace, ".vscode", "settings.json");
    const setPicks = async (paths) => {
      writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, "utf8")), "antares.dev.picks": paths }, null, 2));
      await sleep(2500); // the editor re-reads the settings file
    };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const extraDir = join(work, "extra-lib");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "lib.txt"), "library\n");
    writeFileSync(join(workspace, "my notes.txt"), "notes\n");
    writeFileSync(join(workspace, "pic.png"), png);
    writeFileSync(join(work, "outside.txt"), "outside\n");
    const errorNotices = () => evalWeb("d.querySelectorAll('.notice.error').length");

    // The menu.
    await evalWeb("(() => { d.getElementById('plus').click(); return true; })()");
    const menu = await evalWeb("({ open: !d.getElementById('plusMenu').hidden, expanded: d.getElementById('plus').getAttribute('aria-expanded'), items: [...d.querySelectorAll('#plusMenu .menu-item')].map(b => b.querySelector('span').textContent) })");
    check("the + button opens a menu with files, folder, slash commands, connectors, plugins, skills management and import skills", menu.open && menu.expanded === "true" && JSON.stringify(menu.items) === JSON.stringify(["Add files or photos", "Add folder", "Add current file", "Add selection", "Slash commands", "Connectors", "Plugins", "Manage skills…", "Import skills…"]), JSON.stringify(menu));
    await shot("15-plus-menu");

    // Files and photos: a text file inside the workspace becomes @path, a name with a space is quoted, a photo
    // becomes a thumbnail, and a file outside the workspace is refused with an explanation.
    await setPicks([join(workspace, "hello.txt"), join(workspace, "my notes.txt"), join(workspace, "pic.png"), join(work, "outside.txt")]);
    await evalWeb("(() => { d.querySelector('#plusMenu [data-act=files]').click(); return true; })()");
    await waitFor("the picked files", () => evalWeb("d.getElementById('input').value.includes('@hello.txt') && d.querySelectorAll('#attachments .thumb').length === 1"), 15000);
    const picked = await evalWeb("({ input: d.getElementById('input').value, thumbs: d.querySelectorAll('#attachments .thumb').length, notices: [...d.querySelectorAll('.notice')].map(n => n.textContent.slice(0, 90)), menuClosed: d.getElementById('plusMenu').hidden })");
    check("files become @mentions (spaces quoted), a photo becomes a thumbnail, the menu closes", picked.input.includes("@hello.txt") && picked.input.includes('@"my notes.txt"') && picked.thumbs === 1 && picked.menuClosed, JSON.stringify(picked));
    check("a file outside the workspace is refused with an explanation instead of a useless mention", picked.notices.some((n) => /outside\.txt is outside/.test(n)) && !picked.input.includes("outside"), JSON.stringify(picked.notices));
    await shot("16-files-picked");
    await evalWeb("(() => { d.querySelector('.thumb-remove').click(); const i = d.getElementById('input'); i.value = ''; return true; })()");

    // A drop from the Explorer: only addresses, no File object. It must end as an @mention.
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = ''; return true; })()");
    await evalWeb(`(() => { const dt = new w.DataTransfer(); dt.setData('text/uri-list', ${JSON.stringify(pathToFileURL(join(workspace, "hello.txt")).href)}); w.dispatchEvent(new w.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
    await waitFor("the dropped Explorer file", () => evalWeb("d.getElementById('input').value.includes('@hello.txt')"), 15000);
    check("a file dragged from the Explorer (only its address) becomes an @mention", true);
    await evalWeb("(() => { d.getElementById('input').value = ''; return true; })()");

    // Add current file and Add selection use the file open in the editor, even though the chat has the focus.
    // Open hello.txt the way a person does: quick open (Ctrl+P), the name, Enter.
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 80, key: "p", code: "KeyP", modifiers: 2 }, pageSession);
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 80, key: "p", code: "KeyP", modifiers: 2 }, pageSession);
    await waitFor("quick open", () => evalPage("!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')"), 10000);
    await browser.send("Input.insertText", { text: "hello.txt" }, pageSession);
    await sleep(600);
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" }, pageSession);
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" }, pageSession);
    await waitFor("hello.txt open in an editor", () => evalPage("[...document.querySelectorAll('.tab')].some(x => /hello\\.txt/.test(x.textContent))"), 15000);
    await sleep(800);
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] }, pageSession);
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, key: "a", code: "KeyA", modifiers: 2 }, pageSession);
    await sleep(500);
    await evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=currentFile]').click(); return true; })()");
    await waitFor("the current file mention", () => evalWeb("d.getElementById('input').value.includes('@hello.txt')"), 15000);
    check("Add current file adds the open file as an @mention", true);
    await evalWeb("(() => { d.getElementById('input').value = ''; d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=selection]').click(); return true; })()");
    await waitFor("the selection block", () => evalWeb("d.getElementById('input').value.includes('hello.txt:1-')"), 15000);
    const snippet = await evalWeb("d.getElementById('input').value");
    check("Add selection adds the selected text as a quoted block that names the file and lines", /^hello\.txt:1-\d+\n```\nhello\n+```/.test(snippet), JSON.stringify(snippet));
    await evalWeb("(() => { d.getElementById('input').value = ''; return true; })()");

    // Ctrl+U asks for files, like the + menu item.
    await setPicks([join(workspace, "hello.txt")]);
    await evalWeb("(() => { w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'u', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()");
    await waitFor("Ctrl+U to pick files", () => evalWeb("d.getElementById('input').value.includes('@hello.txt')"), 15000);
    check("Ctrl+U opens the same file pick", true);
    await evalWeb("(() => { d.getElementById('input').value = ''; return true; })()");

    // A folder: the grant asks first (the workbench's own modal), then shows as a chip and goes with the next message.
    await setPicks([extraDir]);
    await evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=folder]').click(); return true; })()");
    const grant = await waitFor("the folder confirmation", () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return b ? { text: b.textContent.slice(0, 260), buttons: [...b.querySelectorAll('.dialog-buttons .monaco-button')].map(x => x.textContent.trim()) } : null; })()"), 15000);
    check("adding a folder asks first and says what it grants", /Give Muse access to/.test(grant.text) && /Project Trust/.test(grant.text) && grant.buttons.some((b) => /Add folder/.test(b)), JSON.stringify(grant));
    await shot("17-folder-confirm");
    await evalPage("(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => /Add folder/.test(x.textContent)); btn.click(); return true; })()");
    await waitFor("the folder chip", () => evalWeb("d.querySelectorAll('#folders .folder-chip').length === 1"), 10000);
    const chip = await evalWeb("({ text: d.querySelector('#folders .folder-chip span').textContent, hidden: d.getElementById('folders').hidden })");
    check("the added folder shows as a removable chip", !chip.hidden && /extra-lib/.test(chip.text), JSON.stringify(chip));
    const errorsBefore = await errorNotices();
    const repliesBefore = await evalWeb("d.querySelectorAll('.msg.assistant').length");
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'after adding a folder'; i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()");
    await waitFor("the reply after adding a folder", () => evalWeb(`d.querySelectorAll('.msg.assistant').length > ${repliesBefore} && d.getElementById('stop').hidden`), 20000);
    check("the real host accepts the turn that carries the added folder (canonical path)", (await errorNotices()) === errorsBefore, `errors before ${errorsBefore}, after ${await errorNotices()}`);
    await shot("18-folder-turn");

    // Slash commands: the palette lists the real host's skills; a typed /skill goes as a skill part.
    await evalWeb("(() => { const i = d.getElementById('input'); i.focus(); i.value = '/'; i.dispatchEvent(new w.Event('input', { bubbles: true })); return true; })()");
    await waitFor("the slash palette", () => evalWeb("!d.getElementById('slashMenu').hidden && d.querySelectorAll('#slashMenu .slash-item').length > 0"), 25000);
    const slash = await evalWeb("({ names: [...d.querySelectorAll('#slashMenu .slash-name')].map(n => n.textContent), badges: [...new Set([...d.querySelectorAll('#slashMenu .badge')].map(n => n.textContent))] })");
    check("typing / lists the host's skills with their source", slash.names.includes("/plan") && slash.names.length >= 3, JSON.stringify({ count: slash.names.length, hasPlan: slash.names.includes("/plan"), sources: slash.badges }));
    await shot("19-slash-palette");
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = '/pla'; i.dispatchEvent(new w.Event('input', { bubbles: true })); i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()");
    const picked2 = await evalWeb("({ input: d.getElementById('input').value, menuHidden: d.getElementById('slashMenu').hidden, users: d.querySelectorAll('.msg.user').length })");
    check("Enter in the palette completes the skill name and does not send", picked2.input === "/plan " && picked2.menuHidden, JSON.stringify(picked2));
    const repliesBeforeSkill = await evalWeb("d.querySelectorAll('.msg.assistant').length");
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = '/plan tidy the README'; i.dispatchEvent(new w.Event('input', { bubbles: true })); i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()");
    await waitFor("the skill turn", () => evalWeb(`d.querySelectorAll('.msg.assistant').length > ${repliesBeforeSkill} && d.getElementById('stop').hidden`), 30000);
    const skillTurn = await evalWeb("({ user: [...d.querySelectorAll('.msg.user')].pop()?.querySelector('.body').textContent, reply: [...d.querySelectorAll('.msg.assistant')].pop()?.querySelector('.body').textContent.slice(0, 40), errors: d.querySelectorAll('.notice.error').length })");
    check("a typed /skill is accepted by the real host as a skill invocation", /^\/plan tidy the README/.test(skillTurn.user) && /^echo:/.test(skillTurn.reply) && skillTurn.errors === errorsBefore, JSON.stringify(skillTurn));
    await shot("20-skill-turn");

    // Connectors and plugins: read-only lists from the real host (nothing is set up in this throwaway config).
    for (const [act, title] of [["connectors", /Connectors/], ["plugins", /Plugins/]]) {
      await evalWeb(`(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=${act}]').click(); return true; })()`);
      await waitFor(`the ${act} list`, () => evalWeb("!d.getElementById('extrasPanel').hidden && d.getElementById('extrasStatus').textContent !== 'Reading from Muse…'"), 30000);
      const extras = await evalWeb("({ title: d.getElementById('extrasTitle').textContent, status: d.getElementById('extrasStatus').textContent, rows: d.querySelectorAll('#extrasList li').length })");
      check(`the ${act} list answers from the real host (rows or a clear empty state)`, title.test(extras.title) && !/^Could not/.test(extras.status) && /(Servers defined in Muse's settings|Installing runs nothing|Skills of an enabled plugin)/.test(extras.status), JSON.stringify(extras));
      await shot(`21-${act}`);
      await evalWeb("(() => { d.getElementById('extrasClose').click(); return true; })()");
    }

    // Plugin manager (Phase E): what a plugin brings from Muse's own CLI, approval of its hooks and MCP servers one by one (never
    // automatic), enable, update, remove, and the marketplaces view. The demo plugin brings a skill, a harmless echo hook and the mini MCP
    // server (never started here), in this run's isolated Muse data.
    {
      const museBinary = locateMuse(undefined);
      const cliEnv = { ...process.env, XDG_CONFIG_HOME: join(muse, "config"), XDG_DATA_HOME: join(muse, "data"), MUSE_AUTH_PATH: join(muse, "config", "absent-auth.json"), META_API_KEY: "" };
      const cli = (...args) => execFileSync(museBinary, args, { env: cliEnv, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
      const demo = join(work, "plugin-demo");
      mkdirSync(join(demo, ".claude-plugin"), { recursive: true });
      mkdirSync(join(demo, "skills", "hello"), { recursive: true });
      mkdirSync(join(demo, "hooks"), { recursive: true });
      writeFileSync(join(demo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "antares-demo", version: "0.0.1", description: "A harmless demo bundle." }));
      writeFileSync(join(demo, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello. Demo only.\n---\nSay hello.\n");
      writeFileSync(join(demo, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo antares-demo-hook" }] }] } }));
      writeFileSync(join(demo, ".mcp.json"), JSON.stringify({ mcpServers: { "demo-mini": { command: process.execPath, args: [join(root, "test", "fixtures", "mini-mcp-server.mjs")] } } }));
      const market = join(work, "plugin-market");
      mkdirSync(join(market, ".claude-plugin"), { recursive: true });
      writeFileSync(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "demo-market", owner: { name: "e2e" }, plugins: [{ name: "antares-demo", source: "./antares-demo", description: "demo" }] }));
      cpSync(demo, join(market, "antares-demo"), { recursive: true });
      cli("plugins", "install", demo, "--scope", "user", "--json");
      cli("plugins", "marketplace", "add", "demo-market", market, "--json");
      const clickDialog2 = async (label) => {
        await waitFor("the dialog " + label, () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return !!b && [...b.querySelectorAll('.dialog-buttons .monaco-button')].some(x => x.textContent.trim() === " + JSON.stringify(label) + "); })()"), 20000);
        await evalPage("(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === " + JSON.stringify(label) + "); btn.click(); return true; })()");
      };
      const planRow = (label) => "(() => { const li = [...d.querySelectorAll('#extrasList li')][0]; const b = [...li.querySelectorAll('button')].find(x => x.textContent === " + JSON.stringify(label) + "); b.click(); return true; })()";
      const partButton = (kindText, label) => "(() => { const line = [...d.querySelectorAll('#extrasList .plugin-part')].find(x => x.textContent.startsWith(" + JSON.stringify(kindText) + ")); const b = [...line.querySelectorAll('button')].find(x => x.textContent === " + JSON.stringify(label) + "); b.click(); return true; })()";
      const partText = (kindText) => "([...d.querySelectorAll('#extrasList .plugin-part')].find(x => x.textContent.startsWith(" + JSON.stringify(kindText) + ")) || { textContent: '' }).textContent";
      await evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=plugins]').click(); return true; })()");
      await waitFor("the plugin from the CLI", () => evalWeb("d.querySelectorAll('#extrasList .extra-row').length === 1 && d.querySelectorAll('#extrasList .plugin-part').length === 2"), 60000);
      const rich = await evalWeb("({ title: d.querySelector('#extrasList .session-title').textContent, parts: [...d.querySelectorAll('#extrasList .plugin-part')].map(x => x.textContent.replace(/Approve…|Reject/g, '').trim()), badges: [...d.querySelectorAll('#extrasList .extra-badges .badge')].map(x => x.textContent), text: d.getElementById('extrasList').textContent })");
      check("the plugin list says what it brings and that its hook and MCP server wait for review (nothing is approved by default)", rich.title === 'antares-demo' && rich.parts.some((p) => /^Hook .*echo antares-demo-hook.*waiting for your review/.test(p)) && rich.parts.some((p) => /^MCP server .*waiting for your review/.test(p)) && rich.badges.includes('2 to review') && /1 skill/.test(rich.text), JSON.stringify(rich));
      await shot("23-plugins-review");
      await evalWeb(partButton("Hook", "Approve…"));
      await clickDialog2("Approve");
      await waitFor("the hook approved", () => evalWeb(partText("Hook") + ".includes('approved, runs')"), 60000);
      check("approving the hook (after a warning that it runs outside the sandbox) changes only the hook", await evalWeb(partText("MCP server") + ".includes('waiting for your review')"));
      await evalWeb(partButton("MCP server", "Reject"));
      await clickDialog2("Reject");
      await waitFor("the MCP server rejected", () => evalWeb(partText("MCP server") + ".includes('rejected')"), 60000);
      check("rejecting the MCP server leaves it not running and nothing left to review", await evalWeb("![...d.querySelectorAll('#extrasList .badge')].some(x => /to review/.test(x.textContent))"));
      await evalWeb(planRow("Disable"));
      await clickDialog2("Disable");
      await waitFor("the plugin disabled", () => evalWeb("[...d.querySelectorAll('#extrasList .badge')].some(x => x.textContent === 'not loaded') && /disabled: its hooks and MCP servers are not loaded/.test(d.getElementById('extrasList').textContent)"), 60000);
      check("disabling says the hooks and MCP servers are no longer loaded", true);
      await evalWeb(planRow("Enable"));
      await clickDialog2("Enable");
      await waitFor("the plugin enabled", () => evalWeb("[...d.querySelectorAll('#extrasList .badge')].some(x => x.textContent === 'loaded') && " + partText("Hook") + ".includes('approved, runs')"), 60000);
      check("enabling again keeps the earlier approvals", true);
      await evalWeb(planRow("Update"));
      await clickDialog2("Update");
      await waitFor("the update notice", () => evalWeb("[...d.querySelectorAll('.notice')].some(n => /Updated antares-demo/.test(n.textContent))"), 60000);
      check("update runs through Muse and tells the user to check for changed parts", true);
      // Marketplaces view
      await evalWeb("(() => { [...d.querySelectorAll('#extrasActions button')].find(b => b.textContent === 'Marketplaces…').click(); return true; })()");
      await waitFor("the marketplaces", () => evalWeb("d.getElementById('extrasTitle').textContent === 'Marketplaces' && d.querySelectorAll('#extrasList .extra-row:not(.suggested):not(.suggested-head)').length === 1"), 60000);
      const mk = await evalWeb("(() => { const row = d.querySelector('#extrasList .extra-row:not(.suggested):not(.suggested-head)'); return { name: row.querySelector('.session-title').textContent, meta: row.querySelector('.session-meta').textContent, buttons: [...row.querySelectorAll('.extra-badges button')].map(b => b.textContent) }; })()");
      check("the marketplaces view lists the catalog with Refresh and Remove", mk.name === 'demo-market' && /local-dir/.test(mk.meta) && /1 plugin/.test(mk.meta) && mk.buttons.join() === 'Refresh,Remove', JSON.stringify(mk));
      const sug = await evalWeb("({ titles: [...d.querySelectorAll('#extrasList .suggested .session-title')].map(x => x.textContent), buttons: [...d.querySelectorAll('#extrasList .suggested .extra-badges button')].map(x => x.textContent), head: !!d.querySelector('#extrasList .suggested-head') })");
      check("the marketplaces view suggests a plugin marketplace and a skills collection, each added only by a button (nothing is added by itself)", sug.head && sug.titles.length === 2 && sug.buttons.join() === 'Add catalog…,Browse skills…' && /official plugins/.test(sug.titles[0]) && /Agent Skills/.test(sug.titles[1]), JSON.stringify(sug));
      await evalWeb("(() => { [...d.querySelectorAll('#extrasList .extra-badges button')].find(b => b.textContent === 'Refresh').click(); return true; })()");
      await waitFor("the refresh notice", () => evalWeb("[...d.querySelectorAll('.notice')].some(n => /Refreshed the marketplace demo-market/.test(n.textContent))"), 60000);
      await evalWeb("(() => { [...d.querySelectorAll('#extrasList .extra-badges button')].find(b => b.textContent === 'Remove').click(); return true; })()");
      await clickDialog2("Remove");
      await waitFor("the marketplace removed", () => evalWeb("d.querySelectorAll('#extrasList .extra-row:not(.suggested):not(.suggested-head)').length === 0"), 60000);
      check("removing a marketplace asks first and leaves installed plugins alone", /antares-demo/.test(cli("plugins", "list", "--json")));
      await evalWeb("(() => { [...d.querySelectorAll('#extrasActions button')].find(b => b.textContent === '← Plugins').click(); return true; })()");
      await waitFor("the plugins view", () => evalWeb("d.getElementById('extrasTitle').textContent === 'Plugins' && d.querySelectorAll('#extrasList .extra-row:not(.suggested):not(.suggested-head)').length === 1"), 60000);
      await evalWeb(planRow("Remove"));
      await clickDialog2("Remove");
      await waitFor("the plugin removed", () => evalWeb("d.querySelectorAll('#extrasList .extra-row:not(.suggested):not(.suggested-head)').length === 0"), 60000);
      check("removing a plugin asks first and Muse no longer lists it", !/antares-demo/.test(cli("plugins", "list", "--json")));
      await evalWeb("(() => { d.getElementById('extrasClose').click(); return true; })()");
    }

    // MCP manager (Phase D): servers defined in Muse's settings.json are listed from the file (the host's list does not show them),
    // secrets stay hidden, Test makes Muse itself start the server, and every write asks first and keeps a backup.
    {
      const mcpDir = join(muse, "config", "muse");
      mkdirSync(mcpDir, { recursive: true });
      const mcpFile = join(mcpDir, "settings.json");
      const miniServer = join(root, "test", "fixtures", "mini-mcp-server.mjs");
      writeFileSync(mcpFile, JSON.stringify({ schema_version: 1, contributor_mode_enabled: false, mcpServers: {
        mini: { transport: "stdio", command: process.execPath, args: [miniServer], mode: "optional", env: { MINI_SECRET: "e2e-secret-value-123" } },
        gone: { transport: "stdio", command: "definitely-not-a-real-command-xyz", mode: "optional" },
      } }, null, 2));
      const clickDialog = async (label) => {
        await waitFor("the dialog " + label, () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return !!b && [...b.querySelectorAll('.dialog-buttons .monaco-button')].some(x => x.textContent.trim() === " + JSON.stringify(label) + "); })()"), 20000);
        await evalPage("(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => x.textContent.trim() === " + JSON.stringify(label) + "); btn.click(); return true; })()");
      };
      await evalWeb("(() => { d.getElementById('plus').click(); d.querySelector('#plusMenu [data-act=connectors]').click(); return true; })()");
      await waitFor("the connectors from the file", () => evalWeb("d.querySelectorAll('#extrasList li').length === 2"), 30000);
      const listed = await evalWeb("({ names: [...d.querySelectorAll('#extrasList .session-title')].map(n => n.textContent), text: d.getElementById('extrasPanel').textContent, adds: [...d.querySelectorAll('#extrasActions button')].map(b => b.textContent) })");
      check("the connectors list shows the servers defined in settings.json, with env names and no secret values", listed.names.join() === "mini,gone" && /MINI_SECRET/.test(listed.text) && !/e2e-secret-value-123/.test(listed.text) && listed.adds.join() === "Add local server…,Add HTTP server…", JSON.stringify({ names: listed.names, adds: listed.adds }));
      await shot("22-connectors-file");
      const rowButton = (name, label) => "(() => { const li = [...d.querySelectorAll('#extrasList li')].find(x => x.querySelector('.session-title').textContent === " + JSON.stringify(name) + "); const b = [...li.querySelectorAll('button')].find(x => x.textContent === " + JSON.stringify(label) + "); b.click(); return true; })()";
      await evalWeb(rowButton("mini", "Test"));
      await clickDialog("Test");
      await waitFor("the test to answer", () => evalWeb("/answered/.test(d.querySelector('.mcp-test[data-name=mini]').textContent)"), 60000);
      check("Test makes Muse start the server and reports that it answered", true);
      await evalWeb(rowButton("gone", "Test"));
      await clickDialog("Test");
      await waitFor("the failed test", () => evalWeb("/Did not start/.test(d.querySelector('.mcp-test[data-name=gone]').textContent)"), 60000);
      const failed = await evalWeb("d.querySelector('.mcp-test[data-name=gone]').textContent");
      check("a server that cannot start is reported with Muse's reason", /configured command is unavailable/.test(failed), failed);
      await evalWeb(rowButton("mini", "Disable"));
      await clickDialog("Save");
      await waitFor("the file to change", () => evalWeb("[...d.querySelectorAll('#extrasList li')].find(x => x.querySelector('.session-title').textContent === 'mini')?.textContent.includes('disabled') === true"), 30000);
      const saved = JSON.parse(readFileSync(mcpFile, "utf8"));
      const backups = readdirSync(mcpDir).filter((x) => x.includes("antares-bak"));
      check("disabling asks first, changes only that server, keeps everything else, and leaves a backup", saved.mcpServers.mini.enabled === false && saved.mcpServers.mini.env.MINI_SECRET === "e2e-secret-value-123" && saved.contributor_mode_enabled === false && saved.mcpServers.gone.mode === "optional" && backups.length === 1, JSON.stringify({ enabled: saved.mcpServers.mini.enabled, backups: backups.length }));
      await evalWeb(rowButton("gone", "Remove"));
      await clickDialog("Save");
      await waitFor("the removal", () => evalWeb("d.querySelectorAll('#extrasList li').length === 1"), 30000);
      check("removing a server deletes only its entry", Object.keys(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers).join() === "mini");
      await evalWeb("(() => { d.getElementById('extrasClose').click(); return true; })()");
      rmSync(mcpFile, { force: true });
      for (const b of readdirSync(mcpDir).filter((x) => x.includes("antares-bak"))) rmSync(join(mcpDir, b), { force: true });
    }
  }

  // Mode change: a native modal confirmation (workbench dialog). The offline test provider keeps no stored session,
  // so the chat restarts (the continue-the-session path is checked with E2E_MODES=1).
  await evalWeb("(() => { d.getElementById('modeBtn').click(); d.querySelector('#modeMenu [data-mode=acceptEdits]').click(); return true; })()");
  const dialog = await waitFor("the confirmation dialog", () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return b ? { text: b.textContent.slice(0, 260), buttons: [...b.querySelectorAll('.dialog-buttons .monaco-button')].map(x => x.textContent.trim()) } : null; })()"), 10000);
  check("changing to Accept edits asks for confirmation in a native dialog", /Accept edits/.test(dialog.text) && /ask-me/.test(dialog.text) && dialog.buttons.some((b) => /Start new chat/.test(b)), JSON.stringify(dialog.buttons));
  await shot("09-profile-dialog");
  await evalPage(`(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => /Start new chat/.test(x.textContent)); btn.click(); return true; })()`);
  await waitFor("the new chat", () => evalWeb("d.querySelectorAll('.msg').length === 0 && d.getElementById('modeLabel').textContent === 'Accept edits'"), 15000);
  const asked = await evalWeb("({ footer: d.getElementById('meta').textContent.slice(0, 50), label: d.getElementById('modeLabel').textContent })");
  check("after confirming, the chat restarts in Accept edits (:ask-me)", /:ask-me/.test(asked.footer) && asked.label === "Accept edits", JSON.stringify(asked));
  await shot("10-ask-me");

  // Narrow layout.
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  await sleep(800);
  const narrow = await evalWeb("({ overflowX: d.documentElement.scrollWidth > d.documentElement.clientWidth, width: d.documentElement.clientWidth })");
  check("the panel does not overflow horizontally when narrow", !narrow.overflowX, JSON.stringify(narrow));
  await shot("11-narrow");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);

  }

  // The activity-bar launcher exists next to the other views.
  const launcher = await evalPage("[...document.querySelectorAll('.activitybar .action-label')].map(x => x.getAttribute('aria-label') || '').filter(x => /Antares/.test(x))");
  check("the activity bar has an Antares launcher button", launcher.length > 0, JSON.stringify(launcher));

  // Status bar item exists in the real workbench.
  const status = await evalPage("[...document.querySelectorAll('.statusbar-item')].map(e => e.textContent.trim()).filter(t => /Antares|5h\\s*[\\d–]/.test(t))");
  check("status bar shows the Antares item", status.length > 0, JSON.stringify(status));
  await shot("06-final");
} catch (error) {
  check("e2e run", false, error.message);
  try {
    const state = await evalWebSafe("({ label: d.getElementById('modeLabel')?.textContent, footer: d.getElementById('meta')?.textContent.slice(0, 80), status: d.getElementById('stop')?.hidden, notices: [...d.querySelectorAll('.notice')].map(n => n.textContent.slice(0, 160)), dialogs: [] })");
    console.log("FAILURE-STATE:", JSON.stringify(state));
    await shot("99-failure");
  } catch {}
} finally {
  try {
    void browser?.send("Browser.close");
  } catch {}
  browser?.close();
  await sleep(1500);
  try {
    child.kill();
  } catch {}
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[${label}] ${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`);
  process.exit(failed.length ? 1 : 0);
}
