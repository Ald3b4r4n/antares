# Changelog

## 0.2.2

- **Interface do chat no estilo do Capella:** passos do agente (pensamento e ferramentas) numa linha do tempo vertical, sem cartões, com bolinha por passo; balão do usuário à direita; erros em texto vermelho simples.
- **Thinking:** o item de raciocínio do Muse aparece como um passo recolhível.

## 0.2.1

- **Modo de uso:** o botão Standard/Contributor agora também permite mudar para Contributor (antes só havia o caminho para Standard), sempre com uma confirmação que explica o uso dos dados; o valor é relido do Muse depois de gravar.
- **Marketplaces:** novo item **Marketplaces** no menu "+" (antes só se chegava por Plugins > Marketplaces…).

## 0.2.0

Evolução em fases depois da auditoria de 2026-11-02 (detalhes e evidências em `docs/EVOLUCAO.md`):

- Catálogo de modelos: erros deixam de ser engolidos, o último catálogo válido é mantido e marcado como possivelmente desatualizado, há o botão ↻ Models, e mudanças no catálogo ou o desaparecimento do modelo lembrado são avisados. Detalhes em `docs/EVOLUCAO.md`.

- Modalidade Standard/Contributor (Fase B2): indicador somente leitura que diz "não confirmado" quando o valor salvo não prova o que está em vigor, diálogo de privacidade e troca para Standard com confirmação. Detalhes em `docs/EVOLUCAO.md`.

- Gerenciador de skills (Fase C): lista com escopo, origem e estado de ativação reais (da CLI oficial), busca e filtro, ligar/desligar com leitura de volta, instalar de pasta com validação e confirmação, remover, avisos de nomes repetidos. Detalhes em `docs/EVOLUCAO.md`.

- Gerenciador de MCP (Fase D): o painel de Connectors passa a listar os servidores do `settings.json` do Muse (o host não os mostra), com adicionar, editar, ligar/desligar e remover com confirmação, backup e gravação atômica, e um Test que pede ao próprio Muse que inicie o servidor sem usar modelo. Detalhes em `docs/EVOLUCAO.md`.

- Gerenciador de plugins (Fase E): lista o que cada plugin traz e o estado de revisão de seus hooks e servidores MCP, aprovação/rejeição individual com aviso (nunca automática), habilitar/desabilitar, atualizar, remover e visão de marketplaces com atualizar/remover, tudo pela CLI oficial com confirmação e leitura de volta. Detalhes em `docs/EVOLUCAO.md`.

- Catálogos sugeridos (Fase E2): marketplace oficial de plugins e coleção de skills da Anthropic, oferecidos (nunca adicionados sozinhos) com a oferta única na primeira abertura, e marketplaces próprios.
- Acompanha o plano (B3): relê o catálogo de modelos quando o plano muda e ao voltar o foco.
- Acesso à web (H): botão que mostra e altera `web_fetch` e `web_search` do Muse.
- Pré-visualização (I): botão Preview abre no navegador do editor um servidor local ou um HTML da pasta servido somente leitura em 127.0.0.1.

## 0.1.4

- **Fix: "Could not send the message: turn/start: frame exceeds the inbound limit (code -32002)" when several pictures are attached.** The host refuses a request above about 8 MiB (measured with `scripts/probe-frame-limit.ts`: 8 MiB passes, 10 MiB is refused) and Antares allowed 15 MB of pictures, which grow by a third as base64. The total is now 5.5 MB; a picture that does not fit in what is left is re-encoded as JPEG at a smaller size automatically, and an oversized request now gets a plain explanation.

## 0.1.3

- **Fix: the chat keeps scrolling down while the agent works.** Following used to switch itself off whenever the scroll position moved up, which also happens when the content shrinks for a moment (a message repainted, a card collapsing, the footer resizing), so the user had to keep pressing the jump-to-latest arrow. Now following stops only on a real user action (wheel up, keys, touch, dragging the scrollbar) and resumes when the bottom is reached; heights that change without a DOM change (images, footer) also keep the latest output in view.

## 0.1.2

