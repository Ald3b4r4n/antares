import { ANTARES_ASCII, ANTARES_TAGLINE } from "./banner.ts";

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ChatHtmlOptions {
  /** Content-Security-Policy source for styles/images (webview.cspSource, or 'self' in the preview). */
  cspSource: string;
  nonce: string;
  /** Maps a file under media/ to the URL the page should load. */
  mediaUri: (file: string) => string;
  safeMode: boolean;
  /** Preview only: inline script that must run before chat.js (e.g. a fake acquireVsCodeApi). */
  preScript?: string;
}

/** The chat page. Pure (no vscode import) so the preview server renders the exact same markup. */
export function chatHtml(options: ChatHtmlOptions): string {
  const { cspSource, nonce, mediaUri, safeMode, preScript } = options;
  const hint = safeMode
    ? "Safe mode: shell and file-write tools are off in this build, and the session is read-only. Enter sends · Shift+Enter adds a line."
    : "Safe mode is OFF: the agent may use tools, but approvals are not implemented yet in this build. Enter sends · Shift+Enter adds a line.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${mediaUri("chat.css")}">
<title>Antares</title></head><body>
<header><span class="title"><b>✦</b> Antares</span><button id="newChat" class="link">New chat</button></header>
<div id="messages">
  <div class="hero"><img src="${mediaUri("antares.svg")}" alt="">
    <div><pre class="logo">${escapeHtml(ANTARES_ASCII)}</pre><p class="tag">${escapeHtml(ANTARES_TAGLINE)}</p></div></div>
  <p class="hint">${escapeHtml(hint)}</p>
</div>
<footer>
  <div id="meta"></div>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Message Muse…" aria-label="Message"></textarea>
    <button id="send" class="primary">Send</button>
    <button id="stop" class="stop" hidden>Stop</button>
  </div>
</footer>
${preScript ? `<script nonce="${nonce}">${preScript}</script>\n` : ""}<script nonce="${nonce}" src="${mediaUri("chat.js")}"></script>
</body></html>`;
}
