import { useMemo, type ReactNode } from "react";
import { Crown } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { deckStats } from "./DeckStats";

/**
 * What the deck adds up to, on one line of the header.
 *
 * **These five figures were the foot of the page and are the head of it now** (2026-08-24). They
 * were `DeckStats`' `FigureRow`, drawn under four charts at the bottom of a scroller a
 * hundred-card deck is two screens tall — so the numbers a reader edits *against* were the ones
 * they had to scroll away from the deck to read. The charts stay where they are; the arithmetic
 * comes up here, and it exists in exactly one place either way, because both surfaces call
 * {@link deckStats} over the same `DeckCard[]`.
 *
 * **A line of terms, not a row of cards.** Every figure is `label value` in one baseline with a
 * hairline between neighbours, which is a quarter of the height `Figure`'s stacked pair takes and
 * the reason all five fit on a line the action row can spare. It is a `<dl>` for the same reason
 * `FigureRow` is one: a label and the number it names are a description list wherever they are
 * drawn, and the separators are `div`s rather than the design's `span`s so the list stays a valid
 * one.
 *
 * **Three controls at the right end, and the middle one is a readout that is also a press.** What
 * the rules make of the deck ({@link check}) and the bracket the deck reads as ({@link bracket})
 * are slotted in whole, because this component owns nothing about the layers they open. Between
 * them sits the game-changer chip: the count in the words it has used since 2026-08-24, wearing
 * the crown the cards it counts wear, and pressing it narrows the deck to exactly those cards.
 *
 * **The count and the filter are one control again** (2026-09-10, the reader's call). The history
 * is worth keeping because two of the three arrangements are wrong in ways that are not obvious.
 * From 2026-09-08 the press armed a *spotlight* — hover or latch, and every card that is not a
 * game changer faded to a quarter — which answered *which ones* by making everything else dimmer,
 * and a hundred stacked quarter-opacity cards is a blur rather than an answer. So on 2026-09-09
 * the question moved to a `Game Changers` chip in the toolbar's label-filter row and the count
 * here went back to a bare span. That fixed the blur and cost something else: the number and the
 * way to act on it sat two lines apart, in a row of the reader's own arbitrary label strings,
 * where the app's one fixed chip is the odd one out. Now the number *is* the button — same place,
 * same words, and the narrowing the chip did, which leaves every card that survives looking
 * exactly as it looks unfiltered.
 *
 * **The crown is drawn always rather than only when pressed**, because here it is the chip's
 * *identity* and not its state: `aria-pressed` says whether the filter is on, and the gold edge
 * is the sighted half of that same sentence. A bare lucide glyph and never `GameChangerMark` —
 * that component names itself and binds a tooltip of its own, which inside a control that already
 * has both would be a second name and a second hint on one button.
 *
 * **Five figures on a regular deck and four on a virtual one** (2026-09-08, issue #401). A Virtual
 * deck is one the reader tracks without owning the cardboard, so `Owned` would read `0` beside a
 * red `100 missing` for a list nobody ever claimed to have — the one figure on this line that is
 * about a *binder* rather than about the deck, and therefore the one that goes. `tracksCollection`
 * is what says so; the other four are arithmetic over the rows and are true of every kind of deck.
 * (Six `<dt>`s and five, counting the `Format` term, which is not a figure and is drawn as one —
 * that is the count `DeckLedger.test.tsx` asserts the hairlines against.)
 */
