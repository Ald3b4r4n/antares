# Changelog

## 0.0.1 — phase 0 (spike)

- MSP client over the stdio of `muse serve` (JSON-RPC 2.0, one object per line).
- Offline self-test: handshake plus one ephemeral `echo` session in an isolated config tree.
- Antares panel with startup banner and self-test result; commands `Antares: Open` and `Antares: Run offline self-test`.
- Verified headless on Windows against Muse 1.4.14 (schema fingerprint `sha256:c94c3d1f…`).
