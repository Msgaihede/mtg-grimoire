import { useMemo } from "react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { sortOptions } from "@/lib/options";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { colorDisabled, facetTitle, optionDisabled } from "./facets";
import { SetCombobox } from "./SetCombobox";
import { FORMATS, type CardSearch } from "./useCardSearch";

/**
 * Every filter the search view offers, in one row.
 *
 * The colour chips are the app's one deliberate splash of colour and the reason the rest
 * of the chrome stays grey: a real mana symbol on its authentic printed fill is
 * recognisable at 36px to anyone who has held a card, in a way that a letter in a coloured
 * circle is not. Everything else here is quiet on purpose — outlined, mono, grey — so that
 * the one thing the eye lands on is which colours are switched on.
 *
 * The controls themselves live in `@/components/FilterChips`, which the collection view
 * builds its own row out of. This file owns the layout and *which* filters the search
 * offers, and nothing else.
 */
export function FilterBar({
  search,
  layoutToggle = true,
}: {
  search: CardSearch;
  /**
   * Whether the grid-or-table pair rides the row.
   *
   * Off in the deck editor's docked panel, which is a wall of art and has no table to switch
   * to: the toggle there would move the *search view's* stored preference and change nothing
   * the reader can see, which is a control that lies. Everything else on the row is a
   * statement about which cards to show and means the same thing in both places.
   */
  layoutToggle?: boolean;
}) {
  /**
   * How many printings each option would leave, or `undefined` when that is not known.
   *
   * Every control below reads it through `facets.ts`, which is where the rule lives:
   * greyed means "turning this on would not change the result set", not-greyed means "we
   * don't know" — so `undefined` here leaves the whole row live, which is what a cold index,
   * a failed query and the first render all arrive as.
   */
  const facets = search.facets;
  /**
   * The formats in the order the dropdown draws them: **pickable first, greyed last, each
   * half alphabetical by the word on screen.**
   *
   * Alphabetical because a reader hunting for "Modern" hunts under M. `FORMATS`' own order is
   * roughly how the formats rank, which is knowledge this control never shows and which no two
   * players would write down the same way — so it stays a fact about the keys and stops being
   * a layout. The greyed half sinks rather than disappearing: a format nothing in this search
   * is legal in is still worth offering (it says the search has nothing there), and dropping it
   * would make the list jump under the cursor each time the facets land, which is the same
   * reason `SetCombobox` greys instead of filtering.
   *
   * Each option's disabled state is decided once and spent twice — as the grouping level and
   * as the attribute — because the two are the same question and `optionDisabled`'s "a
   * selected option is never greyed" arm is exactly where they must not disagree: the format
   * the reader picked stays in the pickable half however its own count reads, so the way out
   * of a dead end never sinks below six rows the reader cannot use.
   *
   * With no facets at all `optionDisabled` is false for every key, so both halves collapse
   * into one plain alphabetical list without a branch for it.
   */
  const formatOptions = useMemo(
    () =>
      sortOptions(
        FORMATS.map((f) => ({
          ...f,
          disabled: optionDisabled(facets?.formats, f.value, search.format === f.value),
        })),
        (f) => f.label,
        (f) => [f.disabled ? 1 : 0],
      ),
    [facets?.formats, search.format],
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="card-search-text" className="sr-only">
        Search cards
      </label>
      <input
        id="card-search-text"
        type="search"
        value={search.text}
        onChange={(e) => search.setText(e.target.value)}
        placeholder="Search cards…"
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "min-w-56 flex-1 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />

      {/* Wider than the other groups' `gap-1`: a pressed chip's ring reaches 4px past its
          edge, and at 4px apart two pressed chips look like one welded object. */}
      <div role="group" aria-label="Color identity" className="flex gap-1.5">
        {MANA_KEYS.map((key) => (
          <ManaChip
            key={key}
            symbol={key}
            pressed={search.colors.includes(key)}
            // The one control on this row that does not ask "would this return nothing".
            // `colors` is subset semantics, so pressing a chip with another already on
            // *broadens* — the count is the size of the result set after the press, read
            // against `facets.total`. And that total is the facets' own: printings, exact,
            // and not the collapsed, capped number the results caption prints.
            disabled={colorDisabled(
              facets?.colors[key],
              facets?.total ?? 0,
              search.colors.includes(key),
            )}
            title={facetTitle(MANA_LABEL[key], facets?.colors[key])}
            onClick={() => search.toggleColor(key)}
          />
        ))}
      </div>

      <ManaValueChips
        selected={search.manaValues}
        onToggle={search.toggleManaValue}
        disabled={(value) =>
          optionDisabled(facets?.manaValues, String(value), search.manaValues.includes(value))
        }
        // The chip hands its own label back, so "8 or more" is spelled in one place.
        title={(value, label) => facetTitle(label, facets?.manaValues[String(value)])}
      />

      <SetCombobox selected={search.sets} onToggle={search.toggleSet} counts={facets?.sets} />

      <label htmlFor="card-search-format" className="sr-only">
        Format
      </label>
      <select
        id="card-search-format"
        value={search.format}
        onChange={(e) => search.setFormat(e.target.value)}
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "bg-surface px-2",
          search.format ? "border-accent text-accent" : "border-border text-dim",
        )}
      >
        {/* Pinned above the sorted list rather than sorted into it: it is the answer "no
            filter" and not a format, so it belongs where a reader reaches for it blind —
            first — whatever the alphabet and the facets do to the seven below. */}
        <option value="">Any format</option>
        {formatOptions.map((f) => (
          // The one place a real `disabled` is right: `<option disabled>` is native, and a
          // listbox option is not a tab stop there is anything to lose. No count rides here
          // — a `title` on an `<option>` is not drawn by Windows' native dropdown, so it
          // would be a sentence nobody can read.
          <option key={f.value} value={f.value} disabled={f.disabled}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Last of the filters, because it is the only one that is not a statement about the
          card: everything left of it describes cardboard, and this describes the reader's
          relationship to it. One chip and three states — the word on it is what says which
          of the two questions is being asked, so an unpressed "Owned" cannot be mistaken
          for a pressed "Missing".

          **Never greyed**, whatever its counts say: greying a chip mid-cycle would strand
          whoever is in it. The tooltip counts what the chip's *word* names, which is one
          rule reading correctly in both directions — unpressed, it is what pressing would
          give; pressed, it is what the reader is already looking at. */}
      <ToggleChip
        label={search.owned === false ? "Missing" : "Owned"}
        pressed={search.owned !== undefined}
        title={facetTitle(
          search.owned === false ? "Missing" : "Owned",
          search.owned === false ? facets?.owned.missing : facets?.owned.owned,
        )}
        onClick={search.toggleOwned}
      />

      {/* Nothing is drawn until there is something to clear — the rule lives in the
          control, so every view that offers a reset offers the same one. */}
      <ResetAll count={search.activeCount} onReset={search.resetAll} />

      {/* A view mode rather than a filter, so it sits past the reset with the layout pair
          rather than among the statements about which cards to show — and, like them, it
          is untouched by Reset all. The search answers "which cards exist"; this is the way
          through to "which printings", which is otherwise the card pane's question. */}
      <ToggleChip
        label="All printings"
        pressed={search.allPrintings}
        onClick={search.toggleAllPrintings}
      />

      {/* Its neighbour's other half, and it rides here for the same reason: both say what
          there is to look *through* rather than what to look for, so both sit past the reset
          and both survive it.

          One title in both states rather than two, exactly as the Owned chip does it — the
          sentence names what the chip's word names, which reads correctly whether the reader
          is about to press it or is already inside it. It leads with the visible label
          because the `title` is the accessible name too (WCAG 2.5.3), and it says which
          cards it means: "unplayable" is otherwise easy to read as "banned in my format",
          which is a different and much larger set of cards.

          **It says "legal nowhere" rather than "legal in no format" deliberately.** The word
          `format` names the select five controls to the left, and an accessible name carrying
          it makes `getByLabelText(/format/i)` — which four tests in `SearchPage.test.tsx` use
          to reach that select — match two controls instead of one. Two names on one row
          sharing the word that identifies one of them is worth avoiding for a reader too. */}
      <ToggleChip
        label="Unplayable"
        pressed={search.unplayable}
        title="Unplayable — art cards, tokens and other printings that are legal nowhere"
        onClick={search.toggleUnplayable}
      />

      {layoutToggle && <ViewToggle />}
    </div>
  );
}

/** The layout pair, bound to the search's own preference — the collection keeps a separate
 *  one, because a search is for looking at cards and a collection for counting them. */
function ViewToggle() {
  const view = useAppStore((s) => s.searchView);
  const setSearchView = useAppStore((s) => s.setSearchView);
  return <LayoutToggle view={view} onChange={setSearchView} />;
}
