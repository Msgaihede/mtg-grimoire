/**
 * The deck as a table: one row per card, under a band naming its group.
 *
 * The view to reach for when the question is comparative — what is dearest, what is not
 * owned, what is labelled. It is the app's one `VirtualTable` and not a fourth table of its
 * own, which is what keeps the row pitch, the sticky header, the focus ring and the
 * interactive-cell guards identical to the collection's and the wishlist's.
 *
 * **Its headers do not sort, and that is the one deliberate difference from the other
 * three.** The deck's order is the toolbar's — one Group by and one Sort, which together
 * decide both the bands and the rows inside them — and a header that re-sorted would give one
 * list two orders with no way to see which was in force. A press on a header would also have
 * to say what it meant to do to the grouping, which is a question the toolbar has already
 * answered.
 *
 * **It is drawn at its full height, and it stopped being the deck's scrollport exception to be
 * so.** The other three views were given no height on 2026-08-14 because a view scrolling
 * inside a page that also scrolls is two scrollbars an inch apart moving different things;
 * this one was left out of that change on the ground that `VirtualTable` *is* a scroller, so
 * with no height of its own it drew its own scrollbar **and** the page's. `VirtualTable.grow`
 * is the other way out of that: the whole list in normal flow, no local scroller, and the page
 * — `AppShell`'s `main` — taking the scroll like it does for Stacks, Grid and Text. Legal here
 * because a deck is a few hundred rows at the very most, which is exactly what that prop asks a
 * caller to be able to promise; the search, the collection and the wishlist draw this same
 * table over 100k rows and pass nothing.
 */
import { useCallback, useMemo } from "react";
import { Crown } from "lucide-react";
import { OwnedBadge } from "@/components/OwnedBadge";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import {
  VirtualTable,
  type RowRenderProps,
  type TableColumn,
} from "@/components/table/VirtualTable";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { cn } from "@/lib/utils";
import {
  DeckFinishMark,
  LabelDot,
  rowMarkColor,
  theoryMatchLabel,
  TheoryMatchBadge,
} from "../CardMarks";
import {
  deckCardDimmed,
  deckCardMarked,
  deckCardProps,
  deckCardSelectedProps,
  DeckCardControls,
  deckGroupMenuProps,
  deckGroupProps,
  deckGroupRename,
  LandedMark,
  useCategoryDrop,
  useDeckCardDrag,
  type DeckCardActions,
} from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import { theoryMatchMark, type TheoryMark, type TheoryPlan } from "../theoryMatch";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
import { splitRail } from "./columns";
import { GroupHeader } from "./GroupHeader";

/**
 * What one row of the flat list is. A table with bands is a flat list of two kinds of thing,
 * because a nested list would have to be flattened at render time anyway, and then the row
 * indices a screen reader is told would be a different set from the ones the table is
 * counting — `aria-rowindex` runs down one sequence and a `<section>` per group cannot be in
 * it. (It was also what a virtualiser can measure, which is no longer a reason here: this view
 * passes `grow`, so no window is computed. The ARIA half is what the shape rests on now, and
 * it was always the half that could not be worked around.)
 */
type Row =
  | { kind: "group"; key: string; group: CardGroup }
  | {
      kind: "card";
      key: string;
      group: CardGroup;
      card: DeckCard;
      ruleBreakText: string | null;
      /** What the deck's plan says about this row — `theoryMatch.ts`'s `theoryMatchMark`.
       *  Resolved into the row rather than looked up in the cell, so the memo below is the one
       *  place the plan is read. `null` is a card the plan does not ask for; otherwise the tier
       *  it is in and the difference at that tier's own grain. */
      theoryMark: TheoryMark | null;
    };

/**
 * How much taller a band gets while its pile is being renamed — **and under `grow` it is a
 * floor rather than a contract, which is a weaker promise than this comment used to make.**
 *
 * The other three views draw a pile as a `<section>` in normal flow, so a field appearing under
 * the heading pushes what is below it and nobody has to declare anything. This one used to be
 * the opposite case: `VirtualTable` gave every row `height: v.size` off `estimateSize`, so a
 * band that grew without saying so was painted over by the row below it — *"a virtualiser told
 * every row is 44px would overlap the one below it by exactly that band"* — and an un-declared
 * rename field covered the first card of the pile. With `grow` the row carries `minHeight`
 * instead and nothing has to be told: a band that outgrows this number simply makes its row
 * taller. So the number is still worth being right, because it is what the row is sized at
 * before anything measures — and being wrong costs a little slack rather than a covered card.
 *
 * **48px**, and it is arithmetic rather than a guess: `RenameField`'s form is `mt-2 … pt-2`
 * (8 + 8) around a row whose tallest children are `META_FIELD` and `META_SUBMIT`, both `h-8`
 * (32) — 8 + 32 + 8 = 48. That is the one-line case. **The paragraph that used to follow —
 * that a very narrow table would wrap Save onto a second line and want 48 more — is gone with
 * the fixed height**: a wrapped form now grows the row it is in.
 */
