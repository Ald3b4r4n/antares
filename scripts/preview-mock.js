// Runs in the preview page before chat.js. Replaces acquireVsCodeApi with a scripted fake Muse host.
// Prompts: any text streams a reply; "approve" asks for a shell approval; "unknown" asks for an
// approval of a kind the UI does not recognize; "error" fails with authRequired.
const emit = (event) => window.postMessage({ type: "event", event }, "*");
const post = (m) => window.postMessage(m, "*");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE = "```";
const reply =
  "Sure. Here is a **small example** in TypeScript:\n\n" +
  FENCE + "ts\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n" + FENCE +
  "\n\nUse `greet(\"Antares\")` to try it. The copy buttons work on the whole message and on each code block.";

const PROFILES = [
  { id: ":read-only", label: "Read-only", note: "Reading only. Antares also disables shell and file-write tools at the host." },
  { id: ":ask-me", label: "Ask me", note: "Human review profile. Observed once: a file write inside the workspace ran without a prompt, and the shell failed closed because the sandbox was not set up." },
  { id: ":auto-review", label: "Auto-review", note: "An automated reviewer decides first and escalates to you." },
  { id: ":unrestricted", label: "Unrestricted", note: "Per the contract this starts without sandbox or approval prompts. Use with care." },
];
let profileId = ":read-only";
let modelId; // the remembered choice (undefined = default)
let effort;
const CATALOG = [
  { modelId: "muse-wonder-1.0", label: "muse-wonder-1.0", providerId: "meta", profileId: "tbh", isDefault: true, contextLimit: 1007997, variants: ["minimal", "low", "medium", "high", "xhigh", "max"], effortNotes: {}, defaultReasoningEffort: "high" },
  { modelId: "muse-spark-1.3", label: "muse-spark-1.3", providerId: "meta", profileId: "tbh", isDefault: false, contextLimit: 1007997, variants: ["minimal", "low", "medium", "high", "xhigh", "max"], effortNotes: {}, defaultReasoningEffort: "max" },
  { modelId: "muse-spark-1.2", label: "muse-spark-1.2", providerId: "meta", profileId: "tbh", isDefault: false, contextLimit: 1007997, variants: ["minimal", "low", "medium", "high", "xhigh"], effortNotes: { xhigh: "Use this for deepest analysis and complex fixes." }, defaultReasoningEffort: "high" },
];
const catalog = () => CATALOG.map((m) => ({ ...m, isActive: m.modelId === (modelId ?? "muse-wonder-1.0") }));
let ledgerToday = 0;
let usageNow;
let refreshCount = 0;
const config = () => ({ type: "config", profileId, profiles: PROFILES, modelId, effort, usage: usageNow, ledger: { todayTokens: ledgerToday, weekTokens: ledgerToday }, thresholds: [80, 95] });
let n = 0;
let turnRunning = false;
let nextTurnId;
const queued = new Map(); // turnId -> the message the fake host is holding
let folders = [];
const decisions = new Map(); // approvalId -> resolve

// Like the real host: "[Image #n]" markers are appended to the text and only metadata comes back.
function startTurn(text, images) {
  const turnId = nextTurnId ?? "t" + ++n;
  nextTurnId = undefined;
  const list = images || [];
  const marked = text + list.map((_, i) => "[Image #" + (i + 1) + "]").join("");
  emit({ type: "status", status: "running" });
  emit({ type: "turnStarted", turnId });
  emit({ type: "userMessage", itemId: "u" + n, text: marked, attachments: /ephemeral/i.test(text) ? [] : list.map((im, i) => ({ type: "image", mediaType: im.mediaType, width: im.width, height: im.height, attachmentId: "att/" + (i + 1) })) });
  return turnId;
}
function finishTurn(turnId) {
  usageNow = { type: "usage", windowPercent: 25, windowResetsAtMs: Date.now() + 52 * 60000, weeklyPercent: 30, weeklyResetsAtMs: Date.now() + 3 * 86400000, observedAtMs: Date.now() };
  emit(usageNow);
  emit({ type: "status", status: "idle" });
  emit({ type: "turnCompleted", turnId, terminal: "completed", durationMs: 4200, timeToFirstTokenMs: 900 });
}
async function stream(id, text) {
  emit({ type: "assistantStarted", itemId: id });
  for (let i = 0; i < text.length; i += 6) {
    emit({ type: "assistantDelta", itemId: id, delta: text.slice(i, i + 6) });
    await sleep(25);
  }
  ledgerToday += 42123;
  emit({ type: "tokens", modelId: "muse-wonder-1.0", inputTokens: 41910, outputTokens: 213, reasoningTokens: 40, totalTokens: 42123, eventId: "ev" + n, cumulativeTotal: 42123 * n });
  emit({ type: "ledger", todayTokens: ledgerToday, weekTokens: ledgerToday });
  emit({ type: "context", usedTokens: 42378, windowTokens: 1007997, pressure: "normal" });
  emit({ type: "assistantCompleted", itemId: id, text });
}

