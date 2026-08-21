/**
 * The printings modal's controls: what to show, and in what order.
 *
 * **Fully controlled and stateless.** The modal owns the filter, because the filter is also what
 * the count line and the empty state are worded from and what `listKey` is built out of; a control
 * row holding its own copy would be a second truth about the same question.
 *
 * **Which controls are here is the spec's judgement rather than a survey of the fields.** Mana
 * value, colour, type and legality are identical on every printing of one card — a filter for them
 * would either pass everything or nothing. What differs is the set, the language, the treatment
 * and the collector number, and those are exactly the four below.
 *
 * **It is built out of `@/components/FilterChips` rather than beside it.** That module is what
 * keeps the search's row and the collection's row one row rather than two lookalikes, and this is
 * the third surface in the app that asks a reader to narrow a list of cards. A chip here that
 * invented its own height would sit 2px off the line it shares with the text box; one that
 * invented its own focus mark would be the only control in the window a keyboard reader loses.
 *
 * **And the sets are `SetCombobox`, the search's own picker, for one rung further up the same
 * argument.** This row used to draw them two ways — toggle chips up to eight sets, a scrolling
 * checkbox list past that — which made the control's *shape* a fact about the card: a printing in
 * eight sets got a wide wrapping chip row, one in nine got a 160px box, and the row changed height
 * between two cards a chevron apart. One picker at every size settles that, and it is the picker a
 * reader has already learnt on the search page and the collection: type a name or a code, read the
 * set's own keyrune glyph, tick several without the list moving under the press. What is passed to
 * it is this card's sets and only those — see the `options` prop, which also turns its `list_sets`
 * query off, so the wall's own rows stay the only source of what is offered here.
 */
import { useId, useMemo, type ReactNode } from "react";
import { X } from "lucide-react";
import { FILTER_CONTROL, ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { SetCombobox } from "@/features/search/SetCombobox";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { SetSummary } from "@/lib/ipc";
import { languageName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import {
  EMPTY_PRINTING_FILTER,
  isFilterActive,
  type LangOption,
  type PrintingFilter,
  type SetOption,
  type TreatmentOption,
} from "./printingFilters";
import { isPrintingGroupBy, PRINTING_GROUP_BY_OPTIONS, type PrintingGroupBy } from "./printings";

/**
 * The word above one group of controls.
 *
 * 11px and uppercase — the deck editor toolbar's caption, which is the nearest control row in the
 * app that labels its pickers rather than letting a placeholder do it. This row needs them where
 * the search's row does not: three of its groups draw **codes** (`LEA`, `EN`) or bare words, and a
 * column of three-letter codes beside a column of two-letter codes is a puzzle without a heading.
 */
const CAPTION = "text-[0.6875rem] uppercase tracking-wide text-dim";

/**
 * One control with its caption, and the accessible group the caption names.
 *
 * **The visible caption is `aria-hidden` and the name is spelled on the group instead.** A
 * `role="group"` takes no name from its contents, so the two would not merge on their own — the
 * caption would simply be read out as a stray line of text before the controls it belongs to. One
 * fact, said once, in each of the two channels.
 */
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={name} className="flex flex-col gap-1">
      <span aria-hidden="true" className={CAPTION}>
        {name}
      </span>
      {children}
    </div>
  );
}

/** One row of a {@link CheckList}: what the filter sends, what the reader reads, and how many. */
interface CheckOption {
  /** The value handed back to `onToggle` — a set code, a language code. */
  key: string;
  /** What is drawn on the row. */
  text: string;
  /**
   * What the row is called in words, where {@link text} is an abbreviation — a language code.
   *
   * The row's accessible name and its tooltip are built from this rather than from what is
   * drawn, so `JA` is announced and hovered as `Japanese`; a set row, whose text is already the
   * set's name, leaves it unset and the two are the same string. The visible column stays the
   * code because the box is 128px wide and a column of full names would truncate to nothing.
   */
  name?: string;
  /** How many printings it would leave. */
  count: number;
}

