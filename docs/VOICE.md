# Voice input

Antares turns your voice into **text in the message box**. You review it and press Enter yourself; nothing is sent automatically. Muse accepts `text`, `image`, `skill` and `video` as turn input and has no audio part, so transcription happens on your computer, before the turn.

Audio never leaves your machine with either engine. The recording is a temporary WAV file that is deleted as soon as it has been transcribed (or the attempt fails or is cancelled).

## Using it

- Click the microphone button next to the attach button, speak, click again to stop. `Esc` cancels while recording.
- The recognized text is inserted at the caret. If nothing was recognized, or the clip was under 0.3 s, Antares says so instead of inserting anything.
- If no engine is ready, the button explains why and offers **Set up local voice**.

## Two engines

| | faster-whisper (recommended) | Windows speech recognition |
|---|---|---|
| Accuracy | Much better; Whisper handles accents, mixed languages and technical words | Depends on the installed recognizer |
| Needs | A one-time setup: a private Python environment plus a Whisper model (see sizes below) | A **desktop speech recognizer** installed for your language in Windows |
| Works offline | Yes, after setup (the worker runs with `offline: true`) | Yes |
| Where it runs | CPU, `int8`, in a worker process that stops after a few idle minutes | Windows `System.Speech` |

Setting `antares.voice.engine`: `auto` (default) prefers faster-whisper when it is set up and falls back to Windows speech when that has a recognizer; `faster-whisper` and `windows` use only that engine. **A named engine is never silently swapped for the other one**: if it is unavailable, Antares says why.

Windows speech needs desktop recognizers (Settings → Time & language → Speech, or the language pack's speech feature). On the development PC none was installed, and Antares reports that plainly instead of assuming it works.

## Setting up faster-whisper

Run **Antares: Set up local voice** from the command palette. A dialog first lists exactly what will be downloaded and installed, and where; nothing happens until you accept. It also lets you choose another folder (it creates `<folder>/Antares/voice`).

What it does, in order:

1. Creates a private virtual environment (`venv`) with a Python 3.9+ you already have (setting `antares.voice.pythonPath`, or `py -3`, `python` or `python3` found on the machine). Antares does not install Python.
2. `pip install faster-whisper==1.2.1` and `av>=11,<19`.
3. Downloads the Whisper model from Hugging Face (Systran/faster-whisper-*).
4. **Verifies** the result: transcribes a silent WAV *offline* with the worker. Only then does it report success.

Sizes (measured with `base`; the download is smaller than what ends up on disk):

| Model | Download (approx.) | Notes |
|---|---|---|
| `tiny` | 75 MB | Fastest, least accurate |
| `base` (default) | 145 MB | Good balance on CPU |
| `small` | 465 MB | Better, slower |

On disk with `base`: about 290 MB for the environment plus about 140 MB for the model, so **plan for roughly 450 MB** (hence the setting description). A first `pip` run also leaves a cache of about 140 MB in the user's pip cache, which `pip cache purge` clears.

Default location: `%LOCALAPPDATA%\Antares\voice` on Windows. Override with the setting `antares.voice.home` (the setup command writes it for you when you choose a folder), or with the `ANTARES_VOICE_HOME` environment variable for scripts.

### Why `av<19`

`faster-whisper` 1.2.1 failed to open audio with `av` 19.0.2 (`open() got an unexpected keyword argument 'metadata_errors'`). The setup pins `av>=11,<19` (18.1.0 was verified) and the verification step exists so that this kind of break shows up during setup, not in the first dictation.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `antares.voice.engine` | `auto` | `auto`, `faster-whisper` or `windows` |
| `antares.voice.language` | `auto` | Spoken language, e.g. `pt` or `en`; `auto` lets Whisper detect it |
| `antares.voice.model` | `base` | `tiny`, `base` or `small` (changing it needs the setup command again) |
| `antares.voice.home` | empty | Install folder (empty = standard per-user location) |
| `antares.voice.pythonPath` | empty | Python used to create the environment |
| `antares.voice.maxSeconds` | 120 | A recording that reaches this length ends and is transcribed |
| `antares.voice.idleMinutes` | 5 | Minutes after which the Whisper worker is shut down to free memory |

## How it works, and what was measured

- **The microphone is read in the extension host, not in the page.** In both VS Code 1.143.1 and Antigravity IDE 1.107.0 the webview's iframe has no `microphone` in its `allow` list, and `getUserMedia` returns `NotAllowedError: Permission denied` (measured in both, in the real windows). So the page only shows the state and the extension host records.
- **Recording on Windows** uses the `waveIn` API (winmm) from a small PowerShell/C# script: 16 kHz, mono, 16-bit PCM, nothing to install. The first attempt used MCI, which refused 16-bit on the test device and delivered 8-bit audio; `waveIn` gives the format Whisper wants. A second bug found while testing this: PowerShell's `Console.In.ReadLineAsync()` completes synchronously, which blocked the capture loop until `stop`, so only the first four 100 ms buffers were kept (400 ms regardless of how long you spoke). Stdin is now read on a background thread; the self-test records 1.5 s and gets 1508 ms.
- **Other platforms:** recording is implemented for Windows only. On macOS and Linux the button reports that capture is not available yet (the Whisper side is cross-platform). This is a known gap for the open-source release.
- **Transcription quality** (speech synthesized by Windows, transcribed by `base` on CPU): Portuguese 18 % word error rate, English 14 %, roughly 0.8 to 1.6 s for 6 to 8 s of audio. The "Antares" name was heard as "And Terries" in English, so expect proper nouns to need a look before sending; that is the reason the text goes to the box rather than straight to Muse.
- **Real microphone, real Whisper** in a real window (silence): "No speech was recognized.", no file left behind.

## Verifying it yourself

```bash
# set up (downloads software and a model; run deliberately)
ANTARES_VOICE_HOME=<dir> node scripts/voice-setup.ts base

# synthesize speech, transcribe it with the real engines, compare; --mic also records ~1.5 s and deletes it
ANTARES_VOICE_HOME=<dir> node scripts/voice-selftest.ts --mic base

# the real editor, with a fake recorder / a missing engine / the real microphone and Whisper
E2E_VOICE=fake  node scripts/e2e-editor.mjs "<editor exe>" label
E2E_VOICE=error node scripts/e2e-editor.mjs "<editor exe>" label
ANTARES_VOICE_HOME=<dir> E2E_VOICE=real node scripts/e2e-editor.mjs "<editor exe>" label
```

Unit tests (`npm test`) cover the WAV parser, the recorder protocol (including stop, cancel and the length limit), engine choice, the controller state machine, the Whisper worker protocol (missing model, crash, noisy stdout) and the setup steps, with fake processes.

## Not done

- Push-to-talk and hands-free modes; a visual level meter.
- Recording on macOS and Linux.
- Windows speech cannot be tried on the development PC (no desktop recognizer installed), so that engine has only been exercised through its availability check and unit tests.
