/**
 * The Card distribution readout — bars over the deck's cards, cut four ways, then the deck's
 * creature split and its type breakdown, with the opening-hand odds for the chosen cut under all
 * of it.
 *
 * **One card holding two readouts, because one control drives both.** The `by` select in this
 * card's header decides what a bucket *is*, and both halves are then answers about the same cut:
 * the bars say what the deck is made of and the table says what it is likely to draw. Two cards
 * would need two selects a reader had to keep in step by hand, or one select in one card silently
 * reaching into the next.
 *
 * **Two readouts between them answer to no control at all** (2026-09-28): `Creatures vs
 * noncreatures` and the Creature/Land type breakdown are drawn under the bars whatever `by` says.
 * They are *what is this deck made of* asked the two ways every deckbuilder asks it — how much of
 * it is bodies, and what its lands can fetch — and a reader who set the cut to `Card name` to find
 * one card has not stopped wanting either. They sit above the odds rather than below them because
 * they are composition, like the bars, and the odds are the one half of the card that is about
 * drawing.
 *
 * **Every piece of state this card reads is its caller's** — `by` and the odds' three numbers
 * arrive with their setters from `DeckStats`, because the band's three-column layout moves this
 * card between column containers and a move remounts it. Held here, a resize across the
 * breakpoint would put the cut back to `Types` under a reader's hands.
 */
import { useMemo, type JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DeckCard } from "@/lib/ipc";
import {
  activeCards,
  distribution,
  DISTRIBUTION_BAR_LIMIT,
  DISTRIBUTION_MODES,
  foldBuckets,
  type Bucket,
  type DistributionBy,
} from "../deckBuckets";
import { X_GROUP_KEY } from "../grouping";
import type { DeckStatsSummary } from "../DeckStats";
import { CreatureSplitBar } from "./CreatureSplitBar";
import { OpeningHandOdds, type OddsQuestion } from "./OpeningHandOdds";
import { BarChart, StatsCard, type ChartBar } from "./StatsCard";
import { TypeBreakdown } from "./TypeBreakdown";

/** How tall the bars are drawn — shorter than the mana curve's 152, because this chart shares its
 *  card with a table and the pair has to fit the band's row. */
const BAR_HEIGHT = 120;

/**
 * A floor under the label boxes, so a one-line word and a two-line one leave their bars on the
 * same baseline.
 *
 * Worth setting here and not on the curve: these labels are *words* (`Planeswalker`, a category's
 * name, a card's name) and wrap, where a curve is labelled with single glyphs. Without it the
 * chart's baseline is decided by whichever bucket happens to hold the longest name today, and the
 * bars visibly re-seat themselves as the reader edits the deck.
 */
const LABEL_MIN_HEIGHT = 36;

/**
 * The tail of the sentence a screen reader hears after `"12 cards"`, for one bucket of one cut.
 *
 * **Two rules, and the first is the one that is easy to get wrong.** `BarChart` writes
 * `{count} {count === 1 ? "card" : "cards"} {said}` — it pluralises the *noun* and never the
 * tail — so a tail beginning with a verb reads *"1 card are creatures"*, at exactly the count a
 * singleton deck puts on nearly every bar. Every phrase here is therefore prepositional, which is
 * also the shape the mana curve's own `said` already has (`"at mana value 1"`).
 *
 * And each phrase **names the cut** rather than only the bucket. `Removal` and `Lightning Bolt`
 * are proper nouns: heard alone after a count they are a word with no question attached to them,
 * and the select that decides which question is being asked is somewhere the reader listening is
 * not.
 */
function said(by: DistributionBy, bucket: Bucket): string {
  switch (by) {
    case "types":
      return `of type ${bucket.label}`;
    case "categories":
      return `in the ${bucket.label} category`;
    case "cardName":
      return `named ${bucket.label}`;
    case "manaValue":
      // Every numeric bucket, and the X bucket, read as a place on the axis. The one bucket left
      // is `deckBuckets`' "No mana value", which is the *absence* of one — "at mana value No mana
      // value" is what a bare template gives it, so it is worded instead. It is told apart by not
      // being either of the other two rather than by matching its own label, which is that
      // module's private wording and not this one's to depend on.
      return bucket.key === X_GROUP_KEY || /^\d/.test(bucket.label)
        ? `at mana value ${bucket.label}`
        : `with ${bucket.label.toLowerCase()}`;
  }
}

/** What the folded bar stands for, per cut. `foldBuckets` labels it `Other`, which says nothing on
 *  its own once the chart around it is gone. */
const REST_SAID: Record<DistributionBy, string> = {
  types: "of every other type",
  categories: "in every other category",
  manaValue: "at every other mana value",
  cardName: "of every other name",
};

