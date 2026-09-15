/**
 * What the wishlist would cost, and how that cost is spread across one dimension.
 *
 * ## Why this is not `CollectionValueWidget` with a prop flipped
 *
 * The two widgets read two commands that answer the same `BreakdownRow` shape, and the drawing
 * is the same drawing — so the merge is tempting and the plan refuses it in words. **The two
 * lists' empty states and notes are different sentences about different things**, and neither is
 * a wording preference:
 *
 * * An empty **collection** is *you own nothing yet*. An empty **wishlist** is *you want nothing
 *   yet*. One is a record of what happened; the other is a plan that has not been made.
 * * An unpriced **collection** row is a card whose worth is unknown — the reader has it either
 *   way. An unpriced **wish** is a card nobody will quote a price to *buy*, which is a fact
 *   about a purchase the reader cannot yet make.
 * * The `finish` dimension has a fifth bucket here — `"any"`, a wish that names no finish. A
 *   collection row always has one, because you cannot own a card in no finish.
 *
 * A shared component would take all of that as props, and by the time it had four of them it
 * would be a worse version of two files. So: two files, and this comment, so the next reader
 * does not merge them.
 *
 * ## The drawing
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip and the settings popover where
 * the dimension, the chart and the totals switch are chosen — the registry rows `dimension`,
 * `chart` and `figures` in `widgets.ts` — and this file draws what fits in the box it was handed,
 * from `WidgetParts.tsx`. `WidgetBars` rather than the deck stats band's `BarChart`, because that
 * one prints an **integer count** on each bar and speaks it as *"12 cards"*; these bars are
 * **money**. Every rule that band states still binds and is `WidgetBars`' own contract now: the
 * whole drawing is `aria-hidden`, **each bar carries one `sr-only` sentence**, nothing is a
 * control, a nonzero fill keeps a minimum size, and `fill` is a **CSS colour string**, because
 * Tailwind scans source text and a `bg-mana-${key}` emits no rule at all — silently, and only in a
 * build. Nothing here writes either, so a catalogue preview (`still`) needs no branch of its own.
 *
 * **No `@container` here or on the page.** `container-type: inline-size` applies layout
 * containment, which makes the box the containing block for every `fixed` descendant — and the
 * card this is drawn in opens an anchored settings popover. What fits is `fit`'s arithmetic over a
 * box the page measured.
 */
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { percent } from "@/features/decks/stats/StatsCard";
import { count } from "@/lib/counts";
import { finishLabel } from "@/lib/finish";
import { ipc, ipcError, type BreakdownRow, type HomeWidget } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, type ManaKey } from "@/lib/mana";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { wishlistBreakdownKey, wishlistTotalKey } from "../keys";
import {
  WidgetBars,
  WidgetFigures,
  WidgetFooter,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
  type WidgetBarItem,
} from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOn } from "../widgetSettings";
import { BREAKDOWN_DIMENSIONS, type BreakdownDimension } from "../widgets";

/** What a widget slices by when nothing usable is stored. Rarity, because it is the one
 *  breakdown every card has an answer for — a colourless card still has a rarity. */
const WISHLIST_VALUE_DEFAULT_DIMENSION: BreakdownDimension = "rarity";

/**
 * Which column this widget groups over — narrowed against the four words that exist.
 *
 * `pickOf` reads the registry's `dimension` row and already answers the default for a word no
 * option carries, so a stored `dimension: "bogus"` or `dimension: 7` never reaches
 * `wishlist_breakdown`'s four `match` arms and comes back as a refusal — a card that reads as
 * broken because of a word nobody can see. The lookup here is what turns its `string | number`
 * into the type without a cast, and the fallback is for the one case `pickOf` cannot answer, a
 * kind this build does not know.
 */
export function readDimension(widget: HomeWidget): BreakdownDimension {
  const picked = pickOf(widget, "dimension");
  return (
    BREAKDOWN_DIMENSIONS.find((option) => option.id === picked)?.id ??
    WISHLIST_VALUE_DEFAULT_DIMENSION
  );
}

// The two keys this widget reads through live in `../keys` — `wishlistTotalKey` is also
// `SummaryWidget`'s wishlist figure, and one definition is what keeps the pair one fetch. The
// argument for the `["wishlist", …]` root is in that file's module doc.

/** One bar or one single-line row, in pixels — the design's figure. See `CollectionValueWidget`,
 *  which counts against the same numbers for the same drawing. */
const ROW_PX = 32;

/** A row on a two-cell tile, where the money moves under the name: a name line and a caption
 *  line in one padding. */
