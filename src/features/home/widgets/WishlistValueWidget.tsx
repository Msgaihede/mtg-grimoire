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
 * `Track` from the deck stats band rather than its `BarChart`, and the reason is in `BarChart`'s
 * own contract: it prints an **integer count** on each bar and speaks it as *"12 cards"*. This
 * widget's bars are **money**, so a `BarChart` here would either round dollars into a card count
 * or say the wrong noun. Every rule that file states still binds and is kept at this site
 * instead: the whole drawing is `aria-hidden`, **each bar carries one `sr-only` sentence** — the
 * picture is decoration over numbers that are already text, which is also why there is no
 * `role="img"` and no chart library — **nothing here is a control** (a bar is a `<span>`), the
 * denominator is the **caller's** and never a max taken inside the drawing, a nonzero fill keeps
 * a minimum size so a small number is not an invisible bar, and `fill` is a **CSS colour
 * string**, because Tailwind scans source text and a `bg-mana-${key}` emits no rule at all —
 * silently, and only in a build.
 *
 * **No `@container` here or on the page.** `container-type: inline-size` applies layout
 * containment, which makes the box the containing block for every `fixed` descendant — and the
 * dimension `Dropdown` opens an anchored layer. `features/decks/DeckStats.tsx` refuses a
 * container query over its own two columns in the same words.
 */
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { Figure, FigureRow } from "@/components/Figure";
import { percent, Track } from "@/features/decks/stats/StatsCard";
import { finishLabel } from "@/lib/finish";
import { ipc, ipcError, type BreakdownRow, type HomeWidget } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, type ManaKey } from "@/lib/mana";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { rarityColor } from "@/lib/rarity";
import { useMarketplace } from "@/lib/useMarketplace";
import { wishlistBreakdownKey, wishlistTotalKey } from "../keys";
import { widgetConfig, widgetSpan } from "../layout";
import { WidgetCard } from "../WidgetCard";
import type { WidgetProps } from "../widgetProps";
import { BREAKDOWN_DIMENSIONS, WIDGETS, type BreakdownDimension } from "../widgets";

/**
 * The card's heading, read off the registry rather than written a second time.
 *
 * The Add widget menu and the card a press produces have to say the same words — a menu row
 * called one thing that makes a card called another is the reader losing track of what they
 * added. `??` because `WIDGETS` is a list and `find` is honest about that; the fallback is the
 * same string the registry holds.
 */
const HEADING = WIDGETS.find((meta) => meta.kind === "wishlistValue")?.label ?? "Wishlist value";

/** What a widget that has never been configured slices by. Rarity, because it is the one
 *  breakdown every card has an answer for — a colourless card still has a rarity. */
const WISHLIST_VALUE_DEFAULT_DIMENSION: BreakdownDimension = "rarity";

/**
 * The stored config, at the only shape this build writes.
 *
 * `dimension` is a **`string`** and not a {@link BreakdownDimension}, and that is the honest
 * type rather than a missing one: `widgetConfig` checks shapes and cannot check a vocabulary, so
 * a hand-edited row or a newer build's word arrives here as a string that passed. Narrowing is
 * {@link readDimension}'s job and happens once, at the edge.
 */
interface StoredConfig {
  dimension: string;
}

/** The stored config with this build's defaults laid under it — **and every key it does not
 *  know carried through**, which is what makes spreading it back safe. */
function storedConfig(widget: HomeWidget): StoredConfig {
  return widgetConfig<StoredConfig>(widget, { dimension: WISHLIST_VALUE_DEFAULT_DIMENSION });
}

/**
 * Which column this widget groups over — narrowed against the four words that exist.
 *
 * ⚠️ **`widgetConfig` cannot do this for you.** Its shape check compares by `typeof`, so a
 * stored `dimension: "bogus"` is a string, matches the fallback's shape and passes straight
 * through. Sent on, it would reach `wishlist_breakdown`'s four `match` arms and come back as a
 * refusal — a card that reads as broken because of a word nobody can see. Falling back to the
 * default instead draws a chart that is merely not the one somebody's other build chose.
 */
export function readDimension(widget: HomeWidget): BreakdownDimension {
  const { dimension } = storedConfig(widget);
  return BREAKDOWN_DIMENSIONS.some((option) => option.id === dimension)
    ? (dimension as BreakdownDimension)
    : WISHLIST_VALUE_DEFAULT_DIMENSION;
}

// The two keys this widget reads through live in `../keys` — `wishlistTotalKey` is also
// `SummaryWidget`'s wishlist figure, and one definition is what keeps the pair one fetch. The
// argument for the `["wishlist", …]` root is in that file's module doc.

/**
 * How many buckets are drawn.
 *
 * Three of the four dimensions cannot exceed this — six rarities, seven colour buckets, four
 * finishes — and the fourth can be *hundreds*: a wishlist spread over every set Scryfall has.
 * The rows arrive dearest first, so a cap takes the buckets the reader is actually spending in
 * and the rest is said as a count rather than dropped in silence.
 */
const MAX_BARS = 8;

/** The four dimensions as the dropdown's rows, ordered the way every option list in this app is
 *  ordered rather than the way the record happened to be written. */
const DIMENSION_OPTIONS: DropdownOption[] = sortOptions(
  BREAKDOWN_DIMENSIONS,
  (option) => option.label,
).map((option) => ({ value: option.id, label: option.label }));

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

/**
 * A colour bucket as a word.
 *
 * Three shapes, and the case matters: the key for one colour is the **stored uppercase letter**
 * out of `cards.color_identity` — a concatenated string of letters and never a JSON array — while
 * the two special buckets are lowercase, `c` for colourless and `multi` for two or more. Both
 * lists spell them identically, on purpose, so a bar means the same thing in either widget.
 */