const RENAME_HEIGHT = 48;

export function TableView({
  groups,
  marketplace,
  tracksCollection,
  violations,
  theoryPlan,
  onSelect,
  actions,
  selectedSlot,
  landed,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace the Price column and every band's total are quoted from. One value for
   *  the whole view, so a band and the rows under it cannot name two currencies. */
  marketplace: Marketplace;
  /**
   * Does this deck read the collection at all? `deckKind.ts`'s `tracksCollection(deck)`, answered
   * by the host.
   *
   * `false` **drops the Owned column from the list**, and dropping it is the whole point rather
   * than an economy of markup. `OwnedBadge` already returns `null` for a row with nothing owned
   * and nothing wished, so a *Virtual* deck (issue #401) would draw a headed column that is blank
   * on every row of every deck — a question the table keeps asking and never answers, and one a
   * reader can only resolve by knowing a rule that is nowhere on screen. The column's own cell
   * guard is a different absence and stays: an inactive pile is one pile of a deck that *does*
   * own cards.
   *
   * **It is a column and not a cell, so the widths move with it.** The grid template is built from
   * this list, so a virtual deck's table spends the 4rem on the two flexible columns instead of on
   * an empty gutter — which is the same argument the `Move…` select's removal made about 72px of
   * empty gutter on every row.
   *
   * **Required rather than optional**, so a host that has not thought about it cannot silently get
   * the column back.
   */
  tracksCollection: boolean;
  violations?: Map<string, ValidationIssue[]>;
  /** The deck's plan — `theoryMatch.ts`'s two lookups and the deck's own two mark switches,
   *  handed in whole like `violations` beside it. `undefined` for a deck with no plan. */
  theoryPlan?: TheoryPlan;
  onSelect?: (card: DeckCard) => void;
  /**
   * What may be done to a card here — see {@link DeckCardActions}.
   *
   * **This view spends them as columns, where the other three draw them over the card**, and
   * that is the one difference worth having: a table's answer to "where does a control go" is
   * a column of its own, and an overlay would cover the very cells a reader came here to
   * compare. The controls themselves are `cardControl.tsx`'s, the same ones.
   */
  actions?: DeckCardActions;
  /** Which slot the open pane is about ({@link deckCardSlot}), so its row says so. By the slot
   *  rather than the printing; `CardStack` has why. */
  selectedSlot?: string | null;
  /** `deck_cards.id` → the nonce of the add that put it there, for the cards that have just
   *  landed. See `cardControl`'s `LandedMark`. */
  landed?: ReadonlyMap<number, number>;
  className?: string;
}) {
  const tip = useTooltip();
  const editable = actions?.setQuantity !== undefined;
  /**
   * The bands and their rows, flattened — **through {@link splitRail}, which makes this the last
   * of the four views to read the deck in the order the deck is laid out** (2026-09-08).
   *
   * This view mapped `groups` straight through, and on a real Commander deck that read
   * `Commander → Sideboard → Maybeboard → the deck`: the piles the reader has said are played
   * *beside* the deck, or not played at all, came first because they are seeded early in
   * `PREDEFINED_CATEGORIES` and this list was in `sortOrder`. `StackView` and `TextView` have
   * called `splitRail` since it existed and `GridView` joined them earlier today, so leaving the
   * table out would have made it the one view where a reader's Sideboard is somewhere else — one
   * deck laid out two ways, one toolbar press apart, which is the failure this folder's rules keep
   * naming.
   *
   * **The rail is drawn as bands in place, not as a column**, exactly as on the grid: a table has
   * one axis, so what `splitRail` decides here is only *when* a band is reached — the command zone
   * first, the deck, then the Sideboard, the Maybeboard and every switched-off pile last. Nothing
   * inside a run is re-ordered, which is that function's own law.
   *
   * **It also closes the one place the arrow walk and the drawn order disagreed.**
   * `deckWalk.ts`'s stops are derived through the same `splitRail`, so until now a caret stepping
   * through this deck and the bands a reader was looking at could name the piles in two different
   * orders. All four views and the walk are one answer now.
   */
  const rows = useMemo<Row[]>(() => {
    const { command, flow, rail } = splitRail(groups);
    return [...command, ...flow, ...rail].flatMap((group) => [
      { kind: "group" as const, key: `g-${group.key}`, group },
      ...group.cards.map((card) => ({
        kind: "card" as const,
        key: `c-${group.key}-${card.id}`,
        group,
        card,
        ruleBreakText: ruleBreak(violations?.get(card.cardId)),
        theoryMark: theoryMatchMark(theoryPlan, card),
      })),
    ]);
  }, [groups, violations, theoryPlan]);

  const columns = useMemo<TableColumn<Row>[]>(
    () => [
      {
        key: "quantity",
        // Wide enough for the stepper, and no wider — a read-only deck table should not carry
        // an empty gutter, and neither should an editable one.
        //
        // **11rem → 6.5rem when the `Move…` select was removed** (2026-08-14), and the number
        // is the same kind of measurement the old one was: the stepper at `xs` is two `size-5`
        // buttons either side of an `h-5 w-8` box with `gap-1` between them, which is
        // 20 + 4 + 32 + 4 + 20 = **80px**, and `VirtualTable`'s cell padding takes the rest of
        // the 104. The 11rem it replaces was three passes' worth of clearing the select as
        // well: at 8.5rem the cell's own content was 154px in a 136px column and the select was
        // clipped by 18px, 10rem left 6px over and 10.5rem left 2. Keeping 11rem would have
        // left **72px of empty gutter on every row of every deck** — the exact thing the
        // read-only arm exists to avoid.
        //
        // **The game changer's crown moved into this column on 2026-09-08 and neither arm had
        // to grow for it**, which is worth the arithmetic because the paragraph above is what
        // any widening here has to answer to. A `6.5rem` track is **104px** and the crown costs
        // an 11px gutter plus this cell's own `gap-1`: 11 + 4 + 80 = **95px**, so the editable
        // arm keeps **9px** in hand. The pair is centred in the track the way the bare stepper
        // was, which moves the stepper itself 7.5px right (12px of slack a side became 4.5) —
        // the alternative is a left-aligned group with all 9px on one edge, and a stepper the
        // reader aims at all day is better centred than a gutter that is usually empty.
        // The read-only arm is a `3rem` (48px) track holding 11 + 4 + one `ch` of
        // the mono face (~7px at `text-xs`) = **~22px**, so it has more than half the column
        // spare. Neither number was invented for the crown — the 80 and the 104 are the
        // measurements above, unchanged.
        width: editable ? "6.5rem" : "3rem",
        header: "Qty",
        // `interactive` is the whole of what keeps a press on `−` from also opening the card
        // and a typed `12` from scrolling the list a screenful — `VirtualTable` applies
        // `data-no-drag` and swallows the click and the two activation keys.
        interactive: editable,
        cellClassName: editable ? undefined : "font-mono text-xs tabular-nums text-dim",
        // **The crown is drawn on both arms and the `sr-only` twin with it.** The mark says the
        // same thing whether or not the reader can edit the list, and this is the one view in
        // the app where a cell's text is really read — a row here is not an `aria-label`-ed
        // button — so this cell is where the words *Game changer* live now that the `GC` badge
        // in the name column has gone. Dropping them along with the badge would have been a
        // real regression on the only view that can say them.
        //
        // The gutter is reserved on every row, game changer or not: 11px, `shrink-0`, empty in
        // the ordinary case. A conditional element would make every row a different width and
        // the quantities would step in and out down a column of eighty — `rowMarkColor`'s own
        // reasoning, which returns `transparent` rather than nothing for exactly that reason.
        //
        // The crown carries the gold itself (`text-pie-gold`) rather than taking a colour from
        // something it is printed on: there is no filled chip in a table row, so the mark *is*
        // the colour — the same gold the name's stripe is drawn in. Nothing in this view zooms,
        // so every size here is a plain fixed number and no `--mark-scale` reaches it.
        cell: (row) => {
          if (row.kind !== "card") return null;
          const gameChanger = row.card.gameChanger === true;
          return (
            <span
              className={cn(
                "flex items-center gap-1",
                // The editable arm only: the 95px pair takes the centring the bare 80px
                // stepper had, which is the arithmetic in the width note above. The read-only
                // arm reads left to right off the column's edge, as the design draws it.
                editable && "justify-center",
                // The read-only arm inherits `text-dim` from `cellClassName` above; this is
                // what overrides it, and it tints the crown and the digits as one mark.
                gameChanger && "text-pie-gold",
              )}
            >
              <span aria-hidden="true" className="flex w-[11px] shrink-0">
                {gameChanger && (
                  <Crown className="block size-[11px]" strokeWidth={2.75} aria-hidden="true" />
                )}
              </span>
              {editable ? (
                <DeckCardControls card={row.card} actions={actions} className="flex-nowrap" />
              ) : (
                // One `ch` of the mono face is a single digit, so the numbers line up down the
                // column; a two-digit count simply takes its own min-content and stays right
                // aligned against the same edge.
                <span className="w-[1ch] text-right">{row.card.quantity}</span>
              )}
              {gameChanger && <span className="sr-only">Game changer</span>}
            </span>
          );
        },
      },
      {
        key: "name",
        /**
         * **The column this table exists for, and the one that was starving.**
         *
         * Measured in the shipped window: seven fixed columns took 696px of an 843px grid, so
         * the two flexible ones split 147px in a 2:1.5 ratio and the card name got **84px** —
         * about ten characters — while the usually-empty Labels column held 112px. A deck list
         * whose card names are unreadable is not a deck list.
         *
         * Two changes, and they work together. The fixed columns lost 72px between them (every
         * one still fits its own content, checked below), and the name now carries a **floor**
         * and the larger share. The floor is what makes it hold when the table is squeezed by
         * the stats block and the docked panel; `minmax(0,1fr)` on Type is what absorbs it, so
         * the name reaches its floor by taking from the column next to it rather than by
         * pushing the grid into a horizontal scroll.
         */
        width: "minmax(12rem,3fr)",
        header: "Card name",
        cell: (row) =>
          row.kind === "card" ? (
            <span
              // The stripe the text view uses, for the same reason and in the same two
              // colours: down a column of eighty rows it is what says where to stop.
              //
              // **It is the whole of what this column says about a game changer since
              // 2026-09-08.** The gold `GC` badge stood beside the name until then; the mark is
              // a gold crown in the quantity column now, with the count tinted to match, so
              // the fact is drawn once here instead of twice. The stripe itself is unchanged
              // and `rowMarkColor` still gives a rule break precedence over gold.
              style={{ borderColor: rowMarkColor(row.ruleBreakText, row.card.gameChanger) }}
              className="flex min-w-0 items-center gap-1.5 border-l-2 pl-2"
              // `describes: false` — the sr-only span below already puts "Rule break: …" in the
              // accessible tree, since a cell's text is really read here (unlike the other three
              // views' `aria-label`-ed button). A default binding would describe it twice.
              {...tip(row.ruleBreakText ?? undefined, { describes: false })}
            >
              <span className="min-w-0 truncate">{row.card.name}</span>
              {/* Which object this row plays, where there is no art to hang a chip on. Unlike
                  the tick below it needs no `sr-only` twin — see {@link DeckFinishMark}. */}
              <DeckFinishMark card={row.card} />
              {/* The plan's tick, and the `sr-only` twin the other three views cannot have:
                  a cell's text is really read, so this is the surface where the badge's word is
                  said rather than folded into `deckCardName`. The game changer's words are said
                  the same way and in the same view — they are in the quantity cell now, beside
                  the crown that replaced the badge that used to stand here. */}
              {row.theoryMark !== null && (
                <>
                  <TheoryMatchBadge tier={row.theoryMark.tier} delta={row.theoryMark.delta} />
                  <span className="sr-only">
                    {theoryMatchLabel(row.theoryMark.tier, row.theoryMark.delta)}
                  </span>
                </>
              )}
              {row.ruleBreakText !== null && (
                <span className="sr-only">Rule break: {row.ruleBreakText}</span>
              )}
            </span>
          ) : null,
      },
      {
        key: "manaCost",
        width: "5rem",
        header: "Mana cost",
        cell: (row) => (row.kind === "card" ? <ManaText source={row.card.manaCost} /> : null),
      },
      {
        key: "type",
        // Yields to the name: `minmax(0,1fr)` can shrink to nothing, which is how the name reaches
        // its floor without the grid overflowing.
        width: "minmax(0,1fr)",
        header: "Type",
        cellClassName: "truncate text-xs text-dim",
        // The front face, like everywhere else: a modal DFC's back is routinely a land while
        // its front is a spell.
        cell: (row) =>
          row.kind === "card" ? (row.card.typeLine ?? "").split("//")[0].trim() : null,
      },
      {
        key: "price",
        width: "5rem",
        header: "Price",
        headerTitle: pricesAsOf(marketplace),
        headerLabel: `Price. ${pricesAsOf(marketplace)}`,
        headerClassName: "text-right",
        cellClassName: "text-right font-mono text-xs tabular-nums",
        // The one price the read answered with, at the selected marketplace, and never a
        // chain to another one's: a deck card is priced at whichever finish that marketplace
        // sells its printing in, so this is an em dash exactly where that marketplace quotes
        // that printing in none of them.
        cell: (row) =>
          row.kind === "card" ? formatPrice(row.card.unitPrice, marketplace.currency) : null,
      },
      // **Spread away entirely for a deck with no collection behind it, rather than drawn empty**
      // (2026-09-08, issue #401). `OwnedBadge` answers `null` for a row that owns nothing and
      // wishes for nothing, so a Virtual deck left with this column has a heading over eighty
      // blank cells: a table asking one question of every row and answering it for none. The two
      // absences below are different in kind and both survive — an inactive pile is a fact about
      // one pile of a deck that does own cards, and a `0` there means *this deck reserved none*.
      //
      // Its position is unchanged for the decks that keep it: between Price and Labels, where a
      // reader comparing what is dearest and what is missing reads the two side by side.
      ...(tracksCollection
        ? [
            {
              key: "owned",
              width: "4rem",
              header: "Owned",
              // A switched-off pile is handed nothing out of the pool its list draws on, so a
              // badge there would read as "you own none of these" when the truth is "this deck
              // was handed none".
              //
              // **It draws on the Theory tab too since 2026-09-09**
              // ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)), and that is
              // a consequence rather than a decision made here. A theory row's `ownedQuantity`
              // used to be zeroed, and `OwnedBadge` answers `null` for a row that owns nothing
              // and wishes for nothing — so this column was silently blank on a plan. It counts
              // every copy the deck could use now, so the badge appears. That is right and it is
              // not the red `N/M` mark `deckCardShort` still keeps off a plan: this is a **count**
              // of what the reader has, where that is a **shortage** the plan cannot act on.
              cell: (row: Row) =>
                row.kind === "card" && row.card.categoryActive ? (
                  <OwnedBadge owned={row.card.ownedQuantity} />
                ) : null,
            },
          ]
        : []),
      {
        key: "label",
        // A dot and a truncated name; empty in most decks, and it was holding 112px while the
        // card name held 84.
        width: "5rem",
        header: "Labels",
        cell: (row) =>
          row.kind === "card" && row.card.labelName !== null ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <LabelDot name={row.card.labelName} color={row.card.labelColor} />
              <span className="min-w-0 truncate text-xs">{row.card.labelName}</span>
            </span>
          ) : null,
      },
      {
        key: "rarity",
        // Gem plus the word: "uncommon" measures ~62px with the gem, so 80 clears it.
        width: "5rem",
        header: "Rarity",
        cell: (row) =>
          row.kind === "card" ? <RarityGem rarity={row.card.rarity} withLabel /> : null,
      },
      {
        key: "printing",
        // "MH2 · 123" in the data face measures ~59px.
        width: "5rem",
        header: "Printing",
        cellClassName: "truncate font-mono text-xs text-dim",
        cell: (row) =>
          row.kind === "card"
            ? `${row.card.setCode.toUpperCase()} · ${row.card.collectorNumber}`
            : null,
      },
    ],
    [editable, actions, marketplace, tracksCollection, tip],
  );

  // Closed over the column count, because the band's one cell has to say how many columns it
  // stands in and the count is data here rather than a literal.
  //
  // A **component** rather than an element, because a row is a drag source and a drop target
  // and both of those are hooks — and a hook cannot be called from inside a `map` or a
  // callback. `DeckTableRow` is where they live; the band gets one too, so letting a card go
  // on a group's heading files it under that group like letting it go on any of its rows.
  /**
   * Which rows want more room than a row.
   *
   * It asks the same question the band's own render asks — is there a rename field for this
   * pile — by calling the same factory, so the height and the markup cannot disagree about
   * whether a field is there. Building an element to answer a boolean is a little wasteful and
   * is the price of one answer instead of two; a card row short-circuits on its kind before the
   * call.
   *
   * **Its identity still has to move when the answer does, and the reason is now smaller than
   * it was.** Under `grow` the row takes this as a `minHeight`, so a stale answer costs a band
   * that is 44px until React re-renders it rather than a band a card is drawn over — and
   * `VirtualTable`'s own height cache, which used to be the reason (`heightKey` is derived from
   * `[rows, extraHeight]`, and a rename does not change the *list*), is not read here at all
   * any more. Depending on `actions` is kept because that bag is rebuilt when the editor's
   * renaming pile changes, which is exactly when this answer moves.
   */
  const extraHeight = useCallback(
    (row: Row) =>
      row.kind === "group" && deckGroupRename(row.group.categoryId, actions) != null
        ? RENAME_HEIGHT
        : 0,
    [actions],
  );

  const drop = actions?.drop;
  const renderRow = useCallback(
    (props: RowRenderProps, row: Row) => (
      <DeckTableRow
        props={props}
        row={row}
        columns={columns.length}
        marketplace={marketplace}
        actions={actions}
        onDrop={drop}
        selected={row.kind === "card" && deckCardMarked(row.card, selectedSlot, actions)}
        landedKey={row.kind === "card" ? landed?.get(row.card.id) : undefined}
      />
    ),
    [columns.length, marketplace, actions, drop, selectedSlot, landed],
  );

  return (
    // **`min-w-0` where this carried `min-h-0`, which is the whole of the change on this
    // element.** `min-h-0` is the class that says *this box may be squeezed below its own
    // content*, and squeezing it is precisely what made the table scroll inside a page that was
    // already scrolling. The other three views' roots are `flex min-w-0 flex-1 flex-col`, and
    // this one is now the same: nothing bounds its height, so it grows to hold the table and
    // the page takes the scroll. `min-w-0` is the axis that does need saying — a grid of nine
    // tracks has a min-content width, and a flex item that could not shrink below it would push
    // a horizontal scrollbar across the whole deck builder, which the 1024px floor forbids.
    <div className={cn("flex min-w-0 flex-1 flex-col", className)}>
      <VirtualTable<Row>
        rows={rows}
        columns={columns}
        label="This deck"
        total={rows.length}
        // The deck is bounded and the page is the scroller — see this file's own header. This
        // is the one caller of `VirtualTable` that passes it.
        grow
        // A deck arrives whole — there is no next page, and the identity of the list is what
        // is in it, so a regrouping starts at the top.
        listKey={rows.map((row) => row.key).join("|")}
        onNeedNextPage={() => {}}
        // The toolbar owns the order; see this file's own note.
        sort={[]}
        onSort={() => {}}
        // A band whose pile is being renamed is taller than a row — see {@link RENAME_HEIGHT}.
        extraHeight={extraHeight}
        // The chords reach `deckCardPress` here as they do in the other three views; what differs
        // is that a press arrives through `VirtualTable`'s own row handler rather than through a
        // button of this view's own, so the mousedown half has nowhere to hang. A Shift-click on
        // a table row therefore drags a text selection where the other three views refuse one —
        // the price of not owning the element, and small enough to be worth naming rather than
        // fixing by pushing another handler into the table primitive for one caller.
        onActivate={
          onSelect || actions?.pick
            ? (row, event) => {
                if (row.kind !== "card") return;
                if (actions?.pick?.(row.card, event) === true) return;
                onSelect?.(row.card);
              }
            : undefined
        }
        isSelected={(row) => row.kind === "card" && deckCardMarked(row.card, selectedSlot, actions)}
        // The game-changer spotlight's mark. This view does not own its row element —
        // `VirtualTable` does — so it goes through the hook that already exists for exactly
        // this, beside `isSelected`. **Not a new prop on `VirtualTable`**: that is a shared
        // primitive drawn over 100k rows by three other surfaces, and this file's own notes
        // record the decision not to push a handler into it for one caller.
        //
        // The `kind === "card"` guard is the whole of what keeps a band out of it: a group's
        // heading is not a card, so it is neither lit nor faded — a run of dimmed bands would
        // say the piles themselves were the thing being passed over.
        rowClassName={(row) =>
          row.kind === "card" ? deckCardDimmed(row.card.gameChanger) : undefined
        }
        renderRow={renderRow}
      />
    </div>
  );
}

