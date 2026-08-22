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
 *
 * **The four functions themselves moved to `@/lib/folderTree` when the wishlist grew folders of
 * its own** — a wish's `WishlistFolder` answers the same flat shape a deck's `DeckFolder` does,
 * so the tree arithmetic, the cycle refusal and the two cascade rules needed widening rather than
 * a second copy. This file stays, re-exporting them under their old names and their old types,
 * because the eleven imports that reach these functions through `./folders` and through
 * `./FolderTree` were written against this path and must keep working with no edit.
 */

export {
  indent,
  buildFolderTree,
  flattenFolders,
  folderDescendants,
  type FolderNode,
  type FolderLike,
  type Filed,
} from "@/lib/folderTree";
