/**
 * The filing cabinet's shape — flat folder rows read as a tree, and the two questions
 * everything else asks of one: which folder is under which, and how much is filed in it.
 *
 * **No React in here, and that is the point of the file.** `src/features/decks/FolderTree.tsx`
 * draws the deck gallery's tree, but `cardMenu.tsx` and `folderMenu.tsx` only want the
 * arithmetic: which folder is under which, how many decks are in it, and what a folder may not
 * be moved into. Reading those out of the component module pulled a whole tree, its drag
 * machinery and everything they import in behind them.
 *
 * **Lifted here from `src/features/decks/folders.ts` when the wishlist grew folders of its
 * own.** `wishlistFolderList` answers the same flat-rows-with-a-parent-id shape
 * `deckFolderList` always has — {@link FolderLike} is that shape, `DeckFolder` and
 * `WishlistFolder` both answer it — so the tree arithmetic, the cycle refusal and the two
 * cascade rules only needed widening, not a second implementation. `FolderNode` takes its
 * folder type as a parameter for the same reason, and {@link Filed.archived} is optional because
 * a wish cannot be archived and a deck can: the one fact a deck's row carries that a wish's
 * does not must not be required of either.
 *
 * **This file is named `folderTree.ts`, and that would be unsafe one directory over.** This repo
 * is developed and shipped on a case-insensitive filesystem, where in
 * `src/features/decks/` `./FolderTree` also resolves to a sibling `folderTree.ts` — TypeScript
 * tries `.ts` before `.tsx` and the OS answers yes to both spellings — so a module of these four
 * functions sitting beside `FolderTree.tsx` there would make that component unreachable by its
 * own name, silently, everywhere it is imported. Measured at the time: `tsc --noEmit` answered
 * TS1149 plus nine "has no exported member" errors against `DecksPage.tsx` the moment the pair
 * existed. `src/lib/` has no `FolderTree` component beside this file, so the name is free here —
 * `src/features/decks/folders.ts` keeps its own name and re-exports from this module instead of
 * renaming to match it, because the component it would collide with still lives one directory
 * over.
 *
 * **Flat rows, indented — no twisty**, and the reason is a fact about the *drawing*, so it is
 * written at the drawing: `FolderTree.tsx`'s own head. What reaches this file is {@link indent},
 * which every surface that draws a folder list shares.
 *
 * **One function here is not generic, deliberately** — {@link lockedFolderIds}, which is the
 * collection cabinet's alone because `locked` is a column only `collection_folders` has. It sits
 * here rather than in the collection's own folder because it is the same downward walk over the
 * same flat rows as {@link folderDescendants}, and a second implementation of that walk one
 * directory over is how the two come to disagree.
 */

import type { CollectionFolder } from "./ipc";

/** Pixels of indent per level of nesting, and the padding the root sits at. */
const INDENT_STEP = 14;
const INDENT_BASE = 8;

/**
 * The indent, as an **inline style**.
 *
 * Tailwind v4 scans source text for whole class names, so `pl-[${n}px]` built by
 * interpolation emits no rule at all — `VirtualTable`'s column template is an inline style
 * for exactly this reason, and a tree's indent is the same shape of problem.
 *
 * Here rather than beside the rows it pads, because both surfaces that draw a folder list — the
 * tree in the sidebar and `MoveToFolder`'s destination list — indent by the same step, and the
 * one that is a picker must not import the one that is the sidebar to get it.
 */
export function indent(depth: number) {
  return { paddingLeft: INDENT_BASE + depth * INDENT_STEP };
}

/**
 * The minimal shape a filing tree can be built from — `DeckFolder` and `WishlistFolder` both
 * answer it, and that shared shape is the whole reason one implementation serves both trees.
 */
export interface FolderLike {
  id: number;
  /** The folder this one sits inside, or `null` for the root of the tree. */
  parentId: number | null;
  name: string;
  sortOrder: number;
}

