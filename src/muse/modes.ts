/**
 * The permission modes shown in the composer, mapped onto what Muse really has: four permission profiles
 * (and four approval modes that turned out not to be a usable "stricter" switch). Nothing here invents a
 * guarantee Muse does not give:
 *
 * - Auto       = `:auto-review`  (an AI reviewer decides eligible actions first; the host's own description).
 * - Manual     = not available. Observed: under `:ask-me` with the host's `promptUnmatched` approval mode, a
 *                workspace file write still ran with no approval. Muse has no profile that asks before every edit.
 * - Accept edits = `:ask-me`     (edits the workspace freely; asks for protected writes, new network targets and
 *                other restricted actions). Observed: shell and network asked, workspace writes did not.
 * - Plan       = `:read-only`    (reads only; Antares also starts the host with shell and write tools disabled).
 * - Bypass permissions = `:unrestricted` (no sandbox, no approval prompts; the host says so itself).
 */
export type ModeId = "auto" | "manual" | "acceptEdits" | "plan" | "bypass";

export interface ModeInfo {
  id: ModeId;
  label: string;
  /** One line for the menu. */
  short: string;
  /** The Muse permission profile this mode starts the chat with; undefined when the mode cannot be offered. */
  profileId?: string;
  /** The key (1 to 5) that picks it in the open menu. */
  shortcut: number;
  note: string;
  /** Why the mode cannot be selected, when it cannot. */
  unavailable?: string;
  /** Whether Shift+Tab visits it. Bypass is never visited: it has to be chosen on purpose. */
  cycle: boolean;
  /** Needs a confirmation that says what it grants (everything above Plan). */
  confirm: boolean;
}

export const MODES: readonly ModeInfo[] = [
  {
    id: "auto",
    label: "Auto",
    short: "An AI reviewer decides first",
    profileId: ":auto-review",
    shortcut: 1,
    note: "Same access as Accept edits, and an AI reviewer decides eligible actions first, escalating to you (the host's description). Not yet exercised with a real turn.",
    cycle: true,
    confirm: true,
  },
  {
    id: "manual",
    label: "Manual",
    short: "Not available in Muse",
    shortcut: 2,
    note: "Ask before every action.",
    unavailable: "Muse has no profile that asks before every edit. Observed: with :ask-me and the host's strictest prompting mode, a workspace file write still ran without a prompt. Use Plan to prevent changes, or Accept edits, which asks for shell, network and other restricted actions.",
    cycle: false,
    confirm: false,
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    short: "Edits freely, asks for the rest",
    profileId: ":ask-me",
    shortcut: 3,
    note: "Edits the workspace and temporary files without asking; asks for protected writes, new network targets and other restricted actions (the host's description). Observed: shell and network asked, workspace writes did not.",
    cycle: true,
    confirm: true,
  },
  {
    id: "plan",
    label: "Plan",
    short: "Read only",
    profileId: ":read-only",
    shortcut: 4,
    note: "Reads only: Muse cannot change anything, and Antares also disables shell and write tools at the host. Ask for a plan (try /plan), then switch to Accept edits to carry it out.",
    cycle: true,
    confirm: false,
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    short: "No sandbox, no prompts",
    profileId: ":unrestricted",
    shortcut: 5,
    note: "No filesystem sandbox and no approval prompts; commands have direct network access (the host's description). The agent acts with your user's permissions.",
    cycle: false,
    confirm: true,
  },
];

export const DEFAULT_MODE: ModeId = "plan";

export function modeById(id: unknown): ModeInfo | undefined {
  return MODES.find((m) => m.id === id);
}

/** The mode whose profile this is (a profile outside the four, such as a managed one, has none). */
export function modeOfProfile(profileId: string | undefined): ModeInfo | undefined {
  return profileId ? MODES.find((m) => m.profileId === profileId) : undefined;
}

/** Shift+Tab: the next mode that can be selected and is part of the cycle; from Bypass it steps down to Plan. */
export function cycleMode(current: ModeId): ModeId {
  const ring = MODES.filter((m) => m.cycle && m.profileId);
  const at = ring.findIndex((m) => m.id === current);
  return (at < 0 ? modeById("plan")! : ring[(at + 1) % ring.length]!).id;
}

/** What the page needs to draw the selector. */
export function modeRows(): { id: ModeId; label: string; short: string; shortcut: number; note: string; profileId?: string; unavailable?: string; confirm: boolean }[] {
  return MODES.map(({ id, label, short, shortcut, note, profileId, unavailable, confirm }) => ({ id, label, short, shortcut, note, profileId, unavailable, confirm }));
}
