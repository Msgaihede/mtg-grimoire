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
import { MenuRows } from "@/components/menu/ContextMenu";
import { ROW_ATTR } from "@/components/menu/panel";
import type { MenuItem } from "@/components/menu/types";
import { ipcError, type DeckFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { folderPaths } from "./DeckSettingsForm";
import { folderDescendants } from "./FolderTree";
import { useDeckFolders } from "./useDeckFolders";

/**
 * How a destination row says which folder it is — for a test, and for a `cdp.mjs --probe`.
 *
 * **The menu's own row attribute, because the row is the menu's own row.** These were
 * hand-rolled buttons carrying a `data-destination-folder-id` of their own until 2026-08-14 —
 * which is also how they came to skip the panel's caret hand-back, the defect
 * {@link moveToFolderContent} records. They are `ActionRow`s now, and an `ActionRow` carries
 * `data-menu-row` and nothing a caller may add to it, so what a row stands for is said in its
 * **id** — {@link folderDestinationRowId}, which `MenuRows` already requires to be unique within
 * one level.
 *
 * Still not `FolderTree`'s `FOLDER_ROW_ATTR`, which means "a row of the tree" and is what
 * `DecksPage` hands the caret back to after a rename: these rows are drawn by the menu panel, a
 * sibling of `AppShell` and therefore outside the wall that `querySelector` searches. Two ideas,
 * two names, and neither can pick up the other's element.
 */
export const FOLDER_DESTINATION_ATTR = ROW_ATTR;

/**
 * Which folder a destination row is, as the row's own id — `root` for the top level, which is a
 * real offer and not a folder.
 *
 * Exported so that a test and a `cdp.mjs --probe` compose the id rather than re-spelling it;
 * paired with {@link FOLDER_DESTINATION_ATTR}, which says where to read it.
 */
export const folderDestinationRowId = (folderId: number | null): string =>
  `destination-${folderId ?? "root"}`;

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
 *
 * **`currentId` is normalised against this very list, and that is done here rather than at either
 * call site.** A `folderId` naming a folder the list does not carry — a refused folder read, a
 * folder another surface deleted between the two reads — resolves to the **root**, which is the
 * rule `buildFolderTree` already applies to a child whose parent is missing and the rule
 * `DecksPage`'s own `folderOf` applies before it hands the tile's `MoveToFolder` a `currentId`.
 * Reading it raw is how a menu and the popup one press away come to two answers about one deck:
 * the popup marks `All decks` "Here now" and the menu marks nothing, offering a live
 * `deck_set_folder(id, null)` for a deck that already resolves to the root — the no-op write that
 * bumps `updated_at` and changes nothing, which is the whole thing {@link HERE_NOW} exists to
 * prevent. Folded in here so that a third caller cannot miss it.
 */
export function folderDestinations(
  folders: readonly DeckFolder[],
  { currentId, moving }: { currentId: number | null; moving: number | null },
): FolderDestination[] {
  const held = moving === null ? null : folderDescendants(folders, moving);
  const here =
    currentId !== null && folders.some((folder) => folder.id === currentId) ? currentId : null;
  const inertness = (id: number | null): string | null => {
    if (id === here) return HERE_NOW;
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
 *
 * **The rows are `MenuRows`, and that is what puts the caret back where the reader left it**
 * (fixed 2026-08-14). They were hand-rolled `role="menuitem"` buttons that called `onPick` and
 * then `onDone` — and `onDone` is `ctx.close`, which `ContextMenu` documents as "close the whole
 * menu and hand focus **nowhere**". A destination is chosen exactly as `Rename…` or `Delete…` is,
 * so it has to end where they end: `ctx.run`, which focuses the opener *while the row is still
 * mounted*, then closes, then writes. Skipping it left the caret on a panel that was unmounting,
 * dropped it on `<body>`, and the next Tab restarted from the top of the app — with the folder
 * row still on screen and still focusable. It also ran the write **before** the close, which is
 * the same three lines in the wrong order.
 *
 * This is the case `MenuRows` exists to prevent: a lazy body offering real choices should not
 * have to rebuild a row. `ActionRow` draws everything this markup did — the icon, the label,
 * `aria-disabled` and the reason beside it — and it is the one place the hand-back lives, so a
 * second drawing of a row is a second place for it to be got wrong. `onDone` is therefore
 * accepted and **not called**: `ctx.run` has already closed the menu by the time a row of this
 * body runs, and calling it too would be a second close of something already gone.
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
  /**
   * The offers, as the panel's own rows.
   *
   * An inert one is drawn and read and never pressed: `disabled` becomes `aria-disabled` on the
   * row — never the attribute, which would take it out of the tab order — and the `reason` is
   * "Here now" or one of the two fences, drawn beside the name. `ActionRow`'s own `onClick` is
   * what refuses the press, so an inert row's `onSelect` can never run and says so by doing
   * nothing.
   */
  const destinationItems = (folders: readonly DeckFolder[]): MenuItem[] =>
    folderDestinations(folders, { currentId, moving }).map((destination): MenuItem => {
      const row = {
        kind: "action",
        id: folderDestinationRowId(destination.folderId),
        label: destination.name,
        Icon: destination.folderId === null ? Layers : Folder,
      } as const;
      return destination.inert === null
        ? { ...row, onSelect: () => onPick(destination.folderId) }
        : { ...row, disabled: true, reason: destination.inert, onSelect: () => {} };
    });

  return function MoveToFolderContent(): JSX.Element {
    const folders = useDeckFolders();

    // A cabinet with no drawers in it and one that has not answered yet are told apart by
    // `isPending`, never by the empty array — the hook says so on its own `folders`.
    if (folders.query.isPending) return <Note>Reading your folders…</Note>;
    if (folders.query.isError) {
      return <Note failed>Could not read your folders — {ipcError(folders.query.error)}</Note>;
    }

    return <MenuRows items={destinationItems(folders.folders)} />;
  };
}

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