/** One folder as a tree draws it: where it sits, what is under it, and how much. */
export interface FolderNode<F extends FolderLike = FolderLike> {
  folder: F;
  /** 0 at the root of the tree. What the row is indented by. */
  depth: number;
  /**
   * Live members filed here **and in everything under it** — decks for a deck folder, wishes for
   * a wishlist one.
   *
   * Recursive rather than direct, because a row reading 0 while a sub-folder under it holds
   * twelve is a lie the reader can only catch by clicking. Archived members are left out where
   * the kind of member has an archived state at all: they are behind their own disclosure with
   * their own count, and a row that says 5 over a grid showing 4 is the same lie wearing the
   * other hat.
   */
  count: number;
  children: FolderNode<F>[];
}

/**
 * What a folder row needs to know about the members in it — the two fields, so a caller can pass
 * `DeckRow[]`, `WishRow[]` or anything else that answers them.
 */
export interface Filed {
  folderId: number | null;
  /**
   * Whether this member is archived, where that is a thing the member can be at all.
   *
   * Optional rather than `boolean` because a deck can be archived and a wish cannot — `WishRow`
   * carries no such field, so requiring it here would make every wishlist caller invent one just
   * to say `false`. Absent reads as not archived, same as `false`.
   */
  archived?: boolean;
}

/** Siblings in the order the backend meant, then alphabetically, then by id so a tie is still
 *  stable across renders. */
function order(a: FolderLike, b: FolderLike): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id;
}

/**
 * The flat folder rows as a tree, with each node's member count already summed.
 *
 * Two shapes of broken input are handled rather than trusted, and both resolve the same way —
 * **towards the root, never towards nothing**. A `parentId` naming a folder this list does not
 * carry (a folder another surface deleted between the two reads) draws its child at the root;
 * a cycle, which the backend refuses outright and which only corruption could produce, draws
 * every folder it swallowed at the root as a leaf. Dropping a folder would hide the members in
 * it with no number anywhere pointing at them, and that is worse than a wrong indent.
 */
export function buildFolderTree<F extends FolderLike>(
  folders: readonly F[],
  members: readonly Filed[],
): FolderNode<F>[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const direct = new Map<number, number>();
  for (const member of members) {
    if (member.archived === true || member.folderId === null || !byId.has(member.folderId))
      continue;
    direct.set(member.folderId, (direct.get(member.folderId) ?? 0) + 1);
  }

  const childrenOf = new Map<number | null, F[]>();
  for (const folder of folders) {
    const parent = folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), folder]);
  }

  const seen = new Set<number>();
  const build = (parentId: number | null, depth: number): FolderNode<F>[] =>
    [...(childrenOf.get(parentId) ?? [])].sort(order).flatMap((folder) => {
      if (seen.has(folder.id)) return [];
      seen.add(folder.id);
      const children = build(folder.id, depth + 1);
      const under = children.reduce((n, c) => n + c.count, 0);
      return [{ folder, depth, count: (direct.get(folder.id) ?? 0) + under, children }];
    });

  const roots = build(null, 0);
  for (const folder of folders) {
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    roots.push({ folder, depth: 0, count: direct.get(folder.id) ?? 0, children: [] });
  }
  return roots;
}

/** The tree read top to bottom, which is the order it is drawn and the order a destination
 *  list offers. Each node keeps its own `depth`, so nothing has to be recomputed. */
export function flattenFolders<F extends FolderLike>(
  nodes: readonly FolderNode<F>[],
): FolderNode<F>[] {
  return nodes.flatMap((node) => [node, ...flattenFolders(node.children)]);
}

/**
 * One **level** of the tree: the folders filed directly under `parentId`, in the order they are
 * drawn. `null` is the root level, and an id the tree does not carry answers the empty level —
 * which is the same answer a folder with no children gives, and deliberately so: both mean
 * "there are no cards to draw here".
 *
 * **Read off the tree rather than filtered out of the flat rows, and the two genuinely differ.**
 * {@link buildFolderTree} resolves a folder whose parent is missing — and a folder caught in a
 * corrupt cycle — *to the root*, so a row's stored `parentId` can name a level that is nowhere on
 * screen. Every gesture a reader makes is made against what they can see, so "the level a folder
 * is in" has to mean the level it is **drawn** in. A one-line `.filter(f => f.parentId === id)`
 * over the flat list gets that wrong in exactly the case the tree was written to survive.
 *
 * Extracted on 2026-09-01 for the up-one-level tile, which needs the level **above** the one on
 * screen and could not reach it through the `childFolders` memo each page had written out in
 * full. Both pages call it for their own level too, so the walk that finds a level is written
 * once rather than three times.
 */
