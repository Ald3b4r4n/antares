// Prints, from a probe log, the host's patch artifacts and whether item/started carries the arguments.
// Usage: node scripts/show-patch.mjs spike-output/probe-approval-tools.json
import { readFileSync } from "node:fs";

const log = JSON.parse(readFileSync(process.argv[2], "utf8")).log;
for (const e of log) {
  const item = e.payload?.item;
  if (e.method === "item/completed" && item?.patchRef) {
    console.log("REF keys:", Object.keys(item.patchRef).join(","), "| tool:", item.tool, "| summary:", JSON.stringify(item.patchSummary));
    try {
      console.log("PATCH:", readFileSync(String(item.patchRef.path).replace("\\\\?\\", ""), "utf8").slice(0, 700));
    } catch (error) {
      console.log("read failed:", error.message);
    }
  }
  if (e.method === "item/started" && item?.kind === "toolCall") console.log("STARTED", item.tool, "args:", typeof item.args, "status:", item.status);
}
