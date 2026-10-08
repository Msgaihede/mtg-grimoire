/**
 * The shelves a folder wall is drawn as — which shelves there are, in what order, which of them
 * are folded shut, and which of them the page fetches, counts and draws.
 *
 * **A shelf is one folder's section of the wall**: its heading and the cards filed directly in
 * it. **Not sorted** is the shelf of cards filed in no folder, and it is the only shelf that is
 * not a folder — {@link UNFILED_SHELF} here, `0` on the wire. "Section", "group" and "band" are
 * not synonyms for it; the spec (`docs/superpowers/specs/2026-09-26-folder-shelves-design.md`)
 * fixes the words.
 *
 * **The list is built here and sent to Rust as ordered ids** (the spec's decision 10). The tree
 * already lives in {@link buildFolderTree}, and that is also where sibling order is decided —
 * `sortOrder`, then name, then id. SQL's own `ORDER BY sort_order, id` disagrees with it about a
 * tie, so a list worked out on the Rust side would be a second implementation of the tree that
 * draws two siblings in a different order from every picker in the app. With the list coming
 * from here, one of them decides.
 *
 * **Both pages feed it one neutral shape**, {@link ShelfFolder}. The collection maps its `kind`
 * column and the *effective* lock `lockedFolderIds` computes; the wishlist maps `managedDeckId`.
 * Nothing in this file knows which page it is drawing for, so one truth table covers both.
 *
 * No React, no store, no IPC call: pure over its inputs, which is what lets `shelves.test.ts`
 * state every rule about order, depth, collapse and filtering as a row.
 */

import { buildFolderTree, flattenFolders, type FolderNode } from "./folderTree";
import type { ShelfCount } from "./ipc";

/** The shelf of cards filed in no folder — `coalesce(folder_id, 0)` on the Rust side. */
export const UNFILED_SHELF = 0;

/**
 * How many levels of nesting a heading is indented by before it stops moving right (spec §3.3).
 * A deeper heading keeps this indent and names its path from the ancestor at this depth instead,
 * so the wall never runs out of width however deep the reader nests.
 */
export const MAX_SHELF_INDENT = 3;

/** What the unfiled shelf's heading reads. Plain text, never a button: it is not a folder. */
const UNFILED_NAME = "Not sorted";

export type ShelfKind = "unfiled" | "folder" | "deck" | "removed" | "managed";
export type ShelfGroup = "own" | "decks" | "managed";

/**
 * One folder as both pages feed it in — the collection maps `kind`, the wishlist maps
 * `managedDeckId`.
 */
export interface ShelfFolder {
  id: number;
  parentId: number | null;
  name: string;
  sortOrder: number;
  kind: Exclude<ShelfKind, "unfiled">;
  locked: boolean; // effective (inherited) lock; always false on the wishlist
}

export interface Shelf {
  id: number; // folder id, or UNFILED_SHELF
  kind: ShelfKind;
  group: ShelfGroup;
  name: string; // "Not sorted" for UNFILED_SHELF
  pathIds: number[]; // ancestors between the level and this shelf, then this shelf's own id
  path: string[]; // their names, same order
  depth: number; // 0 = directly under the level
  indent: number; // Math.min(depth, MAX_SHELF_INDENT)
  lead: string[]; // ancestor names drawn before `name` in the heading (spec §3.3)
  leadIds: number[]; // their ids, same order
  headless: boolean; // true only for an opened folder's own cards (spec §3.1)
  collapsed: boolean; // effective: false whenever filtering
  locked: boolean;
}

export interface BuildShelvesInput {
  folders: readonly ShelfFolder[]; // every folder of the page, every kind
  levelId: number | null; // null = the root
  folds: Readonly<Record<string, boolean>>; // stored overrides; stale ids ignored
  filtering: boolean;
}

/**
 * Whether a shelf of this kind starts folded shut (spec §3.4).
 *
 * The reader's folders and Not sorted start **open**; deck groups, Recently removed and managed
 * wishlist folders start **shut**, because they are built decks and derived lists rather than
 * binders. A stored fold only ever records a move *away* from this answer, which is why the
 * default is a function of the kind and is never written down itself.
 */
export function defaultCollapsed(kind: ShelfKind): boolean {
  return kind === "deck" || kind === "removed" || kind === "managed";
}

/** One ancestor on the way down from the level — what a heading's path and lead are built from. */
interface Step {
  id: number;
  name: string;
}

type Node = FolderNode<ShelfFolder>;

