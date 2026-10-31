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

## Observed: image input (one real turn, about 42k tokens)

Setup: `scripts/probe-image.ts`, the user's normal environment, `:read-only` with shell and writes disabled, an empty workspace, a generated 64x64 solid red PNG (168 bytes), prompt "Reply with exactly one word: the dominant colour of the attached image."

- **The host accepts an `image` part and the model sees it:** it answered "red". The part was `{type: "image", mediaType: "image/png", base64Data, width: 64, height: 64}`, after the text part.
- **The user message comes back with a marker and metadata only.** The item's `text` had `[Image #1]` appended, and `attachments` was `[{type: "image", mediaType, width, height, attachmentId}]`. The bytes are not returned, so a UI that wants to show the picture has to keep its own copy.
- **An ephemeral host reports the marker but no metadata.** With the offline `echo` provider (`--no-session-log`) the text had `[Image #1]` and `attachments` was `[]`. Antares therefore counts images by the markers as well as by `attachments`.
- **Cost:** 41,942 input tokens for the image turn versus 41,910 for a text-only turn, so a tiny image added about 32 tokens. Larger images were not measured.
- **Not observed:** JPEG, GIF and WebP (they follow the contract but were not sent); the host's real size limits, which are not published. Antares' limits (6 images, 5 MB each, 15 MB total, long side scaled to at most 2048 px) are its own conservative choices.

## Observed: subscription usage (no model call, no session)

Setup: `scripts/probe-usage.ts`, the user's normal environment, `--disable-shell --disable-write`, no session. The provider's tier id is not printed or stored by the probe or by Antares.

