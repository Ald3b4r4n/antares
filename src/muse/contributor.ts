import { MuseHost } from "./host.ts";

/**
 * Standard / Contributor. In Contributor mode Meta may use the user's content to train future models (in exchange for more
 * usage from the plan); in Standard mode it may not. What a client can know, measured on muse 1.4.14:
 *  - `settings/read` (experimental) reports the SAVED value of `contributor_mode_enabled`, not the one in effect when the
 *    host was started with an override (`--contributor-mode`, or `MUSE_CONTRIBUTOR_MODE` for headless runs);
 *  - with no saved value the key is absent, and the documentation says subscriptions default to Contributor.
 * So the state below is "confirmed" only when a saved value exists and nothing is known to override it.
 */
export interface ContributorRead {
  /** The saved setting; undefined when absent, not a boolean, or unreadable. */
  saved: boolean | undefined;
  /** The signed-in account's label (an e-mail address), when the host says. */
  account?: string;
  /** Why the setting could not be read, when it could not. */
  error?: string;
}

export interface ContributorState {
  mode: "contributor" | "standard" | "unconfirmed";
  confirmed: boolean;
  /** One short line for the control. */
  label: string;
  /** What the state rests on and what it does not prove. */
  detail: string;
  /** What each mode means for the user's data. */
  privacy: string;
  account?: string;
}

const PRIVACY =
  "Contributor mode lets Meta use your content to train future Meta models, in exchange for more usage from your plan. Standard mode does not. The Terms of Service have the details.";

export function mapContributor(settings: unknown, account?: unknown): ContributorRead {
  const values = (settings as { values?: Record<string, unknown> } | null)?.values;
  const raw = values && typeof values === "object" ? values.contributor_mode_enabled : undefined;
  const label = (account as { label?: unknown } | null | undefined)?.label;
  return { saved: typeof raw === "boolean" ? raw : undefined, account: typeof label === "string" && label !== "" ? label : undefined };
}

export function describeContributor(read: ContributorRead, env: NodeJS.ProcessEnv): ContributorState {
  const account = read.account;
  const override = env.MUSE_CONTRIBUTOR_MODE;
  if (read.error) {
    return { mode: "unconfirmed", confirmed: false, label: "Mode: not confirmed", detail: `Muse's saved mode could not be read (${read.error}).`, privacy: PRIVACY, account };
  }
  if (override !== undefined && override !== "") {
    return {
      mode: "unconfirmed",
      confirmed: false,
      label: "Mode: not confirmed",
      detail: `MUSE_CONTRIBUTOR_MODE=${override} is set in this editor's environment and may override the saved setting (${read.saved === undefined ? "none saved" : read.saved ? "Contributor" : "Standard"}). Muse does not report the mode actually in effect.`,
      privacy: PRIVACY,
      account,
    };
  }
  if (read.saved === undefined) {
    return {
      mode: "unconfirmed",
      confirmed: false,
      label: "Mode: not confirmed",
      detail: "No mode is saved in Muse's settings, so Muse's default applies, and the documentation says subscriptions default to Contributor.",
      privacy: PRIVACY,
      account,
    };
  }
  return {
    mode: read.saved ? "contributor" : "standard",
    confirmed: true,
    label: read.saved ? "Contributor" : "Standard",
    detail: `${read.saved ? "Contributor" : "Standard"} is the mode saved in Muse's settings, and Antares starts Muse without overriding it. Muse does not report the mode in effect, so this is the saved setting, not a live reading.`,
    privacy: PRIVACY,
    account,
  };
}

/**
 * Switches the saved mode to Standard (`settings/writeValue`, experimental, a key marked hidden). Checked: the host's
 * answer must be Standard, or this throws. Only this direction is offered: turning Contributor on is done in Muse itself,
 * which records the user's acknowledgement of the data-use disclosure (a settings key a client cannot write).
 * Muse's documentation says a change applies from the next request; that has not been verified for an open session.
 */
export async function switchToStandard(options: ContributorReadOptions): Promise<{ saved: boolean }> {
  const host = new MuseHost({ binary: options.binary, args: [...(options.binaryArgs ?? []), "serve", "--disable-shell", "--disable-write"], cwd: options.cwd, env: options.env ?? process.env });
  try {
    host.start();
    await host.request("initialize", {
      clientInfo: { name: "antares", version: options.clientVersion ?? "0.0.1" },
      capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false },
    });
    host.notify("initialized");
    const result = await host.request<{ effectiveValue?: unknown }>("settings/writeValue", { keyPath: "contributor_mode_enabled", value: false }, 20_000);
    if (result.effectiveValue !== false) throw new Error("Muse answered, but the saved mode is still not Standard.");
    return { saved: false };
  } finally {
    await host.stop(3000);
  }
}

export interface ContributorReadOptions {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: arguments placed before `serve`. */
  binaryArgs?: string[];
  clientVersion?: string;
}

/**
 * Reads the saved mode and the account label. `settings/read` and `account/read` are experimental, so, like the usage
 * refresh and the connector list, this uses a short-lived host of its own and leaves the chat host on the stable
 * surface. No session, no model call, nothing written.
 */
export async function readContributor(options: ContributorReadOptions): Promise<ContributorRead> {
  const host = new MuseHost({ binary: options.binary, args: [...(options.binaryArgs ?? []), "serve", "--disable-shell", "--disable-write"], cwd: options.cwd, env: options.env ?? process.env });
  try {
    host.start();
    await host.request("initialize", {
      clientInfo: { name: "antares", version: options.clientVersion ?? "0.0.1" },
      capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false },
    });
    host.notify("initialized");
    let settings: unknown;
    try {
      settings = await host.request("settings/read", {}, 20_000);
    } catch (error) {
      return { saved: undefined, error: error instanceof Error ? error.message : String(error) };
    }
    const account = await host.request("account/read", {}, 20_000).catch(() => undefined);
    return mapContributor(settings, account);
  } finally {
    await host.stop(3000);
  }
}
