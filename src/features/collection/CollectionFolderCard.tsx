/**
 * A collection folder as it is drawn above the cards, in both views — the tile a reader clicks
 * into, and one of the two places a row can be dropped. Design spec §7.1.
 *
 * **Ported from `WishFolderCard.tsx`, which was itself ported from `src/features/decks/
 * FolderCard.tsx`, and it keeps that card's one visual claim.** The border is **dashed**, which
 * across this app is not decoration but a rule with a meaning already established: *dashed means
 * provisional*. A deck folder wears it because a folder is a container rather than a thing you can
 * play; a wishlist folder because it is a container rather than a thing you can buy. A binder
 * wears it for the same reason said in this screen's terms — it is a container rather than a card
 * you **own**. The copies inside it are the things with a condition and a price; the drawer they
 * are in is not one of them. Nothing else on the collection page is dashed, so the dash keeps
 * meaning exactly that.
 *
 * **No strip of member art here either**, which is `WishFolderCard`'s departure from the deck
 * card, kept for a reason of this screen's own: a binder is read for what is *in* it and what it
 * is *worth*, and the wall of art below is already the picture. Three crops would also cost an
 * image query, a `useImageRetry` and an illustrator credit line per tile — Scryfall's image policy
 * attaches to pictures, and there are none here.
 *
 * **Drawn as an `<li>`, so a caller draws a wall of these inside a `<ul>`** — `FolderCard`'s
 * shape, and a row of folders genuinely is a list. That `<li>` is a positioning box and a drop
 * registration and nothing else: it draws no mark of its own. The scroller around the wall still
 * carries `DROP_MARK_ROOM`, but no longer for the drop affordance — `FOCUS` stands 4px proud of
 * this card's button and `overflow` clips at the padding box, which is a WCAG 2.4.7 matter rather
 * than a cosmetic one. That constant's own note carries the whole reading.
 *
 * **Both drag marks are drawn on the `<button>`, because that is the element carrying this card's
 * own edge** (2026-09-03). They were not: the eligible ring went on the `<li>` while the dashed
 * border and the wash went on the face inside it — and a ring is a box shadow painted *outside*
 * the border box, so what shipped was a gold rectangle standing 2px proud of a dashed rectangle it
 * never touched. Two concentric outlines for one landing, which is the reader's report that the
 * affordances are bulky, overlap their neighbours and "don't align with the dotted outline".
 * Nothing about the drop *registrations* moved to fix it and nothing could — see {@link slot} —
 * so only the `className` did.
 *
 * **Two drags reach this card and they are deliberately two.** A *copy* dropped on it is filed
 * into the drawer (`collectionDrag.ts`'s payload); a *folder* dropped on it is nested inside it
 * or placed beside it (`lib/folderDrag.ts`'s). Each reader refuses the other's payload outright,
 * because the two marks live under different keys — so a card carried over a folder can never be
 * mistaken for a folder being re-filed, and neither target needs to know the other exists. Only
 * one thing is ever in the air, so the pair share the two marks `dropMarks.ts` publishes rather
 * than inventing a second vocabulary — and because the face owns a dash all day, the eligible one
 * is {@link DROP_EDGE} rather than the ring a borderless target wears: the card's own outline goes
 * faintly gold for "this drawer would take what you are holding", {@link DROP_OVER} takes it to
 * full strength beside its wash for "and this is where it lands", and at no point are there two
 * edges to fail to line up. The third landing is the one a copy has no equivalent of, and it is
 * `FolderDropLine`.
 */
import {
  useEffect,
  useRef,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type RefObject,
} from "react";
import { Folder, MoreHorizontal } from "lucide-react";
import { FolderDropLine } from "@/components/FolderDropLine";
import { FolderNameField, useFolderFieldReturn } from "@/components/FolderNameField";
import { ParentFolderCard } from "@/components/ParentFolderCard";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import {
  folderDraggable,
  useFolderDropTarget,
  type FolderDrag,
  type FolderEdge,
} from "@/lib/folderDrag";
import type { FolderNode } from "@/lib/folderTree";
import { FOCUS } from "@/lib/focus";
import type { CollectionFolder } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { useCollectionDropTarget, type CollectionDrop } from "./collectionDrag";

