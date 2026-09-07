import {
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, Folder, FolderOpen, FolderPlus, Layers } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { FolderDropLine } from "@/components/FolderDropLine";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { plural } from "@/lib/counts";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import {
  folderDraggable,
  useFolderDropTarget,
  type FolderDrag,
  type FolderEdge,
} from "@/lib/folderDrag";
import { FOCUS } from "@/lib/focus";
import type { DeckFolder } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useDeckDropTarget, type DeckDrag } from "./deckDrag";
import { flattenFolders, indent, type FolderNode } from "./folders";

/**
 * The filing cabinet: the tree the deck gallery is read through, drawn as rows.
 *
 * **What the tree *is* lives in `folders.ts` and the gesture that files a deck into one of
 * its drawers lives in `deckDrag.ts`.** This file is the drawing and nothing else: the rows,
 * the one field that names a folder, and the two doors into a row's menu. The split is what
 * lets `cardMenu.tsx` and `folderMenu.tsx` ask what is under a folder without importing a
 * sidebar — and `MoveToFolder` offer the same folders without importing this.
 *
 * **Flat rows, indented — no twisty.** `deck_folders` has no notion of depth and a reader has
 * tens of folders at most, so every folder is always on screen and the indent is the whole of
 * the nesting. A collapsed branch would be somewhere a deck could hide with no number pointing
 * at it, which is the one thing a filing cabinet must never do.
 */

/**
 * The three modules this one was split out of, re-exported for the three files that still reach
 * them through this path.
 *
 * **A bridge, not an API, and it has three consumers rather than one.** `DecksPage.tsx` takes
 * eleven names from this path — seven of them the re-exports below — while `DeckTile.tsx` takes
 * three and `FolderCard.tsx` four, and every one of those imports was written while this file was
 * the only address those exports had. It is the *page* in particular that wants all three modules,
 * not this component: `folders.ts` for the tree it builds, `deckDrag.ts` for the tile it makes
 * draggable, and `MoveToFolder` for the popup it anchors to that tile. Everything outside those
 * three already imports the module it means — `folderMenu.tsx` and `cardMenu.tsx` read
 * `folders.ts`, and `MoveToFolder.tsx` says at its own head why it must.
 *
 * **So deleting it is four edits and not one**: re-point those three files at `./folders`,
 * `./deckDrag` and `./MoveToFolder`, and take this block with them. In the other order it takes
 * two of them red.
 *
 * It carries only what those three import — a one-file bridge that re-exported more would be
 * inviting a fourth consumer through it. `deckDragData` and `readDeckDrag` are the two that left:
 * `FolderTree.test.tsx` takes both, and takes them from `./deckDrag` directly.
 */
export { buildFolderTree, flattenFolders, folderDescendants, type FolderNode } from "./folders";
export { deckDraggable, useDeckDragging, useDeckDropTarget, type DeckDrag } from "./deckDrag";
export { MoveToFolder } from "./MoveToFolder";

/**
 * The one folder field that may be open, and what it is for.
 *
 * One shape for both jobs, because there is only ever one field: a folder is named in the tree
 * whether it is being made or being corrected, and the page holds this as part of its single
 * `Panel` so the Escape handshake has exactly one rung to order. `"new"` opens a row at the
 * indent the folder *will* have; `"rename"` replaces the row the folder already has.
 */
export type FolderNaming =
  { kind: "new"; parentId: number | null } | { kind: "rename"; folderId: number };

/** How the page finds a folder's row to hand the caret back to after the field it replaced
 *  closes. An attribute for `data-deck-id`'s reason: the row the layer replaced is a *different
 *  element* by the time the layer is gone, so a ref taken when it opened points at nothing. */
export const FOLDER_ROW_ATTR = "data-folder-id";

/**
 * What the gallery calls the top level — the row this tree draws above every folder, and the
 * destination `null` names everywhere else.
 *
 * **Exported because three surfaces say it and one of them is new.** The tree's own root row, the
 * wall's heading, and — since issue #283 — the wall's up-one-level tile, which names the level it
 * would move a deck *to*. A tile that said "Top level" over a tree row saying "All decks" would be
 * two names for the destination of one drag, and the reader is looking at both at once.
 */
