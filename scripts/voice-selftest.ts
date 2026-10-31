// Self-test of local voice on THIS machine. Uses Windows text-to-speech to make known speech (no
// microphone), transcribes it with the real engines and compares with the expected text.
// Add --mic to also check that the microphone path works: that records about 1.5 s from the default
// input device into a temporary file, only checks that it is a valid WAV, and deletes it. Nothing is kept.
//
// Usage: ANTARES_VOICE_HOME=<dir> node scripts/voice-selftest.ts [--mic] [model]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { voiceHome } from "../src/voice/paths.ts";
import { WindowsRecorder } from "../src/voice/recorder.ts";
import { FasterWhisperTranscriber, WindowsSpeechTranscriber } from "../src/voice/transcribers.ts";
import { readWavInfo } from "../src/voice/wav.ts";

const root = resolve(import.meta.dirname, "..");
const wantMic = process.argv.includes("--mic");
const model = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "base";
const work = mkdtempSync(join(tmpdir(), "antares-voice-test-"));
const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function wordErrorRate(expected: string, actual: string): number {
  const a = normalize(expected).split(" ");
  const b = normalize(actual).split(" ");
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]! / a.length;
}

const cases = [
  { culture: "pt-BR", lang: "pt", text: "O Antares é uma interface aberta para o Muse Code, e ela transcreve a minha voz localmente." },
  { culture: "en-US", lang: "en", text: "Antares is an open interface for Muse Code, and it transcribes my voice locally." },
];

const home = voiceHome();
const whisper = new FasterWhisperTranscriber({ home, workerScript: join(root, "media", "voice-worker.py") });
const windows = new WindowsSpeechTranscriber({ scriptPath: join(root, "media", "voice-speech.ps1") });
let failures = 0;
try {
  console.log("voice home:", home);
  console.log("faster-whisper status:", JSON.stringify(await whisper.status()));
  console.log("windows speech status:", JSON.stringify(await windows.status()));

  for (const c of cases) {
    const wav = join(work, `${c.lang}.wav`);
    const tts = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "voice-tts.ps1"), "-Text", c.text, "-Out", wav, "-Culture", c.culture], { encoding: "utf8" });
    if (!existsSync(wav)) {
      console.log(`[${c.culture}] no TTS voice: ${(tts.stderr || tts.stdout).trim().slice(0, 120)}`);
      continue;
    }
    const info = readWavInfo(wav);
    console.log(`\n[${c.culture}] synthesized ${info?.durationMs} ms of speech: "${c.text}"`);
    for (const language of [c.lang, "auto"]) {
      const r = await whisper.transcribe(wav, { language, model });
      const wer = wordErrorRate(c.text, r.text);
      console.log(`  faster-whisper ${model}, language=${language}: "${r.text}"`);
      console.log(`    detected=${r.language} audio=${r.audioSeconds}s took=${r.elapsedMs} ms  word error rate=${(wer * 100).toFixed(0)}%`);
      if (wer > 0.25) failures++;
    }
  }

  if (wantMic) {
    console.log("\nMicrophone path (records ~1.5 s from the default input, validates the WAV, deletes it):");
    const rec = new WindowsRecorder({ scriptPath: join(root, "media", "voice-recorder.ps1"), maxSeconds: 10 });
    await rec.start();
    await new Promise((r) => setTimeout(r, 1500));
    const out = await rec.stop();
    const info = readWavInfo(out.path);
    console.log(`  recorded ${out.durationMs} ms; format: ${info?.sampleRate} Hz, ${info?.channels} ch, ${info?.bitsPerSample} bit`);
    rmSync(out.path, { force: true });
    if (!info || out.durationMs < 800) failures++;
  }
} finally {
  whisper.dispose();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nVOICE SELFTEST OK" : `\nVOICE SELFTEST: ${failures} problem(s)`);
process.exitCode = failures === 0 ? 0 : 1;
