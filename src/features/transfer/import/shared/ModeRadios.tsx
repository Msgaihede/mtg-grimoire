/**
 * A destination's mode choice, drawn as a labelled radio group — the collection's `add`/`set`
 * and the wishlist's own pair.
 *
 * **Not the deck's.** `DeckPreview.tsx`'s `Mode` fieldset draws `merge`/`replace`, and its
 * `replace` label is computed from the variant on screen and a live copy count
 * (`Replace — removes the 3 cards in Theory first`) — a sentence `ImportModeOption.hint` cannot
 * hold, because it is fixed at the moment the array is written rather than read off a query.
 * `ImportModeOption` was carried out of Task 12's review as a shape nothing used yet; this is
 * what satisfies it, for the two destinations whose mode really is two static words and a static
 * sentence under them.
 */
import { useId, type JSX } from "react";
import type { ImportModeOption } from "../destination";

export function ModeRadios({
  modes,
  value,
  onChange,
  label,
}: {
  modes: readonly ImportModeOption[];
  value: string;
  onChange: (key: string) => void;
  label: string;
}): JSX.Element {
  const name = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-xs text-dim">{label}</legend>
      {modes.map((mode) => (
        <label key={mode.key} className="flex flex-col gap-0.5">
          <span className="flex items-baseline gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={mode.key}
              checked={value === mode.key}
              onChange={() => onChange(mode.key)}
              className="accent-accent"
            />
            {mode.label}
          </span>
          <span className="ml-5 text-[0.6875rem] text-dim">{mode.hint}</span>
        </label>
      ))}
    </fieldset>
  );
}
