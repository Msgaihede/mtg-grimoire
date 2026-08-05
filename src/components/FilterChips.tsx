import { MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import { cn } from "@/lib/utils";

/**
 * The controls a filter row is built from, so that the collection's row is the *same* row
 * as the search's rather than a lookalike.
 *
 * Extracted from `FilterBar` unchanged when the second view needed it. The three exported
 * class recipes are the whole of what keeps them one family: a chip that invents its own
 * height sits 2px off the line, and one that invents its own focus style is the only
 * control on the screen a keyboard reader loses.
 */

/**
 * Keyboard focus, everywhere in the row.
 *
 * Gold says "interactive emphasis" for both focus and on, so the two are told apart by
 * *shape* rather than by hue: focus is always an `outline`, standing off the control's
 * edge; on is always the control's own border or a ring hugging it. A chip that is both
 * shows both, which is the one case where either alone would be a lie.
 */
export const FILTER_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Every control in the row is 36px tall, so the chips and the text controls share a line. */
export const FILTER_CONTROL =
  "h-9 rounded-md border text-sm transition-colors duration-150 motion-reduce:transition-none";

/**
 * On and off, for a control whose two states are told apart by its border.
 *
 * Gold border and gold text for on; a hairline and dim text for off, brightening on hover
 * so the row answers a mouse. Not a fill: the direction's colour budget is spent on the
 * mana chips and the card art, and a row of filled gold chips would out-shout both.
 *
 * Exported because the layout toggle that rides the same row is not a filter and wears the
 * same clothes — one hand-copied pair of class lists is how two rows start to differ.
 */
export function filterChipState(pressed: boolean): string {
  return pressed ? "border-accent text-accent" : "border-border text-dim hover:text-text";
}

/** The mana-value chips. The last one is open-ended — `8` means "8 or more". */
export const MANA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * One colour chip: the printed symbol, on the printed fill.
 *
 * Pressed is the card's own colour at full strength with a gold ring; unpressed is the
 * same chip dimmed rather than a different chip, so the row reads as one control with
 * some of it switched on — and so a colourblind reader has the symbol's *shape*, which is
 * what Wizards designed it to carry, and not only the hue.
 */
export function ManaChip({
  symbol,
  pressed,
  onClick,
}: {
  symbol: ManaKey;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={MANA_LABEL[symbol]}
      title={MANA_LABEL[symbol]}
      style={{ backgroundColor: `var(--color-mana-${symbol.toLowerCase()})` }}
      className={cn(
        "grid size-9 place-items-center rounded-full text-lg leading-none text-black",
        "transition-[opacity,box-shadow] duration-150 motion-reduce:transition-none",
        // Clear of the pressed ring, so a focused chip that is already on shows both.
        "focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-accent",
        // 60%, not 40: below about half, the fills stop being cream/sky/bone/salmon/sage
        // and become six shades of the same brown, which is the moment the row goes back
        // to being letters in circles. The gold ring is what says "on"; the dimming only
        // has to say "and these are not".
        pressed
          ? "opacity-100 ring-2 ring-accent ring-offset-2 ring-offset-bg"
          : "opacity-60 hover:opacity-85",
      )}
    >
      {/* The glyph itself comes from the bundled `mana-font`; the fill is ours, because
          the font's own `--ms-mana-*` values are a shade off the direction doc's. */}
      <i className={manaSymbolClass(symbol)} aria-hidden="true" />
    </button>
  );
}

/** The mana-value row, 0 through 8-or-more. Mono numerals, because a cost is data. */
export function ManaValueChips({
  selected,
  onToggle,
}: {
  selected: readonly number[];
  onToggle: (value: number) => void;
}) {
  return (
    <div role="group" aria-label="Mana value" className="flex gap-1">
      {MANA_VALUES.map((value) => {
        // The last chip is open-ended: past Emrakul the tail is a handful of cards
        // nobody filters by exact cost, and the backend reads it the same way.
        const open = value === MANA_VALUES[MANA_VALUES.length - 1];
        const on = selected.includes(value);
        return (
          <button
            key={value}
            type="button"
            onClick={() => onToggle(value)}
            aria-pressed={on}
            aria-label={open ? `Mana value ${value} or more` : `Mana value ${value}`}
            className={cn(
              FILTER_CONTROL,
              FILTER_FOCUS,
              "size-9 font-mono text-xs tabular-nums",
              filterChipState(on),
            )}
          >
            {open ? `${value}+` : value}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A filter that is either on or off, said in a word.
 *
 * The plain member of the family — "Owned", a finish, a condition grade. It carries its
 * label rather than a symbol because these are app vocabulary rather than Magic's, and a
 * letter in a circle for "Lightly played" would be a puzzle.
 */
export function ToggleChip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(FILTER_CONTROL, FILTER_FOCUS, "px-3", filterChipState(pressed))}
    >
      {label}
    </button>
  );
}

/**
 * Clear every filter at once, with the number of them on it.
 *
 * Absent rather than disabled when there is nothing to clear: a control that spends most
 * of its life greyed out teaches the reader to stop looking at it. The rule lives here so
 * that every view that offers a reset offers the same one.
 */
export function ResetAll({ count, onReset }: { count: number; onReset: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "inline-flex items-center gap-2 border-border px-2.5 text-dim hover:text-text",
      )}
    >
      Reset all
      <span className="rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground">
        {count}
      </span>
    </button>
  );
}
