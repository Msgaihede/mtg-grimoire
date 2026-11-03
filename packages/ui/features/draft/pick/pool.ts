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

/**
 * The sideboard's columns beside the deck (issue #1499): the curve folded into four, so the
 * sideboard's columns can be as wide as the deck's beside it — `0–2`, `3–4`, `5+`, then the lands.
 */
export const SIDEBOARD_COLUMNS = ["0-2", "3-4", "5+", "lands"] as const;
export type SideboardColumn = (typeof SIDEBOARD_COLUMNS)[number];

function sideboardColumnOf(card: DraftCard): SideboardColumn {
  if (isLand(card)) return "lands";
  return card.cmc <= 2 ? "0-2" : card.cmc <= 4 ? "3-4" : "5+";
}

/** One column of a shelf, headed in symbols: its cards, in pick order. */
export interface ShelfColumn {
  key: string;
  /**
   * The heading as mana symbols for `ManaText` — `{1}`, `{6}+`, `{0}–{2}` — or `null` for the
   * lands, whose heading is the land symbol.
   */
  symbols: string | null;
  /** What the heading says to a screen reader: `Mana value 1`, `Mana value 0 to 2`, `Lands`. */
  spoken: string;
  cards: DraftCard[];
}

/** `6+` as `{6}+`, `0-2` as `{0}–{2}`: each number its generic mana symbol. */
function symbolsOf(column: string): string {
  return column.replace("-", "–").replace(/\d+/g, (n) => `{${n}}`);
}

function spokenOf(column: string): string {
  if (column === "lands") return "Lands";
  if (column.endsWith("+")) return `Mana value ${column.slice(0, -1)} or more`;
  return `Mana value ${column.replace("-", " to ")}`;
}

/**
 * A shelf's columns: `curve`, the deck's eight (mana value 0 … 6+, then the lands), or `grouped`,
 * the sideboard's four. Empty columns are kept, so the curve is drawn as a curve.
 */
export function shelfColumns(
  pool: readonly DraftCard[],
  shape: "curve" | "grouped",
): ShelfColumn[] {
  const keys: readonly string[] = shape === "curve" ? POOL_COLUMNS : SIDEBOARD_COLUMNS;
  const of = shape === "curve" ? columnOf : sideboardColumnOf;
  const byKey = new Map(keys.map((key) => [key, [] as DraftCard[]]));
  for (const card of pool) byKey.get(of(card))?.push(card);
  return keys.map((key) => ({
    key,
    symbols: key === "lands" ? null : symbolsOf(key),
    spoken: spokenOf(key),
    cards: byKey.get(key) ?? [],
  }));
}

/** One line of the side tray: a card name and how many copies of it the pool holds. */
export interface PoolRow {
  name: string;
  /** The printing first picked under this name — what the row's preview draws. */
  cardId: string;
  count: number;
  colors: readonly string[];
  /** The printed cost, drawn before the name (issue #1498) — `""` for a land. */
  manaCost: string;
}

/**
 * The pool as the side tray lists it (issue #1474): the same columns as the curve, in the same
 * order, each a list of names with a count — so two copies of a common are one line, as on a
 * decklist — sorted by name within a column, since a list is read by name and the curve already
 * keeps pick order. Columns holding nothing are left out: a list has no curve to draw.
 */
export function poolRows(pool: readonly DraftCard[]): {
  column: PoolColumn;
  /** The column's heading as mana symbols, or `null` for the lands — `ShelfColumn`'s. */
  symbols: string | null;
  spoken: string;
  count: number;
  rows: PoolRow[];
}[] {
  const columns = poolColumns(pool);
  return POOL_COLUMNS.flatMap((column) => {
    const cards = columns[column];
    if (cards.length === 0) return [];
    const byName = new Map<string, PoolRow>();
    for (const card of cards) {
      const row = byName.get(card.name);
      if (row === undefined) {
        byName.set(card.name, {
          name: card.name,
          cardId: card.cardId,
          count: 1,
          colors: card.colors,
          manaCost: card.manaCost,
        });
      } else row.count += 1;
    }
    const rows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [
      {
        column,
        symbols: column === "lands" ? null : symbolsOf(column),
        spoken: spokenOf(column),
        count: cards.length,
        rows,
      },
    ];
  });
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
