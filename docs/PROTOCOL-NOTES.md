# MSP: what we have actually observed

Muse 1.4.14, schema fingerprint `sha256:c94c3d1f…`, Windows. Everything below was seen on the wire with `scripts/spike.ts`, `scripts/probe-turn.ts` or `scripts/probe-account.ts`. Anything not listed here is only known from the exported schema and is **unverified at runtime**.

## Observed

- **Handshake.** `initialize` returns `serverInfo`, `userAgent`, `museHome`, `platformFamily`, `schema{version,fingerprint}`, `grantedCapabilities`, `experimentalApi`, `sessionDurability`, `sandboxAvailability`. With `capabilities.experimentalApi: true` the experimental methods are available (`account/read` answered).
- **Durability.** `--no-session-log` makes the host `ephemeral`; an ephemeral host refuses `permissionProfile` at `session/start` per the schema. Without that flag it is `durable` and writes the session log under the data dir.
- **Session start.** `session/start` answers with `session` and `viewCursor`, and the host also broadcasts `session/started`. The connection is subscribed to view events from that cursor on.
- **Turn lifecycle (failure path).** `turn/start` is acknowledged with `status: accepted`, `turnId` (equal to the `commandId`) and `disposition: started`. Then: `session/statusChanged` (`running`), `turn/started`, `item/completed` (a `userMessage` item carrying the prompt `text`), `turn/completed`, `session/statusChanged` (`idle`).
- **Turn failure shape.** `turn/completed` carries `terminal: "failed"`, `reason`, `durationMs` and `error{kind, message, retryable}`. Seen: `kind: "authRequired"`, `retryable: false`, 99 ms, no model call.
- **Auth state.** `account/read` returned `{state: "loggedOut", credentialRequired: true}` for a host with an isolated config/data tree, although an auth file existed at the default location. The product credential is therefore not (only) that file. Antares must run the host in the user's normal environment and read login state through `account/read`.
- **Catalog.** In the logged-out, isolated host: `model/list` returned `source: "bundledCatalog"` with an empty `models` array, and `usage/read` returned `{}`.
- **Shutdown.** Closing stdin ends the host with exit 0 (`exit reason recorded: stdin_closed`); `session/closed` (`hostShutdown`) is broadcast first.

## Not observed yet (need a logged-in host)

- Streaming deltas of the assistant message (item `updated` events), reasoning items, tool-call items.
- `session/tokenUsage`, `session/contextUsage`, `session/modelChanged` payloads.
- A populated `model/list` and `usage/read` (5 h and weekly percent blocks, tier).
- `approval/request` as seen from a client.

## Consequence for the extension

- Never infer login from a file; ask the host (`account/read`), and offer `account/loginStart` (device code) when `loggedOut`.
- Treat `turn/completed.terminal !== "completed"` as a failure and show `error.message`. A turn can end quickly without any model call.