- The banner now credits the author, **Antonio Rafael Souza Cruz de Noronha**, with a link to https://www.antoniorafael.com.br/ (also in the README and in the extension's author field).

## 0.1.1

- **Fix: "Open diff" and "Open file" did nothing for a file the agent had deleted** (typically a scratch file it created and then removed). The failure was silent because the chat's notices sit behind the Changes panel and the diff views. Now an editor notification says the file no longer exists, and **Open diff** still shows what the agent wrote when the edit created the file ("as the agent wrote it; the file no longer exists").
- Fix: the short (8.3) spelling of a folder is now resolved for a file that no longer exists, so it matches the workspace folders (it used to show a full path and no buttons).
- **Follows the output** with a jump-to-latest arrow, **Copy at the end of the turn**, **failed commands show their output**, and the Bypass footer no longer warns about the sandbox (all listed below under 0.1.0 as they were built after the first release candidate).

## 0.1.0 — release candidate

Everything below under "Unreleased" is part of this build. In one place:

- **Chat:** streaming, copy buttons, image paste/drop, tool cards, approvals (the host's own choices, shown once), five permission modes (Manual is shown unavailable: Muse has no such profile), model and effort pickers, subscription usage with alerts, session history (continue or fork).
- **Input:** voice dictation on Windows (faster-whisper or Windows speech, local), "+" menu with files, folders, skills, connectors, plugins and import, steer or queue while a turn runs.
- **Output:** checklists, file-edit diffs, a Changes view with cumulative diffs, workspace images, Computer Use approval cards, explanations for the sandbox failure.
- **Manage:** plugin install (folder or marketplace) and marketplaces, connector OAuth sign-in and sign-out, skill import. Each step says what it does and asks first.
- **Not built or not possible, with reasons:** video input (untestable end to end here), worktrees (the host's git probe times out on the test machine), an embedded terminal (left out on purpose), adding or removing MCP servers (the protocol has no setting), reading a skill's activation, the image a model saw through a tool, model-generated images, voice recording on macOS and Linux.
- **Known problem on the test machine:** the host reports the Windows sandbox as unavailable although `muse sandbox windows check` says ready; see docs/SANDBOX.md.
- **Sandbox, offered at the right moment:** when the sandbox is unavailable, the note under the mode selector and the failed shell call carry a **Switch to Bypass permissions…** button (it opens the confirmation; it never switches by itself), and the first blocked command in a chat also raises a notice in the message flow.
- **Activity-bar launcher:** an Antares icon in the activity bar (next to the other views); showing it opens the chat, and its view has buttons for usage and voice setup.
- **"+" menu additions:** *Add current file* (an @mention), *Add selection* (a quoted block naming the file and lines, capped at 20,000 characters) and files dragged from the Explorer (they carry only their addresses).
- **Voice language:** after each dictation Antares shows which language the engine heard, and the docs explain that `auto` guesses per clip (set `antares.voice.language`, and consider the `small` model).
- **Mode switch wording:** a chat with no messages yet no longer says "Start new chat" in the switch dialog; it says the new mode simply applies.
- **Follows the output, like other assistants:** the view scrolls down as text, tool cards and images arrive. Scrolling up (wheel, keys or the scrollbar) stops it, a round arrow button appears above the message box, and clicking it (or scrolling to the bottom) goes back to the latest message and follows again.
- **Copy at the end:** an assistant message no longer has a copy button while the agent works; one appears under the last message of the turn when it finishes. Code blocks keep their own copy button; your own messages keep theirs.
- **Failed commands show their output:** a shell call that exits with a non-zero status used to show only "process exited with status 1". It now shows the command's own output as text with the exit code (and a note when the host cut it).
- **Bypass footer:** the footer no longer shows a warning-coloured "sandbox unavailable" in Bypass, where the sandbox is not used; it says "not used (Bypass)".
- **Version** bumped from 0.0.1 to 0.1.0.

## Unreleased — phase 3D (second slice): changes in this chat

- A **Changes (n)** button (next to Usage) lists every file the agent changed in this chat, once, with its number of edits and `+n −m` totals. **Open diff** compares the file before the chat's first edit with now, in VS Code's diff editor; **Open file** opens it. The "before" is rebuilt by undoing the chat's edits from the most recent to the oldest. If a line inside a region an edit touched has changed since, no "before" is invented: the file opens and a note says why. Changes elsewhere in the file are kept (only the chat's edits are undone). Replayed history counts too, in the order the edits happened.
- Development setting `antares.dev.patchSeries` feeds successive patches of one file for the real-window check.
- **Not built, with reasons.** Worktrees (`session/start.worktree`, `worktree/list`): on the test machine the host's own git probe times out after 10 seconds (also for this project's repository) while `git` answers in 0.15 s, and `session/start` with a worktree answered "names no repository", so there was no way to create or test one. An embedded terminal: it would re-run what the agent ran under other permissions, which is not the same as seeing what it did; tool cards already show the command and its output.
- Probes: `scripts/probe-worktree.ts` and `scripts/probe-worktree-list.mjs`.
- Tests: 165 unit tests (2 new); the real-window flow now also checks the Changes panel and the cumulative diff (45 checks on both editors).

