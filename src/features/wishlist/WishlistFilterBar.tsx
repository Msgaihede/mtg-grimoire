import {
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  LayoutToggle,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { FOCUS } from "@/lib/focus";
import { sortOptions } from "@/lib/options";
import { useAppStore } from "@/lib/store";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
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
 *
 * `folderId` and `flatten` are not filters and draw nothing here beyond the Flatten chip
 * itself — the folder cards and the breadcrumb this bar shares its row with are the page's, not
 * this component's, `useWishlist.ts`'s doc comment says why.
 */
export function WishlistFilterBar({
  wishlist,
  onNewFolder,
}: {
  wishlist: Wishlist;
  /**
   * Opens the "new folder" field beside the folder cards. Not owned here: this bar only offers
   * the button, the write lives on the page.
   *
   * **It is handed the button**, `FolderTree.onOpenNew`'s arrangement and for its reason: the
   * field the page opens is drawn somewhere else on the page, so the page has nothing else to
   * hand the caret back to when Escape closes it — and an element that unmounts with the caret
   * on it drops focus to `<body>`, after which the next Tab restarts from the top of the app.
   */
  onNewFolder: (opener: HTMLButtonElement) => void;
}) {
  const view = useAppStore((s) => s.wishlistView);
  const setWishlistView = useAppStore((s) => s.setWishlistView);
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
        // **Required, not a courtesy.** Escape is the wishlist's way *out of a folder* now, and
        // Chromium empties an `<input type="search">` on Escape all by itself **without** setting
        // `defaultPrevented` — so one press in a box with a name in it would clear the box *and*
        // walk the reader up a drawer, and the list they were filtering would be gone with the
        // filter. `clearFieldOnEscape` claims the press only while there is something to empty:
        // a full box owns one press, an empty box owns none and the folder rung gets it. jsdom
        // does not implement the native clear, so only this half of it can go red here.
        onKeyDown={(e) => clearFieldOnEscape(e, wishlist.text, () => wishlist.setText(""))}
        placeholder="Search your wishlist…"
        // Capped where the other two views let it take the whole row: they fill what is left
        // with chips, and this one has two controls — 780px of empty search box over a list
        // of eight is a toolbar pretending to be busy.
        // `FILTER_FIELD` and not `FILTER_CONTROL`: the row's chips dip 3% under the press and a
        // box the reader types into must not, or the native ✕ slides out from under the pointer
        // clearing it. Issue #179 — the reason is on the constant.
        className={cn(
          FILTER_FIELD,
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

      {/* On, it ignores the filing entirely: no folder cards, no drill-down, and every wish in
          the list at once, each captioned with the folder it is filed in instead — the only
          way a reader sees a card's folder without opening it. One press either way, since
          there is no third state to walk. */}
      <ToggleChip label="Flatten" pressed={wishlist.flatten} onClick={wishlist.toggleFlatten} />

      {/* Hidden while flattened: a flattened list has no current folder to create one inside.
          Styled like the page's own Import/Export buttons rather than as a chip, because this
          opens a field on the page instead of toggling a state that lives here. */}
      {!wishlist.flatten && (
        <button
          type="button"
          onClick={(e) => onNewFolder(e.currentTarget)}
          className={cn("h-8 rounded-md border border-border px-3 text-sm hover:bg-surface", FOCUS)}
        >
          + New folder
        </button>
      )}

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
        // Left-packed with the filters, where it used to be pushed to the far end of the row on
        // the grounds that this view had no layout toggle to put there. It has one now, and the
        // toggle carries its own `ml-auto` — so the row reads the way the other two do: what is
        // on the left is *what you are looking at*, and the one control on the right is *how you
        // are looking at it*.
        //
        // Never gold: a sort is always on — there is no "unsorted" — so a state colour here
        // would say "a filter is active" about a control that cannot be inactive.
        className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
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

      {/* The same two buttons the search and the collection carry, in the same corner and
          reading the same three words — one wall, one table, one place to switch. It writes
          `wishlistView`, which is its own field: the three lists are looked at for three
          different reasons, and a reader who put their collection in a table was not saying
          anything about their shopping list. */}
      <LayoutToggle view={view} onChange={setWishlistView} />
    </div>
  );
}