/**
 * The bars and the odds table under them, in one bordered card.
 *
 * @param cards the deck's rows **unfiltered** — the two halves each narrow for themselves, and
 * they narrow differently on purpose.
 * @param separateXGroup the deck's own `Split X` flag. It reaches the bars alone: the odds table
 * is a ranked list rather than a curve, and it is handed the cut with no X bucket in it because
 * `{X}{B}{B}{B}` is a card you are as likely to draw whichever bar the reader files it under.
 * @param stats the band's one `deckStats` reading — the creature split's counts come off its
 * curve, so the split and the Mana curve's legend are one number.
 * @param by how the cards are cut, and `onByChange` asks for another — see the note below.
 * @param odds the opening-hand question, and `onOddsChange` asks for another, handed straight
 * through to {@link OpeningHandOdds}.
 */
export function CardDistribution({
  cards,
  separateXGroup,
  stats,
  by,
  onByChange,
  odds,
  onOddsChange,
}: {
  cards: readonly DeckCard[];
  separateXGroup: boolean;
  stats: DeckStatsSummary;
  by: DistributionBy;
  onByChange: (by: DistributionBy) => void;
  odds: OddsQuestion;
  onOddsChange: (odds: OddsQuestion) => void;
}): JSX.Element {
  /*
   * `by` is how the cards are cut — **one piece of state driving both halves of this card, which
   * is a deliberate departure from the design this was built from.**
   *
   * That design puts this select in the Card distribution header and, in its own script, wires it
   * only to the odds table underneath: the bars stay bucketed by card type whatever it says. A
   * control in a card's header that changes only the lower half of that card is a control that
   * reads as broken — a reader presses `Card name`, watches the bars not move, and concludes the
   * select does nothing. So the state lives here, the bars read it, and `OpeningHandOdds` is
   * handed it.
   *
   * **Do not "fix" this back by comparing against the spec.** The departure is the whole reason
   * `deckBuckets.distribution` takes a `by` at all.
   *
   * It is `DeckStats`' state since 2026-09-28 rather than this component's — see the header.
   */

  const bars = useMemo<ChartBar[]>(() => {
    // **Active** copies, not sized ones: the bars are a picture of what the reader has built, and
    // a sideboard is cards they own and sleeve. The odds below count the sized piles alone,
    // because a sideboard is not in the library the opening seven comes out of. `activeCards` and
    // `sizedCards` are those two readings, and the difference between them is deliberate.
    const cut = distribution(activeCards(cards), by, separateXGroup);
    // Which keys the cut itself produced. `foldBuckets` only ever *appends* one bucket of its own,
    // so a bar whose key the cut did not answer with is that fold — read that way rather than by
    // matching the literal key, which is `deckBuckets`' own spelling and not part of its contract.
    const own = new Set(cut.map((bucket) => bucket.key));
    return foldBuckets(cut, DISTRIBUTION_BAR_LIMIT).map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      count: bucket.count,
      said: own.has(bucket.key) ? said(by, bucket) : REST_SAID[by],
    }));
  }, [cards, by, separateXGroup]);

  // Reduced rather than spread: `Math.max(...[])` answers `-Infinity`, which would draw every bar
  // of an empty chart at full height.
  const max = bars.reduce((tallest, bar) => Math.max(tallest, bar.count), 0);

  return (
    <StatsCard
      title="Card distribution"
      actions={
        <Dropdown
          size="sm"
          value={by}
          // Narrowed by lookup rather than by a cast: a value the list does not hold is refused
          // outright, so nothing outside the union can reach the state or the table under it.
          onChange={(value) => {
            const picked = DISTRIBUTION_MODES.find((mode) => mode.value === value);
            if (picked) onByChange(picked.value);
          }}
          options={DISTRIBUTION_MODES}
          // Named for what it cuts, and never the bare `Group by` the editor's toolbar already
          // answers to: two controls sharing one accessible name on one screen is a name that
          // identifies neither, and this card is one scroll below that row.
          label="Card distribution by"
        />
      }
    >
      {bars.length > 0 ? (
        <BarChart
          bars={bars}
          max={max}
          height={BAR_HEIGHT}
          fill="var(--color-accent)"
          labelWraps
          labelMinHeight={LABEL_MIN_HEIGHT}
        />
      ) : null}
      {/* Drawn whatever `by` says — see the header. The split hides itself for a deck with no
          nonland spells; the breakdown is drawn wherever the bars are, since both count the
          same active copies and a breakdown of none is two empty panels saying so twice. */}
      <CreatureSplitBar stats={stats} />
      {bars.length > 0 ? (
        <div className="border-t border-border pt-3">
          <TypeBreakdown cards={cards} />
        </div>
      ) : null}
      {/* The seam between the composition and the odds. Drawn only where there is something
          above it — a rule over nothing is a line whose meaning the reader has to work out, and a
          deck with no bars has no sized cards either, so the odds half below is already saying
          the list is empty. */}
      <div className={bars.length > 0 ? "border-t border-border pt-3" : undefined}>
        <OpeningHandOdds cards={cards} by={by} odds={odds} onOddsChange={onOddsChange} />
      </div>
    </StatsCard>
  );
}
