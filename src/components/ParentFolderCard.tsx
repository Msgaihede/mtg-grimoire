/**
 * The tile that goes back **up** — the level above, drawn as a folder card among the folder cards
 * so that a card, or a folder, can be dropped on it. Issue #283.
 *
 * **The gesture it exists for was one-way until now.** A folder card only ever takes a card
 * *deeper*: drop on `Ordered` and the wish goes into `Ordered`. The only target that took one
 * back out was a **breadcrumb segment** — a word of `text-sm` in a bar above the wall, which is a
 * ~20px-tall target a reader has to aim at while holding a drag, standing beside 62px tiles that
 * are the obvious place to let go. So a reader who filed a card into a folder by dragging had, in
 * practice, to reach for the row menu's `Move to folder…` to undo it. This is the drawer-sized
 * target that was missing, and it sits where the reader is already looking.
 *
 * **It is dashed, and that is not a copy of the folder card's dash — it is the same claim.**
 * Across this app a dashed edge means *provisional: a container rather than a thing you own*
 * (`WishFolderCard`'s doc argues it in full, and `NewFolderCard`'s argues the converse for a
 * control). This tile **is** a container — it is the folder one level up, drawn from the outside —
 * so it wears the dash for exactly the reason every other folder does. `NewFolderCard` beside it
 * stays solid, and the wall still says the two things it has always said: dashed is a drawer,
 * solid is a button.
 *
 * **Its footprint is a folder card's, to the pixel, and by the same construction rather than by a
 * copied number**: a `text-sm` line holding a `size-3.5` glyph and a name, `mt-1`, then a
 * `text-xs` second line — 62px at `p-2.5` with two hairlines, which is the height
 * `NewFolderCard`'s `FOLDER_CARD_HEIGHT` was measured against. Where a folder card's second line
 * is `6 wishes · $312.00` this one says {@link UP_ONE_LEVEL}, which is what keeps the two apart
 * on a wall where they are otherwise the same shape: the **name** is the destination, because
 * that is what a reader needs to read before letting go, and the second line is what the tile
 * does with it.
 *
 * **No `⋯`, and therefore no `pr-9`.** The level above is not a row this wall may rename, move or
 * delete — the card for it lives on the wall one level up, where it is a sibling of its own
 * siblings and the menu makes sense. The name takes the full width instead, which is the width a
 * long folder name needs most on the one tile that cannot be scrolled past.
 *
 * **One element carries both drop targets, where a folder card carries two.** Those cards keep a
 * separate `slot` box because `useFolderDropTarget` divides a target's border box into three
 * landings and the geometry has to be exactly the card's. This tile has **one** landing —
 * everything on it means "up there" — so there is no geometry to keep and no second box to keep
 * it on. `@dnd-kit/dom` keys its droppable registry by entity id rather than by element, so two
 * droppables on one `<li>` both register, and `accepts()` keeps them apart: `readWishDrag` and
 * `readFolderDrag` are disjoint by construction, and only one thing is ever in the air.
 *
 * **Presentational, and deliberately so.** The three walls that draw it — the wishlist's, the
 * collection's and the deck gallery's — each have their own payload, their own "may this land
 * here" and their own hook to ask it with (`useWishDropTarget`, `useCollectionDropTarget`,
 * `useDeckDropTarget`). Those differ; the tile does not. So the hooks stay in the three thin
 * wrappers beside each page's own folder card, and what is shared is the one thing that would
 * otherwise be written three times and drift twice.
 */
import type { ReactElement, RefObject } from "react";
import { FolderUp } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The second line, and the phrase the accessible name is built from.
 *
 * One constant rather than three spellings: the tile's own name is the **destination**, so this
 * is the only thing on it that says what pressing it does, and a wall that said "Up one level" on
 * one page and "Back" on another would be two vocabularies for one gesture. Exported because the
 * three wrappers' tests address the tile by it.
 */
export const UP_ONE_LEVEL = "Up one level";

/**
 * The accessible name, built from the destination rather than replacing it.
 *
 * `Up one level to Trade binder` — both visible strings, in the order they are read, which is
 * WCAG 2.5.3 satisfied by containment rather than by an `aria-label` that says something else
 * entirely. A screen reader announcing only the folder's name would make this tile
 * indistinguishable from the card for that same folder one level up.
 */
export function upCardName(label: string): string {
  return `${UP_ONE_LEVEL} to ${label}`;
}

export function ParentFolderCard({
  cardRef,
  label,
  armed,
  over,
  onOpen,
}: {
  /**
   * The `<li>`, which is where both drop targets are registered and where the ring is drawn.
   *
   * Owned by the wrapper rather than by this component, because the wrapper is what calls the
   * hooks — a ref created here would have to be handed back out, and there is no point in the
   * lifecycle at which that is safe.
   */
  cardRef: RefObject<HTMLLIElement | null>;
  /** What the level above is called: the parent folder's name, or the page's own word for the
   *  root — `Wishlist`, `Collection`, `All decks`, the same word its breadcrumb or tree uses. */
  label: string;
  /** Something this tile would take is in the air. Raises the ring on **every** eligible target
   *  at once, which is what tells a reader mid-drag where they may let go. */
  armed: boolean;
  /** …and the pointer is on this one. */
  over: boolean;
  onOpen: () => void;
}): ReactElement {
  const tip = useTooltip();
  return (
    <li ref={cardRef} className={cn("relative rounded-xl", armed && DROP_RING)}>
      <button
        type="button"
        aria-label={upCardName(label)}
        onClick={onOpen}
        className={cn(
          // `h-full` for `NewFolderCard`'s reason and by its mechanism: the `<li>` is the grid
          // item and grid items stretch to their row, so the tile matches the tallest card beside
          // it. On the wishlist's and the collection's walls every tile is the same 62px and this
          // changes nothing; on the deck gallery's, where a folder card carries a 96px strip of
          // art and scales with the zoom, it is what keeps the tile from floating at the top of a
          // cell twice its height. No floor is needed under it — this tile's own two lines are a
          // folder card's 62px by construction, which is the height that floor was measured at.
          // A column that centres what is in it rather than a block, which is a no-op on the two
          // walls where every tile is 62px — the content is exactly the box there — and is the
          // whole difference on the deck gallery's, where a folder card carries a 96px strip and
          // grows with the zoom. Two lines pinned to the top-left of a cell three times their
          // height read as a card whose picture failed to load.
          "flex h-full w-full flex-col justify-center rounded-xl text-left",
          "border border-dashed border-border p-2.5",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          // One wash for both drags, because only one thing is ever in the air, and because this
          // tile has one landing: a card over it and a folder over it are the same claim — what
          // you are holding goes *up there*.
          over && cn("border-accent", DROP_OVER),
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2">
          {/* The folder silhouette the wall is full of, with the direction drawn inside it —
              rather than a bare arrow, which would read as a control among containers. */}
          <FolderUp className="size-3.5 flex-none text-dim" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm" {...tip(label, { whenClipped: true })}>
            {label}
          </span>
        </span>
        <span className="mt-1 block truncate text-xs text-dim">{UP_ONE_LEVEL}</span>
      </button>
    </li>
  );
}
