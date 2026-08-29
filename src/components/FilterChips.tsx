import { LayoutGrid, Rows3, SlidersHorizontal, X } from "lucide-react";
import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import { PRESS, PRESS_STILL } from "@/lib/motion";
import type { SearchView } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The controls a filter row is built from, so that the collection's row is the *same* row
 * as the search's rather than a lookalike.
 *
 * Extracted from `FilterBar` unchanged when the second view needed it. The exported class
 * recipes are the whole of what keeps them one family: a chip that invents its own
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
 *
 * It **is** the app's {@link FOCUS} rather than a lookalike — it was written out here and was
 * byte-identical to it, so this is the name kept and the string deduplicated (2026-08-16).
 * The row's own exception is {@link ManaChip}'s `outline-offset-[5px]`, which is a variant
 * with a reason of its own and stays written out.
 */
export const FILTER_FOCUS = FOCUS;

/**
 * The row's geometry alone, with nothing that moves — 36px tall, so every control in the row
 * shares a line whether or not it is a thing you press.
 *
 * Module-private and written out whole: it is the half {@link FILTER_CONTROL} and
 * {@link FILTER_FIELD} have in common, and a chip 2px off the line is the failure the family
 * exists to prevent. Tailwind reads source text, so the four names live here once and both
 * recipes are built from this.
 *
 * **36px for a pointer, 44 for a finger** — the first consumer of the `coarse:` variant and
 * `--target-min`, both of which shipped in PR #274 declared and deliberately unapplied so this
 * decision could take them. WCAG 2.5.5 (AAA) asks 44×44 CSS px and 2.5.8 (AA) asks 24×24; this
 * row clears AA everywhere and clears neither floor *for a finger*, because both floors below 44
 * are floors for a pointer and a phone has none. The 36 stays where there is a pointer: a
 * desktop row that grew for touch would be 44px of chrome above every list in the app.
 *
 * **`min-h`, not `h`, and that is what makes the variant order stop mattering.** 9a's finding
 * was that a `coarse:` *size* has no specificity answer against the container-query size the
 * filter bar already writes — each is one class inside one at-rule, so source order in the
 * emitted sheet decides and the spelling is a coin toss. (Neither class is named here in full:
 * Tailwind scans prose as eagerly as code, and a rule this file does not use is a rule in the
 * sheet nothing asks for. It emitted one before this sentence was rewritten.) A *minimum* is
 * not in that contest at all: `min-height` beats `height` in the cascade whatever order they are
 * emitted in, so this floor holds against `FILTER_CONTROL`'s own `h-9`, against
 * `TagQueryRow`'s `h-7` and against the `size-8` the filter bar hands the mana-value group in
 * its narrowest column, without any of them having to know it exists.
 *
 * A square chip needs the other axis said too — `min-h` alone leaves a 36px-wide button 44 tall
 * — so {@link ManaChip}, {@link ValueChip} and {@link LayoutToggle} each add
 * `coarse:min-w-[var(--target-min)]` at their own site. Everything else in the family is
 * captioned and is already wider than 44.
 */
const FILTER_SHAPE = "h-9 coarse:min-h-[var(--target-min)] rounded-md border text-sm";

/**
 * Every control in the row is 36px tall, so the chips and the text controls share a line —
 * **and the press is {@link PRESS}, the app's one recipe, rather than a copy of it.**
 *
 * A composition and not a re-point: `h-9 rounded-md border text-sm` is this row's own, and
 * the press is what it has in common with every other pressable control in the app. The
 * argument for writing the property list out one longhand at a time now lives on that
 * constant.
 *
 * `active:scale-[0.97]` is undone for a control that is out of reach: the filter row greys as
 * the reader types, and a chip that dips under the finger and then does nothing tells the same
 * lie {@link filterChipState}'s dropped hover response already refuses to tell. `aria-disabled`
 * rather than `:disabled`, because these chips never leave the tab order — which is why the
 * out-of-reach clause is the caller's and is deliberately not in `PRESS`.
 */
export const FILTER_CONTROL = `${FILTER_SHAPE} ` + `${PRESS} ` + "aria-disabled:active:scale-100";