/**
 * A scrolling list of checkboxes — the shape the language picker takes.
 *
 * **One caller, and it stays a component rather than being inlined into it.** It was written for
 * two, and the sets moved to `SetCombobox`; what is left is not a generic list looking for a
 * second user but the boundary between *what a language row is* and *where the row's data comes
 * from*, which is what keeps the accname note below attached to the markup it is about. A language
 * is a two-letter code and could not have gone the sets' way: a combobox whose rows read `JA`,
 * `PT`, `RU` is a control with nothing to type into it.
 *
 * The count is right-aligned in the data face rather than run into the label with a separator, so
 * a reader scans one column of names and one column of numbers instead of parsing every row.
 *
 * **The bare number is named in the row's own accessible name rather than left to stand alone.**
 * Nothing beside it says what is being counted — the caption says what the *names* are — so the
 * checkbox is labelled `Japanese — 41 printings` and the same sentence is the row's tooltip.
 * **The name in it is the language's, not the two letters the row draws** (`CheckOption.name`):
 * the sentence is the one place either reader is given room for the words, and a hover that
 * answered `JA — 41 printings` would have repeated the abbreviation rather than explained it. The `<label>` still wraps the input, so the whole row is a hit target; the `aria-label`
 * is what stops the two spans being concatenated into `Limited Edition Alpha12`, which is what the
 * accname algorithm does to inline boxes with nothing between them (measured on `ResetAll`,
 * 2026-08-09).
 *
 * The options arrive in the order `printingFilters` built them — **English first, then by count**
 * — and that order is deliberately not run through `sortOptions`. It is one of the two exemptions
 * this app grants: the order *is* the information. English is what the rest of the app is in and
 * what a reader narrowing a wall of 862 Forests to "the normal ones" is reaching for, and on a
 * heavily reprinted card it is not the largest group — so neither the alphabet nor the count would
 * put it where it belongs.
 *
 * The sets no longer take this exemption and lost something real to it: `SetCombobox` sorts by
 * name, so the set a card was printed in *most* is no longer the first row. It is the trade the
 * picker was chosen for — one shape at every size, a needle to type, and the count still on the
 * row's tooltip — and the wall's own `Sort printings by` control answers the "which set has the
 * most" question directly.
 */
