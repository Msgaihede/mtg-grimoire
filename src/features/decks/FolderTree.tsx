import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Check, Folder, FolderOpen, FolderPlus, Layers } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import type { DeckFolder } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import { NOT_A_DRAG } from "./dnd";

/**
 * The filing cabinet: the tree the deck gallery is read through, and the gesture that files a
 * deck into one of its drawers.
 *
 * **Flat rows, indented — no twisty.** `deck_folders` has no notion of depth and a reader has
 * tens of folders at most, so every folder is always on screen and the indent is the whole of
 * the nesting. A collapsed branch would be somewhere a deck could hide with no number pointing
 * at it, which is the one thing a filing cabinet must never do.
 */

/** Pixels of indent per level of nesting, and the padding the root sits at. */
const INDENT_STEP = 14;
const INDENT_BASE = 8;

/** One derivation of every plural on this screen, so a count and the sentence quoting it can
 *  never disagree about whether it is "deck" or "decks". */
export function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * The indent, as an **inline style**.
 *
 * Tailwind v4 scans source text for whole class names, so `pl-[${n}px]` built by
 * interpolation emits no rule at all — `VirtualTable`'s column template is an inline style
 * for exactly this reason, and a tree's indent is the same shape of problem.
 */
function indent(depth: number) {
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

/**
 * A deck in the air, and the mark that says so.
 *
 * **A different mark from `dnd.ts`'s, deliberately, and it shares that module's key.** A deck
 * is not a card, and the two must be told apart in both directions: `readDragData` refuses
 * anything whose `dragSource` is not the card mark, so a deck dragged over a category column or
 * over the sidebar's Decks entry lights nothing up and writes nothing; and `readDeckDrag`
 * refuses a card for the same reason. Sharing the key is what makes each fence answer the
 * other's payload rather than ignoring it.
 */
const DECK_MARK = "mtg-grimoire/deck-file-drag";
const MARK_KEY = "dragSource";

/** What a deck drag carries: the deck, and its name for whatever wants to say what moved. */
export interface DeckDrag {
  deckId: number;
  name: string;
}

/** What a deck tile hands the adapter. Flat, so `canDrop` reads it without unwrapping. */
export function deckDragData(drag: DeckDrag): Record<string, unknown> {
  return { [MARK_KEY]: DECK_MARK, ...drag };
}

/**
 * The payload a folder may act on, or `null` for everything else.
 *
 * Field by field rather than a cast — `dnd.ts`'s rule, for its reason: this is the app's
 * boundary with an untyped store every draggable in the window writes into.
 */
export function readDeckDrag(data: Record<string, unknown>): DeckDrag | null {
  if (data[MARK_KEY] !== DECK_MARK) return null;
  const { deckId, name } = data;
  if (typeof deckId !== "number" || !Number.isSafeInteger(deckId) || deckId <= 0) return null;
  if (typeof name !== "string") return null;
  return { deckId, name };
}

/**
 * A deck tile that can be picked up, and a press on one of its controls that is a press on the
 * control.
 *
 * `cardDraggable`'s arrangement rather than `cardDraggable` itself: the payload is a deck and
 * the mark has to differ (see {@link DECK_MARK}), so what is shared is {@link NOT_A_DRAG} and
 * the reasoning. Chromium starts a drag from the nearest draggable *ancestor* of whatever was
 * pressed and the library adds no exclusion, so without the capture-phase `mousedown` a press
 * on Delete plus five pixels of travel is a drag of the whole tile and the click never lands.
 */
export function deckDraggable({
  element,
  payload,
}: {
  element: HTMLElement;
  /** Read at `dragstart`, so a tile renamed since it mounted carries what it is now. */
  payload: () => DeckDrag;
}): () => void {
  let onControl = false;
  const press = (event: Event) => {
    const target = event.target;
    onControl = target instanceof Element && target.closest(NOT_A_DRAG) !== null;
  };
  element.addEventListener("mousedown", press, true);
  const stop = draggable({
    element,
    canDrag: () => !onControl,
    getInitialData: () => deckDragData(payload()),
  });
  return () => {
    element.removeEventListener("mousedown", press, true);
    stop();
  };
}

/**
 * The deck in the air, or `null` — what raises the ring on every folder that could take it.
 *
 * The deck rather than a bare "something is being dragged", because a folder the deck is
 * already in cannot take it: a boolean would light every drawer up and then refuse the one the
 * reader aimed at. A card drag raises nothing here at all, and this is where that is decided.
 */
export function useDeckDragging(): DeckDrag | null {
  const [drag, setDrag] = useState<DeckDrag | null>(null);
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => readDeckDrag(source.data) !== null,
        onDragStart: ({ source }) => setDrag(readDeckDrag(source.data)),
        // Fires for a cancelled drag as well as a completed one — the platform ends both the
        // same way — so the rings stand down on Escape without this hearing a keypress.
        onDrop: () => setDrag(null),
      }),
    [],
  );
  return drag;
}

