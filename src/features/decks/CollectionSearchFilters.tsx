import {
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { COLLECTION_SORTS, type CollectionSort } from "@/features/collection/useCollection";
import { FORMATS } from "@/features/search/useCardSearch";
import { MANA_KEYS } from "@/lib/mana";
import { sortOptions } from "@/lib/options";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import type { CollectionSearch } from "./useCollectionSearch";

/**
 * The deck panel's collection filters — **`FilterBar`'s row, over the reader's own binder**.
 *
 * ## Why this is not `FilterBar`
 *
 * `FilterBar`'s prop is a `CardSearch` — `ReturnType<typeof useCardSearch>` — and that hook *is* a
 * `search_cards` with no `enabled` to switch it off. Drawing it here would run the 116 k-row card
 * search for every reader who never leaves their binder, which is the exact cost the panel's
 * two-component split exists to have removed. So this row is built out of
 * `@/components/FilterChips`, which is the sanctioned reuse: that module owns the controls, and
 * each surface owns which of them it offers and how they lay out. `CollectionFilterBar` is the
 * other surface that does this, for the same reason.
 *
 * ## Why these controls and not the other four
 *
 * The card search offers eight groups; this offers five, and each absence is a fact about a
 * collection rather than a shortcut:
 *
 * - **No `Owned`** — every row here is a copy the reader has. A filter whose two states select the
 *   same list is a control that reads as broken.
 * - **No `All printings`** — that switch asks whether to fold a card's printings together, and
 *   these *are* the reader's printings. Folding them would hide which piece of cardboard is being
 *   moved.
 * - **No set combobox** — `SetCombobox` is a popup over thirty-plus options, and this column is
 *   ~193px at the panel's floor. The text box already answers "cards from Dominaria" for anyone
 *   who types the set's name.
 * - **No finish or condition chips** — `CollectionFilterBar` offers eight of them, which is 300px
 *   of chrome for a question the reader is not asking while building a deck. They stay on the
 *   collection page, where the grain is the entry.
 *
 * **`Not in a deck` is the one control here that no other surface has**, and it is what this tab
 * is for: pressed — the default — the list is the copies no deck is holding.
 *
 * ## The width
 *
 * `flex-wrap` on every group, and it is what makes the row safe at the panel's 206px floor rather
 * than a nicety: a flex item cannot shrink below its own min-content, so unwrapped this is an
 * *overhang*, and `DeckEditor`'s page section computes `overflow-x` to `auto` — a horizontal
 * scrollbar across the whole deck builder, which the app's 1024px floor forbids. `src/CLAUDE.md`
 * carries the rule and `ManaValueChips` shipped the bug once already.
 */
export function CollectionSearchFilters({ search }: { search: CollectionSearch }) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <label htmlFor="deck-collection-text" className="sr-only">
        Search your collection
      </label>
      <input
        id="deck-collection-text"
        type="search"
        value={search.text}
        onChange={(e) => search.setText(e.target.value)}
        // **A box with text in it owns one Escape, and an empty one owns none.** This column is
        // docked rather than modal, so a press this box does not take falls through to the
        // editor's `"navigation"` rung and closes the deck — which is right for an empty box and
        // wrong for one the reader was filtering with, since Chromium clears an
        // `<input type="search">` on Escape itself and never sets `defaultPrevented`. The whole
        // argument, and why jsdom can only ever see half of it, is on {@link clearFieldOnEscape}.
        onKeyDown={(e) => clearFieldOnEscape(e, search.text, () => search.setText(""))}
        placeholder="Search your collection…"
        // `FILTER_FIELD` rather than `FILTER_CONTROL`: a box the reader types into must not dip
        // under the press, or Chromium's own ✕ slides out from under the pointer clearing it
        // (issue #179 — the reason is on the constant).
        className={cn(
          FILTER_FIELD,
          FILTER_FOCUS,
          "w-full border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />

      {/* Wider than the other groups' `gap-1`: a pressed chip's ring reaches 4px past its edge,
          and at 4px apart two pressed chips look like one welded object. `CollectionFilterBar`'s
          own measurement, and the pips are the same six controls. */}
      <div role="group" aria-label="Color identity" className="flex flex-wrap gap-1.5">
        {MANA_KEYS.map((key) => (
          <ManaChip
            key={key}
            symbol={key}
            pressed={search.colors.includes(key)}
            onClick={() => search.toggleColor(key)}
          />
        ))}
      </div>

      {/* No facet props on either axis: this bar wires no counts at all, so every chip keeps its
          plain label and nothing greys. `collection_list` has no facet command behind it the way
          `search_cards` does — the counts would be a second query per keystroke over the reader's
          whole binder, for a row of numbers beside a list that is already on screen. */}
      <ManaValueChips
        selected={search.manaValues}
        onToggle={search.toggleManaValue}
        xSelected={search.manaX}
        onToggleX={search.toggleManaX}
      />

      <div className="flex flex-wrap items-center gap-2">
        {/* **The toggle this tab exists for.** Pressed is the default and means "only the copies
            no deck is holding" — the root, a drawer the reader made, and `Recently removed`, which
            are the three places a card is still on the desk. Unpressed shows the spoken-for copies
            too, and pressing Add on one of those is what the confirmation is for.

            One chip rather than a segmented pair: it is one axis with two ends and `aria-pressed`
            is how this app says that. The `hint` is folded into the accessible name, so the
            visible words are contained in it (WCAG 2.5.3). */}
        <ToggleChip
          label="Not in a deck"
          hint="only the copies no deck is holding"
          pressed={search.allocation === "unallocated"}
          onClick={() =>
            search.setAllocation(search.allocation === "unallocated" ? "all" : "unallocated")
          }
        />

        <label htmlFor="deck-collection-format" className="sr-only">
          Format
        </label>
        <select
          id="deck-collection-format"
          value={search.format}
          onChange={(e) => search.setFormat(e.target.value)}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            "bg-surface px-2",
            search.format ? "border-accent text-accent" : "border-border text-dim",
          )}
        >
          {/* Pinned above the sorted list because it is the *absence* of this filter rather than a
              format — `CollectionFilterBar`'s own note, and the same trap: it happens to sort
              first today, so nothing on screen tells the two apart. */}
          <option value="">Any format</option>
          {sortOptions(FORMATS, (f) => f.label).map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>

        {/* **"Sort your collection" rather than "Sort"**, which is what the collection page calls
            its own copy of this control. This one is drawn *inside the deck editor*, whose toolbar
            already has a `Sort` — so two controls a screen reader announces identically would be
            on screen together, and "the second one" is not a thing a reader can ask for. Named the
            way the search box beside it is, for the same reason. */}
        <label htmlFor="deck-collection-sort" className="sr-only">
          Sort your collection
        </label>
        {/* Only the orders this column can act on. There are no sortable headers here to build a
            `Custom…` state out of — that option exists on the collection page because its table's
            headers write the same state from the other end — so every value this select can hold
            is one of its own options and the pinned row is not needed. */}
        <select
          id="deck-collection-sort"
          value={search.sortSelection}
          onChange={(e) => search.setSortKey(e.target.value as CollectionSort)}
          className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
        >
          {sortOptions(COLLECTION_SORTS, (s) => s.label).map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Always drawn, greyed when there is nothing to clear — the rule lives in the control, so
            every view that offers a reset offers the same one. */}
        <ResetAll count={search.activeCount} onReset={search.resetAll} />
      </div>
    </div>
  );
}
