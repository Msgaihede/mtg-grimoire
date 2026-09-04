/**
 * Every printing of the open card, as a list the reader reads **down** — the card detail
 * modal's main column, and the control the printing combobox used to be.
 *
 * ## Why the list is back and the combobox is gone
 *
 * The combobox was one line that could name one printing at a time, and it was the only way to
 * see the card's other printings without leaving the panel. Two things follow from that shape
 * and neither is what the reader wanted. A picker announces the printing you are *on* and hides
 * every printing you are choosing *between*, so the comparison the control exists for — which
 * set, which year, which price — happens inside a popup that closes on the first press. And the
 * modal's main column had nothing else in it, so a panel opened to look at a card spent its
 * widest column on one collapsed row.
 *
 * The list answers both at once: it is the comparison, drawn, in the space that was empty.
 *
 * ## Why it is not {@link AllPrintingsDialog}'s wall extracted
 *
 * The obvious move — one component both surfaces mount — is refused, and the reason is that the
 * two are not one thing drawn at two widths. `AllPrintingsDialog` is a `CardGrid`: a virtualised
 * **wall of art** that owns its own scroller, needs a bounded parent to virtualise against, and
 * flattens the groups away entirely because a heading cannot be interleaved between absolutely
 * positioned rows. This is a **column of facts** — set, number, year, language, a price per
 * finish — with the group headings kept, drawn inside a column that already scrolls. Mounting a
 * `CardGrid` here would put a second scroller inside the one `CardDetailModal` gives this column
 * and lose the headings this list's whole sort control is about.
 *
 * What *is* shared is the part that can drift: `buildPrintingGroups` decides what a group is and
 * what order everything comes in, and both surfaces call it. The wall flattens the answer; this
 * draws it. One ordering rule, two drawings — which is the split `AllPrintingsDialog`'s own
 * `sorted` already describes from the other side.
 *
 * ## What a press means
 *
 * Nothing this file decides. `onPick` is the host's callback and its meaning is the host's: with
 * a deck row behind the modal it *swaps the deck's printing*, with no deck row it *browses*. See
 * {@link CardModalPrintingsProps.onPick}. What this file does is say, in the row's accessible
 * name, which of the two a press is about to do — because a reader who cannot see the row finds
 * out by pressing it otherwise.
 */
import { useId, useMemo } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FinishMark } from "@/components/FinishMark";
import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { parseFinishes } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import type { CardDetail, Printing } from "@/lib/ipc";
import { languageHint } from "@/lib/languages";
import type { Marketplace } from "@/lib/marketplace";
import { PRESS } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { finishTreatments } from "@/lib/treatment";
import { cn } from "@/lib/utils";
import type { CardModalScope } from "./cardModalScope";
import {
  buildPrintingGroups,
  isPrintingGroupBy,
  PRINTING_GROUP_BY_OPTIONS,
} from "./printings";
import { usePrintingGroupBy } from "./usePrintingGroupBy";

/**
 * `PRINTING_GROUP_BY_OPTIONS`, in the shape `Dropdown` draws — the four modes with their value
 * and label and nothing else, since none of them wants a hint or an icon.
 *
 * Module scope because the four modes never change: rebuilding this array on every render of
 * every open modal would cost four objects for nothing. It stood in the deleted docked pane
 * under the same name and is the one piece of that file copied out rather than re-derived.
 */
const GROUP_BY_DROPDOWN_OPTIONS: readonly DropdownOption[] = PRINTING_GROUP_BY_OPTIONS.map(
  (option) => ({ value: option.value, label: option.label }),
);