/**
 * What a folder card is drawn from: the copies filed in it and what they are worth.
 *
 * **Not `CollectionFolderSummary` itself, and the difference is load-bearing.** That row is
 * *direct* — this folder's own cards, never its sub-folders' — which is right for the row and
 * wrong for the card: a folder holding two sub-folders of six cards each and none of its own would
 * draw `0 cards` over a drawer holding twelve. The caller adds the children in, the same
 * arithmetic `buildFolderTree` already does for `FolderNode.count`, and hands the total here.
 *
 * `cards` is **copies**, not rows — `sum(quantity)`, which is the page header's own `totalCards`
 * arithmetic, so a tile and the header can never count one folder two ways.
 *
 * `value` is `number | null` and the `null` is the backend's own, kept rather than flattened: a
 * marketplace that prices nothing in the drawer answers `None`, and `$0.00` there would claim a
 * quote nobody gave.
 */
export interface CollectionFolderTotals {
  cards: number;
  value: number | null;
}

/**
 * The folder's face, in two spellings of one sentence.
 *
 * `shown` is what the card prints, joined with the app's `·`. `spoken` is the same facts joined
 * with commas for the button's `aria-label`, because an `aria-label` replaces everything inside
 * the control and a middot read aloud is punctuation nobody asked for. Built together rather than
 * written twice, so the two can never disagree about what the card says.
 *
 * **`null` is "not counted yet", and it is a different thing from a folder holding nothing.** The
 * cabinet is drawn as soon as the folder *list* answers, and that list is one flat `SELECT` while
 * the summary behind these figures is a `GROUP BY` carrying a marketplace price expression — so
 * there is a real window in which a drawer holding 240 copies worth $1,300 is on screen with
 * nothing yet known about it. Drawing `0 cards` across that window is not a spinner, it is a
 * **wrong number that then jumps**, and a reader who glanced at the wall in that moment was told
 * the drawer was empty. An em dash is what every other unanswered figure in this app draws
 * (`Figure`'s own `query.isPending ? "—"`), and the spoken half says it in words because a dash
 * read aloud is punctuation.
 *
 * **An empty drawer shows its count and no money at all.** `$0.00` under a folder with nothing in
 * it is noise — `formatPrice`'s own rule is that it is a price nobody quoted — and an em dash
 * beside `0 cards` would invite the reader to wonder which of the nothing could not be priced.
 *
 * **A count that can reach four figures is written through `count`, not `plural`.** A binder
 * genuinely holds thousands of copies where a wishlist holds tens, and `plural` writes its number
 * plainly on purpose — its own doc says a caller that reaches four figures wants
 * `${count(n)} ${…}` and its own thought about it. This is that caller.
 *
 * **Exported for `PinnedFolders`, which draws the app's own folders beside these.** A deck group
 * and `Recently removed` are drawn by a different component — they take no drop, offer no menu and
 * are not part of the nestable tree — but they answer the *same* two questions about themselves,
 * and a second spelling of "12 cards · $340.00" is a second chance for one wall to disagree with
 * the wall under it.
 */
export function folderFace(
  summary: CollectionFolderTotals | null,
  currency: Currency,
): { shown: string; spoken: string } {
  if (summary === null) return { shown: "—", spoken: "still counting" };
  const cards = `${count(summary.cards)} ${summary.cards === 1 ? "card" : "cards"}`;
  if (summary.cards === 0) return { shown: cards, spoken: cards };
  // The two spellings differ on exactly one field, and only where the marketplace priced nothing
  // in the drawer: the em dash is the right mark on screen and the wrong word in a sentence —
  // the same rule the "still counting" branch above applies one field earlier.
  const money =
    summary.value === null
      ? { shown: "—", spoken: "not priced" }
      : { shown: formatPrice(summary.value, currency), spoken: formatPrice(summary.value, currency) };
  return {
    shown: `${cards} · ${money.shown}`,
    spoken: `${cards}, ${money.spoken}`,
  };
}

