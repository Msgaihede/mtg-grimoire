/**
 * Condition grades, and the strings the rest of the world writes them as.
 *
 * The app stores one of five NA-scale grades and **keeps the original string** beside it,
 * because the normalisation is lossy: EU `GD` and NA `MP` arrive as the same grade, and
 * the user's own file is then the only place the difference still exists.
 */
export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Sentence case, as every other label in the app is. */
export const CONDITION_LABEL: Record<Condition, string> = {
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
};

/**
 * Every spelling this app recognises, lower-cased.
 *
 * From the research doc's synonym table. Two entries are the EU scale's, and they are here
 * only because those spellings never come from anywhere else: `EX` (≈ NA Lightly Played)
 * and `GD` (≈ NA Moderately Played). A bare **`LP` is deliberately not remapped** — it is
 * the NA scale's own grade, and Cardmarket's LP-means-Played is a property of the *file*,
 * so it belongs to the importer that knows which file it is reading (Plan 5).
 */
const SYNONYMS: Record<string, Condition> = {
  mint: "NM",
  m: "NM",
  mt: "NM",
  "near mint": "NM",
  nm: "NM",
  "nm-mint": "NM",
  sp: "LP",
  "slightly played": "LP",
  excellent: "LP",
  ex: "LP",
  "lightly played": "LP",
  lp: "LP",
  "good (lightly played)": "LP",
  "moderately played": "MP",
  mp: "MP",
  played: "MP",
  good: "MP",
  gd: "MP",
  "heavily played": "HP",
  hp: "HP",
  poor: "HP",
  po: "HP",
  damaged: "DMG",
  dmg: "DMG",
  dm: "DMG",
  d: "DMG",
};

/**
 * One incoming condition string, as a grade plus what it said.
 *
 * `matched: false` is not an error — it is what an import preview shows as a warning row
 * (spec §7: "unknown conditions" are one of the three things a preview flags). The grade
 * defaults to `NM` because that is what an unmarked card is assumed to be.
 */
export function normalizeCondition(raw: string | null | undefined): {
  condition: Condition;
  original: string | null;
  matched: boolean;
} {
  const original = raw?.trim() ?? null;
  if (!original) return { condition: "NM", original: null, matched: true };
  const found = SYNONYMS[original.toLowerCase()];
  return { condition: found ?? "NM", original, matched: found !== undefined };
}
