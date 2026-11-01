# Install and use Antares

Antares is an unofficial, open-source editor interface for **Muse Code**. It runs inside VS Code or a VS Code-based editor such as Antigravity IDE and talks to your own installed `muse`. Portuguese version: [INSTALL.pt-BR.md](INSTALL.pt-BR.md).

## 1. What you need first

| Need | Check |
|---|---|
| **Muse Code installed and logged in** | In a terminal: `muse --version` prints a version (tested with **1.4.14**), and you have run `muse login` once. Antares never handles your login. |
| **VS Code 1.90+ or a compatible editor** | Tested on VS Code 1.143.1 and Antigravity IDE 1.107.0 (Windows). |
| **A folder to work in** | Open your project folder in the editor first. Muse works inside a workspace. |
| *(optional)* Python 3.9+ | Only for local voice dictation with faster-whisper. |

Windows is the tested platform. macOS and Linux may work for the chat, but were not tested, and voice recording is Windows-only for now.

## 2. Install

1. Download **`antares-0.1.4.vsix`** from the [Releases page](https://github.com/Ald3b4r4n/antares/releases) (it is a pre-release).
2. Install it, either way:
   - **In the editor:** open the Extensions view, click the **`...`** menu at its top, choose **Install from VSIX...**, pick the file.
   - **From a terminal:** `code --install-extension antares-0.1.4.vsix` (use your editor's command instead of `code`, for example `antigravity-ide`; its `bin` folder is in the editor's install directory).
3. **Reload the window**: `Ctrl+Shift+P`, then *Developer: Reload Window*.

To build it yourself instead: `git clone https://github.com/Ald3b4r4n/antares`, then in `muse-extension` run `npm install`, `npm run build`, `npm run package`, and install the `.vsix` it creates (Node.js 22+).

## 3. Open it

- Click the **Antares icon in the activity bar** (the left strip), or
- `Ctrl+Shift+P`, then **Antares: Open**.

The chat opens beside your editor. The first thing you see is the Antares banner. If you see "Muse executable not found", set `antares.musePath` (next section).

## 4. Configure (all optional)

Open Settings (`Ctrl+,`) and search for **antares**, or edit `settings.json`:

```json
{
  "antares.musePath": "C:\\Users\\you\\AppData\\Local\\Programs\\muse\\muse.exe",
  "antares.initialProfile": ":read-only",
  "antares.usage.alertThresholds": [80, 95],
  "antares.voice.home": "D:\\programas\\Antares\\voice"
}
```

| Setting | What it does |
|---|---|
| `antares.musePath` | Full path to `muse` when it is not on your `PATH`. |
| `antares.initialProfile` | The permission profile a new chat starts in. Default `:read-only` (the **Plan** mode). |
| `antares.usage.alertThresholds` | Percentages of your subscription windows that raise an alert (default 80 and 95). |
| `antares.usage.refreshOnOpen` | Read fresh usage when a chat opens (no model call, at most once a minute). |
| `antares.voice.*` | Voice dictation (below). |

## 5. Optional: voice dictation

Dictation turns your voice into text **on your computer**; the text lands in the message box for you to review. Audio is never sent anywhere and the temporary recording is deleted.

1. `Ctrl+Shift+P`, then **Antares: Set up local voice**.
2. Read the dialog: it lists what will be downloaded (a private Python environment, `faster-whisper`, and a Whisper model, about **450 MB** with the default `base` model) and where. You can choose another folder (for example a drive with more space). Nothing happens until you accept.
3. When it finishes, click the **microphone** button in the chat. Click again to stop; `Esc` cancels.

If you installed voice in a custom folder, make sure `antares.voice.home` points to it. Windows speech recognition is an alternative with no download, but it needs a desktop speech recognizer installed for your language in Windows. Details: [VOICE.md](VOICE.md).

## 6. Use it

**The footer** shows the model, effort, context use and, when Muse reports them, your 5-hour and weekly subscription windows.

**Permission modes** (selector next to the model; `Shift+Tab` in the message box cycles; keys `1`-`5` pick in the open menu):

| Mode | What Muse can do |
|---|---|
| **Plan** (default) | Read only. Ask for a plan (try `/plan`). |
| **Accept edits** | Edits the workspace freely; asks for protected writes, new network targets and other restricted actions. |
| **Auto** | Same access, with an automated reviewer deciding first. |
| **Bypass permissions** | No sandbox and no approval prompts. Only for projects you accept exposing. |
| Manual | Not available: Muse has no profile that asks before every edit. |

Changing mode keeps the conversation. Anything above Plan asks you to confirm first.

**The "+" button** adds files and photos (`Ctrl+U`), a folder, the current file, the selection, a skill (`/`), shows connectors and plugins, installs plugins, and imports skills. You can also paste or drop images and files. Files outside the workspace need *Add folder* first.

**While Muse works:** `Enter` steers the running turn; `Ctrl+Enter` queues the message.

**Following the output:** the view scrolls as Muse writes. Scroll up to read something and it stops; click the round arrow button above the message box to jump back to the latest message. The **Copy** button for the answer appears under the last message when the task finishes.

**What Muse changed:** file edits show a diff on the tool card, and the **Changes** button lists every changed file with one diff per file.

**Approvals:** each one shows exactly what is asked, with Muse's own choices. Antares never decides for you.

## 7. If something does not work

| Symptom | What to do |
|---|---|
| "Muse executable not found" | Set `antares.musePath`. |
| "sandbox unavailable", shell commands fail | Read [SANDBOX.md](SANDBOX.md). Known problem with `muse serve` on Windows; Plan and Accept edits still read and edit, and Bypass runs commands (no sandbox). |
| Microphone button says voice needs setup | Run **Antares: Set up local voice**, or set `antares.voice.home`. |
| Dictation comes out in the wrong language | Set `antares.voice.language` (for example `pt`); see [VOICE.md](VOICE.md#the-text-comes-out-in-the-wrong-language). |
| Not logged in | Run `muse login` in a terminal, then start a new chat. |
| Browser control | Needs an MCP server you configure in Muse: [BROWSER.md](BROWSER.md). |

## 8. Update and uninstall

- **Update:** install the newer `.vsix` over the old one and reload the window.
- **Uninstall:** Extensions view, Antares, *Uninstall*. To remove voice, delete the folder you chose (default `%LOCALAPPDATA%\Antares\voice`).

## 9. Privacy in one paragraph

Antares launches the official `muse serve` and speaks to it locally. It does not read your `auth.json`, does not call the key-minting endpoint, and does not call the model API itself. Usage numbers come from Muse. Voice audio stays on your machine. Antares sends nothing to any server of its own (it has none).

## 10. What is still missing in 0.1.4

- **Video input** (not built; could not be tested end to end).
- **Worktrees** (the host's own git probe timed out on the test machine).
- **Voice recording on macOS and Linux** (Windows only).
- **An embedded terminal** (left out on purpose).
- **Adding or removing MCP servers** and **reading a skill's on/off state** (the protocol does not offer them).
- **The image a model saw through a tool** and **model-generated images** (Muse does not expose them).
- **Not verified with real services:** connector OAuth against a real provider, plugins that bring hooks or MCP servers, the Auto-review reviewer, and a real browser server.
- **Not published** to the Open VSX registry or the VS Code Marketplace yet; install from the `.vsix`.

The full status by phase is in the [README roadmap](../README.md#roadmap) and [PLAN.md](PLAN.md) (Portuguese).
