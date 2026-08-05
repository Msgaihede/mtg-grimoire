import { useEffect, useId, useMemo, useRef, type RefObject } from "react";
import { Figure, FigureRow } from "@/components/Figure";
import { ipcError, type DeckCard } from "@/lib/ipc";
import { MANA_LABEL, MANA_LINE_KEYS } from "@/lib/mana";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { manaValueOf } from "./validation/engine";
import { groupCards } from "./ZoneColumn";

/**
 * Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 * control's edge, never a ring (a ring means "state" everywhere else).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The nine curve buckets — 0 through 7 exactly, and 8 open-ended, which is the bucketing the
 *  mana-value filter chips and `ZoneColumn`'s mana-value grouping already use. */
const CURVE_BUCKETS = 9;

/** The five colours a pip can be, in the order symbols are printed. */
type PipKey = (typeof MANA_LINE_KEYS)[number];

/**
 * One wedge of a pie: what it is, how many copies are in it, and the fill that says which.
 *
 * `color` is a token reference rather than a literal, so the charts and the identity pips can
 * never drift apart from the direction doc's pie deeps (`index.css`, `--color-pie-*`).
 */
export interface Slice {
  key: string;
  label: string;
  count: number;
  color: string;
}

/** What one card type's bar draws. */
export interface TypeCount {
  key: string;
  label: string;
  count: number;
}

/**
 * Everything the strip says about a deck, computed once from the rows the editor already
 * holds.
 *
 * **Copies throughout, never rows.** Four Bolts are four cards in every number here, which is
 * the only reading under which a curve, a price and a deck size can be talked about together.
 *
 * **The scratchpad counts toward nothing** — not size, not price, not the curve — which is the
 * same rule `validateDeck` applies before it judges anything and the reason the allocator
 * never claims a copy for it. Everything else counts: a sideboard is cards you own, sleeve and
 * pay for.
 */
export interface DeckStatsSummary {
  /** Copies in every zone but `maybe`. */
  copies: number;
  lands: number;
  nonlands: number;
  /** Nonland copies with no mana value anywhere — an orphaned row has neither a `cmc` nor a
   *  printed cost, and filing it under 0 would put a number this app invented at the head of
   *  the curve, where a reader counts their cheapest spells. */
  unknownManaValue: number;
  /** Nine buckets over nonlands: index 0–7 exactly, index 8 is "8 or more". */
  curve: number[];
  /** Copies of each colour, counted **once per colour on the card** — a WU card feeds both W
   *  and U. Overlapping on purpose: this is "what can this deck cast", which is a different
   *  question from the colour pie's "what is this deck made of". */
  pips: Record<PipKey, number>;
  /** Nonlands in exactly one bucket each — mono, multicolour or colourless — so they sum to
   *  {@link nonlands} and can therefore be a pie. */
  colorDist: Slice[];
  /** Lands by the basic land types on their front face, summing to {@link lands}. */
  landDist: Slice[];
  /** The deck list's own type buckets, in its own order (`ZoneColumn.groupCards`). */
  typeDist: TypeCount[];
  /** Over nonlands with a mana value, weighted by copies. `null` for a deck of nothing but
   *  lands — an average of no numbers is not 0. */
  averageManaValue: number | null;
  /** Summed from each row's own finish-correct `usd`, never `cards.price_usd` — which is a
   *  display fallback chain and must not be added up. `null` when nothing is priced. */
  priceUsd: number | null;
  /** Copies the sum could not price, so a total that omits them does not lie by rounding
   *  down. */
  unpriced: number;
  /** Copies this deck secured from the collection, and the ones it could not. */
  owned: number;
  missing: number;
}

/** The basic land types, and the pie deep each is drawn in. Order is WUBRG, as printed. */
const BASIC_TYPES: { type: string; color: string }[] = [
  { type: "Plains", color: "var(--color-pie-w)" },
  { type: "Island", color: "var(--color-pie-u)" },
  { type: "Swamp", color: "var(--color-pie-b)" },
  { type: "Mountain", color: "var(--color-pie-r)" },
  { type: "Forest", color: "var(--color-pie-g)" },
];

/** The pie deep one colour letter is drawn in. */
const PIP_COLOR: Record<PipKey, string> = {
  W: "var(--color-pie-w)",
  U: "var(--color-pie-u)",
  B: "var(--color-pie-b)",
  R: "var(--color-pie-r)",
  G: "var(--color-pie-g)",
};

