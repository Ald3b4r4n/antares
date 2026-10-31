import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where local voice (faster-whisper and its model) lives: one folder per user, shared by every editor
 * that runs Antares, so a fork does not download the model again. `ANTARES_VOICE_HOME` overrides it
 * (tests, or a user who wants the files elsewhere).
 */
export function voiceHome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANTARES_VOICE_HOME) return env.ANTARES_VOICE_HOME;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Antares", "voice");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Antares", "voice");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "antares", "voice");
}

export const venvDir = (home: string): string => join(home, "venv");
export const modelCacheDir = (home: string): string => join(home, "models");

/** The Python inside the private virtual environment. */
export function venvPython(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venvDir(home), "Scripts", "python.exe") : join(venvDir(home), "bin", "python");
}
