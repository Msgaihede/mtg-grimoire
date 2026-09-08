import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronLeft, Folder, FolderOpen, FolderPlus, Layers } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { FolderDropLine } from "@/components/FolderDropLine";
import { ResizeHandle } from "@/components/ResizeHandle";
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
import { statusLine, TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useDeckDropTarget, type DeckDrag } from "./deckDrag";
import type { FolderNode } from "./folders";

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
 *
 * **The nesting is _drawn_ now, and that sentence above is untouched by it.** The indent used to
 * be the whole of it, and three levels in a reader was measuring whitespace to tell a child from
 * its parent's next sibling — the one thing an indent alone cannot say is where a run of rows
 * *ends*. So each row carries a gutter of hairlines beside its button: a trunk down every
 * ancestor level that still has siblings below this row, the row's own trunk, and a tick from
 * that trunk into the row's glyph. **That is disclosure's picture without disclosure's
 * mechanism**: there is still no twisty, nothing to collapse, and no branch a deck can be hidden
 * in. The guides say where a row sits; they never say a branch could be shut.
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
 * The width the tree is drawn at on a database nobody has dragged, in px — today's `w-52`.
 *
 * The number is unchanged and the *kind* of number it is has changed: it was a Tailwind class on
 * the `<nav>`, so it was the tree's width full stop, and it is now the seed the reader's own
 * width starts from. What that means for a reader who never touches the edge is nothing at all,
 * which is the point — 208 is the column this screen shipped with and was laid out against, so a
 * default of anything else would move a wall nobody asked to move.
 *
 * **A pixel default rather than a share of the window**, which is `DEFAULT_PANEL_WIDTH_PX`'s rule
 * one column over: on a 2560px monitor a proportional default is a 400px filing cabinet nobody
 * asked for, and what a wider window should buy is room to *drag* rather than a wider tree.
 */
export const DEFAULT_FOLDER_TREE_WIDTH_PX = 208;

/**
 * The narrowest the tree may be dragged, in px.
 *
 * **Counted off the markup rather than chosen**, and off the two rows that have to survive it.
 * A top-level folder row is a 26px guide gutter (`GUIDE_STEP · 1 + GUIDE_TICK`), the button's own
 * `pl-2` (8), its 16px glyph, the `gap-2` either side of the name (8 + 8), a two-digit count
 * (~14 at `text-[0.7rem]` tabular mono) and the `pr-8` (32) the row's `+` control is absolutely
 * positioned inside — **112px that cannot shrink** — over the nav's own `pr-3` and its hairline,
 * which is **125**. The heading row above it is a second sum on the same width: a 28px chevron, a
 * 24px `New folder`, a `gap-2` either side of the word and the same `px-1`, `pr-3` and hairline,
 * which is **89**.
 *
 * So 160 leaves a folder's truncating name **35px** and the word `Folders` **71**, which is the
 * narrowest either of them says anything at. Below it the name is the ellipsis alone and the
 * gutter, the glyph and the count are the whole of the row — a filing cabinet whose drawers have
 * no labels on them.
 *
 * It is the floor a *drag* is clamped to and the width a page decides there is no room for the
 * tree at all by, exactly as `MIN_PANEL_WIDTH_PX` is for the docked search columns: below it the
 * tree rails rather than being squeezed, and the width the reader had dragged to is still here
 * when the room comes back.
 */
export const MIN_FOLDER_TREE_WIDTH_PX = 160;

/**
 * Why the disclosure will not open, said where it is refused.
 *
 * `CardSearchPanel`'s `NO_ROOM` with this page's own remedies in it, and the difference is the
 * point rather than drift: there is no card pane on this screen to close, and the row's floor is
 * **one deck tile at the reader's own zoom** — so zooming the wall out really does buy the tree
 * its width back, and it is the remedy a reader is least likely to think of.
 */
const NO_ROOM = "Not enough room — zoom the decks out or widen the window";

