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
 * shape, and a row of folders genuinely is a list. The ring lives on that `<li>`, which means the
 * scroller around the wall has to carry `DROP_MARK_ROOM`; that is the wall's business rather than
 * the card's, and `dropMarks.ts` explains why padding one level in is not the same fix.
 *
 * **Two drags reach this card and they are deliberately two.** A *copy* dropped on it is filed
 * into the drawer (`collectionDrag.ts`'s payload); a *folder* dropped on it is nested inside it
 * or placed beside it (`lib/folderDrag.ts`'s). Each reader refuses the other's payload outright,
 * because the two marks live under different keys — so a card carried over a folder can never be
 * mistaken for a folder being re-filed, and neither target needs to know the other exists. Only
 * one thing is ever in the air, so the pair share the two marks `dropMarks.ts` publishes rather
 * than inventing a second vocabulary: {@link DROP_RING} on the `<li>` for "this drawer would take
 * what you are holding" and {@link DROP_OVER} on the face for "and this is where it lands". The
 * third landing is the one a copy has no equivalent of, and it is `FolderDropLine`.
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
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
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
   * Whether *this* folder would take what is currently in the air — the folder a card is already
   * filed in refuses it, and draws no ring rather than a ring that does nothing.
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

  return (
    <li ref={ref} className={cn("relative rounded-xl", (armed || folderArmed) && DROP_RING)}>
      <div ref={slot}>
        <button
          type="button"
          // Starts with the visible label and then says, in words, what the second line says in
          // figures — WCAG 2.5.3, and `FolderCard`'s arrangement: the name is the prefix, and the
          // count is a sentence rather than a bare number a screen reader cannot attach to
          // anything.
          aria-label={`${node.folder.name} folder, ${spoken}`}
          onClick={onOpen}
          // **The menu's two doors are on this button**, never on the `<li>` around it — the panel
          // hands the caret back to the element a menu was opened on, and this is the focusable one.
          // `FolderTree`'s rule, and the same reason it gives.
          onContextMenu={rowMenu.onContextMenu}
          onKeyDown={rowMenu.onKeyDown}
          className={cn(
            // `pr-9` leaves the manage trigger its corner: the trigger is a *sibling* rather than a
            // child, because a button inside a button is not markup a browser will build.
            "block w-full rounded-xl border border-dashed border-border p-2.5 pr-9 text-left",
            "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
            // One wash for both drags, because only one thing is ever in the air: a copy over this
            // drawer and a folder over its middle are the same claim — what you are holding lands
            // *in here*. The other two landings are a line rather than a wash, which is what keeps
            // "inside this folder" and "beside this folder" from wearing one mark.
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

        {/* The visible way into the same menu the right-click opens — the affordance a reader who
            does not know a card can be right-clicked has. Named for the folder, because a wall of
            these is otherwise a row of controls all called "Manage": a screen reader reads them out
            of context, one after another, with nothing to tell them apart.

            `aria-haspopup="menu"` and no `aria-expanded`, which is the deliberately partial
            declaration `WishFolderCard` argues in full: the popup *kind* is a fact about this
            button and is free, while the expanded *state* is a fact about `ContextMenuProvider`,
            which holds the one open menu at the app root and publishes only `openMenu`/`closeMenu`.
            A static `aria-expanded="false"` would be an assertion, and it would be wrong for
            exactly as long as the menu is up. */}
        <button
          type="button"
          aria-label={`Manage ${node.folder.name}`}
          aria-haspopup="menu"
          // `data-no-drag`, and it is load-bearing from the moment the card became draggable:
          // Chromium starts a drag from the nearest draggable *ancestor* of whatever was pressed,
          // so without it a press on the `⋯` plus five pixels of travel files this folder somewhere
          // instead of opening its menu — and the click that was meant is never delivered.
          // `composedDraggable`'s capture-phase guard is what reads it; `dnd.ts` has the measurement.
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