- **`usage/read` on a freshly started host returns `{}`** ("nothing observed"). Without a refresh or a finished turn there is nothing to show.
- **`usage/refresh` works with no session** and no model call. It is experimental, so the experimental API must be negotiated (`capabilities.experimentalApi: true`, echoed back as `true`). Result: `{subscriptionActive: true, tierName: "<display name>", usage: {...}}`. The host documents it as one rate-bounded mint per host per 60 s. After it, `usage/read` returned the same observation and a `usage/changed` notification was emitted.
- **Shape (`SubscriptionUsage`):** `window: {usedPercent, windowDurationMins: 300, resetsAtMs}`, `weekly: {usedPercent, resetsAtMs}`, `observedAtMs` (when the host received the numbers) and `tier` (the provider's id; clients show `tierName`, never `tier`). Percentages are integers and may exceed 100. There is no monetary figure anywhere.
- **The numbers are point-in-time and account-wide.** The contract says to render "as of", never as live data. The 5-hour window was 25% in an earlier read and 2% in a later one (it had reset); the weekly figure moved from 30% to 31% across several test turns, so the cost of this project's real probes was small. `usage/changed` also arrives after a finished turn.
- **Not observed:** what the host does when the login has no subscription (the contract says `subscriptionActive: false` with no `usage`), and any behavior near or above 100%.

Design consequences: Antares uses a separate short-lived host for `usage/refresh`, so the chat host stays on the stable surface; keeps at least 60 s between refreshes; never polls; shows "as of"; treats a window whose `resetsAtMs` has passed as expired (shows "reset", raises no alert and re-arms); and counts tokens locally only from the host's `session/tokenUsage` reports, once per source event id.

## Observed: session list, resume and fork (no model call)

Setup: `scripts/probe-sessions.ts` and a check of the shipped code. Privacy: the user's history holds real conversations, so the probes printed only counts and field names, and resumed/forked **only sessions this project created itself** (recognised by the test prompts it used). No other session was opened. Resume and fork each leave a record in the session store; the fork created one more session in the user's history.

- **`session/list`** (`{limit: 200}`): `{sessions, nextCursor}`; 18 root sessions at the time, none of kind `subagent`, one page. Row keys: `sessionId, path, status, activeTurnId, createdAt, updatedAt, workspaceRoot, providerId, modelId, turnCount, forkedFrom, sideFrom, kind, createdByClient, lastActivityAt, title, firstUserPrompt`. **The contract says newest `updatedAt` first, but the observed order was not strictly that**, so Antares sorts by the later of `lastActivityAt` and `updatedAt`.
- **`session/read`** returns metadata only by default (`history.mode: "none"`); it does not attach or load.
- **`session/resume`** with `history: "inline"` returned `history.mode: "inline"` and the stored items in the same shape as live items (`userMessage` with `attachments`, `agentMessage`, `toolCall`, plus `hookRun` and `reminderChild`, which are background activity), `pendingRequests: []`, `lastTurn` and `viewCursor`. **Omitting `permissionProfile` restores the session's previous authority** (contract text), which could be broader than what the user picked in this chat, so Antares always sends the chat's profile on resume. `session/leave` was accepted afterwards.
- **`session/fork`** returned `session.forkedFrom` (`sessionId, cutCursor, cutExplicit, commandId`) and a new session id. **The contract does not admit `permissionProfile` on fork**, so Antares offers forking only in `:read-only` chats (where the host-level shell and write limits apply regardless of the profile). The inline history of the fork held only the assistant message, not the user message, so the UI says that what it shows is what Muse returned for the fork.
- **`session/rename` is not supported on this platform** (`-32601`, "not supported on this platform"), so Antares does not offer renaming.
- **Not observed:** a session whose history is not served inline (the contract says long sessions are downgraded to a snapshot or none; Antares then continues the session and says earlier messages are not shown, without paging them), resuming a session another client holds open, and a session created in the editor's own folder by another client (none existed).
- **Folder matching:** stored `workspaceRoot` values are whatever form the creating client used (this project's own sessions have 8.3 short names). Antares matches folders after normalizing separators, the `\?\` prefix, trailing slash and, on Windows, case; it cannot resolve 8.3 names, so such sessions can show up under "other folders".

## Observed: real approval requests (real model turns)

Setup: `scripts/probe-approval.ts` (deny-only), `scripts/probe-approval-flow.ts` (Antares' own session code) and the real-window run of `scripts/e2e-editor.mjs` with `E2E_REAL=1`; the user's normal environment, an empty throwaway workspace, profile `:ask-me`, a request to fetch `https://example.com`. A sanitized copy of the payloads is `test/fixtures/real-approvals.json`.

- **What asked for approval and what did not (under `:ask-me`):** network access (`web_fetch`) and a shell command asked. A file write **inside** the workspace did not ask (it ran). A write **outside** the workspace was refused by the tool itself (`absolute path is outside the workspace`), with no approval. `web_search` ran without asking.
- **`approval/request` (server request) shape:** `sessionId, approvalId, turnId, taskId, itemId, toolCallId, toolName, rawArgs, viewCursor, sourceRange, subject, currentRequirementId, availableChoices, protectedWrite, judgeEscalated`. Network: `toolName: "network"`, `subject: {kind: "network", toolName, host, port: 443, protocol: "https", origin: {kind: "url", url}}`. Shell: `toolName: "powershell"`, `subject: {kind: "shell", command, workspaceRoot, stages: []}` (`stages` was empty; `workspaceRoot` is in the extended-length form `\\?\C:\...`). `currentRequirementId` was `{approvalId, sourceIndex: 0}`. Neither `protectedWrite` nor `judgeEscalated` was set.
- **Offered choices.** Network: `allow_once` (approved, once), `allow_session` (approvedForSession, with `rulePreview: "example.com:443 (https)"`), `allow_local_network` ("Always allow this network destination", approvedPolicyAmendment, localPersistent, same `rulePreview`), and `abort` ("Reject", **decision `abort`**, `acceptsFeedback: true`). Shell: only `allow_once` and `abort`.
- **The host announces every approval twice:** as the server request (it expects a `{}` receipt as the response) and as an `approval/requested` notification with the same content. Showing both makes a client offer the same decision twice, and the second `approval/decide` fails with `approval ... is already resolved (code -32051)`. A client must show each approval once.
- **`approval/decide`** with `{commandId, sessionId, approvalId, choiceId, requirementId}` (plus `feedback` on a choice that accepts it) answered `{status: "accepted", terminal: true, approvalId, commandId}`. The authoritative outcome is `approval/resolved`: `{approvalId, itemId, turnId, decision, policyResult, resolvedBy: "user", decidedByCommandId, decidedAt, stageEvidence: []}`; a rejection was `decision: "abort"`, `policyResult: "deny"`.
- **Effects on the tool call.** Rejected network: the tool failed with `web_fetch failed: network access denied`. Rejected shell: the item ended `status: "rejected"` with `failureReason: "approval aborted"`. Allowed once: the tool completed (`web_fetch` completed and the model answered from the page).
- **The model works around a rejection.** After network access was rejected, the model tried the same fetch through a shell command, which raised a second approval, and then used `web_search` (which needed none). This happened with no note, with the note "Not now, thanks", and also when the note asked it not to look for another way. Whether the note reaches the model was not verified. Each request has to be read; a rejection is not a stop.
- **Not observed from the real host:** file-access, Unix-socket, process and unknown-kind subjects; multi-stage approvals (`terminal: false` then a re-sent request with a new `currentRequirementId`, covered only by a fake-host test); `protectedWrite` and `judgeEscalated` set; `:auto-review`.

## Observed: composer inputs (skills, plugins, MCP servers, queueing, workspace roots; no model call)

Setup: `scripts/probe-composer.ts` and `scripts/probe-skill-turn.ts` against the real `muse serve` 1.4.14 with the **echo provider**, an ephemeral session and throwaway folders, plus the real-window check. The user's own skill, plugin and server names were not printed; only counts and field names.

- **`skill/list`** (`{sessionId}`; needs a session) returned 32 rows on the test machine: 12 bundled, 18 user, 2 plugin. Row keys: `description, displayName, selector, source` (and `argumentHint` on 4 rows; `title` and `pluginId` are in the contract). `selector` is the token after the slash, bare or `plugin:skill`.
- **A `skill` input part** `{type:"skill", selector, source?, arguments?}` in `turn/start` was accepted and the stored user message reads `/plan tidy the README`. The host expands the skill itself (the echo reply began with a `skill-body` system reminder). **An unknown selector is refused** with `-32032` ("names no user-invocable skill"), so Antares sends a skill part only for a selector that is in the host's own list and sends anything else as plain text.
- **`plugin/list`** (`{sessionId}`, stable) answered with an empty list on the test machine (0 plugins), so row fields come from the contract only: `id, version, enabled, source` where `source` is `curated`, `marketplaceUserAdded`, `foreignImport` or `nativeLocal`.
- **`mcpServer/list` is experimental**: without the `experimentalApi` capability it fails with `-32601` ("requires experimentalApi capability"). With it, and no session, it returned the host-global set, empty on the test machine. Row fields (contract): `name, source (settings|plugin|session), transport (stdio|streamableHttp|unknown), oauth (loggedIn|loggedOut|notSupported)`. Antares uses a short-lived experimental host for it, like the usage refresh.
- **`hook/list`** (stable) answered with 11 rows (`enabled, event, handlerKind, key`); not used by the UI yet.
- **`ifBusy`**: a second `turn/start` while a turn runs returned `disposition: "queued"` by default and `"steered"` with `ifBusy: "steer"` (`startedNewTurn: false` for both); an idle one returned `"started"`. A queued submit gets its own `turnId` in the ack, and when it launches the `turn/started` carries that id; `turn/unqueue {sessionId, turnId}` takes it back and `turn/unqueued` is the notification. The unqueue of an already-launched turn was not exercised against the real host.
- **`turn/start.workspaceRoots` must be canonical paths.** A short 8.3 path (`C:\Users\ANTONI~1\...`) was refused with `-32602` ("expected a canonical path (resolves to `\?\C:\Users\Antonio Rafael\...`)"). The canonical extended-length form was accepted, for the chat's own folder and for an added one. The set is a sticky replacement, so Antares always sends the chat's own folder first and re-sends the set only when the user changed it.
- **Not observed (needs a real model turn):** whether the agent's file tools actually read inside an added root, and how the host treats an `@path` mention (including a quoted one with spaces, which is Antares' guess). A file outside the workspace was refused by the tool in an earlier probe, which is why Antares does not insert a mention for it.

## Observed: permission profile and approval mode switching (one real turn, rest without a model call)

Setup: `scripts/probe-modes.ts` (a real durable session that never receives a prompt, host started with shell and write disabled, experimental API negotiated), `scripts/probe-resume-profile.ts`, and `scripts/probe-approval.ts` with `PROBE_APPROVAL_MODE` (one real turn in a throwaway folder; every approval would have been rejected, none was asked).

- **`permissionState` and `approvalMode` are experimental fields.** A stable host returns neither on `session/start`. With the experimental API: `session.approvalMode = {mode, source, lastCommandId}` (a fresh `:ask-me` session was `onRequest`, source `startup`) and `session.permissionState = {profileId, reviewerAuthority, reviewerAttached, axes: {filesystem, network, approval, reviewer}}`.
- **`permissionProfile/list`** (experimental) served all four profiles as available, with the host's own descriptions: `:read-only` "Reads files only."; `:ask-me` "Edits workspace and temporary files; requires approval for protected writes, new network targets, and other restricted actions."; `:auto-review` "Same access as Ask me; AI reviews eligible actions; trusted permission hooks may decide approval requests first."; `:unrestricted` "No filesystem sandbox or approval prompts; local commands have direct network access; project trust is unchanged." Reviewer authority: human, human, autoReview, none.
- **Axes per profile:** `:read-only` sandboxed filesystem, network restricted; `:ask-me` sandboxed, network off, approval onRequest; `:auto-review` the same with reviewer autoReview; `:unrestricted` unrestricted filesystem, network enabled, approval allowAll, no reviewer.
- **`session/setApprovalMode`** (stable) accepted all four modes (`allowAll`, `promptUnmatched`, `onRequest`, `denyUnmatched`), answered `applyOutcome: completed` with the new `effectiveMode` and emitted `session/approvalModeChanged`. It did **not** change `permissionState.axes.approval`. It is a separate layer from the profile.
- **The approval mode is not a stricter "ask before every edit".** One real turn with `:ask-me` and `promptUnmatched` ("create a file named antares-note.txt"): `write_file` completed with no approval request (0 seen). So Muse has no way to ask before workspace edits through the approval mode; the profile decides what asks.
- **`session/setPermissionProfile`** (experimental) switched all four profiles live on a durable session (`applyOutcome: completed`, new `permissionState` in the result, `session/permissionProfileChanged` with `source: "livePicker"` and `session/statusChanged` carrying the state). The host had been started with `--disable-shell --disable-write`; those flags are host-level and a profile switch does not lift them, so a live switch from a read-only host to a writing profile would leave the tools disabled. Antares therefore does not use it.
- **`session/resume` with `permissionProfile`** (stable) worked for a session with no turns under each of the four profiles and with the host flags matching the target; the host reported the requested profile and axes each time, with inline history (`mode: "inline"`). A session that holds no conversation is resumable.
- **Not observed:** the same with a conversation that already has turns; the auto-review reviewer on a real turn; what `allowAll`, `onRequest` and `denyUnmatched` change in practice (only `promptUnmatched` was tried with a turn).