/**
 * How a test finds one hairline of the nesting, and which piece of the drawing it found.
 *
 * Every mark in here is `aria-hidden` and has no role, no name and no text — the shape of the
 * tree is something a screen reader already hears, as the order of the rows and the counts on
 * them, and narrating a trunk would be describing a picture to a reader who is not looking at
 * one. So nothing about a guide is reachable through the accessibility tree. Its **offsets are
 * inline styles** (they are computed, and Tailwind emits nothing for an interpolated class) and
 * its colour is a class, and jsdom applies no stylesheet — so a class assertion would be a check
 * on source text rather than on the drawing. An attribute is the only honest handle, in the shape
 * {@link FOLDER_ROW_ATTR} above, `DeckColorBar`'s `DECK_COLOR_SEGMENT_ATTR` and
 * `FolderDropLine`'s `FOLDER_DROP_LINE_ATTR` already use.
 *
 * **It carries which piece as its value**, for `DECK_COLOR_SEGMENT_ATTR`'s reason: a row draws up
 * to four of these and they are not interchangeable, so a handle that could only be counted would
 * be satisfied by an ancestor's trunk standing where the row's own belongs. Five values —
 * `gutter` (the box the guides live in, and the whole of the row's indent), `ancestor` (one per
 * ancestor level that still has siblings below this row), `trunk` (this row's own level), `tick`
 * (the hairline from that trunk into the row's glyph) and `root` (the line under "All decks" that
 * every top-level folder descends from).
 *
 * **The selected row's rail is on this same handle, as `rail`**, though it says nothing about
 * nesting. It is the same kind of thing — an `aria-hidden` mark that is nothing but a position
 * and a colour, over a row whose currency is already spelled in `aria-current` — so a second
 * constant would be a second name for one question: what did this row draw that the
 * accessibility tree cannot see.
 */
export const FOLDER_GUIDE_ATTR = "data-folder-guide";

/**
 * The step the guides are drawn on, and the room the tick needs to the right of a trunk.
 *
 * **16 rather than `folderTree.ts`'s 14, and the two deliberately no longer share a number.**
 * `folderTree.ts`'s `indent()` is still 14, still exported and still `MoveToFolder`'s — that one
 * is a *picker*, a flat list of destinations with no guides in it, so its step is free to be what
 * reads well. A step that draws hairlines is not: the row's glyph is 16px wide at 8px of padding,
 * so a trunk for level L wants to be centred on `x = 16·L` — drawn at `16·L − 0.5`, which is where
 * a 1px line starts if its middle is to land there — and at L = 1 that is exactly the centre of
 * the "All decks" row's own glyph, which is the line every top-level folder hangs from. Pulling
 * the tree back to 14 would put every trunk half a glyph off the row above it; pushing the picker
 * out to 16 would move a list that gets nothing for it.
 */
const GUIDE_STEP = 16;
const GUIDE_TICK = 10;

/**
 * Where a row's content starts, as an inline style — the offset the button already sits at with
 * its gutter in front of it, so a "New folder in …" field lines up with the rows around it.
 *
 * An inline style for the reason `indent()` is one, unchanged: Tailwind v4 scans source text for
 * whole class names, so a `pl-[${n}px]` built by interpolation emits no rule at all.
 *
 * Deliberately **not** `indent(depth)` any more. A field that stood two pixels out of the column
 * it is being typed into is exactly the kind of drift the guides were added to make visible, and
 * the two functions answer different questions now — see {@link GUIDE_STEP}.
 */
function treeIndent(depth: number) {
  return { paddingLeft: GUIDE_STEP * depth + GUIDE_TICK };
}

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
  /**
   * How wide to draw the column when it is open, in px — the reader's own answer, held by the
   * page (`useFolderPane`) rather than here.
   *
   * Hoisted for `CardSearchPanel`'s reason read from the other end: this component is drawn
   * once, so it *could* hold the number — but the number outlives the tree (it is remembered
   * across sessions) and a component that owned a persisted width would be a component that had
   * to know about storage. The page owns both halves of the pair and hands them down.
   */
  width: number;
  /**
   * What the **reader** pressed, and never what is drawn.
   *
   * A narrow window is a measurement, not a press — see {@link roomy} — so a railing must never
   * write back through {@link onCollapse}. Fold the two together and the first reader who
   * narrows their window loses the tree permanently: the measurement records itself as a choice
   * and widening the window back gives nothing.
   */
  collapsed: boolean;
  /** The widest the tree may be dragged, in px — the page's measurement, because the page is what
   *  holds the row the tree and the wall share. */
  maxWidth: number;
  /**
   * Whether the row has room to draw the tree open — measured, not guessed.
   *
   * `false` draws the rail whatever {@link collapsed} says, and the chevron goes with it:
   * `aria-disabled` with the reason in a tooltip, which is the docked search columns' refusal
   * word for word. **It decides what is _drawn_ and never what the reader chose**, which is the
   * whole of why it is a prop of its own.
   *
   * Absent is `true`: a story or a test that says nothing about width gets the tree it has always
   * drawn, and an unmeasured row is not a narrow one.
   */
  roomy?: boolean;
  onResize: (width: number) => void;
  onCollapse: (collapsed: boolean) => void;
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
  /** F2 on a row. There is no trigger *on* the row: a column 208px wide by default — and as
   *  narrow as {@link MIN_FOLDER_TREE_WIDTH_PX} by the reader's own drag — with an indent, a
   *  glyph, a name, a count and a "new folder" control has no width left for a second one, so
   *  the pointer's route is the wall's own "Rename folder" and this is the keyboard's. */
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
 * One row of the tree as the guides need it — the folder, and the two facts about its *position*
 * that a flat list of nodes cannot carry.
 */
