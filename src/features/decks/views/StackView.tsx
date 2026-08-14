/**
 * The deck as stacks of cards in columns — the default view, and the one the redesign is
 * built around.
 */
import { useRef } from "react";
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { DEFAULT_ZOOM } from "@/lib/cardZoom";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import type { Marketplace } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { CardStack, STACK_CARD_BORDER, stackCardWidth, stackHeight } from "../CardStack";
import { deckGroupProps, useCategoryDrop, type DeckCardActions } from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import type { ValidationIssue } from "../validation/types";
import { packColumns } from "./columns";
import { GroupHeader } from "./GroupHeader";

/**
 * The group section's own `p-1.5`, one side — 6px, read off the class below.
 *
 * It does not zoom, and neither does the hairline beside it: padding and a border are chrome
 * *around* a card rather than part of one, and a reader who asks for bigger cards is not asking
 * for a thicker gutter. That is why {@link stackColumnWidth} adds them rather than scaling 224.
 *
 * **That hairline is the section's own and it is `border-transparent` at rest** (changed
 * 2026-08-14 — `StackGroup` has the whole of why). It used to be called "the card's border" here,
 * which was wrong even before it stopped painting: `STACK_CARD_BORDER` is a length, and the two
 * edges the sum below reserves are drawn by the `<section>`, not by anything inside it. A border
 * that paints nothing still occupies its 1px, so the box the arithmetic depends on is intact —
 * but that is only true while the *class* survives. Clearing the colour is the change that was
 * made; deleting the class is the one that would make every card 2px wider than
 * `stackCardWidth()` says it is.
 */
const SECTION_PADDING = 6;

/**
 * How wide a column is at this zoom — **the card, plus the chrome the card sits in**.
 *
 * The direction of this derivation is the whole of what makes the view survive a zoom, and it is
 * the reverse of what it used to be. The column was a fixed `14rem` off the design canvas (224px,
 * which a 1280px window fits five of beside the stats panel) and `CardStack` subtracted the
 * padding and the borders from it to learn what a card was. Now the card is the given —
 * `stackCardWidth(zoom)` — and the column is whatever holds it.
 *
 * Two numbers scaled independently would agree at 1× and drift everywhere else: at 1.1 a column
 * of `round(224 × 1.1) = 246` around a card of `round(210 × 1.1) = 231` leaves 15px of padding
 * where the classes draw 14, and the card would be stretched a pixel wider than the height its
 * own aspect ratio was computed from. Derived, the two cannot disagree at any stop on the ladder.
 *
 * At 1× it is 210 + 12 + 2 = 224, which is the `14rem` this replaced, exactly.
 *
 * **The `2 × STACK_CARD_BORDER` term is the `<section>`'s own hairline, and it is transparent.**
 * It is a real 1px of border box either side whether or not a line is painted in it, so the
 * width did not move when `StackGroup` stopped drawing the outline. Worth stating because the
 * term now names a length nobody can see: it is a *box*, not a decoration, and it is what keeps
 * the card inside filling exactly {@link stackCardWidth}.
 */
export function stackColumnWidth(zoom: number): number {
  return stackCardWidth(zoom) + 2 * SECTION_PADDING + 2 * STACK_CARD_BORDER;
}

/**
 * How a test finds a column. An attribute rather than a role, because a column is a *layout*
 * and carries no meaning for a reader — `packColumns` decides which groups share one, and the
 * only claim worth pinning is that it decided rather than dropped everything into one box.
 * `DropIndicator`'s `DROP_LINE_ATTR` and `cardControl`'s `DECK_GROUP_ATTR` are the same idea for
 * the same reason.
 */
export const STACK_COLUMN_ATTR = "data-stack-column";

/**
 * How a test finds the one column that does **not** scroll — the sideboard, held against the
 * right edge while the deck runs past under it.
 *
 * It is a second attribute rather than a value on {@link STACK_COLUMN_ATTR}, because the element
 * carries both and the two claims are independent: it *is* a column (same width, same gap, same
 * `StackGroup`s inside, and a sweep counting columns must still count it) and it is *also* the
 * pinned one. A test that wants "every column" and a test that wants "the pinned column" then ask
 * two questions of one element instead of one question with a special case in it.
 *
 * **The pinned column exists only when a `side` group does**, which is why a probe that finds
 * nothing here is an answer rather than a failure: a deck with no sideboard draws no such column,
 * and neither do the two derived grouping modes — see {@link StackView} for why that needs no
 * check of its own.
 */
