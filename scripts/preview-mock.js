// Runs in the preview page before chat.js. Replaces acquireVsCodeApi with a scripted fake Muse host.
const emit = (event) => window.postMessage({ type: "event", event }, "*");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE = "```";
const reply =
  "Sure. Here is a **small example** in TypeScript:\n\n" +
  FENCE + "ts\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n" + FENCE +
  "\n\nUse `greet(\"Antares\")` to try it. The copy buttons work on the whole message and on each code block.";
let n = 0;

async function turn(text) {
  const turnId = "t" + ++n;
  emit({ type: "status", status: "running" });
  emit({ type: "turnStarted", turnId });
  emit({ type: "userMessage", itemId: "u" + n, text });
  emit({ type: "activity", itemId: "h" + n, kind: "hookRun", label: "session hook", status: "started" });
  await sleep(500);
  emit({ type: "activity", itemId: "h" + n, kind: "hookRun", label: "session hook", status: "completed" });
  if (/error/i.test(text)) {
    emit({ type: "turnCompleted", turnId, terminal: "failed", errorKind: "authRequired", errorMessage: "not logged in: run /login to add an API key", durationMs: 99 });
    return;
  }
  const id = "a" + n;
  emit({ type: "assistantStarted", itemId: id });
  for (let i = 0; i < reply.length; i += 6) {
    emit({ type: "assistantDelta", itemId: id, delta: reply.slice(i, i + 6) });
    await sleep(25);
  }
  emit({ type: "tokens", modelId: "muse-wonder-1.0", inputTokens: 41910, outputTokens: 213, reasoningTokens: 40, totalTokens: 42123 });
  emit({ type: "context", usedTokens: 42378, windowTokens: 1007997, pressure: "normal" });
  emit({ type: "assistantCompleted", itemId: id, text: reply });
  emit({ type: "foregroundCompleted", turnId });
  await sleep(900);
  emit({ type: "usage", windowPercent: 25, windowResetsAtMs: Date.now() + 52 * 60000, weeklyPercent: 30, weeklyResetsAtMs: Date.now() + 3 * 86400000 });
  emit({ type: "status", status: "idle" });
  emit({ type: "turnCompleted", turnId, terminal: "completed", durationMs: 4200, timeToFirstTokenMs: 900 });
}

window.acquireVsCodeApi = () => ({
  postMessage(m) {
    if (m.type === "ready") {
      emit({ type: "models", models: [{ modelId: "muse-wonder-1.0", label: "muse-wonder-1.0", isDefault: true, variants: ["minimal", "high"] }] });
    } else if (m.type === "send") turn(m.text);
    else if (m.type === "copy") {
      window.__lastCopied = m.text;
      window.postMessage({ type: "copied" }, "*");
    } else if (m.type === "newChat") window.postMessage({ type: "reset" }, "*");
  },
});
