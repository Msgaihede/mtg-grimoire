import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { MANA_KEYS } from "@/lib/mana";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
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
            onClick={() => search.toggleColor(key)}
          />
        ))}
      </div>

      <ManaValueChips selected={search.manaValues} onToggle={search.toggleManaValue} />

      <SetCombobox selected={search.sets} onToggle={search.toggleSet} />

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
        <option value="">Any format</option>
        {FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Last of the filters, because it is the only one that is not a statement about the
          card: everything left of it describes cardboard, and this describes the reader's
          relationship to it. One chip and three states — the word on it is what says which
          of the two questions is being asked, so an unpressed "Owned" cannot be mistaken
          for a pressed "Missing". */}
      <ToggleChip
        label={search.owned === false ? "Missing" : "Owned"}
        pressed={search.owned !== undefined}
        onClick={search.toggleOwned}
      />

      {/* Nothing is drawn until there is something to clear — the rule lives in the
          control, so every view that offers a reset offers the same one. */}
      <ResetAll count={search.activeCount} onReset={search.resetAll} />

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