export function folderLevel<F extends FolderLike>(
  nodes: readonly FolderNode<F>[],
  parentId: number | null,
): readonly FolderNode<F>[] {
  if (parentId === null) return nodes;
  return flattenFolders(nodes).find((node) => node.folder.id === parentId)?.children ?? [];
}

/**
 * Every folder underneath one — what a folder may **not** be moved into.
 *
 * The backend refuses a move into a descendant in words, and that refusal is a fence rather
 * than the affordance: `deck_folders.parent_id` (and `wishlist_folders.parent_id` beside it)
 * cascades onto itself, so a cycle is a graph SQLite would walk forever the day the folder is
 * deleted. This is what greys the offer out before the reader can make it.
 *
 * Breadth-first with a visited set, so a corrupt cycle terminates here too.
 */
export function folderDescendants<F extends FolderLike>(
  folders: readonly F[],
  id: number,
): ReadonlySet<number> {
  const out = new Set<number>();
  let frontier = new Set<number>([id]);
  while (frontier.size > 0) {
    const next = new Set<number>();
    for (const folder of folders) {
      if (folder.parentId === null || !frontier.has(folder.parentId)) continue;
      if (out.has(folder.id) || folder.id === id) continue;
      out.add(folder.id);
      next.add(folder.id);
    }
    frontier = next;
  }
  return out;
}

/**
 * Every collection folder that is **effectively locked** — the ones the reader set aside, plus
 * everything filed inside one, because the lock inherits down the tree.
 *
 * **This is the single place that inheritance is computed on the TypeScript side, and no call
 * site may re-derive it.** `CollectionFolder.locked` is the folder's *own* flag and never the
 * answer: the badge on a folder card, the greyed Lock/Unlock row, the greyed Delete and the
 * drag confirmation are all four about the effective lock, and a surface that read the raw
 * field would draw an unmarked drawer inside a locked one — making the inheritance invisible
 * exactly where it matters. A move *within* one locked sub-tree is likewise computed from both
 * ends' membership of this set, not from the two folders' flags.
 *
 * **`readonly CollectionFolder[]` rather than a type parameter, and that narrowness is the
 * point.** This module serves the deck gallery and the wishlist as well, and neither
 * `DeckFolder` nor `WishlistFolder` carries a `locked` column — there is no wishlist equivalent
 * of this feature and no plan for one. A generic would invite exactly the widening the design
 * refused.
 *
 * **The mirror of `collection_folders`' recursive CTE**, spelled once on each side. Written
 * downward from the locked rows rather than by walking each folder's ancestors upward, for
 * {@link folderDescendants}' reason: one breadth-first pass with a visited set costs one sweep
 * per level instead of one per folder, and it **terminates on a corrupt cycle** — which is the
 * same `UNION` rather than `UNION ALL` the SQL uses, and for the same reason. `move_folder`
 * refuses to write a cycle; only a hand-edited database could hold one, and a helper that hung
 * the window over it would be worse than the corruption.
 */
export function lockedFolderIds(folders: readonly CollectionFolder[]): ReadonlySet<number> {
  const locked = new Set<number>();
  let frontier = new Set<number>();
  for (const folder of folders) {
    if (!folder.locked) continue;
    locked.add(folder.id);
    frontier.add(folder.id);
  }

  while (frontier.size > 0) {
    const next = new Set<number>();
    for (const folder of folders) {
      if (folder.parentId === null || !frontier.has(folder.parentId)) continue;
      if (locked.has(folder.id)) continue;
      locked.add(folder.id);
      next.add(folder.id);
    }
    frontier = next;
  }
  return locked;
}
