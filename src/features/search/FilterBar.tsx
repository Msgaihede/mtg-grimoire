import { LayoutGrid, Rows3 } from "lucide-react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ManaChip,
  ManaValueChips,
  ResetAll,
} from "@/components/FilterChips";
import { MANA_KEYS } from "@/lib/mana";
import { useAppStore, type SearchView } from "@/lib/store";
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
export function FilterBar({ search }: { search: CardSearch }) {
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

      {/* Nothing is drawn until there is something to clear — the rule lives in the
          control, so every view that offers a reset offers the same one. */}
      <ResetAll count={search.activeCount} onReset={search.resetAll} />

      <ViewToggle />
    </div>
  );
}

/** The two layouts, and the words for them a reader would use. */
const LAYOUTS = [
  { id: "grid", label: "Card view", Icon: LayoutGrid },
  { id: "table", label: "Table view", Icon: Rows3 },
] as const satisfies readonly { id: SearchView; label: string; Icon: typeof LayoutGrid }[];

/**
 * How the results are drawn — art, or a table.
 *
 * Not a filter, and it rides the filter row anyway: it is the only other control that
 * governs the list below, and a second row holding one pair of buttons would be a whole
 * band of chrome above the art. `ml-auto` sends it to the far end so the filters still
 * read as a group without it, and the pair is icon-only because two 36px squares carry
 * "grid or rows" at a glance in a way two words on a busy row do not.
 */
function ViewToggle() {
  const view = useAppStore((s) => s.searchView);
  const setSearchView = useAppStore((s) => s.setSearchView);

  return (
    <div role="group" aria-label="Result layout" className="ml-auto flex gap-1">
      {LAYOUTS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setSearchView(id)}
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
