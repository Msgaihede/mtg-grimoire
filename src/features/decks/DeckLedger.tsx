import { useMemo, type ReactNode } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
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
 * **Two controls at the right end, with a figure between them.** What the rules make of the deck
 * ({@link check}) and the bracket the deck reads as ({@link bracket}) are each a press with a
 * layer behind it, and both are slotted in whole because this component owns nothing about what
 * they open. Between them sits the game-changer count, which is drawn here and is not a control
 * at all: a readout in the dim mono voice the rest of this line reads in, with no edge, no ring
 * and nothing to press.
 *
 * **It was a press for one day, and the day is worth writing down** (2026-09-09). From
 * 2026-09-08 the chip armed a *spotlight* — hovering it, or latching it with a click, faded every
 * card in the deck that is not a game changer to a quarter. It answered *which ones* by making
 * everything else dimmer, and on a hundred-card desk a hundred stacked quarter-opacity cards is a
 * blur rather than an answer: the deck the reader was reading the answer out of had stopped being
 * legible. The question moved to a **Game Changers** chip in the toolbar's label-filter row, which
 * narrows the deck to those cards and leaves every card that survives looking exactly as it looked
 * unfiltered — a shorter list rather than a dimmer one. What is left here is the count, in the
 * place it has held since 2026-08-24 and in the words it has used throughout.
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
  /** Copies of the cards the format calls game changers, over the piles that count. Nothing is
   *  drawn for a deck with none — `0 game changers` is a readout pointing at cards to go and find
   *  where there are none to find, and the words are the whole of what this figure is. */
  gameChangers: number;
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
        {gameChangers > 0 && (
          // Beside the check rather than inside it, because the two answer different questions:
          // the check counts what is *wrong* and this counts what is *powerful*. A game changer
          // is legal by definition — it is the bracket conversation, not the legality one — so
          // folding the number into a chip that reads "4 issues" would invent four problems.
          //
          // **A `span` with no edge, because the edge is what said "pressable"** (2026-09-09).
          // This was a bordered readout from 2026-08-24 and a bordered *button* for the day the
          // game-changer spotlight lasted — see the component's doc block for what that press did
          // and why it went. A bordered span left standing between two real buttons would go on
          // making the offer the press used to keep, so the border went with the handlers and what
          // is left is dim mono: the voice every other figure on this line reads in, which is what
          // this is.
          <span className="inline-flex h-7 shrink-0 items-center whitespace-nowrap font-mono text-[0.6875rem] tabular-nums text-dim">
            {/* The narrow arm is exactly what it was and its `sr-only` twin is **load-bearing
                again**: while the count was a press it carried an `aria-label`, and a label
                *replaces* an element's contents for naming, so the twin was announced to nobody.
                The label went with the press, so at this width these two spans are the whole of
                what names the figure — the words for a screen reader, the abbreviation for the
                eye — and they stay one string split at a space rather than two free to drift. */}
            {tight ? (
              <>
                <span className="sr-only">{gameChangerWords(gameChangers)}</span>
                <span aria-hidden="true">{count(gameChangers)} GC</span>
              </>
            ) : (
              gameChangerWords(gameChangers)
            )}
          </span>
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