export function CollectionFolderCard({
  node,
  summary,
  currency,
  onOpen,
  rowMenu,
  rename,
  canDrop,
  onDropCard,
  canDropFolder,
  onDropFolder,
}: {
  node: FolderNode<CollectionFolder>;
  /** The recursive total the caller summed — or `null` while the summary read is still in flight,
   *  which is not the same answer as an empty drawer. See {@link folderFace}. */
  summary: CollectionFolderTotals | null;
  currency: Currency;
  onOpen: () => void;
  /**
   * The page's own menu — Rename / Move to folder… / Delete — reached from three gestures here
   * and built once per page rather than once per card.
   *
   * **Three handles rather than two, because the trigger's press is a third kind of door.** A
   * right-click carries the pointer's coordinates and a `ContextMenu` keypress carries none; a
   * plain click on the `⋯` is *either*, depending on whether a pointer or the Enter key produced
   * it, and only `useContextMenu`'s `menuClick` knows to ask. Built from
   * `{ onContextMenu: menu(build), onKeyDown: menuKey(build), onClick: menuClick(build) }`.
   */
  rowMenu: {
    onContextMenu: MouseEventHandler<HTMLButtonElement>;
    onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
    onClick: MouseEventHandler<HTMLButtonElement>;
  };
  /**
   * `Rename…`, answered **on the card** rather than in a strip above the wall.
   *
   * `active` is the page's, not the card's, because one field is open at a time across the whole
   * cabinet: pressing `New folder` has to close a rename already in progress, and a card holding
   * its own flag could not know that had happened. It is also what makes the draft disposable —
   * the field is mounted by this flag and holds the half-typed name in its own state, so a
   * cancelled rename cannot survive into the next one.
   *
   * **The card keeps its figures line while the field is open** (see the render), which is the
   * whole reason a rename is not simply `NewFolderCard`'s tile with a different label: a reader
   * renaming *Trade binder* is looking at the drawer holding 240 cards, and a box that dropped
   * the count would make them check they had the right one.
   */
  rename: {
    active: boolean;
    /** The write is in flight — holds the field open and greys the tick. */
    pending: boolean;
    onSubmit: (name: string) => void;
    onCancel: () => void;
  };
  /**
   * Whether *this* folder would take what is currently in the air — the folder a card is already
   * filed in refuses it, and leaves its dash plain rather than lighting an edge that leads
   * nowhere.
   *
   * **Either shape of collection drop**, a table row's single entry or a wall tile's whole shelf
   * of copies, and the card stays dumb about the difference: it hands the drop straight through
   * and the page answers, because "which of these copies is already here" is a question about the
   * cabinet rather than about this tile.
   */
  canDrop: (drop: CollectionDrop) => boolean;
  onDropCard: (drop: CollectionDrop) => void;
  /**
   * The other drag: a **folder** let go on this card, and which of the three landings it would
   * take — inside this drawer, or beside it on either side.
   *
   * Already bound to this card by the page, exactly as {@link canDrop} is, and with no `drag`
   * prop beside it: `useFolderDropTarget` runs a monitor per target gated by this same question,
   * so every card on the wall answers for itself and no two answer the same. The folder in the
   * air refuses itself, its own parent refuses the nest that would move it nowhere, and a drop
   * that would reproduce the order already on screen refuses all three.
   *
   * **The axis is the whole of what this drawing differs by**, and it is `"horizontal"` here: the
   * page lays its drawers out as a grid of cards, so `before`/`after` are the leading and
   * trailing sides where in the deck sidebar's vertical tree they are the top and bottom edges.
   */
  canDropFolder: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDropFolder: (drag: FolderDrag, edge: FolderEdge) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  /**
   * The box the **folder** drop target is registered on, and why it is still not the `<li>`.
   *
   * **The reason changed with the library and the arrangement did not.** `@atlaskit/pragmatic-
   * drag-and-drop` kept exactly one element drop target per element — `makeDropTarget`'s registry
   * is a `WeakMap` keyed by the node, so a second `dropTargetForElements` silently *replaced* the
   * first — and two payloads land on this card, so they needed two boxes. `@dnd-kit/dom` keys its
   * registry by **entity id**, so two `Droppable`s on one element both register and both compete;
   * what keeps them apart is `accepts()`, which `computeCollisions` asks before it measures
   * anything, and `readCollectionDrop`/`readWishDrag` and `readFolderDrag` are disjoint by
   * construction. So one box would now work.
   *
   * It stays two for the two reasons that outlived the registry. **The geometry**: this wrapper
   * holds both buttons and therefore covers every pixel of the card including the `⋯`'s corner,
   * and its border box is the `<li>`'s, which is what {@link useFolderDropTarget} divides into
   * the three landings. And **every test and story here addresses the two boxes by name**, which
   * is how they tell "the copy target answered" from "the folder target answered" in a suite with
   * no layout engine. A plain `<div>` with no positioning of its own, so the `⋯` still resolves
   * against the `<li>` and nothing in the layout moves.
   */
  const slot = useRef<HTMLDivElement>(null);
  const tip = useTooltip();
  const { armed, over } = useCollectionDropTarget({ ref, canDrop, onDrop: onDropCard });
  useFolderDragSource(ref, node.folder);
  const { armed: folderArmed, edge } = useFolderDropTarget({
    ref: slot,
    scope: "collection",
    axis: "horizontal",
    canDrop: canDropFolder,
    onDrop: onDropFolder,
  });
  const { shown, spoken } = folderFace(summary, currency);
  // The caret's way back out of the field, and it has to be a ref taken here rather than the
  // element the page remembered when the menu was opened: the `⋯` this restores to is a *new*
  // element, built by the render that closed the field, so the one the page is holding is a
  // detached node whose `focus()` is a silent no-op. See `useFolderFieldReturn`.
  const manageRef = useFolderFieldReturn<HTMLButtonElement>(rename.active);

  // No mark on the `<li>`, and that is the whole of the 2026-09-03 fix: it is where the copy drop
  // is registered and what `FolderDropLine` is positioned against, and it sits *outside* the
  // dashed edge the reader actually sees. Anything drawn on it is a second outline around the
  // first. See the file header.
  return (
    <li ref={ref} className="relative rounded-xl">
      <div ref={slot}>
        {rename.active ? (
          /* **The card becomes the field, and keeps its second line.** The name is edited on the
             line it is drawn on, at the same track and inside the same dashed edge — a folder
             being renamed is still a container, so the dash stays and only its colour moves to
             `border-accent`. The figures line goes on saying what is in the drawer, which is what
             a reader checks they have the right one by.

             The two drop targets above are left registered on purpose: a copy dropped onto a
             folder whose name is being edited files perfectly well, and tearing the targets down
             would make the wall answer a drag differently depending on a state the dragger cannot
             see. What the field *does* suppress is this card as a drag **source** — its `<form>`
             carries `data-no-drag`, so pressing into the name places a caret instead of picking
             the folder up. */
          <FolderNameField
            mode="rename"
            label={`Rename ${node.folder.name}`}
            initial={node.folder.name}
            submitLabel="Rename folder"
            pending={rename.pending}
            footer={
              <span className="mt-1 block truncate text-xs tabular-nums text-dim">{shown}</span>
            }
            onSubmit={rename.onSubmit}
            onCancel={rename.onCancel}
          />
        ) : (
          <>
            <button
              type="button"
              // Starts with the visible label and then says, in words, what the second line says in
              // figures — WCAG 2.5.3, and `FolderCard`'s arrangement: the name is the prefix, and
              // the count is a sentence rather than a bare number a screen reader cannot attach to
              // anything.
              aria-label={`${node.folder.name} folder, ${spoken}`}
              onClick={onOpen}
              // **The menu's two doors are on this button**, never on the `<li>` around it — the
              // panel hands the caret back to the element a menu was opened on, and this is the
              // focusable one. `FolderTree`'s rule, and the same reason it gives.
              onContextMenu={rowMenu.onContextMenu}
              onKeyDown={rowMenu.onKeyDown}
              className={cn(
                // `pr-9` leaves the manage trigger its corner: the trigger is a *sibling* rather
                // than a child, because a button inside a button is not markup a browser will
                // build.
                "block w-full rounded-xl border border-dashed border-border p-2.5 pr-9 text-left",
                "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
                // The card's own dash, gone faintly gold — one mark for both drags, because
                // either one being in the air means the same thing about this drawer: it would
                // take what you are holding. The eligible mark for a surface that already has an
                // edge, so nothing is drawn *around* this one to disagree with it.
                (armed || folderArmed) && DROP_EDGE,
                // One wash for both drags, because only one thing is ever in the air: a copy over
                // this drawer and a folder over its middle are the same claim — what you are
                // holding lands *in here*. The other two landings are a line rather than a wash,
                // which is what keeps "inside this folder" and "beside this folder" from wearing
                // one mark.
                //
                // **After the line above on purpose.** `tailwind-merge` resolves a border colour
                // by argument order, so this is what takes `border-accent/45` up to full strength
                // on the one card the pointer is actually on — swap the two and every eligible
                // drawer on the wall would out-shout it.
                (over || edge === "inside") && cn("border-accent", DROP_OVER),
                FOCUS,
              )}
            >
              <span className="flex items-center gap-2">
                <Folder className="size-3.5 flex-none text-dim" aria-hidden="true" />
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  {...tip(node.folder.name, { whenClipped: true })}
                >
                  {node.folder.name}
                </span>
              </span>
              <span className="mt-1 block truncate text-xs tabular-nums text-dim">{shown}</span>
            </button>

            {/* The visible way into the same menu the right-click opens — the affordance a reader
                who does not know a card can be right-clicked has. Named for the folder, because a
                wall of these is otherwise a row of controls all called "Manage": a screen reader
                reads them out of context, one after another, with nothing to tell them apart.

                `aria-haspopup="menu"` and no `aria-expanded`, which is the deliberately partial
                declaration `WishFolderCard` argues in full: the popup *kind* is a fact about this
                button and is free, while the expanded *state* is a fact about
                `ContextMenuProvider`, which holds the one open menu at the app root and publishes
                only `openMenu`/`closeMenu`. A static `aria-expanded="false"` would be an
                assertion, and it would be wrong for exactly as long as the menu is up. */}
            <button
              ref={manageRef}
              type="button"
              aria-label={`Manage ${node.folder.name}`}
              aria-haspopup="menu"
              // `data-no-drag`, and it is load-bearing from the moment the card became draggable:
              // Chromium starts a drag from the nearest draggable *ancestor* of whatever was
              // pressed, so without it a press on the `⋯` plus five pixels of travel files this
              // folder somewhere instead of opening its menu — and the click that was meant is
              // never delivered. `composedDraggable`'s capture-phase guard is what reads it;
              // `dnd.ts` has the measurement.
              data-no-drag=""
              onClick={rowMenu.onClick}
              onKeyDown={rowMenu.onKeyDown}
              className={cn(
                "absolute right-1 top-1 grid size-7 place-items-center rounded-md text-dim",
                "transition-colors duration-150 hover:bg-surface hover:text-text",
                "motion-reduce:transition-none",
                FOCUS,
              )}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* Drawn straight off `edge`, which is `null` both when the pointer is elsewhere and when
          it is over a part of this card that would refuse — so no line means no drop, rather than
          a mark leading to a write that never happens. `absolute` against this `<li>`, which is
          why the card's box is `relative`. */}
      <FolderDropLine edge={edge} axis="horizontal" />
    </li>
  );
}

/**
 * The collection's **up one level** tile — the level above this one, drawn as a drawer among the
 * drawers so a copy can be dropped back out of a binder as easily as it was dropped into one.
 * Issue #283.
 *
 * `ParentFolderCard` is the whole of what it looks like; what is here is the pair of drop targets,
 * which is the part that is this cabinet's own. Both register on the **same `<li>`** — the tile
 * has one landing, so it needs none of the geometry a folder card's second box exists for, and
 * `readCollectionDrop` and `readFolderDrag` are disjoint, so `accepts()` keeps the two apart.
 *
 * **The folder half ignores the edge on purpose.** `useFolderDropTarget` divides a target into
 * before / inside / after because a folder card offers three landings; this tile offers one, and
 * the wall is not the level the dragged folder would be joining, so "beside this tile" is not a
 * position that exists. Every part of it means *up there*.
 *
 * **It is the one drop target on this page whose destination can be an app-owned level, and it
 * never is.** The tile is drawn from the reader's own trail, and nothing nests inside a deck
 * group or `Recently removed` — so the level above is always either the root or a folder the
 * reader made. The page asks `canMoveCopy`'s question anyway, which is the fence rather than the
 * affordance and stays local for the day something is nested there.
 */
export function CollectionParentFolderCard({
  label,
  onOpen,
  canDrop,
  onDropCard,
  canDropFolder,
  onDropFolder,
}: {
  /** The parent folder's name, or `Collection` at the root — the breadcrumb's own word for the
   *  same place, so the tile and the trail above it cannot name one destination two ways. */
  label: string;
  onOpen: () => void;
  /** Whether the level above would take what is in the air — either shape of collection drop, a
   *  table row's single entry or a wall tile's whole shelf of copies, exactly as a folder card
   *  takes them and with the same page answering. */
  canDrop: (drop: CollectionDrop) => boolean;
  onDropCard: (drop: CollectionDrop) => void;
  /** The other drag: a **folder** moved up out of the level on screen, landing last in the level
   *  above. Answered by the page, which is what holds the cabinet the order comes from. */
  canDropFolder: (drag: FolderDrag) => boolean;
  onDropFolder: (drag: FolderDrag) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const { armed, over } = useCollectionDropTarget({ ref, canDrop, onDrop: onDropCard });
  const { armed: folderArmed, edge } = useFolderDropTarget({
    ref,
    scope: "collection",
    axis: "horizontal",
    canDrop: (drag) => canDropFolder(drag),
    onDrop: (drag) => onDropFolder(drag),
  });

  return (
    <ParentFolderCard
      cardRef={ref}
      label={label}
      armed={armed || folderArmed}
      over={over || edge !== null}
      onOpen={onOpen}
    />
  );
}

/**
 * The card as something to pick **up**.
 *
 * **Not `features/decks/FolderTree.tsx`'s `useFolderDragSource`, which is the same twelve lines.**
 * That one takes a `DeckFolder` and spells `scope: "deck"` into the payload, so reusing it here
 * would mean widening it to `FolderLike` plus a scope argument *and* making a collection card
 * import the deck gallery's tree module to get it. `folderDrag.ts` is where the shared part
 * already lives; what is left over is a type and a word.
 *
 * `folderDraggable` takes a callback and this reads it out of a **ref** for that callback's own
 * reason: `node.folder` is a fresh object on every refetch of the folder list, so an effect keyed
 * on it would tear the source down and rebuild it in the middle of a gesture. Registration is
 * keyed on the id alone — which is what the wall keys the card on — so it happens once per folder
 * for the life of the card, and a folder renamed or re-filed since then still carries what it is
 * now at `dragstart`. That last part is what lets a folder's current parent refuse a nest that
 * would move it nowhere.
 */
function useFolderDragSource(
  ref: RefObject<HTMLElement | null>,
  folder: CollectionFolder,
): void {
  const latest = useRef(folder);
  useEffect(() => {
    latest.current = folder;
  });

  const id = folder.id;
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    return folderDraggable({
      element,
      folder: () => ({
        folderId: id,
        name: latest.current.name,
        parentId: latest.current.parentId,
        scope: "collection",
      }),
    });
  }, [ref, id]);
}
