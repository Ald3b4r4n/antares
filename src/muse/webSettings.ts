import { MuseHost } from "./host.ts";
import type { ContributorReadOptions } from "./contributor.ts";

/**
 * Web access for the agent. Muse has its own tools for it: `web_fetch` reads a page and `web_search` searches. Two host settings
 * (experimental, writable) switch them: `tools.web_fetch.enabled` (boolean) and `tools.web_search.mode` (`client`, `hosted`, `off`).
 * Reaching a site still asks for network approval by domain under the stricter permission modes (observed), so switching a tool on
 * does not remove the approval. The names of the search modes are Muse's; Antares does not claim more about them than that.
 */
export type SearchMode = "client" | "hosted" | "off";
const MODES: SearchMode[] = ["client", "hosted", "off"];

export interface WebSettings {
  fetchEnabled: boolean | undefined;
  searchMode: SearchMode | undefined;
}

export function mapWebSettings(settings: unknown): WebSettings {
  const values = (settings as { values?: Record<string, unknown> } | null)?.values ?? {};
  const fetch = values["tools.web_fetch.enabled"];
  const mode = values["tools.web_search.mode"];
  return { fetchEnabled: typeof fetch === "boolean" ? fetch : undefined, searchMode: MODES.includes(mode as SearchMode) ? (mode as SearchMode) : undefined };
}

export function describeWeb(s: WebSettings): { label: string; detail: string } {
  const fetchPart = s.fetchEnabled === undefined ? "Reading pages (web_fetch): not reported." : s.fetchEnabled ? "Reading pages (web_fetch): on." : "Reading pages (web_fetch): off.";
  const searchPart = s.searchMode === undefined ? "Searching (web_search): not reported." : `Searching (web_search): ${s.searchMode}.`;
  const note = "Under the stricter permission modes, reaching a site still asks for your approval by domain. A change applies to new chats.";
  const searching = s.searchMode !== undefined && s.searchMode !== "off";
  let label: string;
  if (s.fetchEnabled === undefined && s.searchMode === undefined) label = "Web: not reported";
  else if (s.fetchEnabled !== false && s.fetchEnabled !== undefined && searching) label = "Web: on";
  else if (s.fetchEnabled === false && s.searchMode === "off") label = "Web: off";
  else if (s.fetchEnabled === true && !searching) label = "Web: pages only";
  else if (s.fetchEnabled === false && searching) label = "Web: search only";
  else label = "Web: partly reported";
  return { label, detail: `${fetchPart} ${searchPart} ${note}` };
}

async function withHost<T>(options: ContributorReadOptions, use: (host: MuseHost) => Promise<T>): Promise<T> {
  const host = new MuseHost({ binary: options.binary, args: [...(options.binaryArgs ?? []), "serve", "--disable-shell", "--disable-write"], cwd: options.cwd, env: options.env ?? process.env });
  try {
    host.start();
    await host.request("initialize", { clientInfo: { name: "antares", version: options.clientVersion ?? "0.0.1" }, capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
    host.notify("initialized");
    return await use(host);
  } finally {
    await host.stop(3000);
  }
}

/** Reads the two settings. A short-lived host (settings are experimental); no session, no model call. */
export function readWebSettings(options: ContributorReadOptions): Promise<WebSettings> {
  return withHost(options, async (host) => mapWebSettings(await host.request("settings/read", {}, 20_000)));
}

async function write(options: ContributorReadOptions, keyPath: string, value: boolean | string): Promise<unknown> {
  return withHost(options, async (host) => (await host.request<{ effectiveValue?: unknown }>("settings/writeValue", { keyPath, value }, 20_000)).effectiveValue);
}

/** Turns page reading on or off. Success is claimed only when the host's answer is the value asked for. */
export async function setFetchEnabled(options: ContributorReadOptions, enabled: boolean): Promise<boolean> {
  const effective = await write(options, "tools.web_fetch.enabled", enabled);
  if (effective !== enabled) throw new Error(`Muse answered, but page reading is still ${effective === true ? "on" : effective === false ? "off" : "not as asked"}.`);
  return enabled;
}

export async function setSearchMode(options: ContributorReadOptions, mode: SearchMode): Promise<SearchMode> {
  if (!MODES.includes(mode)) throw new Error("The search mode must be client, hosted or off.");
  const effective = await write(options, "tools.web_search.mode", mode);
  if (effective !== mode) throw new Error(`Muse answered, but search is still ${typeof effective === "string" ? effective : "not as asked"}.`);
  return mode;
}