export interface CardModalPrintingsProps {
  /** The open card. Read for `id` — which row is the one on screen — and for nothing else. */
  card: CardDetail;
  /**
   * Spec §7's per-view table, resolved once by `useCardModalScope`.
   *
   * **Read for the row's *name* and never for the row's *write*.** `scope.deck` is what lets a
   * row say `Use this printing (LEB 161) in Burn spells` instead of `Show LEB · 161`; the write
   * itself is {@link onPick}'s, out in the host. That is the same division `CardModalControls`
   * draws: it reads `scope.deck.categoryName` for a placeholder and still refuses to decide what
   * picking a printing means.
   */
  scope: CardModalScope;
  /** The page the host already fetched — `card_printings` at {@link marketplace}. */
  items: readonly Printing[];
  /** How many printings the card has, which is **not** `items.length` — the read is paged. */
  total: number;
  /** The read is in flight. */
  loading: boolean;
  /** The read was refused, as a whole sentence, or `null`. */
  error: string | null;
  /**
   * Which marketplace every price here is quoted at.
   *
   * A prop rather than `useMarketplace()` of this component's own, because the numbers in
   * {@link items} were fetched at one particular marketplace and a currency symbol read from a
   * second source could disagree with the figures beside it. It travels with the data.
   */
  marketplace: Marketplace;
  /**
   * A write the host started is still in flight — the list goes inert and says so.
   *
   * Every row that would swap, not only the pressed one: they all send the same `from` printing
   * and the write in flight is in the middle of moving it. `aria-disabled` and a guard rather
   * than the `disabled` attribute, which is `src/CLAUDE.md`'s rule and here buys the thing the
   * rule is for — a control that greyed under the reader's hand mid-press would drop out of the
   * tab order and blur to `<body>`.
   */
  busy?: boolean;
  /**
   * A printing was pressed — and **what that means is the host's answer, not this file's.**
   *
   * With a deck row behind the modal the host swaps the row onto it (`useDeck.swapPrinting`, the
   * same write `AllPrintingsDialog`'s tiles press); with no deck row it browses
   * (`viewPrinting`). This list deliberately knows neither: it draws rows over `scope`, and a
   * component that branched on `scope.deck` to decide which *write* a press makes would be a
   * second opinion about a question `cardModalScope.ts` is the single answer to.
   *
   * The row for the printing already on screen is not pressable at all, so this is never called
   * with {@link card}'s own id.
   */
  onPick: (printingId: string) => void;
  /**
   * Open the printings **wall** — `AllPrintingsDialog`, the filtered grid of art.
   *
   * **A different surface from this list rather than a bigger version of it**, which is why both
   * exist: this is a column of facts a reader compares down, that is a wall of pictures they
   * search across. It sits here because it is about the printings, and a reader who wants more of
   * them than this column shows is looking at this column when they decide that — it lived in the
   * controls column, two boxes away from the thing it is about, until 2026-09-04.
   */
  onViewAll: () => void;
}

/**
 * The section: a heading, the control that reorders what it names, a count, and the rows.
 *
 * **It draws no scroller of its own.** `CardDetailModal`'s middle column is already
 * `overflow-y-auto` from `@min-[640px]/card` up and the whole grid is the scroller below that,
 * so a bounded box here would be a second scrollbar inside the first — the arrangement
 * `src/CLAUDE.md` names as the deck editor's own fixed bug. The list grows and the column
 * scrolls.
 */
