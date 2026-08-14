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
  "transition-[color,background-color,border-color,opacity,transform,scale] " +
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

/**
 * The mana-value chips. The last one is open-ended — `8` means "8 or more".
 *
 * **`X` is deliberately not in here.** It is not a mana value, and a sentinel number for it
 * would be a lie this list then spreads to Rust's filter, to the fake and to the facet map,
 * each of which would have to be told which number is not a number. It is a second axis over
 * the same question instead — see {@link ManaValueChips}.
 */
export const MANA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * What the X chip is called, spelled once.
 *
 * A chip reading `X` beside one reading `8 or more` is a puzzle to anyone who cannot see the
 * group it sits in, so the name says the whole thing while the chip draws the one letter that
 * is printed on the cards. The visible text is inside the name (WCAG 2.5.3), which is what
 * keeps the chip addressable by what is written on it.
 */
const MANA_X_LABEL = "Cards with X in their mana cost";

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
        "transition-[opacity,box-shadow,transform,scale] duration-[var(--duration-fast)] ease-standard",
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
 * One chip of the mana-value group — a numeral, `8+`, or `X`.
 *
 * Internal, and shared by both halves of {@link ManaValueChips} deliberately: X has to be
 * *the same chip* as its neighbours rather than one that resembles them, or the row grows a
 * second focus outline and a second greying treatment the first time either is touched. It
 * takes a finished `name` because the two halves spell their labels differently and neither
 * spelling belongs to a chip.
 */
function ValueChip({
  text,
  name,
  pressed,
  disabled,
  onToggle,
}: {
  /** What is written on the chip — `3`, `8+`, `X`. */
  text: string;
  /** The tooltip and the accessible name together, already composed by the caller. */
  name: string;
  pressed: boolean;
  /** Drawn dim and unpressable, without leaving the tab order — see {@link ManaChip}. */
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onToggle();
      }}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-label={name}
      title={name}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "size-9 font-mono text-xs tabular-nums",
        filterChipState(pressed, disabled),
      )}
    >
      {text}
    </button>
  );
}

/**
 * The mana-value row, 0 through 8-or-more, and then X. Mono, because a cost is data.
 *
 * The two facet props are **per value**, because this one component draws all nine numerals:
 * a plain `disabled` boolean there could only grey the row. `title` is handed the chip's own
 * accessible label as well as its value, so a caller composing a count onto it cannot drift
 * from what the chip actually says — "8 or more" is spelled here and nowhere else.
 *
 * **X is a second axis over the same question and takes its own four props**, because it is
 * not a mana value: Scryfall's `cmc` counts `{X}` as zero, so `{X}{B}{B}{B}` is a **3** *and*
 * an X, and the chips are OR'd exactly as 0–8 already are — a reader who picks both finds it
 * once. It rides at the end of this group rather than beside it because it answers the same
 * question the group asks; a chip on its own would read as a stray control.
 *
 * `xTitle` takes the label rather than a finished string for the reason `title` does: the
 * sentence a greyed chip carries has to be one sentence in one voice across the whole row,
 * and a caller composing a count onto a label it wrote itself is a caller that can drift from
 * what the chip says.
 */