export const STACK_PINNED_ATTR = "data-stack-pinned";

/**
 * A group's height in the column, header and padding included, so the packer can fill a
 * column without measuring anything.
 *
 * The 46px is the two-line header plus the section's own padding, and the 20px is the gap to
 * the next group. Both are read off the classes below; if either changes here, the packing
 * gets slightly worse and nothing breaks — which is the right failure for a number that is
 * about how full a column looks. Neither zooms: the header is text at a fixed size and the gap
 * is chrome, so only the stack in the middle grows.
 *
 * **The zoom has to reach this or the pack is wrong**, which is the one failure here that is not
 * cosmetic: a 2× stack is more than twice as tall, so a packer working from unzoomed heights
 * would fill every column to roughly half of what it thought and the last group in each would
 * run off the bottom of the desk. It defaults for the callers that legitimately mean "the base
 * geometry" — the stories, and the tests that pin the 1× sums.
 */
export function groupHeight(group: CardGroup, zoom: number = DEFAULT_ZOOM): number {
  return 46 + stackHeight(group.cards.length, zoom) + 20;
}

/**
 * How tall a column is allowed to get before the next group starts a new one.
 *
 * A default rather than a measurement, because this view has no business observing its own
 * box: the editor knows the height of the scroller it puts this in and passes it. 640 is a
 * 1280×800 window's content area with the ribbon, the toolbar and a little air.
 */
export const DEFAULT_COLUMN_HEIGHT = 640;

