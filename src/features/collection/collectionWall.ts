/**
 * The collection's wall of tiles as values — the pure half of `CollectionPage`'s wall, split out
 * so the light app's phone face draws the cabinet from the same rules rather than a copy of them.
 *
 * **What is here is what decides what a tile _is_**: which rows fold into one tile (the card, the
 * finish and the folder, never the grade or the language), what the tile carries, how the tiles
 * fall onto the shelves, and how a folder's figures add up its sub-folders'. `CollectionPage` reads
 * every one of them where it used to define them, and nothing about the desktop's wall moved.
 *
 * No React, no store, no IPC call — `collectionWall.test.ts` states each rule as a row.
 */
import type { CollectionFolderTotals } from "./CollectionFolderCard";
import type { GridCard } from "@/features/search/CardGrid";
import { FINISHES, isFinish, type Finish } from "@/lib/finish";
import type { FolderNode } from "@/lib/folderTree";
import type { CollectionFolder, CollectionRow } from "@/lib/ipc";
import { UNFILED_SHELF, type Shelf } from "@/lib/shelves";
import { tileKeyOf } from "@/lib/tileKey";

/**
 * A folder the summary has no row for.
 *
 * **Not a defensive default — the ordinary answer for an empty folder.**
 * `collection_folder_summary` is a `GROUP BY` over `collection_entries`, so a folder holding
 * nothing emits no row at all, and a card fed a raw `Map.get` would render `undefined` figures
 * over exactly the drawer whose whole job on this screen is to be empty. `0 cards` is the honest
 * face of an empty drawer, and an empty drawer is where the next card goes.
 *
 * **It is the answer for a folder the summary skipped, and never for a summary that has not
 * answered yet.** The two are one `Map.get` miss apart and mean opposite things — see the
 * `summaryQuery.isPending` branch at `CollectionPage`'s wall, which is what keeps them apart.
 *
 * `value` is `null` rather than `0` for `formatPrice`'s reason and the backend's own: `$0.00` is a
 * price nobody quoted.
 */
export const NO_CARDS: CollectionFolderTotals = { cards: 0, value: null };

/**
 * Every folder's numbers **with its sub-folders' added in**, indexed by folder id.
 *
 * `collection_folder_summary` answers *direct* counts — this folder's own copies, never the ones
 * nested under it — and says so at its own type, because SQL that walked the tree would be a
 * second implementation of the arithmetic `buildFolderTree` already does for `FolderNode.count`.
 * This is that arithmetic over the two fields: a heading handed a raw lookup would draw
 * `0 cards` over a drawer holding twelve in two sub-folders, and the reader would only catch it by
 * opening the drawer.
 *
 * **A `null` value stays `null` all the way up, and only until something under it is priced.** The
 * backend answers `None` for a folder the marketplace could price nothing in, and a sub-tree in
 * which *nothing* is priced has to say the same thing rather than `$0.00` — but a drawer holding
 * one priced card and one unpriced one is worth what the priced one is worth. So a child's `null`
 * contributes nothing and a child's number lifts the parent out of `null`, which is exactly how
 * `sum()` treats a `NULL` one statement lower down.
 *
 * The whole tree in one pass rather than a sum per card, because a node's total is its children's
 * totals and a per-card recursion would recompute every level of the cabinet once per level.
 */
export function subtotalsOf(
  nodes: readonly FolderNode<CollectionFolder>[],
  direct: ReadonlyMap<number, CollectionFolderTotals>,
): ReadonlyMap<number, CollectionFolderTotals> {
  const out = new Map<number, CollectionFolderTotals>();
  const visit = (node: FolderNode<CollectionFolder>): CollectionFolderTotals => {
    const own = direct.get(node.folder.id) ?? NO_CARDS;
    let cards = own.cards;
    let value = own.value;
    for (const child of node.children) {
      const under = visit(child);
      cards += under.cards;
      if (under.value !== null) value = (value ?? 0) + under.value;
    }
    const total = { cards, value };
    out.set(node.folder.id, total);
    return total;
  };
  for (const node of nodes) visit(node);
  return out;
}

/**
 * A heading's **unfiltered** total — the `M` of `N of M cards` a filtered heading reads (spec §3.2):
 * the shelf's subtree from `collection_folder_summary`, summed up the tree by {@link subtotalsOf}.
 *
 * `null` for Not sorted, which nothing counts unfiltered, and while the summary has not answered
 * (`summary` is `null` then) — a miss before the summary answers is not zero, and a filtered
 * heading then states its matches alone.
 */
export function shelfTotal(
  shelf: Pick<Shelf, "id" | "kind">,
  subtotals: ReadonlyMap<number, CollectionFolderTotals>,
  summary: ReadonlyMap<number, CollectionFolderTotals> | null,
): number | null {
  if (shelf.kind === "unfiled" || summary === null) return null;
  return (subtotals.get(shelf.id) ?? summary.get(shelf.id) ?? NO_CARDS).cards;
}

/** One tile of the wall: a printing **in one finish**, and how many copies of it the collection
 *  holds. */