/**
 * The same control, for the box the reader **types into** — every class {@link FILTER_CONTROL}
 * wears except the press dip.
 *
 * **The dip is not cosmetic on a text field; it breaks the clear button** (issue #179).
 * Chromium draws the `✕` of an `<input type="search">` inside the field's own shadow tree, and
 * a `scale` pivots on the field's **centre** — so for as long as the button is held down the
 * whole box, and that button with it, slides left by `width × (1/0.97 − 1) / 2`. A `click` is
 * dispatched to the common ancestor of the press target and the release target, so once the
 * button has travelled out from under the pointer the click lands on the *field*, Blink's
 * cancel-button handler never runs, and the box dips without clearing. What a reader reports is
 * exactly that: "the text box bounces, but its contents are not cleared".
 *
 * **It is a width bug, which is why it read as one box working and the rest not.** Swept a
 * pixel at a time in Chromium 2026-08-21 against a 10px-wide cancel button: at `w-44` (176px)
 * the press still lands over 8 of those pixels, at `w-64` (256px) over 7, and at 700px over
 * **none at all** — measured against the shipped `dist/` CSS, a 700px box's right edge travels
 * **10.5px** while it is held down, which is further than the button is wide. The filter row's
 * boxes are `min-w-56 flex-1` — they take whatever the row leaves, which on a maximised window
 * is most of it — so the one search box in the app that always worked was `DeckEditor`'s 176px
 * "Filter this deck", which had never taken `FILTER_CONTROL` in the first place.
 *
 * The rule is {@link press}'s, one gesture along: that preset carries no `whileFocus` because
 * "scaling on focus moves a control out from under a caret the reader just put there", and
 * scaling on *press* moves it out from under the pointer pressing it. `TitleBar`'s caption
 * buttons leave the dip off for a third version of the same sentence.
 *
 * `motion.test.ts` sweeps `src/` for a text-entry `<input>` that took the dip back.
 */
