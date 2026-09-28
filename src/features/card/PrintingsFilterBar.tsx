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
 * **One centred toolbar of 36px controls, the search page's own shape** (2026-09-28). This row
 * used to be five differently shaped things under captions — a bare text box, a captioned set
 * picker, a checkbox list up to 160px tall, a wrapping row of eight chips and a 32px sort picker —
 * laid out `items-start`, so the one uncaptioned box floated 20px above its neighbours and the
 * tallest control set the height of the whole band. Every picker is a {@link MultiDropdown} now,
 * which is what `SetCombobox` already was: a trigger that says `Any language` or `2 languages`,
 * turns gold while it narrows, and opens a list with each option's count beside it. One shape,
 * one height, and the row is centred because nothing in it is taller than anything else.
 *
 * **It is built out of `@/components/FilterChips` rather than beside it.** That module is what
 * keeps the search's row and the collection's row one row rather than two lookalikes: the box is
 * `FILTER_FIELD`, the reset is `ResetAll`, and the filters that are on are stated as
 * `ActiveFilterChip`s on a line of their own, drawn only while something is on — the search bar's
 * arrangement, so a reader who has learnt one has learnt this.
 *
 * **And the sets are `SetCombobox`, the search's own picker.** What is passed to it is this card's
 * sets and only those — see the `options` prop, which also turns its `list_sets` query off, so the
 * wall's own rows stay the only source of what is offered here.
 */
