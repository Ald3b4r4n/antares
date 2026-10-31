# The Muse sandbox on Windows ("sandbox unavailable")

If Antares shows **sandbox unavailable** in the footer, or a shell command fails with
`environment failure: sandbox enforcement unavailable: windows_elevated setup_required`, this page is for you.

## What it means

Muse runs shell commands inside a sandbox in the modes that allow them (**Auto** and **Accept edits**). When the host
cannot use the sandbox, a shell command **fails before it starts**. Reading and editing files still works, and so do
web tools. Plan never runs commands. **Bypass permissions** runs them with no sandbox at all (not a fix).

Antares reads the host's own report (`initialize.sandboxAvailability`) as soon as the host starts, shows it in the footer
and under the mode selector, and adds a hint to the failed tool call. It never changes the sandbox itself.

## Set it up

1. Open **a terminal as Administrator** (right-click, *Run as administrator*).
2. Run `muse sandbox windows setup`. This is Muse's own command; it prepares the sandbox (Windows sandbox users and a
   network filter). Read what it asks before you accept.
3. Run `muse sandbox windows check`. A working setup prints `status=ready`, `sandbox_users_ready=true`,
   `capabilities_ready=true` and `wfp_ready=true`.
4. Open a **new** chat in Antares and look at the footer: it should say `sandbox available`.

## If the footer still says "unavailable" although `check` says "ready"

This was observed on the machine this extension was developed on, and the cause was **not found**. Facts:

- `muse sandbox windows check` and `setup` reported `status=ready` (runner trusted, version matches, users, capabilities
  and network filter ready) while `muse serve` reported `sandboxAvailability: "unavailable"`, with the same result for
  `muse.exe` and the versioned `muse-bin-<version>.exe`, and with `--sandbox-network restricted`. The host prints nothing
  about why, and the contract's `sandboxUnavailableReason` only has Linux values.
- The setup marker and sandbox users existed, and Muse's own sandbox log showed the sandbox being used earlier the same
  day. Running `setup` again changed nothing (it is idempotent when already ready).
- The same state was seen from a script, from inside the editor, and from an editor running as Administrator.

Things to try, in order (none confirmed to fix it):

1. Start Muse's own terminal app with a **sandboxed** profile: `muse --permission-profile :ask-me`, and ask it to run `echo hi`. Look at the status line at the bottom: **YOLO** (in red) means approval **and the sandbox are off**, so a command working there says nothing about the sandbox. (On the development machine the terminal app ran in YOLO, and `echo hi` worked, both in an editor terminal and in a plain PowerShell.) If it works under `:ask-me` and Antares still fails, the difference is in how the host is launched; if it fails with the same message, the problem is in Muse's sandbox on that machine, and it is theirs to fix.
2. ~~Launch the editor elevated.~~ **Tested and ruled out:** Antigravity IDE opened as Administrator (the window title showed `[Administrator]`) still showed `sandbox unavailable` in a new chat, with `muse sandbox windows check` reporting ready. Elevation of the parent process is not the cause.
3. Check that no security software blocks the sandbox users, and that Muse is installed per user as usual.
4. Report it with the output of `muse sandbox windows check` and the footer text, to the Muse team (it is their host)
   and as an issue on the Antares repository.

## A reproducible difference: `muse exec` works, `muse serve` does not

Measured on the development machine (Windows, Muse Code 1.4.14), same profile and same prompt ("run `echo antares-sandbox-test` with your shell tool"):

| How Muse was started | Profile | Result |
|---|---|---|
| `muse exec --permission-profile :ask-me "..."` (headless, in-process) | `:ask-me` (sandboxed) | The command **ran**; the output `antares-sandbox-test` came back |
| `muse serve` (what Antares and any MSP client use), session started with `:ask-me` | `:ask-me` | The tool call **failed**: `environment failure: sandbox enforcement unavailable: windows_elevated setup_required: windows elevated sandbox setup has not run` |
| `muse` terminal app, default profile | YOLO (no sandbox, no approval) | Works, but proves nothing about the sandbox |

Also for `muse serve`: `initialize` reports `sandboxAvailability: "unavailable"` with no reason, for the default options, `--sandbox-network proxy-only`, `restricted` and `enabled`, `--trust-workspace`, `--no-session-log` and `--provider echo`, for `muse.exe` and for the versioned binary, and from an editor running as Administrator. `muse sandbox windows check` says `status=ready` throughout.

So the sandbox itself works on that machine; the stdio host does not manage to use it. This looks like a defect or an undocumented condition in `muse serve` on Windows, not something Antares or a missing setup causes. **Please report it to the Muse team** with the table above. If you find what makes `serve` see the sandbox (an environment variable, a setting), please open an issue on the Antares repository so this page can say it.

Tried as a workaround and **rejected**: starting the host with `--disable-sandbox` under `:ask-me`. The shell command then ran with **no approval request at all** (0 approvals), so it is no safer than Bypass permissions, only less honest about it. Antares does not offer it.

Until it is fixed: Antares shows the problem in the footer and on the failed call, Plan and Accept edits still read and edit, and commands can be run in the editor's own terminal.

## Working without it

- **Plan** and **Accept edits** still read and edit files, which covers reviewing and writing code.
- Run tests and builds yourself in a terminal, or in the chat only if you choose **Bypass permissions** knowingly:
  no sandbox, no approval prompts, commands run with your user's permissions. Do not use it on a project you would not
  run unreviewed code in.

## What Antares will never do

Run `muse sandbox windows setup` for you, edit the sandbox, create accounts or change Windows settings. Those need your
own decision and, here, your own elevation.
