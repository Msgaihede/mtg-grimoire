/**
 * The wishlist's shelves as this page draws them — the pure half, so every rule in it is a truth
 * table in `wishShelfPlan.test.ts` rather than a behaviour a page test has to stage.
 *
 * **`lib/shelves.ts` decides the tree and this file decides the wishlist.** Which shelves exist,
 * in what order, which are shut and which are hidden is asked of `buildShelves` and
 * `visibleShelves`; what is this page's own is what only a wishlist knows — that a deck's folder
 * is `managed` and nothing is ever locked, what a heading's figures say, where a card let go on a
 * shelf is filed, and how the table interleaves its heading bands with its rows.
 */
import { plural } from "@/lib/counts";
import type { ShelfCount, WishlistFolder, WishRow } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { layoutShelves, type ShelfSection } from "@/lib/shelfLayout";
import {
  defaultCollapsed,
  UNFILED_SHELF,
  visibleShelves,
  type Shelf,
  type ShelfFolder,
} from "@/lib/shelves";

/**
 * The id of the folder being **added** — the heading drawn where the new folder will live, whose
 * name is the naming field (spec §3.8).
 *
 * Negative because `wishlist_folders.id` is an `INTEGER PRIMARY KEY` and therefore always positive,
 * and never `0`, which is Not sorted. **It never reaches the wire**: nothing is fetched or counted
 * for a folder that does not exist yet, which is why the page builds it into the shelves it *draws*
 * and never into the ones `useWishlist` sends.
 */
export const NEW_FOLDER_SHELF = -1;

/** One wishlist folder as `buildShelves` takes it. `locked` is always `false`: the wishlist has no
 *  lock, and a deck's managed folder refuses hand writes by being `managed`, not by being locked. */
export function toShelfFolder(folder: WishlistFolder): ShelfFolder {
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    sortOrder: folder.sortOrder,
    kind: folder.managedDeckId !== null ? "managed" : "folder",
    locked: false,
  };
}

/**
 * The folder being added, as `buildShelves` takes it — **last among its siblings**, because
 * `wishlist_folder_create` appends and the heading is drawn where the folder will appear, so
 * nothing moves when ✓ lands. `Number.MAX_SAFE_INTEGER` rather than a count of the siblings,
 * because the order is `sortOrder, name, id` and a sibling may already hold any smaller number.
 */
export function newFolderShelf(parentId: number | null): ShelfFolder {
  return {
    id: NEW_FOLDER_SHELF,
    parentId,
    name: "",
    sortOrder: Number.MAX_SAFE_INTEGER,
    kind: "folder",
    locked: false,
  };
}

/** Which shelf a wish sits on — its folder, or Not sorted. */
export function shelfOfWish(row: Pick<WishRow, "folderId">): number {
  return row.folderId ?? UNFILED_SHELF;
}

/** Where a card let go on a shelf is filed: the folder itself, or the root for Not sorted. */
export function fileTarget(shelf: Pick<Shelf, "id">): number | null {
  return shelf.id === UNFILED_SHELF ? null : shelf.id;
}

/** The loaded rows, grouped by shelf, in the order the list answered them — which is shelf order
 *  and then the reader's sort within it, because `shelves` is the list's first `ORDER BY` term. */
export function rowsByShelf(rows: readonly WishRow[]): ReadonlyMap<number, readonly WishRow[]> {
  const out = new Map<number, WishRow[]>();
  for (const row of rows) {
    const id = shelfOfWish(row);
    const list = out.get(id);
    if (list === undefined) out.set(id, [row]);
    else list.push(row);
  }
  return out;
}

/**
 * The counts the wall is laid out from — the server's, raised wherever more rows are already
 * loaded than it says.
 *
 * **Two reads, answering at two moments.** The list and the counts are separate queries settled by
 * one invalidation, so for a round trip either can be ahead of the other; a shelf drawn from a
 * count one short of the rows on screen would drop a card the reader can see. The loaded rows are a
 * floor, never a ceiling — a count larger than what has loaded is what places the slots of a page
 * that has not arrived yet (spec §5.2). `null` until the counts have answered at all, which the page
 * reads as "reading", never as "empty".
 */
