// Antares chat webview. Plain browser JS (no build step) so it can also run in the preview harness.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $("messages");
  const input = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const meta = $("meta");
  const profileSel = $("profile");
  const hint = $("hint");
  const modelSel = $("model");
  const effortSel = $("effort");

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor"/></svg>';

  const state = {
    running: false,
    items: new Map(), // itemId -> { el, text, role, raf }
    tools: new Map(), // itemId -> element
    approvals: new Map(), // approvalId -> { el, event, decided }
    models: [],
    modelId: undefined, // the user's remembered choice, if any
    effort: undefined, // undefined = the model's default
    tokens: undefined,
    context: undefined,
    usage: undefined,
    background: new Set(),
    turnNote: "",
    statusText: "Ready",
    profileId: undefined,
    profiles: [],
    sandbox: undefined,
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
  function addMessage(itemId, role, text, streaming) {
    const node = el("div", "msg " + role + (streaming ? " streaming" : ""));
    node.innerHTML =
      '<div class="msg-head"><span class="who">' + (role === "user" ? "You" : "Muse") + "</span>" +
      '<button class="copy" data-copy="message" title="Copy message">' + COPY_ICON + '<span class="label">Copy</span></button></div>' +
      '<div class="body"></div>';
    const item = { el: node, text, role, raf: 0 };
    state.items.set(itemId, item);
    paint(item);
    append(node);
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
    append(el("div", "notice " + level, text));
  }

  // ---- tool calls ----
  function upsertTool(e) {
    let node = state.tools.get(e.itemId);
    if (!node) {
      node = el("div", "tool");
      state.tools.set(e.itemId, node);
      append(node);
    }
    node.className = "tool " + (e.failure ? "failed" : e.status === "completed" ? "done" : "running");
    node.replaceChildren();
    const head = el("div", "tool-head");
    head.append(el("span", "tool-name", e.tool), el("span", "tool-summary", e.summary), el("span", "badge", e.failure ? "failed" : e.status));
    node.append(head);
    if (e.held) node.append(el("div", "tool-note", "held" + (e.heldFor ? " for " + e.heldFor : "")));
    if (e.failure) node.append(el("div", "tool-fail", e.failure));
    if (e.output) {
      const details = el("details", "tool-out");
      details.append(el("summary", "", "output"), el("pre", "", e.output));
      node.append(details);
    }
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
  function addApproval(e) {
    if (state.approvals.has(e.approvalId)) return;
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
  function pct(label, p, resetMs) {
    if (p === undefined) return "";
    const cls = p >= 90 ? ' class="warn"' : "";
    return "<span" + cls + ">" + label + " " + p + "%" + fmtReset(resetMs) + "</span>";
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
    if (state.tokens) parts.push("<span>last turn " + fmtTokens(state.tokens.inputTokens) + " in · " + fmtTokens(state.tokens.outputTokens) + " out</span>");
    if (state.usage) {
      parts.push(pct("5 h", state.usage.windowPercent, state.usage.windowResetsAtMs));
      parts.push(pct("week", state.usage.weeklyPercent, state.usage.weeklyResetsAtMs));
    }
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
    sendBtn.disabled = running;
    stopBtn.hidden = !running;
    sendBtn.hidden = running;
    renderMeta();
  }

  // ---- profile ----
  function applyConfig(msg) {
    state.profileId = msg.profileId;
    state.profiles = msg.profiles || [];
    state.modelId = msg.modelId;
    state.effort = msg.effort;
    renderModelControls();
    profileSel.replaceChildren();
    for (const p of state.profiles) {
      const opt = el("option", "", p.label + " (" + p.id + ")");
      opt.value = p.id;
      profileSel.append(opt);
    }
    profileSel.value = state.profileId;
    const current = state.profiles.find((p) => p.id === state.profileId);
    hint.textContent = (current ? "Profile " + current.id + ": " + current.note + " " : "") + "Enter sends · Shift+Enter adds a line.";
    renderMeta();
  }
  profileSel.addEventListener("change", () => {
    const wanted = profileSel.value;
    profileSel.value = state.profileId; // stays put until the extension confirms with a new config
    vscode.postMessage({ type: "setProfile", profileId: wanted });
  });

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
        state.usage = { ...(state.usage || {}), ...e };
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
    else if (msg.type === "config") applyConfig(msg);
    else if (msg.type === "reset") {
      for (const node of messages.querySelectorAll(".msg, .notice, .tool, .approval")) node.remove();
      state.items.clear();
      state.tools.clear();
      state.approvals.clear();
      state.tokens = state.context = undefined;
      state.sandbox = undefined;
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
