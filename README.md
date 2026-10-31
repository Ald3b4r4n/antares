<p align="center">
  <img src="media/antares.png" alt="Antares" width="96">
</p>

<p align="center">
  <img src="docs/images/antares-vscode.png" alt="Antares open in VS Code, with the offline echo provider" width="720"><br>
  <sub>Antares in VS Code (offline echo provider, throwaway profile).</sub>
</p>
<p align="center">
  <img src="docs/images/antares-approval.png" alt="A real approval request in Antares: network access to example.com, with the host's own choices" width="720"><br>
  <sub>A real approval request from Muse (network access), with the host's own choices.</sub>
</p>

```text
   _   _  _ _____   _   ___ ___ ___
  /_\ | \| |_   _| /_\ | _ \ __/ __|
 / _ \| .` | | |  / _ \|   / _|\__ \
/_/ \_\_|\_| |_| /_/ \_\_|_\___|___/
```

**Antares** is an open-source editor interface for Muse Code, for VS Code and VS Code–based editors such as Antigravity. It talks to your locally installed `muse` through its official Muse Server Protocol (MSP), so Muse keeps doing the login, the model calls and the sandboxing. Antares only gives it a friendlier place to live.

> **Status: phase 1 done, phase 2 started (voice input works on Windows).** Chat with streaming, tool-call cards, an approval UI, a per-chat permission profile, a model and reasoning-effort picker, image input, subscription-usage alerts, and a session history work. Approvals were checked against the real host (network and shell requests, allowed once and rejected, in the real editor window). See the [roadmap](#roadmap).

> **Unofficial.** Antares is an independent community project. It is not made, endorsed or supported by Meta or the Muse Code team. "Muse" and "Muse Code" belong to their owners.

## Why "Antares"?

Every project of the author is named after a star. Antares (α Scorpii) is the red supergiant at the heart of the constellation Scorpius. Its name comes from the Greek *Anti-Ares*, "rival of Mars", because its color is so close to the red planet's. A bright, red, easy-to-find light in a crowded sky, which is roughly what an agent interface should be.

## What Antares does and does not do

- It **launches the official `muse serve`** as a child process and speaks MSP (JSON-RPC 2.0, one JSON object per line over stdio).
- It **does not** read your `auth.json`, call the key-minting endpoint, or call the model API on its own. Your subscription stays attached to the official client; login happens through the host (device code flow) when that phase lands.
- It **starts every chat in the `:read-only` profile** with shell and file-write tools also disabled at the host. You can pick another profile in the header (setting `antares.initialProfile` sets the default); that starts a new chat and asks for confirmation. The profile and the sandbox state the host reports are always shown. Antares never decides an approval by itself.
- **A ready sandbox check is not an active sandbox.** In testing, `muse sandbox windows check` said `ready` while `muse serve` reported the sandbox unavailable and the shell tool failed closed. Antares shows what the host reports for the session.
- It **does not bundle or redistribute** Muse or its schemas. Protocol types are generated from the `muse` you have installed (`muse schema generate-json-schema`).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | MSP client, offline self-test (echo provider), Antares panel with banner | **Done** |
| 1 (MVP) | **Done:** chat with streaming, copy button on every message and code block, paste text, startup banner, usage/context/token footer, tool-call cards, approval cards (decide with the host's own choices), permission profile per chat with a confirmation for anything above read-only, model and reasoning-effort picker (catalog shown before the first message, choice remembered), image input (paste, drop or attach; PNG verified against the real host), subscription usage (5 h and weekly windows with "as of", threshold alerts, status bar, local token ledger), session history (continue or fork a stored session of the open folder, with the conversation redrawn). **Phase 1 feature list complete and checked in the real editors, including real approvals.** Not yet seen: file-access and Unix-socket approvals, multi-stage approvals from the real host (handled and tested against a fake one), and `:auto-review`. | **Done** (protocol findings: [docs/PROTOCOL-NOTES.md](docs/PROTOCOL-NOTES.md)) |
| 2A | **Done (Windows):** voice input. Microphone button, **local** transcription with faster-whisper (recommended) or Windows speech recognition; the text lands in the box for review and nothing is sent by itself. See [docs/VOICE.md](docs/VOICE.md). Recording on macOS and Linux is not implemented yet | **Done** |
| 2B | Composer "+" menu: attach photos and files (`@path` mentions; Muse has no file part), add a folder (grants access, so it asks), slash commands from Muse skills, connectors and plugins entry points, queue with Ctrl+Enter and steer with Enter | Planned |
| 2C | Permission modes selector (Automatic, Manual, Accept edits, Plan, Ignore permissions) that switches without losing the conversation. Mapped onto Muse's profiles and approval modes; "Accept edits" and "Plan" exist only on Antares' side and are explicit user choices | Planned: the mapping is confirmed by probes first |
| 3A | Connectors (MCP servers), plugins, hooks | Planned |
| 3B | Web and browser: reading the web already works with per-domain approvals; browser *control* through an MCP browser server the user configures, plus Computer Use approval cards if the host sends them (the host's own Computer Use is described for macOS only) | Planned |
| 3C | Show images in the chat: images the model saw (tool captures) and workspace image files. **Model-generated images only if the host delivers them; the contract says nothing about image output** | Planned |
| 3D | Editor diffs, terminal, worktrees | Planned |
| 4 | Video input, polish, Open VSX / Marketplace packaging | Planned |

Details, decisions and open questions: [docs/PLAN.md](docs/PLAN.md) (in Portuguese for now).

Known limits worth stating up front:

- Sessions: you can continue or fork stored sessions of the open folder (others are listed but cannot be opened from here). Renaming is not offered because the host does not support it on Windows. A fork cannot be given a permission profile, so forking is only offered in Read-only chats; a resumed session always gets the profile you chose, never the one it had. Very long sessions may not be replayed inline; Antares then continues them and says so.

- Muse accepts `text`, `image`, `skill` and `video` as turn input. There is no audio part, so voice is transcribed on your computer and the text goes to the message box.
- Voice: audio never leaves your machine and the temporary recording is deleted after transcription. **faster-whisper is the recommended engine** (run *Antares: Set up local voice* once; it asks before downloading anything and needs a Python 3.9+ you already have; plan for about 450 MB with the default `base` model, in a folder you can choose with `antares.voice.home`). *Windows speech recognition* is the alternative with no download, but it needs a desktop speech recognizer installed for your language. Recording is Windows-only for now, and is done by the extension host because the editors' webviews deny the microphone. Details and measurements: [docs/VOICE.md](docs/VOICE.md).
- Images: PNG was verified end to end against the real host; JPEG, GIF and WebP follow the contract but were not tried. The host's own size limits are unpublished, so Antares applies its own (6 images, 5 MB each, 15 MB total, scaled to 2048 px on the long side). Dropping files onto a webview may require holding Shift in VS Code; that has not been checked.
- Subscription usage is exposed as percentages of the 5 h and weekly windows. There is no monetary figure in the protocol, so Antares will not invent one. The numbers are as of the host's last read, not live: Antares shows the time, reads fresh numbers when a chat opens (`usage/refresh`, no model call, at most once a minute; setting `antares.usage.refreshOnOpen`) and after each message, and never polls. Alerts (default 80% and 95%, setting `antares.usage.alertThresholds`) fire once per window and re-arm when the window resets. The token counter is a local sum of what the host reports for chats run through Antares, not the account total.
- Part of the protocol is experimental and may change between Muse versions. Antares checks the schema fingerprint at `initialize` and warns when it differs from the versions it was written against.

## Requirements

- Muse Code installed and, for later phases, logged in. Phase 0 needs no login.
- VS Code 1.90+ or a compatible fork. Tested inside **VS Code 1.143.1** and **Antigravity IDE 1.107.0**, including a real-window check (see [Testing](#testing)). The protocol layer and the chat core are also tested headless on Windows against Muse 1.4.14.
- Node.js 22+ to build from source.

## Try it (from source)

```bash
npm install
npm run typecheck
npm run build