/**
 * One row of the table, as a component — which is what lets it be a drag source and a drop
 * target, since both are hooks and `renderRow` is a callback.
 *
 * **Every row of a group is a drop target for that group**, the band included: the bands are
 * this view's only heading, so a reader aiming a card at "Ramp" is aiming at the band, and a
 * target that covered only the cards would refuse the most obvious drop on the screen.
 */
function DeckTableRow({
  props,
  row,
  columns,
  marketplace,
  actions,
  onDrop,
  selected,
  landedKey,
}: {
  props: RowRenderProps;
  row: Row;
  columns: number;
  /** Only a band reads it — the heading it draws totals a pile. */
  marketplace: Marketplace;
  actions?: DeckCardActions;
  onDrop?: DeckCardActions["drop"];
  /**
   * This row is the card the pane is open on.
   *
   * **The surface colour is still `VirtualTable`'s** — `isSelected` above draws it, the same
   * quiet `bg-surface` all three of the app's tables use. What this carries is the *attribute*,
   * so the four views answer "which card is picked" the same way from a test and from a probe in
   * the shipped window. See `cardControl`'s `SELECTED_ATTR`.
   */
  selected: boolean;
  /** The nonce this row's last add was given, or `undefined` — `undefined` for a band, which
   *  is a heading and never a thing that lands. The mark's `key`, so a second add replays it. */
  landedKey?: number;
}) {
  const { attach, over, eligible } = useCategoryDrop(row.group.categoryId, onDrop);
  const dragRef = useDeckCardDrag(
    row.kind === "card" ? row.card : EMPTY_CARD,
    row.kind === "card" && actions?.drop !== undefined,
    actions?.groupDrag,
  );
  // One element, two registrations — a row is both the thing that can be picked up and the
  // place a card can be let go. React 19 calls the returned function as the cleanup, so the
  // two teardowns are chained rather than one of them being dropped.
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const stopDrag = dragRef(element);
      const stopDrop = attach(element);
      return () => {
        stopDrag?.();
        stopDrop?.();
      };
    },
    [dragRef, attach],
  );

  if (row.kind === "group")
    return bandRow(props, row.group, columns, marketplace, ref, over, eligible, actions);

  // A band has no card, so it has no card menu — the *heading's* menu is a different question
  // and a different builder. Read after the band's early return for that reason.
  const menu = actions?.menu?.(row.card);

  return (
    <div
      {...props}
      ref={ref}
      // The caret's way home after a printing swap, on the row because the row is what takes
      // focus in this table (`VirtualTable` owns the click, Enter and Space on it).
      {...deckCardProps(row.card)}
      {...deckCardSelectedProps(selected)}
      // The row is this view's card, so the menu hangs on the row. **Chained rather than
      // spread**, and that is the one place the other three views differ from this one: the row
      // already carries `VirtualTable`'s own `onKeyDown`, which is Enter and Space opening the
      // card, and a spread here would silently replace it — a table whose rows had stopped
      // answering the keyboard, with a right-click menu as the only sign anything had changed.
      // Both run: `menuKey` returns early for every key but Shift+F10 and the ContextMenu key,
      // neither of which `VirtualTable` claims.
      onContextMenu={menu?.onContextMenu}
      onKeyDown={(e) => {
        props.onKeyDown?.(e);
        menu?.onKeyDown(e);
      }}
      // The shared pair, as in the other three views.
      //
      // **This view carried `ring-inset` of its own until 2026-09-03, and it was right first.**
      // Its reason at the time — a row here was absolutely positioned inside a scroller, and an
      // outset ring is drawn over its neighbours — turned out to be the general case rather than
      // this table's special one: a reader reported exactly that overlap across the whole app,
      // and `DROP_RING` is inset for everybody now. So the extra class is gone as a duplicate of
      // what the token already says, and nothing about what this row draws changed. (The rows
      // are in normal flow since `grow`, which retires the premise and not the conclusion: rows
      // stacked flush against each other overlap an outset ring however they are placed.)
      className={cn(props.className, eligible && DROP_RING, over && DROP_OVER)}
    >
      {props.children}
      {/* The table's own drop mark, which it alone was missing — the same line the other three
          views draw on the edge of the category that would take the card. Every row of a group
          is a target here, so the line lands on the row under the pointer rather than on the
          band; that is what this view has instead of a column edge. */}
      {over && <DropIndicator />}

      {/* The landed mark, over the row it belongs to. An `inset-0` overlay needs no `relative`
          adding here because the row is positioned already — `VirtualTable` gives it `relative`
          under `grow`, exactly as it gave it `absolute` when the virtualiser was placing it, and
          that class is there for this overlay and the `DropIndicator` above it. This view's rows
          are also the one place the mark is over *text* rather than over art, which is what the
          wash's low alpha is for. */}
      {landedKey !== undefined && <LandedMark key={landedKey} />}
    </div>
  );
}

