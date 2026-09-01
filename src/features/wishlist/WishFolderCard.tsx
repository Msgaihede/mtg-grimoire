/**
 * A wishlist folder as it is drawn above the wishes, in both views — the tile a reader clicks
 * into, and one of the two places a wish can be dropped. Design spec §4 and §9.
 *
 * **Ported from `src/features/decks/FolderCard.tsx`, and it keeps that card's one visual claim.**
 * The border is **dashed**, which on this screen is not decoration but a rule with a meaning
 * already established: *dashed means provisional*. A deck folder wears it because a folder is a
 * container rather than a thing you can play. A wishlist folder wears it for the same reason
 * stated in this page's own terms — it is a container rather than a thing you can **buy**. The
 * wishes inside it are the things with prices; the drawer they are in is not one of them. Nothing
 * else on the wishlist is dashed, so the dash keeps meaning exactly that.
 *
 * **The one place this deliberately departs from the component it is ported from: no strip of
 * member art.** `FolderCard` draws three member covers, because a deck gallery is browsed by
 * recognising a deck, and a deck's face is its art. A shopping list is not browsed that way — it
 * is read for its **money**. Three crops of cards a reader has not bought yet answer a question
 * nobody asked of a wishlist folder, while `6 wishes · $312.00`, the whole face this draws
 * instead, answers the only one they have: how much is in this drawer and what will it cost. That
 * also makes the tile cheap in a way the deck card is not — it needs no image query, no
 * `useImageRetry`, and no illustrator credit line, because Scryfall's image policy attaches to
 * pictures and there are none here.
 *
 * The unpriced note is written in the same `· 2 unpriced` shape `WishlistPage`'s own header
 * builds, so a folder's qualification of its subtotal and the page's qualification of the whole
 * list's read as one sentence rather than as two conventions.
 *
 * **Drawn as an `<li>`, so a caller draws a wall of these inside a `<ul>`** — `FolderCard`'s
 * shape, and a row of folders genuinely is a list. The ring lives on that `<li>`, which means the
 * scroller around the wall has to carry `DROP_MARK_ROOM`; that is the wall's business rather than
 * the card's, and `dropMarks.ts` explains why padding one level in is not the same fix.
 *
 * **Two drags reach this card and they are deliberately two.** A *wish* dropped on it is filed
 * into the drawer (`wishDrag.ts`'s payload); a *folder* dropped on it is nested inside it or
 * placed beside it (`lib/folderDrag.ts`'s). Each reader refuses the other's payload outright,
 * because the two marks live under different keys — so neither target needs to know the other
 * exists. Only one thing is ever in the air, so the pair share the two marks `dropMarks.ts`
 * publishes rather than inventing a second vocabulary: {@link DROP_RING} on the `<li>` for "this
 * drawer would take what you are holding" and {@link DROP_OVER} on the face for "and this is
 * where it lands". The third landing is the one a wish has no equivalent of, and it is
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
import { ParentFolderCard } from "@/components/ParentFolderCard";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import {
  folderDraggable,
  useFolderDropTarget,
  type FolderDrag,
  type FolderEdge,
} from "@/lib/folderDrag";
import type { FolderNode } from "@/lib/folderTree";
import { FOCUS } from "@/lib/focus";
import type { WishlistFolder } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { useWishDropTarget, type WishDrag } from "./wishDrag";

/**
 * What a folder card is drawn from: the wishes in it, the copies still to find, what those cost
 * and how many of them the marketplace could not price.
 *
 * **Not `WishlistFolderSummary` itself, and the difference is load-bearing.** That row is
 * *direct* — this folder's own wishes, never its sub-folders' — which is right for the row and
 * wrong for the card: a folder holding two sub-folders of six wishes each and none of its own
 * would draw `0 wishes` over a drawer holding twelve. The caller adds the children in, the same
 * arithmetic `buildFolderTree` already does for `FolderNode.count`, and hands the total here.
 */