/** App-owned folders sort by name and nothing else, as `PinnedFolders` and `managedWishFolders`
 *  draw them today: the reader cannot arrange one, so a `sort_order` on it is not an order anybody
 *  chose. The id breaks a tie, so two decks with one name keep their places between renders. */
function byName(a: Node, b: Node): number {
  return a.folder.name.localeCompare(b.folder.name) || a.folder.id - b.folder.id;
}

/**
 * Every shelf at and below the level, in the order the wall draws them (spec §3.1).
 *
 * **At the root:** Not sorted first; then the reader's folders, depth-first, a shelf before its
 * subfolders' shelves, siblings in {@link buildFolderTree}'s order; then the app-owned folders
 * under their own group — the collection's deck groups by name and **then** Recently removed
 * (group `"decks"`), the wishlist's managed folders by name (group `"managed"`). Anything filed
 * under an app-owned folder follows it depth-first in the same group rather than vanishing.
 *
 * **Inside an opened folder:** one **headless** shelf for the level's own cards — its id is the
 * level's, it has no heading because the path row already names it, and it is never collapsed,
 * since a shelf with no chevron could never be opened again — then the level's subfolders,
 * depth-first, starting again at depth 0. No app-owned group is drawn inside a folder, so every
 * shelf here is group `"own"` even when the level is a deck group: `group` says which label a
 * shelf is drawn under, and `kind` says what it is.
 *
 * **Depth, indent and lead** (spec §3.3). `depth` counts the ancestors between the level and the
 * shelf; `indent` is that, capped at {@link MAX_SHELF_INDENT}. Down to the cap the heading's lead
 * is the whole chain from the level (`Binder › Staples › Fetchlands`); below it the lead starts at
 * the ancestor on the cap instead (`Fetchlands › Foils › Showcase`), which is what keeps a deep
 * heading as short as a shallow one. Opening a folder resets all three, which is the reader's
 * escape from a very deep chain.
 *
 * **Collapse** is `folds[id] ?? defaultCollapsed(kind)`, and `false` for every shelf while
 * `filtering` (decision 4) — the stored map is only read, so clearing the filter brings every
 * fold back untouched. A fold for a folder that no longer exists is never asked for, which is
 * all "stale ids are ignored" has to mean; Not sorted's fold is keyed `"0"`.
 *
 * **A level that no longer exists answers no shelves** — a folder another window or a synced
 * device deleted while this page stood in it. Drawing the root's shelves instead would put the
 * whole collection under a path row still naming the missing folder.
 */
export function buildShelves({ folders, levelId, folds, filtering }: BuildShelvesInput): Shelf[] {
  const tree = buildFolderTree(folders, []);
  const collapsedOf = (id: number, kind: ShelfKind): boolean =>
    filtering ? false : (folds[String(id)] ?? defaultCollapsed(kind));

  const shelfOf = (folder: ShelfFolder, group: ShelfGroup, chain: readonly Step[]): Shelf => {
    const depth = chain.length;
    const lead = chain.slice(depth > MAX_SHELF_INDENT ? MAX_SHELF_INDENT : 0);
    return {
      id: folder.id,
      kind: folder.kind,
      group,
      name: folder.name,
      pathIds: [...chain.map((step) => step.id), folder.id],
      path: [...chain.map((step) => step.name), folder.name],
      depth,
      indent: Math.min(depth, MAX_SHELF_INDENT),
      lead: lead.map((step) => step.name),
      leadIds: lead.map((step) => step.id),
      headless: false,
      collapsed: collapsedOf(folder.id, folder.kind),
      locked: folder.locked,
    };
  };

  // Depth-first over the tree `buildFolderTree` already ordered. Its own `flattenFolders` would
  // give the same order, but drops the ancestor chain every shelf's path is made of.
  const walk = (nodes: readonly Node[], group: ShelfGroup, chain: readonly Step[]): Shelf[] =>
    nodes.flatMap((node) => [
      shelfOf(node.folder, group, chain),
      ...walk(node.children, group, [...chain, { id: node.folder.id, name: node.folder.name }]),
    ]);

  if (levelId !== null) {
    const level = flattenFolders(tree).find((node) => node.folder.id === levelId);
    if (level === undefined) return [];
    const own: Shelf = { ...shelfOf(level.folder, "own", []), headless: true, collapsed: false };
    return [own, ...walk(level.children, "own", [])];
  }

  const unfiled: Shelf = {
    id: UNFILED_SHELF,
    kind: "unfiled",
    group: "own",
    name: UNFILED_NAME,
    pathIds: [UNFILED_SHELF],
    path: [UNFILED_NAME],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: collapsedOf(UNFILED_SHELF, "unfiled"),
    locked: false,
  };
  const ofKind = (kind: ShelfFolder["kind"]) => tree.filter((node) => node.folder.kind === kind);
  return [
    unfiled,
    ...walk(ofKind("folder"), "own", []),
    ...walk([...ofKind("deck").sort(byName), ...ofKind("removed").sort(byName)], "decks", []),
    ...walk(ofKind("managed").sort(byName), "managed", []),
  ];
}