export const ROOT_LABEL = "All decks";

/**
 * A folder that can be picked up — a row here, or a card on the wall.
 *
 * **One hook for the gallery's two drawings of a folder**, which is why it is exported rather
 * than written twice: `FolderCard.tsx` already reaches this module for the tree and the deck
 * drag, and two copies of a registration whose whole subtlety is *when it re-registers* would
 * drift the first time either surface grew a prop.
 *
 * `folderDraggable` takes a callback and this reads it out of a **ref** for that callback's own
 * reason: `node.folder` is a fresh object on every refetch, so an effect keyed on it would tear
 * the source down and rebuild it in the middle of a gesture — `useFolderDropTarget` keeps its two
 * callbacks in a ref against exactly that. Registration is keyed on the id alone, which is what a
 * row is keyed on, so it happens once per folder for the life of the row.
 *
 * `null` for the tree's "All decks" row, which is the root rather than a folder: there is nothing
 * to pick up.
 */
export function useFolderDragSource(
  ref: RefObject<HTMLElement | null>,
  folder: DeckFolder | null,
): void {
  const latest = useRef(folder);
  useEffect(() => {
    latest.current = folder;
  });

  const id = folder?.id ?? null;
  useEffect(() => {
    const element = ref.current;
    if (element === null || id === null) return;
    return folderDraggable({
      element,
      // The name and the parent are read at `dragstart`, so a folder renamed or re-filed since
      // its row mounted carries what it is now — and its current parent is what lets a nest that
      // would move it nowhere be refused before the drop. The ref holds this same folder for the
      // whole life of the registration (a row is keyed on its id, and only a folder registers),
      // so the fallbacks below stand for a state that cannot arise rather than for one that can.
      folder: () => ({
        folderId: id,
        name: latest.current?.name ?? "",
        parentId: latest.current?.parentId ?? null,
        scope: "deck",
      }),
    });
  }, [ref, id]);
}

/** A row's two doors into one menu — a right-click, and Shift+F10 or the ContextMenu key. */
export interface FolderRowMenu {
  onContextMenu: MouseEventHandler<HTMLButtonElement>;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}