export const FILTER_FIELD = `${FILTER_SHAPE} ` + PRESS_STILL;

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
  const tip = useTooltip();
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
      // `describes: false`: `name` is this button's own `aria-label` above, so a wired
      // `aria-describedby` would have a screen reader hear it twice.
      {...tip(name, { describes: false })}
      style={{ backgroundColor: `var(--color-mana-${symbol.toLowerCase()})` }}
      className={cn(
        "grid size-9 place-items-center rounded-full text-lg leading-none text-black",
        // 44×44 for a finger. This chip writes its own property list rather than taking
        // `FILTER_SHAPE`, so it says the floor itself — both axes, because it is a circle and
        // a height alone would make it an ellipse. See `FILTER_SHAPE` for why it is a
        // *minimum* rather than a size: a minimum is not in the specificity contest that made
        // 9a call a conditional `coarse:` spelling a coin toss.
        "coarse:min-h-[var(--target-min)] coarse:min-w-[var(--target-min)]",
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
  chipClass,
  onToggle,
}: {
  /** What is written on the chip — `3`, `8+`, `X`. */
  text: string;
  /** The tooltip and the accessible name together, already composed by the caller. */
  name: string;
  pressed: boolean;
  /** Drawn dim and unpressable, without leaving the tab order — see {@link ManaChip}. */
  disabled: boolean;
  /** The caller's own classes — see {@link ManaValueChips}, which is where they come from. */
  chipClass: string | undefined;
  onToggle: () => void;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onToggle();
      }}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-label={name}
      // `describes: false`: identical to the `aria-label` above, so a wired `aria-describedby`
      // would repeat it.
      {...tip(name, { describes: false })}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "size-9 font-mono text-xs tabular-nums",
        // The other axis of `FILTER_SHAPE`'s floor: this chip is a square, and a height alone
        // would leave it 36 wide and 44 tall for a finger. **It costs the group no extra line.**
        // Ten chips at `gap-1` in a 350px content box (390px window less `main`'s `p-5`) wrap to
        // two rows either way: at the filter bar's narrow `size-8` nine fit on the first row
        // (9 × 32 + 8 × 4 = 320) and the tenth drops, and at 44 seven fit (7 × 44 + 6 × 4 = 332)
        // and three drop. The `flex-wrap` the group already carries — put there when the X chip
        // made ten chips 396px against the docked panel's ~371 — is what makes that free.
        "coarse:min-w-[var(--target-min)]",
        filterChipState(pressed, disabled),
        // Last, so tailwind-merge resolves a size clash in the caller's favour — which is the
        // whole of what this prop is for. It must not be spent on the state classes above it: a
        // caller quietly winning *that* argument is a chip that stops saying whether it is on.
        chipClass,
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
  chipClass,
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
  /**
   * Extra classes for **every chip in the group**, the ten counted alike.
   *
   * It exists for one caller and one measurement: the filter bar draws these at **32px** in its
   * narrowest column and at the family's 36 everywhere else. Ten chips at `gap-1` are
   * `10 × 36 + 9 × 4` = **396px**; at 32 they are **356**, which is what the group measured before
   * the X chip existed and what fits the deck panel's 384px default (~371 of content). The row's
   * own `flex-wrap` is still what keeps it safe below that — the panel is draggable down to 206 —
   * so this is a *fit*, never a fence.
   *
   * **A class and not a `dense` boolean**, because the width that decides it is a *container*
   * width: the same bar is a maximised window's and a 384px panel's, so the answer is a container
   * query the caller writes (`size-8 @min-[640px]/fb:size-9`) and not a prop this component could
   * be handed. A boolean would need a `ResizeObserver` above it to know which value to pass.
   *
   * Merged last, so a size clash resolves the caller's way; it may not reach the state classes —
   * see {@link ValueChip}.
   */
  chipClass?: string;
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
            chipClass={chipClass}
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
          chipClass={chipClass}
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
  disabled,
  className,
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
   * `disabled` is one prop down, and it exists now — see it for why, and for what this note
   * used to say instead.
   */
  title?: string;
  /**
   * Out of reach: a chip whose option would leave nothing.
   *
   * **This used to be documented as a prop deliberately absent**, and the argument was sound
   * for as long as its premise held: the only faceted chip of this kind was Owned, which is a
   * single button cycling off → owned → missing → off, so greying it would strand whoever was
   * mid-cycle — and a prop no caller may ever set is one more state to reason about and no
   * behaviour at all. The printings modal's treatment chips are the second caller and they are
   * not a cycle: each is one independent option over one card's printings, and a card with no
   * showcase printing has a Showcase chip that can only ever answer with an empty wall.
   *
   * **Greyed and present rather than dropped**, which is `features/search/facets.ts`' rule and
   * its reason: an option that vanishes reads as a control that broke, where a greyed one reads
   * as a fact about the card in front of you. It also keeps the row a fixed shape, so it does
   * not reflow under the reader as they narrow.
   *
   * Three things together, because any one alone is a control that lies. `aria-disabled` rather
   * than `disabled`, so the chip keeps its tab stop and a reader sweeping the row still hears
   * the option and its count; the press refused here rather than only at the call site, so the
   * attribute cannot drift from the behaviour; and {@link FILTER_UNAVAILABLE}'s dimming plus the
   * dropped hover and press responses, because a control that brightens under the mouse and then
   * ignores the click is worse than one that never moved.
   *
   * It never co-occurs with `pressed` — a selected option is never greyed, per `facets.ts` — and
   * if the two ever did meet, `filterChipState` draws "on, and out of reach" rather than letting
   * one silently win.
   */
  disabled?: boolean;
  /**
   * Extra classes, **for a label that is data rather than app vocabulary** — and that is the
   * whole of what it is for.
   *
   * Every other chip in this family is captioned with a word this app chose ("Owned", "Near
   * Mint"), so the recipe's fixed `h-9` is safe by construction. The search's card filter is
   * captioned with a **card name**, which is arbitrary up to 141 characters ("Our Market
   * Research Shows That Players Like Really Long Card Names…"), and a name that long wraps to
   * three lines inside a box that is 36px tall. Its caller spends this on `max-w-48 truncate`;
   * the `title` still carries the whole name, so nothing is lost but the overflow.
   *
   * Merged last so tailwind-merge resolves a clash in the caller's favour — which is also why
   * it must not be spent on the state classes {@link filterChipState} decides, since a caller
   * quietly winning that argument is a chip that stops saying whether it is on.
   */
  className?: string;
}) {
  const tip = useTooltip();
  const name = title ?? (hint ? `${label}, ${hint}` : undefined);
  return (
    <button
      type="button"
      // Refused here as well as said in the attribute. `aria-disabled` is a statement to the
      // accessibility tree and nothing more — unlike `disabled` it does not stop the browser
      // firing the click — so a chip that only wore the attribute would be one every pointer
      // could still press. See the prop for why it is not `disabled`.
      onClick={disabled ? undefined : onClick}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      // `describes: false`: either `title` is given and is `name` verbatim, or `hint` is given
      // and its words are already folded into `name` (`${label}, ${hint}`) — either way the
      // tooltip repeats what the `aria-label` already says.
      {...tip(title ?? hint, { describes: false })}
      aria-label={name}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "px-3",
        filterChipState(pressed, disabled),
        // The two responses `filterChipState`'s classes cannot reach from here, because both are
        // written by the recipe this chip is built out of rather than by the state: `PRESS`'s
        // `active:scale` is keyed on an `aria-disabled` that `FILTER_CONTROL` sets on the
        // *element*, and the hover brightening is a `hover:text-text` that survives a merge
        // against an identical `text-dim`. Named here so the greyed chip really is inert to both.
        disabled && "hover:text-dim active:scale-100",
        className,
      )}
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
  const tip = useTooltip();
  return (
    <div role="group" aria-label="Result layout" className="ml-auto flex gap-1">
      {LAYOUTS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={view === id}
          aria-label={label}
          // `describes: false`: identical to the `aria-label` above.
          {...tip(label, { describes: false })}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            // A square, so it says the width half of `FILTER_SHAPE`'s floor itself — see
            // {@link ValueChip}, which carries the same pair for the same reason.
            "size-9 coarse:min-w-[var(--target-min)]",
            filterChipState(view === id),
          )}
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
  const tip = useTooltip();
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
      // `describes: false`: identical to the `aria-label` above.
      {...tip(name, { describes: false })}
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