export function StackView({
  groups,
  marketplace,
  violations,
  onSelect,
  actions,
  columnHeight = DEFAULT_COLUMN_HEIGHT,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace every price in this view is quoted from — the heading's total and each
   *  card's own unit price. One value for the whole view, so the two cannot disagree. */
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here, and where a dropped one lands. See
   *  {@link DeckCardActions}; omitted, this view is exactly what it always was. */
  actions?: DeckCardActions;
  /** The height of the box this is being drawn into. See {@link DEFAULT_COLUMN_HEIGHT}. */
  columnHeight?: number;
  className?: string;
}) {
  const cardZoom = useAppStore((s) => s.cardZoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ctrl+wheel, on the element that scrolls: this view is the whole desk, and a wheel event
  // bubbles from whichever card the pointer is over up to here — including from the gaps between
  // the columns, which belong to no card at all. A native non-passive listener is what the hook
  // is for; React's own wheel listeners are passive and could not `preventDefault`, so WebView2
  // would zoom the entire window underneath the cards.
  useCardZoomGesture(scrollRef);

  // Sized from the same zoom the stacks inside are, so the column is exactly the card plus its
  // chrome at every stop on the ladder. A px number in an inline style rather than the `14rem`
  // this replaced, because a computed Tailwind class emits no CSS rule at all.
  const columnWidth = stackColumnWidth(cardZoom);
  // **The split happens before the pack, and it has to.** `packColumns` fills a column to
  // `columnHeight` in the reader's own order and never re-orders anything — so a sideboard left
  // in that stream lands in whichever column happened to have room for it, twelve columns to the
  // right of the window's edge on a deck of any size. A column held against that edge is not a
  // column the packer may put anything in, so it is taken out of the packer's input rather than
  // pulled back out of its answer. Both halves keep their existing order: this is a partition,
  // never a sort.
  //
  // **`kind === "side"` is the whole test, and there is deliberately no grouping-mode check to go
  // with it** — not because the other two modes cannot produce a pinned column, but because
  // `kind` is already the honest answer in all three.
  //
  // Under `Group by mana value` and `Group by type`, `buildGroups` buckets only the *active*
  // cards, and each bucket it invents carries `kind: null` — "Mana value 3" has no rules role, so
  // it can never be pinned. But the derived arm does not stop there: it appends every
  // **switched-off** pile as itself, `categoryGroup` and all, so a Sideboard the reader has
  // switched off arrives in those modes still carrying `kind: "side"` and this split still pins
  // it. That is the right answer — it is the same pile, it is still a drop target, and
  // `buildGroups` was already sending it to the right-hand end of the list — and reading it off
  // `kind` is what gets it right for free.
  //
  // A mode check would be a second place to state what `CardGroup` already carries, and it would
  // get exactly that case wrong: it would unpin a pile that ought to stay pinned, in the two
  // modes where it is the only category on the desk.
  const pinned = groups.filter((group) => group.kind === "side");
  const flowing = groups.filter((group) => group.kind !== "side");
  // The pack has to see the zoom too — a taller stack is fewer groups to a column. Wrapped
  // rather than passed by name, because `packColumns` takes a measurement of one item and knows
  // nothing about decks, let alone about how big the reader is drawing them.
  const columns = packColumns(flowing, (group) => groupHeight(group, cardZoom), columnHeight);

  return (
    // Scrolls both ways: sideways because a fifteen-category deck is more columns than a
    // window is wide, and down because a lifted card at the foot of a column overflows its
    // group on purpose and has to have somewhere to go.
    <div
      ref={scrollRef}
      className={cn("flex min-w-0 flex-1 gap-4 overflow-auto pb-2", className)}
    >
      {columns.map((column, index) => (
        <div
          // By position, and that is safe here in the way a table row's key is not: a column
          // is not a thing the reader can address, and its identity is exactly "the nth
          // column of this layout".
          key={index}
          {...{ [STACK_COLUMN_ATTR]: "" }}
          style={{ width: columnWidth, flex: `0 0 ${columnWidth}px` }}
          className="flex flex-col gap-5"
        >
          {column.map((group) => (
            <StackGroup
              key={group.key}
              group={group}
              marketplace={marketplace}
              violations={violations}
              onSelect={onSelect}
              actions={actions}
              zoom={cardZoom}
            />
          ))}
        </div>
      ))}

      {/* **The sideboard, held against the right edge while the deck scrolls under it.**

          Drawn last in the document on purpose, and not merely because that is where the flex
          line puts it. `sticky right-0` inside this scroller keeps it in view at every scroll
          offset, `bg-bg` is what makes the columns passing behind it *pass* rather than show
          through, and {@link LAYER.raised} is what puts it over them at all.

          **Document order is doing real work at that rung.** An open card's list takes
          `LAYER.raised` too (`CardStack`), and equal z-indexes resolve by document order — so the
          last element at the rung wins, and this is the last element. That is the outcome wanted
          rather than a coincidence tolerated: a card opened in a column halfway off the screen
          overflows its group by 293px on purpose, and it must pass *under* the pinned sideboard,
          not over it, or the reader is reading a card through a column that is meant to be
          covering it.

          **No height, deliberately.** A flex line stretches its items (`align-items: stretch` is
          the default), so this column is already exactly as tall as the tallest packed column
          beside it — which is what makes the `bg-bg` backdrop cover the full height of whatever
          scrolls behind it. Any height here would be a second answer to a question the flex line
          has already answered correctly, and a wrong one at every zoom but the one it was
          measured at. */}
      {pinned.length > 0 && (
        <div
          // Both attributes, because both claims are true of this element — see
          // {@link STACK_PINNED_ATTR}. The same inline width as every packed column, off the same
          // `stackColumnWidth`: a pinned column is a column, and a sideboard drawn at a different
          // width from the pile beside it would read as a panel rather than as part of the deck.
          {...{ [STACK_COLUMN_ATTR]: "", [STACK_PINNED_ATTR]: "" }}
          style={{ width: columnWidth, flex: `0 0 ${columnWidth}px` }}
          className={cn(
            "sticky right-0 flex flex-col gap-5 bg-bg",
            LAYER.raised,
            // A soft shadow thrown *leftward*, onto what is sliding under it. It is the only
            // thing that says this column is in front: every column here is the same width on
            // the same background, so without it a reader watching the deck scroll sees one
            // column mysteriously refusing to move. Deep alpha for the app's felt, as
            // `CardStack`'s own shadows are and for the same reason — 0.1 is not a shadow at
            // 0.16 lightness.
            "shadow-[-8px_0_16px_-4px_rgb(0_0_0/0.45)]",
          )}
        >
          {pinned.map((group) => (
            <StackGroup
              key={group.key}
              group={group}
              marketplace={marketplace}
              violations={violations}
              onSelect={onSelect}
              actions={actions}
              zoom={cardZoom}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One pile: its heading, its stack, and the place a dragged card can be let go.
 *
 * A component of its own rather than markup inside the `map` above, because a drop target is a
 * hook and a hook cannot be called per item of a list. The same shape the other three views
 * take, for the same reason.
 */
function StackGroup({
  group,
  marketplace,
  violations,
  onSelect,
  actions,
  zoom,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** The zoom the column above was sized from, handed straight through to the stack so the two
   *  are the same number rather than two reads of one store. */
  zoom: number;
}) {
  const { attach, over, eligible } = useCategoryDrop(group.categoryId, actions?.drop);

  return (
    <section
      ref={attach}
      aria-labelledby={`group-${group.key}`}
      // The caret lands here when a card leaves the pile under it — a stepper reaching zero, or
      // a move landing somewhere else — so the reader is left looking at the pile that changed
      // and hears its name. `tabIndex: -1`, so it is a place focus can be *put* and never a
      // stop Tab has to travel through.
      {...deckGroupProps(group.categoryId)}
      className={cn(
        // **`border-transparent`, and it is not the same thing as having no border.** The card
        // inside fills this section's content box, and `stackColumnWidth` is
        // `stackCardWidth(zoom) + 2·SECTION_PADDING + 2·STACK_CARD_BORDER` — that last term is
        // *this* hairline. Drop the class and the content box grows by 2px, so every card paints
        // 2px wider than `stackCardWidth()`, which is the one number the whole `CardStack` file's
        // arithmetic is derived from; nothing would go red and every card in the view would be
        // very slightly the wrong shape. Transparent keeps the box and paints nothing, which is
        // the whole of what was wanted here: a pile of cards on the desk, not a pile of cards in
        // a box. See {@link SECTION_PADDING}.
        "relative rounded-lg border border-transparent p-1.5",
        // A switched-off pile is a wash and nothing else now. It used to be a *dashed* outline
        // over a fainter one (`bg-surface/40`), and the dash was the signal — which only worked
        // while every other pile carried a solid outline for it to differ from. With no outline
        // anywhere the dash had nothing to be different from, so the wash goes up and takes the
        // whole job. It is still one of three things saying it: this, `GroupHeader`'s dimmed name
        // and `INACTIVE` chip, and the stack's own `opacity-60` below. An active pile carries
        // none of the three, which is the right asymmetry — being in the deck is the default, and
        // being switched off is the fact worth spending marks on.
        !group.isActive && "bg-surface/60",
        // `AppShell`'s pair, as in the other three views, and **the border going away changed
        // nothing here.** A `ring` is a box shadow drawn *outside* the border box, so the drop
        // affordance never depended on there being a line to draw it against or to overwrite —
        // it is painted in the same place, at the same width, on a section whose own edge is now
        // invisible. Said out loud because it is the first thing a reader will suspect: taking an
        // outline away from a drop target looks exactly like the change that would have broken
        // one, and this is not it.
        eligible && DROP_RING,
        over && DROP_OVER,
      )}
    >
      {/* The app's own drop mark, the same one the deck's columns used to draw. */}
      {over && <DropIndicator />}
      <GroupHeader
        group={group}
        marketplace={marketplace}
        layout="stacked"
        id={`group-${group.key}`}
        className="px-1 pb-1.5"
      />
      {group.cards.length === 0 ? (
        // An empty category is a place as well as a heading — this is where the next card
        // goes, and saying so is what makes the empty column worth drawing.
        <p className="px-1 pb-1 text-xs text-dim">Nothing here yet.</p>
      ) : (
        <CardStack
          cards={group.cards}
          label={group.name}
          currency={marketplace.currency}
          violations={violations}
          onSelect={onSelect}
          actions={actions}
          zoom={zoom}
          // The third of the three signals a switched-off pile carries — the wash on the section
          // and `GroupHeader`'s dimmed name and `INACTIVE` chip are the other two. Card art is the
          // loudest thing in this view by a wide margin, so a pile whose *chrome* says "not in
          // the deck" while its cards read at full strength says it twice as quietly as it meant
          // to. 60 % is far enough back to sort at a glance and near enough to still read.
          //
          // **`opacity` below 1 makes this `<ul>` a stacking context**, and that `<ul>` is exactly
          // the element that takes `LAYER.raised` when a card in it opens. The lift survives it —
          // what comes forward over the groups below is the whole raised list, and the raised
          // list *is* this new context's root, so it moves as one — but this is the first thing
          // to check if that lift ever regresses on an inactive pile. It is the only place in
          // this view where a stacking context appears out of a property that is not a z-index,
          // and `layers.ts`' sweep cannot see it.
          className={group.isActive ? undefined : "opacity-60"}
        />
      )}
    </section>
  );
}