/** The two buckets that are not one of the five: gold for a card of several colours, the
 *  colourless grey for a card of none. */
const GOLD = "var(--color-pie-gold)";
const COLORLESS = "var(--color-pie-c)";

/**
 * A row's own mana value: the synced column when there is one, the printed cost when there is
 * not, and `null` for a row that has neither.
 *
 * The same fallback `engine.ts` measures Tiny Leaders' ceiling with, through the same exported
 * arithmetic — two implementations of `{2/W}` would eventually disagree about a card.
 */
function manaValue(card: DeckCard): number | null {
  if (card.cmc !== null) return card.cmc;
  return card.manaCost === null ? null : manaValueOf(card.manaCost);
}

/** The front face's type line. A modal double-faced card's back is routinely a land while its
 *  front is a spell, and a deck is cast from the front. */
function front(typeLine: string | null): string {
  return (typeLine ?? "").split("//")[0];
}

/**
 * The buckets a pie can draw: the ones with something in them.
 *
 * Dropped here rather than in the chart so that every distribution this module answers has the
 * same shape as `groupCards`' — a bucket nothing is in is not a bucket, and a legend row
 * reading 0 is a line that says nothing. The full list is what the caller sees dropped,
 * because a mono-red deck has one colour and not seven.
 */
function drawable(slices: Slice[]): Slice[] {
  return slices.filter((slice) => slice.count > 0);
}

/**
 * Every number the strip draws, from the rows the editor already has.
 *
 * Pure, exported and tested on its own: a chart is only as trustworthy as the arithmetic
 * behind it, and arithmetic that can only be checked by reading pixels is arithmetic nobody
 * checks.
 */
export function deckStats(cards: readonly DeckCard[]): DeckStatsSummary {
  const counted = cards.filter((c) => c.zone !== "maybe");

  // One bucketing for four charts: the type bars *are* the deck list's headings, and the
  // land/nonland split every other chart turns on is the same grouping read once. Deriving it
  // twice is how a column heading and a bar under it start disagreeing about a card.
  const groups = groupCards(counted, "type");
  const lands = groups.find((g) => g.key === "land")?.cards ?? [];
  const nonlands = groups.filter((g) => g.key !== "land").flatMap((g) => g.cards);

  const copiesOf = (rows: readonly DeckCard[]) => rows.reduce((n, c) => n + c.quantity, 0);

  const curve = Array<number>(CURVE_BUCKETS).fill(0);
  let manaValued = 0;
  let manaValueTotal = 0;
  let unknownManaValue = 0;
  for (const card of nonlands) {
    const mv = manaValue(card);
    if (mv === null) {
      unknownManaValue += card.quantity;
      continue;
    }
    curve[Math.min(CURVE_BUCKETS - 1, Math.max(0, Math.floor(mv)))] += card.quantity;
    manaValued += card.quantity;
    manaValueTotal += mv * card.quantity;
  }

  const pips: Record<PipKey, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const card of counted) {
    // Letters, never JSON: `colors` is `"WU"`, and `JSON.parse` throws on it.
    for (const letter of card.colors ?? "") {
      if (letter in pips) pips[letter as PipKey] += card.quantity;
    }
  }

  const colorCounts = new Map<string, number>();
  for (const card of nonlands) {
    const colors = card.colors ?? "";
    const key = colors.length === 0 ? "c" : colors.length === 1 ? colors : "gold";
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + card.quantity);
  }
  const colorDist: Slice[] = drawable([
    ...MANA_LINE_KEYS.map((key) => ({
      key,
      label: MANA_LABEL[key],
      count: colorCounts.get(key) ?? 0,
      color: PIP_COLOR[key],
    })),
    { key: "gold", label: "Multicolor", count: colorCounts.get("gold") ?? 0, color: GOLD },
    { key: "c", label: "Colorless", count: colorCounts.get("c") ?? 0, color: COLORLESS },
  ]);

  const landCounts = new Map<string, number>();
  for (const card of lands) {
    const line = front(card.typeLine);
    const printed = BASIC_TYPES.filter((b) => line.includes(b.type));
    const key = printed.length === 1 ? printed[0].type : printed.length > 1 ? "multi" : "other";
    landCounts.set(key, (landCounts.get(key) ?? 0) + card.quantity);
  }
  const landDist: Slice[] = drawable([
    ...BASIC_TYPES.map(({ type, color }) => ({
      key: type,
      label: type,
      count: landCounts.get(type) ?? 0,
      color,
    })),
    { key: "multi", label: "Multi-type", count: landCounts.get("multi") ?? 0, color: GOLD },
    { key: "other", label: "Other lands", count: landCounts.get("other") ?? 0, color: COLORLESS },
  ]);

  let priceUsd = 0;
  let priced = 0;
  let unpriced = 0;
  let owned = 0;
  let missing = 0;
  for (const card of counted) {
    if (card.unitPriceUsd === null) unpriced += card.quantity;
    else {
      priceUsd += card.unitPriceUsd * card.quantity;
      priced += card.quantity;
    }
    // The row badge's own arithmetic, added up: a claim is clamped to what the row wants, and
    // a deck cannot be more than fully covered.
    const have = Math.min(card.ownedQuantity, card.quantity);
    owned += have;
    missing += card.quantity - have;
  }

  return {
    copies: copiesOf(counted),
    lands: copiesOf(lands),
    nonlands: copiesOf(nonlands),
    unknownManaValue,
    curve,
    pips,
    colorDist,
    landDist,
    typeDist: groups.map(({ key, label, count }) => ({ key, label, count })),
    averageManaValue: manaValued === 0 ? null : manaValueTotal / manaValued,
    priceUsd: priced === 0 ? null : priceUsd,
    unpriced,
    owned,
    missing,
  };
}

