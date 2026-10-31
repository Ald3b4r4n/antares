// End-to-end check inside a REAL editor window (VS Code or a fork), driven over the Chrome DevTools
// Protocol (the editors are Electron). It launches the editor with Antares as a development extension
// in a throwaway profile, with the offline `echo` provider and an isolated Muse config (no login, no
// model call), opens the panel from the command palette, drives the real webview and saves
// screenshots of the real window to spike-output/e2e/.
//
// Usage: node scripts/e2e-editor.mjs <path-to-editor-exe> [label]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = process.argv[2];
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
writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify({ "antares.dev.provider": "echo", "antares.usage.refreshOnOpen": false }, null, 2));
writeFileSync(join(workspace, "hello.txt"), "hello\n");

const child = spawn(
  exe,
  [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${join(work, "extensions")}`, `--extensionDevelopmentPath=${root}`, `--remote-debugging-port=${port}`, "--disable-workspace-trust", "--skip-release-notes", "--skip-welcome", "--new-window"],
  { stdio: "ignore", env: { ...process.env, XDG_CONFIG_HOME: join(muse, "config"), XDG_DATA_HOME: join(muse, "data"), MUSE_AUTH_PATH: join(muse, "config", "absent-auth.json"), META_API_KEY: "" } },
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
  await waitFor("chat.js to start inside the real webview", () => evalWeb("!!d.getElementById('input') && d.getElementById('meta').children.length > 0"), 30000);
  await sleep(1500);
  check("panel opens from the command palette in the real editor", true);
  await shot("03-panel-open");

  const dom = await evalWeb(`({
    title: d.title,
    hero: !!d.querySelector('.hero img') && d.querySelector('pre.logo')?.textContent.split(String.fromCharCode(10)).length === 5,
    logoLoaded: d.querySelector('.hero img')?.naturalWidth > 0,
    profileOptions: [...d.querySelectorAll('#profile option')].map(o => o.value),
    modelControls: !!d.getElementById('model') && !!d.getElementById('effort'),
    footer: d.getElementById('meta').textContent,
    hint: d.getElementById('hint').textContent.slice(0, 60),
    cssLoaded: getComputedStyle(d.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
    fontFromTheme: getComputedStyle(d.body).fontFamily.slice(0, 30)
  })`);
  console.log("DOM:", JSON.stringify(dom));
  check("banner and logo render (SVG loaded through the webview URI)", dom.hero && dom.logoLoaded);
  check("profile picker lists the four profiles", dom.profileOptions.length === 4);
  check("model and effort controls exist", dom.modelControls);
  check("page styles loaded", dom.cssLoaded);

  // Send a message through the real UI path and watch the reply stream in.
  await evalWeb(`(() => { const i = d.getElementById('input'); i.value = 'hello from the real editor'; i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await waitFor("the reply", () => evalWeb("d.querySelectorAll('.msg.assistant').length > 0 && !d.getElementById('send').hidden"), 30000);
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
  await waitFor("the second reply", () => evalWeb("d.querySelectorAll('.msg.assistant').length >= 2 && !d.getElementById('send').hidden"), 20000).catch(() => undefined);
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
  await waitFor("the image reply", () => evalWeb("d.querySelectorAll('.msg.assistant').length >= 3 && !d.getElementById('send').hidden"), 20000);
  const sent = await evalWeb("({ text: [...d.querySelectorAll('.msg.user')].pop()?.querySelector('.body').textContent, chips: [...d.querySelectorAll('.msg.user')].pop()?.querySelectorAll('.chip').length, thumbOk: [...d.querySelectorAll('.msg.user')].pop()?.querySelector('.sent-thumb')?.naturalWidth > 0 })");
  check("the image is sent and shown as a chip with its thumbnail", sent.chips === 1 && sent.thumbOk, JSON.stringify(sent));
  await shot("08-image-sent");

  // Profile change: a native modal confirmation (workbench dialog), then a fresh chat with the new profile.
  await evalWeb(`(() => { const s = d.getElementById('profile'); s.value = ':ask-me'; s.dispatchEvent(new w.Event('change')); return true; })()`);
  const dialog = await waitFor("the confirmation dialog", () => evalPage("(() => { const b = document.querySelector('.monaco-dialog-box'); return b ? { text: b.textContent.slice(0, 160), buttons: [...b.querySelectorAll('.dialog-buttons .monaco-button')].map(x => x.textContent.trim()) } : null; })()"), 10000);
  check("changing to :ask-me asks for confirmation in a native dialog", /ask-me/.test(dialog.text) && dialog.buttons.some((b) => /Start new chat/.test(b)), JSON.stringify(dialog.buttons));
  await shot("09-profile-dialog");
  await evalPage(`(() => { const btn = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(x => /Start new chat/.test(x.textContent)); btn.click(); return true; })()`);
  await waitFor("the new chat", () => evalWeb("d.querySelectorAll('.msg').length === 0 && d.getElementById('profile').value === ':ask-me'"), 15000);
  const asked = await evalWeb("({ footer: d.getElementById('meta').textContent.slice(0, 50), hint: d.getElementById('hint').textContent.slice(0, 40) })");
  check("after confirming, the chat restarts with the :ask-me profile", /:ask-me/.test(asked.footer) || /ask-me/.test(asked.hint), JSON.stringify(asked));
  await shot("10-ask-me");

  // Narrow layout.
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  await sleep(800);
  const narrow = await evalWeb("({ overflowX: d.documentElement.scrollWidth > d.documentElement.clientWidth, width: d.documentElement.clientWidth })");
  check("the panel does not overflow horizontally when narrow", !narrow.overflowX, JSON.stringify(narrow));
  await shot("11-narrow");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);

  // Status bar item exists in the real workbench.
  const status = await evalPage("[...document.querySelectorAll('.statusbar-item')].map(e => e.textContent.trim()).filter(t => /Antares/.test(t))");
  check("status bar shows the Antares item", status.length > 0, JSON.stringify(status));
  await shot("06-final");
} catch (error) {
  check("e2e run", false, error.message);
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
