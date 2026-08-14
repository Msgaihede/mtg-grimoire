/**
 * The folder row's right-click menu, and the "Move to" list both gallery menus share.
 *
 * **Pure reuse, and that is the whole of it.** Every action here already exists as a button in
 * `FolderTree` or in the wall's heading row — new deck, new sub-folder, rename, move, delete —
 * every write is already written in `useDeckFolders`, and `folderDescendants` already computes
 * what a folder may not be moved into. What the menu adds is that all five are in one place, on
 * the row itself, instead of spread between a 208px tree that has no width for a second control
 * and a heading row that only speaks for the folder the reader is standing in.
 *
 * **A menu is data.** These builders answer a `MenuItem[]` and draw nothing; the panel in
 * `src/components/menu` draws it. The one exception is {@link moveToFolderContent}, which is a
 * `lazy` submenu's `Content` — the kind whose rows are a component precisely because they are
 * fetched on expand — and which is therefore the one place in this file that renders.
 */
import type { ComponentType, JSX, ReactNode } from "react";
import { Folder, FolderInput, FolderPlus, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { ROW_CLASS } from "@/components/menu/panel";
import type { MenuItem } from "@/components/menu/types";
import { ipcError, type DeckFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { folderPaths } from "./DeckSettingsForm";
import { folderDescendants } from "./FolderTree";
import { useDeckFolders } from "./useDeckFolders";

/**
 * How a destination row says which folder it is — for a test, and for a `cdp.mjs --probe`.
 *
 * Its own attribute rather than `FolderTree`'s `FOLDER_ROW_ATTR`, which means "a row of the
 * tree" and is what `DecksPage` hands the caret back to after a rename: these rows are drawn by
 * the menu panel, which is a sibling of `AppShell` and therefore outside the wall that
 * `querySelector` searches. Two ideas, two names, and neither can pick up the other's element.
 */
export const FOLDER_DESTINATION_ATTR = "data-destination-folder-id";

/** The top level, named as `MoveToFolder` names it — one wording for the same offer, whether
 *  the reader reaches it from the tile's popup or from a menu. */
const ROOT_NAME = "All decks";

/** Where a thing already is: offered, inert. `MoveToFolder`'s own word, for its reason — moving
 *  something to where it already is writes nothing and bumps `updated_at`. */
const HERE_NOW = "Here now";

/** One offer in a "Move to" list. */
export interface FolderDestination {
  /** `null` is the top level, and it is an offer with a meaning: `DeckPatch` writes every column
   *  with `coalesce(?n, column)`, so this list is the only way back to the root. */
  folderId: number | null;
  /** `Commander › Legends` — {@link folderPaths}' spelling, or {@link ROOT_NAME}. */
  name: string;
  /** Non-null when the row is drawn inert: why, in words, beside it. */
  inert: string | null;
}

/**
 * Every folder a deck or a folder may be moved to, and which of them are inert.
 *
 * **One rule for both menus**, so the deck's "Move to" and the folder's cannot come to two
 * answers about the same tree.
 *
 * **`folderPaths` rather than `buildFolderTree` + `flattenFolders`, and the reason is that a
 * menu row has no indent.** `MenuItem` carries no depth and a flat list of bare names would show
 * two "Legends" with nothing to tell them apart — so nesting is said in words, in the same
 * `Commander › Legends` spelling the settings dialog's Folder select already uses. That also
 * fixes the order: alphabetical by the whole rendered path, through the app's one collator.
 * (The folder *tree* is exempt from `sortOptions` because a tree has its own order; a flat list
 * of paths is not a tree.)
 *
 * `moving` is the folder being moved, or `null` when it is a deck that is moving. A folder may
 * not go inside itself or inside anything it holds — the backend refuses it in words, and that
 * refusal is a fence rather than the affordance, because `deck_folders.parent_id` cascades onto
 * itself and a cycle is a graph SQLite would walk forever the day the folder is deleted.
 */
export function folderDestinations(
  folders: readonly DeckFolder[],
  { currentId, moving }: { currentId: number | null; moving: number | null },
): FolderDestination[] {
  const held = moving === null ? null : folderDescendants(folders, moving);
  const inertness = (id: number | null): string | null => {
    if (id === currentId) return HERE_NOW;
    if (id === null || moving === null) return null;
    if (id === moving) return "Cannot go inside itself";
    return held?.has(id) === true ? "Cannot go inside what it holds" : null;
  };

  return [
    { folderId: null, name: ROOT_NAME, inert: inertness(null) },
    ...folderPaths(folders).map((f) => ({
      folderId: f.id,
      name: f.path,
      inert: inertness(f.id),
    })),
  ];
}

/**
 * The rows behind a "Move to" — **fetched when the row is expanded, and never when the menu
 * opens.**
 *
 * That is the whole reason this is a `lazy` submenu rather than a `submenu` of items already in
 * hand: `useDeckFolders` lives in here, so a right-click on a tile costs one render and no read,
 * and the folder list is asked for only by a reader who has gone looking for it. Both gallery
 * menus use this one component, so their destination lists are the same list drawn the same way
 * — two spellings of it would be two places for the fence below to be got wrong.
 *
 * A factory rather than a component with props, because {@link MenuLazy.Content} is handed only
 * an `onDone`: what is being moved, and where it is now, are closed over when the menu is built.
 */
export function moveToFolderContent({
  currentId,
  moving,
  onPick,
}: {
  /** Where the thing being moved is filed now — a deck's `folderId`, a folder's `parentId`. */
  currentId: number | null;
  /** The folder being moved, or `null` when it is a deck. See {@link folderDestinations}. */
  moving: number | null;
  onPick: (folderId: number | null) => void;
}): ComponentType<{ onDone: () => void }> {
  return function MoveToFolderContent({ onDone }: { onDone: () => void }): JSX.Element {
    const folders = useDeckFolders();

    // A cabinet with no drawers in it and one that has not answered yet are told apart by
    // `isPending`, never by the empty array — the hook says so on its own `folders`.
    if (folders.query.isPending) return <Note>Reading your folders…</Note>;
    if (folders.query.isError) {
      return <Note failed>Could not read your folders — {ipcError(folders.query.error)}</Note>;
    }

    return (
      <>
        {folderDestinations(folders.folders, { currentId, moving }).map((destination) => (
          <button
            key={destination.folderId ?? "root"}
            type="button"
            role="menuitem"
            // The panel owns the caret: a menu is one roving tab stop, so every row it can land
            // on is out of the tab order and reached by `moveCaret` rather than by Tab. It finds
            // these rows by their **role**, which is what lets a lazy panel's own rows — rows it
            // never saw — take the caret like any other.
            tabIndex={-1}
            // Both row attributes on one element, because a plain row *is* its button. The
            // pointer's hover handler resolves a row by `ROW_ATTR`, and without it a submenu
            // opened by hover stays open while the pointer sweeps past to the row below —
            // `ContextMenu`'s `ActionRow` carries the pair for the same reason.
            data-menu-row={`destination-${destination.folderId ?? "root"}`}
            data-menu-row-button=""
            // `aria-disabled`, never the attribute — a `disabled` button leaves the tab order,
            // and a greyed row here exists to be *read*: "Here now" and the two fences are
            // answers rather than omissions. `menuRowsIn` reads exactly this to keep the caret
            // off them.
            aria-disabled={destination.inert === null ? undefined : true}
            {...(destination.folderId === null
              ? {}
              : { [FOLDER_DESTINATION_ATTR]: destination.folderId })}
            onClick={() => {
              if (destination.inert !== null) return;
              onPick(destination.folderId);
              onDone();
            }}
            className={cn(ROW_CLASS, destination.inert === null ? LIVE_ROW : INERT_ROW)}
          >
            {destination.folderId === null ? (
              <Layers className="size-4 flex-none" aria-hidden="true" />
            ) : (
              <Folder className="size-4 flex-none" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate">{destination.name}</span>
            {destination.inert !== null && (
              <span className="flex-none text-[0.7rem] text-dim">{destination.inert}</span>
            )}
          </button>
        ))}
      </>
    );
  };
}

/**
 * A destination row's two states, over the panel's own {@link ROW_CLASS}.
 *
 * The geometry is imported rather than copied, so a row this file draws inside a menu really is
 * one of that menu's rows — `ContextMenu`'s `ActionRow` and `Submenu`'s trigger are built the
 * same way, and the colours are the row's own to add because they are what differs by state.
 * **The caret is real focus here**, which is why the live state names `focus:` alongside
 * `hover:`, exactly as `ActionRow`'s `LIVE_ROW` does; the greyed state paints no hover at all,
 * because a row that cannot be pressed must not light up under the pointer.
 */
const LIVE_ROW = "text-text hover:bg-bg focus:bg-bg";
const INERT_ROW = "cursor-default text-dim";

/**
 * What the panel says while it is reading, or when the read was refused — never a blank box,
 * which reads as a menu that has nothing to offer.
 *
 * `role="status"` rather than `alert` even for the refusal: this screen reserves `alert` for a
 * **write** the app refused, which is a thing that just happened, and a failed *read* is a
 * condition that is — `FolderTree`'s own split, one panel along. It announces nothing on mount
 * either way, because a live region that first appears with its sentence already inside it is a
 * region nothing changed in.
 */
function Note({
  children,
  failed = false,
}: {
  children: ReactNode;
  failed?: boolean;
}): JSX.Element {
  return (
    <p
      role="status"
      className={cn("px-2 py-1.5 text-xs", failed ? "text-destructive" : "text-dim")}
    >
      {children}
    </p>
  );
}

/**
 * Everything the folder menu does that is not the folder — one callback per row.
 *
 * Every one of these is a write the gallery already makes, reached from the row instead of from
 * the heading row above the wall.
 */
export interface FolderMenuDeps {
  /**
   * Make a deck **in this folder** — the create dialog, opened with the folder already chosen.
   *
   * "Here" is the promise the row makes, so a host that merely opened the dialog would create
   * the deck at the top level and the item would be a lie.
   */
  newDeck: (folderId: number) => void;
  /** The tree's own "New folder in …" control, reached from the row. */
  newSubfolder: (parentId: number) => void;
  /** The rename field that replaces the row — `DecksPage`'s `renameFolder` panel, which F2 on
   *  the row already opens. */
  startRename: (folderId: number) => void;
  /** `deck_folder_move`; `null` is the top level. The fence is drawn by
   *  {@link folderDestinations} before the backend has to refuse anything. */
  moveFolder: (folderId: number, parentId: number | null) => void;
  /**
   * The confirmation, never the delete.
   *
   * A folder's delete is the one a reader guesses wrong — the decks inside are kept and the
   * folders inside are not — so the sentence that says both is the whole point of the step.
   */
  askDelete: (folder: DeckFolder) => void;
}

/** The five things the tree's own buttons already do, on the row itself. */
export function buildFolderMenu(folder: DeckFolder, deps: FolderMenuDeps): MenuItem[] {
  return [
    {
      kind: "action",
      id: "new-deck",
      label: "New deck here",
      Icon: Plus,
      onSelect: () => deps.newDeck(folder.id),
    },
    {
      kind: "action",
      id: "new-subfolder",
      label: "New subfolder…",
      Icon: FolderPlus,
      onSelect: () => deps.newSubfolder(folder.id),
    },
    { kind: "separator", id: "after-new" },
    {
      kind: "action",
      id: "rename",
      label: "Rename…",
      Icon: Pencil,
      onSelect: () => deps.startRename(folder.id),
    },
    {
      kind: "lazy",
      id: "move",
      label: "Move to",
      Icon: FolderInput,
      Content: moveToFolderContent({
        currentId: folder.parentId,
        moving: folder.id,
        onPick: (parentId) => deps.moveFolder(folder.id, parentId),
      }),
    },
    { kind: "separator", id: "before-delete" },
    {
      kind: "action",
      id: "delete",
      label: "Delete…",
      Icon: Trash2,
      onSelect: () => deps.askDelete(folder),
    },
  ];
}
