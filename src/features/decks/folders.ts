import type { DeckFolder } from "@/lib/ipc";

/**
 * The filing cabinet's shape — the flat `deck_folder_list` rows read as a tree, and the two
 * questions everything else asks of one.
 *
 * **No React in here, and that is the point of the file.** `FolderTree.tsx` draws this, but
 * `cardMenu.tsx` and `folderMenu.tsx` only want the arithmetic: which folder is under which,
 * how many decks are in it, and what a folder may not be moved into. Reading those out of the
 * component module pulled a whole tree, its drag machinery and everything they import in behind
 * them.
 *
 * **The cycle those two menus were in was already broken by then, and this is a different
 * edge.** `src/lib/dropMarks.ts` was split out earlier in the same wave to keep `AppShell` out of
 * the menu's import graph. What remained after that was a menu module pulling a 915-line
 * component for four pure functions — not a cycle, just weight, and weight that could turn back
 * into one the next time anything in that component grew an import.
 *
 * **Named `folders.ts` rather than `folderTree.ts`, and that is a fact about Windows.** This
 * repo is developed and shipped on a case-insensitive filesystem, where `./FolderTree` resolves
 * to `folderTree.ts` — TypeScript tries `.ts` before `.tsx` and the OS answers yes to both
 * spellings — so the component beside this file would have become unreachable by its own name,
 * silently, everywhere it is imported. Measured: `tsc --noEmit` answered TS1149 plus nine
 * "has no exported member" errors against `DecksPage.tsx` the moment the pair existed.
 *
 * **Flat rows, indented — no twisty**, and the reason is a fact about the *drawing*, so it is
 * written at the drawing: `FolderTree.tsx`'s own head. What reaches this file is {@link indent},
 * which both surfaces that draw a folder list share.
 */

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

/** One folder as the tree draws it: where it sits, what is under it, and how much. */
export interface FolderNode {
  folder: DeckFolder;
  /** 0 at the root of the tree. What the row is indented by. */
  depth: number;
  /**
   * Live decks filed here **and in everything under it**.
   *
   * Recursive rather than direct, because a row reading 0 while a sub-folder under it holds
   * twelve decks is a lie the reader can only catch by clicking. Archived decks are left out:
   * they are behind their own disclosure with their own count, and a row that says 5 over a
   * grid showing 4 is the same lie wearing the other hat.
   */
  deckCount: number;
  children: FolderNode[];
}

/** What a folder row needs to know about the decks in it — the two fields, so a caller can
 *  pass `DeckRow[]` or anything else that answers them. */
interface Filed {
  folderId: number | null;
  archived: boolean;
}

/** Siblings in the order the backend meant, then alphabetically, then by id so a tie is still
 *  stable across renders. */
function order(a: DeckFolder, b: DeckFolder): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id;
}

/**
 * The flat `deck_folder_list` rows as a tree, with each node's deck count already summed.
 *
 * Two shapes of broken input are handled rather than trusted, and both resolve the same way —
 * **towards the root, never towards nothing**. A `parentId` naming a folder this list does not
 * carry (a folder another surface deleted between the two reads) draws its child at the root;
 * a cycle, which the backend refuses outright and which only corruption could produce, draws
 * every folder it swallowed at the root as a leaf. Dropping a folder would hide the decks in it
 * with no number anywhere pointing at them, and that is worse than a wrong indent.
 */
export function buildFolderTree(
  folders: readonly DeckFolder[],
  decks: readonly Filed[],
): FolderNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const direct = new Map<number, number>();
  for (const deck of decks) {
    if (deck.archived || deck.folderId === null || !byId.has(deck.folderId)) continue;
    direct.set(deck.folderId, (direct.get(deck.folderId) ?? 0) + 1);
  }

  const childrenOf = new Map<number | null, DeckFolder[]>();
  for (const folder of folders) {
    const parent = folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), folder]);
  }

  const seen = new Set<number>();
  const build = (parentId: number | null, depth: number): FolderNode[] =>
    [...(childrenOf.get(parentId) ?? [])].sort(order).flatMap((folder) => {
      if (seen.has(folder.id)) return [];
      seen.add(folder.id);
      const children = build(folder.id, depth + 1);
      const under = children.reduce((n, c) => n + c.deckCount, 0);
      return [{ folder, depth, deckCount: (direct.get(folder.id) ?? 0) + under, children }];
    });

  const roots = build(null, 0);
  for (const folder of folders) {
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    roots.push({ folder, depth: 0, deckCount: direct.get(folder.id) ?? 0, children: [] });
  }
  return roots;
}

/** The tree read top to bottom, which is the order it is drawn and the order a destination
 *  list offers. Each node keeps its own `depth`, so nothing has to be recomputed. */
export function flattenFolders(nodes: readonly FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolders(node.children)]);
}

/**
 * Every folder underneath one — what a folder may **not** be moved into.
 *
 * The backend refuses a move into a descendant in words, and that refusal is a fence rather
 * than the affordance: `deck_folders.parent_id` cascades onto itself, so a cycle is a graph
 * SQLite would walk forever the day the folder is deleted. This is what greys the offer out
 * before the reader can make it.
 *
 * Breadth-first with a visited set, so a corrupt cycle terminates here too.
 */
export function folderDescendants(folders: readonly DeckFolder[], id: number): ReadonlySet<number> {
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
