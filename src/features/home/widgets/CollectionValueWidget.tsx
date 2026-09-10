/**
 * What the collection is worth, and where the money is — one total, and one bar per bucket of
 * whichever dimension the reader picked.
 *
 * **It is a `Track` chart and deliberately not a `BarChart`, which is the one place this widget
 * departs from the deck stats band it borrows everything else from.** `BarChart` prints
 * `bar.count` on the fill verbatim, so a money figure would appear as `412.37` — unformatted, in
 * no currency, beside a total that says `$412.37` — and its bars are vertical, which puts a set
 * name under a 40px column in a card whose floor is 22rem. The `set` dimension answers one row
 * per set the reader owns a card from, which is hundreds. So the bars run **across**: a word, a
 * track, and the money at the right, eight of them, with everything past the eighth folded into
 * one `Other`. Every rule `StatsCard` states still binds — see the two below.
 *
 * **The whole drawing is `aria-hidden` and each bar carries one `sr-only` sentence.** That is
 * the band's standing rule and the reason there is no `role="img"` and no chart library: the
 * picture is decoration over numbers that are already text. It is also why nothing here is a
 * control — a bar is a `<span>`, and making one narrow the collection is a cross-page feature
 * that is explicitly not in this pass.
 *
 * **`WishlistValueWidget` is this widget against the other list and is a separate component on
 * purpose** — the two lists' empty states and price notes differ, and the day one of them grows
 * a third figure is the day a shared component grows a flag. Do not merge them.
 */
