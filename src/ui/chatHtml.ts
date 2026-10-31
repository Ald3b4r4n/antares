import { ANTARES_ASCII, ANTARES_TAGLINE } from "./banner.ts";

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ChatHtmlOptions {
  /** Content-Security-Policy source for styles/images (webview.cspSource, or 'self' in the preview). */
  cspSource: string;
  nonce: string;
  /** Maps a file under media/ to the URL the page should load. */
  mediaUri: (file: string) => string;
  /** Preview only: inline script that must run before chat.js (e.g. a fake acquireVsCodeApi). */
  preScript?: string;
}

/** The chat page. Pure (no vscode import) so the preview server renders the exact same markup. */
export function chatHtml(options: ChatHtmlOptions): string {
  const { cspSource, nonce, mediaUri, preScript } = options;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${mediaUri("chat.css")}">
<title>Antares</title></head><body>
<header>
  <span class="title"><b>✦</b> Antares</span>
  <span class="header-right">
    <label class="profile-label" for="profile">Profile</label>
    <select id="profile" title="Permission profile for this chat. Changing it starts a new chat."></select>
    <button id="historyBtn" class="link" title="Continue or fork a stored session of this folder">History</button>
    <button id="newChat" class="link">New chat</button>
  </span>
</header>
<div id="messages">
  <div class="hero"><img src="${mediaUri("antares.svg")}" alt="">
    <div><pre class="logo">${escapeHtml(ANTARES_ASCII)}</pre><p class="tag">${escapeHtml(ANTARES_TAGLINE)}</p></div></div>
  <p class="hint" id="hint">Enter sends · Shift+Enter adds a line · paste, drop or attach images.</p>
</div>
<section id="historyPanel" class="overlay" hidden aria-label="Session history">
  <div class="overlay-head">
    <strong>Sessions</strong>
    <input id="historySearch" type="search" placeholder="Filter by title…" aria-label="Filter sessions">
    <label class="inline"><input id="historyAll" type="checkbox"> other folders</label>
    <button id="historyClose" class="link" aria-label="Close history">Close</button>
  </div>
  <div id="historyStatus" class="overlay-status"></div>
  <ul id="historyList" class="session-list"></ul>
</section>
<footer>
  <div id="meta"></div>
  <div class="controls">
    <label for="model">Model</label>
    <select id="model" title="Model for this chat. Takes effect on the next message."></select>
    <label for="effort">Effort</label>
    <select id="effort" title="Reasoning effort sent with each message"></select>
    <button id="refreshUsage" class="link tiny" title="Read fresh subscription usage from Muse (no model call; at most one read per minute)">↻ Usage</button>
  </div>
  <div id="attachments" class="attachments" hidden></div>
  <div id="voiceStatus" class="voice-status" role="status" aria-live="polite" hidden></div>
  <input id="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
  <div class="composer">
    <button id="attach" class="icon-btn" title="Attach an image (you can also paste or drop one)" aria-label="Attach an image">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="M2 12l3.5-3.5 2.5 2.5 2.5-3L14 12" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>
    </button>
    <button id="mic" class="icon-btn" title="Dictate: records from your microphone and turns it into text on your computer. The text lands in the box for you to review." aria-label="Dictate">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>
    </button>
    <textarea id="input" rows="1" placeholder="Message Muse…" aria-label="Message"></textarea>
    <button id="send" class="primary">Send</button>
    <button id="stop" class="stop" hidden>Stop</button>
  </div>
</footer>
${preScript ? `<script nonce="${nonce}">${preScript}</script>\n` : ""}<script nonce="${nonce}" src="${mediaUri("chat.js")}"></script>
</body></html>`;
}