export function effectiveCounts(
  counts: readonly ShelfCount[] | undefined,
  loaded: ReadonlyMap<number, readonly WishRow[]>,
): ReadonlyMap<number, ShelfCount> | null {
  if (counts === undefined) return null;
  const out = new Map(counts.map((c) => [c.folderId, c]));
  for (const [id, rows] of loaded) {
    const known = out.get(id);
    if (known === undefined) {
      out.set(id, {
        folderId: id,
        tiles: rows.length,
        copies: 0,
        value: null,
        unpriced: 0,
        peek: [],
      });
    } else if (known.tiles < rows.length) {
      out.set(id, { ...known, tiles: rows.length });
    }
  }
  return out;
}

/** The whole wall's figures — the header's `Wishes` and `Total cost` (spec §3.6). */
export interface CountTotals {
  wishes: number;
  copies: number;
  /** Priced shelves summed. A shelf nothing in which is priced adds nothing, and is counted in
   *  `unpriced` instead — never quoted at another marketplace's rate. */
  value: number;
  unpriced: number;
}

/** Summed over the **server's** counts, never the loaded rows: this is the number the header
 *  exists to get right when most of the list has not been fetched. `null` until they answer. */
export function countTotals(counts: readonly ShelfCount[] | undefined): CountTotals | null {
  if (counts === undefined) return null;
  return counts.reduce<CountTotals>(
    (sum, c) => ({
      wishes: sum.wishes + c.tiles,
      copies: sum.copies + c.copies,
      value: sum.value + (c.value ?? 0),
      unpriced: sum.unpriced + c.unpriced,
    }),
    { wishes: 0, copies: 0, value: 0, unpriced: 0 },
  );
}

/** How many tile slots a shelf draws: none while shut (its cards were never fetched), none for
 *  the folder being added, and otherwise what the counts say. */
export function tileCountOf(shelf: Shelf, counts: ReadonlyMap<number, ShelfCount>): number {
  if (shelf.collapsed || shelf.id === NEW_FOLDER_SHELF) return 0;
  return counts.get(shelf.id)?.tiles ?? 0;
}

export function sectionsOf(
  visible: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount>,
): ShelfSection[] {
  return visible.map((shelf) => ({ shelf, tileCount: tileCountOf(shelf, counts) }));
}

/**
 * The visible shelves with **the folder being added** put back, and the ancestors it hangs under.
 *
 * `visibleShelves` hides, under a filter, every shelf with no match in it or below it — and a
 * folder that does not exist yet has none, so without this the heading holding the reader's caret
 * would vanish the moment they typed a search. `all` is `buildShelves`' depth-first order and
 * `visible` a subsequence of it, so filtering `all` keeps the tree's order exactly.
 */
export function keepNewFolder(all: readonly Shelf[], visible: readonly Shelf[]): Shelf[] {
  const phantom = all.find((shelf) => shelf.id === NEW_FOLDER_SHELF);
  if (phantom === undefined || visible.some((shelf) => shelf.id === NEW_FOLDER_SHELF)) {
    return [...visible];
  }
  const keep = new Set([...visible.map((shelf) => shelf.id), ...phantom.pathIds]);
  return all.filter((shelf) => keep.has(shelf.id));
}

/**
 * The wall while a folder heading is in the air (spec §3.9): **every heading, shut, with no
 * cards** — so the whole tree is a column of targets a short move apart.
 *
 * Built from the shelves opened first, because "every shelf folds to its heading" means every
 * heading is drawn — the nested one under a parent the reader had shut included — where running
 * the stored folds through `visibleShelves` would hide that parent's whole subtree and take its
 * targets with it. The opened folder's own headless shelf goes (it has no heading to fold to); Not
 * sorted stays wherever `visibleShelves` draws it, empty included (issue #597), so the headings
 * below it do not jump up by a shelf as the drag starts. **A render-time override that writes
 * nothing**: the stored folds are untouched and come back on the drop.
 */
export function foldedForDrag(
  shelves: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount>,
  filtering: boolean,
): ShelfSection[] {
  const open = shelves.map((shelf) => (shelf.collapsed ? { ...shelf, collapsed: false } : shelf));
  return visibleShelves(open, counts, filtering)
    .filter((shelf) => !shelf.headless)
    .map((shelf) => ({ shelf: { ...shelf, collapsed: true }, tileCount: 0 }));
}

