<p align="center">
  <img src="media/antares.png" alt="Antares" width="96">
</p>

```text
   _   _  _ _____   _   ___ ___ ___
  /_\ | \| |_   _| /_\ | _ \ __/ __|
 / _ \| .` | | |  / _ \|   / _|\__ \
/_/ \_\_|\_| |_| /_/ \_\_|_\___|___/
```

**Antares** is an open-source editor interface for Muse Code, for VS Code and VS Code–based editors such as Antigravity. It talks to your locally installed `muse` through its official Muse Server Protocol (MSP), so Muse keeps doing the login, the model calls and the sandboxing. Antares only gives it a friendlier place to live.

> **Status: phase 1 in progress.** Antares verifies that it can talk to your local Muse and shows the Antares panel. There is no chat yet. See the [roadmap](#roadmap).

> **Unofficial.** Antares is an independent community project. It is not made, endorsed or supported by Meta or the Muse Code team. "Muse" and "Muse Code" belong to their owners.

## Why "Antares"?

Every project of the author is named after a star. Antares (α Scorpii) is the red supergiant at the heart of the constellation Scorpius. Its name comes from the Greek *Anti-Ares*, "rival of Mars", because its color is so close to the red planet's. A bright, red, easy-to-find light in a crowded sky, which is roughly what an agent interface should be.

## What Antares does and does not do

- It **launches the official `muse serve`** as a child process and speaks MSP (JSON-RPC 2.0, one JSON object per line over stdio).
- It **does not** read your `auth.json`, call the key-minting endpoint, or call the model API on its own. Your subscription stays attached to the official client; login happens through the host (device code flow) when that phase lands.
- It **defaults to a safer permission profile** than a bare install and always shows the active profile and sandbox availability. Ready sandbox checks do not mean a given session is contained, so the UI will not imply that.
- It **does not bundle or redistribute** Muse or its schemas. Protocol types are generated from the `muse` you have installed (`muse schema generate-json-schema`).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | MSP client, offline self-test (echo provider), Antares panel with banner | **Done** |
| 1 (MVP) | Chat with streaming; copy button on every message, code block, shell output and diff; paste text and images; approvals with visible profile and sandbox; model and reasoning-effort picker; token and subscription-usage panel (5 h and weekly windows, with threshold alerts); sessions (list, resume, fork) | **In progress** (protocol findings so far: [docs/PROTOCOL-NOTES.md](docs/PROTOCOL-NOTES.md)) |
| 2 | Voice input (local Whisper, transcript sent as text), skills (`/`), worktrees | Planned |
| 3 | MCP servers, plugins, hooks, editor diffs, terminal | Planned |
| 4 | Video input, polish, Open VSX / Marketplace packaging | Planned |

Details, decisions and open questions: [docs/PLAN.md](docs/PLAN.md) (in Portuguese for now).

Known limits worth stating up front:

- Muse accepts `text`, `image`, `skill` and `video` as turn input. There is no audio part, so voice must be transcribed client-side.
- Subscription usage is exposed as percentages of the 5 h and weekly windows plus the tier. There is no monetary figure in the protocol, so Antares will not invent one.
- Part of the protocol is experimental and may change between Muse versions. Antares checks the schema fingerprint at `initialize` and warns when it differs from the versions it was written against.

## Requirements

- Muse Code installed and, for later phases, logged in. Phase 0 needs no login.
- VS Code 1.90+ or a compatible fork. Tested: none yet in a GUI; the protocol layer is tested headless on Windows against Muse 1.4.14.
- Node.js 22+ to build from source.

## Try it (from source)

```bash
npm install
npm run typecheck
npm run build

# headless self-test of the protocol layer (no login, no model call)
npm run spike
```

The self-test starts `muse serve --provider echo --no-session-log --sandbox-network restricted` with an isolated config tree and no credentials, performs the MSP handshake, opens one ephemeral session, and closes the host. Expected output ends with `"ok": true`.

To run inside the editor, open this folder in VS Code and press `F5`, then run **Antares: Open** from the command palette. If `muse` is not on your `PATH`, set `antares.musePath` in Settings.

To install in Antigravity or another fork, build a VSIX with `npm run package` and install it with *Extensions: Install from VSIX…*.

## Project layout

```text
src/muse/host.ts      JSON-RPC client over the stdio of `muse serve`
src/muse/selftest.ts  offline end-to-end check (handshake + one echo session)
src/muse/locate.ts    finds the muse executable
src/muse/uuidv7.ts    MSP requires UUIDv7 command ids (v4 is refused)
src/ui/               webview panel and the startup banner
scripts/spike.ts      runs the self-test from the command line
scripts/probe-*.ts    protocol probes (one minimal turn; credential state). Run deliberately
docs/PLAN.md          roadmap, decisions, risks
docs/PROTOCOL-NOTES.md what has been observed on the wire vs. only read from the schema
```

## Contributing

Issues and pull requests are welcome. This README is updated at the end of every phase; please keep protocol claims tied to something you observed, and say so when something is inferred.

## License

[MIT](LICENSE)
