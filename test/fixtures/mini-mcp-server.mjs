// A tiny, harmless MCP server over stdio (newline-delimited JSON-RPC) for tests: one tool, `antares_ping`, that answers
// "pong:<text>". It touches no files and no network. Every request it receives is appended to MINI_MCP_LOG when set, so a
// test can prove the host really started it and really called the tool. Test fixture only.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => {
  if (process.env.MINI_MCP_LOG) appendFileSync(process.env.MINI_MCP_LOG, `${JSON.stringify(entry)}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ method: msg.method, params: msg.params });
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "antares-mini", version: "0.0.1" } } });
  } else if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools: [{ name: "antares_ping", description: "Answers pong:<text>. Test tool.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  } else if (msg.method === "tools/call") {
    send({ id: msg.id, result: { content: [{ type: "text", text: `pong:${msg.params?.arguments?.text ?? ""}` }] } });
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