export function ManaValueChips({
  selected,
  onToggle,
  disabled,
  title,
  xSelected = false,
  onToggleX,
  xDisabled = false,
  xTitle,
}: {
  selected: readonly number[];
  onToggle: (value: number) => void;
  /** Whether one chip is out of reach. `aria-disabled`, never `disabled` — see {@link ManaChip}. */
  disabled?: (value: number) => boolean;
  /** One chip's tooltip and accessible name, given its value and the label it would carry. */
  title?: (value: number, label: string) => string | undefined;
  /** Whether the X chip is on. Independent of {@link selected}: both can be. */
  xSelected?: boolean;
  /**
   * One press on the X chip — **and what decides the chip is drawn at all.**
   *
   * A chip with nothing to report is worse than a filter a row does not offer, so the two
   * cannot come apart: there is no state where X is drawn and dead. Both filter rows wire it,
   * so both draw it; a caller that leaves it off gets exactly the nine chips this group drew
   * before X existed.
   */
  onToggleX?: () => void;
  /** Whether X is out of reach. A plain boolean, unlike its per-value neighbour: one chip. */
  xDisabled?: boolean;
  /** X's tooltip and accessible name, given the label it would carry. */
  xTitle?: (label: string) => string | undefined;
}) {
  return (
    // **`flex-wrap`, and it is load-bearing in exactly one place.** This row is ten `size-9`
    // chips with `gap-1` between them — 10 × 36 + 9 × 4 = **396px**, measured — and the widest
    // surface that draws it is not a filter bar across the window but the deck editor's **docked
    // search panel, 384px** (`PANEL_WIDTH_PX`), whose content box is ~371. Unwrapped, the group is
    // a flex item that cannot shrink below its own min-content, so it hung **25px** out of the
    // panel; the editor is `overflow-y-auto`, which computes `overflow-x` to `auto`, so those 25px
    // became a horizontal scrollbar across the whole deck builder — at every window width, since
    // the panel's width never changes. Measured in the shipped window 2026-08-14: editor
    // `scrollWidth` 1042 against `clientWidth` 1017 at 1280×800, and 2322 against 2297 at
    // 2560×1400. **The X chip is what tipped it**: nine numerals came to 356 and fitted.
    // Wrapping makes the group's min-content one chip, so it shrinks and breaks onto a second
    // line in the panel and is unchanged in the two full-width filter bars, where it already fitted.
    <div role="group" aria-label="Mana value" className="flex flex-wrap gap-1">
      {MANA_VALUES.map((value) => {
        // The last chip is open-ended: past Emrakul the tail is a handful of cards
        // nobody filters by exact cost, and the backend reads it the same way.
        const open = value === MANA_VALUES[MANA_VALUES.length - 1];
        const label = open ? `Mana value ${value} or more` : `Mana value ${value}`;
        return (
          <ValueChip
            key={value}
            text={open ? `${value}+` : String(value)}
            name={title?.(value, label) ?? label}
            pressed={selected.includes(value)}
            disabled={disabled?.(value) ?? false}
            onToggle={() => onToggle(value)}
          />
        );
      })}
      {onToggleX && (
        <ValueChip
          text="X"
          name={xTitle?.(MANA_X_LABEL) ?? MANA_X_LABEL}
          pressed={xSelected}
          disabled={xDisabled}
          onToggle={onToggleX}
        />
      )}
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
 * **Always drawn, and greyed at zero.** It used to return `null` with nothing to clear, on the
 * theory that a control spending most of its life dimmed teaches the reader to stop looking at
 * it. That is true and it is the smaller cost: the search box these rows open with is `flex-1`,
 * so a button appearing mid-row takes its whole width out of the box and *every control to the
 * right of it slides left* — the colour chips, the mana values, the set picker. The reader
 * presses a colour, the row shifts under the cursor, and the second press lands on a chip they
 * did not aim at. A filter row that moves while it is being used is the worse control, so the
 * width is spent up front and the button is dead rather than gone.
 *
 * `aria-disabled` and never `disabled`, like every other out-of-reach control here — the button
 * keeps its place in the tab order — and the greying is `FILTER_UNAVAILABLE`, so "cannot be
 * pressed" arrives in one treatment across the whole row rather than two.
 *
 * **The badge is `aria-hidden` and the count is spelled into the button's own name instead.**
 * Left to itself the accname algorithm puts no separator between inline boxes, so this button
 * announced as `"Reset all6"` (measured 2026-08-09 with `computeAccessibleName` from
 * `dom-accessibility-api`). That was a small defect while the button only existed with a filter
 * on; drawn always, it would be `"Reset all0"` on every quiet row in the app. The visible label
 * still leads the name (WCAG 2.5.3) and the digit is still in it.
 *
 * The rule lives here so that every view that offers a reset offers the same one.
 */
export function ResetAll({ count, onReset }: { count: number; onReset: () => void }) {
  const empty = count <= 0;
  const name = `Reset all — ${count} filter${count === 1 ? "" : "s"} active`;
  return (
    <button
      type="button"
      onClick={() => {
        if (!empty) onReset();
      }}
      aria-disabled={empty || undefined}
      aria-label={name}
      title={name}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "inline-flex items-center gap-2 border-border px-2.5 text-dim",
        empty ? FILTER_UNAVAILABLE : "hover:text-text",
      )}
    >
      Reset all
      <span
        aria-hidden="true"
        className="rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground"
      >
        {count}
      </span>
    </button>
  );
}
