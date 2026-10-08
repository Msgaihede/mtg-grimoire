/**
 * What the deck adds up to, as four figures with their qualifications under them.
 *
 * **Two of the four are conditional, and both are absent rather than greyed** — this feature's
 * standing answer, and right here twice over. A **Virtual** deck owns nothing by construction,
 * so an `Owned` count over one is arithmetic about a binder the reader never claimed to have;
 * and a deck with no plan has nothing for `Matches theory` to be a fraction *of*. A dash in
 * either place would be worse than nothing, because a dash on a figure in this app already means
 * *no number to give* (the average of a deck of nothing but lands), and re-using it for *no
 * question to ask* puts two meanings on one glyph.
 *
 * **Every figure is handed in already true**, which is why this takes a `DeckStatsSummary`, a
 * `Marketplace` and two answers rather than a deck: `tracksCollection` is `deckKind.ts`' and
 * `theory` is the plan's, and `DeckEditor` answers each once for every surface that owes a
 * reader the same fact. A component that decided either for itself would be the second place in
 * the editor able to disagree about it.
 *
 * **Money goes through `formatPrice` and never converts.** The marketplace was chosen when the
 * deck was read, so every figure here is already quoted in it; what this component owns is which
 * currency formats them. A `null` price is the answer — never another marketplace's number, and
 * never `$0.00`.
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { DeckStatsSummary } from "../DeckStats";
import { percent, StatsCard } from "./StatsCard";

/**
 * Two columns while there is room for two, one below that, and never three whatever width the
 * band hands this card.
 *
 * **An inline style rather than an arbitrary Tailwind value**, which is this repo's rule for a
 * column template: Tailwind scans source text for whole class names, and a mistyped `calc()`
 * inside one emits no rule at all — a grid that silently falls back to one column and reads as a
 * design decision nobody made.
 *
 * The arithmetic is the "as many as fit, capped at N" idiom. A track's minimum is *at least half
 * the card*, so two is the most that can ever fit; below twice the 7.5rem floor that half drops
 * under the floor and only one does. The `min(100%, …)` is the floor under the floor: at a card
 * narrower than 7.5rem the track would otherwise be wider than its own container and the figures
 * would hang out of the border.
 *
 * ⚠️ **The `1rem` is `gap-x-4` written a second time**, because a `gap` is not readable from
 * inside a track template. They are one number and move together — a gap widened without this
 * would let two tracks claim more than the card has and push the right-hand column out.
 *
 * With three cells the third sits alone on the second row, which is the honest shape: the grid
 * says where a figure *is*, and a cell stretched to fill a hole would make the odd figure the
 * emphasised one.
 *
 * **Measured 2026-09-10, headless Edge over this rule on a standalone page** — not the shipped
 * window, so read it as the template's behaviour rather than as the band's. The switch is at
 * **256px of content width exactly**: 254px draws one 254px track and 256px draws two of 120.
 * It never draws three — four cells at a 1600px card are still two tracks of 792 — and 2/3/4
 * cells come out as one row / two rows / two rows above the threshold and stacked below it. No
 * horizontal overflow at any width down to 100px. At 80px the *value* overflows its cell, which
 * no template can fix: `$1,234.56` at this card's 20px mono face is ~101px wide, and the track
 * had already given it every pixel the card had.
 */
const FIGURE_GRID: CSSProperties = {
  gridTemplateColumns:
    "repeat(auto-fit, minmax(min(100%, max(7.5rem, calc((100% - 1rem) / 2))), 1fr))",
};

