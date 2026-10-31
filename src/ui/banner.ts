/** Startup banner, shown at the top of the Antares panel (same idea as the opencode splash). */
const BACKTICK = String.fromCharCode(96);

// String.raw keeps the backslashes of the figlet "small" lettering literal. The line that ends in a
// backslash, and the one that needs a backtick, are assembled from pieces so no template literal
// has to end in "\" or contain a raw backtick.
export const ANTARES_ASCII = [
  String.raw`   _   _  _ _____   _   ___ ___ ___`,
  String.raw`  /_\ | \| |_   _| /_\ | _ \ __/ __|`,
  String.raw` / _ \| .` + BACKTICK + String.raw` | | |  / _ \|   / _|\__ ` + "\\",
  String.raw`/_/ \_\_|\_| |_| /_/ \_\_|_\___|___/`,
].join("\n");

export const ANTARES_TAGLINE = "α Scorpii · an open interface for Muse Code";
