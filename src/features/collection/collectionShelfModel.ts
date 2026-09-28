/**
 * The collection's shelves as numbers and words — everything about the Shelves wall (spec
 * `docs/superpowers/specs/2026-09-26-folder-shelves-design.md`) that this page decides and that
 * needs no React to decide.
 *
 * `lib/shelves.ts` owns the shape of the wall — which shelves there are, in what order, which are
 * open — and is shared with the wishlist. What is here is this cabinet's own reading of it: how a
 * `collection_folders` row becomes a shelf, what a heading says about the copies under it, what a
 * chevron press writes, and where the heading of a folder that does not exist yet goes. Pure, so
 * each rule is a row in `collectionShelfModel.test.ts` rather than a claim a page test has to
 * reach through a render.
 */
import { PEEK_LIMIT } from "@/features/shelves/ShelfHeading";
import { count } from "@/lib/counts";
import type { FolderLike, FolderNode } from "@/lib/folderTree";
import type { CollectionFolder, ShelfCount } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { defaultCollapsed, visibleShelves, type Shelf, type ShelfFolder } from "@/lib/shelves";
import { DECK_KIND } from "./PinnedFolders";

/**
 * The id of the heading drawn for a folder that is being named and does not exist yet.
 *
 * `collection_folders.id` is an `INTEGER PRIMARY KEY` and `UNFILED_SHELF` is `0`, so a negative id
 * can never collide with a real shelf. It never reaches the wire: the page adds the draft only to
 * the shelves it *draws*, never to the ones `useCollection` fetches or counts.
 */
export const NEW_FOLDER_SHELF = -1;

/**
 * One `collection_folders` row as `buildShelves` takes it.
 *
 * **Written positively, and a kind this build cannot name is the app's.** `user` is a folder the
 * reader made, `deck` a deck's group, and anything else — `removed` today, a fourth kind tomorrow —
 * is treated as app-owned: collapsed by default, never draggable, never renamed, never a drop
 * target. That is `readersOwnLevel`'s direction on the page: a control that turns itself on for a
 * kind nobody has thought about is the failure worth preventing.
 *
 * `locked` is the **effective** lock (`lockedFolderIds`), never the row's own flag.
 */
export function shelfFolderOf(
  folder: CollectionFolder,
  lockedIds: ReadonlySet<number>,
): ShelfFolder {
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    sortOrder: folder.sortOrder,
    kind: folder.kind === "user" ? "folder" : folder.kind === DECK_KIND ? "deck" : "removed",
    locked: lockedIds.has(folder.id),
  };
}

/**
 * The folder **Add folder** is naming, as a shelf input — last among its siblings (spec §3.8:
 * "the new folder appears where it will live") and set aside when its parent is, because
 * `create_folder` will put it inside that lock.
 */
export function draftFolder(parentId: number | null, lockedIds: ReadonlySet<number>): ShelfFolder {
  return {
    id: NEW_FOLDER_SHELF,
    parentId,
    name: "",
    sortOrder: Number.MAX_SAFE_INTEGER,
    kind: "folder",
    locked: parentId !== null && lockedIds.has(parentId),
  };
}

/** `collection_shelf_counts` indexed by shelf — `null` while it has not answered, which
 *  `visibleShelves` reads as "do not hide anything yet". */
export function countsById(
  counts: readonly ShelfCount[] | undefined,
): ReadonlyMap<number, ShelfCount> | null {
  return counts === undefined ? null : new Map(counts.map((one) => [one.folderId, one]));
}

/** What a heading states about the copies at and under it. */
export interface ShelfFigures {
  copies: number;
  /** `null` until something at or under the shelf is priced — `sum()`'s own reading of `NULL`. */
  value: number | null;
  unpriced: number;
}

/**
 * Every shelf's figures **with the shelves under it added in**.
 *
 * `collection_shelf_counts` answers per shelf — the copies filed *directly* in it — which is right
 * for the query and wrong for a heading: a folder whose cards are all in its subfolders would read
 * `0 cards` over a subtree holding twelve (Review Focus 2). `pathIds` names every ancestor between
 * the level and the shelf and then the shelf itself, so one pass adds each count to each of them.
 */
export function rolledUp(
  shelves: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount>,
): ReadonlyMap<number, ShelfFigures> {
  const out = new Map<number, ShelfFigures>();
  for (const shelf of shelves) {
    const own = counts.get(shelf.id);
    if (own === undefined) continue;
    for (const id of new Set([...shelf.pathIds, shelf.id])) {
      const at = out.get(id) ?? { copies: 0, value: null, unpriced: 0 };
      out.set(id, {
        copies: at.copies + own.copies,
        value: own.value === null ? at.value : (at.value ?? 0) + own.value,
        unpriced: at.unpriced + own.unpriced,
      });
    }
  }
  return out;
}

/**
 * A heading's figures line (spec §3.2): `42 cards · $2,490.00 · 3 unpriced`, or `3 of 42 cards`
 * under a filter.
 *
 * - `figures` is `null` while the counts have not answered — an em dash, `folderFace`'s reading
 *   of "not counted yet", never `0 cards`; `undefined` is an answered shelf with no row, which is
 *   an empty one.
 * - `total` is the **unfiltered** copies at and under the shelf, from `collection_folder_summary`
 *   and `subtotalsOf`; `null` where nothing counts it (Not sorted) or it has not answered, and
 *   then a filtered heading states its matches alone.
 * - Money only where there are cards and something is priced: `$0.00` is a price nobody quoted.
 */
