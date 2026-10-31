import { MANA_KEYS, type ManaKey } from "@/lib/mana";
import type { DraftCard, DraftView } from "@/lib/ipc";
import { rarityRank } from "@/lib/rarity";

/**
 * A drafted pool as the pick screen lays it out: one column per mana value (0 … 6+), the lands
 * apart, and a count per colour.
 */

/** The columns, left to right. `lands` is last and holds every land whatever its mana value. */
export const POOL_COLUMNS = ["0", "1", "2", "3", "4", "5", "6+", "lands"] as const;
export type PoolColumn = (typeof POOL_COLUMNS)[number];

/** A land by its front face — a modal double-faced spell with a land back is a spell here. */
export function isLand(card: Pick<DraftCard, "typeLine">): boolean {
  return /\bLand\b/.test(card.typeLine.split(" // ")[0] ?? "");
}

export function columnOf(card: DraftCard): PoolColumn {
  if (isLand(card)) return "lands";
  return card.cmc >= 6 ? "6+" : (String(card.cmc) as PoolColumn);
}

/** The pool by column, each column in pick order. Empty columns are kept, so the curve is drawn
 *  as a curve. */
export function poolColumns(pool: readonly DraftCard[]): Record<PoolColumn, DraftCard[]> {
  const out = Object.fromEntries(POOL_COLUMNS.map((c) => [c, [] as DraftCard[]])) as Record<
    PoolColumn,
    DraftCard[]
  >;
  for (const card of pool) out[columnOf(card)].push(card);
  return out;
}

/** How the pack's cards are laid out: rarity high to low (the default, issue #1432), or as dealt. */
export type PackSort = "rarity" | "dealt";

/** The pack in `by` order. A rarity's cards keep the order they were dealt in, so the wall does
 *  not shuffle between renders. */
export function sortPack(pack: readonly DraftCard[], by: PackSort): DraftCard[] {
  const out = [...pack];
  if (by === "rarity") out.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity));
  return out;
}

/** Cards of each colour — a two-colour card counts for both; a colourless card is `C`. */
export function colorTally(pool: readonly DraftCard[]): Record<ManaKey, number> {
  const out = Object.fromEntries(MANA_KEYS.map((k) => [k, 0])) as Record<ManaKey, number>;
  for (const card of pool) {
    const colors = card.colors.filter((c): c is ManaKey =>
      (MANA_KEYS as readonly string[]).includes(c),
    );
    if (colors.length === 0) out.C += 1;
    for (const c of colors) out[c] += 1;
  }
  return out;
}

/**
 * How far a view is into the draft, as one number that only grows — so a pushed `draft:view`
 * that arrives after a newer one (a guest's pick answered before the event) never moves the
 * screen back. Waiting on the table is a half step past the pick it waits on.
 */
export function progressOf(view: DraftView): number {
  if (view.status === "deckbuilding") return Number.POSITIVE_INFINITY;
  return view.packNumber * 1000 + view.pickNumber * 2 + (view.waiting ? 1 : 0);
}

/** Whether a pushed view should replace the one on screen: the same seat, and no older. */
export function acceptsView(current: DraftView | null, pushed: DraftView): boolean {
  if (current === null) return true;
  if (pushed.seat !== current.seat) return false;
  return progressOf(pushed) >= progressOf(current);
}
