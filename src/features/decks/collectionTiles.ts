import type { GridCard } from "@/features/search/CardGrid";
import { FINISHES, type Finish } from "@/lib/finish";
import type { CollectionRow } from "@/lib/ipc";
import type { CopySource } from "./useCollectionSearch";

/**
 * One printing on the deck panel's collection wall — **every copy of it the reader holds, folded
 * into the one piece of art**.
 *
 * ## Why the fold, when the list it replaced had a row per copy
 *
 * The list's grain was the printing, its finish, its condition *and* the folder it sits in,
 * because which of those rows an Add takes decides whether another deck loses a card. A wall of
 * art cannot draw four facts per tile, and drawing the same illustration three times — a foil, a
 * played nonfoil and a copy in a drawer — reads as a rendering fault rather than as three
 * choices.
 *
 * So the grain moves to the printing and **the choice moves into {@link pickCopy}**, which is
 * where it can be stated once and tested: the desk's copies before a deck's, a real card before a
 * proxy, the oldest entry before the newest. What that costs is the reader picking *which* copy;
 * what it buys is that they no longer have to, because the order is the one the app already
 * applies everywhere else a copy is chosen for them (`chooseFreeCopy`).
 *
 * **The safety property survives the fold, and that is the load-bearing claim of this file.** A
 * tile is added from `add`, and `add` is a desk copy whenever the reader has one — so a printing
 * they hold two of, one loose and one in Mono-Red Aggro, adds the loose one silently and Mono-Red
 * Aggro never notices. Only a printing whose copies are *all* spoken for hands over an
 * `otherDeck` row, and that is the one case the tab still asks about before it presses.
 */
export interface CopyTile extends GridCard {
  /** How many copies the reader holds of this printing, across every finish, grade and folder —
   *  what `OwnedBadge` draws over the art. Rows already in this deck are counted: they are copies
   *  the reader owns, and {@link here} is the separate fact about where they are. */
  copies: number;
  /** Carried for {@link landingCategory}, which files an add by what the card *does* and reads
   *  the type line to do it — the documented floor for a database with no oracle tags. */
  typeLine: string | null;
  /** Which oracle card this is, for the context menu's "View all printings". `null` for an
   *  orphan — a printing that has left `cards` — exactly as the row carries it. */
  oracleId: string | null;
  /**
   * The finish to mark the art with, or `null` where the copies behind this tile disagree.
   *
   * **`null` on a mixed tile rather than a first-row guess.** The mark is a claim about the
   * cardboard in the picture, and a reader holding one foil and one nonfoil owns neither "a foil"
   * nor "a nonfoil" — they own both, and the honest wall for that is an unmarked one. The same
   * reasoning `CollectionTile.finishes` gives for asking rather than assuming when a printing is
   * held in two finishes.
   */
  finish: Finish | null;
  /**
   * The row an Add takes — `null` only when every copy is already in **this** deck, which is the
   * one state the tile refuses in words.
   *
   * The whole row rather than its id, so the press can name the copy it is about to move without
   * looking it back up in a list the move is about to change.
   */
  add: CollectionRow | null;
  /** Where {@link add} sits, so the press knows whether to ask first. `null` with `add`. */
  from: CopySource | null;
  /** How many of {@link copies} this deck is already holding — what turns the Add button's name
   *  into "already in this deck" once the reader has taken the last free one. */
  here: number;
}

/**
 * Which copy of one printing an Add takes.
 *
 * **Three keys, and the first is the only one that is this file's own idea.** A copy on the desk
 * outranks a copy in another deck, because taking the second costs a deck the reader is not
 * looking at a card and taking the first costs nothing at all. The two below it are
 * `chooseFreeCopy`'s, kept verbatim so that a reader who is used to the card-search tab picking a
 * copy for them sees the same copy picked here:
 *
 * 1. **The desk before another deck** — see above.
 * 2. **A real copy before a proxy**, because a proxy is a slot rather than a card.
 * 3. **The oldest entry**, because with nothing else to separate two copies the one recorded
 *    first is the one they have had longest.
 *
 * A row this deck already holds is **not a candidate at any key** and is filtered rather than
 * ranked last: `collection_to_deck` answers `ALREADY_HERE` for it in words, so offering it would
 * be offering a press that cannot land.
 */
/**
 * What a card with no name is called.
 *
 * The last rung of {@link tileName}, and the same words the list this wall replaced used, so a row
 * nothing knows the name of reads the same on both.
 */
export const UNKNOWN_CARD = "Unknown card";