export interface CollectionTile extends GridCard {
  /**
   * This tile's identity — {@link tileKeyOf} over the card, the finish **and the folder**, which is
   * **not** the card's id.
   *
   * A foil and a played nonfoil of one printing are two tiles carrying one `id`, and since shelves
   * (decision 11) so are the same finish filed in two folders: each shelf draws its own tile with
   * its own count, so the wall's arrow walk and picked set key on this instead. See `CardGrid`'s
   * `GridCard.key`.
   */
  key: string;
  /**
   * What the ring compares with the open card — the card and the finish, **no folder** (spec
   * §5.6). The reader opened a printing, not a filing, so every shelf it sits on says so.
   */
  ringKey: string;
  /** How many copies of this printing **in this finish** the collection holds, across every
   *  grade and language **in this tile's folder** — what `OwnedBadge` draws over the art. */
  copies: number;
  /**
   * The finish to mark the art with — the tile's own, since the finish is part of what makes two
   * tiles two.
   *
   * **`null` is a word this build cannot name and nothing else.** `collection_entries.finish` is
   * TEXT with a CHECK rather than an enum this side knows, so a row can arrive spelling something
   * `FINISHES` has never heard of; that marks the art with nothing rather than with a sheen no
   * stylesheet has. It is no longer "the copies behind this tile disagree" — grouping on the
   * finish is what removed that question, and every tile is one finish now.
   */
  finish: Finish | null;
  /**
   * What one copy of this printing, in **this** finish, costs at the marketplace the query named.
   *
   * Taken off the group's first row rather than reduced across them: every row in a group now
   * names the same printing *and* the same finish, so they all carry the same figure and picking
   * the first is not a choice between two answers. `null` is unpriced there, and it is never
   * filled in from another marketplace or another finish.
   */
  unitPrice: number | null;
  /**
   * The set's **name**, for the chin's tooltip — `PF26` is not a word anybody knows. Carried for the
   * light app's phone wall, whose chin is `CardChin`; the desktop's caption draws the code alone.
   * `null` where the entries behind this tile are orphans.
   */
  setName: string | null;
  /** Carried for the right-click menu alone — nothing on the wall draws it. A menu add is
   *  filed by what the card *does*, exactly as a drag of the same card is. */
  typeLine: string | null;
  /** Also the menu's alone: which oracle card this is, so "View all printings" can reach it.
   *  `null` where the entries behind this tile are orphans. */
  oracleId: string | null;
  /**
   * The finishes the reader's own entries for this printing are in, as the JSON list
   * `CardMenuTarget.finishes` takes.
   *
   * **Not the finishes the printing exists in** — a collection row does not carry those — and
   * that difference is the point rather than a compromise. The tile sums entries, so it knows
   * exactly which finishes are behind the art in front of the reader — and since the finish
   * joined the grain that is **at most one**, so the menu records it without asking.
   *
   * **The empty list is the case worth warning about, and exactly one thing produces it**: a row
   * spelling a finish word `FINISHES` cannot name, which {@link ownedFinishes} drops rather than
   * pass on to the backend. A tile left saying nothing here falls to the menu's unknown-list rule
   * and silently records a **nonfoil** copy — the same shape of failure the whole finish rule
   * exists to prevent, arrived at from the one direction the rule cannot close. It is 0 live rows,
   * and it is written down because the `CHECK` on `collection_entries.finish` is the only thing
   * holding it there.
   *
   * (That warning was illustrated with "a reader who owns two foils and no nonfoil" until
   * 2026-08-26. The example was false and pre-dated the split: such a reader has always got
   * `["foil"]` out of {@link ownedFinishes} and a foil entry recorded. The warning was right; the
   * story attached to it was not.)
   *
   * The narrowing itself — `FINISHES` order, unrecognised words dropped — belongs to
   * {@link ownedFinishes} and is argued there rather than twice.
   */
  finishes: string;
  /**
   * The folder every copy behind this tile is filed in — `null` for the root.
   *
   * **One folder, and that is decision 11.** The folder joined the tile's key when the wall became
   * shelves, because a tile belongs to one shelf and a shelf is one folder: a printing filed in two
   * drawers is a tile on each, each badged with that drawer's own copies. So what used to be a list
   * — and a caption that said `2 folders` because no single name was honest — is one id, and the
   * heading above the tile names it.
   */
  folderId: number | null;
}

