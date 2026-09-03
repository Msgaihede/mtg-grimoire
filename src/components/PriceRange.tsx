import { useId, useState } from "react";
import { FILTER_FIELD, FILTER_FOCUS } from "@/components/FilterChips";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";

/**
 * A price band, as two numbers and a pair of handles.
 *
 * The one control in the filter tray that is not a set of options, which is why it is here
 * rather than in `FilterChips`: everything in that module is a chip, a toggle or a recipe for
 * one, and this is a scale.
 */

/**
 * The prices the slider's five segments run between — a quasi-logarithmic ladder, not a line.
 *
 * **A linear slider is unusable over this data and that is a fact about Magic rather than a
 * taste.** Card prices are Pareto: almost every printing is under a pound and the tail runs to
 * four figures, so a linear 0–1000 track spends 99.9% of its width on prices nobody filters by
 * and puts the entire interesting range inside its first pixel. Each segment below gets an
 * equal fifth of the track, so the reader gets a fifth of the width for "under a pound", a
 * fifth for "one to five", and so on out to the tail.
 *
 * Anchors rather than stops: the position between two of them interpolates, so **every** price
 * has a position and a typed number always has somewhere to put its handle. A stop list would
 * have made the handle lie about any number between two stops.
 *
 * The top anchor is also the slider's "no ceiling" position — see {@link PRICE_POSITIONS}.
 */
export const PRICE_ANCHORS = [0, 1, 5, 20, 100, 1000] as const;

/**
 * How many positions the track is divided into.
 *
 * A thousand rather than one per anchor, so dragging is smooth and {@link positionOfPrice} can
 * put a typed number where it really falls. The *values* a drag produces are still round —
 * {@link roundPrice} does that — so the fine track buys precision of position without spending
 * it on `$6.83`.
 *
 * Divisible by `PRICE_ANCHORS.length - 1`, which is what makes each segment a whole number of
 * positions and the arithmetic below exact.
 */
export const PRICE_POSITIONS = 1000;

const SEGMENT = PRICE_POSITIONS / (PRICE_ANCHORS.length - 1);

/**
 * A price a reader would recognise, at the precision that price deserves.
 *
 * Four bands rather than a fixed number of decimals: 2 decimal places is noise at $300 and not
 * enough resolution at $0.30. Every value this produces is a number a shop would print.
 *
 * **Monotonic across its own boundaries**, which is what keeps a drag from ever going
 * backwards: 0.975 rounds up to 1.00 by the first arm and 1.00 is what the second arm would
 * have given it anyway.
 */
export function roundPrice(value: number): number {
  if (value < 1) return Math.round(value * 20) / 20;
  if (value < 10) return Math.round(value * 4) / 4;
  if (value < 100) return Math.round(value);
  return Math.round(value / 5) * 5;
}

/** What a handle at `pos` is asking for, rounded to a price a shop would print. */
export function priceAtPosition(pos: number): number {
  const clamped = Math.min(Math.max(pos, 0), PRICE_POSITIONS);
  // `min` against the last *pair*, not the last anchor: at the very top `clamped / SEGMENT` is
  // exactly `PRICE_ANCHORS.length - 1`, which has no anchor above it to interpolate towards.
  const seg = Math.min(Math.floor(clamped / SEGMENT), PRICE_ANCHORS.length - 2);
  const t = (clamped - seg * SEGMENT) / SEGMENT;
  return roundPrice(PRICE_ANCHORS[seg] + t * (PRICE_ANCHORS[seg + 1] - PRICE_ANCHORS[seg]));
}

/**
 * Where a price sits on the track — the inverse of {@link priceAtPosition}, up to its rounding.
 *
 * **A number above the top anchor clamps to the far right**, where it shares a position with
 * "no ceiling". The two are told apart by the number box beside the handle, which carries the
 * typed figure and is the filter's real value: a reader who types `2000` sees `2000` and a
 * handle at the end, and a reader who dragged there sees an empty box. Nothing is lost, because
 * the only way to *reach* the ambiguous position by dragging is the unbounded one.
 */
export function positionOfPrice(value: number): number {
  if (value <= PRICE_ANCHORS[0]) return 0;
  if (value >= PRICE_ANCHORS[PRICE_ANCHORS.length - 1]) return PRICE_POSITIONS;
  for (let seg = 0; seg < PRICE_ANCHORS.length - 1; seg += 1) {
    const low = PRICE_ANCHORS[seg];
    const high = PRICE_ANCHORS[seg + 1];
    if (value < high) return Math.round(seg * SEGMENT + (SEGMENT * (value - low)) / (high - low));
  }
  return PRICE_POSITIONS;
}

/**
 * What the reader typed, as a number the filter can use — or `undefined` for "this end is open".
 *
 * A blank box is an open end and not a zero, which is the whole reason this is a `text` field
 * with a draft rather than a `number` input bound straight to the filter: `0` is a real and very
 * narrow filter (it drops every printing the marketplace does not price), and it must not be
 * what an empty box means.
 *
 * Anything unparseable is also an open end. A half-typed `1.` is the everyday case, and treating
 * it as a filter would re-query the corpus on the way to a number the reader has not finished
 * writing.
 */