const TWO_LINE_ROW_PX = 48;

/** The figure line, comfortable and compact, and the footer line — the design's reservations. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;
const FOOTER_PX = 22;

/** The folded bucket's key. No breakdown vocabulary spells it — rarity words, colour letters, set
 *  codes, finishes and `any`/`unknown` — so it cannot collide with a real bucket. */
const OTHER_KEY = "__other__";

/** The accent — the fill for a bucket whose word carries no colour of its own. */
const NEUTRAL_FILL = "var(--color-accent)";

/** One drawn bucket. */
interface WishBucket {
  key: string;
  /** The word on screen. */
  label: string;
  /** The word the sentence opens with — the label, except for the fold, whose visible `Other`
   *  would be spoken as a proper noun with no question attached. */
  spoken: string;
  cards: number;
  /** `null` is *nobody quotes a price for anything in this bucket*, never a zero. */
  value: number | null;
  fill: string;
  rarity?: string;
}

function isManaKey(key: string): key is ManaKey {
  return (MANA_KEYS as readonly string[]).includes(key);
}

/**
 * What a bucket is called on screen.
 *
 * **The vocabulary is the wire's and both breakdown commands agree on it**, so this is a
 * translation and never a guess: a rarity, a colour bucket and a finish each *are* their own
 * word, and only a set needs the second column `BreakdownRow.name` carries.
 */
function bucketLabel(dimension: BreakdownDimension, row: BreakdownRow): string {
  switch (dimension) {
    case "rarity":
      // `coalesce(c.rarity, 'unknown')` — a wish whose printing has left the card database. No
      // Scryfall rarity is spelled `unknown`, so the bucket cannot collide with a real one.
      return row.key === "unknown" ? "Unknown rarity" : capitalise(row.key);
    case "color":
      return colorLabel(row.key);
    case "set":
      // The name where the corpus knows one — nothing but it knows that `mh3` is *Modern
      // Horizons 3* — and the code, shouted, where it does not.
      return row.name ?? (row.key === "unknown" ? "Unknown set" : row.key.toUpperCase());
    case "finish":
      // **The wishlist's fifth bucket.** `coalesce(w.preferred_finish, 'any')`: a wish need not
      // name a finish, and "the reader has not said" is a real answer rather than a gap.
      return row.key === "any" ? "Any finish" : finishLabel(row.key);
  }
}

/** How the fold is spoken, per dimension — naming the cut, so a count heard after it has a
 *  question attached. */
const REST: Record<BreakdownDimension, string> = {
  rarity: "Every other rarity",
  color: "Every other colour",
  set: "Every other set",
  finish: "Every other finish",
};

/**
 * A colour bucket as a word.
 *
 * Three shapes, and the case matters: the key for one colour is the **stored uppercase letter**
 * out of `cards.color_identity` — a concatenated string of letters and never a JSON array — while
 * the two special buckets are lowercase, `c` for colourless and `multi` for two or more. Both
 * lists spell them identically, on purpose, so a bar means the same thing in either widget —
 * which is why `multi` is `Multicolour` here as it is there (it read `Multicolor` until the grid
 * redesign, the one word the two had drifted on).
 */
function colorLabel(key: string): string {
  if (key === "multi") return "Multicolour";
  if (key === "c") return MANA_LABEL.C;
  return isManaKey(key) ? MANA_LABEL[key] : key;
}

/**
 * The fill, as a CSS colour string.
 *
 * **A custom property and never an interpolated Tailwind class** — the band's rule, and the
 * failure it prevents is silent: Tailwind scans source *text* for whole class names, so a
 * `bg-mana-${key}` emits no rule at all and only in a build.
 *
 * Colour carries meaning and is drawn in it; every other dimension takes the accent. **Rarity is
 * said by the gem before the label rather than by the fill** — the design's choice, and the one
 * that keeps the money legible: `WidgetBars` prints a bar's figure in its fill, and the rarities
 * with no token of their own (`special`, `bonus`, `unknown`) take `--color-border`, about 1.9:1
 * on the app background (`lib/rarity.ts`'s `hasRarityColor`) — a price in that ink is a price
 * nobody can read, where a 6px gem may wear it. `multi` has no mana fill
 * of its own — the six are the printed symbols — so it takes the app's gold, which is what
 * multicolour is on a real card frame.
 */
