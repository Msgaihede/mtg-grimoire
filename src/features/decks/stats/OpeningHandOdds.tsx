/**
 * The lower half of the Card distribution card: the chance of meeting each bucket in an opening
 * hand.
 *
 * **It owns the three numbers the reading is made of and none of the cut.** `by` arrives from the
 * card above, because the select that decides it is drawn in that card's header and a control in
 * a header that moved only one half of its own card would read as broken. What is asked here is
 * the other half of the question — *at least how many, in a hand of how many* — and those two are
 * nobody else's business: no other readout in the band changes when the reader steps the hand to
 * eight to see what a Commander mulligan looks like.
 */
import { useMemo, useState, type JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { QuantityStepper } from "@/components/QuantityStepper";
import { plural } from "@/lib/counts";
import type { DeckCard } from "@/lib/ipc";
import { compareLabels } from "@/lib/options";
import { cn } from "@/lib/utils";
import {
  distribution,
  DISTRIBUTION_HEADING,
  sizedCards,
  type DistributionBy,
} from "../deckBuckets";
import { DEFAULT_HAND_SIZE, handOdds, ODDS_MODES, type OddsMode } from "../openingHand";
import { percent, Track } from "./StatsCard";

/**
 * The height of one row, on both sides of the grid.
 *
 * **A number rather than "whatever the content is", because the two columns are two elements and
 * nothing in the DOM ties row *n* of the bars to row *n* of the table.** A `<tr>` sized by its own
 * text and a `<div>` sized by its own bar agree at exactly one type size and drift at every other;
 * a bar drawn beside the wrong row is a chart that lies rather than one that looks untidy. 22px is
 * `text-xs` with air either side, and a table row's height is a *minimum*, so it is the floor on
 * both sides and the same floor.
 */
const ROW_HEIGHT = 22;

/** The heading line's own height, for the same reason and on the same two sides — the bars column
 *  has to spend it too, or every bar sits one heading higher than its row. */
const HEAD_HEIGHT = 20;

/** How thick a chance bar is drawn. Thinner than the mana pips' 12: there is one per row here and
 *  a dozen rows, where that tile draws two per colour and has the room. */
const BAR_HEIGHT = 8;

/** The heading over a column of this table — small, dim and set apart from the figures under it. */
const COLUMN_HEAD = "text-[0.6875rem] font-medium uppercase tracking-wide text-dim";

/** Every figure in the table. Mono and `tabular-nums` because a column of percentages a reader
 *  scans down has to have its digits in the same place on every row. */
const FIGURE = "text-right font-mono text-xs tabular-nums text-text";

/**
 * The odds table, its three controls and the bars beside it.
 *
 * @param cards the deck's rows unfiltered — narrowed here to {@link sizedCards}, which is the
 * library an opening hand is actually drawn from.
 * @param by the cut, from the card above. Buckets are **not** folded on this side: a table row is
 * legible at any length, and a reader who set the cut to `Card name` did it to find one card.
 */
export function OpeningHandOdds({
  cards,
  by,
}: {
  cards: readonly DeckCard[];
  by: DistributionBy;
}): JSX.Element {
  const [mode, setMode] = useState<OddsMode>("atLeast");
  const [want, setWant] = useState(1);
  const [hand, setHand] = useState(DEFAULT_HAND_SIZE);

  const sized = useMemo(() => sizedCards(cards), [cards]);
  /** The population — **copies, not rows**, which is the only reading the hypergeometric
   *  arithmetic in `openingHand.ts` is true under. */
  const deck = useMemo(() => sized.reduce((n, card) => n + card.quantity, 0), [sized]);

  const rows = useMemo(
    () =>
      // Ranked, and deliberately **not** in the cut's own order the way the bars above are. This
      // list answers *what am I most likely to draw*, which is a different question from the
      // bars' *what is this deck made of* — so it does not inherit their order, and a reader
      // scanning down it meets the biggest number first. `compareLabels` breaks the tie for the
      // reason every option list in the app uses it: a pinned collation, so two machines draw one
      // deck the same way round.
      [...distribution(sized, by)].sort(
        (a, b) => b.count - a.count || compareLabels(a.label, b.label),
      ),
    [sized, by],
  );

  /**
   * Each row with its own reading attached.
   *
   * **Computed once and read twice**, because the table cell and the bar beside it must be the
   * same number — `handOdds` is a sum over a hypergeometric term per row, so calling it again in
   * the bars column would be both the arithmetic twice and a second place for it to be called
   * with the wrong argument.
   */
  const readings = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        odds: handOdds({ deck, successes: row.count, hand, want, mode }),
      })),
    [rows, deck, hand, want, mode],
  );

  const modeLabel = ODDS_MODES.find((option) => option.value === mode)?.label ?? "";

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {/* `flex-wrap`, because the editor column is a few hundred pixels wide with the card pane
          docked and this row is four fixed-width controls and two words. A row of fixed-width
          controls is sized by the narrowest surface that draws it, and an unwrapped one does not
          shrink — it hangs out of the column and puts a horizontal scrollbar across the page. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* A heading and never a second `StatsCard`: this is the lower half of one readout about
            one cut, and a card of its own would be a second border saying the two halves are two
            questions. `h4` is the rung under the card's own `h3`. */}
        <h4 className="text-sm font-medium text-text">Opening hand odds</h4>
        {/* Absent rather than greyed on an empty list, which is this folder's standing rule: a
            stepper asking how many copies to draw out of a deck of none is a control with nothing
            to answer, and a greyed one reads as something broken rather than as something that
            has not been given anything to do yet. */}
        {deck > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-dim">
            <Dropdown
              size="sm"
              value={mode}
              // By lookup rather than by a cast, so a value the list does not hold cannot reach
              // the state — the same fence the cut's own select uses one component up.
              onChange={(value) => {
                const picked = ODDS_MODES.find((option) => option.value === value);
                if (picked) setMode(picked.value);
              }}
              options={ODDS_MODES}
              label="How to count the copies drawn"
            />
            <QuantityStepper
              size="sm"
              min={0}
              value={want}
              onChange={setWant}
              // Named for the question rather than "Quantity": there are two steppers on this
              // row, and a reader hearing "Quantity" twice has been told nothing about either.
              label="Copies to draw"
            />
            <span>in</span>
            <QuantityStepper
              size="sm"
              // One card, at least: a hand of none is not a hand, and `handOdds` answers 0 for it
              // — a table of noughts is a worse answer than a control that will not go there.
              min={1}
              value={hand}
              onChange={setHand}
              label="Cards in the opening hand"
            />
            <span>cards</span>
          </div>
        ) : null}
      </div>

      {deck === 0 ? (
        // `deck === 0` is not a table of `0%` — there is nothing to draw at all, and a column of
        // noughts states an answer where the honest thing to say is that the question does not
        // arise yet.
        <p className="text-xs text-dim">This list has no cards to draw from.</p>
      ) : (
        // Two columns: the figures on the left, the picture of them on the right. The table takes
        // the larger share because it carries every number *and* the whole accessible story; the
        // bars are what makes the shape of the list readable at a glance. `minmax(0, …)` on both
        // tracks is what lets the label cell truncate rather than push the numbers off the card.
        //
        // An inline style and not `grid-cols-[…]`, which is this app's standing rule for a column
        // template: the arbitrary spelling has to survive Tailwind's scanner exactly, and a
        // template that emits no rule leaves two `1fr` columns that look nearly right.
        <div
          className="grid gap-x-3"
          style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)" }}
        >
          {/* `table-fixed` is what makes the ellipsis on the label cell possible at all: an auto
              table sizes a column to its widest cell, so one long card name would widen the first
              column and shove `Qty` and `Odds` out of the card. (The design spells the same fence
              as `max-w-0` on the cell, which is the auto-table form of it; stated on the table it
              is said once rather than once per row.) */}
          <table className="w-full table-fixed border-collapse">
            <caption className="sr-only">
              {`Chance of drawing ${modeLabel.toLowerCase()} ${plural(want, "copy", "copies")} in an opening hand of ${plural(hand, "card")}, out of ${plural(deck, "card")}.`}
            </caption>
            <thead>
              <tr style={{ height: HEAD_HEIGHT }}>
                <th scope="col" className={cn(COLUMN_HEAD, "truncate pr-2 text-left")}>
                  {DISTRIBUTION_HEADING[by]}
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "w-10 text-right")}>
                  Qty
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "w-12 text-right")}>
                  Odds
                </th>
              </tr>
            </thead>
            <tbody>
              {readings.map((row) => (
                <tr key={row.key} style={{ height: ROW_HEIGHT }}>
                  {/* `truncate` and never a wrap: a row that grew to two lines would put its own
                      bar half a line out of true, and every bar under it with it. */}
                  <th scope="row" className="truncate pr-2 text-left text-xs font-normal text-text">
                    {row.label}
                  </th>
                  <td className={FIGURE}>{row.count}</td>
                  <td className={FIGURE}>{percent(row.odds)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* **The bars are hidden and the table is the accessible story.** Every percentage they
              draw is already in the `Odds` cell beside them, so a bar that announced itself would
              have a screen reader read every row of this list twice — and the `Chance` heading
              goes with them, because it names a column that is not there to be read. */}
          <div aria-hidden="true" className="flex min-w-0 flex-col">
            <div className={cn("flex items-center", COLUMN_HEAD)} style={{ height: HEAD_HEIGHT }}>
              Chance
            </div>
            {readings.map((row) => (
              <div key={row.key} className="flex items-center" style={{ height: ROW_HEIGHT }}>
                <Track share={row.odds} fill="var(--color-accent)" height={BAR_HEIGHT} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