export interface FolderTreeProps {
  nodes: readonly FolderNode[];
  /** Every live deck there is — what the "All decks" row counts. */
  totalDecks: number;
  /** The folder the wall is showing, or `null` for the top level. */
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** The deck in the air, or `null`: every folder that could take *this one* says so. */
  drag: DeckDrag | null;
  canDropIn: (drag: DeckDrag, folderId: number | null) => boolean;
  onDropIn: (drag: DeckDrag, folderId: number | null) => void;
  /**
   * The other drag: a **folder** let go on this row, and where it would land relative to it.
   *
   * There is no `drag` prop beside these the way there is for a deck, and that is the shape of
   * the mechanism rather than an omission: `useFolderDropTarget` runs a monitor **per target**
   * gated by this same question, so a row answers "could I take it?" for itself. No two rows
   * answer the same — one refuses itself, one refuses a nest that would move nothing, one refuses
   * a cycle — which is what a single `drag` prop could not express.
   *
   * `folderId` is `null` for the "All decks" row: see the tree's own call below for what the root
   * takes and why.
   */
  canDropFolder: (drag: FolderDrag, folderId: number | null, edge: FolderEdge) => boolean;
  onDropFolder: (drag: FolderDrag, folderId: number | null, edge: FolderEdge) => void;
  /** The one open field, or `null`. Held by the page so it is the page's single dismissible
   *  layer — two Escape peers are not ordered by the handshake at all. */
  naming: FolderNaming | null;
  onOpenNew: (parentId: number | null, opener: HTMLButtonElement) => void;
  /** F2 on a row. There is no trigger *on* the row: a 208px column with an indent, a glyph, a
   *  name, a count and a "new folder" control has no width left for a second one, so the
   *  pointer's route is the wall's own "Rename folder" and this is the keyboard's. */
  onOpenRename: (folderId: number) => void;
  /** Focus left the field on its own: it closes and hands nothing back. */
  onCloseNaming: () => void;
  /** Whatever the open field is for — the page knows which from its own `Panel`. */
  onName: (name: string) => void;
  /** The create-or-rename write is in flight. */
  busy: boolean;
  /** The folder list itself was refused. The tree says so and the wall goes on working. */
  failure: string | null;
  pending: boolean;
  /**
   * One folder row's right-click, built by the page.
   *
   * **The menu is data and the page is what has the writes**, so this tree draws rows and never
   * decides what a row offers — the same split `DeckEditor` uses for a deck card's menu. That
   * sentence is now the whole of the reason. It used to carry a second one: `folderMenu.tsx`
   * reads `folderDescendants`, which was *this file's*, so a `buildFolderMenu` call in here was a
   * cycle. **The split removed that edge** — `folderMenu.tsx`'s import list has no path back to
   * this file, and `folders.ts` imports nothing local — so calling the builder here would type-
   * check today. It stays a prop because the writes are the page's, which never depended on the
   * graph.
   *
   * Not offered for "All decks", which is the tree's root and not a folder — there is nothing to
   * rename, move or delete.
   */
  rowMenu: (folder: DeckFolder) => FolderRowMenu;
  /**
   * Where a row writes itself when its menu opens, so a layer that menu raises has an opener to
   * hand the caret back to.
   *
   * **A menu row has no element of its own** — a `MenuAction.onSelect` is a bare callback — so
   * the deps the page built cannot be told which row was pressed unless the row says so first.
   * `DecksPage`'s `menuOpenerRef` one floor along carries the same fact for the same reason, and
   * this is that ref: one menu is open at a time, so one note is enough for both.
   *
   * **The row's `<button>`, never its `<li>` or the box around it.** The panel hands the caret
   * back to the element the menu was opened on, and `focus()` on a non-focusable node is a
   * no-op that drops the reader on `<body>`.
   */
  menuOpenerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The sidebar: every folder there is, indented, each row saying what is in it — and every row
 * a place a deck can be dropped.
 */
export function FolderTree({
  nodes,
  totalDecks,
  selectedId,
  onSelect,
  drag,
  canDropIn,
  onDropIn,
  canDropFolder,
  onDropFolder,
  naming,
  onOpenNew,
  onOpenRename,
  onCloseNaming,
  onName,
  busy,
  failure,
  pending,
  rowMenu,
  menuOpenerRef,
}: FolderTreeProps) {
  const tip = useTooltip();
  const flat = flattenFolders(nodes);
  /** Where a "new folder" field is open, or `undefined` when the open field is a rename. */
  const newAt = naming?.kind === "new" ? naming.parentId : undefined;

  return (
    <nav
      aria-label="Folders"
      className="flex w-52 flex-none flex-col overflow-y-auto border-r border-border pr-3"
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="font-heading text-lg leading-none">Folders</h2>
        <button
          type="button"
          aria-label="New folder at the top level"
          aria-expanded={newAt === null}
          {...tip("New folder", { describes: false })}
          onClick={(e) => onOpenNew(null, e.currentTarget)}
          className={cn(
            "grid size-6 place-items-center rounded-md border border-border text-dim",
            "transition-colors duration-150 hover:border-accent hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <FolderPlus className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* A failed **read**, reported the way this screen reports its other one (the wall's own
          "Reading your decks…" line): `status`, not `alert`. `alert` is reserved here for a
          write the app refused, which is a thing that just happened rather than a condition
          that is. Mounted only when there is something to say — a tree that has loaded has no
          slot for a sentence. */}
      {/* Grown into place: the whole tree below it is what moves otherwise. The gap under the
          sentence is `pb-2` on the child rather than a margin on the animated element, which is
          the split `motion.ts` asks for — a margin on a box whose height is animating to 0
          still occupies its margin, so the layout would jump by 8px instead of by 32 and read
          as a bug rather than as a fix. `overflow-hidden` on the wrapper, since the sentence is
          laid out at full size whatever the box around it is doing. */}
      <AnimatePresence initial={false}>
        {failure && (
          <motion.div {...statusLine} className="overflow-hidden">
            <p role="status" className="px-1 pb-2 text-xs text-destructive">
              Could not read your folders — {failure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <ul className="flex flex-col gap-0.5">
        {/* **The root takes a folder, and only into itself.**
            "All decks" is not a folder — it cannot be picked up, renamed or deleted — but it is
            the one row that means *the top level*, and filing a folder back there is otherwise
            unreachable by this gesture: every other row is a folder, so dragging a folder **out**
            of a drawer would always mean dragging it **into** another one. The pointer needs
            somewhere that is nowhere, and this is it.
            Its two positional landings are refused instead. A line above or below this row would
            promise a place in a level it does not itself sit in — it stands above every top-level
            folder rather than among them — and the position it looks like it offers ("first at
            the top level") is already the first folder's own leading edge, which is the same drop
            spelled once. */}
        <FolderRow
          label={ROOT_LABEL}
          count={totalDecks}
          depth={0}
          selected={selectedId === null}
          Glyph={Layers}
          drag={drag}
          canDrop={(d) => canDropIn(d, null)}
          onDropDeck={(d) => onDropIn(d, null)}
          canDropFolder={(d, at) => canDropFolder(d, null, at)}
          onDropFolder={(d, at) => onDropFolder(d, null, at)}
          onSelect={() => onSelect(null)}
        />

        {flat.map((node) =>
          // Renaming replaces the row rather than opening a field under it: the folder already
          // has a place in the tree, and correcting its name is not a new thing arriving.
          naming?.kind === "rename" && naming.folderId === node.folder.id ? (
            <li key={node.folder.id}>
              <TreeNameField
                depth={node.depth + 1}
                initial={node.folder.name}
                label={`Rename ${node.folder.name}`}
                submitLabel="Rename folder"
                pending={busy}
                onCancel={onCloseNaming}
                onSubmit={onName}
              />
            </li>
          ) : (
            <FolderRow
              key={node.folder.id}
              folder={node.folder}
              label={node.folder.name}
              count={node.count}
              depth={node.depth + 1}
              selected={selectedId === node.folder.id}
              Glyph={selectedId === node.folder.id ? FolderOpen : Folder}
              drag={drag}
              canDrop={(d) => canDropIn(d, node.folder.id)}
              onDropDeck={(d) => onDropIn(d, node.folder.id)}
              canDropFolder={(d, at) => canDropFolder(d, node.folder.id, at)}
              onDropFolder={(d, at) => onDropFolder(d, node.folder.id, at)}
              onSelect={() => onSelect(node.folder.id)}
              onRename={() => onOpenRename(node.folder.id)}
              onNewChild={(opener) => onOpenNew(node.folder.id, opener)}
              addingChild={newAt === node.folder.id}
              menu={rowMenu(node.folder)}
              menuOpenerRef={menuOpenerRef}
            >
              {newAt === node.folder.id && (
                <TreeNameField
                  depth={node.depth + 2}
                  where={`in ${node.folder.name}`}
                  label="New folder name"
                  submitLabel="Create folder"
                  pending={busy}
                  onCancel={onCloseNaming}
                  onSubmit={onName}
                />
              )}
            </FolderRow>
          ),
        )}

        {newAt === null && (
          <li>
            <TreeNameField
              depth={1}
              where="at the top level"
              label="New folder name"
              submitLabel="Create folder"
              pending={busy}
              onCancel={onCloseNaming}
              onSubmit={onName}
            />
          </li>
        )}

        {!pending && !failure && flat.length === 0 && naming === null && (
          <li className="px-1 pt-2 text-[0.7rem] leading-relaxed text-dim">
            Folders file decks the way drawers file paper. Make one, then drag a deck onto it.
          </li>
        )}
      </ul>
    </nav>
  );
}

/**
 * One row of the tree — and one of the two ways a deck is filed.
 *
 * The row's glyph carries its state rather than a second mark doing it: the open folder is the
 * one the wall is showing.
 */
function FolderRow({
  folder,
  label,
  count,
  depth,
  selected,
  Glyph,
  drag,
  canDrop,
  onDropDeck,
  canDropFolder,
  onDropFolder,
  onSelect,
  onRename,
  onNewChild,
  addingChild = false,
  menu,
  menuOpenerRef,
  children,
}: {
  /** Absent on "All decks", which is the tree's root and not a folder — so that row carries no
   *  id, cannot be picked up, and offers no menu. */
  folder?: DeckFolder;
  label: string;
  count: number;
  depth: number;
  selected: boolean;
  Glyph: typeof Folder;
  drag: DeckDrag | null;
  canDrop: (drag: DeckDrag) => boolean;
  onDropDeck: (drag: DeckDrag) => void;
  /** The folder drag's pair, bound to this row already — see
   *  {@link FolderTreeProps.canDropFolder}. */
  canDropFolder: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDropFolder: (drag: FolderDrag, edge: FolderEdge) => void;
  onSelect: () => void;
  /** F2, the file manager's own key. Absent on "All decks". */
  onRename?: () => void;
  /** Absent on "All decks": the header's own control already makes a folder there. */
  onNewChild?: (opener: HTMLButtonElement) => void;
  addingChild?: boolean;
  /** The row's right-click and its keyboard twin. Absent on "All decks", which is not a
   *  folder — there is nothing to rename, move or delete. */
  menu?: FolderRowMenu;
  /** Where this row writes itself as its menu opens — see {@link FolderTreeProps.menuOpenerRef}. */
  menuOpenerRef?: RefObject<HTMLButtonElement | null>;
  /** The create form, when it belongs under this row. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);
  const tip = useTooltip();
  const folderId = folder?.id;
  const over = useDeckDropTarget({ ref, canDrop, onDrop: onDropDeck });
  useFolderDragSource(folderRef, folder ?? null);
  const { armed, edge } = useFolderDropTarget({
    ref: folderRef,
    scope: "deck",
    axis: "vertical",
    canDrop: canDropFolder,
    onDrop: onDropFolder,
  });
  // The ring says "this drawer could take the deck you are holding", the wash says "this is the
  // one it would go into" — `AppShell`'s sidebar vocabulary, because these are the same claim
  // made about the same gesture two panels apart.
  const eligible = drag !== null && canDrop(drag);

  return (
    <li>
      {/* **Two boxes for two drags, and it is the drag library that insists.**
          `dropTargetForElements` keeps **one** registration per element — a second `set` on the
          same key replaces the first in its `WeakMap` and warns in dev — so the deck drop and the
          folder drop cannot share a box however alike they look. Measured here: the row filed a
          deck until the folder target was added and then silently stopped.
          The outer box is the deck's, unchanged. The inner one is the folder's, and it is also
          where the folder is picked up, so one element is the whole of what the folder gesture
          reads and writes. They are the same rectangle — no padding between them — which matters
          because the inner one is *measured*: `folderEdge` divides its box into the three
          landings, and a box that was not the row would put the thresholds somewhere else. */}
      <div
        ref={ref}
        className={cn("group relative rounded-md", eligible && DROP_RING, over && DROP_OVER)}
      >
        {/* **The folder drag borrows the deck's two marks rather than inventing a pair**, and it
            can because only one drag is ever in the air: `armed` is "this row could take the
            folder you are holding" and an `inside` landing is "this is the drawer it would go
            into" — word for word the two claims one box out, about the other payload. What the
            folder drag adds is the third landing, which a deck has no equivalent of: `before` and
            `after` are positions *between* rows rather than a row taking anything, so they are
            drawn as a line and `FolderDropLine` draws nothing for the other two. No mark at all
            means no drop — `edge` is `null` both off this row and over a part of it that would
            refuse.
            `relative` because the line is `absolute` against it; the `+` control below is
            `absolute` too and this box is the same rectangle as the one it used to be positioned
            against, so it does not move. */}
        <div
          ref={folderRef}
          className={cn(
            "relative rounded-md",
            armed && DROP_RING,
            edge === "inside" && DROP_OVER,
          )}
        >
          <FolderDropLine edge={edge} axis="vertical" />
          <button
            type="button"
            // How the page hands the caret back to this row after the rename field that replaced
            // it closes. See {@link FOLDER_ROW_ATTR}.
            {...(folderId === undefined ? {} : { [FOLDER_ROW_ATTR]: folderId })}
            // The count is drawn as a figure and said as a sentence: a bare "2" after a folder's
            // name tells a screen reader nothing about what two of. The visible label is the
            // prefix, which is what WCAG 2.5.3 asks of a control labelled on screen.
            aria-label={`${label}, ${plural(count, "deck")}`}
            aria-current={selected ? "true" : undefined}
            onClick={onSelect}
            // **The row's menu, on the row's own `<button>`** — not on the `<li>` and not on the
            // box in between, and both exclusions are load-bearing.
            //
            // *Focus*: the panel hands the caret back to the element the menu was opened on, and
            // this is the only focusable one here — which is also why it is the element Shift+F10
            // can land on at all.
            //
            // *The field*: a "New folder in …" field is drawn **inside this row's `<li>`**, as a
            // sibling of the box above (see the tree's `children`), so a handler on either of
            // those would answer a right-click inside a text field — and its own
            // `preventDefault()`/`stopPropagation()` would keep the provider's document-level
            // carve-out from ever running, taking cut, copy, paste, undo and the spellcheck
            // suggestions with it. `isTextField` inside the primitive is the fence; this is the
            // element that does not need it. (The *rename* field is a different case again: it
            // replaces the row whole, so there is no row here at all while it is up.)
            //
            // The stash is this handler's own line and `e.currentTarget` is this button, exactly
            // as the deck tile writes its own. It is written even for a press the menu then
            // declines, which is harmless: nothing reads the opener until a menu *row* is chosen,
            // and that can only follow a menu that opened.
            onContextMenu={(e) => {
              if (menuOpenerRef) menuOpenerRef.current = e.currentTarget;
              menu?.onContextMenu(e);
            }}
            // F2 renames the row the caret is on — the file manager's key, and the keyboard's
            // route to a rename whose pointer route is this row's own menu. A shortcut rather than
            // the only way in: nothing here is reachable by this key alone.
            //
            // **Composed with the menu key, never replaced by it.** The two answer different
            // presses, so the order is immaterial and the `defaultPrevented` check is the belt:
            // what matters is that wiring a menu onto this element did not take the rename off it.
            onKeyDown={(e) => {
              if (menuOpenerRef) menuOpenerRef.current = e.currentTarget;
              menu?.onKeyDown(e);
              if (e.defaultPrevented) return;
              if (e.key !== "F2" || onRename === undefined) return;
              e.preventDefault();
              onRename();
            }}
            style={indent(depth)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md py-1.5 pr-8 text-left text-sm",
              "transition-colors duration-150 motion-reduce:transition-none",
              selected ? "bg-surface text-text" : "text-dim hover:bg-surface/60 hover:text-text",
              FOCUS,
            )}
          >
            <Glyph
              className={cn("size-3.5 flex-none", selected && "text-accent")}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="flex-none font-mono text-[0.7rem] tabular-nums text-dim">{count}</span>
          </button>

          {onNewChild && (
            <button
              type="button"
              // **The row above it is a drag source now, and Chromium starts a drag from the
              // nearest draggable *ancestor* of whatever was pressed** — so without this mark a
              // press here plus five pixels of travel files the folder somewhere instead of opening
              // the field. `dnd.ts`'s `NOT_A_DRAG` is the selector; the rule it states is that
              // anything inside a draggable which owns its own press marks itself.
              data-no-drag=""
              aria-label={`New folder in ${label}`}
              aria-expanded={addingChild}
              {...tip(`New folder in ${label}`, { describes: false })}
              onClick={(e) => onNewChild(e.currentTarget)}
              className={cn(
                "absolute right-1 top-1 grid size-6 place-items-center rounded-md text-dim",
                "transition-colors duration-150 hover:text-accent motion-reduce:transition-none",
                REVEAL_ON_HOVER,
                FOCUS,
              )}
            >
              <FolderPlus className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {children}
    </li>
  );
}

/**
 * What a folder is called — asked **in the tree**, at the indent the folder has or will have.
 *
 * One field for both jobs. A popup would have had to say where the folder was going in words; a
 * row in the tree at the right depth says it by being there, and the line under it names the
 * parent for a reader who cannot see the indent. A rename needs no such line at all, because
 * the field is standing exactly where the folder was.
 *
 * `metaRows.tsx`'s `RenameField` — the row grammar the deck's two meta dialogs share — decided
 * the two details that matter and they are kept here:
 * the current name arrives **selected**, because the commonest rename replaces the word rather
 * than edits inside it, and Escape's job is left to the page — this field is one of `DecksPage`'s
 * `Panel` union, so the page's single rung already closes it, and a rung of its own would be a
 * second registration for one layer. (That reason used to read "the case `useDismissOnEscape`
 * explicitly does not order", which is no longer true — the hook stacks capture-phase
 * registrations and only the top one acts — and was never the argument: the field has nothing to
 * dismiss that the page is not already dismissing.)
 *
 * What is *not* kept is that field's visible Cancel: at 208px less an indent there is no room
 * for two text buttons beside the input, and this screen's other half-made decisions (the new
 * deck form, the delete question, both move pickers) are all discarded the same two ways —
 * Escape, or looking away.
 */
/*
 * **Named `TreeNameField` rather than `FolderNameField` since 2026-09-03**, and the rename is
 * the whole of what changed here. `components/FolderNameField.tsx` became a shared component
 * that day — the folder *wall's* field, drawn as the tile itself on the collection and the
 * wishlist — and this row's field is a different thing at a different shape: a tree row at a
 * depth, with a `where` line and no visible Cancel. Two unrelated components answering one
 * grep is the confusion the collection and wishlist pages had while they each kept a private
 * copy of the third, so one of the two names had to move, and the shared one has the better
 * claim to the plain one.
 */
function TreeNameField({
  depth,
  where,
  label,
  submitLabel,
  initial = "",
  pending,
  onCancel,
  onSubmit,
}: {
  depth: number;
  /** "in Commander" / "at the top level" — where this folder will land, in words. Absent for a
   *  rename: the field is standing where the folder already is. */
  where?: string;
  /** The input's accessible name — "New folder name", or "Rename Commander". */
  label: string;
  /** The submit control's, which is the only place the two jobs read differently to a mouse. */
  submitLabel: string;
  initial?: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tip = useTooltip();
  const [name, setName] = useState(initial);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    // Both, and in this order. `select()` alone is what a browser makes look sufficient —
    // Chromium focuses an input it selects — but the spec says `select()` only sets the
    // selection, and jsdom implements the spec: the caret never arrives and the reader's first
    // keystroke goes to the page. Measured here as a failing `toHaveFocus`.
    input.focus();
    // On a rename this is the difference between typing a new name and typing into the old
    // one; on an empty field it does nothing at all.
    input.select();
  }, []);

  const trimmed = name.trim();

  return (
    <div
      ref={rootRef}
      style={indent(depth)}
      className="py-1 pr-1"
      // Clicking or tabbing away discards a half-typed name, exactly as every other popup in
      // this app discards its half-made decision — and not while the write is in flight, the
      // guard `NewDeck` needs for the same reason: a control that disables itself on the press
      // is blurred by the browser with no `relatedTarget` at all.
      onBlur={(e) => {
        if (pending) return;
        if (!rootRef.current?.contains(e.relatedTarget)) onCancel();
      }}
    >
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          onSubmit(trimmed);
        }}
      >
        <input
          ref={inputRef}
          aria-label={label}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(
            "h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm",
            "focus:border-accent focus:outline-none",
          )}
        />
        {/* **A `<span>` wrapper, not a no-op.** The button is genuinely `disabled` — a real
            attribute, not `aria-disabled` — while the field is empty or the write is in
            flight, and a real `disabled` control fires no pointer events at all: `tip()` bound
            on the button alone would show nothing for as long as it is out of reach, which is
            exactly when a reader is most likely to be hovering it wondering why. A disabled
            control still lets the hover reach a plain ancestor, so the hint moves one element
            out rather than being dropped. */}
        <span {...tip(submitLabel, { describes: false })}>
          <button
            type="submit"
            aria-label={submitLabel}
            disabled={!trimmed || pending}
            className={cn(
              "grid size-7 flex-none place-items-center rounded-md border border-accent text-accent",
              "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <Check className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      </form>
      {where && <p className="mt-1 text-[0.7rem] text-dim">{where}</p>}
    </div>
  );
}