function bucketFill(dimension: BreakdownDimension, key: string): string {
  if (dimension === "color") {
    if (key === "multi") return "var(--color-pie-gold)";
    if (key === "c") return MANA_FILL.C;
    return isManaKey(key) ? MANA_FILL[key] : "var(--color-border)";
  }
  return NEUTRAL_FILL;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function copiesOf(cards: number): string {
  return `${count(cards)} ${cards === 1 ? "copy" : "copies"}`;
}

/**
 * The buckets cut to the room the card has, **with the tail folded into one `Other` so the drawn
 * buckets still sum to the list's total**.
 *
 * The rows arrive dearest first — `wishlist_breakdown`'s own order — so a cut takes the buckets
 * the reader is actually spending in and what it folds is always the smallest. When the list is
 * longer than the room, the last slot is the fold rather than one more bucket: copies are summed,
 * and money is summed **skipping the nulls**, so a fold of unpriced wishes stays `null` rather
 * than becoming `$0.00`. One slot draws the dearest bucket alone rather than a lone `Other` — a
 * fold with nothing beside it is the total said a second time, and the bucket it draws speaks its
 * share of the whole list, so it never claims to be all of it.
 */
function fitBuckets(
  rows: readonly BreakdownRow[],
  room: number,
  dimension: BreakdownDimension,
): WishBucket[] {
  const bucket = (row: BreakdownRow): WishBucket => {
    const label = bucketLabel(dimension, row);
    return {
      key: row.key,
      label,
      spoken: label,
      cards: row.cards,
      value: row.value,
      fill: bucketFill(dimension, row.key),
      rarity: dimension === "rarity" ? row.key : undefined,
    };
  };
  if (rows.length <= room) return rows.map(bucket);
  if (room <= 1) return rows.slice(0, room).map(bucket);
  const rest = rows.slice(room - 1);
  return [
    ...rows.slice(0, room - 1).map(bucket),
    {
      key: OTHER_KEY,
      label: "Other",
      spoken: REST[dimension],
      cards: rest.reduce((total, row) => total + row.cards, 0),
      value: rest.reduce<number | null>(
        (total, row) => (row.value === null ? total : (total ?? 0) + row.value),
        null,
      ),
      fill: NEUTRAL_FILL,
    },
  ];
}

/**
 * The one sentence a bar is spoken as.
 *
 * The drawing beside it is `aria-hidden` in its entirety, so this is not a caption — it is the
 * whole of what a screen reader is told about this bucket, and it has to be complete without the
 * picture.
 *
 * **The unpriced arm is the wishlist's own sentence and not the collection's.** A collection row
 * the marketplace cannot price is a card whose *worth* is unknown; a wish it cannot price is a
 * card the reader cannot be quoted a price to *buy*. Same hole in the data, two different things
 * to say about it — which is exactly why this widget is its own file.
 */
function barSentence(
  bucket: WishBucket,
  share: number | null,
  currency: "usd" | "eur",
  marketplaceLabel: string,
): string {
  if (bucket.value === null) {
    return `${bucket.spoken}: ${copiesOf(bucket.cards)}, no price to buy at ${marketplaceLabel}.`;
  }
  // Omitted rather than drawn as an em dash mid-sentence: there is nothing to take a percentage
  // of when the list itself totals nothing, and a clause saying so would be noise.
  const of = share === null ? "" : `, ${percent(share)} of the total`;
  return `${bucket.spoken}: ${copiesOf(bucket.cards)}, ${formatPrice(bucket.value, currency)}${of}.`;
}

/**
 * The wishlist's cost, split one of four ways, fitted to its box.
 *
 * **Figures first, chart second** — the collection widget's order and its reason: the figure line
 * and the footer are reserved first and the chart takes the whole rows left, and zero rows draws
 * no chart and no footer rather than a bar the card's edge cuts through.
 */
export function WishlistValueWidget({ widget, fit }: WidgetBodyProps): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const dimension = readDimension(widget);
  const asList = pickOf(widget, "chart") === "list";
  const withFigures = toggleOn(widget, "figures");

  const summary = useQuery({
    queryKey: wishlistTotalKey(marketplace.id),
    queryFn: () => ipc.wishlistSummary(marketplace.id),
  });
  const breakdown = useQuery({
    queryKey: wishlistBreakdownKey(dimension, marketplace.id),
    queryFn: () => ipc.wishlistBreakdown(dimension, marketplace.id),
  });

  // Either read failing is one refusal: the card has one body, and two sentences stacked in it
  // would be the same outage said twice.
  const refusal = summary.isError
    ? ipcError(summary.error)
    : breakdown.isError
      ? ipcError(breakdown.error)
      : null;

  const totals = summary.data;
  const rows = breakdown.data;

  if (refusal !== null) {
    return (
      <WidgetMessage tone="destructive">Could not price your wishlist — {refusal}</WidgetMessage>
    );
  }
  if (totals === undefined || rows === undefined) {
    return <WidgetMessage>Adding up what your wishlist would cost…</WidgetMessage>;
  }
  if (totals.wishes === 0) {
    // **The wishlist's sentence, not the collection's**, and no figures over it: nothing is owned
    // or unowned here, and a total cost of `$0.00` over an empty list is a price nobody quoted.
    return (
      <WidgetMessage>You want nothing yet — wish for a card and its cost lands here.</WidgetMessage>
    );
  }

  const twoLine = asList && fit.tier === 0;
  const withFooter = fit.tier >= 2 && fit.h >= 2;
  const reserved =
    (withFigures ? (fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX) : 0) +
    (withFooter ? FOOTER_PX : 0);
  const rowsOfRoom = fit.fitCount(twoLine ? TWO_LINE_ROW_PX : ROW_PX, reserved);
  // A list lays its rows out in `listColumns`, so a whole row there holds that many buckets.
  const room = asList ? rowsOfRoom * fit.listColumns : rowsOfRoom;
  const shown = fitBuckets(rows, room, dimension);
  const charted = shown.length > 0;

  // **Two denominators, and they answer two questions.** The spoken share is of the list's own
  // total, so a sentence means the same thing whichever slice is on screen and however the card
  // was cut. The *width* is of the widest drawn bar — `WidgetBarItem.share`'s contract, and the
  // collection twin's drawing — so the two charts, side by side on one page, draw one shape of
  // chart rather than two. (It was the total until the grid redesign, with a percentage printed
  // beside each track; that column has no place in a bar the grid's primitives draw, and the
  // number it carried survives in the sentence.)
  const widest = shown.reduce((tallest, bucket) => Math.max(tallest, bucket.value ?? 0), 0);
  const bars: WidgetBarItem[] = shown.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: formatPrice(bucket.value, currency),
    share: widest > 0 && bucket.value !== null ? bucket.value / widest : 0,
    fill: bucket.fill,
    rarity: bucket.rarity,
    said: barSentence(
      bucket,
      bucket.value === null || totals.cost <= 0 ? null : bucket.value / totals.cost,
      currency,
      marketplace.label,
    ),
  }));

  const dimensionWord =
    BREAKDOWN_DIMENSIONS.find((option) => option.id === dimension)?.label.toLowerCase() ??
    dimension;

  return (
    // A fragment: `WidgetCard` lays its body out as a column and owns the gap between the blocks.
    <>
      {withFigures && (
        <WidgetFigures
          fit={fit}
          divided={charted}
          figures={[
            {
              key: "cost",
              label: `Cost (${currency.toUpperCase()})`,
              value: formatPrice(totals.cost, currency),
              // The qualification that keeps the number honest: a sum that quietly omitted these
              // copies would read as a smaller list rather than as an incomplete price.
              note:
                totals.unpriced > 0
                  ? `${copiesOf(totals.unpriced)} nobody quotes a price for`
                  : undefined,
              tone: "accent",
              hint: pricesAsOf(marketplace),
            },
            // Copies rather than wishes, because it is copies the cost is the price of — and the
            // word every sentence below counts in.
            { key: "copies", label: "Copies", value: count(totals.copies), tone: "text" },
          ]}
        />
      )}
      {rows.length === 0 ? (
        // A list with wishes on it and no buckets to show is the marketplace's silence, not an
        // empty wishlist — two different sentences, and this is the rarer one.
        <WidgetMessage>Nothing in this slice has a price yet.</WidgetMessage>
      ) : !charted ? null : asList ? (
        <WidgetRowList fit={fit}>
          {bars.map((bar) =>
            // A two-cell tile has no width for a name and a figure side by side, so the money
            // moves under the name in body ink — `WidgetRow`'s own rule for the tile.
            fit.tier === 0 ? (
              <WidgetRow key={bar.key} name={bar.label} caption={bar.value} captionStrong />
            ) : (
              <WidgetRow key={bar.key} name={bar.label} value={bar.value} />
            ),
          )}
        </WidgetRowList>
      ) : (
        <WidgetBars bars={bars} fit={fit} />
      )}
      {charted && withFooter && (
        <WidgetFooter>
          {/* Where the money came from, then the cut — the provenance sentence's own full stop
              dropped so the clause can ride after it. */}
          {pricesAsOf(marketplace).replace(/\.$/, "")} · split by {dimensionWord}
        </WidgetFooter>
      )}
    </>
  );
}
