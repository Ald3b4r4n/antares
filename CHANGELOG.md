# Changelog

## Unreleased — phase 1 (in progress)

- Chat panel with streaming: assistant text arrives as it is generated; Stop interrupts the turn; New chat restarts the session.
- Copy button (two-squares icon) on every message and on each code block, through the host clipboard.
- Startup banner and logo at the top of the chat.
- Footer with model, context use, last-turn tokens, and the 5 h / weekly subscription windows when the host reports them.
- Permission profile per chat (`:read-only` default, `:ask-me`, `:auto-review`, `:unrestricted`), chosen in the header; changing it starts a new chat and asks for confirmation above read-only. Setting `antares.initialProfile`. `:read-only` also disables shell and file-write tools at the host.
- Tool-call cards (what ran, failed, was held by a hook) and approval cards that relay the host's own choices; unknown approval kinds are shown generically and never approved automatically.
- Model picker and reasoning-effort picker: the catalog is read from the host before the first message (no model call), the choice is remembered, effort tiers follow the selected model, and a remembered model that disappears falls back to the default with a notice.
- Image input: paste a screenshot, drop files, or use the attach button; thumbnails with remove, large images scaled to 2048 px, a refused send gives the images back. The host's `[Image #n]` markers are shown as chips with the local thumbnails. Images are validated again in the extension (type, signature, size, count), because the webview is untrusted input.
- Unit tests for the event mapper and an approval-relay test against a fake MSP host (`npm test`).
- Event mapper for the observed MSP notifications; offline `smoke` test and a browser `preview` with a fake host.
- Integration suite (`npm run test:editor`) that runs inside a real editor; passing on VS Code 1.143.1 and Antigravity IDE 1.107.0.
- Setting `antares.dev.provider` for offline development, and a small test API returned by `activate`.
- `docs/PROTOCOL-NOTES.md`: observed vs. schema-only behavior, from one real minimal turn.

## 0.0.1 — phase 0 (spike)

- MSP client over the stdio of `muse serve` (JSON-RPC 2.0, one object per line).
- Offline self-test: handshake plus one ephemeral `echo` session in an isolated config tree.
- Antares panel with startup banner and self-test result; commands `Antares: Open` and `Antares: Run offline self-test`.
- Verified headless on Windows against Muse 1.4.14 (schema fingerprint `sha256:c94c3d1f…`).
