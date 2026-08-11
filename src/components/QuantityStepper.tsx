import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Keyboard focus, in the shape the rest of the app uses: an outline standing off the
 * control's edge, never a ring (see `FilterChips`' `FILTER_FOCUS` — outline is focus,
 * border and ring are state).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The same outline, drawn **inside** the control's own edge.
 *
 * For a stepper sitting in a box that clips — a deck card's frame, a grid tile — where an
 * outline standing 2px *off* the control is painted entirely in the clipped region and is
 * never seen at all. That is not a smaller ring, it is no focus indicator, WCAG 2.4.7, and it
 * is invisible to anyone testing with a mouse. `cardControl.tsx`'s `FOCUS_INSET` is the same
 * string for the same reason one floor up; this copy exists because this component is
 * `components/` and may not import a feature's.
 */
const FOCUS_INSET =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

const BUTTON =
  "grid place-items-center rounded-md border border-border text-dim transition-colors " +
  "duration-150 hover:text-text disabled:opacity-40 disabled:hover:text-dim " +
  "motion-reduce:transition-none";

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
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** The accessible name of the number itself — "Quantity of Lightning Bolt", not "Quantity". */
  label: string;
  /** `xs` is the deck's: a stepper that has to sit inside a card frame, a 150px grid tile or a
   *  22px text row, where `sm`'s 28px does not fit. */
  size?: "xs" | "sm" | "md";
  /** Which side of the control's own edge the focus outline is drawn on. `inset` for a stepper
   *  inside a box that clips — see {@link FOCUS_INSET}. */
  focus?: "outside" | "inset";
}) {
  const box = size === "xs" ? "size-5" : size === "sm" ? "size-7" : "size-9";
  const field =
    size === "xs"
      ? "h-5 w-8 text-[0.625rem]"
      : size === "sm"
        ? "h-7 w-12 text-xs"
        : "h-9 w-14 text-sm";
  const icon = size === "xs" ? "size-3" : "size-3.5";
  const ring = focus === "inset" ? FOCUS_INSET : FOCUS;
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

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
        className={cn(BUTTON, ring, box)}
      >
        <Minus className={icon} aria-hidden="true" />
      </button>
      <input
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
          ring,
          field,
        )}
      />
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
        className={cn(BUTTON, ring, box)}
      >
        <Plus className={icon} aria-hidden="true" />
      </button>
    </span>
  );
}