function colorLabel(key: string): string {
  if (key === "multi") return "Multicolor";
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
 * Colour and rarity carry meaning and are drawn in it; a set and a finish do not, so they take
 * the accent. `multi` has no mana fill of its own — the six are the printed symbols — so it
 * takes the app's gold, which is what multicolour is on a real card frame.
 */
function bucketFill(dimension: BreakdownDimension, key: string): string {
  if (dimension === "rarity") return rarityColor(key);
  if (dimension === "color") {
    if (key === "multi") return "var(--color-pie-gold)";
    if (key === "c") return MANA_FILL.C;
    return isManaKey(key) ? MANA_FILL[key] : "var(--color-border)";
  }
  return "var(--color-accent)";
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function copiesOf(cards: number): string {
  return `${cards} ${cards === 1 ? "copy" : "copies"}`;
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
  label: string,
  row: BreakdownRow,
  share: number | null,
  currency: "usd" | "eur",
  marketplaceLabel: string,
): string {
  if (row.value === null) {
    return `${label}: ${copiesOf(row.cards)}, no price to buy at ${marketplaceLabel}.`;
  }
  // Omitted rather than drawn as an em dash mid-sentence: there is nothing to take a percentage
  // of when the list itself totals nothing, and a clause saying so would be noise.
  const of = share === null ? "" : `, ${percent(share)} of the total`;
  return `${label}: ${copiesOf(row.cards)}, ${formatPrice(row.value, currency)}${of}.`;
}

export function WishlistValueWidget({
  widget,
  editing,
  onConfig,
  onRemove,
  onSpan,
  dragHandleRef,
  onNudge,
}: WidgetProps): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const stored = storedConfig(widget);
  const dimension = readDimension(widget);

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
  const drawn = rows?.slice(0, MAX_BARS) ?? [];
  const hidden = (rows?.length ?? 0) - drawn.length;

  return (
    <WidgetCard
      heading={HEADING}
      editing={editing}
      span={widgetSpan(widget)}
      actions={
        <Dropdown
          size="sm"
          // Named for the widget and not just for the control: the collection's card carries the
          // same dropdown, and two buttons called "Break down by" on one page is a page whose
          // controls a reader cannot tell apart.
          label={`Break down ${HEADING.toLowerCase()} by`}
          options={DIMENSION_OPTIONS}
          value={dimension}
          // **Spread, never replace.** `widgetConfig` carries through keys this build does not
          // know about, and passing them back is what stops an older build silently deleting a
          // newer one's settings on a press that was only about the dimension.
          onChange={(next) => onConfig({ ...stored, dimension: next })}
        />
      }
      onRemove={onRemove}
      onSpan={onSpan}
      dragHandleRef={dragHandleRef}
      onNudge={onNudge}
    >
      {refusal !== null ? (
        <p className="text-sm text-destructive">Could not price your wishlist — {refusal}</p>
      ) : totals === undefined || rows === undefined ? (
        <p className="text-sm text-dim">Adding up what your wishlist would cost…</p>
      ) : totals.wishes === 0 ? (
        // **The wishlist's sentence, not the collection's.** Nothing is owned or unowned here:
        // an empty wishlist is a plan nobody has made yet.
        <p className="text-sm text-dim">
          You want nothing yet — wish for a card and its cost lands here.
        </p>
      ) : (
        <>
          <FigureRow>
            <Figure
              label={`Total cost (${currency.toUpperCase()})`}
              value={formatPrice(totals.cost, currency)}
              // The qualification that keeps the number honest: a sum that quietly omitted these
              // copies would read as a smaller list rather than as an incomplete price.
              note={
                totals.unpriced > 0
                  ? `${copiesOf(totals.unpriced)} nobody quotes a price for`
                  : undefined
              }
              title={pricesAsOf(marketplace)}
            />
          </FigureRow>

          {drawn.length === 0 ? (
            // A list with wishes on it and no buckets to show is the marketplace's silence, not
            // an empty wishlist — two different sentences, and this is the rarer one.
            <p className="text-sm text-dim">Nothing in this slice has a price yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {drawn.map((row) => {
                // **The denominator is the caller's.** The list's own total is what a share is a
                // share *of*, so a bar means the same thing whichever dimension is on screen —
                // a max taken across the drawn rows would silently rescale every bar when the
                // reader switched slice. `null` where there is nothing to take a percentage of,
                // which `percent` draws as an em dash.
                const share =
                  row.value === null || totals.cost <= 0 ? null : row.value / totals.cost;
                const label = bucketLabel(dimension, row);
                return (
                  <li key={row.key} className="flex flex-col gap-0.5">
                    <span className="sr-only">
                      {barSentence(label, row, share, currency, marketplace.label)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="flex items-baseline justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 truncate text-text">{label}</span>
                      <span className="shrink-0 font-mono tabular-nums text-dim">
                        {formatPrice(row.value, currency)}
                      </span>
                    </span>
                    <span aria-hidden="true" className="flex items-center gap-2">
                      <Track
                        share={share ?? 0}
                        fill={bucketFill(dimension, row.key)}
                        height={6}
                        // A bucket the reader can see is a bucket with something in it: a dollar
                        // against a thousand rounds to nothing, and an invisible bar under a
                        // label reads as a bug rather than as a small number.
                        style={share !== null && share > 0 ? { minWidth: 2 } : undefined}
                      />
                      <span className="w-8 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-dim">
                        {percent(share)}
                      </span>
                    </span>
                  </li>
                );
              })}
              {hidden > 0 && (
                <li className="text-xs text-dim">
                  …and {hidden} smaller {hidden === 1 ? "bucket" : "buckets"}.
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  );
}
