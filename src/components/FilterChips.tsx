import { LayoutGrid, Rows3 } from "lucide-react";
import { MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import type { SearchView } from "@/lib/store";
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

/**
 * Every control in the row is 36px tall, so the chips and the text controls share a line.
 *
 * **One arbitrary property list, and never a colour utility beside a transform one.** Those two
 * compile to the same CSS longhand, so tailwind-merge keeps whichever it saw last and drops the
 * other — and the one it drops is invisible until someone presses a chip and the scale snaps.
 * The list is spelled out for that reason and is the same string every pressable control in the
 * app carries.
 *
 * (Spelled as a description rather than by naming the two utilities, because `tokens.test.ts`
 * reads a class name in prose exactly as it reads one in code and would ask this paragraph for
 * a reduced-motion opt-out of its own.)
 *
 * `active:scale-[0.97]` is undone for a control that is out of reach: the filter row greys as
 * the reader types, and a chip that dips under the finger and then does nothing tells the same
 * lie {@link filterChipState}'s dropped hover response already refuses to tell. `aria-disabled`
 * rather than `:disabled`, because these chips never leave the tab order.
 */
export const FILTER_CONTROL =
  "h-9 rounded-md border text-sm " +
  "transition-[color,background-color,border-color,opacity,transform] " +
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.97] " +
  "aria-disabled:active:scale-100 motion-reduce:transition-none";

/**
 * A control this search cannot reach.
 *
 * One string for the whole filter row, shared with `SetCombobox`'s capped rows, because
 * "unavailable" arriving in two different treatments is two different words for one thing.
 * Never `disabled`: see {@link ManaChip}.
 */
export const FILTER_UNAVAILABLE = "cursor-not-allowed opacity-45";

/**
 * On, off, and out of reach — for a control whose state is told apart by its border.
 *
 * Gold border and gold text for on; a hairline and dim text for off, brightening on hover
 * so the row answers a mouse. Not a fill: the direction's colour budget is spent on the
 * mana chips and the card art, and a row of filled gold chips would out-shout both.
 *
 * `unavailable` dims whichever of those two it is and **drops the hover response**, because
 * a control that brightens under the mouse and then ignores the press is a control that
 * lies. It does not clear the on state: a selected option is never greyed (see
 * `features/search/facets.ts`), so the two do not co-occur, and if they ever did the honest
 * drawing is "on, and out of reach" rather than one of the two silently winning.
 *
 * Exported because the layout toggle that rides the same row is not a filter and wears the
 * same clothes — one hand-copied pair of class lists is how two rows start to differ.
 */
export function filterChipState(pressed: boolean, unavailable = false): string {
  const on = pressed ? "border-accent text-accent" : "border-border text-dim";
  if (unavailable) return cn(on, FILTER_UNAVAILABLE);
  return pressed ? on : cn(on, "hover:text-text");
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
 *
 * **`disabled` is `aria-disabled` and never the attribute.** A `disabled` button leaves the
 * tab order, and a filter row that greys as the reader types would shrink and grow under a
 * keyboard reader's caret. The chip stays focusable, keeps saying whether it is pressed, and
 * ignores the press.
 */
export function ManaChip({
  symbol,
  pressed,
  onClick,
  disabled = false,
  title,
}: {
  symbol: ManaKey;
  pressed: boolean;
  onClick: () => void;
  /** Drawn dim and unpressable, without leaving the tab order. */
  disabled?: boolean;
  /**
   * The tooltip, **and the accessible name with it** — a `title` that disagrees with the
   * name is announced as a second, competing sentence. Defaults to the colour's name, and
   * a caller adding a count to it has to keep that name at the front (WCAG 2.5.3).
   */
  title?: string;
}) {
  const name = title ?? MANA_LABEL[symbol];
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onClick();
      }}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-label={name}
      title={name}
      style={{ backgroundColor: `var(--color-mana-${symbol.toLowerCase()})` }}
      className={cn(
        "grid size-9 place-items-center rounded-full text-lg leading-none text-black",
        // Its own property list rather than `FILTER_CONTROL`'s, because this chip's on state
        // is a ring and a ring is a box shadow — but `transform` joins it so the colour chips
        // depress like every other chip in the row, and a row where half the chips answer a
        // press is worse than one where none of them do.
        "transition-[opacity,box-shadow,transform] duration-[var(--duration-fast)] ease-standard",
        "active:scale-[0.97] aria-disabled:active:scale-100 motion-reduce:transition-none",
        // Clear of the pressed ring, so a focused chip that is already on shows both.
        "focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-accent",
        // 60%, not 40: below about half, the fills stop being cream/sky/bone/salmon/sage
        // and become six shades of the same brown, which is the moment the row goes back
        // to being letters in circles. The gold ring is what says "on"; the dimming only
        // has to say "and these are not".
        pressed && "opacity-100 ring-2 ring-accent ring-offset-2 ring-offset-bg",
        !pressed && !disabled && "opacity-60 hover:opacity-85",
        // Last, so tailwind-merge resolves the opacity in its favour: a chip that is somehow
        // both on and out of reach keeps its ring and takes the dimming.
        disabled && FILTER_UNAVAILABLE,
      )}
    >
      {/* The glyph itself comes from the bundled `mana-font`; the fill is ours, because
          the font's own `--ms-mana-*` values are a shade off the direction doc's. */}
      <i className={manaSymbolClass(symbol)} aria-hidden="true" />
    </button>
  );
}