interface DrawnFolder {
  node: FolderNode;
  /** Whether this folder is the last of its own siblings. It is what stops the row's trunk at
   *  the elbow instead of running past the last child of a branch into nothing. */
  last: boolean;
  /**
   * For each ancestor level, whether that ancestor still has siblings **after** it — which is
   * whether a trunk carries on down past this row at that level, or the branch is finished and
   * the column is blank.
   *
   * 0-based and one short of the row's own depth: `trail[0]` is the top-level ancestor, which is
   * level 1, so `trail.length === depth - 1` and a top-level folder's own trail is empty.
   */
  trail: readonly boolean[];
}

/**
 * The tree in draw order, each row carrying what its gutter has to know.
 *
 * **Module-local rather than a widening of `flattenFolders`, deliberately.** That walker lives in
 * `lib/folderTree.ts` and is read by the wishlist's tree, the collection's cabinet and
 * `MoveToFolder` as well as by this file — and not one of those draws a guide. Growing
 * `FolderNode`, or the flattener's answer, for two facts that only this drawing uses is a change
 * four surfaces pay for and one benefits from. What is not given up is the *order*: this is the
 * same depth-first, parents-before-children walk `flattenFolders` answers, which is what let the
 * call be replaced rather than joined.
 *
 * `nodes` is one **level**, so "is this the last of its siblings" is `i === nodes.length - 1` and
 * needs no lookup at all; the trail grows by exactly that answer, negated, as the walk descends.
 */
function drawOrder(nodes: readonly FolderNode[], trail: readonly boolean[] = []): DrawnFolder[] {
  return nodes.flatMap((node, i) => {
    const last = i === nodes.length - 1;
    return [{ node, last, trail }, ...drawOrder(node.children, [...trail, !last])];
  });
}

/**
 * The sidebar: every folder there is, indented, each row saying what is in it — and every row
 * a place a deck can be dropped.
 */
