/**
 * What the collection is worth, and where the money is — one total, and one bar per bucket of
 * whichever dimension the reader picked.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip that says *Rarity*, and the
 * settings popover where the dimension, the chart and the totals switch are chosen — the registry
 * rows `dimension`, `chart` and `figures` in `widgets.ts`. This file reads those three and draws
 * what fits in the box it was handed, from the shared pieces in `WidgetParts.tsx`.
 *
 * **Bars that run across rather than a `BarChart`**, which is the one place this widget departs
 * from the deck stats band it borrows everything else from. `BarChart` prints `bar.count` on the
 * fill verbatim, so a money figure would appear as `412.37` — unformatted, in no currency, beside a
 * total that says `$412.37` — and its bars are vertical, which puts a set name under a 40px column.
 * The `set` dimension answers one row per set the reader owns a card from, which is hundreds, so
 * the bars run **across**: a word, a track, and the money at the right, as many as the card has
 * whole rows for, with everything past the last one folded into one `Other`.
 *
 * **The whole drawing is `aria-hidden` and each bar carries one `sr-only` sentence** —
 * `WidgetBars`' contract, and the band's standing rule: the picture is decoration over numbers
 * that are already text. Nothing here is a control, and nothing here writes, which is why a
 * catalogue preview (`still`) needs no branch of its own.
 *
 * **`WishlistValueWidget` is this widget against the other list and is a separate component on
 * purpose** — the two lists' empty states and price notes differ, and the day one of them grows
 * a third figure is the day a shared component grows a flag. Do not merge them.
 */
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { percent } from "@/features/decks/stats/StatsCard";
import { count } from "@/lib/counts";
import { finishLabel } from "@/lib/finish";
import {
  ipc,
  ipcError,
  type BreakdownRow,
  type CollectionSummary,
  type HomeWidget,
} from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, type ManaKey } from "@/lib/mana";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { collectionBreakdownKey, collectionTotalKey } from "../keys";
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

/**
 * The dimension a widget opens on when nothing usable is stored.
 *
 * Rarity rather than set, because it is the one cut whose buckets are the same handful for every
 * reader — a first launch showing four bars says what the widget is, where a first launch showing
 * eight set codes out of six hundred says what one collection happens to hold. It is also the
 * registry's first option, which is what `pickOf` answers for a word no option carries; this
 * constant is the answer for the one case `pickOf` cannot reach, a kind this build does not know.
 */
export const DEFAULT_BREAKDOWN_DIMENSION: BreakdownDimension = "rarity";

/**
 * Which column this widget groups over — the registry pick, narrowed to the type.
 *
 * `pickOf` has already refused a word no option carries (a hand-edited row, a newer build's), so
 * the lookup here only turns `string | number` into {@link BreakdownDimension} without a cast. A
 * stored `dimension: "bogus"` sent on would reach `collection_breakdown`'s four `match` arms and
 * come back as a refusal — a card that reads as broken because of a word nobody can see.
 */
export function collectionDimension(widget: HomeWidget): BreakdownDimension {
  const picked = pickOf(widget, "dimension");
  return (
    BREAKDOWN_DIMENSIONS.find((entry) => entry.id === picked)?.id ?? DEFAULT_BREAKDOWN_DIMENSION
  );
}

/**
 * The pixels one bar takes, and one single-line row — `WidgetBars`' label line over its 6px track,
 * and `WidgetRow`'s 20px line in its padding and border. The design's figure, and close enough to
 * both drawings that a whole-row count against it never clips a bar.
 */
const ROW_PX = 32;

/**
 * A row on a two-cell tile, where the money moves under the name (`WidgetRow`'s doc): a 20px name
 * and a 16px caption in the same padding. Counting those against {@link ROW_PX} would promise a
 * row the tile does not have, and the last one would be cut through by the card's edge.
 */
const TWO_LINE_ROW_PX = 48;

/** The figure line's height, comfortable and compact — the design's two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;

/** The footer's line and the gap above it. */
const FOOTER_PX = 22;

/** The folded bar's key. Not a value any backend dimension answers with — the four vocabularies
 *  are rarity words, colour letters, set codes and finishes — so it cannot collide with a bucket. */
const OTHER_KEY = "__other__";

/** Anything that is not a colour bucket. The accent, which is what every chart in the band that
 *  is not about mana is filled with — and which `WidgetBars` knows to print the money beside in
 *  dim ink rather than in gold. */
