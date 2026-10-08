/**
 * The arithmetic under Card distribution's lower readouts (2026-09-28): the `Creatures vs
 * noncreatures` band and the two type-breakdown panels, **Creature** and **Land**.
 *
 * Pure and separate from the components for the reason `deckBuckets.ts` is: every rule here is a
 * reading of a type line, and a type line is the one input this band has learned to distrust —
 * `//` between faces, an em dash or a hyphen before the subtypes, a land that heads a spell bar.
 * Those are cases a test states in one line and a component test states in forty.
 *
 * **Three counts, and each is pinned to a number some other readout already prints**, because a
 * band that says 14 creatures in one card and 15 in the next is a band nobody can read:
 *
 * - {@link creatureSplit} is the **curve's** count, taken straight off `DeckStatsSummary` rather
 *   than recounted, so the band and the Mana curve's `Creatures` legend are one number.
 * - {@link typeBreakdown}'s `lands` is `isLand` over the **active** copies — `deckStats`'
 *   `lands`, the ledger's first Lands term — and never the `by Types` Land bar, which files
 *   Urza's Saga under Enchantment on purpose (`isLand`'s doc names that disagreement).
 * - its `creatures` is `isCreature` over the same active copies **less the lands**, which is the
 *   curve's creature population in everything but the orphaned row with no mana value anywhere.
 */
import type { DeckCard } from "@/lib/ipc";
import type { ManaKey } from "@/lib/mana";
import type { DeckStatsSummary } from "../DeckStats";
import { activeCards, front, isCreature, isLand, isMdfcLand } from "../deckBuckets";

/** One side of the `Creatures vs noncreatures` band. */
export interface CreatureSplit {
  creatures: number;
  noncreatures: number;
  /** `creatures + noncreatures`. `0` is the band's own "draw nothing". */
  total: number;
}

/**
 * The band's two counts, **read off the curve** rather than recounted from the rows.
 *
 * `sum(curve) + (variableCost ?? 0)` is every nonland with a mana value, wherever `Split X` put
 * it, and the creature half is the same sum over the creature arrays — the fields B's contract
 * added so the split and the curve are one pass (`DeckStatsSummary.curveCreatures`). Taking the
 * number from there is what makes it impossible for this band and the Mana curve's legend to
 * disagree; a second count over the rows would agree today and drift the first time either rule
 * moved.
 */
export function creatureSplit(
  stats: Pick<
    DeckStatsSummary,
    "curve" | "curveCreatures" | "variableCost" | "variableCostCreatures"
  >,
): CreatureSplit {
  const sum = (values: readonly number[]) => values.reduce((n, v) => n + v, 0);
  const total = sum(stats.curve) + (stats.variableCost ?? 0);
  const creatures = sum(stats.curveCreatures) + (stats.variableCostCreatures ?? 0);
  return { creatures, noncreatures: total - creatures, total };
}

/** One row of the Creature panel — a subtype and the copies that carry it. */
export interface SubtypeRow {
  name: string;
  count: number;
}

/**
 * One slice of the Land pie: the lands carrying **exactly** this set of basic land types.
 *
 * `types` is empty for the `No basic land type` slice, and otherwise in WUBRG order — which is
 * also the order the words are joined in for `label`, so a Steam Vents is `Island Mountain`
 * whichever way round a type line happened to print them.
 */
export interface LandSlice {
  /** Stable and unique — the joined keys, or `none`. A React key and an SVG pattern id suffix. */
  key: string;
  label: string;
  types: readonly ManaKey[];
  count: number;
}

export interface TypeBreakdown {
  /** Creature copies — the Creature panel's heading. */
  creatures: number;
  /** One row per subtype, count descending then name. A copy with two subtypes is in two rows,
   *  so these do **not** sum to {@link creatures}, and the panel says so. */
  creatureTypes: readonly SubtypeRow[];
  /** Land copies — the Land panel's heading, and exactly the sum of {@link landSlices}. */
  lands: number;
  /** A partition of {@link lands}: every land copy is in exactly one slice. */
  landSlices: readonly LandSlice[];
  /**
   * Modal DFCs with a land back — `isMdfcLand`, `deckStats`' `mdfcLands`. **Not in {@link lands}
   * and not in any slice**, for that field's reason: they are cast from the front, and a land
   * count must never read longer than the manabase plays. The panel prints them as a second
   * term, the ledger's `38+2 MDFC` grammar.
   */
  mdfcLands: number;
}

