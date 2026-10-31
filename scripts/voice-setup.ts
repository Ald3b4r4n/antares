// Sets up local voice (faster-whisper in a private venv, plus the Whisper model) using the same code the
// extension's "Antares: Set up local voice" command uses. It downloads software and a model: run it
// deliberately. Idempotent.
//
// Usage: ANTARES_VOICE_HOME=<dir> node scripts/voice-setup.ts [model]
import { resolve } from "node:path";
import { consentText } from "../src/voice/setup.ts";
import { installFasterWhisper } from "../src/voice/setup.ts";
import { voiceHome } from "../src/voice/paths.ts";

const model = process.argv[2] ?? "base";
const home = voiceHome();
console.log(consentText(home, model));
console.log("");
const started = Date.now();
await installFasterWhisper({
  home,
  model,
  workerScript: resolve(import.meta.dirname, "..", "media", "voice-worker.py"),
  onStep: (step, detail) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${step}: ${detail}`),
});
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
