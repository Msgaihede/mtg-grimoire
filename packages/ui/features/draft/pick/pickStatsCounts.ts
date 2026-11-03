import {
  CURVE_BUCKETS,
  curveBucket,
  isCreature,
  OTHER,
  TYPE_BUCKETS,
  typeBucket,
} from "@/features/decks/deckBuckets";
import type { LandSlice } from "@/features/decks/stats/typeBreakdownCounts";
import type { DraftCard } from "@/lib/ipc";
import { MANA_LABEL, MANA_LINE_KEYS, type ManaKey } from "@/lib/mana";
import { isLand } from "./pool";

/**
 * What the pick screen's stats panel counts (issue #1499's follow-up): the **deck's** cards only —
 * the picks on the sideboard are never in it — by the deck editor's own rules (`deckBuckets`), so a
 * card sits in the same bar here as in the editor the draft builds into.
 */
export interface PickStats {
  /** Nonland cards per mana value, buckets 0 … 7 and 8+ (`CURVE_BUCKETS`). */
  curve: number[];
  /** Of each bucket, the creatures — the curve's split. */
  curveCreatures: number[];
  /** The nonland cards' mean mana value, or `null` for a deck of lands or of nothing. */
  average: number | null;
  /** Cards per type, `TYPE_BUCKETS`' order and then `Other`, the empty ones left out. */
  types: { label: string; count: number }[];
  /** The nonland cards by color — each combination a slice of its own, colorless last. */
  colors: LandSlice[];
  /** The nonland cards the curve and the pie count. */
  nonland: number;
}

/** Five colors, then the pairs and on, then colorless; within a size, in WUBRG order. */
function sliceOrder(a: readonly ManaKey[], b: readonly ManaKey[]): number {
  const size = (keys: readonly ManaKey[]) => (keys.length === 0 ? 6 : keys.length);
  if (size(a) !== size(b)) return size(a) - size(b);
  const rank = (keys: readonly ManaKey[]) =>
    keys.map((k) => MANA_LINE_KEYS.indexOf(k as (typeof MANA_LINE_KEYS)[number]));
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return (ra[i] ?? 0) - (rb[i] ?? 0);
  return 0;
}

/** `White`, `White–black`: a combination's name, its first color capitalised. */
function colorName(keys: readonly ManaKey[]): string {
  if (keys.length === 0) return MANA_LABEL.C;
  return keys.map((k, i) => (i === 0 ? MANA_LABEL[k] : MANA_LABEL[k].toLowerCase())).join("–");
}

export function pickStats(cards: readonly DraftCard[]): PickStats {
  const curve = Array.from({ length: CURVE_BUCKETS }, () => 0);
  const curveCreatures = Array.from({ length: CURVE_BUCKETS }, () => 0);
  const types = new Map<string, number>();
  const colors = new Map<string, { types: ManaKey[]; count: number }>();
  let manaValues = 0;
  let nonland = 0;

  for (const card of cards) {
    const type = typeBucket(card.typeLine);
    types.set(type, (types.get(type) ?? 0) + 1);
    if (isLand(card)) continue;
    nonland += 1;
    manaValues += card.cmc;
    const bucket = curveBucket(card.cmc);
    curve[bucket] = (curve[bucket] ?? 0) + 1;
    if (isCreature(card.typeLine)) curveCreatures[bucket] = (curveCreatures[bucket] ?? 0) + 1;
    const keys = MANA_LINE_KEYS.filter((k) => card.colors.includes(k));
    const key = keys.length === 0 ? "none" : keys.join("");
    const slice = colors.get(key);
    if (slice === undefined) colors.set(key, { types: keys, count: 1 });
    else slice.count += 1;
  }

  return {
    curve,
    curveCreatures,
    average: nonland === 0 ? null : manaValues / nonland,
    types: [...TYPE_BUCKETS, OTHER].flatMap((label) => {
      const count = types.get(label) ?? 0;
      return count === 0 ? [] : [{ label, count }];
    }),
    colors: [...colors.entries()]
      .map(([key, slice]) => ({ key, label: colorName(slice.types), ...slice }))
      .sort((a, b) => sliceOrder(a.types, b.types)),
    nonland,
  };
}