/**
 * What this strip needs of `useDeck().missingToWishlist` — the mutation, narrowed to the six
 * things a button and a sentence read.
 *
 * Narrowed rather than passed whole so the strip can be rendered in a test without a query
 * client, and so the one write it makes is visible in its own signature.
 */
export interface MissingWrite {
  mutate: (variables: void) => void;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  /** How many wishes the last successful press wrote. */
  data: number | undefined;
}

/**
 * What the deck adds up to, live.
 *
 * Every number comes from the same `DeckCard[]` the columns are drawn from — one query, so a
 * curve and a legality panel can never disagree — and it is recomputed on every edit, because
 * the arithmetic is a single pass over a few hundred rows and a stats block that lags the
 * stepper beside it is worse than one that costs a microsecond.
 *
 * Four charts and a pips row, and the four are the direction doc's sanctioned uses of colour
 * outside the mana line: a deck's colours *are* Magic meaning. Nothing here animates, nothing
 * here is a chart library, and every chart carries its numbers as text — the drawing is
 * `aria-hidden` and the words beside it are the whole accessible story.
 */
export function DeckStats({ cards, send }: { cards: readonly DeckCard[]; send: MissingWrite }) {
  const stats = useMemo(() => deckStats(cards), [cards]);
  const sendRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);

  // The disabled-on-press hazard, in the shape it takes outside a dismissible layer: a browser
  // blurs a control that disables itself, with no `relatedTarget` at all, so the caret lands on
  // `<body>` and the reader's next Tab restarts from the top of the app. The button is still
  // here when the write settles, so it takes the caret back — and only from `<body>`, because a
  // reader who has moved on in the meantime owns where they are.
  const pending = send.isPending;
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      sendRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  const n = (value: number) => value.toLocaleString("en-US");
  const added = send.isSuccess ? (send.data ?? 0) : null;
  const failure = send.isError ? ipcError(send.error) : null;

  return (
    <div className="flex shrink-0 flex-col gap-3">
      <FigureRow>
        <Figure label="Cards" value={n(stats.copies)} />
        <Figure label="Lands" value={n(stats.lands)} />
        <Figure
          label="Avg. mana value"
          value={stats.averageManaValue === null ? "—" : stats.averageManaValue.toFixed(2)}
          note="nonlands"
        />
        <Figure
          label="Price (USD)"
          value={usdPrice(stats.priceUsd)}
          note={stats.unpriced > 0 ? `${n(stats.unpriced)} unpriced` : undefined}
          title={PRICES_AS_OF}
        />
      </FigureRow>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Pips pips={stats.pips} />
        <Missing
          stats={stats}
          send={send}
          sendRef={sendRef}
          added={added}
          failure={failure}
          n={n}
        />
      </div>

      {stats.copies > 0 && (
        // The clusters wrap rather than truncate: at 1024px with the card pane docked beside
        // the editor this row is a few hundred pixels wide, and a chart whose numbers are cut
        // off is a chart that has stopped being one.
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <Curve curve={stats.curve} unknown={stats.unknownManaValue} />
          <Pie caption="Colors" slices={stats.colorDist} />
          <Pie caption="Lands" slices={stats.landDist} />
          <TypeBars types={stats.typeDist} />
        </div>
      )}
    </div>
  );
}