/** Whether any ancestor between the level and this shelf is folded shut. Every id in `pathIds`
 *  but the last is such an ancestor; the headless shelf is nobody's, and is never shut. */
function underShut(shelf: Shelf, shut: ReadonlySet<number>): boolean {
  for (let i = 0; i < shelf.pathIds.length - 1; i++) {
    if (shut.has(shelf.pathIds[i])) return true;
  }
  return false;
}

function shutIds(shelves: readonly Shelf[]): ReadonlySet<number> {
  return new Set(shelves.filter((shelf) => shelf.collapsed).map((shelf) => shelf.id));
}

/**
 * The ids to send as `shelves` on the list query — the shelves drawn **open**, in wall order.
 *
 * A collapsed shelf's cards are never fetched (spec §4.1), and neither are those of any shelf
 * under it, whatever that shelf's own fold says: its heading is not on screen, so there is
 * nothing to draw them under. Passing {@link visibleShelves}' answer instead is also correct and
 * trims the shelves a filter has already shown to be empty.
 */
export function shelvesToFetch(shelves: readonly Shelf[]): number[] {
  const shut = shutIds(shelves);
  return shelves
    .filter((shelf) => !shelf.collapsed && !underShut(shelf, shut))
    .map((shelf) => shelf.id);
}

/**
 * The ids to send to the shelf-counts query — **every** shelf, collapsed ones included, because
 * a collapsed heading still states its figures and the header counts everything the wall covers
 * (spec §3.6, §4.2).
 */
export function shelvesToCount(shelves: readonly Shelf[]): number[] {
  return shelves.map((shelf) => shelf.id);
}

/**
 * The shelves that get a place on the wall, in order.
 *
 * - **Under a collapsed shelf**: hidden — the fold is what the chevron promised.
 * - **Not sorted with no cards is drawn, like an empty folder** (issue #597, reversing spec §3.1's
 *   "drawn only when it has cards"). It is the root's drop target — a card let go on it is filed
 *   in no folder — and a target that vanishes the moment the reader has filed everything leaves
 *   no way back out of a folder by dragging. **The one exception is a wall with no other shelf
 *   on it**: with no folder of any kind there is nowhere a card could be dragged *from*, and an
 *   empty Not sorted would be the whole wall, standing where the page says it has nothing yet.
 * - **While filtering**: a shelf is hidden only when neither it nor anything under it has a
 *   match. A folder whose matches are all in its subfolders keeps its heading as their container
 *   — the review's `Mana base` case — so a match deep inside a folder the reader had collapsed
 *   is drawn with every heading above it (collapse is already off: {@link buildShelves} saw the
 *   same `filtering`, and the two must be given the same flag).
 * - **`counts` still loading (`null`)**: nothing but the collapsed subtrees is hidden. Hiding on
 *   a count that has not arrived would draw a filled collection as empty for a frame.
 *
 * A count row names a shelf by id, so a row for a shelf that is not in the list — a folder
 * deleted since the counts were asked for — matches nothing and is ignored.
 */
export function visibleShelves(
  shelves: readonly Shelf[],
  counts: ReadonlyMap<number, ShelfCount> | null,
  filtering: boolean,
): Shelf[] {
  const shut = shutIds(shelves);
  const open = shelves.filter((shelf) => !underShut(shelf, shut));
  if (counts === null) return open;

  const hasCards = (id: number) => (counts.get(id)?.tiles ?? 0) > 0;
  if (!filtering) {
    const alone = shelves.every((shelf) => shelf.kind === "unfiled");
    return open.filter((shelf) => shelf.kind !== "unfiled" || !alone || hasCards(shelf.id));
  }

  // A shelf with a match lights itself and every ancestor between it and the level.
  const lit = new Set<number>();
  for (const shelf of shelves) {
    if (!hasCards(shelf.id)) continue;
    for (const id of shelf.pathIds) lit.add(id);
  }
  return open.filter((shelf) => lit.has(shelf.id));
}
