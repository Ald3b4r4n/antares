// Runs INSIDE a real VS Code (or fork) extension host. Offline: the `echo` provider, isolated Muse config.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { AntaresApi } from "../../src/extension.ts";
import { makeSolidPng } from "../fixtures/png.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<AntaresApi>("ald3b4r4n.antares");
  assert.ok(ext, "extension is installed under development");
  const api = await ext.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("antares.open") && commands.includes("antares.selfTest"), "commands are registered");

  await vscode.commands.executeCommand("antares.open");
  const panel = api.chat();
  assert.ok(panel, "chat panel was created");
  await waitFor("chat.js to run in the real webview (ready message)", () => panel.testState.ready >= 1, 20_000);

  // Warming: the model catalog reaches the page before the first message, with no session yet.
  await waitFor("the model catalog (host warm-up)", () => panel.testState.events.some((e) => e.type === "models"), 20_000);
  assert.ok(!panel.testState.events.some((e) => e.type === "userMessage"), "nothing was sent yet");

  await panel.send("hello from the extension host");
  await waitFor("turn to complete and the page to confirm rendering", () => panel.testState.rendered !== undefined, 30_000);

  const events = panel.testState.events;
  const types = events.map((e) => e.type);
  assert.ok(types.includes("userMessage"), "user message event reached the webview");
  assert.ok(types.includes("assistantStarted"), "assistant started");
  const completed = events.find((e) => e.type === "assistantCompleted");
  assert.equal(completed && "text" in completed ? completed.text : undefined, "echo: hello from the extension host");
  const turn = events.find((e) => e.type === "turnCompleted");
  assert.equal(turn && "terminal" in turn ? turn.terminal : undefined, "completed");

  const rendered = panel.testState.rendered;
  assert.ok(rendered, "the page confirmed rendering");
  assert.equal(rendered.userMessages, 1, "the page rendered the user message");
  assert.equal(rendered.messages, 2, "the page rendered user + assistant messages");
  assert.equal(rendered.copyButtons, 2, "each message has a copy button");

  // Copy goes through the host clipboard.
  await vscode.env.clipboard.writeText("before");
  await panel.onMessage({ type: "copy", text: "copied by antares" });
  assert.equal(await vscode.env.clipboard.readText(), "copied by antares");

  // Usage: the shared tracker raises one alert per window when a threshold is crossed (not again while
  // above it), mirrors the numbers in the status bar, and counts reported tokens once per event id.
  const tracker = api.usage();
  assert.match(tracker.testState.statusText, /Antares/, "the status bar item exists before any usage is known");
  const soon = Date.now() + 2 * 3600_000;
  const reading = { type: "usage" as const, windowPercent: 85, windowResetsAtMs: soon, weeklyPercent: 96, weeklyResetsAtMs: soon + 86400_000, observedAtMs: Date.now() };
  const extras = tracker.handle(reading);
  assert.deepEqual(tracker.testState.alerts.map((a) => [a.kind, a.threshold]), [["window", 80], ["weekly", 95]], "one alert per window, at the highest crossed threshold");
  assert.equal(extras.filter((e) => e.type === "notice").length, 2, "the chat is told as well");
  assert.match(tracker.testState.statusText, /5h 85% · wk 96%/, "the status bar mirrors the numbers");
  tracker.handle({ ...reading, windowPercent: 88 });
  assert.equal(tracker.testState.alerts.length, 2, "still above the threshold: no repeat");
  tracker.handle({ ...reading, windowPercent: 20 });
  assert.match(tracker.testState.statusText, /5h 20%/);
  const tokens = { type: "tokens" as const, inputTokens: 900, outputTokens: 100, reasoningTokens: 0, totalTokens: 1000, eventId: "ev-1", cumulativeTotal: 1000 };
  const before = tracker.ledgerSummary().todayTokens;
  tracker.handle(tokens);
  tracker.handle(tokens);
  assert.equal(tracker.ledgerSummary().todayTokens, before + 1000, "the same event id is counted once");

  // Images: a valid one goes through the real panel path; an invalid one is refused before any send.
  const png = makeSolidPng(8, 8, [0, 0, 255]).toString("base64");
  const userMessagesBefore = panel.testState.events.filter((e) => e.type === "userMessage").length;
  panel.testState.rendered = undefined;
  await panel.send("with an image", [{ mediaType: "image/png", base64Data: png, width: 8, height: 8 }]);
  await waitFor("the image turn", () => (panel.testState as { rendered?: unknown }).rendered !== undefined, 30_000);
  const withImage = panel.testState.events.filter((e) => e.type === "userMessage").pop();
  assert.equal(panel.testState.events.filter((e) => e.type === "userMessage").length, userMessagesBefore + 1);
  // The host accepted the image: it appends an "[Image #1]" marker to the text. (An ephemeral echo session
  // reports no attachment metadata, so the marker is the evidence here.)
  assert.match(withImage?.type === "userMessage" ? withImage.text : "", /\[Image #1\]/, "the host accepted the image");
  const noticesBefore = panel.testState.events.filter((e) => e.type === "notice").length;
  await panel.send("bad image", [{ mediaType: "image/bmp", base64Data: png }]);
  assert.equal(panel.testState.events.filter((e) => e.type === "userMessage").length, userMessagesBefore + 1, "a refused image must not be sent");
  assert.equal(panel.testState.events.filter((e) => e.type === "notice").length, noticesBefore + 1, "the refusal is shown to the user");

  // History: the panel answers a list request (with the rows or a readable error, never silence), and a
  // session that cannot be opened is reported as an error instead of leaving a broken chat behind.
  const listsBefore = panel.testState.sessionLists;
  await panel.onMessage({ type: "listSessions" });
  await waitFor("the session list reply", () => panel.testState.sessionLists > listsBefore, 20_000);
  const errorsBefore = panel.testState.events.filter((e) => e.type === "notice" && e.level === "error").length;
  await panel.onMessage({ type: "openSession", sessionId: "00000000-0000-7000-8000-000000000000", mode: "resume" });
  await waitFor("the refusal to open a missing session", () => panel.testState.events.filter((e) => e.type === "notice" && e.level === "error").length > errorsBefore, 20_000);
  const reopened = panel.testState.events.filter((e) => e.type === "notice" && e.level === "error").pop();
  assert.match(reopened?.type === "notice" ? reopened.text : "", /Could not continue that session/);
  await panel.onMessage({ type: "openSession", sessionId: "x", mode: "fork" }); // forking a session that does not exist is refused as well
  await panel.onMessage({ type: "openSession", sessionId: 42 as unknown as string, mode: "resume" }); // malformed input is ignored
  panel.testState.rendered = undefined;
  await panel.send("still works after a failed open");
  await waitFor("a turn after the failed open", () => (panel.testState as { rendered?: unknown }).rendered !== undefined, 30_000);

  // New chat restarts cleanly, and a second turn works on the new session.
  await panel.onMessage({ type: "newChat" });
  panel.testState.rendered = undefined;
  await panel.send("second");
  await waitFor("second turn", () => panel.testState.rendered !== undefined, 30_000);
  assert.equal((panel.testState as { rendered?: { messages: number } }).rendered?.messages, 2, "after New chat the page shows only the new exchange");

  await vscode.commands.executeCommand("antares.selfTest");
  console.log(`[antares-suite] all assertions passed in ${vscode.env.appName} ${vscode.version}`);
}