const NEUTRAL_FILL = "var(--color-accent)";

/** Two or more colours. Gold is what multicolour is in Magic and what this palette already
 *  spends on it — `--color-pie-gold` is the game changer's crown. */
const MULTI_FILL = "var(--color-pie-gold)";

/** The `color` dimension's two keys that are not one of Scryfall's five letters: the bucket for a
 *  card with no colours, and the bucket for a card with several. */
const COLOURLESS_KEY = "c";
const MULTI_KEY = "multi";

/** One drawn bucket, worded and coloured — the same record whether it becomes a bar or a row. */
interface ValueBucket {
  key: string;
  /** The word under the eye — a rarity, a colour, a set's name, a finish. */
  label: string;
  cards: number;
  /** `null` is *the marketplace priced nothing in this bucket* and is never a zero. */
  value: number | null;
  /** A CSS colour string. **Never a `bg-mana-${key}`** — Tailwind scans source text for whole
   *  class names, so an interpolated one emits no rule at all, silently and only in a build. */
  fill: string;
  /** The stored rarity word, for the gem before the label — `rarity` buckets only. */
  rarity?: string;
  /** The tail of the spoken sentence, after the count — `"of Common rarity"`. */
  said: string;
}

/** Is this key one of Scryfall's five colour letters? The backend stores them **uppercase**, and
 *  `cards.color_identity` is a string of letters rather than a JSON array. */
function isManaKey(key: string): key is ManaKey {
  return (MANA_KEYS as readonly string[]).includes(key);
}

/** What a `color` bucket is called. `"c"` is lowercase on the wire where `MANA_LABEL` keys it
 *  uppercase, which is the one translation this file makes. */
function colourLabel(key: string): string {
  if (key === MULTI_KEY) return "Multicolour";
  if (key === COLOURLESS_KEY) return MANA_LABEL.C;
  return isManaKey(key) ? MANA_LABEL[key] : key;
}

/** The fill a `color` bucket takes. Every other dimension is the accent. */
function colourFill(key: string): string {
  if (key === MULTI_KEY) return MULTI_FILL;
  if (key === COLOURLESS_KEY) return MANA_FILL.C;
  return isManaKey(key) ? MANA_FILL[key] : NEUTRAL_FILL;
}

/** A stored word capitalised — `FilterChips`' own spelling for a rarity, which is a lowercase
 *  column value everywhere it is stored. `"unknown"`, the bucket a NULL rarity lands in, reads
 *  correctly through the same rule. */
function capitalised(word: string): string {
  return word.replace(/^./, (first) => first.toUpperCase());
}

/**
 * How each dimension words a bucket, and how it words the fold.
 *
 * **Every phrase is prepositional**, which is `CardDistribution`'s rule and its reason: the
 * sentence is written `"{n} cards {said}"`, so a tail beginning with a verb reads *"1 card are
 * commons"* at exactly the count a small bucket puts on screen. And each phrase **names the
 * cut** rather than only the bucket — `Alpha` heard alone after a count is a proper noun with no
 * question attached to it, and the settings popover that decides which question is being asked is
 * somewhere the reader listening is not.
 */
const SAID: Record<BreakdownDimension, { one: (label: string) => string; rest: string }> = {
  rarity: { one: (label) => `of ${label} rarity`, rest: "of every other rarity" },
  color: { one: (label) => `in ${label}`, rest: "in every other colour" },
  set: { one: (label) => `from ${label}`, rest: "from every other set" },
  finish: { one: (label) => `in ${label}`, rest: "in every other finish" },
};

/** What one row is called, per dimension. A set's name lives in `row.name` and is **absent for
 *  an orphaned row**, whose name left with the printing — the code is what is left to draw. */
function labelOf(dimension: BreakdownDimension, row: BreakdownRow): string {
  switch (dimension) {
    case "color":
      return colourLabel(row.key);
    case "set":
      return row.name ?? row.key.toUpperCase();
    case "finish":
      return finishLabel(row.key);
    case "rarity":
      return capitalised(row.key);
  }
}

/**
 * The buckets, ranked — biggest money first, with the unpriced buckets last.
 *
 * **One rule for four dimensions rather than four orderings**: this widget answers *where is the
 * money*, so the order **is** the information — which is also what makes the fold honest, since
 * what it folds away is always the smallest. A bucket the marketplace could price nothing in has
 * no value to rank by and sinks to the foot, where its em dash sits beside the other em dashes
 * rather than in the middle of the money.
 */
