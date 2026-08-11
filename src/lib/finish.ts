/**
 * Scryfall's finish enum, and what a finish is worth.
 *
 * A module of its own because three views now need it: the card pane prices every finish a
 * printing exists in, the quick-add popup offers them as a choice, and the collection
 * stores one per row. It is an enum and never a boolean — `etched` is a third thing, and
 * flattening it into `foil: true` is the single most common way an importer loses data.
 */
export const FINISHES = ["nonfoil", "foil", "etched"] as const;
export type Finish = (typeof FINISHES)[number];

export const FINISH_LABEL: Record<Finish, string> = {
  nonfoil: "Nonfoil",
  foil: "Foil",
  etched: "Etched",
};

// How a finish is marked where there is no room for a word is now a *component*,
// `src/components/FinishMark.tsx`, and not a table of letters: `F` and `E` needed an `<abbr>`
// and a tooltip to mean anything, and the glyphs say foil and etched at a glance. The rule
// the table encoded survives it — nonfoil draws nothing, because it is the finish a price is
// assumed to be.

/** The `prices` key each finish is worth. `eur_etched` does not exist in the data. */
const PRICE_KEY: Record<Finish, string> = {
  nonfoil: "usd",
  foil: "usd_foil",
  etched: "usd_etched",
};

export function isFinish(value: string): value is Finish {
  return (FINISHES as readonly string[]).includes(value);
}

/**
 * The finish as a word, for the columns that store whatever was written into them.
 *
 * `collection_entries.finish` and `wishlist_entries.preferred_finish` are TEXT with a
 * `CHECK`, not an enum the type system knows about, so a row can arrive spelling something
 * this app has never heard of. It is printed as it was stored rather than dropped: an
 * unrecognised value is still what the reader's own data says.
 */
export function finishLabel(raw: string): string {
  return isFinish(raw) ? FINISH_LABEL[raw] : raw;
}

/**
 * The finish a printing leaves no choice about, or `null`.
 *
 * What a foil marking on card art is drawn from. 12 366 paper printings exist **only** in foil
 * and 892 only in etched, and nothing in the app said so — a foil-only printing looked exactly
 * like every other, because Scryfall's art has no foil in it.
 *
 * A printing sold in both is deliberately **not** marked. The mark states what the object *is*,
 * and 53 224 of the corpus's 107 337 paper printings have a foil version — a sheen on 61 % of
 * every wall would be decoration rather than information. Which finish a reader *owns* is a
 * different question, answered by a collection entry's own `finish`.
 */
export function soleFinish(json: string | null): Finish | null {
  const finishes = parseFinishes(json);
  if (finishes.length !== 1) return null;
  return finishes[0] === "nonfoil" ? null : finishes[0];
}

/** The finishes a printing exists in. Unknown values are dropped, not guessed at. */
export function parseFinishes(json: string | null): Finish[] {
  const parsed = safeParse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((f): f is Finish => typeof f === "string" && isFinish(f));
}

/**
 * What one finish of a printing costs in USD, or `null`.
 *
 * A lookup by finish, with **no fallback of any kind**. `price_usd` — the derived column —
 * is a nonfoil→foil→etched chain built for sorting, and using it here would price a plain
 * copy at foil rates. Values arrive as decimal strings because money is not a float on the
 * wire; `Number` is the last possible moment to make one.
 */
export function finishPrice(pricesJson: string | null, finish: Finish): number | null {
  const prices = safeParse(pricesJson);
  if (typeof prices !== "object" || prices === null) return null;
  const raw = (prices as Record<string, unknown>)[PRICE_KEY[finish]];
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