/**
 * What a tile is called — the card's name, else the printing it records, else {@link UNKNOWN_CARD}.
 *
 * **Every field is read defensively, and that is not belt and braces.** `CollectionRow` types
 * `name` as nullable and `setCode`/`collectorNumber` as present, and a type is a claim about the
 * wire rather than a guarantee about the object in hand — `row.setCode.toUpperCase()` threw during
 * render until 2026-08-23, on the tab the panel *opens* on, so one unexpected row was the whole
 * deck editor rather than one tile. The list that shipped that fix is gone; the fix is not.
 *
 * The middle rung is the collection page's own fallback, said the same way: a printing `cards` has
 * forgotten still has the set and the number the entry recorded, and on a wall of art that is the
 * whole of what identifies it.
 */
export function tileName(row: PartialRow): string {
  if (row.name) return row.name;
  const printing = [row.setCode?.toUpperCase(), row.collectorNumber].filter(Boolean).join(" ");
  return printing || UNKNOWN_CARD;
}

/** As much of a row as {@link tileName} reads, with every field optional for its stated reason. */
type PartialRow = Partial<Pick<CollectionRow, "name" | "setCode" | "collectorNumber">>;

/** A quantity that is actually a number, or `0` — {@link tileName}'s defensiveness applied to the
 *  one field the badge does arithmetic on. `×NaN` over a card's art is worse than `×0`, which the
 *  badge draws as nothing at all. */
function held(row: Pick<CollectionRow, "quantity">): number {
  return typeof row.quantity === "number" && Number.isFinite(row.quantity) ? row.quantity : 0;
}

export function pickCopy(
  rows: readonly { row: CollectionRow; source: CopySource }[],
): { row: CollectionRow; source: CopySource } | null {
  const pool = rows.filter((candidate) => candidate.source.kind !== "here");
  // Sorted on a copy, so the caller's list is not reordered under it.
  const ranked = [...pool].sort(
    (a, b) =>
      Number(a.source.kind === "otherDeck") - Number(b.source.kind === "otherDeck") ||
      Number(a.row.proxy) - Number(b.row.proxy) ||
      a.row.id - b.row.id,
  );
  return ranked[0] ?? null;
}

/**
 * Every copy row on screen, folded to one tile per printing — the wall's rows.
 *
 * `sourceOf` is handed in rather than imported because the answer needs the folder census and the
 * open deck's id, both of which are the hook's. Passing the function keeps this module pure, which
 * is what lets the fold and the pick be tested against five-field rows instead of a mounted panel.
 *
 * **Insertion order is the backend's order**, kept: the first row of a printing decides where its
 * tile sits, so the sort the reader picked in the filter row survives the fold. A `Map` is what
 * makes that free — JavaScript's iterates in insertion order — and it is also what makes this one
 * pass rather than the collection page's two.
 */
export function foldCopies(
  rows: readonly CollectionRow[],
  sourceOf: (row: CollectionRow) => CopySource,
): CopyTile[] {
  const grouped = new Map<string, { row: CollectionRow; source: CopySource }[]>();
  for (const row of rows) {
    const held = grouped.get(row.cardId);
    const entry = { row, source: sourceOf(row) };
    if (held) held.push(entry);
    else grouped.set(row.cardId, [entry]);
  }

  const out: CopyTile[] = [];
  for (const [cardId, entries] of grouped) {
    const first = entries[0].row;
    const finishes = new Set(entries.map((e) => e.row.finish));
    const only = finishes.size === 1 ? [...finishes][0] : null;
    const chosen = pickCopy(entries);
    out.push({
      id: cardId,
      name: tileName(first),
      // `?? ""` on the two `GridCard` requires: the interface types them as present and a row is
      // not obliged to honour that (see {@link tileName}), and a `""` caption is a caption that
      // says nothing rather than an `undefined` rendered into the DOM as the word.
      setCode: first.setCode ?? "",
      collectorNumber: first.collectorNumber ?? "",
      rarity: first.rarity ?? null,
      copies: entries.reduce((n, e) => n + held(e.row), 0),
      typeLine: first.typeLine ?? null,
      oracleId: first.oracleId ?? null,
      // Narrowed against `FINISHES` rather than cast: `finish` is TEXT with a CHECK rather than an
      // enum this side knows, so a word this build cannot name marks nothing instead of marking
      // the art with a sheen no stylesheet has.
      finish: (FINISHES as readonly string[]).includes(only as string) ? (only as Finish) : null,
      add: chosen?.row ?? null,
      from: chosen?.source ?? null,
      here: entries.filter((e) => e.source.kind === "here").reduce((n, e) => n + held(e.row), 0),
    });
  }
  return out;
}