/** A row's drag payload needs a card, and a band has none. Never read: `useDeckCardDrag` is
 *  handed `enabled: false` for a band, so nothing registers and nothing is asked for it. */
const EMPTY_CARD = { cardId: "", name: "", categoryId: 0 } as DeckCard;

/**
 * A card row is the table's own; a group row is one band spanning every column.
 *
 * The props are spread whole in both cases, and the band then overrides **six** of them:
 * `tabIndex`, `onClick` and `onKeyDown` because a heading is not something Enter opens;
 * `style.gridTemplateColumns`, because a band has one track rather than nine; `className`,
 * for the surface colour; and `children`, which is the band itself. Everything it does not
 * touch — `role`, `aria-rowindex`, the row's own geometry (`position` and, under `grow`, the
 * `minHeight` that carries {@link RENAME_HEIGHT}), the focus ring — is exactly what a row in
 * this table is, and a band is still a row of it.
 *
 * **The band owns a real cell.** A `role="row"` with no `role="cell"` inside it is malformed
 * to assistive tech — a row that owns nothing — so the heading sits in one cell carrying
 * `aria-colspan`, which is the same thing the design canvas's `colspan="9"` says in HTML.
 */
function bandRow(
  props: RowRenderProps,
  group: CardGroup,
  columns: number,
  marketplace: Marketplace,
  ref: (element: HTMLDivElement | null) => void,
  over: boolean,
  eligible: boolean,
  actions?: DeckCardActions,
) {
  return (
    <div
      {...props}
      ref={ref}
      tabIndex={undefined}
      onClick={undefined}
      onKeyDown={undefined}
      // **The pile's own menu, and this band is where it belongs in this view** — the band *is*
      // the group here, and it is emphatically not `GroupHeader`, which is drawn inside
      // `CategoriesDialog`'s scrimmed dialog as well; `deckGroupMenuProps` carries the reason.
      // Spread rather than chained, unlike a card row: the three props above have just been
      // cleared, because a heading is not something Enter opens.
      {...deckGroupMenuProps(group.categoryId, actions)}
      // The caret lands here when a card leaves this pile under it, exactly as it lands on a
      // group's section in the other three views — the band *is* the group here.
      {...deckGroupProps(group.categoryId)}
      // One track, not nine. `props.className` already carries `grid`; overriding the
      // template is the whole of what makes this row one cell wide, and adding a second
      // display utility beside it would leave which one wins to the class sorter.
      // One track across, and one *down* — the second is the correction that goes with
      // {@link RENAME_HEIGHT}. `VirtualTable` splits a grown row into a 44px track and the extra
      // one, because its own tall case (the reconciler's band) is a second thing positioned
      // under the cells. A band is not that shape: it is a single cell that wraps, so the two
      // tracks would pin it to the first 44px and the rename field would overflow the row this
      // fix just made tall enough. Cleared, the cell has the whole height to wrap inside.
      // **`props.style`'s height term is kept in both modes** — under `grow` that is a
      // `minHeight`, so a rename form that wraps to two lines grows the band instead of
      // spilling out of it, which is why {@link RENAME_HEIGHT} no longer has to allow for one.
      style={{
        ...props.style,
        gridTemplateColumns: "minmax(0,1fr)",
        gridTemplateRows: undefined,
      }}
      className={cn(
        props.className,
        "bg-surface",
        eligible && DROP_RING,
        "ring-inset",
        over && DROP_OVER,
      )}
    >
      <span role="cell" aria-colspan={columns} className="flex min-w-0 flex-wrap items-center">
        <GroupHeader group={group} marketplace={marketplace} className="w-full" />
        {deckGroupRename(group.categoryId, actions)}
      </span>
      {over && <DropIndicator />}
    </div>
  );
}
