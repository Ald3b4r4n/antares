// End-to-end approval flow through Antares' own session code (MuseSession) against the REAL host.
// Costs one real model turn per run (about 45k+ tokens). Runs in the user's normal environment, in an
// empty throwaway workspace, with the `:ask-me` profile, asking for a harmless public page.
//
// FLOW_MODE=abort          (default) reject every approval, with a note for the model
// FLOW_MODE=allow-example  allow ONCE a network fetch of example.com and nothing else; everything
//                          else (a shell command, any other host) is rejected
//
// Usage: node scripts/probe-approval-flow.ts [path-to-muse]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../src/muse/events.ts";
import { locateMuse } from "../src/muse/locate.ts";
import { MuseSession } from "../src/muse/session.ts";

const binary = locateMuse(process.argv.slice(2).find((a) => !a.startsWith("--")));
if (!binary) {
  console.error("muse executable not found.");
  process.exit(2);
}
const mode = process.env.FLOW_MODE === "allow-example" ? "allow-example" : "abort";
const work = mkdtempSync(join(tmpdir(), "antares-flow-"));
const workspace = join(work, "workspace");
mkdirSync(workspace, { recursive: true });

const session = new MuseSession({ binary, workspaceRoot: workspace, profile: ":ask-me" });
const timeline: string[] = [];
const decisions: { kind: string; summary: string; picked: string; accepted: boolean | string }[] = [];
const toolStates: string[] = [];
let finalText = "";
let outcome = "";
let finished: () => void = () => undefined;
const done = new Promise<void>((resolve) => (finished = resolve));

session.on("event", (e: ChatEvent) => {
  if (e.type === "approvalRequested") {
    timeline.push(`approval:${e.subject.kind}`);
    const allowThis = mode === "allow-example" && e.subject.kind === "network" && /^example\.com(:443)?\b/.test(e.subject.summary);
    const choice = allowThis
      ? e.choices.find((c) => c.choiceId === "allow_once" && c.decision === "approved" && c.scope === "once")
      : e.choices.find((c) => c.decision === "abort" || c.decision === "denied");
    const picked = choice ? `${choice.choiceId} (${choice.decision}, ${choice.scope})` : "(no safe choice: interrupting)";
    const entry = { kind: e.subject.kind, summary: e.subject.summary.slice(0, 90), picked, accepted: false as boolean | string };
    decisions.push(entry);
    if (!choice) {
      void session.interrupt();
      return;
    }
    const feedback = choice.acceptsFeedback ? "Not now, thanks. Please do not look for another way to do this." : undefined;
    session
      .decide(e.approvalId, choice.choiceId, e.requirementId, feedback)
      .then(() => (entry.accepted = true))
      .catch((err: Error) => (entry.accepted = `refused: ${err.message}`));
  } else if (e.type === "approvalResolved") {
    timeline.push(`resolved:${e.decision}/${e.policyResult}/${e.resolvedBy}`);
  } else if (e.type === "toolCall") {
    const last = toolStates[toolStates.length - 1];
    const line = `${e.tool}:${e.failure ? "failed" : e.status}`;
    if (line !== last) toolStates.push(line);
  } else if (e.type === "assistantCompleted") {
    finalText = e.text;
  } else if (e.type === "turnCompleted") {
    outcome = e.terminal;
    finished();
  } else if (e.type === "notice") {
    timeline.push(`notice:${e.level}`);
  }
});

try {
  console.log(`Sending ONE real turn (mode: ${mode})...`);
  setTimeout(finished, 180_000);
  await session.send("Use your web fetch tool to retrieve https://example.com and tell me the page title in one short sentence.");
  await done;
  if (!outcome) await session.interrupt();
} finally {
  await session.stop();
  rmSync(work, { recursive: true, force: true });
  console.log(JSON.stringify({ mode, turnOutcome: outcome || "(timed out)", approvalsSeen: decisions.length, decisions, toolStates, timeline: timeline.filter((t, i) => timeline.indexOf(t) === i || !/^notice/.test(t)), finalText: finalText.replace(/\s+/g, " ").slice(0, 140) }, null, 2));
}