export function parsePrice(draft: string): number | undefined {
  const trimmed = draft.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** How a bound reads in a box: the bare number, because the currency is on the field's label. */
function draftOf(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * Both ends of the price filter, at the marketplace the view quotes from.
 *
 * **The two number boxes are the filter and the handles are a way of reaching it**, which is the
 * one thing to hold on to when reading this. A handle can only express the prices the ladder
 * runs over; a box can express any of them. So a drag writes through `priceAtPosition` and a
 * typed number is taken as it stands — and the handle a typed number puts on the track is the
 * nearest honest position for it rather than a claim that the number is exactly there.
 *
 * **An end at the extreme of its own travel is open, not clamped.** A minimum handle at the far
 * left means "no floor" rather than "at least nothing", and a maximum at the far right means "no
 * ceiling" rather than "at most a thousand pounds" — otherwise there is no way back to an
 * unfiltered band once a handle has been touched, which is a control a reader cannot undo.
 *
 * **An unpriced printing fails a bound end**, and the caption says so rather than leaving it to
 * be discovered: a shop that does not list a card has not offered it for nothing, so narrowing
 * by price narrows away everything the chosen marketplace is silent about. On Card Kingdom and
 * Mana Pool that is the whole corpus until the feed has been fetched.
 */
export function PriceRange({
  min,
  max,
  currency,
  onChange,
}: {
  min: number | undefined;
  max: number | undefined;
  /** Whose money this is, for the labels and the spoken values. The marketplace's, never a guess. */
  currency: Currency;
  onChange: (min: number | undefined, max: number | undefined) => void;
}) {
  const id = useId();
  // **The boxes hold a draft and the filter holds a number**, because the two are not the same
  // thing while a reader is mid-word: `1.`, `1.5` and `1.50` are three drafts of one number, and
  // re-rendering the box from the filter would delete the character just typed.
  const [lowDraft, setLowDraft] = useState(() => draftOf(min));
  const [highDraft, setHighDraft] = useState(() => draftOf(max));
  // **Re-seeded during render and never in an effect**, which is React's own answer for state
  // that has to follow a prop — and the only one available here, because `npm run lint` rejects
  // a `setState` called synchronously inside a `useEffect` (`react-hooks/set-state-in-effect`).
  //
  // The test is against what the draft *parses to* rather than against a remembered previous
  // prop, and that is what makes it both correct and quiet. A draft is authoritative for its own
  // value, so `1.50` and `1.5` are the same filter and a trailing zero survives being typed; a
  // bound moved from *outside* — a handle dragged, Reset all pressed — is a value the draft does
  // not express, and only that re-seeds. It cannot loop: the branch writes exactly the string
  // that parses back to the prop, so the next render's test is false.
  if (parsePrice(lowDraft) !== min) setLowDraft(draftOf(min));
  if (parsePrice(highDraft) !== max) setHighDraft(draftOf(max));

  const lowPos = min === undefined ? 0 : positionOfPrice(min);
  const highPos = max === undefined ? PRICE_POSITIONS : positionOfPrice(max);
  /** Whether either end is a real bound — what tells a filter from a control at rest. */
  const bounded = min !== undefined || max !== undefined;
  const spoken = (value: number | undefined, open: string) =>
    value === undefined ? open : formatPrice(value, currency);

  const box = cn(
    FILTER_FIELD,
    FILTER_FOCUS,
    "w-16 shrink-0 border-border bg-bg px-2 font-mono text-xs tabular-nums text-text",
    "placeholder:text-dim focus:border-accent",
  );
  // One recipe for both handles: an invisible native range whose *thumb* is the only part that
  // is drawn or can be pressed, stacked over the shared track below. `pointer-events-none` on
  // the input is what lets the two overlap without the upper one swallowing every press meant
  // for the lower — the thumbs take their own back.
  const handle = cn(
    "pointer-events-none absolute inset-0 m-0 h-9 w-full appearance-none bg-transparent",
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-3.5",
    "[&::-webkit-slider-thumb]:cursor-ew-resize [&::-webkit-slider-thumb]:appearance-none",
    "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2",
    "[&::-webkit-slider-thumb]:border-bg [&::-webkit-slider-thumb]:bg-accent",
    // The focus ring goes on the thumb rather than on the input, which is a full-width box with
    // no edges a reader could make sense of. Same shape as the row's `FILTER_FOCUS`: an outline
    // standing off the control, so focus and on are told apart by shape and not by hue.
    //
    // **`focus-thumb:` rather than the arbitrary variant this was written with.** Spelled by
    // hand, inside square brackets, the pseudo-class is a string the *component* wrote — not the
    // variant Tailwind owns — so the redefinition in `src/index.css` never rewrote it. This one
    // control would have gone on drawing its ring for a keystroke that moved no focus, while
    // every other focus outline in the app correctly stopped. `keyboardModality.test.ts` sweeps
    // for the shape, which is why the words above describe it instead of quoting it.
    "focus-thumb:outline-2 focus-thumb:outline-offset-2 focus-thumb:outline-accent",
    "focus-visible:outline-none",
  );

  return (
    // **`flex-wrap`, and it is load-bearing at exactly one width.** Two 64px boxes, a 48px track
    // and two 8px gaps come to 192, and the narrowest cell this control is ever drawn in is the
    // deck panel's one-column tray at its 206px floor — about 174 of content. Unwrapped, the
    // track cannot shrink past its `min-w` and the whole row hangs out of the panel, which
    // `DeckEditor`'s section turns into a horizontal scrollbar across the entire deck builder
    // (`src/CLAUDE.md`'s narrowest-surface rule; measured 5px over at 206 before this). Wrapping
    // drops the track onto a line of its own under the two numbers, which is the right thing to
    // give up first: the boxes are the filter and the track is a way of reaching it.
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label htmlFor={`${id}-low`} className="sr-only">
        Lowest price
      </label>
      <input
        id={`${id}-low`}
        type="text"
        inputMode="decimal"
        value={lowDraft}
        placeholder="Any"
        onChange={(e) => {
          setLowDraft(e.target.value);
          onChange(parsePrice(e.target.value), max);
        }}
        className={cn(box, "text-right")}
      />

      {/* `isolate`, and **no `z-index` anywhere below it.** The two ranges are stacked siblings
          and the later one wins the overlap by document order, which is exactly the arrangement
          `lib/layers.ts`' sweep exists to forbid *between app surfaces* — so this box makes a
          stacking context of its own and the contest cannot reach the app's ladder. What it costs
          is that a press where the two thumbs coincide always grabs the maximum, and that is
          survivable rather than a trap: dragging the maximum carries the minimum with it (the
          push below), so every coincident state is escapable with the thumb that is on top. */}
      <div className="relative isolate flex h-9 min-w-16 flex-1 items-center">
        {/* The track and the filled span are drawn here rather than by either input, because
            there are two inputs and one band: a native range track would be drawn twice, once
            per handle, and the second would paint over the first. */}
        <div aria-hidden="true" className="absolute inset-x-0 h-[3px] rounded-full bg-border" />
        <div
          aria-hidden="true"
          className={cn(
            "absolute h-[3px] rounded-full",
            // **Gold only when the band is a filter.** With both ends open the span covers the
            // whole track, so an unconditional accent draws a full-width gold bar across a tray
            // nobody has touched — and gold means *this is on* everywhere else on this row, which
            // makes it the one control that claims to be filtering when it is not. Found by
            // looking at the shipped window; every number about this control was already right.
            //
            // The two thumbs stay gold either way: they are where the reader presses, and a
            // hairline thumb on a hairline track is a control with nothing to aim at.
            bounded ? "bg-accent" : "bg-border",
          )}
          style={{
            left: `${(lowPos / PRICE_POSITIONS) * 100}%`,
            right: `${100 - (highPos / PRICE_POSITIONS) * 100}%`,
          }}
        />
        <input
          type="range"
          min={0}
          max={PRICE_POSITIONS}
          value={lowPos}
          // **Not the same name as the box beside it**, though it is the same value. Two controls
          // sharing one accessible name cannot be addressed unambiguously — by a screen reader
          // walking the form, by anyone driving the app by voice, or by a `getByLabelText` that
          // throws "found multiple". The box is where the number is typed and keeps the plain
          // name; the slider says what it is. Both still *begin* with the words a reader would
          // reach for, which is what keeps either findable.
          aria-label="Lowest price, slider"
          // The number, spoken — a screen reader reading "480" off a thousand-position track
          // would be hearing the mechanism instead of the filter.
          aria-valuetext={spoken(min, "No minimum")}
          onChange={(e) => {
            const pos = Number(e.target.value);
            const next = pos === 0 ? undefined : priceAtPosition(pos);
            // Pushed rather than blocked: dragging the floor past the ceiling takes the ceiling
            // with it, which is what every dual slider in a shop does. Refusing the drag instead
            // leaves the handle stuck under the pointer with no way to say why.
            onChange(next, max !== undefined && next !== undefined && max < next ? next : max);
          }}
          className={handle}
        />
        <input
          type="range"
          min={0}
          max={PRICE_POSITIONS}
          value={highPos}
          aria-label="Highest price, slider"
          aria-valuetext={spoken(max, "No maximum")}
          onChange={(e) => {
            const pos = Number(e.target.value);
            const next = pos === PRICE_POSITIONS ? undefined : priceAtPosition(pos);
            onChange(min !== undefined && next !== undefined && min > next ? next : min, next);
          }}
          className={handle}
        />
      </div>

      <label htmlFor={`${id}-high`} className="sr-only">
        Highest price
      </label>
      <input
        id={`${id}-high`}
        type="text"
        inputMode="decimal"
        value={highDraft}
        placeholder="Any"
        onChange={(e) => {
          setHighDraft(e.target.value);
          onChange(min, parsePrice(e.target.value));
        }}
        className={box}
      />
    </div>
  );
}