/** The five basic land types and the mana each is the type of, in WUBRG order. */
const BASIC_TYPES: readonly (readonly [string, ManaKey])[] = [
  ["Plains", "W"],
  ["Island", "U"],
  ["Swamp", "B"],
  ["Mountain", "R"],
  ["Forest", "G"],
];

/** The label for a land with none of the five. */
export const NO_BASIC_TYPE = "No basic land type";

/**
 * The one creature type printed as two words. Splitting subtypes on whitespace is right for every
 * other creature type in the game — `Assembly-Worker` is one word with a hyphen in it, which is
 * why {@link subtypes} takes a hyphen as the separator only with spaces round it — and wrong for
 * this one, which
 * would otherwise read as a `Time` and a `Lord`.
 */
const MULTI_WORD_TYPES: readonly string[] = ["Time Lord"];

/**
 * The subtypes of one face — the words after its dash, `[]` for a face with no dash.
 *
 * **Scryfall prints an em dash** (`Creature — Human Wizard`); a hand-typed line, an old import
 * and more than one fixture in this repo spell it ` - `. Both are accepted, and a hyphen only
 * with a space either side, because a bare hyphen is part of a word (`Assembly-Worker`).
 */
export function subtypes(face: string): string[] {
  const match = /\s*(?:—|\s-\s)\s*(.*)$/.exec(face);
  if (!match) return [];
  let rest = match[1].trim();
  const found: string[] = [];
  for (const name of MULTI_WORD_TYPES) {
    if (new RegExp(`(^|\\s)${name}(\\s|$)`).test(rest)) {
      found.push(name);
      rest = rest.replace(name, " ");
    }
  }
  return [...found, ...rest.split(/\s+/).filter(Boolean)];
}

/**
 * The Creature and Land panels' figures, over the **active** copies — the same rows the
 * distribution bars above them are drawn over (`activeCards`), so a sideboard is counted and a
 * pile switched off is not.
 *
 * - **A creature is `isCreature` and not `isLand`.** `isCreature` is `typeBucket`'s own answer
 *   (the front face's first printed type), so an Artifact Creature is one and a modal DFC with a
 *   creature on its back is not. Lands are taken out because Dryad Arbor is a `Land Creature —
 *   Forest Dryad`: its subtypes are half land type, it is already a slice of the pie, and the
 *   band's creature split — which is over the curve, and the curve is over nonlands — does not
 *   count it either. Its subtypes are read off the **front** face.
 * - **A land is `isLand`** — the front face — and its basic types are read off that face, which
 *   is its land face by definition. A Pathway (`Land // Land`) is one land with its front's type.
 */
export function typeBreakdown(cards: readonly DeckCard[]): TypeBreakdown {
  let creatures = 0;
  let lands = 0;
  let mdfcLands = 0;
  const tally = new Map<string, number>();
  const slices = new Map<string, LandSlice>();

  for (const card of activeCards(cards)) {
    const face = front(card.typeLine);
    if (isLand(card.typeLine)) {
      lands += card.quantity;
      const words = new Set(subtypes(face));
      const types = BASIC_TYPES.filter(([word]) => words.has(word));
      const key = types.length === 0 ? "none" : types.map(([, mana]) => mana).join("");
      const slice = slices.get(key) ?? {
        key,
        label: types.length === 0 ? NO_BASIC_TYPE : types.map(([word]) => word).join(" "),
        types: types.map(([, mana]) => mana),
        count: 0,
      };
      slices.set(key, { ...slice, count: slice.count + card.quantity });
      continue;
    }
    if (isMdfcLand(card)) mdfcLands += card.quantity;
    if (!isCreature(card.typeLine)) continue;
    creatures += card.quantity;
    // A set, so a line that somehow printed one type twice still counts the copy once under it.
    for (const name of new Set(subtypes(face))) {
      tally.set(name, (tally.get(name) ?? 0) + card.quantity);
    }
  }

  const creatureTypes = [...tally]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en"));

  const landSlices = [...slices.values()].sort(
    (a, b) => b.count - a.count || sliceRank(a) - sliceRank(b),
  );

  return { creatures, creatureTypes, lands, landSlices, mdfcLands };
}

/**
 * The tie-break between two slices of one size: fewer types first, then WUBRG, and the
 * no-basic-type slice after every typed one — a fixed order, so two equal slices do not swap
 * places between renders or between machines.
 */
function sliceRank(slice: LandSlice): number {
  if (slice.types.length === 0) return Number.MAX_SAFE_INTEGER;
  const order = BASIC_TYPES.map(([, mana]) => mana);
  return slice.types.reduce(
    (rank, mana) => rank * 8 + order.indexOf(mana) + 1,
    slice.types.length,
  );
}
