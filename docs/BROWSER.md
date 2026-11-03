# Browser and app control

Muse Code controls a browser through an MCP server. Antares can **add one for you** ("+" > Connectors > **Add the browser…**: Microsoft's Playwright MCP, with a question that says it is third-party code) and then shows what the agent is doing and asks you before each consequential action. It never runs a browser itself. This page says what is known, what is not, and how to stay safe.

## The "Add the browser" button

- It installs `@playwright/mcp` **0.0.83** (pinned, npm's install scripts off, about 19 MB) into the extension's own storage, using the Node.js and npm already on your PATH (npm runs through `node`, never a shell), and writes the server into Muse's `settings.json` with the usual confirmation and backup, in `optional` mode.
- It drives the **Edge or Chrome you already have** (nothing is downloaded), headless, in a throwaway profile: no cookies, no logins, nothing kept. You choose **only this computer** (the browser is asked to load only `localhost` / `127.0.0.1` pages) or **any website**. The page filter is not a security boundary: a page can redirect.
- Muse starts an MCP server with only the environment written in its entry, so the entry carries the command's absolute path and a short list of system variables (TEMP, LOCALAPPDATA and the like; no secrets, no PATH), with the values they have when you add it. If you move your user folders, add the server again.
- Under the stricter permission modes each browser action asks first, like any MCP tool.
- Checked on this computer (Windows, Edge, Muse 1.4.14): the pinned package installs; with only that environment the server opens a local page headless and reads its title, and an outside address is refused (`only this computer`); Muse itself starts the entry (the Test button's route), and refuses a broken one. **Not checked:** a model driving the browser in a chat, Chrome, macOS or Linux, and screenshots shown in the chat (they are saved in the extension's `browser-output` folder; the chat does not show them).

## What Antares does

- Shows every tool call the agent makes, including the ones from an MCP server (name, arguments, result).
- Shows each approval request with the host's own choices. For an MCP tool the request is a **tool** approval and the arguments are listed as `name: value` lines (a URL, a selector, the text to type), so you can read exactly what is being asked.
- Renders **Computer Use** approvals when Muse sends them (the contract's `cuaCardFacts`): the page's host (with its plain `xn--` form when the address is not ASCII), the window title **quoted and as plain text** (it is the page's own words and can lie), every step that may have an effect ("Step 2: click button "Pay now" — may place an order"), and the data the call would send, with secrets shown masked, never their value.
- Never decides an approval by itself, and never approves in bulk.

## What Antares cannot do

- **Control a browser by itself.** Antares adds the browser server (above) and shows and gates what the agent does with it; the clicking and typing is the MCP server's doing. The **Preview** button only opens a page for *you* in the editor's browser.
- Run Computer Use setup. Muse describes that flow for macOS; what Windows offers is unknown.
- See into a plugin or MCP server before it runs.

## Where Muse reads MCP servers (measured on Muse 1.4.14)

- The user settings file is `settings.json` in Muse's config folder (`$XDG_CONFIG_HOME/muse/`, else `~/.config/muse/`). It needs `"schema_version": 1`.
- Servers go under `mcpServers` **or** `mcp_servers` (Muse reads both; the documentation shows only `mcp_servers`). Each entry is `{transport: "stdio" | "streamable_http", command, args, env, framing | url, headers, mode: "required" | "optional", enabled}`.
- Muse starts them at the **first turn** of a chat, and a `required` server that cannot start stops the run with a message. This was shown with a test server that received `initialize`, `tools/list` and a real `tools/call`, and with your own image server.
- Muse's protocol method `mcpServer/list` does **not** list the servers defined in this file, so Antares reads the file itself (**Connectors**). Antares edits it only with a confirmation, a backup and an atomic write, and never shows a secret value.
- That file sits next to your credentials (`auth.json`). Never paste it anywhere.

## Example shape (untested)

The common way to give an agent a browser is a Playwright or Chrome-DevTools MCP server. In `settings.json` it would look like this (**not run or verified here**; a package downloaded by `npx` is third-party code that runs on your computer, so pin a version you have looked at):

```json
{
  "schema_version": 1,
  "mcpServers": {
    "browser": { "command": "npx", "args": ["@playwright/mcp@<version>"] }
  }
}
```

## Staying safe

Controlling a browser is the highest-impact thing an agent can do, because it can act on any account you are signed in to.

- Use a **separate browser profile with no logins** for the agent. Do not point it at your everyday browser.
- Prefer **Accept edits** or **Auto** over **Bypass permissions**, and read every approval. In Auto, an automated reviewer decides first; in Bypass there are no prompts at all.
- Read the page host and each step. Treat the window title and any label as untrusted text.
- A "Would send" list means the call would send data, and the host then offers one-shot choices only.
- Reject anything you did not expect. A rejection is not a stop: the model may try another route, which raises another approval.
- Muse's sandbox does not cover a browser the MCP server launches. Its limits are the server's, not Muse's.

## Verified

Unit tests cover the wording rules, masked secrets, non-ASCII hosts and hostile text, and the tool-argument lines. A synthetic Computer Use approval was rendered in VS Code and Antigravity IDE under the real content-security policy (markup in a window title stayed text). The Playwright MCP server was installed and driven for real (see "The Add the browser button" above). **No real Computer Use request was run, and no model has yet driven the browser in a chat.**