interface WishFolderSummary {
  wishes: number;
  missing: number;
  cost: number;
  unpriced: number;
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
 * the summary behind these figures is a `GROUP BY` carrying the owned-copies subquery and a price
 * expression — so there is a real window in which a drawer holding six wishes worth $312 is on
 * screen with nothing yet known about it. Drawing `0 wishes` across that window is not a spinner,
 * it is a **wrong number that then jumps**, and a reader who glanced at the wall in that moment
 * was told the drawer was empty. An em dash is what every other unanswered figure in this app
 * draws (`Figure`'s own `query.isPending ? "—"`), and the spoken half says it in words because a
 * dash read aloud is punctuation.
 *
 * **A folder with nothing left to buy shows its wish count and no money at all.** `$0.00` on a
 * folder the reader has finished buying is noise — `formatPrice`'s own rule is that it is a price
 * nobody quoted — and the unpriced note goes with it, since that note exists to qualify a
 * subtotal and there is no subtotal to qualify.
 */
function face(
  summary: WishFolderSummary | null,
  currency: Currency,
): { shown: string; spoken: string } {
  if (summary === null) return { shown: "—", spoken: "still counting" };
  const wishes = plural(summary.wishes, "wish", "wishes");
  if (summary.missing === 0) return { shown: wishes, spoken: wishes };
  const parts = [
    // `null` rather than `0` where nothing in the folder could be priced: every missing copy is
    // unpriced, and an em dash beside `3 unpriced` says that where `$0.00` would claim the
    // marketplace quoted nothing for three cards.
    formatPrice(summary.cost > 0 ? summary.cost : null, currency),
    ...(summary.unpriced > 0 ? [`${summary.unpriced} unpriced`] : []),
  ];
  return {
    shown: [wishes, ...parts].join(" · "),
    spoken: [wishes, ...parts].join(", "),
  };
}

export function WishFolderCard({
  node,
  summary,
  currency,
  onOpen,
  rowMenu,
  canDrop,
  onDropWish,
  canDropFolder,
  onDropFolder,
}: {
  node: FolderNode<WishlistFolder>;
  /** The recursive total the caller summed — or `null` while the summary read is still in
   *  flight, which is not the same answer as an empty drawer. See {@link face}. */
  summary: WishFolderSummary | null;
  currency: Currency;
  onOpen: () => void;
  /**
   * The page's own menu — Rename / Move to folder… / Delete — reached from three gestures here
   * and built once per page rather than once per card.
   *
   * **Three handles rather than two, because the trigger's press is a third kind of door.** A
   * right-click carries the pointer's coordinates and a `ContextMenu` keypress carries none;
   * a plain click on the `⋯` is *either*, depending on whether a pointer or the Enter key
   * produced it, and only `useContextMenu`'s `menuClick` knows to ask. Built from
   * `{ onContextMenu: menu(build), onKeyDown: menuKey(build), onClick: menuClick(build) }`.
   */
  rowMenu: {
    onContextMenu: MouseEventHandler<HTMLButtonElement>;
    onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
    onClick: MouseEventHandler<HTMLButtonElement>;
  };
  /** Whether *this* folder would take the wish currently in the air — spec §9: the folder a wish
   *  is already filed in refuses it, and draws no ring rather than a ring that does nothing. */
  canDrop: (drag: WishDrag) => boolean;
  onDropWish: (drag: WishDrag) => void;
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
   * is how they tell "the wish target answered" from "the folder target answered" in a suite with
   * no layout engine. A plain `<div>` with no positioning of its own, so the `⋯` still resolves
   * against the `<li>` and nothing in the layout moves.
   */
  const slot = useRef<HTMLDivElement>(null);
  const tip = useTooltip();
  const { armed, over } = useWishDropTarget({ ref, canDrop, onDrop: onDropWish });
  useFolderDragSource(ref, node.folder);
  const { armed: folderArmed, edge } = useFolderDropTarget({
    ref: slot,
    scope: "wishlist",
    axis: "horizontal",
    canDrop: canDropFolder,
    onDrop: onDropFolder,
  });
  const { shown, spoken } = face(summary, currency);

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
            // One wash for both drags, because only one thing is ever in the air: a wish over this
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
            these is otherwise a row of controls all called "Manage": a screen reader reads them
            out of context, one after another, with nothing to tell them apart.

            **`aria-haspopup="menu"` and no `aria-expanded`, which is a deliberately partial
            declaration.** This is the app's first plain-click menu trigger — `menuClick` is new —
            so it inherits nothing, and the two halves of the declaration cost very different
            things. The popup *kind* is a fact about this button and is free: without it NVDA
            announces "Manage Ordered, button" and a reader has no way to know a press opens
            anything. The expanded *state* is a fact about `ContextMenuProvider`, which holds the
            one open menu in state and publishes only `openMenu`/`closeMenu` — every other popup
            trigger in the app (`AnchoredPopup`, `Submenu`) owns its own open flag and this one
            cannot, because the panel is mounted at the app root and closes by routes this card
            never hears about. Publishing it would put the open menu's identity in the context value
            and re-render every card surface in the app on each open. A static `aria-expanded="false"`
            that never changed would be worse than none — it is an assertion, and it would be wrong
            for exactly as long as the menu is up. */}
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
 * The wishlist's **up one level** tile — the level above this one, drawn as a drawer among the
 * drawers so a wish can be dropped back out of a folder as easily as it was dropped into one.
 * Issue #283.
 *
 * `ParentFolderCard` is the whole of what it looks like; what is here is the pair of drop targets,
 * which is the part that is the wishlist's own. Both register on the **same `<li>`** — the tile
 * has one landing, so it needs none of the geometry a folder card's second box exists for, and
 * `readWishDrag` and `readFolderDrag` are disjoint, so `accepts()` keeps the two apart.
 *
 * **The folder half ignores the edge on purpose.** {@link useFolderDropTarget} divides a target
 * into before / inside / after because a folder card offers three landings; this tile offers one,
 * and the wall is not the level the dragged folder would be joining, so "beside this tile" is not
 * a position that exists. Every part of it means *up there*, and `edge !== null` is therefore the
 * whole of "the pointer is on this tile and it would take what you are holding".
 *
 * It is not draggable and carries no `⋯`: the level above is a row of the wall one level up, and
 * that is where it can be renamed, re-filed or deleted.
 */
export function WishParentFolderCard({
  label,
  onOpen,
  canDrop,
  onDropWish,
  canDropFolder,
  onDropFolder,
}: {
  /** The parent folder's name, or `Wishlist` at the root — the breadcrumb's own word for the
   *  same place, so the tile and the trail above it cannot name one destination two ways. */
  label: string;
  onOpen: () => void;
  /** Whether the level above would take the wish in the air — the page's own `canFile` bound to
   *  the destination, so a wish already filed there draws no ring rather than a ring that does
   *  nothing. */
  canDrop: (drag: WishDrag) => boolean;
  onDropWish: (drag: WishDrag) => void;
  /** The other drag: a **folder** moved up out of the level on screen, landing last in the level
   *  above. Answered by the page, which is what holds the cabinet the order comes from. */
  canDropFolder: (drag: FolderDrag) => boolean;
  onDropFolder: (drag: FolderDrag) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const { armed, over } = useWishDropTarget({ ref, canDrop, onDrop: onDropWish });
  const { armed: folderArmed, edge } = useFolderDropTarget({
    ref,
    scope: "wishlist",
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
 * would mean widening it to `FolderLike` plus a scope argument *and* making a wishlist card
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
  folder: WishlistFolder,
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
        scope: "wishlist",
      }),
    });
  }, [ref, id]);
}