/**
 * One place a deck can be let go: a folder row, or a folder card on the wall.
 *
 * `canDrop` and `onDrop` are read through a ref rather than through the effect's deps, so a
 * target does not tear itself down and re-register every time the deck list changes under it —
 * `AppShell`'s sidebar entries do the same, for the same reason.
 */
export function useDeckDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drag: DeckDrag) => boolean;
  onDrop: (drag: DeckDrag) => void;
}): boolean {
  const [over, setOver] = useState(false);
  const latest = useRef({ canDrop, onDrop });
  useEffect(() => {
    latest.current = { canDrop, onDrop };
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const drag = readDeckDrag(source.data);
        return drag !== null && latest.current.canDrop(drag);
      },
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        const drag = readDeckDrag(source.data);
        // Asked again on the drop itself: `canDrop` and this can be a second apart, and only
        // this one writes.
        if (drag !== null && latest.current.canDrop(drag)) latest.current.onDrop(drag);
      },
    });
  }, [ref]);

  return over;
}

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
  naming,
  onOpenNew,
  onOpenRename,
  onCloseNaming,
  onName,
  busy,
  failure,
  pending,
}: FolderTreeProps) {
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
          title="New folder"
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
        <FolderRow
          label="All decks"
          count={totalDecks}
          depth={0}
          selected={selectedId === null}
          Glyph={Layers}
          drag={drag}
          canDrop={(d) => canDropIn(d, null)}
          onDropDeck={(d) => onDropIn(d, null)}
          onSelect={() => onSelect(null)}
        />

        {flat.map((node) =>
          // Renaming replaces the row rather than opening a field under it: the folder already
          // has a place in the tree, and correcting its name is not a new thing arriving.
          naming?.kind === "rename" && naming.folderId === node.folder.id ? (
            <li key={node.folder.id}>
              <FolderNameField
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
              folderId={node.folder.id}
              label={node.folder.name}
              count={node.deckCount}
              depth={node.depth + 1}
              selected={selectedId === node.folder.id}
              Glyph={selectedId === node.folder.id ? FolderOpen : Folder}
              drag={drag}
              canDrop={(d) => canDropIn(d, node.folder.id)}
              onDropDeck={(d) => onDropIn(d, node.folder.id)}
              onSelect={() => onSelect(node.folder.id)}
              onRename={() => onOpenRename(node.folder.id)}
              onNewChild={(opener) => onOpenNew(node.folder.id, opener)}
              addingChild={newAt === node.folder.id}
            >
              {newAt === node.folder.id && (
                <FolderNameField
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
            <FolderNameField
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
  folderId,
  label,
  count,
  depth,
  selected,
  Glyph,
  drag,
  canDrop,
  onDropDeck,
  onSelect,
  onRename,
  onNewChild,
  addingChild = false,
  children,
}: {
  /** Absent on "All decks", which is the tree's root and not a folder. */
  folderId?: number;
  label: string;
  count: number;
  depth: number;
  selected: boolean;
  Glyph: typeof Folder;
  drag: DeckDrag | null;
  canDrop: (drag: DeckDrag) => boolean;
  onDropDeck: (drag: DeckDrag) => void;
  onSelect: () => void;
  /** F2, the file manager's own key. Absent on "All decks". */
  onRename?: () => void;
  /** Absent on "All decks": the header's own control already makes a folder there. */
  onNewChild?: (opener: HTMLButtonElement) => void;
  addingChild?: boolean;
  /** The create form, when it belongs under this row. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const over = useDeckDropTarget({ ref, canDrop, onDrop: onDropDeck });
  // The ring says "this drawer could take the deck you are holding", the wash says "this is the
  // one it would go into" — `AppShell`'s sidebar vocabulary, because these are the same claim
  // made about the same gesture two panels apart.
  const eligible = drag !== null && canDrop(drag);

  return (
    <li>
      <div
        ref={ref}
        className={cn("group relative rounded-md", eligible && DROP_RING, over && DROP_OVER)}
      >
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
          // F2 renames the row the caret is on — the file manager's key, and the keyboard's
          // route to a rename whose pointer route is the wall's "Rename folder". A shortcut
          // rather than the only way in: nothing here is reachable by this key alone.
          onKeyDown={(e) => {
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
            aria-label={`New folder in ${label}`}
            aria-expanded={addingChild}
            title={`New folder in ${label}`}
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
 * `CategoriesPanel`'s `RenameField` decided the two details that matter and they are kept here:
 * the current name arrives **selected**, because the commonest rename replaces the word rather
 * than edits inside it, and Escape's job is left to the page — a second Escape rung inside an
 * `"inner"` layer is the case `useDismissOnEscape` explicitly does not order.
 *
 * What is *not* kept is that field's visible Cancel: at 208px less an indent there is no room
 * for two text buttons beside the input, and this screen's other half-made decisions (the new
 * deck form, the delete question, both move pickers) are all discarded the same two ways —
 * Escape, or looking away.
 */
function FolderNameField({
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
        <button
          type="submit"
          aria-label={submitLabel}
          title={submitLabel}
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
      </form>
      {where && <p className="mt-1 text-[0.7rem] text-dim">{where}</p>}
    </div>
  );
}

const NOTHING_FORBIDDEN: ReadonlySet<number> = new Set();

/**
 * Where a deck or a folder can be moved to — **the keyboard's half of the drag.**
 *
 * A drag-only affordance is half a feature, and this is the other half: the same two writes
 * (`deck_set_folder`, `deck_folder_move`) reached with the caret. `null` is the top level and
 * is an offer with a meaning rather than an omission — `DeckPatch` writes every column with
 * `coalesce(?n, column)`, so there is no patch that un-files a deck and this list is the only
 * way back to the root.
 */
export function MoveToFolder({
  label,
  nodes,
  currentId,
  forbidden = NOTHING_FORBIDDEN,
  forbiddenReason = null,
  pending,
  onPick,
  onClose,
}: {
  /** The dialog's accessible name — "Move Burn to a folder". */
  label: string;
  nodes: readonly FolderNode[];
  /** Where it already is: offered, inert. Moving something where it already is writes nothing
   *  and bumps `updated_at` — `dropWrite`'s rule about a card dropped back in its own column. */
  currentId: number | null;
  /** Folders it may not go into — itself and its descendants, for a folder move. */
  forbidden?: ReadonlySet<number>;
  /** Why those are inert. Said once under the list rather than on each of them. */
  forbiddenReason?: string | null;
  pending: boolean;
  onPick: (folderId: number | null) => void;
  /** Focus left the layer on its own. Closes and hands nothing back. */
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const flat = flattenFolders(nodes);

  // The caret moves into the layer, as it does for every other one in the app, so Escape has
  // something to hand back and Tab reaches the destinations next.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const destination = (id: number | null, name: string, depth: number) => {
    const inert = id === currentId || (id !== null && forbidden.has(id));
    return (
      <li key={id ?? "root"}>
        <button
          type="button"
          disabled={inert || pending}
          onClick={() => onPick(id)}
          style={indent(depth)}
          className={cn(
            "flex w-full items-center gap-2 truncate rounded-md py-1.5 pr-2 text-left text-xs",
            "transition-colors duration-150 motion-reduce:transition-none",
            "hover:bg-surface hover:text-text disabled:opacity-40 disabled:hover:bg-transparent",
            inert ? "text-dim" : "text-text",
            FOCUS,
          )}
        >
          {id === null ? (
            <Layers className="size-3.5 flex-none" aria-hidden="true" />
          ) : (
            <Folder className="size-3.5 flex-none" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {id === currentId && <span className="flex-none text-[0.7rem] text-dim">Here now</span>}
        </button>
      </li>
    );
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      // A press in here is a press on a control, never the start of a drag of the tile this
      // panel is anchored inside.
      data-no-drag=""
      // Anchored to its trigger and pinned to the trigger's **right** edge, not portalled:
      // the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a
      // runtime <style>, and nothing clips these popups — one opening leftward from a tile at
      // the end of a row scrolls the whole app sideways.
      className={cn(
        "absolute right-0 top-8 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg",
        LAYER.popup,
        FOCUS,
      )}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <ul className="max-h-56 overflow-y-auto">
        {destination(null, "All decks", 0)}
        {flat.map((node) => destination(node.folder.id, node.folder.name, node.depth + 1))}
      </ul>
      {forbiddenReason && (
        <p className="border-t border-border px-2 pb-1 pt-1.5 text-[0.7rem] leading-relaxed text-dim">
          {forbiddenReason}
        </p>
      )}
    </div>
  );
}