## Unreleased — phase 3C: images from the workspace

- A `read_file` of an image shows that file's thumbnail on its tool card, and `![alt](path)` in an assistant message shows the file. The page only asks; the **extension** reads the file and answers with the data or the reason it refused.
- What is read: no URL or network path (nothing is fetched), PNG, JPEG, GIF or WebP by name (SVG left out on purpose), inside the chat's folders after resolving symlinks and short names, up to 5 MB, and the bytes must really be that type. A refused image is replaced by its alt text and the reason.
- Measured, and why the image a model saw is not shown: one real turn where the model read a PNG with `read_file` returned only text ("Read image file ... as model-visible image output") and the item had no `modelVisibleContent` or `outputRef`, live or in the resumed history. Nothing for `item/readOutput` to fetch. Model-generated images remain unsupported by the contract.
- Probe: `scripts/probe-tool-image.ts` (one real turn, throwaway folder, generated PNG).
- Tests: 163 unit tests (8 new, every refusal path); the real-window flow checks a valid image, one outside the workspace and a web address (42 checks on both editors).
- Not verified: a real turn showing the cards in the interface (the events are synthetic in the window).

## Unreleased — phase 3B: browser and app control

- **Computer Use approvals.** When Muse sends `cuaCardFacts`, the approval card shows the page's host (with its plain `xn--` form and a warning when the address is not ASCII), the window title quoted and as plain text, each consequential step worded as the contract says ("Step N: action role "label" — effect"), and the data the call would send, with secrets masked and never shown. A warning says to read every step.
- **Tool approvals** (what an MCP browser tool's request looks like) list their arguments as `name: value` lines instead of one clipped blob.
- Fix: since the "+" menu work, approval cards had lost their padding because the queue list's `.pending` style also matched the approval card's own `pending` class. The queue styles are scoped to `#pending` again.
- New guide `docs/BROWSER.md`: what Antares does and cannot do (it cannot configure MCP servers), the observed `settings.json` shape, an untested example, and safety advice.
- Probes: `scripts/probe-mcp-config.ts` and `scripts/probe-mcp-config2.mjs` (throwaway config).
- Tests: 155 unit tests (3 new); the real-window flow now renders a synthetic browser approval with hostile markup in the window title (40 checks on both editors).
- Not verified: a real browser MCP server, a real Computer Use request; why the connector list did not show a hand-written server in the isolated trial.

## Unreleased — phase 3A (plugins and OAuth)

- **Plugins panel actions.** *Install from folder…* runs Muse's own `muse plugins validate` (read-only: it installs and executes nothing), then a dialog names the plugin, its version and description, the folder, and what it brings; hooks and MCP servers are called out as code that runs on this computer. *Install from marketplace…* lists what the configured marketplaces offer (`muse plugins list --available`), shows the source and says Antares cannot look inside before installing. *Add marketplace…* (name and source) says it installs nothing by itself. All three ask first; none approves what a plugin brings (that stays `muse plugins approve`).
- **Connector sign-in and sign-out.** The connector list shows Sign in or Sign out for servers the host can resolve by name. Sign-in asks the host to start the flow, shows only the **https origin** of the provider page in a dialog, opens the browser after you agree, waits up to five minutes (with Cancel) and reports how it ended. Declining, cancelling or timing out cancels the flow at the host. Sign-out deletes Muse's stored credential and asks the provider to revoke it (best effort). Antares never sees a token.
- Findings and probes: `scripts/probe-plugins.mjs` and `scripts/probe-plugins-msp.ts` (throwaway home); see the protocol notes.
- Tests: 152 unit tests (12 new, against the fake host); a new isolated real-window flow, `E2E_PLUGINS=1` (15 checks, plugins that only bring a skill), plus all earlier flows on both editors.
- Not verified: OAuth against a real provider (the test machine has no connector), and installing a plugin that brings hooks or MCP servers.

## Unreleased — phase 3A (first slice): import skills

- "Import skills…" in the "+" menu: choose Claude or Codex, see the host's own preview (`skill/import` with `dryRun`, which writes nothing), confirm in a dialog that lists the skills and says to read what you import, then the host imports them and the slash palette refreshes. Running it again reports what is already imported. Skill activation is not offered: it can be written but not read back (see the protocol notes).
- Tests: 140 unit tests (2 new); a new real-window flow, `E2E_IMPORT=1`, runs the real host with no model call in a throwaway HOME holding one fake Claude skill (12 checks on both editors); the other flows still pass (37 and 17).

## Unreleased — phase 3D (first slice): tool presentation and diffs

- `write_todos` shows a checklist (done, in progress, to do) instead of JSON.
- `write_file` and `edit_file` show the path relative to the workspace, `+n −m` and an inline diff taken from the host's own patch (`patchRef`). **Open diff** opens VS Code's diff editor with the file before (rebuilt from the patch and the file as it is now) and after; **Open file** opens it. If the file changed since the edit, the "before" side is not invented: the file opens and a note says why. Only files named by that call's patch and inside the chat's folders can be opened.
- The patch is read by the extension, never by the page, and only from a `*-tool_patch.json` under a `tool-outputs` folder, up to 512 KB. Replayed history shows the same cards.
- Development setting `antares.dev.patch` feeds the same code a patch, so the real-window check can open the diff without a model turn.
- Fix: when a mode switch cannot resume the session, Antares no longer leaves a blank chat. With no messages yet, the host may not have written the empty session before it stopped (`session not found`, about one run in five on Antigravity); the chat then starts fresh in the new mode. With a conversation, it is put back under the previous mode.
- Fix: after a fresh restart the sandbox note stayed while the footer's sandbox label cleared; both now clear and return with the host's report.
- Tests: 138 unit tests (15 new); the real-window flows pass on both editors (37 and 17 checks). The e2e now prints the page state and takes a screenshot when a run fails.

## Unreleased — fixes from the first real use

- **The sandbox, explained.** On a Windows PC where Muse's elevated sandbox was never set up, a shell command in Accept edits or Auto fails before it starts ("sandbox enforcement unavailable: windows_elevated setup_required") and the model then tries an approval escalation. Antares now (1) reads the host's `sandboxAvailability` as soon as the host starts and shows a note under the mode selector in modes that run commands in the sandbox, and (2) adds a hint under that failure on the tool card. Both name the fix, `muse sandbox windows setup` from an administrator terminal, and say that Antares never runs it. File reads and edits keep working.
- A tool call that ends with "approval aborted" now says what that means: it was rejected by you, by the automatic reviewer, or the turn was stopped while it waited.
- New `host` event (version and sandbox state before any session), so the footer shows the sandbox state before the first message too.
- Tests: 123 in total (4 new); the real-window runs pass on both editors (32 and 17 checks).

## Unreleased — phase 2C: permission modes

- A mode selector next to the model picker replaces the header's profile dropdown: **Auto** (`:auto-review`), **Manual** (unavailable), **Accept edits** (`:ask-me`), **Plan** (`:read-only`, the default) and **Bypass permissions** (`:unrestricted`). Keys 1 to 5 pick in the open menu; Shift+Tab in the message box cycles Auto, Accept edits and Plan and never lands on Bypass.
- Switching continues the conversation: the host is stopped and the same session is resumed under the new profile (with the host-level shell and write limits following the mode). Anything above Plan asks first and says what it grants; Plan does not. It is refused while a turn runs. With no stored session (nothing said yet, or the offline test provider) the chat restarts instead. Folders added through the "+" menu are kept.
- Manual is shown disabled with the reason, not simulated: Muse has no profile that asks before every edit.
- Plan mode shows a note with a button that switches to Accept edits to carry out the plan.
- Findings (docs/PROTOCOL-NOTES.md): the four approval modes select fine but do not make a stricter profile; live `session/setPermissionProfile` works but cannot lift a read-only host's tool flags; resume under any of the four profiles works.
- Probes: `scripts/probe-modes.ts`, `scripts/probe-resume-profile.ts`, `scripts/probe-approval.ts` (now takes `PROBE_APPROVAL_MODE` and `PROBE_LABEL`).
- Checked: 7 new unit tests (119 in total), and in VS Code 1.143.1 and Antigravity IDE 1.107.0 both the echo-provider flow (32 checks) and `E2E_MODES=1`, the real host with no model call (15 checks).
- Not done: switching mid-conversation after real turns was not exercised; `:auto-review` was not run with a real turn.

## Unreleased — phase 2B: composer "+" menu

- A "+" button replaces the attach button and opens a menu: **Add files or photos** (Ctrl+U), **Add folder**, **Slash commands**, **Connectors**, **Plugins**.
- Files and photos: chosen with the editor's own file dialog. Images (PNG, JPEG, GIF, WebP, up to 5 MB) become attachments with the same checks as a pasted one; other files become `@relative/path` mentions (quoted when the path has spaces); a file outside the workspace folders is refused with an explanation, because the host's file tools would refuse it.
- Add folder: asks first in a modal that says what it grants (and that Project Trust is not granted), shows a removable chip, is sent as the sticky `workspaceRoots` set with the next message (chat folder first, canonical paths, which the real host requires) and ends with the chat.
- Slash commands: typing `/` first opens a palette of the host's skills (`skill/list`: source, description, argument hint); Enter or Tab completes; `/skill args` goes as a `skill` input part only when the selector is in the host's list (the real host refuses unknown ones), otherwise as plain text.
- Connectors (`mcpServer/list`, experimental, on a short-lived host) and Plugins (`plugin/list`) as read-only lists. Managing them is phase 3A.
- Queue: while a turn runs the box stays usable; Enter steers the running turn (`ifBusy: steer`), Ctrl+Enter or the Queue button holds the message (`ifBusy: queue`) in a list above the box with a Remove button (`turn/unqueue`); the host's answer (`started`, `queued`, `steered`) is shown.
- Setting `antares.dev.picks` (development only) replaces the native file and folder dialogs so the real-window check can drive them.
- Checked: 15 new unit tests (112 in total), the real host with the echo provider (skill part, canonical roots, mention), and 32 real-window checks each in VS Code 1.143.1 and Antigravity IDE 1.107.0. Findings in `docs/PROTOCOL-NOTES.md`.
- Not done: dragging files from the Explorer, "current file" and "selection" mentions, `skill/import`, a check with a real model that the agent reads an added folder.

## Unreleased — phase 2A: voice input

- Microphone button in the composer. The recognized text is inserted at the caret for review; nothing is sent automatically. `Esc` cancels a recording.
- Two local engines: faster-whisper (recommended; private Python environment, Whisper model, offline after setup, worker stopped when idle) and Windows speech recognition (needs an installed desktop recognizer; reported as unavailable otherwise). `antares.voice.engine: auto` prefers faster-whisper and never silently swaps a named engine.
- Command `Antares: Set up local voice`: shows what will be downloaded and where, asks for consent, lets you pick the folder, installs `faster-whisper==1.2.1` (with `av>=11,<19`), downloads the model and verifies it by transcribing a silent clip offline. Settings `antares.voice.*`.
- Recording happens in the extension host (Windows `waveIn`, 16 kHz mono 16-bit), because the webviews of VS Code and Antigravity IDE deny the microphone (measured). The temporary WAV is deleted after use.
- Fix found while testing: an MCI-based capture delivered 8-bit audio on the test device, and a blocking stdin read limited every recording to 400 ms; both replaced.
- Checked: unit tests (97 in total), synthesized-speech self-test with the real engine (pt 18 %, en 14 % word error rate), and real-window checks in VS Code 1.143.1 and Antigravity IDE 1.107.0 (fake recorder, missing engine, and real microphone with real Whisper). See `docs/VOICE.md`.
- Not done: recording on macOS and Linux; Windows speech could not be tried end to end here (no recognizer installed).

## Unreleased — phase 1 (in progress)

- Chat panel with streaming: assistant text arrives as it is generated; Stop interrupts the turn; New chat restarts the session.
- Copy button (two-squares icon) on every message and on each code block, through the host clipboard.
- Startup banner and logo at the top of the chat.
- Footer with model, context use, last-turn tokens, and the 5 h / weekly subscription windows when the host reports them.
- Permission profile per chat (`:read-only` default, `:ask-me`, `:auto-review`, `:unrestricted`), chosen in the header; changing it starts a new chat and asks for confirmation above read-only. Setting `antares.initialProfile`. `:read-only` also disables shell and file-write tools at the host.
- Tool-call cards (what ran, failed, was held by a hook) and approval cards that relay the host's own choices; unknown approval kinds are shown generically and never approved automatically.
- Model picker and reasoning-effort picker: the catalog is read from the host before the first message (no model call), the choice is remembered, effort tiers follow the selected model, and a remembered model that disappears falls back to the default with a notice.
- Image input: paste a screenshot, drop files, or use the attach button; thumbnails with remove, large images scaled to 2048 px, a refused send gives the images back. The host's `[Image #n]` markers are shown as chips with the local thumbnails. Images are validated again in the extension (type, signature, size, count), because the webview is untrusted input.
- Subscription usage: the 5 h and weekly windows in the footer with an "as of" time, colour at the first and last alert thresholds, and an expired window shown as reset instead of a stale percentage; a status bar item; threshold alerts (default 80% and 95%) that fire once per window and re-arm on reset, as an editor notification and a chat notice; a local token ledger (this chat and today) counted once per host event id; fresh reads with `usage/refresh` on a short-lived host when a chat opens or on demand, at most once a minute. Commands: `Antares: Show subscription usage`, `Antares: Refresh subscription usage`.
- Session history: a History panel lists the open folder's stored sessions (newest first, filter by title, other folders shown disabled); Continue redraws the conversation (messages, tool calls, image chips; hooks and reminders left out) and resumes with the chat's permission profile named explicitly; Fork is offered in Read-only chats only. No renaming (unsupported by the host on Windows).
- Fix: if the Muse process cannot be started, `stop()` no longer waits forever for an exit that cannot come (it could have frozen New chat or closing the panel), and a write to a dead host no longer raises an unhandled error.
- Real-window end-to-end check (`node scripts/e2e-editor.mjs`): drives the actual VS Code and Antigravity IDE windows over CDP with screenshots; 18 checks pass on both.
- Fix: the block-letter banner replaces slash-and-underscore lettering that was unreadable in the real editor; narrow panels no longer overflow (header wraps, banner scales, selectors and composer stack) down to about 220 px.
- Real approvals: checked against the real host, through the session code and in the real editor window (a real model turn asks for network access; the card shows the host's own choices; allowed once and rejected both work). The host's `abort` decision is what "Reject" sends.
- Fix: the host announces every approval twice (the request and an `approval/requested` notification), which showed it twice to anything consuming the session and made the second decision fail with "already resolved"; each (approval, stage) is now shown once. A later stage of a multi-stage approval (same approval id, new requirement) now replaces the card, because a decision aimed at the old stage would be refused. The extended-length `\\?\` prefix is hidden in shell approvals.
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