export function DeckFigures({
  stats,
  marketplace,
  tracksCollection,
  theory,
}: {
  stats: DeckStatsSummary;
  /** Which marketplace every figure on the Price line is quoted at — its currency for the
   *  formatter, its label for the provenance sentence. The arithmetic needs neither: the rows
   *  arrived priced. */
  marketplace: Marketplace;
  /**
   * Whether this deck reads the reader's collection at all. A VIRTUAL deck does not.
   *
   * **Required rather than optional**, so a host that has not thought about it cannot silently
   * get the arm that draws an owned count over a deck that owns nothing.
   */
  tracksCollection: boolean;
  /** How far the live list has got toward the deck's plan, or null where there is no plan.
   *  `have` copies of `want` planned. */
  theory: { have: number; want: number } | null;
}): JSX.Element {
  return (
    <StatsCard title="Figures">
      {/* A `<dl>` whose children are all `div`s, which is the one arrangement that is a valid
          description list — the same rule `DeckLedger` and `FigureRow` keep. The notes live
          *inside* the `<dd>` for the same reason: HTML's content model for a `div` in a `<dl>`
          is `dt`s then `dd`s and nothing else, so a note as a sibling paragraph would be markup
          claiming to be a description list and failing to be one. */}
      <dl className="grid gap-x-4 gap-y-3" style={FIGURE_GRID}>
        <Figure label="Cards" value={count(stats.sized)} notes={cardNotes(stats)} />
        <Figure
          label="Price"
          value={formatPrice(stats.price, marketplace.currency)}
          notes={priceNotes(stats, marketplace, tracksCollection)}
          // Which marketplace's money this is, and when it was quoted — the sentence this app
          // puts on every money figure that has no room to write it out. It is the only thing
          // on this card that names the marketplace at all.
          hint={pricesAsOf(marketplace)}
        />
        {tracksCollection && (
          <Figure label="Owned" value={count(stats.owned)} notes={ownedNotes(stats)} />
        )}
        {theory !== null && (
          <Figure
            label="Matches theory"
            value={`${count(theory.have)} of ${count(theory.want)}`}
            notes={theoryNotes(theory)}
          />
        )}
      </dl>
    </StatsCard>
  );
}

/**
 * One figure: what it is, the already-formatted number, and the qualifications that keep the
 * number honest.
 *
 * Its own component so that every cell of the grid is the same object rather than four
 * arrangements that agree today — and so that the empty-note rule is written once. An empty
 * `notes` draws nothing at all: a blank line under a figure reads as a note that failed to
 * render, which is exactly the doubt a note exists to remove.
 */
function Figure({
  label,
  value,
  notes,
  hint,
}: {
  label: string;
  /** Already formatted — money through `formatPrice`, counts through `count`. A component that
   *  formatted its own would be a second place money is written. */
  value: string;
  notes: readonly string[];
  hint?: ReactNode;
}): JSX.Element {
  const tip = useTooltip();
  return (
    <div className="min-w-0" {...tip(hint)}>
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="font-mono text-xl tabular-nums text-accent">
        {value}
        {/* `block`, so each note is its own line under the figure rather than a run beside it —
            and each is a separate element, so the value and its notes never concatenate into one
            unreadable string the way a `gap` between two texts does. Keyed by the note itself:
            each ends in a different word, so two can never collide, and a key by position would
            re-use a DOM node when a note in front of it is dropped. */}
        {notes.map((note) => (
          <span key={note} className="mt-0.5 block font-mono text-xs tabular-nums text-dim">
            {note}
          </span>
        ))}
      </dd>
    </div>
  );
}

/**
 * What the headline card count does **not** count.
 *
 * Two different absences, and neither is derivable from the other: `elsewhere` is the piles that
 * are switched **on** and outside the format's size rule — a sideboard, a companion — while
 * `inactive` is the piles switched off, which count toward nothing anywhere. A reader adding the
 * columns on their desk and coming up short is owed both.
 *
 * **The pile names itself where there is one of it**, rather than the fixed word *sideboard*:
 * `elsewhere` is whatever piles the deck actually has outside `SIZE_KINDS`, which may be a
 * Companion or a pile of the reader's own, and a note that called a Companion a sideboard would
 * be naming a column that is not on the desk. Two or more have no one name to give, so the note
 * says `elsewhere` and the piles themselves are one glance away. Lowercased because the note is
 * half a sentence rather than a heading — `DeckLedger`'s own treatment of the same names.
 */
