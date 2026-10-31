/** Startup banner, shown at the top of the Antares panel (same idea as the opencode splash). */

// A 5-row block font. Solid blocks stay legible at small sizes and in any monospace font, unlike
// slash-and-underscore lettering, which blurred in the real editor.
const GLYPHS: Record<string, string[]> = {
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  S: [" ████", "█    ", " ███ ", "    █", "████ "],
};

export function blockText(word: string): string {
  const rows: string[] = ["", "", "", "", ""];
  for (const ch of word.toUpperCase()) {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    glyph.forEach((line, i) => {
      rows[i] += `${line} `;
    });
  }
  return rows.map((r) => r.trimEnd()).join("\n");
}

export const ANTARES_ASCII = blockText("ANTARES");

export const ANTARES_TAGLINE = "α Scorpii · an open interface for Muse Code";