export function CardModalPrintings({
  card,
  scope,
  items,
  total,
  loading,
  error,
  marketplace,
  busy = false,
  onPick,
  onViewAll,
}: CardModalPrintingsProps) {
  const headingId = useId();
  /**
   * The ordering, which is **a stored preference and not this component's own state.**
   *
   * `usePrintingGroupBy` is an `app_meta` row behind a query, so a reader who groups by set here
   * finds this list grouped by set at the next card, the next open and the next launch. It is
   * deliberately the **same** row `AllPrintingsDialog` reads: this list and that wall are two
   * drawings of one question about one card, and a reader who sorts by price here and then
   * presses `View all printings` must not be handed the same printings in a different order. It
   * was the deleted docked pane's preference on exactly that argument, shared with the dialog.
   *
   * Owned here rather than taken as a prop for the reason the hook's own doc gives: a new
   * observer over a resolved query is a read of the cache, never a round trip, so there is
   * nothing for the host to hold on this component's behalf.
   */
  const { mode, setMode } = usePrintingGroupBy();

  // Sorted and bucketed over up to 400 rows inside a panel that re-renders on every hover and
  // every keystroke elsewhere in it, so it is memoised on exactly the two things it reads.
  // `items` keeps its identity across a refetch that changed nothing (React Query's structural
  // sharing), so this is not work repeated per render.
  const groups = useMemo(() => buildPrintingGroups(items, mode), [items, mode]);

  // What the groups *are*, in this mode's own word — `null` in `price`, which makes none.
  const noun = PRINTING_GROUP_BY_OPTIONS.find((option) => option.value === mode)?.noun ?? null;

  return (
    // **A fragment, because the button above the rule is not part of the section below it.** The
    // two are siblings in the wrapper `CardDetailModal` draws around them, which is the flex
    // column that gives the section its height and leaves the button its own.
    <>
      {/* **The door to the printings wall, above the rule rather than under it.**

          That rule is the section's own `border-t`, and it separates "this card" from "every
          card like it" — the panel's deepest division, the one `Legality` draws too. The button
          is not part of the list it sits over: it opens a *different* surface, a filtered grid of
          art at three or four times this width. Under the rule it read as the list's first row.

          Its count is the same `total` the line below states, and saying it twice is the point:
          that line says how many there are and this says it will show them, so a reader who has
          read "12 of 865 printings" and wants the rest has the way there under their eyes rather
          than two boxes away in another column, which is where it was until 2026-09-04.

          **Accent outline and accent text** — `FilterChips`' recipe for a lit control and the
          app's one spelling of it. Everything around it reports; this is the only thing here that
          opens something. Outline and not fill: the panel's footer row owns the primary
          treatment, and a second filled control would compete with `Add to deck`.

          `shrink-0` because the section below it is the flexible one — see the wrapper in
          `CardDetailModal`, which is the flex column the two of them are children of. */}
      <button
        type="button"
        onClick={onViewAll}
        className={cn(
          "h-9 w-full shrink-0 truncate rounded-md border px-3 text-xs",
          "border-accent text-accent hover:border-accent hover:bg-accent/10",
          PRESS,
          FOCUS,
        )}
      >
        {/* One text node, count included: a label and its count in two spans separated by a CSS
            `gap` compute to "View all printings865" — a gap is not a word separator, and the
            accessible name is what a test and a screen reader both read. */}
        {`View all printings (${total})`}
      </button>

      {/* **`relative`, and it is not decoration.** `RarityGem` and the language badge below each
          carry an `sr-only` span, and Tailwind's `.sr-only` is `position: absolute` — a
          screen-reader label with no positioned ancestor takes its containing block from far
          outside the column this list is drawn in and is then laid out at a static position the
          scroller cannot clip. That is `src/CLAUDE.md`'s phantom-scrollbar rule, met from the inside
          rather than at the box carrying the `overflow`; one word here bounds this whole subtree.

          The rule above it separates "this card" from "every card like it", which is the panel's
          deepest division — the same hairline `InlineCounts` draws above, so the middle column reads
          as stacked sections rather than as boxes.
          **A fixed head and a scrolling body, at the rung where this column is its own scroller.**
          The heading, the control that reorders the list and the count line all describe what is
          below them, so a reader three hundred rows down had lost the name of the thing they were
          reading, the control they would use to re-sort it, and the only statement of how many
          there are. Everything above the rows is `shrink-0`; the rows take what is left.

          **`flex flex-col gap-2` rather than the `space-y-2` this had**: the body needs
          `flex-1 min-h-0` to be given a definite height to scroll inside, which is a thing only a
          flex parent can hand it. The gap is the same 2 the margins were, so nothing moves.

          Below `@min-[1200px]/card` none of it applies and none of it has to be turned off: the
          main column is the scroller there, this section is auto-height inside it, and a body with
          no height to overflow draws no bar. The classes are unconditional for that reason — a
          container-query variant on them would be four more classes saying what the layout already
          says. */}
    <section
      aria-labelledby={headingId}
      className="relative flex flex-col gap-2 border-t border-border pt-3 @min-[1200px]/card:min-h-0 @min-[1200px]/card:flex-1"
    >
      {/* The heading and the control that reorders what it names, on one line — and
          **`flex-wrap`, which is `src/CLAUDE.md`'s rule about a row of fixed-width controls
          rather than a precaution.** The narrowest surface that draws this row is the panel below
          the phone fold, where the column is the whole panel less its padding; the dropdown
          cannot shrink past its own longest label (`Release date`), so without a wrap a long
          heading would push it out of the column and the grid's `overflow-y-auto` would compute
          `overflow-x: auto` around it.

          `min-w-0 truncate` on the heading is the other half: the elastic thing is the word and
          the fixed thing is the control, which is the arrangement every narrow row in this app
          already uses.

          **No `View all printings` here.** It stays in `CardModalControls`, one block up the same
          column — a second copy would be two buttons with one accessible name in one panel, which
          is ambiguous to a screen reader and to `getByRole` alike. */}
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id={headingId}
          className="min-w-0 flex-1 truncate text-xs uppercase tracking-wide text-dim"
        >
          Printings
        </h3>
        <Dropdown
          // **Labelled for a screen reader alone**, because the line already carries the word
          // this control is about: a visible `Group by` beside a heading reading `Printings`
          // would be two labels for one list. The name says what it groups rather than just
          // "Group by", since a reader listing this panel's controls hears it beside the deck
          // category picker and the marketplace.
          //
          // **`Group printings by` and not `Sort`**, which is the one word this list and
          // `AllPrintingsDialog` deliberately disagree on: that wall draws no headings, so its
          // control can only be a sort; this list draws them, so the modes are groups and the
          // heading count under it says how many.
          label="Group printings by"
          size="sm"
          value={mode}
          options={GROUP_BY_DROPDOWN_OPTIONS}
          onChange={(value) => {
            // `GROUP_BY_DROPDOWN_OPTIONS` is built from nothing but `PRINTING_GROUP_BY_OPTIONS`'
            // own four values, so `value` can only ever be one of them. Kept as a real check
            // rather than a cast because `Dropdown`'s `onChange` is typed as a bare `string` and
            // cannot see that provenance on its own.
            if (isPrintingGroupBy(value)) setMode(value);
          }}
          className="shrink-0 text-text"
        />
      </div>

      {loading && <p className="shrink-0 text-xs text-dim">Loading printings…</p>}
      {error !== null && (
        <p className="shrink-0 text-xs text-destructive">
          Could not read the other printings — {error}. The card above is unaffected.
        </p>
      )}

      {/* A count line, so it is set in the data face. `items.length` is capped by the page the
          host asked for and `total` is not — saying only the first would report a Forest as
          having 400 printings when it has 862.

          **The second half follows the mode**, because it is a gloss on the grouping the reader
          is looking at: "5 artists" under Artist, "3 release dates" under Release date, "4 sets"
          under Set. It is dropped whole in `price` mode rather than reworded — there is one group
          there and it has no heading, so "1 price" would count a thing that is not on screen. */}
      {items.length > 0 && (
        <p className="shrink-0 font-mono text-[0.7rem] tabular-nums text-dim">
          {items.length < total
            ? `${items.length} of ${plural(total, "printing")}`
            : plural(total, "printing")}
          {noun !== null && (
            <>
              {" · "}
              {groups.length} {groups.length === 1 ? noun.one : noun.many}
            </>
          )}
        </p>
      )}

      {/* **The empty state is drawn rather than returned as `null`, which reverses the docked
          pane's answer and reverses it on purpose.** In a 384px column beside a deck, a section
          with nothing in it was a heading taking width off the deck; here this list *is* the
          modal's main column, and a column that silently disappears leaves exactly the empty
          space this whole change exists to fill. A reader who asked which printings a card has
          is owed the answer "none", in words. */}
      {!loading && error === null && items.length === 0 && (
        <p className="shrink-0 text-sm text-dim">This card has no paper printings.</p>
      )}

      {/* **The body, and the only thing in this section that scrolls.** `space-y-2` here is the
          spacing the section's own used to give between groups; it moved with them.

          `relative` because this is the box with the overflow now, which is `src/CLAUDE.md`'s
          phantom-scrollbar rule: every row draws a rarity gem and a language badge, each
          carrying an `sr-only` span, and `.sr-only` is `position: absolute` — laid out against
          the viewport rather than this box, an absolutely positioned descendant lands outside it
          and the box grows a bar for a caption nobody can see.

          The gold thumb is here rather than on the column, since this is the box that draws
          one — see `.scrollbar-accent` in `index.css` for why this list and no other. */}
      <div className="scrollbar-slim scrollbar-accent relative min-h-0 flex-1 space-y-2 overflow-y-auto">
      {groups.map((group) => (
        // The key is the group's own — `printings.ts` makes it, because only the thing that
        // decided what a group *is* can say what tells two of them apart (an artist, a date, a
        // set code, or the one bucket a flat list has).
        <div key={group.key} className="space-y-0.5">
          {/* No heading element at all when there is none — not an empty one, and not a
              placeholder word. A flat list with a blank line above it would read as a group
              whose name failed to load. */}
          {group.heading !== null && (
            <p className="flex items-baseline gap-1.5 pt-1 text-[0.7rem] text-dim">
              <span className="min-w-0 truncate">{group.heading}</span>
              <span className="font-mono tabular-nums">· {group.printings.length}</span>
            </p>
          )}
          <ul className="space-y-0.5">
            {group.printings.map((printing) => (
              <PrintingRow
                key={printing.id}
                printing={printing}
                deck={scope.deck}
                current={printing.id === card.id}
                busy={busy}
                marketplace={marketplace}
                onPick={onPick}
              />
            ))}
          </ul>
        </div>
      ))}
      </div>
    </section>
    </>
  );
}