/**
 * The caption over one field in the filter tray.
 *
 * 11px, upper-cased, letter-spaced — the one place in the app where a label sits *above* its
 * control rather than beside it, because the tray is a grid of unlike things and a row of inline
 * labels would give every field a different width for no reason a reader could use.
 *
 * A class recipe rather than a component, like the three at the top of this file: a caption is a
 * `<span>` with four utilities on it, and wrapping that would be a name to look up for nothing.
 */
export const FILTER_LABEL = "text-[0.6875rem] uppercase tracking-[0.08em] text-dim";

/**
 * The way into every filter that is not on the bar — a disclosure, with the number of filters
 * that are on riding on it.
 *
 * **Its two states are told apart by kind: the border and the word are the *count*, the fill is
 * the *tray*.** It was gold-bordered at rest until 2026-08-26, on the argument that a disclosure
 * has to say "there is more in here" before anything has been pressed — but that made it the one
 * control on the row wearing the on-treatment while off, so a reader sweeping the row for what is
 * switched on found it every single time and had to read the badge to learn it was not. It is
 * {@link filterChipState} now, unmodified, over `count > 0`: a hairline and a dim word off,
 * brightening under the mouse, exactly like every other bordered control here; gold border and
 * gold word on. An open tray adds the panel's own grey fill and touches neither — so opening the
 * tray never turns the word gold, and a live count turns it gold whether the tray is up or not.
 * Both readings at once is legal and draws both, which is that function's rule too.
 *
 * **It went borderless at rest for one commit and that was a step too far** (`dc96695`, reverted
 * here the same day). Dropping the gold was right; dropping the hairline with it left the one
 * control on the row with no edge, so it read as a label rather than as something to press —
 * "similar to our other buttons" is the bar, and the other buttons have a border.
 *
 * The badge is what says how much is on, and it is drawn only when there is something to say — a
 * `0` on every quiet row is chrome that teaches the eye to skip the control it is attached to.
 *
 * **The count is the whole search's and not the tray's**, deliberately. It is `activeCount`, the
 * same number Reset all wears, so the two cannot disagree about how much is on. A tray-only count
 * would leave a reader who has pressed three colours looking at a Filters button reading zero,
 * with nothing on screen to say what it is counting.
 *
 * **The word is hidden by a class rather than by a prop, and that is not a style preference.**
 * The narrow breakpoints want the icon and the badge alone, and the obvious build — a `compact`
 * boolean, and two of these in the tree with one shown at a time — puts two buttons with one
 * accessible name and two tab stops behind a single control. So the caller hands `labelClass` the
 * variants for its own container and the word is hidden in CSS, where a screen reader still hears
 * the name this component builds and a keyboard still finds exactly one button.
 */
