/**
 * A ManaBox export, split by where its reader had each card filed — issue #873.
 *
 * ManaBox writes one CSV for the whole collection and says, on every row, which **binder** the
 * copy sits in and what kind of binder it is (`Binder Name`, `Binder Type`; `parse.ts` reads both
 * into `ParsedLine.binder`). Read as a plain collection import that file lands every copy at the
 * root, and the reader re-files a few thousand cards by hand into drawers they had already made
 * once. This planner is what lets one press put them back where they were:
 *
 * - a **`deck`** binder becomes a **new deck** of that name, in the `unspecified` format — the
 *   export says nothing about what the deck is for, so the deck is judged by no rule until the
 *   reader picks one — its cards filed into piles by the app's own **auto-sort**
 *   (`autoCategoryFor`: Oracle tags, then the type line; ManaBox names no pile, so nothing in
 *   the file outranks it, and `deck_import_commit` makes the piles as `'auto'` categories) and
 *   its copies filed into the deck's own group, exactly what the new-deck import's "Add cards
 *   to collection" box does;
 * - **every other kind** — `binder`, ManaBox's `list`, a blank — becomes a **folder** of that
 *   name, found or made at the top level of the collection; and
 * - a row naming **no binder** stays at the root, which is where the plain import puts it.
 *
 * **ManaBox's `list` is a folder, and that is a choice rather than a fact.** ManaBox keeps lists
 * for cards a reader is tracking rather than holding, so a wishlist folder is the other reading.
 * The folder wins because this whole file is a *collection* import the reader started from the
 * collection page: every other row of it is a copy they own, a folder is where they can see and
 * move the rows, and nothing is ever dropped (`parse.ts`' rule) — a wish built from a row would
 * be a card quietly leaving the count the preview just promised.
 *
 * **Pure, like the two planners it is built from.** No group gets a planner of its own: a folder's
 * rows go through `planCollectionImport` and a deck's through `buildImportPlan` as well, over a
 * sub-list cut out of the one `ParsedList` and the one `resolved` answer the dialog already holds
 * — so a card lands in the same pile and at the same grain whichever door it came through. The
 * writes are `useImport`'s `importBinders`.
 */
import type { CollectionImportItem, ImportItem, ImportResolveRow, PrintingTags } from "@/lib/ipc";
import type { ParsedLine, ParsedList } from "../parse";
import {
  planCollectionImport,
  type CollectionOptions,
  type DroppedPrice,
  type FoldedLine,
} from "./collection";
import { buildImportPlan, toImportItems } from "./deck";

/** What one binder becomes — see the module doc for which kind goes where. */
export type BinderTarget = "folder" | "deck";

/** ManaBox's kind word that makes a deck. Everything else is filed as a folder. */
const DECK_BINDER = "deck";

/** One binder of the file, planned. */
export interface BinderGroup {
  /**
   * The binder's name as the file spelled it — the folder or deck this lands in. `null` is the
   * rows that named no binder at all, which stay at the root; there is at most one such group,
   * and it is always a `folder` target.
   */
  name: string | null;
  target: BinderTarget;
  /**
   * The copies, at the collection's grain. For a `deck` these are filed into the new deck's own
   * group, so the deck reads every one of them as owned the moment the dialog closes.
   */
  collectionItems: CollectionImportItem[];
  /** The deck's list — `buildImportPlan`'s piles, no commander chosen. Empty for a folder. */
  deckItems: ImportItem[];
  /** Copies that will land, which is the collection items' sum — not the rows the file had, some
   *  of which may have matched nothing. */
  totalCards: number;
}

export interface BinderPlan {
  /** In the order the file first names each binder, which is the only order a reader can check
   *  against the file they exported. */
  groups: BinderGroup[];
  /** How many groups are folders and decks — the preview's headline. The root group is not a
   *  folder and is counted by neither. */
  folders: number;
  decks: number;
  /**
   * The lines that merged into an earlier line **of the same binder** — the groups' own folds,
   * which are what the sorted press actually writes. The whole-file plan's `folded` is not: it
   * merges a Sol Ring in a binder into the one in a deck, two rows the sorted press keeps apart.
   * Measured on a real export (2026-10-11, 9,583 rows): 382 whole-file merges against the
   * binders' own count, so the preview read as if hundreds of cards would cross between drawers.
   */
  folded: FoldedLine[];
  /** {@link folded}'s twin for a price dropped in a merge — `CollectionPlan.droppedPrices`, per
   *  binder, for the same reason. */
  droppedPrices: DroppedPrice[];
}