/** The stored override for one shelf: the state itself where it departs from the kind's default,
 *  `null` — "back to the default" — where it does not (spec §5.7). */
export function foldFor(shelf: Pick<Shelf, "kind">, collapsed: boolean): boolean | null {
  return collapsed === defaultCollapsed(shelf.kind) ? null : collapsed;
}

/**
 * **Expand all** / **Collapse all** as one write: every shelf below the level, app-owned ones
 * included (spec §3.4) — all of them, not only the visible ones, because a nested shelf under a
 * shut parent is below the level too and Expand all has to open it. The level's own headless shelf
 * has no chevron, and the folder being added is not a folder yet.
 */
export function foldChanges(
  shelves: readonly Shelf[],
  collapsed: boolean,
): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const shelf of shelves) {
    if (shelf.headless || shelf.id === NEW_FOLDER_SHELF) continue;
    out[String(shelf.id)] = foldFor(shelf, collapsed);
  }
  return out;
}

/** A folder's unfiltered figures, recursive — `wishlist_folder_summary` plus `subtotalsOf`. */
export interface ShelfFigures {
  wishes: number;
  copies: number;
  /** `null` where nothing is priced: an em dash beside `3 unpriced`, never `$0.00`. */
  cost: number | null;
  unpriced: number;
}

/** `6 wishes · $312.00 · 1 unpriced`, or the wishes alone for a folder holding none — the folder
 *  card's face, read across to the heading it became. */
function face(figures: ShelfFigures, currency: Currency): string {
  const wishes = plural(figures.wishes, "card");
  if (figures.copies === 0) return wishes;
  return [
    wishes,
    formatPrice(figures.cost, currency),
    ...(figures.unpriced > 0 ? [`${figures.unpriced} unpriced`] : []),
  ].join(" · ");
}

/** The matches in a shelf **and every shelf under it** — `pathIds` names the ancestors between the
 *  level and a shelf, so a shelf is under this one exactly when its path holds this one's id. */
function matchedBelow(
  shelf: Shelf,
  shelves: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount>,
): number {
  let matched = 0;
  for (const one of shelves) {
    if (one.pathIds.includes(shelf.id)) matched += counts.get(one.id)?.tiles ?? 0;
  }
  return matched;
}

/**
 * What a heading's figures say (spec §3.2).
 *
 * - **Unfiltered**, a folder reads its own recursive figures — the drawer and everything in it,
 *   the number the folder card used to print — and Not sorted reads its own count.
 * - **Under a filter**, `3 of 42 wishes`: the matches in it and below, over its unfiltered total.
 *   Not sorted has no unfiltered total the page is holding, so it reads `3 matching`, and so does
 *   a folder whose summary has not answered.
 * - The folder being added says nothing; its name is still being typed.
 */
export function shelfStat({
  shelf,
  shelves,
  counts,
  subtotal,
  filtering,
  currency,
}: {
  shelf: Shelf;
  /** Every shelf at and below the level, shut ones included — the counts cover all of them. */
  shelves: readonly Shelf[];
  counts: ReadonlyMap<number, ShelfCount>;
  /** `null` for Not sorted, and for a folder before `wishlist_folder_summary` has answered. */
  subtotal: ShelfFigures | null;
  filtering: boolean;
  currency: Currency;
}): string {
  if (shelf.id === NEW_FOLDER_SHELF) return "";
  if (filtering) {
    const matched = matchedBelow(shelf, shelves, counts);
    return subtotal === null
      ? `${matched} matching`
      : `${matched} of ${plural(subtotal.wishes, "card")}`;
  }
  if (shelf.kind === "unfiled") {
    const own = counts.get(UNFILED_SHELF);
    return face(
      {
        wishes: own?.tiles ?? 0,
        copies: own?.copies ?? 0,
        cost: own?.value ?? null,
        unpriced: own?.unpriced ?? 0,
      },
      currency,
    );
  }
  return subtotal === null ? "—" : face(subtotal, currency);
}

/**
 * A row of the table that is not a wish: a shelf's heading, the label over the decks' group, or an
 * empty shelf's box with no heading of its own to hang under.
 */