function rankBuckets(rows: readonly BreakdownRow[], dimension: BreakdownDimension): ValueBucket[] {
  const said = SAID[dimension];
  return [...rows]
    .sort((a, b) => {
      if (a.value === null && b.value === null) return b.cards - a.cards;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value || b.cards - a.cards;
    })
    .map((row) => {
      const label = labelOf(dimension, row);
      return {
        key: row.key,
        label,
        cards: row.cards,
        value: row.value,
        fill: dimension === "color" ? colourFill(row.key) : NEUTRAL_FILL,
        rarity: dimension === "rarity" ? row.key : undefined,
        said: said.one(label),
      };
    });
}

/**
 * The ranked buckets cut to the whole rows the card has, **with what does not fit folded into
 * one `Other` so the drawn buckets still sum to the total** — the property `BreakdownRow`'s own
 * doc promises, and the difference between a chart that is shorter and one that is wrong.
 *
 * So when the list is longer than the room, the last slot is the fold rather than one more
 * bucket. The fold keeps both figures: cards are summed, and values are summed **skipping the
 * nulls**, so a fold holding one priced bucket is worth what that bucket is worth and a fold
 * holding none stays `null` rather than becoming `$0.00`. That is `sum()` over a `NULL` in SQL,
 * and the rule `WishlistPage`'s folder subtotals already keep.
 *
 * **One slot is the exception, and it draws the largest bucket alone rather than a lone
 * `Other`.** A fold with nothing beside it is a bar at full width saying *every other rarity* of
 * no rarity at all — the total a second time, in a sentence that does not parse. The one bucket
 * it draws speaks its share *of the whole* (the denominator is every row, see the body), so it
 * claims to be a part and never the sum.
 */
function fitBuckets(
  ranked: readonly ValueBucket[],
  room: number,
  dimension: BreakdownDimension,
): ValueBucket[] {
  if (ranked.length <= room) return [...ranked];
  if (room <= 1) return ranked.slice(0, room);
  const rest = ranked.slice(room - 1);
  return [
    ...ranked.slice(0, room - 1),
    {
      key: OTHER_KEY,
      label: "Other",
      cards: rest.reduce((total, bucket) => total + bucket.cards, 0),
      value: rest.reduce<number | null>(
        (total, bucket) => (bucket.value === null ? total : (total ?? 0) + bucket.value),
        null,
      ),
      fill: NEUTRAL_FILL,
      said: SAID[dimension].rest,
    },
  ];
}

/**
 * The sentence one bucket is spoken as — the whole of what a screen reader gets, since the drawing
 * beside it is `aria-hidden`.
 *
 * It carries the share as well as the money, because the share is exactly what the **track**
 * carries and nothing else says: `percent` is the band's own spelling of one, so a percentage
 * here and a percentage in the deck stats band cannot come to round differently. A bucket with
 * no price says so in words instead — `"worth —"` is an em dash read aloud, which is the one
 * place this app's price em dash does not survive being spoken.
 */
function sentence(bucket: ValueBucket, total: number, marketplace: Marketplace): string {
  const cards = `${count(bucket.cards)} ${bucket.cards === 1 ? "card" : "cards"} ${bucket.said}`;
  if (bucket.value === null) return `${cards}, with no ${marketplace.label} price`;
  const share = total > 0 ? bucket.value / total : null;
  const money = formatPrice(bucket.value, marketplace.currency);
  return share === null
    ? `${cards}, worth ${money}`
    : `${cards}, worth ${money}, ${percent(share)} of the total`;
}

/**
 * The collection's value, split one of four ways, fitted to its box.
 *
 * **Figures first, chart second**: a small tile is an honest pair of figures, where two bars it has
 * no room for are two bars drawn through the bottom edge of the card. So the figure line and the
 * footer are reserved first and the chart gets the whole rows that are left — and **zero is a real
 * answer**, which draws no chart and no footer rather than one bar the card clips.
 */
