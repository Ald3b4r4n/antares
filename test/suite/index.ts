// Runs INSIDE a real VS Code (or fork) extension host. Offline: the `echo` provider, isolated Muse config.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { AntaresApi } from "../../src/extension.ts";

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

  // New chat restarts cleanly, and a second turn works on the new session.
  await panel.onMessage({ type: "newChat" });
  panel.testState.rendered = undefined;
  await panel.send("second");
  await waitFor("second turn", () => panel.testState.rendered !== undefined, 30_000);
  assert.equal((panel.testState as { rendered?: { messages: number } }).rendered?.messages, 2, "after New chat the page shows only the new exchange");

  await vscode.commands.executeCommand("antares.selfTest");
  console.log(`[antares-suite] all assertions passed in ${vscode.env.appName} ${vscode.version}`);
}