/**
 * One printing, and what pressing it means.
 *
 * The row **is** the press — there is no "Use this printing" button beside it, which is the
 * docked pane's own answer kept: the row is already the thing the reader is pointing at, and a
 * button would take its width out of the set name, which is what the reader is choosing a
 * printing *by*.
 *
 * What that cost in the pane it does not cost here. There, a click in a deck context rewrote the
 * deck with no way to look first; here `View all printings` is one press away in the heading row
 * above, and that wall is a wall of art where looking is the whole point. A mis-press is covered
 * by the deck's undo either way.
 */
function PrintingRow({
  printing,
  deck,
  current,
  busy,
  marketplace,
  onPick,
}: {
  printing: Printing;
  /** The deck row behind the modal, or `null` — read for the row's name, never for its write. */
  deck: CardModalScope["deck"];
  /** This is the printing the panel is drawing. */
  current: boolean;
  /** A write is in flight somewhere in the list. */
  busy: boolean;
  marketplace: Marketplace;
  onPick: (printingId: string) => void;
}) {
  const tip = useTooltip();

  /**
   * The pile a press here would rewrite, or `null` where a press only browses.
   *
   * **The name rather than the boolean, because the name is what the row has to say** — and
   * TypeScript will not carry a narrowing of `deck` through a `boolean` into the label below, so
   * a `swaps` flag would have to be paid for with a `!` that claims something about another
   * file's invariant.
   *
   * Compared against the **deck row's** printing rather than against the open card, because they
   * are two different facts that only happen to agree: `openCardFromDeck` writes both and
   * `useDeck.reanchorPane` moves both, so in this modal they are the same id — and a row named
   * off the wrong one of them would lie on the first day something opens a card from a deck
   * without re-anchoring it.
   */
  const swapInto = deck !== null && printing.id !== deck.cardId ? deck.categoryName : null;
  /** Out of reach while a write runs — every row that would swap, not only the pressed one. */
  const inert = swapInto !== null && busy;

  const label = `${printing.setCode.toUpperCase()} · ${printing.collectorNumber}${
    printing.releasedAt ? ` · ${printing.releasedAt.slice(0, 4)}` : ""
  }`;

  return (
    <li
      // **The state, not a decoration.** `aria-current` is what says "this is the one on screen"
      // to a reader who cannot see the gold hairline — and the hairline is the only other thing
      // saying it, since the current row draws no button and so has no name to put it in.
      aria-current={current || undefined}
      className={cn(
        "rounded-md px-2 py-1 text-xs",
        // The one printing this panel is about. A gold hairline down its edge rather than a
        // fill: gold means "here" everywhere else in the app, and a filled row in a list of
        // forty would be the brightest thing in the column.
        current
          ? "border-l-2 border-accent bg-bg pl-1.5 text-text"
          : cn(
              "text-dim hover:bg-surface",
              "transition-colors duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
            ),
      )}
    >
      {/* The facts, on one line. `items-center` rather than baseline because the line ends in
          marks and figures of different heights. */}
      <div className="flex items-center gap-2">
        <RarityGem rarity={printing.rarity} className="shrink-0" />
        {current ? (
          // **No `whenClipped` on either of these tooltips**, and the rule is worth stating once:
          // `whenClipped` is only correct when the tooltip's words are the anchor's *own* text.
          // This shows `setCode` and tips `setName`, a different string, so gating the panel on
          // whether the *code* happens to be clipped gates it on something that has nothing to do
          // with the name it is about to say — and at this width the code rarely clips, so the
          // name would be unreachable by hover in practice.
          <span className="min-w-0 flex-1 truncate font-mono" {...tip(printing.setName ?? "")}>
            {label}
          </span>
        ) : (
          <button
            type="button"
            // **The name has to change with what the press does.** In a deck context it rewrites
            // a deck row; a button still called "Show LEB · 161" would describe a version of this
            // list that does not exist, and a reader who cannot see the row would find out what
            // it really did by pressing it.
            //
            // The category is named because the same printing can sit in the main deck and the
            // sideboard, and the slot being rewritten is the one the modal was opened on. That
            // word is the context's own rather than a lookup — this component is a sibling of the
            // deck editor and has no category list to translate an id through. A row moved to
            // another pile under an open modal makes that word stale and *only* that word: the
            // write is addressed by the same slot and is refused, in the panel's own sentence.
            aria-label={
              swapInto !== null
                ? `Use this printing (${printing.setCode.toUpperCase()} ${printing.collectorNumber}) in ${swapInto}`
                : `Show ${label}`
            }
            // Greyed and refused, never removed from the tab order — see {@link inert}.
            aria-disabled={inert}
            onClick={() => {
              // The paint says so and this says so again: a press that lands between the state
              // and the frame must not queue a second write.
              if (inert) return;
              onPick(printing.id);
            }}
            {...tip(printing.setName ?? "")}
            className={cn(
              "min-w-0 flex-1 truncate text-left font-mono aria-disabled:opacity-50",
              FOCUS,
            )}
          >
            {label}
          </button>
        )}
        {printing.lang !== "en" && <LangBadge lang={printing.lang} />}
        {/* Per finish, priced at the marketplace the list was read at — never one number
            standing for both, and never another marketplace's. `formatPrice` draws an em dash
            for a finish this feed has not answered for and never invents a zero. */}
        {parseFinishes(printing.finishes).map((finish) => (
          <span
            key={finish}
            className="flex shrink-0 items-center gap-0.5 font-mono tabular-nums"
          >
            <FinishMark
              finish={finish}
              treatments={finishTreatments(printing.promoTypes, finish)}
            />
            {formatPrice(printing.finishPrices[finish], marketplace.currency)}
          </span>
        ))}
      </div>
    </li>
  );
}

/**
 * A printing's language, in the two letters Scryfall files it under — drawn **only** where it is
 * not English.
 *
 * A list where every row says `EN` says nothing, and the row has no width to spend saying it. The
 * words come from `languageHint` so this list, the printings wall and the card's own facts line
 * all say the same thing: `PH` on Elesh Norn is unreadable to anyone who has not already learned
 * that Scryfall files Phyrexian as a language.
 */
function LangBadge({ lang }: { lang: string }) {
  const tip = useTooltip();
  return (
    <span
      {...tip(languageHint(lang))}
      className="shrink-0 rounded border border-border px-1 font-mono text-[0.65rem] uppercase leading-4"
    >
      <span className="sr-only">Language: </span>
      {lang}
    </span>
  );
}