import { useMemo, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { Figure, FigureRow } from "@/components/Figure";
import { percent, Track } from "@/features/decks/stats/StatsCard";
import { count } from "@/lib/counts";
import { finishLabel } from "@/lib/finish";
import { ipc, ipcError, type BreakdownRow, type CollectionSummary } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, type ManaKey } from "@/lib/mana";
import type { Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { collectionBreakdownKey, collectionTotalKey } from "../keys";
import { widgetConfig, widgetSpan } from "../layout";
import { WidgetCard } from "../WidgetCard";
import type { WidgetProps } from "../widgetProps";
import { BREAKDOWN_DIMENSIONS, WIDGETS, type BreakdownDimension } from "../widgets";

/**
 * The card's heading, read off the registry rather than typed here.
 *
 * `WIDGET_META` is a `Record<WidgetKind, …>`, so the row exists by construction and the `??` is
 * what the type system asks for rather than a second opinion about the words — what it buys is
 * that the **Add widget** menu row and the card it adds cannot come to say two different things.
 */
const HEADING =
  WIDGETS.find((meta) => meta.kind === "collectionValue")?.label ?? "Collection value";

/**
 * The dimension a widget that has never been configured opens on.
 *
 * Rarity rather than set, because it is the one cut whose buckets are the same handful for every
 * reader — a first launch showing four bars says what the widget is, where a first launch showing
 * eight set codes out of six hundred says what one collection happens to hold.
 */
export const DEFAULT_BREAKDOWN_DIMENSION: BreakdownDimension = "rarity";

/** What this widget remembers. One field today; {@link widgetConfig} carries a newer build's
 *  keys through untouched, which is why the write below spreads the config it read. */
export interface CollectionValueConfig {
  dimension: BreakdownDimension;
}

// The two keys this widget reads through live in `../keys` — `collectionTotalKey` is also
// `SummaryWidget`'s collection figure, and one definition is what keeps the pair one fetch. The
// argument for the shape of each, `"home"` included, is in that file's module doc.

/**
 * The picker's rows, built once.
 *
 * Through `sortOptions` like every option list in this app — `widgets.ts` says in as many words
 * that `BREAKDOWN_DIMENSIONS`' own order is the order the record was written in and not the
 * order a reader sees.
 */
const DIMENSION_OPTIONS = sortOptions(BREAKDOWN_DIMENSIONS, (entry) => entry.label).map(
  (entry) => ({
    value: entry.id,
    label: entry.label,
  }),
);

/**
 * How many bars are drawn before the rest are folded into one.
 *
 * Eight is what a 22rem card holds without the labels truncating, and it is a **cap on the
 * drawing rather than on the read**: the fold keeps every bucket's cards and money, so the bars
 * still sum to the total above them, which is the property `BreakdownRow`'s own doc promises.
 */
const MAX_BARS = 8;

/** The folded bar's key. Not a value any backend dimension answers with — the four vocabularies
 *  are rarity words, colour letters, set codes and finishes — so it cannot collide with a bucket. */
const OTHER_KEY = "__other__";

/**
 * The width a bar with money in it never falls below.
 *
 * `BarChart`'s `minHeight` rule, one axis over and for its reason: a bucket worth two dollars
 * against a bucket worth two thousand rounds to nothing, and an invisible fill beside a figure
 * that says `$2.00` reads as a bug rather than as a small number. A bucket worth **nothing** —
 * priced at zero, or priced not at all — draws no fill, which is the honest answer.
 */
const MIN_FILL_PX = 3;

/** Anything that is not a colour bucket. The accent, which is what every chart in the band that
 *  is not about mana is filled with. */
const NEUTRAL_FILL = "var(--color-accent)";

/** Two or more colours. Gold is what multicolour is in Magic and what this palette already
 *  spends on it — `--color-pie-gold` is the game changer's crown. */
const MULTI_FILL = "var(--color-pie-gold)";

/** The `color` dimension's two keys that are not one of Scryfall's five letters: the bucket for a
 *  card with no colours, and the bucket for a card with several. */
const COLOURLESS_KEY = "c";
const MULTI_KEY = "multi";

/** One drawn bar: a bucket, worded and coloured. */
interface ValueBar {
  key: string;
  /** The word under the eye — a rarity, a colour, a set's name, a finish. */
  label: string;
  cards: number;
  /** `null` is *the marketplace priced nothing in this bucket* and is never a zero. */
  value: number | null;
  /** A CSS colour string. **Never a `bg-mana-${key}`** — Tailwind scans source text for whole
   *  class names, so an interpolated one emits no rule at all, silently and only in a build. */
  fill: string;
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
 * question attached to it, and the picker that decides which question is being asked is
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
 * The buckets, ranked and capped.
 *
 * **Ranked by value, biggest first, with the unpriced buckets last**, and that is one rule for
 * four dimensions rather than four orderings: this widget answers *where is the money*, so the
 * order **is** the information — which is also what makes the fold honest, since what it folds
 * away is always the smallest. A bucket the marketplace could price nothing in has no value to
 * rank by and sinks to the foot, where its em dash sits beside the other em dashes rather than
 * in the middle of the money.
 *
 * The fold keeps both figures: cards are summed, and values are summed **skipping the nulls**, so
 * that a fold holding one priced bucket is worth what that bucket is worth and a fold holding
 * none stays `null` rather than becoming `$0.00`. That is `sum()` over a `NULL` in SQL, and it is
 * the rule `WishlistPage`'s folder subtotals already keep.
 */
function foldBars(rows: readonly BreakdownRow[], dimension: BreakdownDimension): ValueBar[] {
  const said = SAID[dimension];
  const ranked = [...rows].sort((a, b) => {
    if (a.value === null && b.value === null) return b.cards - a.cards;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return b.value - a.value || b.cards - a.cards;
  });
  const bars: ValueBar[] = ranked.slice(0, MAX_BARS).map((row) => {
    const label = labelOf(dimension, row);
    return {
      key: row.key,
      label,
      cards: row.cards,
      value: row.value,
      fill: dimension === "color" ? colourFill(row.key) : NEUTRAL_FILL,
      said: said.one(label),
    };
  });
  const rest = ranked.slice(MAX_BARS);
  if (rest.length === 0) return bars;
  return [
    ...bars,
    {
      key: OTHER_KEY,
      label: "Other",
      cards: rest.reduce((total, row) => total + row.cards, 0),
      value: rest.reduce<number | null>(
        (total, row) => (row.value === null ? total : (total ?? 0) + row.value),
        null,
      ),
      fill: NEUTRAL_FILL,
      said: said.rest,
    },
  ];
}

/**
 * The sentence one bar is spoken as — the whole of what a screen reader gets, since the drawing
 * beside it is `aria-hidden`.
 *
 * It carries the share as well as the money, because the share is exactly what the **track**
 * carries and nothing else says: `percent` is the band's own spelling of one, so a percentage
 * here and a percentage in the deck stats band cannot come to round differently. A bucket with
 * no price says so in words instead — `"worth —"` is an em dash read aloud, which is the one
 * place this app's price em dash does not survive being spoken.
 */
function sentence(bar: ValueBar, total: number, marketplace: Marketplace): string {
  const cards = `${count(bar.cards)} ${bar.cards === 1 ? "card" : "cards"} ${bar.said}`;
  if (bar.value === null) return `${cards}, with no ${marketplace.label} price`;
  const share = total > 0 ? bar.value / total : null;
  const money = formatPrice(bar.value, marketplace.currency);
  return share === null
    ? `${cards}, worth ${money}`
    : `${cards}, worth ${money}, ${percent(share)} of the total`;
}

/**
 * The bars.
 *
 * **`max` is the caller's and is required rather than defaulted**, which is `BarChart`'s rule
 * kept verbatim: it is the figure every fill is drawn as a fraction of, and a component that
 * quietly took `Math.max` of what it was handed is a component nobody can normalise two charts
 * against. `total` is the separate figure the spoken share is a share *of* — the two are the
 * largest bucket and every bucket added up, and they are never the same question.
 */
function ValueBars({
  bars,
  max,
  total,
  marketplace,
}: {
  bars: readonly ValueBar[];
  max: number;
  total: number;
  marketplace: Marketplace;
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {bars.map((bar) => (
        <li key={bar.key}>
          <span className="sr-only">{sentence(bar, total, marketplace)}</span>
          {/* Everything below is the picture. It says nothing the sentence above has not already
              said, which is what the `aria-hidden` here is a claim about. */}
          <div aria-hidden="true" className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm text-text">{bar.label}</span>
              <span className="shrink-0 font-mono text-sm tabular-nums text-dim">
                {formatPrice(bar.value, marketplace.currency)}
              </span>
            </div>
            <Track
              share={max > 0 && bar.value !== null ? bar.value / max : 0}
              fill={bar.fill}
              height={6}
              style={{ minWidth: bar.value !== null && bar.value > 0 ? MIN_FILL_PX : 0 }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The collection's value, split one of four ways.
 *
 * @param widget the stored entry. `config.dimension` is read through {@link widgetConfig} and
 * then **narrowed against `BREAKDOWN_DIMENSIONS` here**, because that helper checks a *shape*
 * and cannot check a vocabulary — a stored `dimension: "bogus"` is a string and passes it. The
 * backend refuses a fifth word in a sentence, so an unnarrowed one would cost the reader their
 * bars and hand them a refusal to read.
 */
export function CollectionValueWidget({
  widget,
  editing,
  onConfig,
  onRemove,
  onSpan,
  dragHandleRef,
  onNudge,
}: WidgetProps): JSX.Element {
  const { marketplace } = useMarketplace();

  const config = widgetConfig<CollectionValueConfig>(widget, {
    dimension: DEFAULT_BREAKDOWN_DIMENSION,
  });
  const dimension =
    BREAKDOWN_DIMENSIONS.find((entry) => entry.id === config.dimension)?.id ??
    DEFAULT_BREAKDOWN_DIMENSION;

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

  const bars = useMemo(
    () => foldBars(breakdown.data ?? [], dimension),
    [breakdown.data, dimension],
  );
  // Reduced rather than spread: `Math.max(...[])` is `-Infinity`, which would draw every fill of
  // an empty chart at full width. Both figures are computed here and passed down — see
  // `ValueBars`, where they are two different questions.
  const max = bars.reduce((tallest, bar) => Math.max(tallest, bar.value ?? 0), 0);
  const summed = bars.reduce((sum, bar) => sum + (bar.value ?? 0), 0);

  const failure = total.error ?? breakdown.error;
  const summary = total.data;

  return (
    <WidgetCard
      heading={HEADING}
      editing={editing}
      span={widgetSpan(widget)}
      actions={
        <Dropdown
          size="sm"
          value={dimension}
          // Narrowed by lookup rather than by a cast, exactly as `CardDistribution`'s own picker
          // is: a value the list does not hold reaches neither the config nor the wire.
          onChange={(value) => {
            const picked = BREAKDOWN_DIMENSIONS.find((entry) => entry.id === value);
            // **The current config is spread rather than replaced** — `widgetConfig` carries
            // through keys this build does not know about, and that is what stops an older build
            // silently deleting a newer one's settings.
            if (picked) onConfig({ ...config, dimension: picked.id });
          }}
          options={DIMENSION_OPTIONS}
          // Named for what it cuts, never a bare `Dimension`: the wishlist's twin is drawn on the
          // same page, and two controls sharing one accessible name is a name that identifies
          // neither.
          label={`${HEADING} by`}
        />
      }
      onRemove={onRemove}
      onSpan={onSpan}
      dragHandleRef={dragHandleRef}
      onNudge={onNudge}
    >
      {/* Three states, three sentences, and the order is what keeps them apart. A refusal wins,
          because a card that went on saying "counting" over a read which will never answer is the
          one failure a reader cannot act on. */}
      {failure !== null ? (
        <p className="text-sm text-destructive">
          Your collection could not be read. {ipcError(failure)}
        </p>
      ) : total.isPending || breakdown.isPending ? (
        <p className="text-sm text-dim">Counting your collection…</p>
      ) : (
        <>
          <FigureRow>
            <Figure
              label={`Value (${marketplace.currency.toUpperCase()})`}
              value={formatPrice(summary?.value ?? null, marketplace.currency)}
              // The count travels with the figure it qualifies: no two marketplaces have the same
              // holes, so this note is about the number beside it and never about another.
              note={
                summary && summary.unpriced > 0 ? `${count(summary.unpriced)} unpriced` : undefined
              }
              title={pricesAsOf(marketplace)}
            />
            <Figure label="Cards" value={count(summary?.totalCards ?? 0)} />
          </FigureRow>
          {bars.length > 0 ? (
            <ValueBars bars={bars} max={max} total={summed} marketplace={marketplace} />
          ) : (
            <p className="text-sm text-dim">Nothing in your collection yet.</p>
          )}
        </>
      )}
    </WidgetCard>
  );
}