async function plainTurn(text, images) {
  const turnId = startTurn(text, images);
  await sleep(400);
  await stream("a" + n, reply);
  emit({ type: "foregroundCompleted", turnId });
  await sleep(700);
  finishTurn(turnId);
}

async function approvalTurn(text, unknown) {
  const turnId = startTurn(text);
  await sleep(300);
  const callId = "tool" + n;
  emit({ type: "toolCall", itemId: callId, tool: unknown ? "mystery_tool" : "powershell", summary: unknown ? "{...}" : "Remove-Item -Recurse build", status: "inProgress", held: false });
  const approvalId = "ap" + n;
  const subject = unknown
    ? { kind: "teleport", summary: "mystery_tool: {\"to\":\"somewhere\"}", detail: ["unrecognized approval kind \"teleport\""], generic: true }
    : { kind: "shell", summary: "Remove-Item -Recurse build", detail: ["stage 1: Remove-Item -Recurse build", "in C:\\work\\project"], generic: false };
  emit({
    type: "approvalRequested", approvalId, itemId: callId, toolName: unknown ? "mystery_tool" : "powershell", subject,
    requirementId: { approvalId, sourceIndex: 0 }, protectedWrite: false, judgeEscalated: !unknown, reviewerReason: unknown ? undefined : "deletes files recursively",
    choices: [
      { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once", acceptsFeedback: false },
      { choiceId: "c-session", label: "Allow for this session", decision: "approvedForSession", scope: "session", acceptsFeedback: false },
      { choiceId: "c-always", label: "Always allow this command prefix", decision: "approvedPolicyAmendment", scope: "localPersistent", rulePreview: "allow shell: Remove-Item -Recurse", acceptsFeedback: false },
      { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once", acceptsFeedback: true },
    ],
  });
  const choice = await new Promise((resolve) => decisions.set(approvalId, resolve));
  const allowed = /^approved/.test(choice.decision);
  emit({ type: "approvalResolved", approvalId, decision: choice.decision, resolvedBy: "user", policyResult: allowed ? "allow" : "deny" });
  await sleep(300);
  emit(allowed
    ? { type: "toolCall", itemId: callId, tool: "powershell", summary: "Remove-Item -Recurse build", status: "completed", held: false, output: "(simulated) removed 12 items" }
    : { type: "toolCall", itemId: callId, tool: unknown ? "mystery_tool" : "powershell", summary: unknown ? "{...}" : "Remove-Item -Recurse build", status: "failed", held: false, failure: "denied by user" });
  await stream("a" + n, allowed ? "Done: the build folder was removed." : "Understood, I will not run that.");
  emit({ type: "foregroundCompleted", turnId });
  finishTurn(turnId);
}

async function turn(text, images) {
  if (/refuse/i.test(text)) {
    emit({ type: "notice", level: "error", text: "Image 1: the content is not a image/png image." });
    return;
  }
  if (/error/i.test(text)) {
    const turnId = startTurn(text);
    await sleep(200);
    emit({ type: "turnCompleted", turnId, terminal: "failed", errorKind: "authRequired", errorMessage: "not logged in: run /login to add an API key", durationMs: 99 });
  } else if (/unknown/i.test(text)) await approvalTurn(text, true);
  else if (/approve/i.test(text)) await approvalTurn(text, false);
  else await plainTurn(text, images);
}

window.__sent = [];
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    window.__sent.push(m);
    if (m.type === "ready") {
      post(config());
      emit({ type: "session", profileId, sandbox: "unavailable", version: "1.4.14" });
      emit({ type: "models", models: catalog() });
    } else if (m.type === "listSessions") {
      const now = Date.now();
      setTimeout(() => post({
        type: "sessions", currentSessionId: "s-current", canFork: profileId === ":read-only",
        sessions: [
          { sessionId: "s-1", title: "Refactor the parser and add tests for the tokenizer", updatedAtMs: now - 12 * 60000, turnCount: 6, modelId: "muse-wonder-1.0", workspaceRoot: "D:\\work\\project", sameWorkspace: true, forked: false },
          { sessionId: "s-2", title: "Why does the build fail on Windows?", updatedAtMs: now - 5 * 3600000, turnCount: 2, modelId: "muse-spark-1.3", workspaceRoot: "D:\\work\\project", sameWorkspace: true, forked: true },
          { sessionId: "s-current", title: "(this chat)", updatedAtMs: now, turnCount: 0, workspaceRoot: "D:\\work\\project", sameWorkspace: true, forked: false },
          { sessionId: "s-other", title: "Notes for a different repository", updatedAtMs: now - 3 * 86400000, turnCount: 9, modelId: "muse-wonder-1.0", workspaceRoot: "D:\\other\\repo", sameWorkspace: false, forked: false },
        ],
      }), 150);
    } else if (m.type === "openSession") {
      post({ type: "reset" });
      post(config());
      const past = [
        { type: "userMessage", itemId: "h1", text: "Why does the build fail on Windows?[Image #1]", attachments: [{ type: "image", mediaType: "image/png", width: 800, height: 600 }] },
        { type: "toolCall", itemId: "h2", tool: "read_file", summary: "build.log", status: "completed", held: false, output: "error: path too long" },
        { type: "assistantCompleted", itemId: "h3", text: "The log shows a **path too long** error. Enable long paths or shorten the output directory." },
      ];
      setTimeout(() => {
        emit({ type: "session", sessionId: m.sessionId, profileId, sandbox: "unavailable" });
        emit({ type: "history", source: m.mode, mode: "inline", events: past, note: m.mode === "fork" ? "This is a fork. The history shown is what Muse returned for the fork; the source conversation is unchanged." : undefined });
      }, 200);
    } else if (m.type === "setModel") {
      modelId = m.modelId;
      effort = undefined;
      emit({ type: "modelChanged", modelId, providerId: "meta", source: "user" });
      emit({ type: "models", models: catalog() });
      post(config());
    } else if (m.type === "refreshUsage") {
      refreshCount++;
      const h = 3600000;
      // 1: normal; 2: high (warn/err colours); 3: the 5 h window has reset (expired data)
      const states = [
        { windowPercent: 2, windowResetsAtMs: Date.now() + 4 * h, weeklyPercent: 31, weeklyResetsAtMs: Date.now() + 70 * h },
        { windowPercent: 83, windowResetsAtMs: Date.now() + 2 * h, weeklyPercent: 96, weeklyResetsAtMs: Date.now() + 70 * h },
        { windowPercent: 97, windowResetsAtMs: Date.now() - 600000, weeklyPercent: 40, weeklyResetsAtMs: Date.now() + 70 * h },
      ];
      usageNow = { type: "usage", ...states[(refreshCount - 1) % 3], observedAtMs: Date.now(), plan: "Muse Code High Usage", subscriptionActive: true };
      emit(usageNow);
    } else if (m.type === "setEffort") {
      effort = m.effort;
      post(config());
    } else if (m.type === "send") {
      if (turnRunning && m.mode) {
        // Like the host: a prompt during a turn is either folded into it or held until it ends.
        const turnId = "t" + ++n;
        if (m.mode === "queue") {
          queued.set(turnId, m);
          emit({ type: "submitted", turnId, disposition: "queued", text: m.text });
        } else emit({ type: "submitted", turnId, disposition: "steered", text: m.text });
      } else {
        turnRunning = true;
        turn(m.text, m.images).finally(() => {
          turnRunning = false;
          const next = queued.entries().next().value;
          if (next) {
            queued.delete(next[0]);
            nextTurnId = next[0]; // a held message launches under the id the host gave it when it was held
            turnRunning = true;
            turn(next[1].text, next[1].images).finally(() => (turnRunning = false));
          }
        });
      }
    } else if (m.type === "unqueue") {
      if (queued.delete(m.turnId)) emit({ type: "unqueued", turnId: m.turnId });
    } else if (m.type === "pickFiles") {
      post({ type: "picked", images: [], mentions: ["@src/index.ts", "@docs/my notes.md".replace(/^@(.*)$/, '@"$1"')], skipped: ["notes.txt is outside this chat's folders, so Muse's file tools would refuse it. Use \"Add folder\" for its folder first."] });
    } else if (m.type === "addFolder") {
      folders.push("D:\\work\\shared-lib");
      post({ type: "folders", folders: [...folders] });
    } else if (m.type === "removeFolder") {
      folders = folders.filter((p) => p !== m.path);
      post({ type: "folders", folders: [...folders] });
    } else if (m.type === "listSkills") {
      setTimeout(() => post({ type: "skills", skills: [
        { selector: "plan", displayName: "plan", description: "Write a plan before changing code.", source: "bundled" },
        { selector: "doctor", displayName: "doctor", description: "Check the Muse installation and settings.", source: "bundled" },
        { selector: "fix-bug", displayName: "Fix a bug", description: "Reproduce, find the cause and fix a bug with a test.", source: "user", argumentHint: "<issue or error>" },
        { selector: "acme:deploy", displayName: "Deploy", description: "Deploy to staging.", source: "plugin", pluginId: "acme", argumentHint: "[environment]" },
      ] }), 200);
    } else if (m.type === "listConnectors") {
      setTimeout(() => post({ type: "extras", kind: "connectors", rows: [
        { name: "github", source: "settings", transport: "streamableHttp", oauth: "loggedIn" },
        { name: "filesystem", source: "plugin", transport: "stdio", oauth: "notSupported" },
      ] }), 200);
    } else if (m.type === "listPlugins") {
      setTimeout(() => post({ type: "extras", kind: "plugins", rows: [{ id: "acme", version: "1.2.0", enabled: true, source: "marketplaceUserAdded" }] }), 200);
    }
    else if (m.type === "decide") decisions.get(m.approvalId)?.({ decision: m.choiceId === "c-deny" ? "denied" : m.choiceId === "c-once" ? "approved" : m.choiceId === "c-session" ? "approvedForSession" : "approvedPolicyAmendment" });
    else if (m.type === "setProfile") {
      profileId = m.profileId;
      post({ type: "reset" });
      post(config());
    } else if (m.type === "copy") {
      window.__lastCopied = m.text;
      post({ type: "copied" });
    } else if (m.type === "newChat") {
      post({ type: "reset" });
      post(config());
    }
  },
});
