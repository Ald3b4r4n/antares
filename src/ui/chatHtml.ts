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
    <button id="historyBtn" class="link" title="Continue or fork a stored session of this folder">History</button>
    <button id="newChat" class="link">New chat</button>
  </span>
</header>
<div id="messages">
  <div class="hero"><img src="${mediaUri("antares.svg")}" alt="">
    <div><pre class="logo">${escapeHtml(ANTARES_ASCII)}</pre><p class="tag">${escapeHtml(ANTARES_TAGLINE)}</p></div></div>
  <p class="hint" id="hint">Enter sends · Shift+Enter adds a line · / for skills · Ctrl+U adds files · paste or drop images.</p>
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
<section id="extrasPanel" class="overlay" hidden aria-label="Connectors and plugins">
  <div class="overlay-head">
    <strong id="extrasTitle">Connectors</strong>
    <span class="grow"></span>
    <span id="extrasActions" class="extras-actions"></span>
    <button id="extrasClose" class="link" aria-label="Close">Close</button>
  </div>
  <div id="extrasStatus" class="overlay-status"></div>
  <ul id="extrasList" class="session-list"></ul>
</section>
<footer>
  <div id="meta"></div>
  <div class="controls">
    <button id="modeBtn" class="mode-btn" aria-haspopup="menu" aria-expanded="false" title="Permission mode. Click, or press Shift+Tab in the message box to cycle."><span class="mode-dot" aria-hidden="true"></span><span id="modeLabel">Plan</span><span aria-hidden="true">▾</span></button>
    <label for="model">Model</label>
    <select id="model" title="Model for this chat. Takes effect on the next message."></select>
    <label for="effort">Effort</label>
    <select id="effort" title="Reasoning effort sent with each message"></select>
    <button id="changesBtn" class="link tiny" hidden title="Every file changed in this chat, with one diff per file from before the first edit">Changes</button>
    <button id="refreshUsage" class="link tiny" title="Read fresh subscription usage from Muse (no model call; at most one read per minute)">↻ Usage</button>
  </div>
  <ul id="pending" class="pending" aria-label="Queued messages" hidden></ul>
  <div id="folders" class="folders" aria-label="Folders added to this chat" hidden></div>
  <div id="modeMenu" class="menu mode-menu" role="menu" aria-label="Permission mode" hidden></div>
  <div id="sandboxNote" class="mode-note warn" role="status" hidden></div>
  <div id="modeNote" class="mode-note" hidden><span id="modeNoteText"></span> <button id="modeNoteGo" class="link tiny" hidden></button></div>
  <div id="attachments" class="attachments" hidden></div>
  <div id="voiceStatus" class="voice-status" role="status" aria-live="polite" hidden></div>
  <div id="slashMenu" class="slash-menu" role="listbox" aria-label="Skills" hidden></div>
  <div id="plusMenu" class="menu" role="menu" aria-label="Add to the message" hidden>
    <button role="menuitem" data-act="files" class="menu-item"><span>Add files or photos</span><kbd>Ctrl+U</kbd></button>
    <button role="menuitem" data-act="folder" class="menu-item"><span>Add folder</span></button>
    <button role="menuitem" data-act="slash" class="menu-item"><span>Slash commands</span><kbd>/</kbd></button>
    <button role="menuitem" data-act="connectors" class="menu-item"><span>Connectors</span></button>
    <button role="menuitem" data-act="plugins" class="menu-item"><span>Plugins</span></button>
    <button role="menuitem" data-act="importSkills" class="menu-item"><span>Import skills…</span></button>
  </div>
  <div class="composer">
    <button id="plus" class="icon-btn" title="Add files, photos or a folder, use a skill, see connectors and plugins" aria-label="Add to the message" aria-haspopup="menu" aria-expanded="false">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
    <button id="mic" class="icon-btn" title="Dictate: records from your microphone and turns it into text on your computer. The text lands in the box for you to review." aria-label="Dictate">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>
    </button>
    <textarea id="input" rows="1" placeholder="Message Muse…" aria-label="Message"></textarea>
    <button id="send" class="primary">Send</button>
    <button id="queue" class="link queue-btn" hidden title="Hold this message until the running turn ends (Ctrl+Enter)">Queue</button>
    <button id="stop" class="stop" hidden>Stop</button>
  </div>
</footer>
${preScript ? `<script nonce="${nonce}">${preScript}</script>\n` : ""}<script nonce="${nonce}" src="${mediaUri("chat.js")}"></script>
</body></html>`;
}