export function CollectionValueWidget({ widget, fit }: WidgetBodyProps): ReactElement {
  const { marketplace } = useMarketplace();
  const dimension = collectionDimension(widget);
  const asList = pickOf(widget, "chart") === "list";
  const withFigures = toggleOn(widget, "figures");

  const total = useQuery({
    queryKey: collectionTotalKey(marketplace.id),
    // No filters at all: this is the home page's figure rather than a wall's, so it asks about
    // every copy the reader owns. `limit: 0` is what makes it a count and not a page.
    queryFn: (): Promise<CollectionSummary> =>
      ipc.collectionSummary({ limit: 0, offset: 0, marketplace: marketplace.id }),
  });
  const breakdown = useQuery({
    queryKey: collectionBreakdownKey(dimension, marketplace.id),
    queryFn: (): Promise<BreakdownRow[]> => ipc.collectionBreakdown(dimension, marketplace.id),
  });

  const failure = total.error ?? breakdown.error;

  // Three states, three sentences, and the order is what keeps them apart. A refusal wins,
  // because a card that went on saying "counting" over a read which will never answer is the
  // one failure a reader cannot act on.
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Your collection could not be read. {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (total.data === undefined || breakdown.data === undefined) {
    return <WidgetMessage>Counting your collection…</WidgetMessage>;
  }

  const summary = total.data;
  const ranked = rankBuckets(breakdown.data, dimension);
  // Every bucket, not the drawn ones: the spoken share is a share of the whole, and a fold that
  // was cut differently on a smaller card must not change what a percentage is of.
  const whole = ranked.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0);

  const twoLine = asList && fit.tier === 0;
  const withFooter = fit.tier >= 2 && fit.h >= 2;
  const reserved =
    (withFigures ? (fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX) : 0) +
    (withFooter ? FOOTER_PX : 0);
  const rowsOfRoom = fit.fitCount(twoLine ? TWO_LINE_ROW_PX : ROW_PX, reserved);
  // A list is laid out in `listColumns`, so each whole row holds that many buckets; bars are one
  // to a row whatever the width.
  const room = asList ? rowsOfRoom * fit.listColumns : rowsOfRoom;
  const shown = fitBuckets(ranked, room, dimension);

  // Reduced rather than spread: `Math.max(...[])` is `-Infinity`. The widest bar is what every
  // fill is a fraction of — `WidgetBarItem.share`'s contract — and it is a different question
  // from `whole`, which the sentence's share is a share *of*.
  const widest = shown.reduce((tallest, bucket) => Math.max(tallest, bucket.value ?? 0), 0);

  const empty = ranked.length === 0;
  const charted = !empty && shown.length > 0;
  const dimensionWord =
    BREAKDOWN_DIMENSIONS.find((entry) => entry.id === dimension)?.label.toLowerCase() ?? dimension;

  const bars: WidgetBarItem[] = shown.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: formatPrice(bucket.value, marketplace.currency),
    share: widest > 0 && bucket.value !== null ? bucket.value / widest : 0,
    fill: bucket.fill,
    rarity: bucket.rarity,
    said: sentence(bucket, whole, marketplace),
  }));

  return (
    // A fragment: `WidgetCard` lays its body out as a column and owns the gap between the blocks,
    // so a wrapper here would be a second opinion about a spacing the card already decided.
    <>
      {withFigures && (
        <WidgetFigures
          fit={fit}
          divided={charted}
          figures={[
            {
              key: "value",
              label: `Value (${marketplace.currency.toUpperCase()})`,
              value: formatPrice(summary.value, marketplace.currency),
              // The count travels with the figure it qualifies: no two marketplaces have the same
              // holes, so this note is about the number beside it and never about another.
              note: summary.unpriced > 0 ? `${count(summary.unpriced)} unpriced` : undefined,
              tone: "accent",
              hint: pricesAsOf(marketplace),
            },
            { key: "cards", label: "Cards", value: count(summary.totalCards), tone: "text" },
          ]}
        />
      )}
      {empty ? (
        // Nothing owned yet — a real answer, and a different sentence from counting. Drawn
        // whatever the room, because a card that has cut its chart *and* its only sentence away
        // is a card that says nothing at all.
        <WidgetMessage>Nothing in your collection yet.</WidgetMessage>
      ) : !charted ? null : asList ? (
        <WidgetRowList fit={fit}>
          {bars.map((bar) =>
            // On a two-cell tile a name and a figure do not fit side by side, so the money moves
            // under the name in body ink — `WidgetRow`'s own rule for the tile.
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
          {/* The provenance sentence with the split word riding after it as a clause, so the
              sentence's own full stop is dropped rather than left in the middle of the line. */}
          {pricesAsOf(marketplace).replace(/\.$/, "")} · split by {dimensionWord}
        </WidgetFooter>
      )}
    </>
  );
}