export function shelfStat({
  figures,
  total,
  filtering,
  currency,
}: {
  figures: ShelfFigures | null | undefined;
  total: number | null;
  filtering: boolean;
  currency: Currency;
}): string {
  if (figures === null) return "—";
  const f = figures ?? { copies: 0, value: null, unpriced: 0 };
  const cards = (n: number) => (n === 1 ? "card" : "cards");
  if (filtering) {
    return total === null
      ? `${count(f.copies)} ${cards(f.copies)}`
      : `${count(f.copies)} of ${count(total)} ${cards(total)}`;
  }
  const parts = [`${count(f.copies)} ${cards(f.copies)}`];
  if (f.copies > 0 && f.value !== null) parts.push(formatPrice(f.value, currency));
  if (f.unpriced > 0) parts.push(`${count(f.unpriced)} unpriced`);
  return parts.join(" · ");
}

/**
 * What a chevron press writes: the new state, or `null` where it lands back on the kind's default
 * — `shelf_folds` holds only the shelves the reader moved off their default (spec §5.7), so a
 * folder expanded again removes its entry rather than storing `false`.
 */
export function foldChange(shelf: Pick<Shelf, "kind">, collapsed: boolean): boolean | null {
  return collapsed === defaultCollapsed(shelf.kind) ? null : collapsed;
}

/**
 * **Expand all** / **Collapse all** (spec §3.4): every shelf below the level, app-owned ones
 * included — but not the level's own headless cards, which have no chevron to reopen them with,
 * and not a folder still being named, which has no id to store.
 */
export function foldAll(
  shelves: readonly Shelf[],
  collapsed: boolean,
): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const shelf of shelves) {
    if (shelf.headless || shelf.id === NEW_FOLDER_SHELF) continue;
    out[String(shelf.id)] = foldChange(shelf, collapsed);
  }
  return out;
}

/**
 * Every folder's parent **as the tree draws it** — `null` for the root level.
 *
 * Not the row's own `parentId`: `buildFolderTree` draws a folder whose parent another surface
 * deleted at the root, so a before/after drop beside that orphan reorders the root, which is the
 * level it is on screen in (the drawer-whose-parent-is-gone case the reorder tests pin).
 */
export function treeParents<F extends FolderLike>(
  nodes: readonly FolderNode<F>[],
): ReadonlyMap<number, number | null> {
  const out = new Map<number, number | null>();
  const walk = (level: readonly FolderNode<F>[], parent: number | null) => {
    for (const node of level) {
      out.set(node.folder.id, parent);
      walk(node.children, node.folder.id);
    }
  };
  walk(nodes, null);
  return out;
}

/**
 * What a collapsed heading peeks at (spec §3.2): `ShelfCount.peek`'s card ids — up to four per
 * shelf, unfiltered — for the shelf **and then every shelf under it**, in wall order, cut at
 * `PEEK_LIMIT`.
 *
 * The subtree and not the shelf alone, because a collapse hides the subtree: a collapsed
 * `Mana base` whose cards are all in `Fetches` and `Duals` would otherwise peek at nothing over a
 * shelf holding forty. `name` is `""` — the counts carry ids, and `ShelfHeading` draws the peek
 * `aria-hidden`, so a name would be read by nobody.
 */
export function peekOf(
  shelf: Shelf,
  shelves: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount> | null,
): { cardId: string; name: string }[] {
  if (counts === null) return [];
  const out: { cardId: string; name: string }[] = [];
  for (const one of shelves) {
    if (!one.pathIds.includes(shelf.id) && one.id !== shelf.id) continue;
    for (const cardId of counts.get(one.id)?.peek ?? []) {
      if (out.length === PEEK_LIMIT) return out;
      out.push({ cardId, name: "" });
    }
  }
  return out;
}

/**
 * `visible` with the shelf `id` drawn even where a filter hid it — for the heading of a folder
 * being named or renamed — **and every heading it hangs under**. A naming field the reader cannot
 * see is still an open layer holding the page's `"inner"` Escape rung, so a filter must not be able
 * to take it off screen; and a heading drawn without its parent would claim to be somewhere it is
 * not. `drawn` is `buildShelves`' depth-first order and `visible` a subsequence of it, so filtering
 * `drawn` keeps the tree's order exactly. The wishlist's `keepNewFolder`, one cabinet over.
 */
export function keepShelf(
  visible: readonly Shelf[],
  drawn: readonly Shelf[],
  id: number | null,
): Shelf[] {
  if (id === null || visible.some((shelf) => shelf.id === id)) return [...visible];
  const kept = drawn.find((shelf) => shelf.id === id);
  if (kept === undefined) return [...visible];
  const keep = new Set([...visible.map((shelf) => shelf.id), ...kept.pathIds, kept.id]);
  return drawn.filter((shelf) => keep.has(shelf.id));
}

/**
 * The wall while a folder heading is in the air (spec §3.9): **every heading, shut, with no
 * cards** — so the whole tree is a column of targets a short move apart.
 *
 * Built with every shelf opened first, because "every shelf folds to its heading" means every
 * heading is drawn — a nested one under a parent the reader had shut included — where running the
 * stored folds through `visibleShelves` would hide that parent's subtree and its targets with it.
 * The opened folder's own headless shelf goes (it has no heading to fold to); Not sorted stays
 * wherever `visibleShelves` draws it, empty included (issue #597), so the headings below it do not
 * jump up by a shelf as the drag starts. **A render-time override that writes nothing**: the stored
 * folds come back on the drop. The wishlist's twin has the same name and the same rule.
 */
export function foldedForDrag(
  shelves: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount>,
  filtering: boolean,
): Shelf[] {
  const open = shelves.map((shelf) => (shelf.collapsed ? { ...shelf, collapsed: false } : shelf));
  return visibleShelves(open, counts, filtering)
    .filter((shelf) => !shelf.headless)
    .map((shelf) => ({ ...shelf, collapsed: true }));
}