export function DeckLedger({
  cards,
  marketplace,
  formatName,
  gameChangers,
  hasGameChangers,
  gameChangersOnly,
  onGameChangersOnlyToggle,
  tight,
  tracksCollection,
  check,
  bracket,
}: {
  /** The rows every figure is counted over — the deck's own, unfiltered. What the toolbar's
   *  filter narrows is what is *shown*; a deck's price is a fact about the deck. */
  cards: readonly DeckCard[];
  /** Which marketplace the Price figure quotes — its currency for the formatter, its label for
   *  the as-of sentence the figure carries as a tooltip. The arithmetic needs neither: the rows
   *  arrived priced. */
  marketplace: Marketplace;
  /**
   * What the ruleset every number is judged against is called, or `null` before the deck has
   * answered.
   *
   * **It is here because the header's `Deck format` select is not** (2026-08-24). The select was
   * dropped for the width it cost a row that already wrapped, and *changing* a format is a Deck
   * settings trip now — but a ledger that says `2 issues` without saying issues *with what* is a
   * readout the reader has to remember the scope of. Read-only, in the dim voice, first: it is
   * the condition on the line rather than a figure in it.
   */
  formatName: string | null;
  /**
   * Copies of the cards the format calls game changers, over the piles that count — the figure
   * half of the chip. **Never drawn as `0`**: a readout of `0 game changers` points at cards to
   * go and find where there are none to find, so a zero falls back to the chip's bare caption and
   * the control keeps only the half that is still true.
   */
  gameChangers: number;
  /**
   * Whether the deck **draws** a game changer at all — the chip's own gate, and deliberately not
   * {@link gameChangers} above.
   *
   * The count is a *rules* readout: copies over the piles that count, which is the number the
   * format will judge. The gate is a question about what is on the desk. A game changer parked in
   * a switched-off Maybeboard is exactly a card a reader wants to press this chip about — it is
   * still in front of them — so the chip is drawn for it and the filter matches it, and the
   * count beside it stays silent because that pile counts toward nothing. That is the same split
   * `validateForMarks` and `validateDeck` make one screen over (issue #134): a claim about the
   * deck, and an answer about each card drawn.
   *
   * **The two arms are why the caption has two spellings**, and the odd-looking one is the honest
   * one: `Game Changers` with no number is a deck whose only powerful cards are parked.
   */
  hasGameChangers: boolean;
  /**
   * Whether the chip is pressed — the filter as the deck is actually being drawn under it, not
   * the editor's stored flag. See `DeckEditor`'s `gcFilter` for why those are two things.
   */
  gameChangersOnly: boolean;
  /**
   * A press: narrow the deck to the game changers, or give the rest of it back. The chip is told
   * nothing about which — it reports the gesture and the editor holds the state, for the reason
   * every other control on this line reports rather than decides.
   */
  onGameChangersOnlyToggle: () => void;
  /**
   * The narrowest editor column this header reasons about, where the two counted figures that
   * carry a sentence say it in a number instead.
   *
   * Nothing is dropped for being narrow that a reader could not otherwise get at: the shortfall
   * keeps its words for a screen reader (`sr-only`), and the game-changer count is the second
   * half of the bracket popup's own headline.
   */
  tight: boolean;
  /**
   * Does this deck read the collection at all? `deckKind.ts`'s `tracksCollection(deck)`, answered
   * by the host.
   *
   * `false` drops the `Owned` term and the hairline in front of it — a **Virtual** deck owns
   * nothing by construction, so the figure would be a zero and a red shortfall about cardboard
   * the reader never said they had. **Absent rather than dimmed to an em dash**, which is this
   * feature's standing answer and the right one here twice over: a dash on this line already
   * means *no number to give* (the average of a deck of nothing but lands), and re-using it for
   * *no question to ask* would put two meanings on one glyph.
   *
   * **The boolean and not the deck**, for `formatName`'s reason one prop up: this line is handed
   * facts and draws them. `DeckEditor` answers it once for the header, the band, the strip and
   * the table, so the four cannot disagree about whether this deck has a binder behind it.
   *
   * **Required rather than optional**, so a host that has not thought about it cannot silently
   * get the arm that draws an owned count over a deck that owns nothing.
   */
  tracksCollection: boolean;
  /** The format check — a press and the panel of findings behind it, or nothing at all while
   *  `format_specs` has not answered. */
  check: ReactNode;
  /** The bracket estimate, for the formats that have one. */
  bracket: ReactNode;
}) {
  const tip = useTooltip();
  // The same pass `DeckStats` makes, over the same rows, through the same function — so the head
  // of the page and the foot of it cannot answer one question two ways. `separateXGroup` is
  // deliberately not passed: it moves cards between *curve buckets* and touches no figure here.
  const stats = useMemo(() => deckStats(cards), [cards]);

  // Where the rest of the deck is, for the headline figure's `+n`. Every pile names itself, so
  // the tooltip names the columns the reader is looking at — and it is `deckStats`'s answer
  // rather than a second reading of the size rule here.
  const elsewhere = stats.elsewhere
    .map((category) => `${count(category.quantity)} ${category.name.toLowerCase()}`)
    .join(" + ");
  const spare = stats.copies - stats.sized;

  return (
    <dl
      className={cn(
        "flex min-h-9 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1",
        "border-y border-border py-1",
        // The row's own floor, for the reason every flex row in this editor carries one: without
        // it the terms are the only shrinkable children and a squeeze falls on the numbers.
        "min-w-0",
      )}
    >
      {/* Not a figure and drawn as one all the same: the pair is `what this is` / `what it is
          called`, which is what a description list says. Sans rather than the data face — a
          format is a name, and the mono face in this app means a number. */}
      {formatName !== null && !tight && (
        <>
          <div className="flex shrink-0 items-baseline gap-1.5">
            <dt className="text-[0.6875rem] text-dim">Format</dt>
            <dd className="text-xs text-text">{formatName}</dd>
          </div>
          <Rule />
        </>
      )}

      {/* The number the format check is talking about, from the engine's own `SIZE_KINDS`. The
          `+n` beside it is every switched-on pile that rule does not count — a sideboard, a
          companion — and it is dim because it is not part of the headline. */}
      <div
        className="flex shrink-0 items-baseline gap-1.5"
        {...tip(
          elsewhere
            ? `The cards a format's size rule counts, plus ${elsewhere} it does not.`
            : "The cards a format's size rule counts — every switched-on pile except the sideboard.",
        )}
      >
        <dt className="text-[0.6875rem] text-dim">Cards</dt>
        <dd className="font-mono text-[0.8125rem] tabular-nums">
          {count(stats.sized)}
          {spare > 0 && <span className="text-dim">+{count(spare)}</span>}
        </dd>
      </div>
      <Rule />

      <div className="flex shrink-0 items-baseline gap-1.5">
        <dt className="text-[0.6875rem] text-dim">Lands</dt>
        <dd className="font-mono text-[0.8125rem] tabular-nums">{count(stats.lands)}</dd>
      </div>
      <Rule />

      {/* An em dash rather than a zero for a deck of nothing but lands: an average of no numbers
          is not 0, which is the same distinction `deckStats` draws in the field itself. */}
      <div className="flex shrink-0 items-baseline gap-1.5" {...tip("Over nonlands, by copies.")}>
        <dt className="text-[0.6875rem] text-dim">Avg. mana</dt>
        <dd className="font-mono text-[0.8125rem] tabular-nums">
          {stats.averageManaValue === null ? "—" : stats.averageManaValue.toFixed(2)}
        </dd>
      </div>
      <Rule />

      {/* The currency rides in the value rather than in the label — `formatPrice` writes the
          symbol — because this row has no room for `Price (USD)` and the glyph says it. The
          unpriced note and spec §5's as-of sentence are the tooltip, which is where the figure
          row put the second of them already. */}
      <div
        className="flex shrink-0 items-baseline gap-1.5"
        {...tip(
          stats.unpriced > 0
            ? `${pricesAsOf(marketplace)} ${count(stats.unpriced)} unpriced.`
            : pricesAsOf(marketplace),
        )}
      >
        <dt className="text-[0.6875rem] text-dim">Price</dt>
        <dd className="font-mono text-[0.8125rem] tabular-nums">
          {formatPrice(stats.price, marketplace.currency)}
        </dd>
      </div>

      {/* What the deck secured from the collection, and what it could not. The shortfall is the
          one red thing on this line and it is a *fact*, not a refusal — the press that acts on it
          is `Send missing to wishlist`, under the deck with the charts, **on a deck that has a
          collection to be short of**. It is drawn under the same condition as this term, so a
          reader is never pointed at a button that is not there.

          **The hairline is inside the condition, not above it**, which is the whole of what makes
          this a clean deletion: every term on this line is preceded by its own `Rule`, so a term
          that leaves without one strands a divider between the last figure and the controls
          pinned right — punctuation with nothing after it to punctuate. */}
      {tracksCollection && (
        <>
          <Rule />
          <div className="flex shrink-0 items-baseline gap-1.5">
            <dt className="text-[0.6875rem] text-dim">Owned</dt>
            <dd className="font-mono text-[0.8125rem] tabular-nums">
              {count(stats.owned)}
              {stats.missing > 0 && (
                <span className="ml-1.5 text-[0.6875rem] text-destructive">
                  {tight ? (
                    <>
                      {/* The words for a screen reader, the sign for the eye. `−3` is only
                          legible beside the number it is short of, which is exactly what a reader
                          hearing this line one term at a time does not have. */}
                      <span className="sr-only">{count(stats.missing)} missing</span>
                      <span aria-hidden="true">−{count(stats.missing)}</span>
                    </>
                  ) : (
                    `${count(stats.missing)} missing`
                  )}
                </span>
              )}
            </dd>
          </div>
        </>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {check}
        {hasGameChangers && (
          // Beside the check rather than inside it, because the two answer different questions:
          // the check counts what is *wrong* and this counts what is *powerful*. A game changer
          // is legal by definition — it is the bracket conversation, not the legality one — so
          // folding the number into a chip that reads "4 issues" would invent four problems.
          //
          // **The edge is back because there is something to press again** (2026-09-10). It was a
          // bordered readout from 2026-08-24, a bordered button for the day the spotlight lasted,
          // and a bare span for the day the filter lived in the toolbar — and a bordered span
          // between two real buttons was the one arrangement that lied, which is why the border
          // went when the handlers did. Both are back together.
          //
          // Off is the line's own dim mono with the border every control on it wears; on takes
          // `text-pie-gold` and the edge with it. That gold is what the crowns and banners on the
          // cards themselves are drawn in, so the chip and what it narrows to say one fact in one
          // colour — deliberately not the accent, which on this very line already means something
          // else: `DeckBracket`'s accent edge says *a reading you can go and look at*.
          <button
            type="button"
            // A toggle, so the press is `aria-pressed` and the name never changes with it. The
            // name is the chip's own contents rather than an `aria-label`, which would replace
            // them — and would silence the `sr-only` twin the narrow arm is named by.
            aria-pressed={gameChangersOnly}
            // The action, for the pointer and for the caret alike: `describes` is left on, so the
            // sentence the visible words cannot say is wired to `aria-describedby` rather than
            // being a hint only a mouse ever gets. Nothing here binds focus handlers of its own,
            // so the spread is the whole binding.
            {...tip(
              gameChangersOnly
                ? "Showing only the game changers. Press to show the whole deck."
                : "Show only the game changers.",
            )}
            onClick={onGameChangersOnlyToggle}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md",
              "border px-2 font-mono text-[0.6875rem] tabular-nums",
              "transition-colors duration-150 motion-reduce:transition-none",
              gameChangersOnly
                ? "border-pie-gold text-pie-gold"
                : "border-border text-dim hover:text-pie-gold focus-visible:text-pie-gold",
              FOCUS,
            )}
          >
            <Crown className="size-3 shrink-0" aria-hidden="true" />
            {/* Three spellings and each is the widest true thing at its size. The count is the
                figure this chip has always carried; `hasGameChangers` without one is a deck whose
                only game changers are parked in a switched-off pile, where a `0` would point at
                cards to go and find that are right there. The narrow arm keeps the words for a
                screen reader and abbreviates for the eye — one string split at a space rather
                than two spellings free to drift. */}
            {gameChangers === 0 ? (
              "Game Changers"
            ) : tight ? (
              <>
                <span className="sr-only">{gameChangerWords(gameChangers)}</span>
                <span aria-hidden="true">{count(gameChangers)} GC</span>
              </>
            ) : (
              gameChangerWords(gameChangers)
            )}
          </button>
        )}
        {bracket}
      </div>
    </dl>
  );
}

/** `1 game changer`, `6 game changers`. */
function gameChangerWords(n: number): string {
  return n === 1 ? "1 game changer" : `${count(n)} game changers`;
}

/**
 * The hairline between two terms.
 *
 * A `div` and not the `span` the design draws, because a `<dl>` whose children are `div`s is a
 * valid description list and one with a stray `span` in it is not — and `aria-hidden`, because a
 * rule is punctuation.
 */
function Rule() {
  return <div aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />;
}