/**
 * The mana-value row, 0 through 8-or-more. Mono numerals, because a cost is data.
 *
 * The two facet props are **per value**, because this one component draws nine chips: a
 * plain `disabled` boolean here could only grey the row. `title` is handed the chip's own
 * accessible label as well as its value, so a caller composing a count onto it cannot drift
 * from what the chip actually says — "8 or more" is spelled here and nowhere else.
 */
export function ManaValueChips({
  selected,
  onToggle,
  disabled,
  title,
}: {
  selected: readonly number[];
  onToggle: (value: number) => void;
  /** Whether one chip is out of reach. `aria-disabled`, never `disabled` — see {@link ManaChip}. */
  disabled?: (value: number) => boolean;
  /** One chip's tooltip and accessible name, given its value and the label it would carry. */
  title?: (value: number, label: string) => string | undefined;
}) {
  return (
    <div role="group" aria-label="Mana value" className="flex gap-1">
      {MANA_VALUES.map((value) => {
        // The last chip is open-ended: past Emrakul the tail is a handful of cards
        // nobody filters by exact cost, and the backend reads it the same way.
        const open = value === MANA_VALUES[MANA_VALUES.length - 1];
        const on = selected.includes(value);
        const off = disabled?.(value) ?? false;
        const label = open ? `Mana value ${value} or more` : `Mana value ${value}`;
        const name = title?.(value, label) ?? label;
        return (
          <button
            key={value}
            type="button"
            onClick={() => {
              if (!off) onToggle(value);
            }}
            aria-pressed={on}
            aria-disabled={off || undefined}
            aria-label={name}
            title={name}
            className={cn(
              FILTER_CONTROL,
              FILTER_FOCUS,
              "size-9 font-mono text-xs tabular-nums",
              filterChipState(on, off),
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
 *
 * `hint` is the exception that keeps that true where the word will not fit: the five
 * condition grades are printed on every marketplace listing as `NM`/`LP`/`MP`/`HP`/`DMG`,
 * and five spelled-out grades are 400px of chrome above the table they filter. The
 * abbreviation is drawn, the grade is spoken, and the accessible name *begins* with the
 * visible text so the chip is still addressable by what is written on it (WCAG 2.5.3).
 */
export function ToggleChip({
  label,
  pressed,
  onClick,
  hint,
  title,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  /** What the label is short for. Becomes the tooltip, and joins the accessible name. */
  hint?: string;
  /**
   * The tooltip and the accessible name together, replacing both of `hint`'s contributions.
   * The two never co-occur today — `hint` expands an abbreviation on the collection's
   * condition chips, this carries a facet count on the search's Owned chip — and if they
   * ever do, the sentence built for this chip wins over the one built for its label.
   *
   * **No `disabled` here, deliberately.** The one faceted chip of this kind is Owned, which
   * is never greyed: it is a single button cycling off → owned → missing → off, and greying
   * it would strand whoever is mid-cycle. A prop no caller may ever set is one more state to
   * reason about and no behaviour at all.
   */
  title?: string;
}) {
  const name = title ?? (hint ? `${label}, ${hint}` : undefined);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={title ?? hint}
      aria-label={name}
      className={cn(FILTER_CONTROL, FILTER_FOCUS, "px-3", filterChipState(pressed))}
    >
      {label}
    </button>
  );
}

/** The two layouts, and the words for them a reader would use. */
const LAYOUTS = [
  { id: "grid", label: "Card view", Icon: LayoutGrid },
  { id: "table", label: "Table view", Icon: Rows3 },
] as const satisfies readonly { id: SearchView; label: string; Icon: typeof LayoutGrid }[];

/**
 * How a list of cards is drawn — art, or a table.
 *
 * Not a filter, and it rides the filter row anyway: it is the only other control that
 * governs the list below, and a second row holding one pair of buttons would be a whole
 * band of chrome above the art. `ml-auto` sends it to the far end so the filters still read
 * as a group without it, and the pair is icon-only because two 36px squares carry "grid or
 * rows" at a glance in a way two words on a busy row do not.
 *
 * Takes its state rather than reading the store, because the two views that offer it are
 * laid out independently: the search opens on art, the collection on the table (a
 * collection is read for what is *in* it, and forty tiles answer none of that).
 */
export function LayoutToggle({
  view,
  onChange,
}: {
  view: SearchView;
  onChange: (view: SearchView) => void;
}) {
  return (
    <div role="group" aria-label="Result layout" className="ml-auto flex gap-1">
      {LAYOUTS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={view === id}
          aria-label={label}
          title={label}
          className={cn(FILTER_CONTROL, FILTER_FOCUS, "size-9", filterChipState(view === id))}
        >
          <Icon className="mx-auto size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
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
