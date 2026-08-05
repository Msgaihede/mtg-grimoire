import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { FORMATS } from "@/features/search/useCardSearch";
import { SetCombobox } from "@/features/search/SetCombobox";
import { CONDITIONS, CONDITION_LABEL } from "@/lib/conditions";
import { FINISHES, FINISH_LABEL } from "@/lib/finish";
import { MANA_KEYS } from "@/lib/mana";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { COLLECTION_SORTS, type Collection, type CollectionSort } from "./useCollection";

/**
 * Every filter the collection view offers, in two rows.
 *
 * Thirty controls in one `flex-wrap` would break wherever they happened to run out of
 * window, which is how a filter row ends up with a lone format picker stranded on a line of
 * its own. Two rows, and the line between them is a real one: the first holds what is
 * **printed on the card** — its name, its colours, its cost, its set, in the same order and
 * the same controls as the search's row, because a reader who has learned that row once
 * should not have to learn it twice — and the second holds everything that is *about* a
 * card without being on it: which formats it is legal in this month, which copy of it this
 * is, and how the list should be read.
 */
export function CollectionFilterBar({ collection }: { collection: Collection }) {
  const view = useAppStore((s) => s.collectionView);
  const setCollectionView = useAppStore((s) => s.setCollectionView);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor="collection-text" className="sr-only">
          Search your collection
        </label>
        <input
          id="collection-text"
          type="search"
          value={collection.text}
          onChange={(e) => collection.setText(e.target.value)}
          placeholder="Search your collection…"
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
              pressed={collection.colors.includes(key)}
              onClick={() => collection.toggleColor(key)}
            />
          ))}
        </div>

        <ManaValueChips selected={collection.manaValues} onToggle={collection.toggleManaValue} />

        <SetCombobox selected={collection.sets} onToggle={collection.toggleSet} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor="collection-format" className="sr-only">
          Format
        </label>
        <select
          id="collection-format"
          value={collection.format}
          onChange={(e) => collection.setFormat(e.target.value)}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            "bg-surface px-2",
            collection.format ? "border-accent text-accent" : "border-border text-dim",
          )}
        >
          <option value="">Any format</option>
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>

        <div role="group" aria-label="Finish" className="flex gap-1">
          {FINISHES.map((f) => (
            <ToggleChip
              key={f}
              label={FINISH_LABEL[f]}
              pressed={collection.finishes.includes(f)}
              onClick={() => collection.toggleFinish(f)}
            />
          ))}
        </div>

        {/* The grades as they are printed on every listing the cards came from. Spelled out
            in the accessible name and the tooltip, because `DMG` is vocabulary and five
            spelled-out grades are 400px of chrome above the table they filter. */}
        <div role="group" aria-label="Condition" className="flex gap-1">
          {CONDITIONS.map((c) => (
            <ToggleChip
              key={c}
              label={c}
              hint={CONDITION_LABEL[c].toLowerCase()}
              pressed={collection.conditions.includes(c)}
              onClick={() => collection.toggleCondition(c)}
            />
          ))}
        </div>

        <ToggleChip
          label="Needs review"
          pressed={collection.needsReview}
          onClick={() => collection.setNeedsReview(!collection.needsReview)}
        />

        <label htmlFor="collection-sort" className="sr-only">
          Sort
        </label>
        <select
          id="collection-sort"
          value={collection.sort}
          onChange={(e) => collection.setSort(e.target.value as CollectionSort)}
          // Never gold: a sort is always on — there is no "unsorted" — so a state colour
          // here would say "a filter is active" about a control that cannot be inactive.
          className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
        >
          {COLLECTION_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Nothing is drawn until there is something to clear — the rule lives in the
            control, so every view that offers a reset offers the same one. */}
        <ResetAll count={collection.activeCount} onReset={collection.resetAll} />

        <LayoutToggle view={view} onChange={setCollectionView} />
      </div>
    </div>
  );
}
