// End-to-end check inside a REAL editor window (VS Code or a fork), driven over the Chrome DevTools
// Protocol (the editors are Electron). It launches the editor with Antares as a development extension
// in a throwaway profile, with the offline `echo` provider and an isolated Muse config (no login, no
// model call), opens the panel from the command palette, drives the real webview and saves
// screenshots of the real window to spike-output/e2e/.
//
// Usage: node scripts/e2e-editor.mjs <path-to-editor-exe> [label]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = process.argv[2];
const REAL = process.env.E2E_REAL === "1";
// E2E_MODES=1: the real host, no model call. A session is opened (the slash palette needs one) and the permission
// mode is switched through the real UI, which continues that session under the new profile.
const MODES = process.env.E2E_MODES === "1";
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
writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify(MODES ? { "antares.usage.refreshOnOpen": false } : REAL ? { "antares.initialProfile": ":ask-me", "antares.usage.refreshOnOpen": false } : { "antares.dev.provider": "echo", "antares.dev.patch": patchFile, "antares.usage.refreshOnOpen": false, ...(VOICE === "fake" ? { "antares.dev.voice": true } : VOICE === "error" ? { "antares.voice.engine": "faster-whisper", "antares.voice.home": join(work, "empty-voice") } : {}) }, null, 2));
writeFileSync(join(workspace, "hello.txt"), "hello\n");

const child = spawn(
  exe,
  [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${join(work, "extensions")}`, `--extensionDevelopmentPath=${root}`, `--remote-debugging-port=${port}`, "--disable-workspace-trust", "--skip-release-notes", "--skip-welcome", "--new-window"],
  { stdio: "ignore", env: REAL ? { ...process.env } : { ...process.env, XDG_CONFIG_HOME: join(muse, "config"), XDG_DATA_HOME: join(muse, "data"), MUSE_AUTH_PATH: join(muse, "config", "absent-auth.json"), META_API_KEY: "" } },
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

  if (!MODES && !REAL) {
    // Tool presentation: a checklist instead of JSON, and a file edit as a diff with buttons to open VS Code's diff.
    await waitFor("the demo tool cards", () => evalWeb("d.querySelectorAll('.tool').length >= 2 && d.querySelectorAll('.patch-line').length > 0"), 20000);
    const cards = await evalWeb("({ todos: [...d.querySelectorAll('.todo')].map(x => x.className.replace('todo ', '') + ':' + x.querySelector('.todo-text').textContent), todoSummary: d.querySelector('.tool .tool-summary').textContent, edit: { summary: [...d.querySelectorAll('.tool-summary')].pop().textContent, changed: d.querySelector('.patch-head .tool-changed')?.textContent, lines: [...d.querySelectorAll('.patch-line')].map(x => x.className.replace('patch-line ', '') + ':' + x.textContent), buttons: [...d.querySelectorAll('.patch-head button')].map(b => b.textContent) } })");
    check("write_todos shows a checklist with done and in-progress items, not JSON", JSON.stringify(cards.todos) === JSON.stringify(["completed:Create plan.txt", "inProgress:Change line 2 to BETA"]) && cards.todoSummary === "2 tasks, 1 done", JSON.stringify({ todos: cards.todos, summary: cards.todoSummary }));
    check("edit_file shows the file relative to the workspace, the counts and the host's diff lines", cards.edit.summary === "plan.txt" && cards.edit.changed === "+1 \u22121" && JSON.stringify(cards.edit.lines) === JSON.stringify(["ctx: alpha", "del:-beta", "add:+BETA", "ctx: gamma"]), JSON.stringify(cards.edit));
    check("the diff card offers Open diff and Open file for a file inside the workspace", JSON.stringify(cards.edit.buttons) === JSON.stringify(["Open diff", "Open file"]), JSON.stringify(cards.edit.buttons));
    await shot("26-tool-cards");
    await evalWeb("(() => { [...d.querySelectorAll('.patch-head button')].find(b => b.textContent === 'Open diff').click(); return true; })()");
    const diffTab = await waitFor("VS Code's diff editor", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before/.test(x.textContent)); return !!document.querySelector('.monaco-diff-editor') && tab ? tab.textContent.trim() : null; })()"), 20000);
    check("Open diff opens VS Code's diff editor on the file before and after the edit", /plan\.txt \(before/.test(diffTab), JSON.stringify(diffTab));
    await waitFor("the diff editor to paint its lines", () => evalPage("document.querySelectorAll('.monaco-diff-editor .editor.original .view-line').length > 0 && document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 0"), 15000).catch(() => undefined);
    const sides = await evalPage("(() => ({ original: [...document.querySelectorAll('.monaco-diff-editor .editor.original .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')), modified: [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].map(x => x.textContent.replace(/\u00a0/g, ' ')) }))()");
    check("the before side was rebuilt from the patch (beta) and the after side is the file (BETA)", sides.original.some((l) => /beta/.test(l)) && !sides.original.some((l) => /BETA/.test(l)) && sides.modified.some((l) => /BETA/.test(l)), JSON.stringify(sides));
    await shot("27-diff-editor");
    await evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before/.test(x.textContent)); const close = tab?.querySelector('.codicon-close, .action-label.codicon'); close?.click(); return true; })()");
  }

  if (MODES) {
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
    const sb = await evalWeb("({ shown: !d.getElementById('sandboxNote').hidden, text: d.getElementById('sandboxNote').textContent.slice(0, 140), unavailable: /sandbox unavailable/.test(d.getElementById('meta').textContent) })");
    check("the sandbox note appears in Accept edits exactly when the host reports no sandbox", sb.shown === sb.unavailable && (!sb.shown || /fail before they start/.test(sb.text)), JSON.stringify(sb));

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
    check("the + button opens a menu with files, folder, slash commands, connectors and plugins", menu.open && menu.expanded === "true" && JSON.stringify(menu.items) === JSON.stringify(["Add files or photos", "Add folder", "Slash commands", "Connectors", "Plugins"]), JSON.stringify(menu));
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
      check(`the ${act} list answers from the real host (rows or a clear empty state), read-only`, title.test(extras.title) && !/^Could not/.test(extras.status) && /read-only/.test(extras.status), JSON.stringify(extras));
      await shot(`21-${act}`);
      await evalWeb("(() => { d.getElementById('extrasClose').click(); return true; })()");
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