/**
 * The entries' finishes for one printing, in the app's own order, as stored JSON.
 *
 * `FINISHES` order (nonfoil, foil, etched) rather than the order the rows arrived in: it is
 * Scryfall's, it is what every finish picker in this app reads in, and the card menu's
 * "Add to → Collection" records the list's first finish — so an order that depended on which
 * entry the backend sorted first would file a different finish from one render to the next.
 * Unrecognised words are dropped — `finish` is TEXT with a CHECK rather than an enum this side
 * knows — and a tile left with nothing falls to the menu's unknown-list rule, which is the honest
 * answer for an entry whose finish this build cannot name.
 *
 * Every entry counts, including one emptied to zero: the wall draws a tile for it, the table
 * keeps the row with its condition and its purchase story, and it is still a finish the reader
 * has recorded holding this printing in.
 *
 * **The set handed in is now at most a singleton, and that is what makes this function worth
 * keeping rather than what makes it redundant.** The finish joined the wall's grain on
 * 2026-08-26, so a tile merges one finish by construction and this answers one entry wherever the
 * word is one `FINISHES` knows — and the empty list for the unrecognised one the paragraph above
 * is about. One is exactly the answer the menu wants: `buildCardMenu` records a single-finish
 * list without asking, so a reader who owns two foils and no nonfoil gets a **foil** entry.
 *
 * The old two-element answer was the honest thing to say about a tile that merged two objects,
 * and the fix was to stop merging them. What survives here is the narrowing — `FINISHES` order,
 * unrecognised words dropped — which a raw `JSON.stringify([row.finish])` would throw away.
 * `CollectionTile.finishes` defers to this function for that rule rather than restating it, and
 * carries the one thing that is the *field's* business: what an empty list costs at the menu.
 */
export function ownedFinishes(seen: ReadonlySet<string>): string {
  return JSON.stringify(FINISHES.filter((finish) => seen.has(finish)));
}

/**
 * The wall is a wall of *objects*, where the table is a list of entries: a printing held in one
 * finish across three grades and two languages is one piece of art to look at, so the tile
 * carries the copies of all of them.
 *
 * **The finish and the folder are part of the key; condition and language are not.** A foil and
 * a played nonfoil are two objects at two prices; the same finish in two drawers is, since shelves
 * (decision 11), a tile on each drawer's shelf, because a shelf is one folder and a tile belongs
 * to one shelf. `foldCopies` in `features/decks/collectionTiles.ts` still folds the deck panel's
 * collection wall on the card and the finish, which is right there: that wall has no shelves.
 *
 * The rows arrive shelf by shelf — the list query sends the open shelves in wall order and the
 * backend orders by position in that list — so each shelf's tiles are already contiguous and in
 * the reader's sort.
 */
export function collectionTiles(rows: readonly CollectionRow[]): CollectionTile[] {
  const copies = new Map<string, number>();
  // The same walk, answering the tile's second question: *which finishes* those copies are in —
  // always a one-element set now, which is what {@link ownedFinishes} is for.
  const finishes = new Map<string, Set<string>>();
  for (const row of rows) {
    // **The raw `row.finish`, never the narrowed one** — see {@link tileKeyOf}, which carries
    // why a word this build cannot name keys as its own tile.
    const key = tileKeyOf(row.cardId, row.finish, row.folderId);
    copies.set(key, (copies.get(key) ?? 0) + row.quantity);
    const held = finishes.get(key) ?? new Set<string>();
    held.add(row.finish);
    finishes.set(key, held);
  }
  const seen = new Set<string>();
  const out: CollectionTile[] = [];
  for (const row of rows) {
    const key = tileKeyOf(row.cardId, row.finish, row.folderId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      // The card and the finish without the folder, so every shelf a printing sits on rings
      // together when it is opened (Review Focus 1).
      ringKey: tileKeyOf(row.cardId, row.finish),
      // **The printing, which is what a press opens** — `CardGrid` keeps the two apart, and
      // this is the half `onSelect`, the art fetch and the caret note are all about.
      id: row.cardId,
      // A printing `cards` has forgotten still has the set and number the entry recorded,
      // and on a wall of art that is the whole of what identifies it.
      name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
      setCode: row.setCode,
      collectorNumber: row.collectorNumber,
      setName: row.setName,
      rarity: row.rarity,
      copies: copies.get(key) ?? 0,
      // Narrowed against `FINISHES` rather than cast, for the reason the key above is *not*
      // narrowed: `finish` is TEXT with a CHECK rather than an enum this side knows, so a word
      // this build cannot name marks the art with nothing instead of with a sheen no stylesheet
      // has — and `openCardAsFinish` is handed the same narrowed value rather than the column.
      finish: isFinish(row.finish) ? row.finish : null,
      // Off the row rather than reduced across the group: every row behind this tile names the
      // same printing *and* the same finish, so they all carry the same figure and taking the
      // first is not a choice between two answers. Already per copy, per finish, at the
      // marketplace the query named — never the derived `price_usd`, which is a fallback chain
      // and would price a plain copy at foil rates.
      unitPrice: row.unitPrice,
      typeLine: row.typeLine,
      oracleId: row.oracleId,
      finishes: ownedFinishes(finishes.get(key) ?? new Set()),
      folderId: row.folderId,
    });
  }
  return out;
}

/**
 * The tiles **by shelf** — what `CardGrid`'s `tilesOf` hands out on the desktop, and what the
 * phone face's shelved wall draws. `folderId ?? UNFILED_SHELF`, so a copy filed nowhere is Not sorted's.
 */
export function tilesByShelf(
  tiles: readonly CollectionTile[],
): ReadonlyMap<number, readonly CollectionTile[]> {
  const out = new Map<number, CollectionTile[]>();
  for (const tile of tiles) {
    const shelf = tile.folderId ?? UNFILED_SHELF;
    const held = out.get(shelf) ?? [];
    held.push(tile);
    out.set(shelf, held);
  }
  return out;
}