# headless self-test of the protocol layer (no login, no model call)
npm run spike

# chat core against the offline echo provider (no login, no model call)
npm run smoke

# open the real chat UI in a browser with a FAKE Muse host (no Muse process, no cost)
npm run preview   # then visit http://127.0.0.1:5757/
```

The self-test starts `muse serve --provider echo --no-session-log --sandbox-network restricted` with an isolated config tree and no credentials, performs the MSP handshake, opens one ephemeral session, and closes the host. Expected output ends with `"ok": true`.

To run inside the editor, open this folder in VS Code and press `F5`, then run **Antares: Open** from the command palette. If `muse` is not on your `PATH`, set `antares.musePath` in Settings.

To install in Antigravity or another fork, build a VSIX with `npm run package` and install it with *Extensions: Install from VSIX…*.

## Testing

```bash
npm run test:editor -- "<path to the editor executable>" vscode
```

This opens the editor with Antares loaded as a development extension in a throwaway profile, with the offline `echo` provider and an isolated Muse config (no login, no model call), and runs `test/suite` inside its real extension host. It checks that the webview loads and runs under the editor's CSP, that a turn streams and renders, that the copy buttons exist, that copying reaches the host clipboard, and that *New chat* restarts cleanly. 
### Real-window check

```bash
node scripts/e2e-editor.mjs "<path to the editor executable>" vscode
```

This launches the editor for real, with Antares loaded as a development extension in a throwaway profile (offline `echo` provider, isolated Muse config, no login, no model call), connects to it over the Chrome DevTools Protocol, opens the panel from the command palette, drives the **real webview** and saves screenshots of the real window to `spike-output/e2e/`. It checks 18 things, among them: the banner and logo load through the webview URI; a message round-trips; the copy button reaches the clipboard through the extension host; real key events (Enter sends, Shift+Enter does not); a pasted image shows its thumbnail under the real Content-Security-Policy and is sent; changing the profile asks for confirmation in the editor's own dialog and restarts the chat; the history panel answers; the status bar item exists; and the panel does not overflow when narrow (down to about 220 px). It found two real problems that the browser preview and the headless tests had not: an unreadable banner and a layout that overflowed in narrow panels. Passing on VS Code 1.143.1 and Antigravity IDE 1.107.0. On the first run, Antigravity IDE shows a welcome screen; the script only presses its plain "Get Started" button and never signs in.

With `E2E_REAL=1` it instead uses your own Muse login and runs a **real model turn that triggers a real approval** in the real window (`E2E_DECISION=allow` allows one fetch of `example.com` and nothing else; `E2E_DECISION=reject` rejects everything, with a note). It costs a real turn each time, and it starts your configured hooks. Both decisions passed every approval check on VS Code 1.143.1 (the one other failure on the first run was a wrong expectation about the status-bar text, since fixed).

Not covered: dropping files from the operating system onto the panel, and file-access, Unix-socket and multi-stage approvals from the real host.

## Project layout

```text
src/muse/host.ts      JSON-RPC client over the stdio of `muse serve`
src/muse/session.ts   one chat session over one host (turns, interrupt, approval relay, profile)
src/muse/events.ts    maps raw MSP notifications to the events the UI shows
src/muse/usage.ts     alert thresholds, token ledger, one-shot usage refresh
src/muse/images.ts    image input validation and turn input parts
src/muse/sessions.ts  session rows, folder matching and history replay
src/muse/selftest.ts  offline end-to-end check (handshake + one echo session)
src/muse/locate.ts    finds the muse executable
src/muse/uuidv7.ts    MSP requires UUIDv7 command ids (v4 is refused)
src/ui/               chat panel, shared page markup, startup banner, usage tracker (status bar, alerts)
src/voice/            dictation: recorder, engines (faster-whisper, Windows speech), controller, setup
media/chat.js|css     the chat webview (plain JS, no build step)
scripts/spike.ts      runs the self-test from the command line
test/                 unit tests (npm test) and the integration suite that runs inside a real editor
scripts/probe-*.ts    protocol probes (one minimal turn; credential state). Run deliberately
docs/PLAN.md          roadmap, decisions, risks
docs/PROTOCOL-NOTES.md what has been observed on the wire vs. only read from the schema
```

## Contributing

Issues and pull requests are welcome. This README is updated at the end of every phase; please keep protocol claims tied to something you observed, and say so when something is inferred.

## License

[MIT](LICENSE)
