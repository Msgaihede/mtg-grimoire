/**
 * Condition grades, and the strings the rest of the world writes them as.
 *
 * The app stores one of five NA-scale grades and **keeps the original string** beside it,
 * because the normalisation is lossy: EU `GD` and NA `MP` arrive as the same grade, and
 * the user's own file is then the only place the difference still exists.
 *
 * Beside `finish.ts` rather than under `features/collection/`: it is pure vocabulary with
 * no view attached, and its only non-test caller is `lib/ipc.ts`, which types the wire with
 * {@link Condition}.
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
 * From the research doc's synonym table. **Four** entries are the EU scale's, and they are
 * here only because those spellings never come from anywhere else — Cardmarket grades a card
 * `M/NM/EX/GD/LP/PL/PO`, which is one grade longer than the NA scale, so the bottom half
 * does not line up one-for-one:
 *
 * | Cardmarket | here  | why |
 * |------------|-------|-----|
 * | `EX`       | `LP`  | Excellent is the NA scale's Lightly Played |
 * | `GD`       | `MP`  | Good is the NA scale's Moderately Played |
 * | `PL`       | `HP`  | Played sits at NA Heavily Played, not at NA Played |
 * | `PO`       | `DMG` | Poor is the bottom grade; the NA scale's bottom is Damaged |
 *
 * Two traps live in that table and both are deliberate:
 *
 * * A bare **`LP` is not remapped**. It is the NA scale's own grade, and Cardmarket's
 *   LP-means-Played is a property of the *file*, so it belongs to the importer that knows
 *   which file it is reading (Plan 5) rather than to a function that only sees two letters.
 * * **`PL` and `played` part company.** `PL` is Cardmarket's abbreviation and lands on `HP`;
 *   the whole word `Played` is Moxfield's, whose scale runs Mint / Near Mint / Good (Lightly
 *   Played) / Played / Heavily Played / Damaged, so it lands on `MP`. Two spellings of what
 *   looks like one word, from two vendors who mean different cards by it.
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
  pl: "HP",
  damaged: "DMG",
  dmg: "DMG",
  dm: "DMG",
  d: "DMG",
  poor: "DMG",
  po: "DMG",
};

/**
 * One incoming condition string, as a grade plus what it said.
 *
 * `matched: false` is not an error — it is what an import preview shows as a warning row
 * (spec §7: "unknown conditions" are one of the three things a preview flags). The grade
 * defaults to `NM` because that is what an unmarked card is assumed to be, which is also
 * why an unrecognised spelling has to be *reported* rather than quietly accepted: the
 * default is the best grade on the scale, so a miss always errs in the owner's favour.
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
