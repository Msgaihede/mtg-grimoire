import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { motion, useAnimationControls } from "motion/react";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { PRESS, TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The two buttons — the app's {@link PRESS} recipe on this component's own box.
 *
 * A button at its floor or its ceiling is `disabled` and must not appear to depress. It is
 * the one control here that uses the attribute, because a stepper button with nothing left to
 * do has no reason to hold a tab stop — and that is why the out-of-reach clause is written
 * here rather than in the shared recipe.
 */
const BUTTON =
  "grid place-items-center rounded-md border border-border text-dim hover:text-text " +
  `${PRESS} ` +
  "disabled:opacity-40 disabled:hover:text-dim disabled:active:scale-100";

/**
 * The same buttons drawn **over a card's illustration** rather than on a panel.
 *
 * Two changes and both are legibility rather than taste. The app's own felt at 88 % backs each
 * button, because a 1px outline with nothing behind it disappears over art of any brightness —
 * it is the backing `FoilOverlay`'s chip and the collection's owned badge already use, at the
 * same strength. And the glyph is the full text colour instead of dim: `text-dim` is a *rank*
 * among panel controls, and there is no rank to express when the thing beside the control is a
 * painting.
 */
const BUTTON_OVER_ART = "bg-bg/88 text-text disabled:hover:text-text";

/**
 * The field's own **native** spin buttons, suppressed — so the two steps this control offers
 * are the two buttons it draws.
 *
 * `type="number"` is kept for the numeric keyboard and the `min`/`max` the field reports to
 * assistive tech, and WebView2 pays for that by drawing its own ▲▼ *inside* the box. At `xs`
 * the box is 32×20px, so those steps crowd the digits out of a field that has to hold "10" —
 * and they are a second, tinier way to do what `−` and `+` already do, three pixels from each
 * other. `appearance: none` alone is not enough on Chromium: the spinner is a pseudo-element
 * and has to be addressed as one, hence all three declarations.
 *
 * Written out as whole class names rather than built up, because Tailwind scans source text and
 * a class assembled by interpolation emits no rule at all.
 */
const NO_NATIVE_STEPS = cn(
  "[appearance:textfield]",
  "[&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none",
  "[&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none",
);

/**
 * A quantity, and the two buttons that change it.
 *
 * The number is an `<input type="number">` rather than a label: typing `12` is one action
 * and pressing `+` eleven times is eleven, and a collection is full of twelves. It is
 * `font-mono tabular-nums` because a quantity is data — the direction reserves colour for
 * mana and art, so this control is grey, and its only emphasis is the focus outline.
 */
export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 9999,
  label,
  size = "md",
  focus = "outside",
  orientation = "horizontal",
  tone = "panel",
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** The accessible name of the number itself — "Quantity of Lightning Bolt", not "Quantity". */
  label: string;
  /**
   * `xs` is the deck's row scale: a stepper inside a 150px grid tile or a 22px text row, where
   * `sm`'s 28px does not fit.
   *
   * `card` is the **48px** column drawn over a card face in the deck stack, and it is the one
   * size larger than the default rather than smaller than `sm` — which is the reverse of what it
   * was until 2026-08-15, when it was 24px. Everything else in this file sits in a *row* of
   * controls and is sized by the row; this one stands alone in a 210px card's right margin, over
   * an illustration, and is the whole of what a reader presses to change how many copies a deck
   * holds. At 24px it was the smallest control in the app in the place with the most room for
   * one. Doubled it is 23% of the card's width and half its height — deliberate, and the number
   * to check first if the column ever overflows the face.
   *
   * **The buttons are square at every size and the field is square in a column**, and at this
   * one the pairing is load-bearing rather than incidental: `vertical` squares the field to the
   * buttons' own width (see {@link orientation}), so the column is one width from top to bottom.
   * A `wide` field in a card's margin would either be wider than the card can spare or drag the
   * buttons out to meet it.
   *
   * It carries a larger corner radius with it, which is not decoration either — a small box
   * reads as a chip at `rounded-md` and as a button at `rounded-lg`, and this is the one place
   * the reader has to tell those apart on top of art. `rounded-lg` did not double with the box:
   * 8px on 48px still reads as a button, and 16px would read as a pill.
   */
  size?: "xs" | "card" | "sm" | "md";
  /** Which side of the control's own edge the focus outline is drawn on. `inset` for a stepper
   *  inside a box that clips — see {@link FOCUS_INSET}. */
  focus?: "outside" | "inset";
  /**
   * Which way the three controls run, and it is a question about the **space**, not the taste:
   * a table cell and a text row are wide and short, and a card face is the other way round.
   *
   * `vertical` puts increase at the top, where up means more, and squares the field to the
   * buttons' own width — a column standing in a card's margin has one dimension to spend and
   * `w-12` of it would be the card.
   */
  orientation?: "horizontal" | "vertical";
  /** What the control is drawn over. `art` for a stepper laid on a card's illustration — see
   *  {@link BUTTON_OVER_ART}. */
  tone?: "panel" | "art";
}) {
  const vertical = orientation === "vertical";
  // `rounded-lg` rides along with `card` and wins over `BUTTON`'s own `rounded-md` because
  // tailwind-merge keeps the last of two conflicting radii and this is passed after it.
  const box =
    size === "xs"
      ? "size-5"
      : size === "card"
        ? "size-12 rounded-lg"
        : size === "sm"
          ? "size-7"
          : "size-9";
  const text =
    size === "xs"
      ? "text-[0.625rem]"
      : size === "card"
        ? "text-[1.375rem]"
        : size === "sm"
          ? "text-xs"
          : "text-sm";
  const wide = size === "xs" ? "h-5 w-8" : size === "sm" ? "h-7 w-12" : "h-9 w-14";
  const field = cn(vertical ? box : wide, text);
  // The glyph is a fixed fraction of its button — 14/24 at `card`, doubled with the box, so a
  // 48px button is not a 14px sign in the middle of an empty square.
  const icon = size === "xs" ? "size-3" : size === "card" ? "size-7" : "size-3.5";
  const ring = focus === "inset" ? FOCUS_INSET : FOCUS;
  const button = cn(BUTTON, tone === "art" && BUTTON_OVER_ART, ring, box);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  /**
   * What is in the box while it is being typed in, or `null` when the box is simply the
   * value.
   *
   * A controlled `<input>` whose `onChange` does not move the state has its DOM value
   * *reverted* by React — so ignoring the empty string, as the obvious version of this does,
   * makes Backspace do nothing at all and turns replacing "1" with "12" into "112". The
   * draft is what lets the box be empty for the one keystroke between the two numbers,
   * without `0` ever reaching the collection.
   */
  const [draft, setDraft] = useState<string | null>(null);

  /**
   * The tick: the number swells by a tenth and settles, once per change.
   *
   * A press on `+` and a press on `−` produce the same thing — a box with a different number
   * in it — and at the sizes this control is drawn at (a 20px box inside a 34px card strip, a
   * 28px one in a table row) the difference between "it stepped" and "it repainted" is a
   * single glyph. The tick is what makes the two read differently, and 1.1 is chosen for the
   * `xs` box: two pixels of travel is felt without a table of steppers becoming a trampoline.
   *
   * **Controls rather than a keyframe on the `animate` prop.** A keyframe array is a new array
   * every render, so `animate={{ scale: [1, 1.1, 1] }}` restarts on renders that changed
   * nothing; and rekeying the `<input>` to force a replay would take the caret out of it
   * mid-type. `useAnimationControls` also goes through the visual element's own target
   * resolution, which is where the app's one `MotionConfig` applies the reader's reduced-motion
   * preference — an imperative `animate()` out of `useAnimate` does not.
   *
   * The ref is compared rather than the render being trusted: this fires on the value the
   * control *reports*, so a step, a typed digit and a quantity that came back changed from the
   * database all tick, and a re-render that moved nothing does not.
   */
  const tick = useAnimationControls();
  const ticked = useRef(value);
  useEffect(() => {
    if (ticked.current === value) return;
    ticked.current = value;
    void tick.start({ scale: [1, 1.1, 1] });
  }, [value, tick]);

  const decrease = (
    <button
      type="button"
      aria-label={`Decrease ${label}`}
      disabled={value <= min}
      onClick={() => onChange(clamp(value - 1))}
      className={button}
    >
      <Minus className={icon} aria-hidden="true" />
    </button>
  );

  const increase = (
    <button
      type="button"
      aria-label={`Increase ${label}`}
      disabled={value >= max}
      onClick={() => onChange(clamp(value + 1))}
      className={button}
    >
      <Plus className={icon} aria-hidden="true" />
    </button>
  );

  const number = (
    <motion.input
      animate={tick}
      transition={TRANSITION.fast}
      type="number"
      inputMode="numeric"
      aria-label={label}
      value={draft ?? value}
      min={min}
      max={max}
      onChange={(e) => {
        const raw = e.target.value;
        const typed = Number.parseInt(raw, 10);
        // An empty box is a box being typed in, not a zero: it is kept as typed and
        // reported to nobody, so the value behind it is still the last real number.
        if (Number.isNaN(typed)) {
          setDraft(raw);
          return;
        }
        const next = clamp(typed);
        // Out of range is shown *clamped* rather than left as typed — a box reading 99
        // over a ceiling of 3 is a promise the control has already broken.
        setDraft(next === typed ? raw : null);
        onChange(next);
      }}
      // Whatever was left half-typed, the box goes back to the number it stands for.
      onBlur={() => setDraft(null)}
      className={cn(
        "rounded-md border border-border bg-surface text-center font-mono tabular-nums",
        NO_NATIVE_STEPS,
        ring,
        field,
      )}
    />
  );

  // Increase first when the column stands on end, because up is more. Horizontally the
  // number keeps the middle, where `−` and `+` bracket it the way every stepper does.
  return (
    <span className={cn("inline-flex items-center gap-1", vertical && "flex-col")}>
      {vertical ? (
        <>
          {increase}
          {number}
          {decrease}
        </>
      ) : (
        <>
          {decrease}
          {number}
          {increase}
        </>
      )}
    </span>
  );
}
