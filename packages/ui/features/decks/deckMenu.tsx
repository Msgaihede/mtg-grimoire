/**
 * What a deck offers on a right-click in the gallery.
 *
 * **A pure builder whose dependencies are an argument**, exactly as `cardMenu`'s is: the writes
 * belong to `useDecks` and the two layers belong to `DecksPage`, so every one of them arrives as
 * a callback and this file is testable without a provider, a query client or a window.
 *
 * Four of the six rows are things the tile already does — open, move, duplicate, delete — and
 * the menu is where they stop being four icons that appear on hover. The other two are new:
 *
 * * **Rename** had no inline affordance at all. Renaming a deck meant opening the editor and
 *   typing into its settings dialog, which is a round trip for one word. The field it opens is
 *   `metaRows.tsx`'s `RenameField`, the one the folder rename already uses.
 * * **Deck settings** opens `DeckSettingsDialog` **over the gallery**, on the deck that was
 *   right-clicked, without opening the editor. `DeckSettingsForm` owns no mutation and imports
 *   no hook that reaches the backend, which is precisely what lets a third host draw it.
 *
 * **Delete keeps the confirmation the tile asks**, and the type is what enforces it:
 * {@link DeckMenuDeps} carries no `remove`, so this menu structurally cannot reach the
 * irreversible write. A menu opens by accident; it must not be one press from deleting minutes
 * of work.
 */
import { BookOpen, Copy, FolderInput, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import type { MenuItem } from "@/components/menu/types";
import type { DeckRow } from "@/lib/ipc";
import { moveToFolderContent } from "./folderMenu";

/** Everything the deck menu does that is not the deck. Built once per surface, not per tile. */
export interface DeckMenuDeps {
  /** `useAppStore`'s own action, passed through — opening a deck is a navigation. */
  setOpenDeckId: (deckId: number) => void;
  /**
   * Open the tile's inline rename field.
   *
   * The whole deck rather than its id, because the field opens on the name the tile is showing
   * and the confirmation-shaped callbacks below take the row too.
   */
  startRename: (deck: DeckRow) => void;
  /** Open `DeckSettingsDialog` over the gallery, on this deck. */
  openSettings: (deckId: number) => void;
  /**
   * `deck_set_folder`, where `null` is the top level.
   *
   * **Not a `DeckPatch`**: `folderId` is written `coalesce(?n, folder_id)`, so a `null` patch
   * reads as *leave it alone* and "Move to → All decks" would be a row that reports success and
   * does nothing.
   */
  moveToFolder: (deckId: number, folderId: number | null) => void;
  duplicate: (deckId: number) => void;
  /** The confirmation the tile already asks — never `decks.remove`. See this file's doc. */
  askDelete: (deck: DeckRow) => void;
}

/** The six rows of §5, in the order the spec draws them. */
export function buildDeckMenu(deck: DeckRow, deps: DeckMenuDeps): MenuItem[] {
  return [
    {
      kind: "action",
      id: "open",
      label: "Open deck",
      Icon: BookOpen,
      onSelect: () => deps.setOpenDeckId(deck.id),
    },
    { kind: "separator", id: "after-open" },
    {
      kind: "action",
      id: "rename",
      label: "Rename…",
      Icon: Pencil,
      onSelect: () => deps.startRename(deck),
    },
    {
      // **`lazy`, so a right-click costs no read.** The folder list is asked for when the row is
      // expanded and never when the menu opens — the same `useDeckFolders` the gallery already
      // has mounted, so by then the answer is usually in the cache and the row draws at once.
      // `moveToFolderContent` is the folder menu's too: one destination list, one fence, one
      // look.
      kind: "lazy",
      id: "move",
      label: "Move to",
      Icon: FolderInput,
      Content: moveToFolderContent({
        currentId: deck.folderId,
        // A deck cannot contain a folder, so nothing is forbidden to it: the only inert row is
        // the folder it is already in.
        moving: null,
        onPick: (folderId) => deps.moveToFolder(deck.id, folderId),
      }),
    },
    {
      kind: "action",
      id: "settings",
      label: "Deck settings…",
      Icon: SlidersHorizontal,
      onSelect: () => deps.openSettings(deck.id),
    },
    { kind: "separator", id: "before-writes" },
    {
      kind: "action",
      id: "duplicate",
      label: "Duplicate",
      Icon: Copy,
      onSelect: () => deps.duplicate(deck.id),
    },
    {
      kind: "action",
      id: "delete",
      label: "Delete…",
      Icon: Trash2,
      onSelect: () => deps.askDelete(deck),
    },
  ];
}
