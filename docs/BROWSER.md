# Browser and app control

Antares **does not configure or run a browser for you**. Muse Code controls a browser through an MCP server that *you* set up in Muse. Antares then shows what the agent is doing and asks you before each consequential action. This page says what is known, what is not, and how to stay safe.

## What Antares does

- Shows every tool call the agent makes, including the ones from an MCP server (name, arguments, result).
- Shows each approval request with the host's own choices. For an MCP tool the request is a **tool** approval and the arguments are listed as `name: value` lines (a URL, a selector, the text to type), so you can read exactly what is being asked.
- Renders **Computer Use** approvals when Muse sends them (the contract's `cuaCardFacts`): the page's host (with its plain `xn--` form when the address is not ASCII), the window title **quoted and as plain text** (it is the page's own words and can lie), every step that may have an effect ("Step 2: click button "Pay now" — may place an order"), and the data the call would send, with secrets shown masked, never their value.
- Never decides an approval by itself, and never approves in bulk.

## What Antares cannot do

- **Add, remove or edit an MCP server.** Muse's protocol has no setting for it (only nine host settings exist, none for MCP servers), so this is configuration you do in Muse itself.
- Run Computer Use setup. Muse describes that flow for macOS; what Windows offers is unknown.
- See into a plugin or MCP server before it runs.

## Where Muse reads MCP servers from (observed, partly)

Observed with Muse 1.4.14 in a throwaway config, through the CLI's own messages (`muse mcp login <server>`), not from documentation:

- The user settings file is `settings.json` in Muse's config folder (`~/.config/muse/` on the test machine). It needs `"schema_version": 1`; without it Muse reports "malformed settings file".
- Servers go under `mcpServers`, by name. A stdio server has `command` and `args`; a streamable-HTTP server has `type: "http"` and a `url`. Muse recognized both shapes, and said OAuth login applies only to the HTTP kind.
- Not confirmed: that the Antares **Connectors** list shows a hand-written server (in the isolated trial it came back empty even though the CLI found the server), and the exact fields Muse supports beyond these. Check Muse's own documentation before relying on this.
- That file sits next to your credentials (`auth.json`). Back it up before editing, and never paste it anywhere.

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

Unit tests cover the wording rules, masked secrets, non-ASCII hosts and hostile text, and the tool-argument lines. A synthetic Computer Use approval was rendered in VS Code and Antigravity IDE under the real content-security policy (markup in a window title stayed text). **No real browser MCP server and no real Computer Use request was run.**