export function FiltersButton({
  open,
  count,
  onToggle,
  controls,
  labelClass,
  className,
}: {
  open: boolean;
  /** How many filters are on — the search's count, not the tray's. Zero draws no badge. */
  count: number;
  onToggle: () => void;
  /** The tray's `id`, for `aria-controls`. */
  controls: string;
  /**
   * Classes for the word `Filters` alone — how a caller hides it at a width of its own.
   *
   * A caller's container queries cannot be written here: this module is shared with the
   * collection's row and knows nothing about anybody's `@container` name.
   */
  labelClass?: string;
  /** Classes for the button, merged last. The filter bar spends it on `order` and `flex`. */
  className?: string;
}) {
  const tip = useTooltip();
  const name = `${open ? "Hide" : "Show"} filters — ${count} active`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={name}
      // `describes: false`: identical to the `aria-label` above.
      {...tip(name, { describes: false })}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "inline-flex shrink-0 items-center justify-center gap-2 px-3",
        // **{@link filterChipState} itself, not a copy of it** — this control is told apart by its
        // border like every other one in the row, so "a hairline and dim text off, gold border and
        // gold text on, brightening on hover" is one function's answer rather than a class pair
        // hand-written here that drifts the first time that one moves. The argument it takes is
        // the *count*, so the gold says exactly what it says everywhere else on the row: a filter
        // is on. Nothing about the tray reaches it — see the fill below.
        filterChipState(count > 0),
        // The panel below is this button's own extension, so an open tray draws the control that
        // opened it in the panel's own fill rather than leaving it looking like one more thing to
        // press. Grey (`bg-surface`, the tray's own) and not the gold tint it was: on this row
        // gold means "a filter is on", which is the border's sentence above and not this one's —
        // so an open tray never turns the word gold, and a live count turns it gold whether the
        // tray is up or not.
        open && "bg-surface",
        className,
      )}
    >
      <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
      <span className={labelClass}>Filters</span>
      {count > 0 && (
        // `aria-hidden`, with the digit spelled into the name above — {@link ResetAll}'s rule and
        // its measurement: left to the accname algorithm this announces as `"Filters3"`.
        <span
          aria-hidden="true"
          className="rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground"
        >
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * One rarity, as the gem the rest of the app draws it with and the word beside it.
 *
 * **The gem rather than a filled chip**, which is {@link RarityGem}'s rule and this row's: the
 * colour budget is spent on mana and card art, and four filled rarity pills beside six mana chips
 * would be two things shouting at once. The word is tinted where the rarity has a colour of its
 * own and left dim where it has not — `RarityGem` decides that, because `special` and `bonus`
 * have no token and a hairline-coloured word is about 1.9:1 against the background.
 *
 * `min-w-0` and the gem's own `truncate`, because the tray is a grid: in a one-column tray inside
 * a 206px panel `uncommon` is wider than its cell, and a chip that cannot shrink hangs out of the
 * panel and puts a horizontal scrollbar across the whole surface (`src/CLAUDE.md`'s
 * narrowest-surface rule).
 */
export function RarityChip({
  rarity,
  pressed,
  onClick,
  disabled = false,
  title,
}: {
  /** Scryfall's own lower-case word — `common`, `uncommon`, `rare`, `mythic`. */
  rarity: string;
  pressed: boolean;
  onClick: () => void;
  /** Drawn dim and unpressable, without leaving the tab order — see {@link ManaChip}. */
  disabled?: boolean;
  /** The tooltip and the accessible name together, with the visible word at the front. */
  title?: string;
}) {
  const tip = useTooltip();
  const name = title ?? `${rarity.replace(/^./, (c) => c.toUpperCase())} cards`;
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onClick();
      }}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-label={name}
      // `describes: false`: identical to the `aria-label` above.
      {...tip(name, { describes: false })}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "flex min-w-0 items-center px-2.5",
        filterChipState(pressed, disabled),
        // The two responses `filterChipState` cannot reach from here — {@link ToggleChip} carries
        // the same pair for the same reason.
        disabled && "hover:text-dim active:scale-100",
      )}
    >
      {/* `aria-hidden`, because `RarityGem` exposes the word to assistive tech itself and the
          `aria-label` above already says it — without this the chip announces its rarity twice. */}
      <span aria-hidden="true" className="flex min-w-0 items-center text-[0.8125rem]">
        <RarityGem rarity={rarity} withLabel />
      </span>
    </button>
  );
}

