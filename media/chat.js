// Antares chat webview. Plain browser JS (no build step) so it can also run in the preview harness.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $("messages");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const meta = $("meta");
  const modeBtn = $("modeBtn");
  const modeMenu = $("modeMenu");
  const modeNote = $("modeNote");
  const hint = $("hint");
  const modelSel = $("model");
  const effortSel = $("effort");
  const attachmentsEl = $("attachments");
  const historyPanel = $("historyPanel");
  const historyList = $("historyList");
  const historyStatus = $("historyStatus");
  const historySearch = $("historySearch");
  const historyAll = $("historyAll");
  const plusBtn = $("plus");
  const plusMenu = $("plusMenu");
  const slashMenu = $("slashMenu");
  const queueBtn = $("queue");
  const pendingEl = $("pending");
  const foldersEl = $("folders");
  const extrasPanel = $("extrasPanel");
  const extrasTitle = $("extrasTitle");
  const extrasStatus = $("extrasStatus");
  const extrasList = $("extrasList");
  const micBtn = $("mic");
  const voiceStatus = $("voiceStatus");

  // Antares' own conservative limits (the host's are not published); the extension re-checks them.
  const IMAGE = { allowed: ["image/png", "image/jpeg", "image/gif", "image/webp"], max: 6, maxBytes: 5 * 1024 * 1024, maxTotal: 15 * 1024 * 1024, maxSide: 2048 };

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor"/></svg>';

  const state = {
    running: false,
    items: new Map(), // itemId -> { el, text, role, raf }
    tools: new Map(), // itemId -> element
    toolEvents: new Map(), // itemId -> the last toolCall event, so a patch that arrives later can redraw the card
    patches: new Map(), // itemId -> the host's patch for a file edit, as read by the extension
    images: new Map(), // workspace path -> { ok, dataUrl | reason }: images the extension read for the chat
    imageAsked: new Set(), // paths already requested, so streaming repaints do not ask again
    approvals: new Map(), // approvalId -> { el, event, decided }
    sessions: [], // stored sessions shown in the history panel
    currentSessionId: undefined,
    canFork: false,
    attachments: [], // pending images: { mediaType, base64Data, width, height, dataUrl, bytes }
    lastSent: [], // the images of the message just sent, restored if the send is refused
    sentQueue: [], // thumbnails of sent messages, matched to the host's userMessage by image count
    pending: new Map(), // turnId -> text of a message the host is holding until the running turn ends
    skills: undefined, // the host's skill list, once read (undefined = not asked yet)
    skillsError: undefined,
    skillsAsked: false, // a read is in flight or failed; the "Slash commands" menu item retries after a failure
    slash: { open: false, index: 0 },
    models: [],
    modelId: undefined, // the user's remembered choice, if any
    effort: undefined, // undefined = the model's default
    tokens: undefined,
    context: undefined,
    usage: undefined,
    ledger: undefined,
    thresholds: [80, 95],
    background: new Set(),
    turnNote: "",
    statusText: "Ready",
    profileId: undefined,
    modes: [], // the permission modes the extension offers, with the profile each one starts
    modeId: undefined,
    sandbox: undefined,
    sandboxNote: undefined, // set when the host cannot enforce its sandbox
    bypassOffered: false, // the notice that offers Bypass is shown once per chat
  };

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ---- tiny, safe markdown: fenced code, inline code, bold, paragraphs ----
  function inline(text) {
    return escapeHtml(text)
      // ![alt](path): only a placeholder here; the extension decides whether the file may be shown (hydrateImages)
      .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, '<span class="img-ref" data-path="$2">$1</span>')
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }
  function renderMarkdown(text) {
    const out = [];
    const fence = /```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) out.push(paragraphs(text.slice(last, m.index)));
      const lang = m[1] || "text";
      const code = m[2].replace(/\n$/, "");
      out.push(
        '<div class="code"><div class="code-head"><span>' + escapeHtml(lang) + "</span>" +
          '<button class="copy" data-copy="code" title="Copy code">' + COPY_ICON + '<span class="label">Copy</span></button></div>' +
          "<pre><code>" + escapeHtml(code) + "</code></pre></div>",
      );
      last = fence.lastIndex;
    }
    if (last < text.length) out.push(paragraphs(text.slice(last)));
    return out.join("");
  }
  function paragraphs(text) {
    return text
      .split(/\n{2,}/)
      .filter((p) => p.trim() !== "")
      .map((p) => "<p>" + inline(p.replace(/^\n+|\n+$/g, "")) + "</p>")
      .join("");
  }

  // ---- message elements ----
  function pinned() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  }
  function scrollDown() {
    messages.scrollTop = messages.scrollHeight;
  }
  function append(node) {
    const stick = pinned();
    messages.appendChild(node);
    if (stick) scrollDown();
  }
  function addMessage(itemId, role, text, streaming, thumbs) {
    const node = el("div", "msg " + role + (streaming ? " streaming" : ""));
    node.innerHTML =
      '<div class="msg-head"><span class="who">' + (role === "user" ? "You" : "Muse") + "</span>" +
      '<button class="copy" data-copy="message" title="Copy message">' + COPY_ICON + '<span class="label">Copy</span></button></div>' +
      '<div class="body"></div>';
    const item = { el: node, text, role, raf: 0, thumbs: thumbs || [] };
    state.items.set(itemId, item);
    paint(item);
    append(node);
    return item;
  }
  function paint(item) {
    const body = item.el.querySelector(".body");
    if (item.role === "user") renderUserBody(body, item);
    else body.innerHTML = renderMarkdown(item.text);
    hydrateImages(body);
  }

  // ---- images from the workspace: the page only asks; the extension reads the file and checks it ----
  function fillImage(span, result) {
    span.classList.remove("img-pending");
    if (result.ok) {
      const img = el("img", "inline-img");
      img.src = result.dataUrl;
      img.alt = span.textContent || span.dataset.path;
      img.title = span.dataset.path;
      span.replaceChildren(img);
    } else {
      span.classList.add("img-denied");
      span.textContent = (span.textContent || span.dataset.path) + " (image not shown: " + result.reason + ")";
    }
  }
  function hydrateImages(root) {
    for (const span of root.querySelectorAll(".img-ref:not(.img-done)")) {
      const path = span.dataset.path;
      if (!path) continue;
      const known = state.images.get(path);
      if (known) {
        span.classList.add("img-done");
        fillImage(span, known);
      } else {
        span.classList.add("img-pending");
        if (!state.imageAsked.has(path)) {
          state.imageAsked.add(path);
          vscode.postMessage({ type: "loadImage", path });
        }
      }
    }
  }
  // ---- every file changed in this chat, with one diff per file ----
  const changesBtn = $("changesBtn");
  state.changes = [];
  function onChanges(msg) {
    state.changes = msg.files || [];
    changesBtn.hidden = state.changes.length === 0;
    changesBtn.textContent = "Changes (" + state.changes.length + ")";
    if (!extrasPanel.hidden && extrasPanel.dataset.kind === "changes") renderChanges();
  }
  function renderChanges() {
    extrasList.replaceChildren();
    const rows = state.changes;
    const edits = rows.reduce((n, r) => n + r.edits, 0);
    extrasStatus.textContent = rows.length
      ? rows.length + " file" + (rows.length === 1 ? "" : "s") + " changed in " + edits + " edit" + (edits === 1 ? "" : "s") + ". Open diff compares each file before the chat's first edit with now."
      : "Nothing has been changed in this chat yet.";
    for (const r of rows) {
      const li = el("li", "session extra-row");
      const info = el("div", "session-info");
      info.append(el("div", "session-title", r.rel || r.path), el("div", "session-meta", r.edits + (r.edits === 1 ? " edit" : " edits") + " · +" + r.added + " \u2212" + r.removed));
      const actions = el("div", "session-actions");
      if (r.openable) {
        const diff = el("button", "link", "Open diff");
        diff.addEventListener("click", () => vscode.postMessage({ type: "openChanged", path: r.path, diff: true }));
        const open = el("button", "link", "Open file");
        open.addEventListener("click", () => vscode.postMessage({ type: "openChanged", path: r.path, diff: false }));
        actions.append(diff, open);
      }
      li.append(info, actions);
      extrasList.append(li);
    }
  }
  changesBtn.addEventListener("click", () => {
    extrasPanel.hidden = false;
    extrasPanel.dataset.kind = "changes";
    extrasTitle.textContent = "Changes in this chat";
    $("extrasActions").replaceChildren();
    renderChanges();
  });
  function onImage(msg) {
    state.images.set(msg.path, msg);
    hydrateImages(document);
  }
  // The host appends "[Image #n]" markers to the text of a message with images and does not send the
  // bytes back, so the markers become chips and the thumbnails are the ones kept locally.
  function renderUserBody(body, item) {
    body.replaceChildren();
    const parts = item.text.split(/(\[Image #\d+\])/);
    for (const part of parts) {
      const m = /^\[Image #(\d+)\]$/.exec(part);
      if (m) body.append(el("span", "chip", "Image " + m[1]));
      else if (part) body.append(document.createTextNode(part));
    }
    if (item.thumbs.length) {
      const row = el("div", "sent-thumbs");
      for (const t of item.thumbs) {
        const img = el("img", "sent-thumb");
        img.src = t.dataUrl;
        img.alt = "Attached image " + (t.width && t.height ? "(" + t.width + "×" + t.height + ")" : "");
        row.append(img);
      }
      body.append(row);
    }
  }
  function schedulePaint(item) {
    if (item.raf) return;
    item.raf = requestAnimationFrame(() => {
      item.raf = 0;
      const stick = pinned();
      paint(item);
      if (stick) scrollDown();
    });
  }
  function addNotice(level, text) {
    const node = el("div", "notice " + level, text);
    append(node);
    return node;
  }

  // ---- tool calls ----
  // Asks the extension to switch to Bypass permissions; it shows its own confirmation that says what that removes.
  function bypassButton() {
    const b = el("button", "link tiny", "Switch to Bypass permissions\u2026");
    b.title = "No sandbox and no approval prompts. You will be asked to confirm.";
    b.addEventListener("click", () => vscode.postMessage({ type: "setMode", modeId: "bypass" }));
    return b;
  }

  function upsertTool(e) {
    state.toolEvents.set(e.itemId, e);
    let node = state.tools.get(e.itemId);
    if (!node) {
      node = el("div", "tool");
      state.tools.set(e.itemId, node);
      append(node);
    }
    node.className = "tool " + (e.failure ? "failed" : e.status === "completed" ? "done" : "running");
    node.replaceChildren();
    const head = el("div", "tool-head");
    const patch = state.patches.get(e.itemId);
    const changed = e.file && (e.file.added !== undefined || e.file.removed !== undefined) ? "+" + (e.file.added || 0) + " \u2212" + (e.file.removed || 0) : "";
    head.append(el("span", "tool-name", e.tool), el("span", "tool-summary", patch && patch[0] && patch[0].rel ? patch[0].rel : e.summary));
    if (changed && !patch) head.append(el("span", "tool-changed", changed)); // with a patch the diff header shows the counts
    head.append(el("span", "badge", e.failure ? "failed" : e.status));
    node.append(head);
    if (e.todos && e.todos.length) node.append(todoList(e.todos));
    if (e.imagePath) {
      const slot = el("div", "tool-image");
      const ref = el("span", "img-ref", e.imagePath);
      ref.dataset.path = e.imagePath;
      slot.append(ref);
      node.append(slot);
      hydrateImages(slot);
    }
    if (e.held) node.append(el("div", "tool-note", "held" + (e.heldFor ? " for " + e.heldFor : "")));
    if (e.failure) node.append(el("div", "tool-fail", e.failure));
    if (e.failure && e.hint) {
      const hintEl = el("div", "tool-hint", e.hint);
      if (e.hintAction === "bypass") {
        hintEl.append(" ");
        hintEl.append(bypassButton());
        // Said once per chat in the message flow too, because a failed card scrolls away.
        if (!state.bypassOffered) {
          state.bypassOffered = true;
          const n = addNotice("warning", "A shell command was blocked because Muse's sandbox is unavailable. To run commands in this chat, switch the mode to Bypass permissions (no sandbox, no approval prompts).");
          if (n) {
            n.append(" ");
            n.append(bypassButton());
          }
        }
      }
      node.append(hintEl);
    }
    if (patch && !e.failure) node.append(patchBlock(e.itemId, patch));
    if (e.output) {
      const details = el("details", "tool-out");
      details.append(el("summary", "", "output"), el("pre", "", e.output));
      node.append(details);
    }
  }

  // A checklist the agent keeps (write_todos): done, in progress, to do.
  function todoList(items) {
    const list = el("ul", "todos");
    for (const t of items) {
      const mark = t.status === "completed" ? "\u2713" : t.status === "inProgress" ? "\u25B8" : "\u25CB";
      const li = el("li", "todo " + t.status);
      li.append(el("span", "todo-mark", mark), el("span", "todo-text", t.text));
      list.append(li);
    }
    return list;
  }

  // The host's own patch for a file edit: a compact inline diff, and buttons for VS Code's diff editor and the file.
  const PATCH_LINES = 60;
  function patchBlock(itemId, files) {
    const wrap = el("div", "patch");
    for (const f of files) {
      const head = el("div", "patch-head");
      head.append(el("span", "patch-path", f.rel || f.path), el("span", "tool-changed", "+" + f.added + " \u2212" + f.removed));
      if (f.openable) {
        const diffBtn = el("button", "link tiny", "Open diff");
        diffBtn.title = "Open VS Code's diff editor: this file before and after the edit";
        diffBtn.addEventListener("click", () => vscode.postMessage({ type: "openDiff", itemId, path: f.path }));
        const openBtn = el("button", "link tiny", "Open file");
        openBtn.addEventListener("click", () => vscode.postMessage({ type: "openFile", itemId, path: f.path }));
        head.append(diffBtn, openBtn);
      }
      wrap.append(head);
      const pre = el("div", "patch-lines");
      let shown = 0;
      let total = 0;
      for (const h of f.hunks) total += h.lines.length;
      for (const h of f.hunks) {
        if (shown >= PATCH_LINES) break;
        pre.append(el("div", "patch-hunk", "@@ -" + h.oldStart + "," + h.oldLines + " +" + h.newStart + "," + h.newLines + " @@"));
        for (const line of h.lines) {
          if (shown >= PATCH_LINES) break;
          const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
          pre.append(el("div", "patch-line " + kind, line));
          shown++;
        }
      }
      if (total > shown) pre.append(el("div", "patch-more", "\u2026 " + (total - shown) + " more lines" + (f.openable ? " (open the diff)" : "")));
      wrap.append(pre);
    }
    return wrap;
  }
  function onPatch(msg) {
    state.patches.set(msg.itemId, msg.files || []);
    const e = state.toolEvents.get(msg.itemId);
    if (e) upsertTool(e);
  }

  // ---- approvals ----
  function choiceClass(decision) {
    if (/^approved/.test(decision)) return "allow";
    if (/^denied|abort|timedOut/.test(decision)) return "deny";
    return "other";
  }
  function scopeLabel(scope) {
    if (scope === "session") return "for this session";
    if (scope === "localPersistent") return "saves a permanent rule";
    return "once";
  }
  // A Computer Use approval (a browser or an app being driven): the page, the window, every consequential step and
  // the data that would be sent, all as plain text. Window titles and labels are the page's own words and can lie.
  function cuaBlock(c) {
    const box = el("div", "cua");
    box.append(el("div", "approval-flag", "The agent wants to control a browser or an app. Read every step: what it clicks or types may act on your accounts."));
    if (c.page) {
      box.append(el("div", "cua-row", "Page: " + c.page.host));
      if (c.page.idn) box.append(el("div", "approval-flag", "This address uses non-ASCII characters; its plain form is " + c.page.hostAscii + ". Check it is the site you expect."));
    }
    if (c.windowTitle) box.append(el("div", "cua-row", "Window title (the page's own words): \u201C" + c.windowTitle + "\u201D"));
    if (c.steps.length) {
      const list = el("ol", "cua-steps");
      for (const s of c.steps) list.append(el("li", "", s.replace(/^Step \d+: /, "")));
      box.append(list);
    }
    if (c.data.length) {
      box.append(el("div", "cua-row", "Would send:"));
      const list = el("ul", "cua-data");
      for (const d of c.data) list.append(el("li", "", d));
      box.append(list);
    }
    return box;
  }

  function addApproval(e) {
    // The same approval id comes again for each later stage of a multi-stage approval, with a new
    // requirement: the old card is replaced, because a decision aimed at the old stage would be refused.
    const previous = state.approvals.get(e.approvalId);
    if (previous) {
      if (JSON.stringify(previous.event.requirementId) === JSON.stringify(e.requirementId)) return;
      previous.el.remove();
      state.approvals.delete(e.approvalId);
    }
    const node = el("div", "approval pending");
    const head = el("div", "approval-head");
    head.append(el("span", "approval-title", "Approval needed"), el("span", "badge", e.subject.kind));
    node.append(head);
    node.append(el("pre", "approval-subject", e.subject.summary));
    if (e.subject.detail.length) {
      const list = el("ul", "approval-detail");
      for (const line of e.subject.detail) list.append(el("li", "", line));
      node.append(list);
    }
    if (e.cua) node.append(cuaBlock(e.cua));
    if (e.subject.generic) node.append(el("div", "approval-flag", "Antares does not recognize this kind of request. Read it carefully; it is never approved automatically."));
    if (e.protectedWrite) node.append(el("div", "approval-flag", "This guards a write to a protected file. Only allow-once and reject are offered."));
    if (e.judgeEscalated) node.append(el("div", "approval-flag", "An automated reviewer passed this to you" + (e.reviewerReason ? ": " + e.reviewerReason : ".")));

    let feedback;
    if (e.choices.some((c) => c.acceptsFeedback)) {
      feedback = el("input", "approval-feedback");
      feedback.type = "text";
      feedback.placeholder = "Optional note to the model (used by choices that accept it)";
      node.append(feedback);
    }
    const choicesEl = el("div", "approval-choices");
    for (const choice of e.choices) {
      const b = el("button", "choice " + choiceClass(choice.decision));
      b.append(el("span", "choice-label", choice.label), el("span", "choice-scope", scopeLabel(choice.scope)));
      if (choice.rulePreview) b.title = choice.rulePreview;
      b.addEventListener("click", () => decide(e, choice, feedback));
      choicesEl.append(b);
      if (choice.rulePreview) choicesEl.append(el("div", "rule-preview", choice.rulePreview));
    }
    node.append(choicesEl);
    state.approvals.set(e.approvalId, { el: node, event: e, decided: false });
    append(node);
    setRunning(true, "Waiting for your approval…");
  }
  function decide(e, choice, feedbackInput) {
    const entry = state.approvals.get(e.approvalId);
    if (!entry || entry.decided) return;
    entry.decided = true;
    for (const b of entry.el.querySelectorAll("button.choice")) b.disabled = true;
    entry.el.append(el("div", "approval-sent", "Decision sent: " + choice.label));
    const feedback = choice.acceptsFeedback && feedbackInput && feedbackInput.value.trim() ? feedbackInput.value.trim() : undefined;
    vscode.postMessage({ type: "decide", approvalId: e.approvalId, choiceId: choice.choiceId, requirementId: e.requirementId, feedback });
  }
  function resolveApproval(e) {
    const entry = state.approvals.get(e.approvalId);
    if (!entry) return;
    entry.decided = true;
    entry.el.className = "approval resolved " + (e.policyResult === "allow" ? "allowed" : "denied");
    entry.el.querySelector(".approval-choices")?.remove();
    entry.el.querySelector(".approval-feedback")?.remove();
    entry.el.querySelector(".approval-sent")?.remove();
    entry.el.append(el("div", "approval-outcome", (e.policyResult === "allow" ? "Allowed" : "Denied") + " · " + e.decision + " · by " + e.resolvedBy));
    entry.el.querySelector(".approval-title").textContent = "Approval";
    if (state.running && ![...state.approvals.values()].some((a) => !a.decided)) setRunning(true, "Working…");
  }
  function closePendingApprovals() {
    for (const entry of state.approvals.values()) {
      if (entry.decided) continue;
      entry.decided = true;
      entry.el.className = "approval resolved denied";
      entry.el.querySelector(".approval-choices")?.remove();
      entry.el.querySelector(".approval-feedback")?.remove();
      entry.el.append(el("div", "approval-outcome", "No longer pending: the turn ended."));
    }
  }

  // ---- footer ----
  const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const fmtReset = (ms) => {
    if (!ms) return "";
    const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
    if (mins < 60) return " · resets in " + mins + " min";
    if (mins < 2880) return " · resets in " + Math.round(mins / 60) + " h";
    return " · resets in " + Math.round(mins / 1440) + " d";
  };
  const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // One usage window. Numbers are "as of" the host's last read, never live. A window whose reset time has
  // passed has an unknown current value, so it is shown as reset instead of a stale percentage.
  function pct(label, p, resetMs) {
    if (p === undefined) return "";
    if (resetMs !== undefined && resetMs <= Date.now()) {
      return '<span class="stale" title="This window reset at ' + clockTime(resetMs) + '. Use the refresh button to read the new value.">' + label + " reset</span>";
    }
    const t = state.thresholds;
    const cls = p >= t[t.length - 1] ? "err" : p >= t[0] ? "warn" : "";
    return '<span class="' + cls + '">' + label + " " + p + "%" + fmtReset(resetMs) + "</span>";
  }
  function usageParts() {
    const u = state.usage;
    if (!u) return [];
    const parts = [pct("5 h", u.windowPercent, u.windowResetsAtMs), pct("week", u.weeklyPercent, u.weeklyResetsAtMs)];
    if (u.observedAtMs) parts.push('<span title="Muse reported these numbers at ' + clockTime(u.observedAtMs) + '. They are not live.">as of ' + clockTime(u.observedAtMs) + "</span>");
    if (u.plan) parts.push("<span>" + escapeHtml(u.plan) + "</span>");
    return parts;
  }
  function tokenParts() {
    const bits = [];
    if (state.tokens && state.tokens.cumulativeTotal) bits.push("chat " + fmtTokens(state.tokens.cumulativeTotal));
    if (state.ledger && state.ledger.todayTokens) bits.push("today " + fmtTokens(state.ledger.todayTokens));
    if (!bits.length) return [];
    const last = state.tokens ? " Last call: " + fmtTokens(state.tokens.inputTokens) + " in, " + fmtTokens(state.tokens.outputTokens) + " out." : "";
    return ['<span title="Tokens the host reported for chats run through Antares. Not the account total: other clients and unreported background work are not counted.' + last + '">tokens ' + bits.join(" · ") + "</span>"];
  }
  function renderMeta() {
    const parts = [];
    parts.push("<span>" + escapeHtml(state.statusText) + (state.background.size ? " · background " + state.background.size : "") + "</span>");
    if (state.profileId) {
      const risky = state.profileId !== ":read-only";
      const sandboxBad = state.sandbox && state.sandbox !== "available";
      parts.push('<span class="' + (risky ? "warn" : "") + '">' + escapeHtml(state.profileId) + "</span>");
      if (state.sandbox) parts.push('<span class="' + (sandboxBad && risky ? "warn" : "") + '" title="Reported by the Muse host at startup">sandbox ' + escapeHtml(state.sandbox) + "</span>");
    }
    const model = currentModel();
    if (model) parts.push("<span>" + escapeHtml(model.label) + (state.effort ? " · " + escapeHtml(state.effort) : "") + "</span>");
    if (state.context) {
      const c = state.context;
      const p = c.windowTokens ? Math.round((c.usedTokens / c.windowTokens) * 100) : 0;
      parts.push("<span>context " + fmtTokens(c.usedTokens) + " / " + fmtTokens(c.windowTokens) + " (" + p + "%)</span>");
    }
    parts.push(...tokenParts());
    parts.push(...usageParts());
    if (state.turnNote) parts.push("<span>" + escapeHtml(state.turnNote) + "</span>");
    meta.innerHTML = parts.filter(Boolean).join("");
  }
  // ---- model and effort ----
  // The shown model is the remembered choice if the catalog still has it, else the host's active
  // model, else the catalog default, else the first row.
  function currentModel() {
    const byId = (id) => state.models.find((m) => m.modelId === id);
    return (state.modelId && byId(state.modelId)) || state.models.find((m) => m.isActive) || state.models.find((m) => m.isDefault) || state.models[0];
  }
  function renderModelControls() {
    modelSel.replaceChildren();
    effortSel.replaceChildren();
    if (state.models.length === 0) {
      const none = el("option", "", "No models (log in with the official client)");
      none.value = "";
      modelSel.append(none);
      modelSel.disabled = true;
      effortSel.disabled = true;
      return;
    }
    const model = currentModel();
    for (const m of state.models) {
      const ctx = m.contextLimit ? " · " + fmtTokens(m.contextLimit) + " ctx" : "";
      const opt = el("option", "", m.label + ctx);
      opt.value = m.modelId;
      modelSel.append(opt);
    }
    modelSel.value = model.modelId;
    const dflt = el("option", "", "Default" + (model.defaultReasoningEffort ? " (" + model.defaultReasoningEffort + ")" : ""));
    dflt.value = "";
    effortSel.append(dflt);
    for (const tier of model.variants) {
      const opt = el("option", "", tier);
      opt.value = tier;
      if (model.effortNotes[tier]) opt.title = model.effortNotes[tier];
      effortSel.append(opt);
    }
    effortSel.value = state.effort && model.variants.includes(state.effort) ? state.effort : "";
    modelSel.disabled = state.running;
    effortSel.disabled = state.running || model.variants.length === 0;
  }
  modelSel.addEventListener("change", () => {
    if (modelSel.value) vscode.postMessage({ type: "setModel", modelId: modelSel.value });
  });
  effortSel.addEventListener("change", () => {
    vscode.postMessage({ type: "setEffort", effort: effortSel.value || undefined });
  });

  function setRunning(running, text) {
    state.running = running;
    state.statusText = text;
    modelSel.disabled = running || state.models.length === 0;
    effortSel.disabled = running || state.models.length === 0;
    // While a turn runs the box stays usable: Enter steers it, Ctrl+Enter queues the message.
    sendBtn.textContent = running ? "Steer" : "Send";
    sendBtn.title = running ? "Add this to the running turn (Enter)" : "";
    queueBtn.hidden = !running;
    stopBtn.hidden = !running;
    input.placeholder = running ? "Enter steers the running turn · Ctrl+Enter queues" : "Message Muse…  (/ for skills)";
    renderMeta();
  }

  // ---- permission mode ----
  const currentMode = () => state.modes.find((m) => m.id === state.modeId);
  function applyConfig(msg) {
    state.profileId = msg.profileId;
    state.modeId = msg.modeId;
    state.modes = msg.modes || [];
    state.modelId = msg.modelId;
    state.effort = msg.effort;
    if (msg.usage) state.usage = msg.usage;
    if (msg.ledger) state.ledger = msg.ledger;
    if (Array.isArray(msg.thresholds) && msg.thresholds.length) state.thresholds = msg.thresholds;
    renderModelControls();
    renderModes();
    hint.textContent = "Enter sends · Shift+Enter adds a line · Shift+Tab changes the mode · / for skills · Ctrl+U adds files · paste or drop images.";
    renderMeta();
  }
  function renderModes() {
    const mode = currentMode();
    $("modeLabel").textContent = mode ? mode.label : state.profileId || "Mode";
    modeBtn.title = (mode ? mode.label + " (" + state.profileId + "): " + mode.note + " · " : "") + "Click to choose a mode, or press Shift+Tab in the message box to cycle.";
    modeBtn.classList.toggle("risky", !!mode && mode.id === "bypass");
    modeBtn.classList.toggle("elevated", !!mode && (mode.id === "auto" || mode.id === "acceptEdits"));
    modeMenu.replaceChildren();
    for (const m of state.modes) {
      const item = el("button", "menu-item mode-item" + (m.unavailable ? " unavailable" : "") + (m.id === state.modeId ? " current" : ""));
      item.setAttribute("role", "menuitem");
      item.dataset.mode = m.id;
      item.title = m.unavailable ? m.note + " " + m.unavailable : m.note;
      const text = el("span", "mode-text");
      text.append(el("span", "mode-name", (m.id === state.modeId ? "✓ " : "") + m.label), el("span", "mode-short", m.short));
      item.append(text, el("kbd", "", String(m.shortcut)));
      modeMenu.append(item);
    }
    // Plan is a way to look before acting: offer the step that carries the plan out.
    const accept = state.modes.find((m) => m.id === "acceptEdits");
    const inPlan = state.modeId === "plan" && !!accept && !accept.unavailable;
    // A mode that runs commands inside the sandbox cannot run them when the host has none: say so up front.
    const sandboxNoteEl = $("sandboxNote");
    const needsSandbox = !!state.sandboxNote && (state.modeId === "acceptEdits" || state.modeId === "auto");
    sandboxNoteEl.hidden = !needsSandbox;
    if (needsSandbox) {
      sandboxNoteEl.textContent = state.sandboxNote + " ";
      sandboxNoteEl.append(bypassButton());
    }
    modeNote.hidden = !inPlan;
    if (inPlan) {
      $("modeNoteText").textContent = "Plan mode: Muse can read but not change anything. Ask for a plan (try /plan), then carry it out in Accept edits.";
      const go = $("modeNoteGo");
      go.hidden = false;
      go.textContent = "Switch to Accept edits";
      go.onclick = () => vscode.postMessage({ type: "setMode", modeId: "acceptEdits" });
    }
  }
  const modeItems = () => [...modeMenu.querySelectorAll(".menu-item")];
  function openModeMenu() {
    closeMenus();
    modeMenu.hidden = false;
    modeBtn.setAttribute("aria-expanded", "true");
    const current = modeItems().find((i) => i.classList.contains("current")) || modeItems()[0];
    if (current) current.focus();
  }
  function closeModeMenu() {
    modeMenu.hidden = true;
    modeBtn.setAttribute("aria-expanded", "false");
  }
  function chooseMode(id) {
    closeModeMenu();
    vscode.postMessage({ type: "setMode", modeId: id });
    input.focus();
  }
  modeBtn.addEventListener("click", () => (modeMenu.hidden ? openModeMenu() : closeModeMenu()));
  modeMenu.addEventListener("click", (ev) => {
    const item = ev.target.closest(".menu-item");
    if (item) chooseMode(item.dataset.mode);
  });
  modeMenu.addEventListener("keydown", (ev) => {
    const items = modeItems();
    const at = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      items[(at + 1) % items.length].focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(at - 1 + items.length) % items.length].focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeModeMenu();
      modeBtn.focus();
    } else if (/^[1-9]$/.test(ev.key)) {
      const m = state.modes.find((x) => x.shortcut === Number(ev.key));
      if (m) {
        ev.preventDefault();
        chooseMode(m.id);
      }
    }
  });
  document.addEventListener("click", (ev) => {
    if (!modeMenu.hidden && !modeMenu.contains(ev.target) && !modeBtn.contains(ev.target)) closeModeMenu();
  });

  // ---- events from the extension ----
  function onEvent(e) {
    switch (e.type) {
      case "turnStarted":
        state.turnNote = "";
        state.background.clear();
        removePending(e.turnId); // a held message has launched
        setRunning(true, "Thinking…");
        break;
      case "submitted":
        // The host held the message (queued) until the running turn ends; show it where it can be taken back.
        if (e.disposition === "queued") addPending(e.turnId, e.text);
        else if (e.disposition === "steered") addNotice("info", "Added to the running turn.");
        break;
      case "unqueued":
        removePending(e.turnId);
        break;
      case "host":
        state.sandbox = e.sandbox;
        state.sandboxNote = e.sandboxNote;
        renderModes();
        renderMeta();
        break;
      case "userMessage": {
        // Count images by the "[Image #n]" markers as well: an ephemeral host sends the markers but an empty
        // attachments list.
        const count = Math.max((e.text.match(/\[Image #\d+\]/g) || []).length, (e.attachments || []).filter((a) => a.type === "image").length);
        const at = count ? state.sentQueue.findIndex((q) => q.length === count) : -1;
        const thumbs = at >= 0 ? state.sentQueue.splice(at, 1)[0] : [];
        addMessage(e.itemId, "user", e.text, false, thumbs);
        break;
      }
      case "assistantStarted":
        addMessage(e.itemId, "assistant", "", true);
        setRunning(true, "Responding…");
        break;
      case "assistantDelta": {
        const item = state.items.get(e.itemId) || addMessage(e.itemId, "assistant", "", true);
        item.text += e.delta;
        schedulePaint(item);
        break;
      }
      case "assistantCompleted": {
        const item = state.items.get(e.itemId) || addMessage(e.itemId, "assistant", "", false);
        item.text = e.text || item.text;
        item.el.classList.remove("streaming");
        paint(item);
        break;
      }
      case "toolCall":
        upsertTool(e);
        break;
      case "approvalRequested":
        addApproval(e);
        break;
      case "approvalResolved":
        resolveApproval(e);
        break;
      case "foregroundCompleted":
        setRunning(true, "Finishing background tasks…");
        break;
      case "turnCompleted": {
        const secs = e.durationMs ? (e.durationMs / 1000).toFixed(1) + " s" : "";
        const ttft = e.timeToFirstTokenMs ? " · first token " + (e.timeToFirstTokenMs / 1000).toFixed(1) + " s" : "";
        state.turnNote = secs ? "last turn " + secs + ttft : "";
        if (e.terminal !== "completed") {
          let text = (e.errorMessage || e.reason || "The turn ended: " + e.terminal) + "";
          if (e.errorKind === "authRequired") text += "\nLog in with the official Muse client (run `muse` and use /login), then try again.";
          addNotice(e.terminal === "cancelled" || e.terminal === "interrupted" ? "info" : "error", text);
        }
        for (const item of state.items.values()) item.el.classList.remove("streaming");
        closePendingApprovals();
        state.background.clear();
        setRunning(false, "Ready");
        input.focus();
        vscode.postMessage({
          type: "rendered",
          messages: messages.querySelectorAll(".msg").length,
          userMessages: messages.querySelectorAll(".msg.user").length,
          codeBlocks: messages.querySelectorAll(".code").length,
          copyButtons: messages.querySelectorAll("button.copy").length,
        });
        break;
      }
      case "session":
        state.currentSessionId = e.sessionId;
        state.sandbox = e.sandbox;
        if (e.profileId) state.profileId = e.profileId;
        renderMeta();
        break;
      case "tokens":
        state.tokens = e;
        renderMeta();
        break;
      case "context":
        state.context = e;
        renderMeta();
        break;
      case "usage":
        for (const [k, v] of Object.entries(e)) if (v !== undefined) (state.usage = state.usage || {})[k] = v;
        renderMeta();
        break;
      case "ledger":
        state.ledger = e;
        renderMeta();
        break;
      case "models":
        state.models = e.models;
        renderModelControls();
        renderMeta();
        break;
      case "activity":
        if (e.status === "started") state.background.add(e.itemId);
        else state.background.delete(e.itemId);
        renderMeta();
        break;
      case "history":
        // A stored conversation is redrawn without touching the running/ready state.
        for (const past of e.events) onEvent(past);
        if (e.note) addNotice("info", e.note);
        else if (e.events.length === 0) addNotice("info", "This session has no earlier messages to show.");
        break;
      case "notice":
        addNotice(e.level, e.text);
        // A refused send must not eat the user's images: put them back.
        if (e.level === "error" && state.sentQueue.length && state.attachments.length === 0) {
          state.attachments = state.lastSent;
          state.sentQueue.length = 0;
          renderAttachments();
        }
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "config") applyConfig(msg);
    else if (msg.type === "sessions") showSessions(msg);
    else if (msg.type === "voice") onVoiceState(msg);
    else if (msg.type === "voiceResult") onVoiceResult(msg);
    else if (msg.type === "voiceError") onVoiceError(msg);
    else if (msg.type === "picked") onPicked(msg);
    else if (msg.type === "patch") onPatch(msg);
    else if (msg.type === "image") onImage(msg);
    else if (msg.type === "changes") onChanges(msg);
    else if (msg.type === "folders") renderFolders(msg.folders || []);
    else if (msg.type === "skills") onSkills(msg);
    else if (msg.type === "extras") onExtras(msg);
    else if (msg.type === "reset") {
      closeHistory();
      closeExtras();
      closeMenus();
      state.pending.clear();
      state.toolEvents.clear();
      state.bypassOffered = false;
      state.patches.clear();
      state.changes = [];
      changesBtn.hidden = true;
      state.images.clear();
      state.imageAsked.clear();
      renderPending();
      state.skills = undefined;
      state.skillsError = undefined;
      state.skillsAsked = false;
      for (const node of messages.querySelectorAll(".msg, .notice, .tool, .approval")) node.remove();
      state.items.clear();
      state.attachments = [];
      state.sentQueue.length = 0;
      renderAttachments();
      state.tools.clear();
      state.approvals.clear();
      state.tokens = state.context = undefined;
      state.sandbox = state.sandboxNote = undefined; // the next host reports it again
      state.turnNote = "";
      setRunning(false, "Ready");
    } else if (msg.type === "copied") {
      const btn = document.querySelector('[data-copy-pending="1"]');
      if (btn) {
        btn.removeAttribute("data-copy-pending");
        btn.classList.add("done");
        const label = btn.querySelector(".label");
        if (label) label.textContent = "Copied";
        setTimeout(() => {
          btn.classList.remove("done");
          if (label) label.textContent = "Copy";
        }, 1400);
      }
    }
  });

  // ---- copy buttons (delegated) ----
  messages.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button.copy");
    if (!btn) return;
    let text = "";
    if (btn.dataset.copy === "code") {
      const code = btn.closest(".code").querySelector("code");
      text = code ? code.textContent : "";
    } else {
      const msgEl = btn.closest(".msg");
      for (const item of state.items.values()) if (item.el === msgEl) text = item.text;
    }
    document.querySelectorAll("[data-copy-pending]").forEach((b) => b.removeAttribute("data-copy-pending"));
    btn.setAttribute("data-copy-pending", "1");
    vscode.postMessage({ type: "copy", text });
  });

  // ---- session history: continue or fork a stored session of this folder ----
  function agoText(ms) {
    if (!ms) return "";
    const diff = Date.now() - ms;
    if (diff < 60000) return "just now";
    const mins = Math.round(diff / 60000);
    if (mins < 60) return mins + " min ago";
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + " h ago";
    const days = Math.round(hours / 24);
    return days === 1 ? "yesterday" : days < 14 ? days + " d ago" : new Date(ms).toLocaleDateString();
  }
  function openHistory() {
    historyPanel.hidden = false;
    historyStatus.textContent = "Loading…";
    historyList.replaceChildren();
    vscode.postMessage({ type: "listSessions" });
    historySearch.focus();
  }
  function closeHistory() {
    historyPanel.hidden = true;
  }
  function showSessions(msg) {
    state.sessions = msg.sessions || [];
    state.currentSessionId = msg.currentSessionId || state.currentSessionId;
    state.canFork = !!msg.canFork;
    if (msg.error) {
      historyStatus.textContent = "Could not list sessions: " + msg.error;
      historyList.replaceChildren();
      return;
    }
    renderSessions();
  }
  function renderSessions() {
    const q = historySearch.value.trim().toLowerCase();
    const showOthers = historyAll.checked;
    const rows = state.sessions.filter((s) => (showOthers || s.sameWorkspace) && (!q || s.title.toLowerCase().includes(q)));
    historyList.replaceChildren();
    const hidden = state.sessions.filter((s) => !s.sameWorkspace).length;
    const hiddenNote = !showOthers && hidden ? " " + (hidden === 1 ? "1 session in another folder is hidden." : hidden + " sessions in other folders are hidden.") : "";
    historyStatus.textContent = rows.length
      ? rows.length + " session" + (rows.length === 1 ? "" : "s") + "." + hiddenNote
      : state.sessions.length ? "No session matches." + hiddenNote : "No stored sessions yet.";
    for (const s of rows) {
      const li = el("li", "session" + (s.sessionId === state.currentSessionId ? " current" : ""));
      const info = el("div", "session-info");
      info.append(el("div", "session-title", s.title));
      const bits = [agoText(s.updatedAtMs), s.turnCount + (s.turnCount === 1 ? " turn" : " turns")];
      if (s.modelId) bits.push(s.modelId);
      if (s.forked) bits.push("fork");
      if (s.sessionId === state.currentSessionId) bits.push("this chat");
      if (!s.sameWorkspace && s.workspaceRoot) bits.push(s.workspaceRoot);
      info.append(el("div", "session-meta", bits.filter(Boolean).join(" · ")));
      const actions = el("div", "session-actions");
      const open = el("button", "link", "Continue");
      const fork = el("button", "link", "Fork");
      if (!s.sameWorkspace) {
        open.disabled = true;
        fork.disabled = true;
        open.title = "This session belongs to another folder. Open that folder to continue it.";
        fork.title = open.title;
      } else if (s.sessionId === state.currentSessionId) {
        open.disabled = true;
        open.title = "This is the current chat.";
      }
      if (!state.canFork && s.sameWorkspace) {
        fork.disabled = true;
        fork.title = "A fork cannot be given a permission profile, so forking is only offered in Read-only chats.";
      }
      open.addEventListener("click", () => {
        closeHistory();
        vscode.postMessage({ type: "openSession", sessionId: s.sessionId, mode: "resume" });
      });
      fork.addEventListener("click", () => {
        closeHistory();
        vscode.postMessage({ type: "openSession", sessionId: s.sessionId, mode: "fork" });
      });
      actions.append(open, fork);
      li.append(info, actions);
      historyList.append(li);
    }
  }
  $("historyBtn").addEventListener("click", openHistory);
  $("historyClose").addEventListener("click", closeHistory);
  historySearch.addEventListener("input", renderSessions);
  historyAll.addEventListener("change", renderSessions);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !historyPanel.hidden) closeHistory();
  });

  // ---- voice dictation. The extension host records (the editor denies the webview the microphone) and
  // transcribes locally; the page only shows the state and receives the text. ----
  let voiceTimer;
  const engineName = (id) => (id === "windows" ? "Windows speech" : "faster-whisper");
  function onVoiceState(msg) {
    clearInterval(voiceTimer);
    micBtn.classList.toggle("recording", msg.state === "recording");
    micBtn.classList.toggle("busy", msg.state === "transcribing");
    micBtn.setAttribute("aria-pressed", String(msg.state === "recording"));
    if (msg.state === "recording") {
      const tick = () => {
        const s = Math.floor((Date.now() - (msg.startedAt || Date.now())) / 1000);
        voiceStatus.textContent = "Recording " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " (" + engineName(msg.engine) + "). Click the microphone to stop, Esc to cancel.";
      };
      tick();
      voiceTimer = setInterval(tick, 500);
      voiceStatus.hidden = false;
    } else if (msg.state === "transcribing") {
      voiceStatus.textContent = "Transcribing on your computer (" + engineName(msg.engine) + ")…";
      voiceStatus.hidden = false;
    } else {
      voiceStatus.hidden = true;
      voiceStatus.textContent = "";
    }
  }
  function onVoiceResult(msg) {
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const sep = before && !/\s$/.test(before) ? " " : "";
    input.value = before + sep + msg.text + after;
    const caret = (before + sep + msg.text).length;
    input.setSelectionRange(caret, caret);
    autosize();
    input.focus();
    if (msg.note) addNotice("info", msg.note);
  }
  function onVoiceError(msg) {
    const node = el("div", "notice warning", msg.message);
    if (msg.canSetup) {
      const b = el("button", "link", "Set up local voice");
      b.style.marginLeft = "10px";
      b.addEventListener("click", () => vscode.postMessage({ type: "voice", action: "setup" }));
      node.append(b);
    }
    append(node);
  }
  micBtn.addEventListener("click", () => vscode.postMessage({ type: "voice", action: "toggle" }));
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && micBtn.classList.contains("recording")) vscode.postMessage({ type: "voice", action: "cancel" });
  });

  // ---- composer ----
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }
  // `mode` only matters while a turn runs: "steer" folds the message into it, "queue" holds it.
  function send(mode) {
    const text = input.value.trim();
    const images = state.attachments;
    if (!text && images.length === 0) return;
    closeMenus();
    input.value = "";
    autosize();
    if (images.length) {
      state.lastSent = images;
      state.sentQueue.push(images.map((a) => ({ dataUrl: a.dataUrl, width: a.width, height: a.height })));
    }
    state.attachments = [];
    renderAttachments();
    vscode.postMessage({
      type: "send",
      text,
      mode: state.running ? mode || "steer" : undefined,
      images: images.length ? images.map((a) => ({ mediaType: a.mediaType, base64Data: a.base64Data, width: a.width, height: a.height })) : undefined,
    });
  }

  // ---- the "+" menu ----
  const menuItems = () => [...plusMenu.querySelectorAll(".menu-item")];
  function closeMenus() {
    closeModeMenu();
    plusMenu.hidden = true;
    plusBtn.setAttribute("aria-expanded", "false");
    closeSlash();
  }
  function openPlusMenu() {
    closeSlash();
    plusMenu.hidden = false;
    plusBtn.setAttribute("aria-expanded", "true");
    const first = menuItems()[0];
    if (first) first.focus();
  }
  plusBtn.addEventListener("click", () => (plusMenu.hidden ? openPlusMenu() : closeMenus()));
  plusMenu.addEventListener("keydown", (ev) => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      items[(at + 1) % items.length].focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(at - 1 + items.length) % items.length].focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenus();
      plusBtn.focus();
    }
  });
  plusMenu.addEventListener("click", (ev) => {
    const item = ev.target.closest(".menu-item");
    if (!item) return;
    const act = item.dataset.act;
    closeMenus();
    if (act === "files") vscode.postMessage({ type: "pickFiles" });
    else if (act === "folder") vscode.postMessage({ type: "addFolder" });
    else if (act === "currentFile") vscode.postMessage({ type: "addCurrentFile" });
    else if (act === "selection") vscode.postMessage({ type: "addSelection" });
    else if (act === "slash") {
      if (state.skillsError) {
        state.skillsAsked = false;
        state.skillsError = undefined;
      }
      if (!input.value.startsWith("/")) input.value = "/" + input.value;
      input.focus();
      input.setSelectionRange(1, 1);
      updateSlash();
    } else if (act === "connectors") openExtras("connectors");
    else if (act === "plugins") openExtras("plugins");
    else if (act === "importSkills") vscode.postMessage({ type: "importSkills" });
  });
  document.addEventListener("click", (ev) => {
    if (!plusMenu.hidden && !plusMenu.contains(ev.target) && !plusBtn.contains(ev.target)) closeMenus();
  });
  // Ctrl+U adds files or photos, as in the other assistants' composers.
  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "u") {
      ev.preventDefault();
      vscode.postMessage({ type: "pickFiles" });
    }
  });

  // What the extension host picked: photos become attachments (so they get the same checks and scaling as a
  // pasted one), other files become @mentions in the text, and the rest is explained.
  const fileFromBase64 = (name, mediaType, b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mediaType });
  };
  function onPicked(msg) {
    for (const s of msg.skipped || []) addNotice("warning", s);
    if ((msg.mentions || []).length) {
      const base = input.value;
      const missing = msg.mentions.filter((m) => !base.includes(m));
      if (missing.length) {
        input.value = (base === "" || /\s$/.test(base) ? base : base + " ") + missing.join(" ") + " ";
        autosize();
      }
      input.focus();
    }
    if (msg.snippet) {
      const base2 = input.value;
      input.value = (base2 === "" || /\s$/.test(base2) ? base2 : base2 + "\n") + msg.snippet;
      autosize();
      input.focus();
    }
    const files = (msg.images || []).map((i) => fileFromBase64(i.name, i.mediaType, i.base64Data));
    if (files.length) void addFiles(files);
  }

  // ---- folders added to this chat ----
  function renderFolders(folders) {
    foldersEl.replaceChildren();
    foldersEl.hidden = folders.length === 0;
    for (const path of folders) {
      const chip = el("div", "folder-chip");
      chip.title = path + " — the agent's file tools can reach this folder in this chat";
      const label = el("span", "", path);
      const remove = el("button", "", "×");
      remove.title = "Remove this folder from the chat (applies from the next message)";
      remove.setAttribute("aria-label", "Remove folder " + path);
      remove.addEventListener("click", () => vscode.postMessage({ type: "removeFolder", path }));
      chip.append(label, remove);
      foldersEl.append(chip);
    }
  }

  // ---- messages the host is holding (queue) ----
  function addPending(turnId, text) {
    state.pending.set(turnId, text);
    renderPending();
  }
  function removePending(turnId) {
    if (state.pending.delete(turnId)) renderPending();
  }
  function renderPending() {
    pendingEl.replaceChildren();
    pendingEl.hidden = state.pending.size === 0;
    for (const [turnId, text] of state.pending) {
      const li = el("li", "");
      li.append(el("span", "badge", "queued"));
      li.append(el("span", "pending-text", text));
      const undo = el("button", "link tiny", "Remove");
      undo.title = "Take this message back before it starts";
      undo.addEventListener("click", () => vscode.postMessage({ type: "unqueue", turnId }));
      li.append(undo);
      pendingEl.append(li);
    }
  }

  // ---- slash palette: "/" at the start of the message lists the host's skills ----
  const slashQuery = () => {
    const m = /^\/([^\s]*)$/.exec(input.value);
    return m ? m[1] : undefined;
  };
  function closeSlash() {
    state.slash.open = false;
    slashMenu.hidden = true;
  }
  function slashRows() {
    const q = (slashQuery() || "").toLowerCase();
    const all = state.skills || [];
    if (!q) return all;
    const starts = all.filter((s) => s.selector.toLowerCase().startsWith(q));
    const rest = all.filter((s) => !s.selector.toLowerCase().startsWith(q) && (s.selector + " " + s.displayName + " " + s.description).toLowerCase().includes(q));
    return starts.concat(rest);
  }
  function updateSlash() {
    if (slashQuery() === undefined) {
      closeSlash();
      return;
    }
    plusMenu.hidden = true;
    state.slash.open = true;
    slashMenu.hidden = false;
    if (state.skills === undefined && !state.skillsAsked) {
      state.skillsAsked = true;
      vscode.postMessage({ type: "listSkills" });
    }
    renderSlash();
  }
  function renderSlash() {
    slashMenu.replaceChildren();
    if (state.skills === undefined) {
      slashMenu.append(el("div", "slash-empty", state.skillsError ? "Could not read the skills: " + state.skillsError : "Reading the skills from Muse…"));
      return;
    }
    const rows = slashRows();
    if (rows.length === 0) {
      slashMenu.append(el("div", "slash-empty", "No skill matches. A message starting with / that is not a skill is sent as plain text."));
      return;
    }
    state.slash.index = Math.min(state.slash.index, rows.length - 1);
    rows.forEach((s, i) => {
      const row = el("div", "slash-item" + (i === state.slash.index ? " active" : ""));
      row.setAttribute("role", "option");
      row.append(el("span", "slash-name", "/" + s.selector));
      if (s.argumentHint) row.append(el("span", "slash-hint", s.argumentHint));
      row.append(el("span", "badge", s.source));
      if (s.description) row.append(el("span", "slash-desc", s.description));
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        pickSkill(s);
      });
      slashMenu.append(row);
    });
    const active = slashMenu.querySelector(".slash-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function pickSkill(skill) {
    input.value = "/" + skill.selector + " ";
    autosize();
    closeSlash();
    input.focus();
  }
  function onSkills(msg) {
    if (msg.error) {
      state.skills = undefined;
      state.skillsError = msg.error;
    } else {
      state.skills = msg.skills || [];
      state.skillsError = undefined;
    }
    if (state.slash.open) renderSlash();
  }

  // ---- connectors and plugins: a read-only look at what the host has ----
  function openExtras(kind) {
    extrasPanel.hidden = false;
    extrasPanel.dataset.kind = kind;
    extrasTitle.textContent = kind === "connectors" ? "Connectors (MCP servers)" : "Plugins";
    extrasStatus.textContent = "Reading from Muse…";
    extrasList.replaceChildren();
    const actions = $("extrasActions");
    actions.replaceChildren();
    if (kind === "plugins") {
      const add = (label, title, message) => {
        const b = el("button", "link tiny", label);
        b.title = title;
        b.addEventListener("click", () => vscode.postMessage(message));
        actions.append(b);
      };
      add("Install from folder…", "Check a plugin folder with Muse, see what it brings, then install it", { type: "installPlugin", from: "folder" });
      add("Install from marketplace…", "Pick a plugin a configured marketplace offers", { type: "installPlugin", from: "marketplace" });
      add("Add marketplace…", "Add a catalog to install from (installs nothing by itself)", { type: "addMarketplace" });
    }
    vscode.postMessage({ type: kind === "connectors" ? "listConnectors" : "listPlugins" });
  }
  function closeExtras() {
    extrasPanel.hidden = true;
  }
  function onExtras(msg) {
    if (extrasPanel.hidden || extrasPanel.dataset.kind !== msg.kind) return;
    if (msg.progress) {
      // A sign-in is under way: say so (the list stays), with a way to stop waiting.
      extrasStatus.textContent = msg.progress + " ";
      if (msg.cancellable) {
        const stop = el("button", "link tiny", "Cancel");
        stop.addEventListener("click", () => vscode.postMessage({ type: "connectorCancel" }));
        extrasStatus.append(stop);
      }
      for (const b of extrasList.querySelectorAll("button")) b.disabled = true;
      return;
    }
    extrasList.replaceChildren();
    if (msg.error) {
      extrasStatus.textContent = "Could not read the list: " + msg.error;
      return;
    }
    const rows = msg.rows || [];
    const noun = msg.kind === "connectors" ? "connector" : "plugin";
    const how = msg.kind === "connectors"
      ? "Sign in and out here; Muse runs the sign-in and keeps the credential. Adding or removing a connector is done in Muse's own configuration."
      : "Installing runs nothing by itself, but a plugin can bring hooks and servers that do: you see what it brings first.";
    extrasStatus.textContent = rows.length
      ? rows.length + " " + noun + (rows.length === 1 ? "" : "s") + ". " + how
      : "No " + noun + "s are set up in Muse. " + how;
    for (const r of rows) {
      const li = el("li", "session extra-row");
      const info = el("div", "session-info");
      info.append(el("div", "session-title", msg.kind === "connectors" ? r.name : r.id));
      const badges = el("div", "extra-badges");
      if (msg.kind === "connectors") {
        info.append(el("div", "session-meta", "from " + r.source));
        badges.append(el("span", "badge", r.transport), el("span", "badge", r.oauth === "loggedIn" ? "signed in" : r.oauth === "loggedOut" ? "signed out" : "no sign-in"));
        // Only servers the host can resolve by name (settings or a plugin) can be signed in or out.
        if (r.source !== "session" && (r.oauth === "loggedOut" || r.oauth === "loggedIn")) {
          const out = r.oauth === "loggedIn";
          const b = el("button", "link tiny", out ? "Sign out" : "Sign in");
          b.addEventListener("click", () => vscode.postMessage({ type: out ? "connectorSignOut" : "connectorSignIn", server: r.name }));
          badges.append(b);
        }
      } else {
        info.append(el("div", "session-meta", "version " + (r.version || "unknown") + " · " + r.source));
        badges.append(el("span", "badge", r.enabled ? "enabled" : "disabled"));
      }
      li.append(info, badges);
      extrasList.append(li);
    }
  }
  $("extrasClose").addEventListener("click", closeExtras);

  // ---- image attachments: paste, drop, or the attach button ----
  const approxBytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  const readDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  const loadImage = (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("not an image"));
      img.src = dataUrl;
    });

  async function toAttachment(file) {
    let dataUrl = await readDataUrl(file);
    const img = await loadImage(dataUrl);
    let { naturalWidth: width, naturalHeight: height } = img;
    // Large images are scaled down (PNG) before sending; small ones are sent untouched.
    if (Math.max(width, height) > IMAGE.maxSide) {
      const scale = IMAGE.maxSide / Math.max(width, height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/png");
      width = canvas.width;
      height = canvas.height;
    }
    const comma = dataUrl.indexOf(",");
    const mediaType = dataUrl.slice(5, dataUrl.indexOf(";"));
    const base64Data = dataUrl.slice(comma + 1);
    return { mediaType, base64Data, width, height, dataUrl, bytes: approxBytes(base64Data) };
  }

  async function addFiles(files) {
    for (const file of files) {
      if (state.attachments.length >= IMAGE.max) {
        addNotice("warning", "At most " + IMAGE.max + " images can be sent in one message.");
        break;
      }
      if (!IMAGE.allowed.includes(file.type)) {
        addNotice("warning", (file.name || "That file") + " is not a PNG, JPEG, GIF or WebP image.");
        continue;
      }
      try {
        const att = await toAttachment(file);
        const total = state.attachments.reduce((n, a) => n + a.bytes, 0) + att.bytes;
        if (att.bytes > IMAGE.maxBytes) addNotice("warning", "That image is too large (" + (att.bytes / 1048576).toFixed(1) + " MB; the limit is " + IMAGE.maxBytes / 1048576 + " MB).");
        else if (total > IMAGE.maxTotal) addNotice("warning", "The images together are too large (the limit is " + IMAGE.maxTotal / 1048576 + " MB).");
        else state.attachments.push(att);
      } catch {
        addNotice("warning", (file.name || "That file") + " could not be read as an image.");
      }
    }
    renderAttachments();
  }

  function renderAttachments() {
    attachmentsEl.replaceChildren();
    attachmentsEl.hidden = state.attachments.length === 0;
    state.attachments.forEach((a, i) => {
      const box = el("div", "thumb");
      const img = el("img");
      img.src = a.dataUrl;
      img.alt = "Image " + (i + 1);
      const remove = el("button", "thumb-remove", "×");
      remove.title = "Remove image";
      remove.setAttribute("aria-label", "Remove image " + (i + 1));
      remove.addEventListener("click", () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      box.append(img, remove, el("span", "thumb-dims", a.width + "×" + a.height));
      attachmentsEl.append(box);
    });
  }

  const imageFiles = (list) => [...(list || [])].filter((f) => f && f.type && f.type.startsWith("image/"));
  input.addEventListener("paste", (ev) => {
    const cd = ev.clipboardData;
    if (!cd) return;
    const files = [...cd.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
    // A clipboard with text keeps its normal text paste; an image-only clipboard (a screenshot) attaches.
    if (files.length === 0 || cd.getData("text/plain")) return;
    ev.preventDefault();
    void addFiles(files.filter(Boolean));
  });
  let dragDepth = 0;
  // Files from the OS carry "Files"; files dragged from the editor's Explorer carry only their addresses.
  const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].some((t) => t === "Files" || t === "text/uri-list");
  window.addEventListener("dragenter", (ev) => {
    if (!hasFiles(ev)) return;
    dragDepth++;
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (ev) => {
    if (!hasFiles(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dragging");
  });
  window.addEventListener("dragover", (ev) => {
    if (hasFiles(ev)) ev.preventDefault();
  });
  window.addEventListener("drop", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    // Files dragged from the Explorer carry no File object, only their addresses: the extension resolves them.
    const uriList = (ev.dataTransfer.getData("text/uri-list") || "").split(/\r?\n/).filter((u) => u && !u.startsWith("#"));
    if (ev.dataTransfer.files.length === 0 && uriList.length > 0) vscode.postMessage({ type: "dropUris", uris: uriList });
    else void addFiles([...ev.dataTransfer.files]);
  });
  input.addEventListener("input", () => {
    autosize();
    state.slash.index = 0;
    updateSlash();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.isComposing) return;
    if (state.slash.open && !slashMenu.hidden) {
      const rows = slashRows();
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (rows.length) {
          state.slash.index = (state.slash.index + (ev.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
          renderSlash();
        }
        return;
      }
      if ((ev.key === "Enter" || ev.key === "Tab") && !ev.shiftKey && !ev.ctrlKey && rows.length) {
        ev.preventDefault();
        pickSkill(rows[Math.min(state.slash.index, rows.length - 1)]);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeSlash();
        return;
      }
    }
    if (ev.key === "Tab" && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      vscode.postMessage({ type: "cycleMode" });
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      // Ctrl+Enter queues while a turn runs; otherwise both keys send (or steer the running turn).
      send(ev.ctrlKey || ev.metaKey ? "queue" : "steer");
    }
  });
  sendBtn.addEventListener("click", () => send("steer"));
  queueBtn.addEventListener("click", () => send("queue"));
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  $("refreshUsage").addEventListener("click", () => vscode.postMessage({ type: "refreshUsage" }));
  $("newChat").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));

  renderMeta();
  setRunning(false, "Ready");
  vscode.postMessage({ type: "ready" });
  input.focus();
})();