import { useId, useMemo } from "react";
import { Dropdown, MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { ActiveFilterChip, FILTER_FIELD, FILTER_LABEL, ResetAll } from "@/components/FilterChips";
import { SetCombobox } from "@/features/search/SetCombobox";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { SetSummary } from "@/lib/ipc";
import { languageName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import {
  activePrintingFilterCount,
  EMPTY_PRINTING_FILTER,
  type LangOption,
  type PrintingFilter,
  type SetOption,
  type TreatmentOption,
} from "./printingFilters";
import { isPrintingGroupBy, PRINTING_GROUP_BY_OPTIONS, type PrintingGroupBy } from "./printings";

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

/**
 * What a multi-picker's trigger says: `Any language`, `1 language`, `3 languages`.
 *
 * A count and never a value, which is `MultiDropdown.triggerLabel`'s own contract and the reason
 * the trigger keeps one width while the reader ticks — a trigger naming `Japanese, Phyrexian`
 * would push every control to its right along the row mid-press.
 */
function countLabel(n: number, noun: string): string {
  return n === 0 ? `Any ${noun}` : plural(n, noun);
}

/**
 * `PRINTING_GROUP_BY_OPTIONS`, in the shape `<Dropdown>` draws — the four orderings with their
 * own value and label and nothing else, since none of them wants a hint or an icon here. Module
 * scope because the four modes never change: rebuilding this array on every render of an open
 * modal would cost four objects for nothing.
 */
const SORT_DROPDOWN_OPTIONS: readonly DropdownOption[] = PRINTING_GROUP_BY_OPTIONS.map(
  (option) => ({ value: option.value, label: option.label }),
);

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
  /** All the treatments with their counts, **including the ones at zero**. */
  treatmentOptions: readonly TreatmentOption[];
  /** The ordering the wall is drawn in — the pane's persisted preference, shared with it. */
  sort: PrintingGroupBy;
  /** Every change to the four filters, as a whole replacement value. */
  onFilterChange: (next: PrintingFilter) => void;
  /** A change to the ordering alone. A second channel deliberately — see `Reset all`. */
  onSortChange: (next: PrintingGroupBy) => void;
}) {
  const sortId = useId();
  const sortLabelId = `${sortId}-label`;
  /**
   * This card's sets in the shape the search's picker takes, and the counts it draws them with.
   *
   * Two values off one list rather than one, because `SetCombobox` reads them for two different
   * questions and reading either off the other would be a claim. `options` is *which sets exist
   * to offer*, and a `SetSummary` is what that picker's rows are built from — `setType` and
   * `releasedAt` are `null` because a `Printing` does not carry them and the picker draws neither,
   * so inventing a value would be worse than admitting there is none. `counts` is *how many rows
   * each one holds in this search*, which is what `facetTitle` writes into the row's tooltip.
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

  /**
   * The languages, **named in words with the code beside them.** The row is the language's name
   * because a column of two-letter codes is a puzzle (`PH` needed its words — issue #161); the
   * code stays as a mono prefix because it is what the wall's own tiles print, so a reader can
   * match one to the other.
   *
   * In `langOptions`' order — English first, then by count — and deliberately not through
   * `sortOptions`: the order is the information, the language nearly every printing is in at the
   * head and the rarities under it.
   */
  const langDropdownOptions = useMemo<DropdownOption[]>(
    () =>
      langOptions.map((o) => ({
        value: o.lang,
        label: languageName(o.lang),
        icon: (
          <span aria-hidden="true" className="w-6 shrink-0 font-mono text-xs text-dim">
            {o.lang.toUpperCase()}
          </span>
        ),
        hint: String(o.count),
        title: `${languageName(o.lang)} — ${plural(o.count, "printing")}`,
      })),
    [langOptions],
  );

  /**
   * The treatments, in `TREATMENTS`' order and deliberately not alphabetical — the other of the
   * two exemptions from `sortOptions`, the order *is* the information: it runs from what the card
   * is **printed in** (foil, etched) through what the printing **is** (promo, full art) to what its
   * **frame** does (borderless, showcase, extended art).
   *
   * **A treatment no printing of this card carries is drawn greyed rather than dropped**, which is
   * `facets.ts`' rule and its reason: an option that vanishes reads as a control that broke, where
   * a greyed one reads as a fact about the card. `DropdownOption.disabled` is the shell's
   * `aria-disabled`, so the row stays announced and refuses the press.
   */
  const treatmentDropdownOptions = useMemo<DropdownOption[]>(
    () =>
      treatmentOptions.map((o) => ({
        value: o.id,
        label: o.label,
        hint: String(o.count),
        title: `${o.label} — ${plural(o.count, "printing")}`,
        disabled: o.count === 0,
      })),
    [treatmentOptions],
  );

  /**
   * The filters that are on, as statements — one chip per kind, `Treatment: Borderless, Foil`,
   * which is the search's `ActiveFilterChip` contract (`Colour: Blue, Red`). A press clears that
   * kind. The typed text is not stated: it is still in the box it was typed into, and the box's
   * own ✕ is its way out.
   */
  const stated = [
    filter.sets.length > 0 && {
      label: `Set: ${filter.sets.map((c) => c.toUpperCase()).join(", ")}`,
      remove: () => onFilterChange({ ...filter, sets: [] }),
    },
    filter.langs.length > 0 && {
      label: `Language: ${filter.langs.map(languageName).join(", ")}`,
      remove: () => onFilterChange({ ...filter, langs: [] }),
    },
    filter.treatments.length > 0 && {
      label: `Treatment: ${filter.treatments
        .map((id) => treatmentOptions.find((o) => o.id === id)?.label ?? id)
        .join(", ")}`,
      remove: () => onFilterChange({ ...filter, treatments: [] }),
    },
  ].filter((chip) => chip !== false);

  return (
    <div className="flex flex-col gap-2">
      {/* **Centred, because every control on it is 36px.** `flex-wrap` is still not optional — a
          row of controls that cannot shrink below their own min-content hangs out of its box at
          a narrow enough window, and the nearest `overflow` ancestor turns the overhang into a
          horizontal scrollbar. Wrapped, the sort group's `ml-auto` holds it against the right
          edge of whichever line it lands on. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        {/* **The four fields it matches are in the placeholder**, because a search box that
            silently ignores what you typed is worse than no box: the card's own name is identical
            on every row of this list and is the one thing typing it here will not find.

            `flex-1` and capped, as the search bar's box is. It could not be while `Clear all`
            appeared at the row's end only with something to clear — a growing box beside an
            arriving button slides every control between them — but `Reset all` is drawn always
            now, so the free space is spent up front and nothing moves when a filter goes on.

            `FILTER_FIELD` and not `FILTER_CONTROL`: the row's controls dip 3% under the press and
            a box the reader types into must not, or the native ✕ slides out from under the
            pointer clearing it. Issue #179 — the reason is on the constant. */}
        <input
          type="search"
          aria-label="Filter printings"
          value={filter.text}
          onChange={(e) => onFilterChange({ ...filter, text: e.target.value })}
          placeholder="Set, number or artist"
          className={cn(
            FILTER_FIELD,
            FOCUS,
            "min-w-48 max-w-[27.5rem] flex-1 basis-48 border-border bg-surface px-3",
            "placeholder:text-dim focus:border-accent",
          )}
        />

        <SetCombobox
          selected={filter.sets}
          options={sets}
          counts={setCounts}
          // Its list is pinned to the trigger's *left* edge and opens rightwards, into the row it
          // belongs to instead of back across the text box beside it.
          align="start"
          onToggle={(code) => onFilterChange({ ...filter, sets: toggleIn(filter.sets, code) })}
        />

        <MultiDropdown
          label="Language"
          triggerLabel={countLabel(filter.langs.length, "language")}
          options={langDropdownOptions}
          selected={filter.langs}
          active={filter.langs.length > 0}
          align="start"
          onToggle={(lang) => onFilterChange({ ...filter, langs: toggleIn(filter.langs, lang) })}
        />

        <MultiDropdown
          label="Treatment"
          triggerLabel={countLabel(filter.treatments.length, "treatment")}
          options={treatmentDropdownOptions}
          selected={filter.treatments}
          active={filter.treatments.length > 0}
          align="start"
          onToggle={(id) => {
            const option = treatmentOptions.find((o) => o.id === id);
            if (option)
              onFilterChange({ ...filter, treatments: toggleIn(filter.treatments, option.id) });
          }}
        />

        {/* **`Sort`, never `Group by`** — the pane's four modes are the same four orderings
            here, but this wall draws no headings: `CardGrid` positions its rows absolutely inside
            a virtualiser, so a heading cannot be interleaved without owning the virtualisation.

            **The caption sits beside the trigger rather than over it**, in the tray's 11px
            caption face, so it costs the row no height. **It supplies the accessible name
            through `labelledBy`** rather than a second `aria-label` spelling the same words, so
            the two cannot drift — and the name is still `Sort printings by`, the rest of it
            `sr-only`: a bare verb names an action and not the thing it acts on (the search bar's
            `Sort results` is the same call). The name *starts with* the visible word, which is
            what WCAG 2.5.3 asks of it. */}
        <div className="ml-auto flex items-center gap-2">
          <label id={sortLabelId} htmlFor={sortId} className={FILTER_LABEL}>
            Sort{" "}
            <span className="sr-only">printings by</span>
          </label>
          <Dropdown
            id={sortId}
            labelledBy={sortLabelId}
            value={sort}
            options={SORT_DROPDOWN_OPTIONS}
            align="end"
            onChange={(value) => {
              // `SORT_DROPDOWN_OPTIONS` is built from nothing but `PRINTING_GROUP_BY_OPTIONS`'s
              // own four values, so `value` here can only ever be one of them. Kept as a real
              // check rather than a cast because `Dropdown`'s `onChange` is typed as a bare
              // `string` and cannot see that provenance on its own.
              if (isPrintingGroupBy(value)) onSortChange(value);
            }}
            className="text-text"
          />
        </div>

        {/* **It clears the four filters and never the sort.** Clearing what you are looking at
            must not change the order you chose to read it in — the two are separate channels for
            that reason, and it is `useCardSearch`'s own rule for its sort. Drawn always and
            greyed at zero, `ResetAll`'s rule, so its arrival never moves the row. */}
        <ResetAll
          count={activePrintingFilterCount(filter)}
          onReset={() => onFilterChange(EMPTY_PRINTING_FILTER)}
        />
      </div>

      {/* Drawn only while something is on, as the search bar's line is: an appearing chip line
          moves only the wall under it, which has just been re-filtered and is moving anyway. */}
      {stated.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(FILTER_LABEL, "shrink-0")}>Filtering by</span>
          {stated.map((chip) => (
            <ActiveFilterChip key={chip.label} label={chip.label} onRemove={chip.remove} />
          ))}
        </div>
      )}
    </div>
  );
}