/**
 * The castability line: one dot per colour, in the pie deeps, with the copies behind it.
 *
 * All five are drawn whether or not the deck plays them — the row is a shape a reader learns
 * to read at a glance, and a row that changes width with the deck is one they have to read
 * again every time. A colour the deck has none of is dimmed rather than dropped.
 */
function Pips({ pips }: { pips: Record<PipKey, number> }) {
  return (
    <div
      role="group"
      aria-label="Color pips"
      title="Copies of each colour. A two-colour card counts in both."
      className="flex items-center gap-3"
    >
      {MANA_LINE_KEYS.map((key) => (
        <span key={key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-3 rounded-full"
            style={{ backgroundColor: PIP_COLOR[key], opacity: pips[key] > 0 ? 1 : 0.3 }}
          />
          <span className="sr-only">{MANA_LABEL[key]}</span>
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              pips[key] > 0 ? "text-text" : "text-dim",
            )}
          >
            {pips[key]}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * What the deck is short of, and the one press that does something about it.
 *
 * The button is absent when there is nothing missing — a control that spends its life offering
 * to do nothing teaches the reader to stop looking at the line it is in — and the sentence
 * that replaces it is still a fact worth having: a deck you own every card of is the answer to
 * the question this line asks.
 */
function Missing({
  stats,
  send,
  sendRef,
  added,
  failure,
  n,
}: {
  stats: DeckStatsSummary;
  send: MissingWrite;
  sendRef: RefObject<HTMLButtonElement | null>;
  added: number | null;
  failure: string | null;
  n: (value: number) => string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {stats.missing > 0 ? (
        <>
          {/* One text node, in the data face: this is a count with two words attached, and
              splitting it across styled spans would make it a sentence no matcher — screen
              reader, test or reader skimming — reads as one. */}
          <p className="font-mono tabular-nums text-destructive">
            {n(stats.missing)} of {n(stats.copies)} missing
          </p>
          <button
            ref={sendRef}
            type="button"
            disabled={send.isPending}
            onClick={() => send.mutate()}
            className={cn(
              "rounded-md border border-border px-2 py-1 text-dim",
              "transition-colors duration-150 hover:text-text disabled:opacity-50",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            Send missing to wishlist
          </button>
        </>
      ) : (
        stats.copies > 0 && (
          <p className="font-mono tabular-nums text-dim">All {n(stats.copies)} owned.</p>
        )
      )}

      {/* Mounted for the life of the strip and swapped into: a live region that appears
          together with its own text announces nothing, because there was no change for a
          screen reader to notice (the decks gallery's lesson). */}
      <p role="status" className="text-dim">
        {added === null
          ? ""
          : added === 0
            ? "Those cards were already on your wishlist."
            : `Added ${n(added)} ${added === 1 ? "wish" : "wishes"}.`}
      </p>

      {/* Beside the button that was pressed, not in the editor's banner: that one speaks for
          the three writes the deck's own controls make, and a refusal reported somewhere else
          is a refusal the reader has to go looking for. */}
      {failure && (
        <p role="alert" className="text-destructive">
          Could not add to the wishlist — {failure}
        </p>
      )}
    </div>
  );
}

/**
 * The curve: nine buckets over the deck's nonlands.
 *
 * Data-quiet by the direction's own instruction — a surface track with an accent fill, no
 * five-colour anything, no motion. The whole axis is drawn even where a bucket is empty,
 * because a gap in a curve is a fact about the deck.
 */
function Curve({ curve, unknown }: { curve: number[]; unknown: number }) {
  const id = useId();
  const max = Math.max(...curve, 1);
  return (
    <div className="min-w-0">
      <p id={id} className="text-xs text-dim">
        Mana curve
      </p>
      <ul aria-labelledby={id} className="mt-1.5 flex items-end gap-1">
        {curve.map((count, mv) => {
          const last = mv === curve.length - 1;
          const label = last ? `${mv}+` : `${mv}`;
          return (
            <li key={mv} className="flex w-5 flex-col items-center gap-1">
              {/* The one place the pair is spoken, so a screen reader hears "8 cards at mana
                  value 1" rather than the two loose numbers the eye reads as a column. */}
              <span className="sr-only">
                {count} {count === 1 ? "card" : "cards"} at mana value {last ? `${mv} or more` : mv}
              </span>
              <span
                aria-hidden="true"
                className="font-mono text-[0.7rem] leading-none tabular-nums text-dim"
              >
                {count}
              </span>
              <span
                aria-hidden="true"
                className="flex h-10 w-full items-end overflow-hidden rounded-sm bg-surface"
              >
                <span
                  className="w-full rounded-sm bg-accent"
                  style={{ height: `${(count / max) * 100}%` }}
                />
              </span>
              <span
                aria-hidden="true"
                className="font-mono text-[0.7rem] leading-none tabular-nums text-dim"
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
      {unknown > 0 && (
        <p className="mt-1 text-[0.7rem] text-dim">{unknown} with no mana value, not counted</p>
      )}
    </div>
  );
}

/**
 * One wedge, as an SVG path.
 *
 * Hand-rolled because the whole chart is four numbers and an arc, and a charting library would
 * be a dependency, a bundle and a runtime `<style>` the shipped CSP refuses. Angles are turns
 * from twelve o'clock, clockwise, which is the direction a pie is read in.
 */
function wedge(from: number, to: number, cx: number, cy: number, r: number): string {
  const at = (turn: number) => {
    const angle = (turn - 0.25) * 2 * Math.PI;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)].map((v) => v.toFixed(2));
  };
  const [x1, y1] = at(from);
  const [x2, y2] = at(to);
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`;
}

/**
 * A pie, in the direction doc's pie deeps, with the legend that is its accessible story.
 *
 * Every slice handed here has something in it — `deckStats` has already dropped the empty
 * buckets, because five legend rows reading 0 above a mono-red deck are four lines of nothing
 * — so a pie with nothing at all to draw is a chart that is simply not drawn. A pie with one
 * slice is a circle rather than an arc: a wedge whose start and end meet draws no area at all,
 * which is a blank chart nobody would think to test for.
 */
function Pie({ caption, slices: drawn }: { caption: string; slices: Slice[] }) {
  const id = useId();
  const total = drawn.reduce((n, s) => n + s.count, 0);
  if (total === 0) return null;

  let at = 0;
  return (
    <div className="min-w-0">
      <p id={id} className="text-xs text-dim">
        {caption}
      </p>
      <div className="mt-1.5 flex items-center gap-3">
        <svg aria-hidden="true" viewBox="0 0 64 64" className="size-14 shrink-0">
          {drawn.length === 1 ? (
            <circle cx="32" cy="32" r="31" style={{ fill: drawn[0].color }} />
          ) : (
            drawn.map((slice) => {
              const from = at;
              at += slice.count / total;
              return (
                <path
                  key={slice.key}
                  d={wedge(from, at, 32, 32, 31)}
                  style={{ fill: slice.color }}
                  // A hairline of the table felt between wedges, so two deeps that sit next to
                  // each other (black and blue) read as two.
                  stroke="var(--color-bg)"
                  strokeWidth="0.75"
                />
              );
            })
          )}
        </svg>
        <ul aria-labelledby={id} className="min-w-0 space-y-0.5 text-xs">
          {drawn.map((slice) => (
            <li key={slice.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: slice.color }}
              />
              <span className="min-w-0">{slice.label}</span>
              <span className="ml-auto pl-2 font-mono tabular-nums text-dim">{slice.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The type counts, as horizontal bars.
 *
 * Bars rather than a third pie: eight nameable categories is past the point where a pie can be
 * read, and a bar chart is the one chart that stays legible when the labels are words. The
 * counts are the deck list's own headings, so a bar here and a heading in a column are the
 * same number by construction.
 */
function TypeBars({ types }: { types: TypeCount[] }) {
  const id = useId();
  if (types.length === 0) return null;
  const max = Math.max(...types.map((t) => t.count), 1);
  return (
    // The one cluster that takes the width that is left. Measured at 1024px, where the four
    // charts wrap onto two lines: capping this one leaves the second line half empty, and the
    // counts sit at the end of the *track* rather than of the fill so that a column of them
    // lines up and can be read down.
    <div className="min-w-[11rem] flex-1">
      <p id={id} className="text-xs text-dim">
        Card types
      </p>
      <ul aria-labelledby={id} className="mt-1.5 space-y-1">
        {types.map((type) => (
          <li key={type.key} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0">{type.label}</span>
            <span aria-hidden="true" className="h-2 min-w-0 flex-1 rounded-sm bg-surface">
              <span
                className="block h-2 rounded-sm bg-accent"
                style={{ width: `${(type.count / max) * 100}%` }}
              />
            </span>
            <span className="shrink-0 font-mono tabular-nums text-dim">{type.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
