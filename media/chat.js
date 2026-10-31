// Antares chat webview. Plain browser JS (no build step) so it can also run in the preview harness.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $("messages");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const meta = $("meta");

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor"/></svg>';

  const state = {
    running: false,
    items: new Map(), // itemId -> { el, text, role, raf }
    model: undefined,
    models: [],
    tokens: undefined,
    context: undefined,
    usage: undefined,
    background: new Set(),
    turnNote: "",
    statusText: "Ready",
  };

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

  // ---- tiny, safe markdown: fenced code, inline code, bold, paragraphs ----
  function inline(text) {
    return escapeHtml(text)
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
        '<div class="code"><div class="code-head"><span>' + escapeHtml(lang) + '</span>' +
          '<button class="copy" data-copy="code" title="Copy code">' + COPY_ICON + '<span class="label">Copy</span></button></div>' +
          "<pre><code>" + escapeHtml(code) + "</code></pre></div>",
      );
      last = fence.lastIndex;
      if (m[0] === "" ) fence.lastIndex++;
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
  function addMessage(itemId, role, text, streaming) {
    const stick = pinned();
    const el = document.createElement("div");
    el.className = "msg " + role + (streaming ? " streaming" : "");
    el.innerHTML =
      '<div class="msg-head"><span class="who">' + (role === "user" ? "You" : "Muse") + "</span>" +
      '<button class="copy" data-copy="message" title="Copy message">' + COPY_ICON + '<span class="label">Copy</span></button></div>' +
      '<div class="body"></div>';
    messages.appendChild(el);
    const item = { el, text, role, raf: 0 };
    state.items.set(itemId, item);
    paint(item);
    if (stick) scrollDown();
    return item;
  }
  function paint(item) {
    const body = item.el.querySelector(".body");
    if (item.role === "user") body.textContent = item.text;
    else body.innerHTML = renderMarkdown(item.text);
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
    const el = document.createElement("div");
    el.className = "notice " + level;
    el.textContent = text;
    messages.appendChild(el);
    scrollDown();
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
  function pct(label, p, resetMs) {
    if (p === undefined) return "";
    const cls = p >= 90 ? ' class="warn"' : "";
    return "<span" + cls + ">" + label + " " + p + "%" + fmtReset(resetMs) + "</span>";
  }
  function renderMeta() {
    const parts = [];
    parts.push("<span>" + escapeHtml(state.statusText) + (state.background.size ? " · background " + state.background.size : "") + "</span>");
    const model = state.model || (state.models.find((m) => m.isDefault) || state.models[0] || {}).label;
    if (model) parts.push("<span>" + escapeHtml(model) + "</span>");
    if (state.context) {
      const c = state.context;
      const p = c.windowTokens ? Math.round((c.usedTokens / c.windowTokens) * 100) : 0;
      parts.push("<span>context " + fmtTokens(c.usedTokens) + " / " + fmtTokens(c.windowTokens) + " (" + p + "%)</span>");
    }
    if (state.tokens) parts.push("<span>last turn " + fmtTokens(state.tokens.inputTokens) + " in · " + fmtTokens(state.tokens.outputTokens) + " out</span>");
    if (state.usage) {
      parts.push(pct("5 h", state.usage.windowPercent, state.usage.windowResetsAtMs));
      parts.push(pct("week", state.usage.weeklyPercent, state.usage.weeklyResetsAtMs));
    }
    if (state.turnNote) parts.push("<span>" + escapeHtml(state.turnNote) + "</span>");
    meta.innerHTML = parts.filter(Boolean).join("");
  }
  function setRunning(running, text) {
    state.running = running;
    state.statusText = text;
    sendBtn.disabled = running;
    stopBtn.hidden = !running;
    sendBtn.hidden = running;
    renderMeta();
  }

  // ---- events from the extension ----
  function onEvent(e) {
    switch (e.type) {
      case "turnStarted":
        state.turnNote = "";
        state.background.clear();
        setRunning(true, "Thinking…");
        break;
      case "userMessage":
        addMessage(e.itemId, "user", e.text, false);
        break;
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
        state.background.clear();
        setRunning(false, "Ready");
        input.focus();
        break;
      }
      case "tokens":
        state.tokens = e;
        renderMeta();
        break;
      case "context":
        state.context = e;
        renderMeta();
        break;
      case "usage":
        state.usage = { ...(state.usage || {}), ...e };
        renderMeta();
        break;
      case "models":
        state.models = e.models;
        renderMeta();
        break;
      case "activity":
        if (e.status === "started") state.background.add(e.itemId);
        else state.background.delete(e.itemId);
        renderMeta();
        break;
      case "notice":
        addNotice(e.level, e.text);
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "reset") {
      for (const el of messages.querySelectorAll(".msg, .notice")) el.remove();
      state.items.clear();
      state.tokens = state.context = undefined;
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

  // ---- composer ----
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }
  function send() {
    const text = input.value.trim();
    if (!text || state.running) return;
    input.value = "";
    autosize();
    vscode.postMessage({ type: "send", text });
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  $("newChat").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));

  renderMeta();
  setRunning(false, "Ready");
  vscode.postMessage({ type: "ready" });
  input.focus();
})();
