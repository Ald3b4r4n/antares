// UI preview: serves the real chat page with a FAKE Muse host that streams a scripted reply.
// No Muse process, no login, no cost. Usage: node scripts/preview.ts [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { modeRows } from "../src/muse/modes.ts";
import { chatHtml } from "../src/ui/chatHtml.ts";

const port = Number(process.argv[2] ?? 5757);
const mediaDir = new URL("../media/", import.meta.url);
const types: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

// The real mode table, so the preview shows exactly what the extension offers.
const mock = `window.__MODES = ${JSON.stringify(modeRows())};
` + (await readFile(new URL("./preview-mock.js", import.meta.url), "utf8"));

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/") {
    const html = chatHtml({ cspSource: "'self'", nonce: "preview", mediaUri: (f) => `/media/${f}`, preScript: mock });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    return;
  }
  if (url.pathname.startsWith("/media/") && !url.pathname.includes("..")) {
    try {
      const body = await readFile(new URL(url.pathname.slice("/media/".length), mediaDir));
      res.writeHead(200, { "content-type": types[extname(url.pathname)] ?? "application/octet-stream" }).end(body);
      return;
    } catch {
      /* fall through */
    }
  }
  res.writeHead(404).end("not found");
}).listen(port, "127.0.0.1", () => console.log(`Antares UI preview: http://127.0.0.1:${port}/`));
