/**
 * Somebody else's drawers, flattened into a list this app can put in a picker.
 *
 * **A second implementation of the walk `share/SharePage.tsx` does, and the duplication is
 * deliberate rather than unnoticed.** The two viewers of this format share the parser
 * (`@/lib/shareSnapshot`) and nothing else by construction: that module imports nothing so the
 * web bundle can stay free of a Tauri boundary, and it is the format's *reader* rather than its
 * presentation. Reaching across the other way — `src/` importing from `share/` — would put the
 * viewer bundle's module graph inside the app. So the walk is written twice, and the fence is
 * this file's own test rather than a shared function.
 *
 * What both copies get right is the same two things, and they are the reason a plain recursion
 * is not enough: a `parent` that resolves nowhere is a **root** here (the format's third
 * documented absence — a folder shared out of the middle of a cabinet), and a cycle or a
 * repeated uid must not hang the page.
 */
import type { ShareFolder, ShareSnapshot } from "@/lib/shareSnapshot";

/** One drawer, at its depth in the shared tree, with what is inside it. */
export interface Drawer extends ShareFolder {
  /** `0` for a drawer at the root of the share. */
  depth: number;
  /**
   * Copies in this drawer **and every drawer beneath it** — one number, so a row cannot lie.
   *
   * Copies rather than rows, which is the app's own unit everywhere a quantity is drawn beside
   * a folder: a drawer holding one row of four cards holds four cards.
   */
  count: number;
}

/**
 * The drawers, depth-first, each carrying a recursive count.
 *
 * Returns `[]` for a whole-collection share, which carries no folders at all — a caller draws
 * no picker rather than an empty one.
 */
export function drawers(snapshot: ShareSnapshot): Drawer[] {
  const uids = new Set(snapshot.folders.map((f) => f.uid));
  const children = new Map<string | null, ShareFolder[]>();
  for (const folder of snapshot.folders) {
    // A `parent` this snapshot does not carry is a drawer shared out of the middle of somebody's
    // cabinet. It gets a root rather than a card nobody can reach.
    const key = folder.parent !== null && uids.has(folder.parent) ? folder.parent : null;
    const kin = children.get(key);
    if (kin === undefined) children.set(key, [folder]);
    else kin.push(folder);
  }

  const own = new Map<string, number>();
  for (const card of snapshot.cards) {
    if (card.fo !== null) own.set(card.fo, (own.get(card.fo) ?? 0) + card.q);
  }

  const flat: Drawer[] = [];
  const seen = new Set<string>();
  const visit = (folder: ShareFolder, depth: number): number => {
    // `seen` is what makes a cycle impossible rather than merely unlikely. The format promises an
    // acyclic tree; a document that breaks the promise draws each drawer once and stops.
    if (seen.has(folder.uid)) return 0;
    seen.add(folder.uid);
    const node: Drawer = { ...folder, depth, count: 0 };
    flat.push(node);
    node.count = (own.get(folder.uid) ?? 0) + walk(folder.uid, depth + 1);
    return node.count;
  };
  const walk = (parent: string | null, depth: number): number => {
    let total = 0;
    for (const folder of children.get(parent) ?? []) total += visit(folder, depth);
    return total;
  };
  walk(null, 0);
  // **Whatever the walk did not reach is a root too**, and this line is the difference between a
  // malformed document losing a drawer and merely mis-nesting one. A cycle has no root at all —
  // every folder in it names a parent that resolves — so a walk from `null` finds none of them
  // and the picker silently loses every drawer in the loop along with the way to the cards in
  // them. Measured on a two-folder cycle while writing this file's test: the tree came back
  // empty. Nothing else here can produce an unreached folder, so on every document the writer
  // can actually produce this loop does nothing.
  for (const folder of snapshot.folders) visit(folder, 0);
  return flat;
}

/**
 * Every drawer at or beneath `uid` — what "show me this drawer" means to a reader.
 *
 * Read off the flattened list rather than off the tree: the list is depth-first, so a drawer's
 * descendants are exactly the run after it whose depth is greater than its own.
 */
export function subtreeOf(flat: readonly Drawer[], uid: string): Set<string> {
  const index = flat.findIndex((f) => f.uid === uid);
  const kept = new Set([uid]);
  if (index === -1) return kept;
  for (let i = index + 1; i < flat.length && flat[i].depth > flat[index].depth; i += 1) {
    kept.add(flat[i].uid);
  }
  return kept;
}