function CheckList({
  options,
  selected,
  onToggle,
  mono = false,
  className,
}: {
  options: readonly CheckOption[];
  /** The keys currently on. */
  selected: readonly string[];
  onToggle: (key: string) => void;
  /** Whether the label is a code rather than a word — a language, not a set name. */
  mono?: boolean;
  /** The box's width, which its caller knows and it does not. */
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <ul
      className={cn(
        // `relative`, because a scroll container has to be the containing block for its own
        // absolutely positioned content: `overflow` clips a descendant only when the scroller
        // lies between it and that descendant's containing block, so anything absolute in here
        // without it would be laid out against the *document* and stretch that instead.
        "relative max-h-40 overflow-y-auto rounded-md border border-border bg-surface",
        // 6px of padding rather than none, and it is the focus mark's room rather than taste.
        // `overflow` clips at the padding box and `FOCUS` is a 2px outline standing 2px off the
        // control — 4px proud — so a checkbox flush against the content edge would lose that
        // side of its indicator: a WCAG 2.4.7 failure that nothing in the box tree reports and
        // jsdom cannot see. The same 6px `DROP_MARK_ROOM` spends on the deck's grow-views.
        "p-1.5",
        className,
      )}
    >
      {options.map((option) => {
        const on = selected.includes(option.key);
        const name = `${option.name ?? option.text} — ${plural(option.count, "printing")}`;
        return (
          <li key={option.key}>
            <label
              {...tip(name, { describes: false })}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm",
                // The two states the chips beside them are told apart by, in the same two
                // colours: on is bright, off is dim and brightens under the mouse so the row
                // answers a pointer. No fill — the direction's colour budget is spent on the
                // mana chips and the card art below, and a list of filled rows would out-shout
                // the wall it is narrowing.
                on ? "text-text" : "text-dim hover:text-text",
              )}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(option.key)}
                aria-label={name}
                className={cn("shrink-0 accent-accent", FOCUS)}
              />
              <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono")}>
                {option.text}
              </span>
              <span aria-hidden="true" className="shrink-0 font-mono text-xs tabular-nums text-dim">
                {option.count}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One value added to a list of them, or taken out of it.
 *
 * A fresh array every time and never a mutation: the filter lives in the modal's `useState` and
 * React compares it by identity, so an in-place `push` would narrow nothing and re-render nothing.
 * Order is press order and does not matter — `filterPrintings` reads both lists through a `Set`.
 */
function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function PrintingsFilterBar({
  filter,
  setOptions,
  langOptions,
  treatmentOptions,
  sort,
  onFilterChange,
  onSortChange,
}: {
  /** Everything the four filter controls are drawn from, as one value. */
  filter: PrintingFilter;
  /** The sets these printings are in, with counts — `printingFilters`' `setOptions` answer. */
  setOptions: readonly SetOption[];
  /** The languages they are in, with counts — English first. */
  langOptions: readonly LangOption[];
  /** All seven treatments with their counts, **including the ones at zero**. */
  treatmentOptions: readonly TreatmentOption[];
  /** The ordering the wall is drawn in — the pane's persisted preference, shared with it. */
  sort: PrintingGroupBy;
  /** Every change to the four filters, as a whole replacement value. */
  onFilterChange: (next: PrintingFilter) => void;
  /** A change to the ordering alone. A second channel deliberately — see the Clear control. */
  onSortChange: (next: PrintingGroupBy) => void;
}) {
  const sortId = useId();
  const active = isFilterActive(filter);
  /**
   * This card's sets in the shape the search's picker takes, and the counts it draws them with.
   *
   * Two values off one list rather than one, because `SetCombobox` reads them for two different
   * questions and reading either off the other would be a claim. `options` is *which sets exist
   * to offer*, and a `SetSummary` is what that picker's rows are built from — `setType` and
   * `releasedAt` are `null` because a `Printing` does not carry them and the picker draws neither,
   * so inventing a value would be worse than admitting there is none. `counts` is *how many rows
   * each one holds in this search*, which is what `facetTitle` writes into the row's tooltip
   * (`Limited Edition Alpha — 12 printings`) and what the greying rule reads. They happen to carry
   * the same number here and are not the same fact: on the search page the first comes from a
   * session-cached `list_sets()` and the second from the facet index.
   *
   * Neither can be zero, because both are counted off the very rows being filtered — so unlike
   * the treatments below, nothing here is ever drawn out of reach and no greyed state can arise.
   */
  const sets = useMemo<SetSummary[]>(
    () =>
      setOptions.map((option) => ({
        code: option.code,
        name: option.name,
        setType: null,
        releasedAt: null,
        cardCount: option.count,
      })),
    [setOptions],
  );
  const setCounts = useMemo(
    () => Object.fromEntries(setOptions.map((option) => [option.code, option.count])),
    [setOptions],
  );

  return (
    // One wrapping row, aligned to its **top**: the language picker is a box up to 160px tall and
    // everything else is a 36px control, so centring would leave the text box floating in the
    // middle of a tall row rather than at the head of it. It takes one box to need this rather
    // than the two that used to be here, and the set picker becoming a 36px trigger is what makes
    // the row's resting height that box's alone. `flex-wrap` is not optional — a row of
    // fixed-width controls is sized by the narrowest surface that draws it, and a flex item
    // cannot shrink below its own min-content, so an unwrapped row hangs out of its container and
    // the nearest `overflow-y-auto` ancestor turns the overhang into a horizontal scrollbar.
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      {/* **The four fields it matches are in the placeholder**, because a search box that
          silently ignores what you typed is worse than no box: the card's own name is identical
          on every row of this list and is the one thing typing it here will not find.

          A fixed width rather than `flex-1`, and that is what lets the Clear control at the far
          end be drawn only when there is something to clear. `ResetAll` is drawn always and
          greyed at zero for the opposite reason: the search's row opens with a `flex-1` box, so a
          button arriving mid-row takes its whole width out of that box and slides every chip to
          its right left, under the finger that just pressed one. Nothing here grows, so the free
          space at the end of the row is what the button appears into and nothing moves. */}
      <input
        type="search"
        aria-label="Filter printings"
        value={filter.text}
        onChange={(e) => onFilterChange({ ...filter, text: e.target.value })}
        placeholder="Set, number or artist"
        className={cn(
          FILTER_CONTROL,
          FOCUS,
          "w-64 min-w-0 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />

      {/* The picker is 36px and the language box beside it is up to 160px, which is what the row's
          `items-start` is for — and what makes the caption above it worth keeping even though the
          combobox already names itself. Without it the button would sit 20px above the first row
          of every field beside it. */}
      <Field name="Sets">
        <SetCombobox
          selected={filter.sets}
          options={sets}
          counts={setCounts}
          // Second in the row rather than at the end of it, which is where both search-shaped
          // callers put it — so the listbox is pinned to the trigger's *left* edge and opens
          // rightwards, into the row it belongs to instead of back across the text box beside it.
          align="start"
          onToggle={(code) => onFilterChange({ ...filter, sets: toggleIn(filter.sets, code) })}
        />
      </Field>

      {/* Always the list, at every size, unlike the sets above. A language is a two-letter code,
          and a row of them as chips would be a row of unlabelled squares; the list gives each one
          its count on the same line, which is what makes `JA 41` worth pressing. */}
      <Field name="Languages">
        <CheckList
          options={langOptions.map((o) => ({
            key: o.lang,
            text: o.lang.toUpperCase(),
            // The words the code stands for, which is what the row is hovered and announced as —
            // see `CheckOption.name`, and `languages.ts` for why `PH` needed them (issue #161).
            name: languageName(o.lang),
            count: o.count,
          }))}
          selected={filter.langs}
          mono
          className="w-32"
          onToggle={(lang) => onFilterChange({ ...filter, langs: toggleIn(filter.langs, lang) })}
        />
      </Field>

      {/* In `TREATMENTS`' order and deliberately not alphabetical — the other of the two
          exemptions from `sortOptions`, the order *is* the information: it runs from what the
          card is **printed in** (foil, etched) through what the printing **is** (promo, full art)
          to what its **frame** does (borderless, showcase, extended art), which is also the order
          of the fields each one is read off. An alphabet would interleave the three. */}
      <Field name="Treatments">
        <div className="flex flex-wrap gap-1">
          {treatmentOptions.map((option) => {
            /**
             * No printing of this card carries it. Drawn greyed rather than dropped, which is
             * `facets.ts`' rule and its reason: an option that vanishes reads as a control that
             * broke, where a greyed one reads as a fact about the card — and the row keeps a
             * fixed shape instead of reflowing as the reader narrows.
             */
            const empty = option.count === 0;
            return (
              <ToggleChip
                key={option.id}
                label={option.label}
                pressed={filter.treatments.includes(option.id)}
                // The count is in the name as well as in the state, so the fact reaches a reader
                // who is hearing the row rather than looking at it: `Showcase — 0 printings`.
                title={`${option.label} — ${plural(option.count, "printing")}`}
                // **`ToggleChip.disabled` was written for this caller.** The prop's own doc used
                // to record its absence as deliberate, on the grounds that the only faceted chip
                // of this kind was the search's `Owned` — a cycle, which greying would strand
                // mid-way. These are not a cycle: each is one independent option over one card's
                // printings. The chip owns the whole of what greyed means (the dimming, the
                // dropped hover and press responses, `aria-disabled`, and refusing the click), so
                // nothing about it is spelled out here and nothing can drift.
                disabled={empty}
                onClick={() =>
                  onFilterChange({
                    ...filter,
                    treatments: toggleIn(filter.treatments, option.id),
                  })
                }
              />
            );
          })}
        </div>
      </Field>

      {/* **`Sort`, never `Group by`** — the pane's four modes are the same four orderings here,
          but this wall draws no headings: `CardGrid` positions its rows absolutely inside a
          virtualiser, so a heading cannot be interleaved without owning the virtualisation. The
          ordering is shared with the pane and so is the reader's choice of it; only the word
          differs, because only what it does differs.

          The words are drawn **and** spelled into `aria-label`, identically. A `<select>`'s
          accessible name is what this control is addressed by from outside the component, and the
          caption above it is what a pointer presses to focus it; keeping them one string is what
          makes the name *contain* the visible label (WCAG 2.5.3) rather than widen past it —
          which is the trap in the shorter `Sort by` this row could have drawn instead. */}
      <div className="flex flex-col gap-1">
        <label htmlFor={sortId} className={CAPTION}>
          Sort printings by
        </label>
        <select
          id={sortId}
          aria-label="Sort printings by"
          value={sort}
          onChange={(event) => {
            // The same predicate that narrows the stored row narrows the event, so there is no
            // cast here and no second idea of what a mode is. A `<select>` cannot emit anything
            // else, which is exactly why this costs nothing to be right about.
            const chosen = event.target.value;
            if (isPrintingGroupBy(chosen)) onSortChange(chosen);
          }}
          className={cn(FILTER_CONTROL, FOCUS, "border-border bg-surface px-2 text-text")}
        >
          {PRINTING_GROUP_BY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* **It clears the four filters and never the sort.** Clearing what you are looking at must
          not change the order you chose to read it in — the two are separate channels for that
          reason, and it is `useCardSearch`'s own rule for its sort.

          Drawn only while there is something to clear, which this row may do and the search's row
          may not: nothing to the left of it grows, so `ml-auto` puts it in free space at the far
          end and its arrival moves nothing. */}
      {active && (
        <button
          type="button"
          onClick={() => onFilterChange(EMPTY_PRINTING_FILTER)}
          className={cn(
            FILTER_CONTROL,
            FOCUS,
            "ml-auto inline-flex items-center gap-1.5 border-border px-2.5 text-dim hover:text-text",
          )}
        >
          <X className="size-4" aria-hidden="true" />
          Clear all
        </button>
      )}
    </div>
  );
}