export function FolderTree({
  width,
  collapsed,
  maxWidth,
  roomy = true,
  onResize,
  onCollapse,
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
  const rows = drawOrder(nodes);
  /** Where a "new folder" field is open, or `undefined` when the open field is a rename. */
  const newAt = naming?.kind === "new" ? naming.parentId : undefined;
  const treeId = useId();
  /**
   * Whether the tree is **drawn** — the reader's press, unless the row has no room for it.
   *
   * The two facts are kept apart all the way down: `collapsed` is what the reader chose and is
   * what the chevron's own name is about, `roomy` is a measurement of the row, and this is the
   * one place they meet. Nothing derived from here may ever be written back through
   * {@link FolderTreeProps.onCollapse}.
   */
  const open = !collapsed && roomy;

  /**
   * What is actually **drawn**: the reader's width inside the page's cap, and never below the one
   * a row is measured from.
   *
   * **The clamp split, which is the docked search columns' rule and may not be re-decided here.**
   * A narrowing window, a wall of tiles that will not give any more — each of those caps what can
   * be drawn without being a thing the reader asked for, so none of them may overwrite what they
   * did ask for. Let the environment write back through {@link FolderTreeProps.onResize} instead
   * and a momentary squeeze is permanent: widen the window again and the tree stays where the
   * narrow moment left it. A *drag* does write clamped, because there the bound is the edge the
   * reader is pushing against rather than something that happened to the window while they were
   * not looking.
   *
   * The `max` around the cap matters at exactly one moment — a row too narrow for the minimum,
   * where `roomy` is already false and this column is 36px of rail whose width nothing reads.
   */
  const floor = Math.max(maxWidth, MIN_FOLDER_TREE_WIDTH_PX);
  const drawnWidth = Math.min(Math.max(width, MIN_FOLDER_TREE_WIDTH_PX), floor);

  /**
   * The disclosure, in both of its states — one control, one element, and `aria-expanded` for
   * the difference.
   *
   * Refused, with the reason, in the one state where pressing it could not work: the row cannot
   * hold the tree and a deck tile side by side, so the press would be recorded and nothing would
   * move. `aria-disabled` and a press that does nothing, **not** `disabled` — a disabled button
   * leaves the tab order, which would hang the reason on a hover a keyboard reader cannot
   * perform. It is the docked search columns' arrangement, and it is deliberately the same one:
   * a reader who has learnt the rail on the right of the deck editor has learnt this.
   */
  const toggle = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={treeId}
      aria-disabled={!roomy || undefined}
      // **It names the result, not the state** — `aria-expanded` above already says which way
      // round it is, and a reader who has just heard "collapsed" wants to know what pressing it
      // will do about that.
      //
      // **Read off what is _drawn_ and deliberately not off the reader's stored answer**, which
      // is `CardSearchPanel`'s wiring character for character (`shown` feeds both its
      // `aria-expanded` and its label). The two agree everywhere except the one state where the
      // room has been taken away from a tree the reader left open — and there, naming the press
      // announces "Collapse folders, collapsed", a control that contradicts the state word it is
      // sitting next to. Naming the drawing says "Expand folders, collapsed", which is coherent
      // with what is on screen; that the press is then refused is what `aria-disabled` and the
      // tooltip are for, and they are the two things a reader meets before pressing anything.
      aria-label={open ? "Collapse folders" : "Expand folders"}
      {...tip(roomy ? null : NO_ROOM)}
      onClick={() => roomy && onCollapse(!collapsed)}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-dim",
        "transition-colors duration-150 motion-reduce:transition-none",
        roomy ? "hover:text-text" : "cursor-not-allowed opacity-60",
        // Railed, the button is centred in the rail's own content box rather than sitting 28px
        // wide at the start of a 35px column — the hairline comes out of the 36px, so a bare
        // `size-7` would be 3px off the centre line the vertical heading below it is on.
        open || "w-full",
        FOCUS,
      )}
    >
      {/* **The chevron points where the tree is going**, which is what makes it readable without
          words: left when the tree is open, because pressing it slides this column away to the
          left edge it is docked against, and right when it is a rail, because pressing it brings
          the column back out. That is the mirror image of the docked search column's, which is
          docked against the *right* edge — same rule, opposite page.

          **One icon turned over, never `ChevronRight` swapped in for `ChevronLeft`.** A different
          element in the same slot is unmounted and remounted, so the indicator *teleports*, and
          the whole of what the press means is that the direction reversed. Half a turn is that
          fact, drawn.

          `initial={false}`, so a tree that mounts already railed draws its chevron turned rather
          than spinning it on first paint. `flex` on the span is load-bearing and not decoration:
          a bare `<span>` is a non-replaced inline box, a transform does not apply to one at all,
          and the rotation would silently do nothing. */}
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ rotate: open ? 0 : 180 }}
        transition={TRANSITION.fast}
        className="flex"
      >
        <ChevronLeft className="size-4" />
      </motion.span>
    </button>
  );

  return (
    // **The `<nav>` is the positioned, non-scrolling container now, and the scroller is one box
    // in.** The resize handle is `absolute inset-y-0` against this element, and an absolutely
    // positioned child of a scroller scrolls away with the content and is clipped at the padding
    // box — so a grab strip down the tree's edge would slide up the page as the reader scrolled
    // their folders. Moving the `overflow-y-auto` inward fixes that and takes the heading row and
    // its `New folder` button out of the scroll as a side effect, which is an improvement: the
    // one control that makes a folder no longer disappears above a long cabinet.
    //
    // **The hairline is drawn in both states**, exactly as the docked search column's is: the
    // rail and the tree are one edge, so a collapse changes what is *in* this column and not what
    // it is. `box-sizing` is `border-box`, so `w-9` stays 36px and the line comes out of the rail
    // rather than out of the wall beside it.
    //
    // The width is an inline style rather than a class for Tailwind's own reason — it scans
    // source text for whole class names, so a `w-[${width}px]` emits no rule at all.
    <nav
      id={treeId}
      aria-label="Folders"
      className={cn(
        "relative flex min-h-0 flex-none flex-col border-r border-border",
        open ? "pr-3" : "w-9",
      )}
      style={open ? { width: drawnWidth } : undefined}
    >
      {open && (
        <ResizeHandle
          controls={treeId}
          label="folders"
          width={drawnWidth}
          min={MIN_FOLDER_TREE_WIDTH_PX}
          max={floor}
          // Docked against the row's left edge, so the strip is over this column's *right*
          // hairline and Right is the key that widens it.
          side="left"
          // The drag's own clamp: a gesture cannot ask for a width the page has already refused,
          // where a *window* that refuses one may not write back at all — see {@link drawnWidth}.
          onResize={(next) => onResize(Math.min(Math.max(next, MIN_FOLDER_TREE_WIDTH_PX), floor))}
        />
      )}
      {/* **The heading row, and railed it _is_ the whole nav.** It takes the height then and lets
          the rail stretch down it — a 36px strip reads as an edge, an 80px one reads as a stray
          button — with the word turned on its side so 36px of chrome still says what this column
          is rather than leaving a bare chevron to be guessed at.

          `self-center` is what centres the heading down the rail and `text-center` is not: in
          `vertical-rl` the *block* axis runs right to left, so `text-align` moves the words up and
          down against a box whose height is their own content. Stretched by the row's
          `items-stretch` the word's centre would sit right of the chevron's in a 36px column.

          `select-none` in that state alone: there the word *is* the rail, so a pointer dragged
          down the shut column with the button held selects the whole of what the tree has left on
          screen. Open it is an ordinary heading over a list and there is nothing to protect it
          from. */}
      <div
        className={cn(
          "flex gap-2",
          open ? "shrink-0 items-center px-1 pb-2" : "min-h-0 flex-1 flex-col items-stretch",
        )}
      >
        {toggle}
        <h2
          className={cn(
            "font-heading text-lg leading-none",
            open ? "min-w-0 flex-1 truncate" : "select-none self-center",
          )}
          style={open ? undefined : { writingMode: "vertical-rl" }}
        >
          Folders
        </h2>
        {open && (
          <button
            type="button"
            aria-label="New folder at the top level"
            aria-expanded={newAt === null}
            {...tip("New folder", { describes: false })}
            onClick={(e) => onOpenNew(null, e.currentTarget)}
            className={cn(
              "grid size-6 flex-none place-items-center rounded-md border border-border text-dim",
              "transition-colors duration-150 hover:border-accent hover:text-accent",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <FolderPlus className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Everything below the heading row, and only while there is room to draw it.

          **The rows are gone at 36px, so a deck cannot be dragged _into the tree_ while it is
          railed** — and nothing here tries to buy that back. Filing still works two other ways
          the reader can see: the wall's own folder cards take a deck dropped on them, and the
          tile's row menu carries `Move to folder…`. A hover-to-expand-mid-drag would be a
          mechanism — and a mode, and a timer — for a gesture the wall already serves at full
          size. */}
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto">
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
              trunkBelow={rows.length > 0}
            />

            {rows.map(({ node, last, trail }) =>
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
                  last={last}
                  trail={trail}
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

            {!pending && !failure && rows.length === 0 && naming === null && (
              <li className="px-1 pt-2 text-[0.7rem] leading-relaxed text-dim">
                Folders file decks the way drawers file paper. Make one, then drag a deck onto it.
              </li>
            )}
          </ul>
        </div>
      )}
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
  last = false,
  trail = [],
  trunkBelow = false,
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
  /** 0 for "All decks" and `node.depth + 1` for a folder, so the guide arithmetic reads a
   *  top-level folder as level 1 — see {@link GUIDE_STEP}. */
  depth: number;
  /** {@link DrawnFolder.last}. Absent on "All decks", which draws no gutter and has no siblings
   *  to be the last of. */
  last?: boolean;
  /** {@link DrawnFolder.trail} — which ancestor levels still have a branch running past this
   *  row. Absent on "All decks" for the same reason. */
  trail?: readonly boolean[];
  /**
   * The line every top-level folder hangs from, drawn in **this** row's `<li>`.
   *
   * Only "All decks" passes it, and only when there is a folder under it. That row has no gutter
   * of its own — it is not in the tree, it *is* the top — so the level-1 trunk has nowhere else
   * to start from, and a line drawn under an empty cabinet would promise a branch the tree does
   * not have.
   */
  trunkBelow?: boolean;
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
    <li className={trunkBelow ? "relative" : undefined}>
      {/* **The root's own trunk, drawn in its `<li>` because the row itself has no gutter.**
          "All decks" is the top rather than a row of the tree, so it is not indented and has
          nowhere to draw a guide beside itself — but every top-level folder's trunk has to come
          from somewhere, and this is it. It starts at `50% + 12px`, which is the row's midline
          plus half a 16px glyph and 4px of air, so the line begins just under the glyph rather
          than out of the middle of it, and it runs 2px past the row to meet the first folder's
          own overhang (see {@link FolderGuides} for why the overhangs exist). */}
      {trunkBelow && (
        <span
          aria-hidden="true"
          {...{ [FOLDER_GUIDE_ATTR]: "root" }}
          className="absolute bottom-[-2px] left-[15.5px] top-[calc(50%+12px)] w-px bg-border"
        />
      )}
      {/* **Two boxes for two drags, and it is the drag library that insists.**
          `dropTargetForElements` keeps **one** registration per element — a second `set` on the
          same key replaces the first in its `WeakMap` and warns in dev — so the deck drop and the
          folder drop cannot share a box however alike they look. Measured here: the row filed a
          deck until the folder target was added and then silently stopped.
          The outer box is the deck's, unchanged. The inner one is the folder's, and it is also
          where the folder is picked up, so one element is the whole of what the folder gesture
          reads and writes. They are the same rectangle — no padding between them — which matters
          because the inner one is *measured*: `folderEdge` divides its box into the three
          landings, and a box that was not the row would put the thresholds somewhere else.
          **The gutter went _inside_ the measured box rather than in front of it**, and that is
          what keeps the sentence above true: the flex row is the inner box itself, so both
          registrations still span the whole row and are still the same rectangle they always
          were. Wrapping the pair in a flex box *outside* `folderRef` would have narrowed the
          folder's own box to the button — the row's leading 26–58px would stop being part of the
          target a folder is let go on, and would stop being part of the thing a folder is picked
          up by. Nothing about `folderEdge`'s thresholds moves either way: `axis="vertical"`
          divides the box by **height**, and a `flex-none` gutter of absolutely positioned
          hairlines adds none. */}
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
            "relative flex rounded-md",
            armed && DROP_RING,
            edge === "inside" && DROP_OVER,
          )}
        >
          <FolderDropLine edge={edge} axis="vertical" />
          {/* **The guides live beside the button and never under it**, which is the whole reason
              this row is a flex of two things rather than a button with a bigger indent. The
              button's own fill is what a hover and a selection paint, and it starts where the
              gutter ends — so a hairline can never end up under a wash, and the focus ring the
              button draws stands clear of the tree's own lines. The root draws none: it has no
              level to be at. */}
          {depth > 0 && <FolderGuides depth={depth} last={last} trail={trail} />}
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
            // **No indent at all any more** — a constant 8px of padding, and the gutter beside it
            // is the whole of the nesting. `relative` for the rail below, which is `absolute`
            // against this box; `min-w-0 flex-1` where this used to be `w-full`, because it is a
            // flex item now and a percentage width beside a gutter overflows the row.
            className={cn(
              "relative flex min-w-0 flex-1 items-center gap-2 rounded-md py-2.5 pl-2 pr-8",
              "text-left text-sm",
              "transition-colors duration-150 motion-reduce:transition-none",
              selected ? "bg-surface text-text" : "text-dim hover:bg-surface/60 hover:text-text",
              FOCUS,
            )}
          >
            {/* **The rail down the leading edge of the row the wall is showing.** The fill and
                `aria-current` already say a row is current, and neither is *findable*: a fill of
                that weight is what a hover paints too, so in a rail of twenty rows the reader
                has to read the names to find where they are. Two pixels of accent at the edge is
                the one mark on this row that only the selected row wears — the same accent the
                open-folder glyph beside it already uses, so it is not a new colour with a new
                meaning to learn. Inside the button rather than on the box around it, so it sits
                within the fill it belongs to and can never be drawn over a guide. */}
            {selected && (
              <span
                aria-hidden="true"
                {...{ [FOLDER_GUIDE_ATTR]: "rail" }}
                className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent"
              />
            )}
            <Glyph
              className={cn("size-4 flex-none", selected && "text-accent")}
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
              // `top-2` follows the row's own padding rather than being a number of its own: a
              // 24px control in a 32px row (`py-1.5` around a 20px line) was centred at `top-1`,
              // and the row is 40px now (`py-2.5`), so the same centring is 8px. It is one
              // arithmetic, written twice — if the row's padding moves again, this moves with it.
              className={cn(
                "absolute right-1 top-2 grid size-6 place-items-center rounded-md text-dim",
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
 * The hairlines that draw the nesting — one row's worth, in a box of its own beside the button.
 *
 * The arithmetic, with {@link GUIDE_STEP} at 16 and the row's glyph 16px wide at 8px of padding:
 * a trunk for level L is centred on `x = 16·L`, so a 1px line is drawn at `16·L − 0.5`, and the
 * box is `16·depth + 10` wide — the last trunk plus {@link GUIDE_TICK}, which is the run the tick
 * needs before the button starts.
 *
 * **The 2px overhangs at each end are what make a trunk read as one line.** The list is
 * `gap-0.5`, so consecutive rows stand 2px apart, and a guide drawn to its own row's edges would
 * stop and restart at every row — a dashed line down the tree, which says something the tree does
 * not mean. Each vertical therefore overhangs by exactly that gap at both ends and meets its
 * neighbour's.
 *
 * **A last child's own trunk stops at the elbow**, `bottom: 50%`, which is where the tick meets
 * it: below it there is nothing at this level for a line to lead to, and a trunk running on past
 * the last child of a branch promises a sibling that is not there. Every other row's runs
 * through. This is the one number in here that is easy to write backwards — hence the first case
 * in `FolderTree.test.tsx`.
 *
 * **An ancestor contributes a vertical only where it still has siblings after it.** That is what
 * `trail` carries and it is the whole of what an indent could never say: two rows at the same
 * depth look identical, and the difference between them is whether the branch above continues.
 *
 * Every offset is an inline style rather than a class, for `folderTree.ts`'s `indent()`'s reason
 * — Tailwind v4 scans source text for whole class names, so a `left-[${n}px]` built from `depth`
 * emits no rule at all and the guides would simply never be drawn. The colour is a class, because
 * a colour in this app is a `--color-*` token and nothing here invents one.
 */
function FolderGuides({
  depth,
  last,
  trail,
}: {
  depth: number;
  last: boolean;
  trail: readonly boolean[];
}) {
  return (
    <span
      aria-hidden="true"
      {...{ [FOLDER_GUIDE_ATTR]: "gutter" }}
      className="relative flex-none"
      style={{ width: GUIDE_STEP * depth + GUIDE_TICK }}
    >
      {trail.map((more, level) =>
        more ? (
          <span
            key={level}
            {...{ [FOLDER_GUIDE_ATTR]: "ancestor" }}
            className="absolute w-px bg-border"
            style={{ left: GUIDE_STEP * (level + 1) - 0.5, top: -2, bottom: -2 }}
          />
        ) : null,
      )}
      <span
        {...{ [FOLDER_GUIDE_ATTR]: "trunk" }}
        className="absolute w-px bg-border"
        style={{ left: GUIDE_STEP * depth - 0.5, top: -2, bottom: last ? "50%" : -2 }}
      />
      <span
        {...{ [FOLDER_GUIDE_ATTR]: "tick" }}
        className="absolute h-px bg-border"
        style={{ top: "50%", left: GUIDE_STEP * depth + 0.5, right: 0 }}
      />
    </span>
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
 * What is *not* kept is that field's visible Cancel: at the tree's default 208px less an indent
 * there is no room for two text buttons beside the input, and less again wherever the reader has
 * pulled the edge in, and this screen's other half-made decisions (the new
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
      // {@link treeIndent} rather than `indent()`: the field stands in the column the rows around
      // it stand in, and since the guides landed those are two different numbers.
      style={treeIndent(depth)}
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