export type ShelfBandRow =
  | {
      band: "heading";
      shelf: Shelf;
      /** The wall draws this shelf's empty box under its heading — `layoutShelves`' `empty` row —
       *  so the band draws it too, and is `SHELF_EMPTY_HEIGHT` taller for it (the table's rule 2). */
      empty: boolean;
    }
  | { band: "label"; group: "decks" | "managed" }
  /** The box alone: the opened folder's own **headless** shelf, empty — the folder the reader is
   *  standing in, which the path row names and no heading does. `SHELF_EMPTY_HEIGHT` tall. */
  | { band: "empty"; shelf: Shelf };
export type WishTableRow = WishRow | ShelfBandRow;
/** `WishRow` has no `band` field, so its presence is the whole discriminator. */
export const isBand = (row: WishTableRow): row is ShelfBandRow => "band" in row;

export interface ShelfTable {
  rows: WishTableRow[];
  /** The shelf each row belongs to, same order — what the sticky bar names. `null` for a label. */
  owners: (Shelf | null)[];
  /** Data rows only: every wish the sections will draw, loaded or not. `VirtualTable` adds the
   *  bands to `aria-rowcount` itself (rule 3). */
  total: number;
}

/**
 * The table's rows (spec §3.10): each shelf's heading band, then that shelf's wishes — with a label
 * band before the decks' group, and no heading band for the opened folder's own headless shelf.
 *
 * **Read off `layoutShelves` at one column — the wall's own layout — and never decided twice.**
 * Which shelf gets a label, a heading and an empty box is `layoutShelves`' answer, and the grid
 * draws exactly those rows; the table used to carry a second copy of the empty-box rule, and the two
 * drifted (the live pass, §13): an opened empty folder drew the dashed box on the wall and nothing
 * in the table — so no drop target — and a deck's empty managed folder drew words in the table and
 * nothing on the wall. One layout is one story. An `empty` row under its own shelf's heading folds
 * into that heading's band (`empty: true`); one with no heading above it — the headless level — is
 * a band of its own.
 *
 * **It stops at the first shelf still loading** while pages remain. The list is paged in shelf
 * order, so a shelf partly loaded is the edge of what has arrived, and drawing the bands after it
 * would put headings over rows that are not there — a `6 wishes` band with nothing under it until
 * the reader scrolls. `VirtualTable` asks for the next page when the last row renders, which is
 * that shelf's last loaded row; the rest arrive with it.
 */
export function shelfTable(
  sections: readonly ShelfSection[],
  rowsOf: (shelfId: number) => readonly WishRow[],
  complete: boolean,
): ShelfTable {
  const rows: WishTableRow[] = [];
  const owners: (Shelf | null)[] = [];
  const total = sections.reduce((sum, { tileCount }) => sum + tileCount, 0);
  const expected = new Map(sections.map(({ shelf, tileCount }) => [shelf.id, tileCount]));
  const drawn = new Set<number>();
  for (const row of layoutShelves(sections, 1).rows) {
    if (row.kind === "label") {
      rows.push({ band: "label", group: row.group });
      owners.push(null);
    } else if (row.kind === "heading") {
      rows.push({ band: "heading", shelf: row.shelf, empty: false });
      owners.push(row.shelf);
    } else if (row.kind === "empty") {
      const above = rows[rows.length - 1];
      const ownHeading =
        above !== undefined &&
        isBand(above) &&
        above.band === "heading" &&
        above.shelf.id === row.shelf.id;
      if (ownHeading) {
        rows[rows.length - 1] = { ...above, empty: true };
      } else {
        rows.push({ band: "empty", shelf: row.shelf });
        owners.push(row.shelf);
      }
    } else if (!drawn.has(row.shelf.id)) {
      // One column: a shelf is one `tiles` row per tile, all consecutive. Its loaded wishes are
      // drawn once, where its first one is.
      drawn.add(row.shelf.id);
      const loaded = rowsOf(row.shelf.id);
      for (const wish of loaded) {
        rows.push(wish);
        owners.push(row.shelf);
      }
      if (!complete && loaded.length < (expected.get(row.shelf.id) ?? 0)) break;
    }
  }
  return { rows, owners, total };
}
