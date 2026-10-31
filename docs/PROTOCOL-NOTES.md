# MSP: what we have actually observed

Muse 1.4.14, schema fingerprint `sha256:c94c3d1f…`, Windows. Everything below was seen on the wire with `scripts/spike.ts`, `scripts/probe-turn.ts` or `scripts/probe-account.ts`. Anything not listed here is only known from the exported schema and is **unverified at runtime**.

## Observed

- **Handshake.** `initialize` returns `serverInfo`, `userAgent`, `museHome`, `platformFamily`, `schema{version,fingerprint}`, `grantedCapabilities`, `experimentalApi`, `sessionDurability`, `sandboxAvailability`. With `capabilities.experimentalApi: true` the experimental methods are available (`account/read` answered).
- **Durability.** `--no-session-log` makes the host `ephemeral`; an ephemeral host refuses `permissionProfile` at `session/start` per the schema. Without that flag it is `durable` and writes the session log under the data dir.
- **Session start.** `session/start` answers with `session` and `viewCursor`, and the host also broadcasts `session/started`. The connection is subscribed to view events from that cursor on.
- **Turn lifecycle (failure path).** `turn/start` is acknowledged with `status: accepted`, `turnId` (equal to the `commandId`) and `disposition: started`. Then: `session/statusChanged` (`running`), `turn/started`, `item/completed` (a `userMessage` item carrying the prompt `text`), `turn/completed`, `session/statusChanged` (`idle`).
- **Turn failure shape.** `turn/completed` carries `terminal: "failed"`, `reason`, `durationMs` and `error{kind, message, retryable}`. Seen: `kind: "authRequired"`, `retryable: false`, 99 ms, no model call.
- **Auth state.** `account/read` returned `{state: "loggedOut", credentialRequired: true}` for a host with an isolated config/data tree, although an auth file existed at the default location. The product credential is therefore not (only) that file. Antares must run the host in the user's normal environment and read login state through `account/read`.
- **Catalog while logged out.** In the isolated host: `model/list` returned `source: "bundledCatalog"` with an empty `models` array, and `usage/read` returned `{}`.
- **Shutdown.** Closing stdin ends the host with exit 0 (`exit reason recorded: stdin_closed`); `session/closed` (`hostShutdown`) is broadcast first.

## Observed with a logged-in host (one minimal real turn)

Setup: `scripts/probe-turn.ts --real-env`: the user's normal environment, `--disable-shell --disable-write`, profile `:read-only`, empty workspace, prompt "Reply with exactly: ok". `account/read` reported `state: "accountLogin"`.