function cardNotes(stats: DeckStatsSummary): string[] {
  const notes: string[] = [];
  // `copies − sized` exactly, and never a second application of the size rule here: a caller
  // that re-derived which piles count could disagree with the figure it is writing under.
  const spare = stats.copies - stats.sized;
  if (spare > 0) {
    const where =
      stats.elsewhere.length === 1 ? stats.elsewhere[0].name.toLowerCase() : "elsewhere";
    notes.push(`+${count(spare)} ${where}`);
  }
  if (stats.inactive > 0) notes.push(`+${count(stats.inactive)} inactive`);
  return notes;
}

/**
 * The total split the way the copies are, plus the copies that are in no total at all.
 *
 * The two money lines read **their own** field's `null` rather than `price`'s, though the three
 * are null together: that is what makes the `formatPrice` call total rather than a claim about a
 * field this function does not hold. The missing line is dropped at zero because `— missing` on
 * a deck the reader owns outright is a shortfall drawn where there is none.
 *
 * **The unpriced note is unconditional on any of that**, and it is the one thing on this card
 * that declares those copies at all. A total that silently omits them lies by rounding down —
 * and the holes are not the same at every marketplace, so the number travels with the figure it
 * sits under and never across a switch.
 *
 * ⚠️ **The two money lines are a _collection_ readout and go with the Owned figure on a Virtual
 * deck.** They read `ownedPrice` and `missingPrice`, which are `stats.owned` and `stats.missing`
 * priced — and on a deck the reader tracks without owning the cardboard every row's
 * `ownedQuantity` is `0` by construction, so the split is `$0.00 owned` against the whole price
 * `missing`. Both numbers are true of the arithmetic and false about the reader, which is the
 * exact sentence `tracksCollection` exists to keep off the screen; the total above them is a fact
 * about the *list* and stays. Same rule, same reason, as the `Owned` figure beside them and as
 * the whole shortfall block further down the band — and it is easy to miss here because the
 * figure this card refuses is not the one the flag is named after.
 */
function priceNotes(
  stats: DeckStatsSummary,
  marketplace: Marketplace,
  tracksCollection: boolean,
): string[] {
  const notes: string[] = [];
  if (tracksCollection && stats.ownedPrice !== null) {
    notes.push(`${formatPrice(stats.ownedPrice, marketplace.currency)} owned`);
  }
  if (tracksCollection && stats.missingPrice !== null && stats.missingPrice > 0) {
    notes.push(`${formatPrice(stats.missingPrice, marketplace.currency)} missing`);
  }
  if (stats.unpriced > 0) notes.push(`${count(stats.unpriced)} unpriced`);
  return notes;
}

/**
 * What is still to find, or that there is nothing.
 *
 * `every copy` rather than silence, because an owned figure with no note under it reads as a
 * figure whose note has not loaded — this is the one line that says the deck is complete, and it
 * is worth a word.
 *
 * **Dim like every other note here and deliberately not the destructive colour.** The header's
 * ledger draws the shortfall red because it is the one figure on that line a reader is meant to
 * act on, and the press that acts on it is the shortfall block further down this band. A third
 * red number, in a card whose whole grammar is *figure, then quiet qualification*, would be
 * shouting the same fact a third time.
 *
 * **No note at all on a deck with no copies**, which is where `every copy` would be vacuously
 * true and read as a claim about a deck that has nothing in it. `owned + missing` is the copies
 * in every counted pile, so the test is exactly "is there anything to be short of".
 */
function ownedNotes(stats: DeckStatsSummary): string[] {
  if (stats.owned + stats.missing === 0) return [];
  return [stats.missing > 0 ? `${count(stats.missing)} missing` : "every copy"];
}

/**
 * How far along the plan is, as a percentage.
 *
 * **Nothing at all for a plan of nothing**, rather than the em dash `percent(null)` writes: a
 * dash is what this app prints where a number exists and is unknown, and a percentage of an
 * empty plan does not exist. The figure above it still reads `0 of 0`, which is the honest
 * statement and the one a reader can act on by putting a card in the plan.
 */
function theoryNotes(theory: { have: number; want: number }): string[] {
  if (theory.want === 0) return [];
  return [percent(theory.have / theory.want)];
}
