import { FILTER_CONTROL, FILTER_FOCUS, ResetAll, ToggleChip } from "@/components/FilterChips";
import { sortOptions } from "@/lib/options";
import { cn } from "@/lib/utils";
import { WISHLIST_SORTS, type Wishlist, type WishlistSort } from "./useWishlist";

/**
 * Every filter the wishlist offers, in one row that never wraps.
 *
 * Three controls where the collection has fourteen — four on the rare day a sync has left
 * something behind. The colour chips, the mana values and the set picker are all absent on
 * purpose: they filter a list of thousands, and this one is a list of tens read by name. What
 * is left is the box you type a name into, the one question a shopping list is for, and how
 * to order it.
 */
export function WishlistFilterBar({ wishlist }: { wishlist: Wishlist }) {
  // Drawn only where it has something to filter. A wishlist is flagged by the reconciler and
  // most never are, so a permanent chip here would be a control that spends its whole life
  // saying nothing — the rule the collection's banner follows, applied to a filter. It stays
  // while the filter is on, including on the complement, where by definition no row on screen
  // carries a flag and the chip is the only way back off.
  const offered = wishlist.needsReview !== undefined || wishlist.rows.some((r) => r.needsReview);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="wishlist-text" className="sr-only">
        Search your wishlist
      </label>
      <input
        id="wishlist-text"
        type="search"
        value={wishlist.text}
        onChange={(e) => wishlist.setText(e.target.value)}
        placeholder="Search your wishlist…"
        // Capped where the other two views let it take the whole row: they fill what is left
        // with chips, and this one has two controls — 780px of empty search box over a list
        // of eight is a toolbar pretending to be busy.
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "min-w-56 max-w-md flex-1 border-border bg-surface px-3 placeholder:text-dim",
          "focus:border-accent",
        )}
      />

      {/* One chip, three states, and the word on it is what says which is on. "Still missing"
          first, because it is the question the list is usually open for — the search's twin
          starts from the other end for the same reason. */}
      <ToggleChip
        label={wishlist.fulfilled === true ? "Fulfilled" : "Still missing"}
        pressed={wishlist.fulfilled !== undefined}
        onClick={wishlist.toggleFulfilled}
      />

      {/* The other half of what the flagged band under a row says: the band tells you a wish
          needs looking at, and this is how you ask for only those. Same three states and the
          same rule about the word on it — "Not flagged" is the complement, which is where the
          reader goes once the flagged ones are dealt with. */}
      {offered && (
        <ToggleChip
          label={wishlist.needsReview === false ? "Not flagged" : "Needs review"}
          pressed={wishlist.needsReview !== undefined}
          onClick={wishlist.toggleNeedsReview}
        />
      )}

      {/* Always drawn, greyed when there is nothing to clear — the rule lives in the control,
          so every view that offers a reset offers the same one. */}
      <ResetAll count={wishlist.activeCount} onReset={wishlist.resetAll} />

      <label htmlFor="wishlist-sort" className="sr-only">
        Sort
      </label>
      {/* The same state the table's headers drive, from the other end. Picking here
          *replaces* the sort with that one term; the headers refine and extend it. It
          survived the headers becoming sortable because two of its orders have no column to
          press: "Recently added", and the unit price, which is the Cost column's other
          question. */}
      <select
        id="wishlist-sort"
        value={wishlist.sortSelection}
        onChange={(e) => wishlist.setSortKey(e.target.value as WishlistSort)}
        // At the far end of the row, where the other two views put their layout toggle: what
        // is on the left is *what you are looking at*, and what is on the right is *how you
        // are reading it*. This view has no layout to choose, so the sort is the whole of the
        // right-hand group.
        //
        // Never gold: a sort is always on — there is no "unsorted" — so a state colour here
        // would say "a filter is active" about a control that cannot be inactive.
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "ml-auto border-border bg-surface px-2 text-dim",
        )}
      >
        {/* Reachable by reading only: picking it would be picking the sort you already
            have. Present because a select showing nothing at all looks broken, and because
            "Custom…" is the honest name for a sort built from a header this control has no
            option for.

            Pinned first, outside the sorted list below: it is the state of the control
            rather than an order to pick. `disabled` and not `aria-disabled` — the house
            rule's one exception is a native `<option>`. */}
        {wishlist.sortSelection === "" && (
          <option value="" disabled>
            Custom…
          </option>
        )}
        {/* Alphabetical by label, like every other option list (`lib/options.ts`) — a
            reader looks up the words on screen. `WISHLIST_SORTS` is declared in the order
            the orders were reasoned about; the display order is decided here. */}
        {sortOptions(WISHLIST_SORTS, (s) => s.label).map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