/** Whether any line of the list names a binder — i.e. whether there is anything to sort by. */
export function hasBinders(list: ParsedList): boolean {
  return list.lines.some((line) => (line.binder ?? null) !== null);
}

/** What a line's binder becomes. */
function targetOf(line: ParsedLine): BinderTarget {
  return line.binder?.type === DECK_BINDER ? "deck" : "folder";
}

/**
 * The list split by binder, each part planned the way its destination plans a whole list.
 *
 * Groups are keyed on **kind and exact name**: ManaBox lets a binder and a deck share a name and
 * those are two places, while two spellings of one folder's name (`Bulk`, `bulk`) are two groups
 * that the commit files into the one folder it finds case-insensitively — the same answer a
 * reader would get importing them one after the other.
 *
 * A group whose every row matched nothing plans no items and is dropped here, so the commit never
 * makes an empty folder or an empty deck out of a binder of typos. Its rows are still on the
 * preview — `ImportProblems` lists every unmatched line of the whole file — so nothing is lost
 * without a word.
 */
export function planBinderImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
  tags: readonly PrintingTags[],
  options: CollectionOptions,
): BinderPlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const order: string[] = [];
  const indices = new Map<string, number[]>();
  list.lines.forEach((line, index) => {
    const name = line.binder?.name ?? null;
    const key = name === null ? "" : `${targetOf(line)}\u0000${name}`;
    const held = indices.get(key);
    if (held === undefined) {
      order.push(key);
      indices.set(key, [index]);
    } else {
      held.push(index);
    }
  });

  const groups: BinderGroup[] = [];
  const folded: FoldedLine[] = [];
  const droppedPrices: DroppedPrice[] = [];
  for (const key of order) {
    const at = indices.get(key)!;
    const first = list.lines[at[0]];
    const name = first.binder?.name ?? null;
    const target: BinderTarget = name === null ? "folder" : targetOf(first);
    const part = subList(list, at, byIndex);
    const collection = planCollectionImport(part.list, part.rows, options);
    const collectionItems = collection.items;
    if (collectionItems.length === 0) continue;
    // Line numbers are the file's own — a sub-list keeps every line's `lineNumber` — so these
    // quote the reader's file exactly as the whole-file plan's would.
    folded.push(...collection.folded);
    droppedPrices.push(...collection.droppedPrices);
    // `null` for the spec and no commander picked: an `unspecified` deck has no command zone to
    // fill, and the file names none — ManaBox has no column for it. A reader who moves the
    // commander in afterwards is choosing a format at the same time.
    const deckItems =
      target === "deck" ? toImportItems(buildImportPlan(part.list, part.rows, null, tags), []) : [];
    groups.push({
      name,
      target,
      collectionItems,
      deckItems,
      totalCards: collectionItems.reduce((n, item) => n + item.quantity, 0),
    });
  }
  return {
    groups,
    folders: groups.filter((g) => g.target === "folder" && g.name !== null).length,
    decks: groups.filter((g) => g.target === "deck").length,
    folded: folded.sort((a, b) => a.lineNumber - b.lineNumber),
    droppedPrices: droppedPrices.sort((a, b) => a.lineNumber - b.lineNumber),
  };
}

/**
 * The lines at `at`, as a list of their own, with the resolver's rows re-indexed to match.
 *
 * **Re-indexed, never re-resolved**: `ImportResolveRow.index` is a position in the list that was
 * sent, so a row carried across unchanged would point at whichever line happens to sit at that
 * position in the shorter list. The parse issues stay on the whole file's plan and are not
 * repeated per group — they belong to no binder, since a row the parser could not read named
 * none it could be trusted for.
 */
function subList(
  list: ParsedList,
  at: readonly number[],
  byIndex: ReadonlyMap<number, ImportResolveRow>,
): { list: ParsedList; rows: ImportResolveRow[] } {
  const lines = at.map((index) => list.lines[index]);
  const rows: ImportResolveRow[] = [];
  at.forEach((index, position) => {
    const row = byIndex.get(index);
    if (row !== undefined) rows.push({ ...row, index: position });
  });
  return {
    list: {
      lines,
      issues: [],
      totalCards: lines.reduce((n, line) => n + line.quantity, 0),
      suggestedName: null,
      csv: list.csv,
    },
    rows,
  };
}