- **Models.** `model/list` returned `source: "providerCatalog"` with three models for provider `meta`: `muse-wonder-1.0` (default), `muse-spark-1.3`, `muse-spark-1.2`. Each row has `contextLimit` (1,007,997), `outputLimit` (128,000), `releaseDate`, `isDefault`, `variants` (reasoning tiers `minimal`..`max`; `max` is absent on `muse-spark-1.2`), `defaultReasoningEffort`, and `cost: null`. This is the catalog for that account at that moment, not a claim about other tiers.
- **Streaming.** Assistant text arrives as `item/started` (`kind: agentMessage`), then `item/delta` with `{itemId, field: "text", delta}`, then `item/completed` carrying the full `text` and `messagePhase`. The one-word reply produced a single delta, so multi-delta behavior is still unobserved.
- **Other item kinds seen in one turn:** `userMessage`, `hookRun` (`hookKey`, `event`, `label`, `runStatus`; the user's configured hooks ran), `reminderChild` (`reminderAgentId`, `childSessionId`, `blocking`). The turn emitted `turn/foregroundCompleted` with `blockingAgents` (`goal-reminder`, `verify-reminder`) and only then `turn/completed`, about 7 s later, so a UI must not treat `foregroundCompleted` as the end.
- **Tokens.** `session/tokenUsage`: `usage{inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheReadTokens, reasoningTokens}`, `promptTokens`, `totalTokens`, `durationMs`, and a `cumulative` block. A trivial prompt reported 41,910 prompt tokens, so the baseline context (instructions plus tool definitions) is large. Whether the reminder child sessions are counted in this figure is unknown.
- **Context.** `session/contextUsage`: `windowTokens`, `usedTokens`, `pressure` (`normal`).
- **Subscription usage.** `usage/read` returned `{}` before the first turn and `{usage: ...}` after. `usage/changed` carried `window{usedPercent, windowDurationMins: 300, resetsAtMs}`, `weekly{usedPercent, resetsAtMs}`, an opaque `tier` id and `observedAtMs`. These percentages are account-wide; they must not be attributed to a single turn.
- **Turn end.** `turn/completed{terminal: "completed", durationMs, timeToFirstTokenMs}`.
- **Side effects of a real-environment run.** The user's hooks executed, and a session was written to the user's real session history.

## Not observed yet

- Reasoning items, tool-call items, and the `approval/request` flow as seen from a client.
- Multi-delta streaming, interrupts (`turn/interrupt`), `session/modelChanged`.
- Image input, `session/resume`, `session/fork`, worktrees.

## Consequence for the extension

- Never infer login from a file; ask the host (`account/read`: `accountLogin` when logged in, `loggedOut` otherwise), and offer `account/loginStart` (device code) when `loggedOut`.
- Treat `turn/completed.terminal !== "completed"` as a failure and show `error.message`. A turn can end quickly without any model call.

## Observed: permission profiles, tools and the sandbox (two minimal real turns)

Setup: `scripts/probe-approval.ts`, the user's normal environment, an empty throwaway workspace, profile `:ask-me`, one real turn each (about 44.6k tokens per turn). The script was deny-only; it never had anything to deny, because no approval was requested.

- **No `approval/request` was seen in either turn.** The approval shapes in `src/muse/events.ts` come from the exported schema only, and are covered by tests against a fake host (`test/`), not against a real request.
- **The sandbox reported unavailable.** `muse serve` in the user's normal environment reported `sandboxAvailability: "unavailable"`, while `muse sandbox windows check` run at the same time printed `status=ready`. The two are not the same check. Why they differ is unknown.
- **Shell fails closed without the sandbox.** The shell tool is named `powershell`, with args `{command, description}`. Under `:ask-me` it failed with `environment failure: sandbox enforcement unavailable: windows_elevated setup_required: windows elevated sandbox setup has not run`, and the failure text says the command was never started. No approval was requested.
- **File writes inside the workspace ran without a prompt under `:ask-me`.** The `write_file` tool (args `{path, content}`) completed with `wrote 5 bytes to <path>`, in the throwaway workspace. So "ask me" does not mean "asks for everything"; what it asks for is decided by the host's policy, and Antares does not try to predict it.
- **Tool-call items.** `item/started`, `item/updated`, `item/completed` with `kind: "toolCall"` carry `tool`, `callId`, `args` (a JSON string), `held` and `heldFor` (seen: `held: true`, `heldFor: "hook"`, i.e. a user hook ran first), and on completion `failureReason` and/or `visibleOutput`.
- **Session object.** On this (stable) connection `session/start` returned no `permissionState`; the profile is therefore taken from what was requested, not read back.

Consequences for the UI: show every tool call and its outcome, show the host-reported sandbox state next to the profile, and describe profiles only with what was observed or published.

## Observed: model catalog and switching (no model call)

Setup: `scripts/probe-model.ts`, the user's normal environment, `:read-only` with shell and writes disabled, an empty throwaway workspace. It lists models, switches the model with `session/setModel`, lists again, restores the model and sets a reasoning effort. No turn was sent, so no tokens were spent. It did leave one empty session in the user's real session history.

- **`model/list` works before any session exists** (params `{}`): `source: "providerCatalog"`, three rows for provider `meta`. Antares therefore starts the host without a session ("warm-up") to fill the picker before the first message. Warming makes no model call.
- **Row fields:** `modelId, displayLabel, providerId, profileId, releaseDate, description, contextLimit, outputLimit, cost, isActive, isDefault, variants, reasoningEffortVariants, defaultReasoningEffort`. `cost` was `null`. `isActive` is only set when `sessionId` is passed; with none, no row is active.
- **`session/start`** returns `session.modelId` (the default model when none was asked for) and `providerId`.
- **`session/setModel`** takes `{commandId, sessionId, model: {modelId, providerId?, profileId?, displayLabel?}}`, answers `{status: "accepted"}`, and the host broadcasts `session/modelChanged` `{modelId, providerId, source: "user"}`. A later `model/list` with the session id flips `isActive`.
- **`session/setReasoningEffort`** is accepted and broadcasts `session/reasoningEffortChanged` `{reasoningEffort, source: "user"}`. Antares does not use the session default: it sends `reasoningEffort` on `turn/start` only when the user picked one, so "Default" means the model's own default. The tiers offered are the row's `variants` (they differ per model; one model lacked `max`).
- **Not observed:** what a turn does with a non-default effort, and a `session/start` refused for an unknown `modelId` (Antares retries without the model and says so; that path is covered only by a fake-host test).
