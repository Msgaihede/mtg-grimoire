import {
  FILTER_CONTROL,
  FILTER_FIELD,
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
import { sortOptions } from "@/lib/options";
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
          // `FILTER_FIELD` and not `FILTER_CONTROL`: the row's chips dip 3% under the press and
          // a box the reader types into must not, or the native ✕ slides out from under the
          // pointer clearing it. Issue #179 — the reason is on the constant.
          className={cn(
            FILTER_FIELD,
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

        {/* No facet props on either axis: this bar wires no counts at all (see the format
            select below), so every chip here keeps the plain label it has always had and
            nothing greys. The X chip is the same chip the search's row draws, minus the
            sentence a count would add to it. */}
        <ManaValueChips
          selected={collection.manaValues}
          onToggle={collection.toggleManaValue}
          xSelected={collection.manaX}
          onToggleX={collection.toggleManaX}
        />

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
          {/* Pinned above the sorted list because it is the *absence* of this filter and not
              a format. It happens to sort first as well today, so nothing on screen tells the
              two apart — which is the reason to write it down: rename it to "No format
              filter" and, sorted, it would land between Modern and Pauper. */}
          <option value="">Any format</option>
          {/* Alphabetical by the words on screen, the app's one order for an option list
              (`lib/options.ts`): a reader hunting Modern looks under M, not in the position
              somebody decided the formats rank in. `FORMATS` is declared in that ranking
              order and shared with the search, so the sort is done here, at the point of
              display, rather than by reordering a constant two views read.

              No `groups`: unlike the search's copy this select wires no facets, so nothing
              here greys and there is one group to order. */}
          {sortOptions(FORMATS, (f) => f.label).map((f) => (
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

        {/* Three-way, like the wishlist's twin and the search's Owned: the chip's *label* is
            what says which state is on, because an unpressed chip cannot mean "not flagged"
            and also be the same chip that means it when pressed. */}
        <ToggleChip
          label={collection.needsReview === false ? "Not flagged" : "Needs review"}
          pressed={collection.needsReview !== undefined}
          onClick={collection.toggleNeedsReview}
        />

        <label htmlFor="collection-sort" className="sr-only">
          Sort
        </label>
        {/* The same state the table's headers drive, from the other end. Picking here
            *replaces* the sort with that one term; the headers refine and extend it. It
            survived the headers becoming sortable because two of its orders have no column
            to press: "Recently added", which neither table can afford a column for, and
            the unit price, which is the Value column's other question. */}
        <select
          id="collection-sort"
          value={collection.sortSelection}
          onChange={(e) => collection.setSortKey(e.target.value as CollectionSort)}
          // Never gold: a sort is always on — there is no "unsorted" — so a state colour
          // here would say "a filter is active" about a control that cannot be inactive.
          className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
        >
          {/* Reachable by reading only: picking it would be picking the sort you already
              have. Present because a select showing nothing at all looks broken, and
              because "Custom…" is the honest name for a sort built from headers this
              control has no option for.

              Pinned first, outside the sorted list below: it is the state of the control
              rather than an order to pick, and a reader who sees it needs to see it without
              hunting. `disabled` and not `aria-disabled`: an `<option>` is the house rule's
              one exception, because the reason behind that rule — a disabled control leaves
              the tab order — is about something that was in it to begin with. */}
          {collection.sortSelection === "" && (
            <option value="" disabled>
              Custom…
            </option>
          )}
          {/* Alphabetical by label, like every other option list (`lib/options.ts`).
              `COLLECTION_SORTS` is declared in the order the orders were reasoned about;
              the display order is decided here. */}
          {sortOptions(COLLECTION_SORTS, (s) => s.label).map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Always drawn, greyed when there is nothing to clear — the rule lives in the
            control, so every view that offers a reset offers the same one. */}
        <ResetAll count={collection.activeCount} onReset={collection.resetAll} />

        <LayoutToggle view={view} onChange={setCollectionView} />
      </div>
    </div>
  );
}
