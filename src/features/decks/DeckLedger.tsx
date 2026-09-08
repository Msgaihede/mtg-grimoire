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
 * **The three controls at the right end are not figures.** What the rules make of the deck
 * ({@link check}), what the format calls powerful, and the bracket the two add up to are each a
 * press; the outer two are slotted in whole, because each opens a layer this component owns
 * nothing about, and the middle one is drawn here because it opens nothing at all.
 *
 * **The middle one is the odd press on the line and worth naming as such** (2026-09-08). The
 * game-changer count is a *readout that is also a control*: hovering it, or pressing it to latch,
 * fades every card in the deck that is not a game changer to a quarter — see {@link spotlight}.
 * It is drawn here rather than slotted like its two neighbours because there is no layer, no
 * anchor and no findings behind it; what it needs is two gestures reported and a boolean handed
 * back, and the state it composes them into belongs to the editor drawing the deck it lights up.
 */
export function DeckLedger({
  cards,
  marketplace,
  formatName,
  gameChangers,
  spotlight,
  onSpotlightToggle,
  onSpotlightHover,
  tight,
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
   *  drawn for a deck with none — a chip reading `0 game changers` is a control saying there is
   *  something to look at, and since that chip became a press it would be one that does nothing
   *  when pressed. */
  gameChangers: number;
  /**
   * Whether the game-changer spotlight is **latched** on — the chip's own pressed state, and
   * deliberately not the effective one the deck is drawn under.
   *
   * The editor's effective state is `latched || hovered`, and the difference is what makes this
   * chip's three appearances legible. A latch is a *toggle*, which is exactly what `aria-pressed`
   * describes and exactly what a second press releases; a hover is the control being *touched*,
   * which is not a state a button is in and which the chip draws for itself with a `hover:`
   * variant. Handing the composite down instead would say `aria-pressed` of a chip nobody has
   * pressed, and would make the pointer arriving indistinguishable from the latch it is offering.
   */
  spotlight: boolean;
  /**
   * A press: latch the spotlight on, or release a latch. The chip is told nothing about which —
   * it reports the gesture and the editor holds the state, for the reason every other control on
   * this line reports rather than decides.
   */
  onSpotlightToggle: () => void;
  /**
   * The pointer arriving on the chip or leaving it, and **the caret doing the same thing** —
   * `onFocus`/`onBlur` are wired to this alongside `onMouseEnter`/`onMouseLeave`, because a
   * reveal a keyboard cannot reach is not a reveal. One callback for both, since neither the chip
   * nor the editor has any use for the difference.
   *
   * ## Two callbacks rather than one `onSpotlight({ latched?, hovered? })`
   *
   * The partial-object shape can spell states this chip can never ask for — `{}`, which means
   * nothing at all, and `{ latched: true, hovered: false }`, which is two gestures at once — so
   * the receiver has to read a bag and work out what happened. Two named callbacks are two verbs:
   * each one is a gesture the reader actually made, the compiler refuses a call that names
   * neither, and the composition (`latched || hovered`) stays entirely the editor's, which is
   * where it can also be gated on the deck still having a game changer in it.
   */
  onSpotlightHover: (on: boolean) => void;
  /**
   * The narrowest editor column this header reasons about, where the two counted figures that
   * carry a sentence say it in a number instead.
   *
   * Nothing is dropped for being narrow that a reader could not otherwise get at: the shortfall
   * keeps its words for a screen reader (`sr-only`), and the game-changer count is the second
   * half of the bracket popup's own headline.
   */
  tight: boolean;
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

  // **Bound here rather than spread inline, because this is the one anchor in the file whose own
  // handlers collide with the tooltip's.** `useTooltip`'s binding is four handlers, and two of
  // them are `onFocus`/`onBlur` — the pair React re-implements over `focusin`/`focusout` so a
  // hint reaches a caret and not just a pointer. The spotlight chip needs those two props for
  // itself, and a `{...tip(…)}` spread followed by an `onFocus` of its own does not merge them:
  // the later prop **replaces** the earlier one, silently, and what is lost is the half of the
  // tooltip only a keyboard reader ever sees. Every other `tip(…)` on this row goes on an
  // element with no focus handlers of its own, which is why this is the only one bound to a name.
  //
  // The pointer half needs no such care: the tooltip listens on `onPointerEnter`/`onPointerLeave`
  // and the chip arms itself on `onMouseEnter`/`onMouseLeave`, which are four different props.
  const spotlightTip = tip(spotlightName(gameChangers, spotlight), { describes: false });

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
      <Rule />

      {/* What the deck secured from the collection, and what it could not. The shortfall is the
          one red thing on this line and it is a *fact*, not a refusal — the press that acts on it
          is `Send missing to wishlist`, under the deck with the charts. */}
      <div className="flex shrink-0 items-baseline gap-1.5">
        <dt className="text-[0.6875rem] text-dim">Owned</dt>
        <dd className="font-mono text-[0.8125rem] tabular-nums">
          {count(stats.owned)}
          {stats.missing > 0 && (
            <span className="ml-1.5 text-[0.6875rem] text-destructive">
              {tight ? (
                <>
                  {/* The words for a screen reader, the sign for the eye. `−3` is only legible
                      beside the number it is short of, which is exactly what a reader hearing
                      this line one term at a time does not have. */}
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

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {check}
        {gameChangers > 0 && (
          // Beside the check rather than inside it, because the two answer different questions:
          // the check counts what is *wrong* and this counts what is *powerful*. A game changer
          // is legal by definition — it is the bracket conversation, not the legality one — so
          // folding the number into a chip that reads "4 issues" would invent four problems.
          //
          // **And since 2026-09-08 the figure is also the press that answers *which ones*.** The
          // count says how many; the deck laid out under it says nothing about where they are,
          // and on a hundred-card desk that is a hunt through four views' worth of gold crowns.
          // Hovering the chip fades every card that is not a game changer to a quarter, so the
          // ones that are stand out of the deck; a click latches the same state so the reader can
          // take their hand off the mouse and go and look. The chip decides neither — it reports
          // the two gestures and the editor composes `latched || hovered`, which is why hovering
          // while latched changes nothing and only a second press lets go.
          //
          // **The reveal is on focus as well as on hover, and that is not a courtesy.** A chip
          // that only a pointer could arm would put the whole affordance out of reach of a
          // keyboard, so `onFocus`/`onBlur` are the same callback as `onMouseEnter`/`onMouseLeave`
          // and a reader who Tabs here gets the spotlight for as long as the caret rests on it.
          //
          // **Three appearances, and only one of them is a *state*.** Off is what shipped —
          // `border-border`, `text-dim`. Hovered (or focused) paints the words gold and leaves
          // the edge alone, and it is drawn by this chip's own `hover:` variant rather than by
          // {@link spotlight}, because a pointer resting on a control is not a state the control
          // is in. Latched takes the border too and adds the crown, which is the mark the cards
          // it is lighting up wear. So hovering while latched changes nothing on screen, exactly
          // as it changes nothing in the editor — the gold is already there.
          <button
            type="button"
            // A toggle button, so `aria-pressed` is how the latch is said — the gold border and
            // the crown are the sighted half of exactly this sentence, and the hover is neither.
            aria-pressed={spotlight}
            // The accessible name carries the **action**, because the visible text is a readout
            // and a readout is not an affordance: "6 game changers" tells nobody there is
            // anything to press. The count stays the name's first token so the visible words are
            // still a prefix of it (WCAG 2.5.3) at both widths — `tight` deletes the word from
            // the *drawing* and never from the name.
            aria-label={spotlightName(gameChangers, spotlight)}
            // The same sentence for a pointer, and one string rather than two so the two readers
            // cannot be told different things — `ValidationPanel`'s arrangement one control over.
            // `describes: false`, since the name above already says it and a wired
            // `aria-describedby` would have it announced twice.
            {...spotlightTip}
            onClick={onSpotlightToggle}
            onMouseEnter={() => onSpotlightHover(true)}
            onMouseLeave={() => onSpotlightHover(false)}
            // **Both, in that order** — see {@link spotlightTip}. The spread above puts the
            // tooltip's own `onFocus`/`onBlur` on this element and these two would otherwise
            // replace them, leaving a keyboard reader with the spotlight and no hint. The hint
            // goes first because it is the passive half: if `onSpotlightHover` ever threw, the
            // panel a reader asked for would already be open.
            onFocus={(event) => {
              spotlightTip.onFocus?.(event);
              onSpotlightHover(true);
            }}
            onBlur={(event) => {
              spotlightTip.onBlur?.(event);
              onSpotlightHover(false);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md",
              "border px-2 font-mono text-[0.6875rem] tabular-nums",
              "transition-colors duration-150 motion-reduce:transition-none",
              // The border is what tells a *latch* from a *hover*: hovering paints the words gold
              // and leaves the edge where it was, so the chip says "this is live right now";
              // latching takes the edge too, so it says "this is still on after you let go". One
              // extra signal for the one state that outlives the pointer.
              //
              // `text-pie-gold` is the gold the crowns and the banners on the cards themselves
              // are drawn in — one colour for one fact, and deliberately not the accent, which on
              // this line already means something else: `DeckBracket`'s accent edge says *a
              // reading you can go and look at*, and this is not a reading.
              spotlight
                ? "border-pie-gold text-pie-gold"
                : "border-border text-dim hover:text-pie-gold focus-visible:text-pie-gold",
              FOCUS,
            )}
          >
            {/* Drawn only while the spotlight is on, so the chip carries the same mark the cards
                it is lighting up carry — the reader's eye leaves a crown and lands on crowns.
                `aria-hidden` and a bare lucide glyph rather than `GameChangerMark`: that
                component names itself and binds a tooltip of its own, which inside a button that
                already has both would be a second name and a second hint on one control. */}
            {spotlight && <Crown className="size-3 shrink-0" aria-hidden="true" />}
            {/* The narrow arm is exactly what it was, and one thing about it changed meaning:
                an `aria-label` *replaces* an element's contents for naming, so the `sr-only`
                twin is now announced to nobody — {@link spotlightName} says the words instead.
                It is kept rather than deleted because it is the name this chip falls back to if
                the label ever goes, and because it keeps the two widths one string split at a
                space rather than two spellings free to drift. */}
            {tight ? (
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
 * What the game-changer chip is called, and what a pointer resting on it is told — one string
 * for both, so the two readers cannot be told different things.
 *
 * It opens with {@link gameChangerWords}, which is the visible text at the roomy width and the
 * `sr-only` twin at the narrow one, so the drawn words stay a prefix of the name (WCAG 2.5.3)
 * whichever way the chip is drawn. What follows is the **action**, because that is the half a
 * readout cannot show: a figure that says `6 game changers` and nothing else is a control nobody
 * knows is a control. It names the state the press would move *to* rather than the one the chip
 * is in — a toggle's label is a verb, and `aria-pressed` is already saying where it stands.
 */
function spotlightName(n: number, spotlight: boolean): string {
  return spotlight
    ? `${gameChangerWords(n)} — press to stop spotlighting them in the deck`
    : `${gameChangerWords(n)} — press to spotlight them in the deck`;
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