/**
 * One thing this search is currently narrowed by, said in words — and pressed to take it off.
 *
 * The row of these under the bar is what the redesign is for. Every control above states its own
 * filter in its own vocabulary — a gold border on a select, six chips two of which are bright —
 * and none of that survives the tray being shut. A chip reading `Colour: Blue, Red` is the search
 * in a sentence, at a size the eye reads before it reads any control.
 *
 * **26px and not the family's 36**, so a stated filter can never be mistaken for a control that
 * sets one. It is the one deliberate exception to the shared height, and it is what tells the two
 * bands of the bar apart at a glance.
 *
 * **The whole chip is the button** rather than a pill with a ✕ inside it. An 11px glyph is an
 * 11px target; the label is already the thing the reader is looking at, so one press on the whole
 * pill is both a bigger target and a shorter sentence than "the close button of the Colour chip".
 *
 * **This is where the 44px floor and the stated design conflict, and the *target* grows rather
 * than the chip.** 26px is the whole argument for this band existing — it is what tells "a filter
 * you are narrowed by" from "a control that sets one" at a glance, and every other control in
 * this file is 36. A 44px chip would put the two bands at one height and wreck that reading; a
 * 26px chip is under WCAG 2.5.5's 44 *and* under 2.5.8's 24 once the row's own gap is counted.
 * So the hit area is a transparent `::before` centred on the chip — 44 tall, and at least 44
 * wide for a chip whose statement is short — while the drawn pill stays 26. WCAG 2.5.5 measures
 * the target, not the ink, which is exactly the seam this uses.
 *
 * **The cost is stated rather than hidden**: a 44px box on a 26px chip reaches 9px above and
 * below the pill, so in a wrapped row the targets of two chips on adjacent lines can meet. That
 * is a real overlap and it is the lesser one — the alternative is a band of controls no finger
 * can aim at.
 */
export function ActiveFilterChip({
  label,
  onRemove,
}: {
  /** The whole statement — `Colour: Blue, Red`. Named for the filter, never for the control. */
  label: string;
  onRemove: () => void;
}) {
  const tip = useTooltip();
  const name = `Remove filter — ${label}`;
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={name}
      // `describes: false`: identical to the `aria-label` above.
      {...tip(name, { describes: false })}
      className={cn(
        PRESS,
        FILTER_FOCUS,
        "inline-flex h-[1.625rem] max-w-full shrink-0 items-center gap-1.5 rounded-full border",
        "border-accent pr-1.5 pl-2.5 text-xs text-accent hover:bg-accent/10",
        // `relative` unconditionally so the pseudo-element below has a containing block to be
        // centred in; it changes nothing on its own. The `::before` is the target and the chip
        // is the ink — see the doc comment for why this one control grows its hit area instead
        // of its height. `content-['']` is written out rather than relied on: a pseudo-element
        // with no `content` is not generated at all, and the failure would be a chip that is
        // simply still 26px with nothing on screen or in the suite saying so.
        "relative",
        "coarse:before:absolute coarse:before:top-1/2 coarse:before:left-1/2",
        "coarse:before:h-[var(--target-min)] coarse:before:w-full",
        "coarse:before:min-w-[var(--target-min)]",
        "coarse:before:-translate-x-1/2 coarse:before:-translate-y-1/2",
        "coarse:before:content-['']",
      )}
    >
      <span className="truncate">{label}</span>
      <X className="size-3 shrink-0" aria-hidden="true" />
    </button>
  );
}
