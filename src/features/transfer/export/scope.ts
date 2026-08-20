/**
 * A filter becomes a whole list.
 *
 * The collection and the wishlist are `useInfiniteQuery` at 100 rows a page, so what is in
 * memory is a **scroll position** rather than a decision. Exporting that would silently truncate
 * a 3,000-card collection to the two hundred rows the reader happened to have scrolled past, and
 * the file would look complete.
 *
 * 500 a page rather than the list's own 100: six round trips for a 3,000-card collection instead
 * of thirty, and nothing here is drawing rows so the page size costs only memory.
 *
 * **The stop condition is a short page, not the total.** A write landing mid-sweep moves the
 * total, and believing it would either drop the tail or loop forever — the same reasoning
 * `useCollection`'s own `getNextPageParam` documents.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, type CollectionQuery, type WishlistQuery } from "@/lib/ipc";
import { fromCollectionRow, fromWishRow, type TransferCard } from "../TransferCard";

export const SWEEP_PAGE = 500;

export async function sweep<TRow>(
  page: (limit: number, offset: number) => Promise<{ items: TRow[]; total: number }>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<TRow[]> {
  const all: TRow[] = [];
  for (;;) {
    const { items, total } = await page(SWEEP_PAGE, all.length);
    all.push(...items);
    onProgress?.(all.length, total);
    if (items.length < SWEEP_PAGE) return all;
  }
}

/** The two surfaces this file knows how to sweep. Not `"deck"`: a deck is already in memory in
 *  full, and `ExportDialog`'s `cards` prop is a caller's argument for that surface — see
 *  `DeckEditor`'s `exportSubject`. */
export type SweepSurface = "collection" | "wishlist";

/** Everything a collection sweep can be asked for, minus the paging `useExportScope` owns. */
export type CollectionScopeFilters = Omit<CollectionQuery, "limit" | "offset" | "sort">;
/** Everything a wishlist sweep can be asked for, minus the paging `useExportScope` owns. */
export type WishlistScopeFilters = Omit<WishlistQuery, "limit" | "offset" | "sort">;

/** What `useExportScope` hands the dialog — {@link ExportDialogProps.scope} without the label,
 *  which is composed by the caller (see {@link scopeLabel}) because only the caller knows the
 *  noun ("your collection", "your wishlist"). */
export interface ExportScope {
  cards: TransferCard[];
  /** Rows in scope — the filtered count once the sweep starts answering, the true count once it
   *  finishes. Never the *filter bar*'s own total: with `everything` on, the two answer a
   *  different question, and this is the one the sweep is actually reading. */
  total: number;
  /** Still sweeping — `ExportDialog`'s `scope.loading` disables Copy and Save as… on it, the same
   *  guard `saving` already uses, so a reader cannot save a file the sweep has not finished
   *  filling in. */
  loading: boolean;
  everything: boolean;
  setEverything: (everything: boolean) => void;
}

/** No cards until the first answer lands — one identity, reused, rather than a fresh empty array
 *  every render for something nothing may write to. */
const NO_CARDS: TransferCard[] = [];

/**
 * The paged sweep, wired to one page's filters and turned into `TransferCard`s.
 *
 * **`enabled` is not in the brief's two-argument sketch, and it is load-bearing rather than
 * decorative.** `ExportDialog` is mounted unconditionally beside its opener — same as every
 * other dialog in this app (`DeckEditor`'s `ExportDialog`, every `Dialog` host) — so that its own
 * scrim can fade out instead of the whole thing vanishing when `open` flips to `false`. That
 * means this hook runs on *every* render of the page, filters and all, whether or not Export was
 * ever pressed; without a gate a reader who has never opened the dialog would still be paying for
 * a sweep of their whole collection on every filter keystroke, which is exactly what "nothing
 * downloads until asked" (this repo's price-feed rule, applied here) forbids. The caller passes
 * its own `exporting` flag.
 *
 * **`everything` drops every filter, marketplace included** — `{}` rather than `filters` with
 * the narrowing fields stripped out, because "ignoring the filters" is the whole of what the
 * toggle promises and a half-ignored filter is not that. A row's price then comes back quoted at
 * the backend's own default (TCGplayer), which is worth knowing rather than worth hiding.
 */
export function useExportScope(
  surface: "collection",
  filters: CollectionScopeFilters,
  enabled: boolean,
): ExportScope;
export function useExportScope(
  surface: "wishlist",
  filters: WishlistScopeFilters,
  enabled: boolean,
): ExportScope;
export function useExportScope(
  surface: SweepSurface,
  filters: CollectionScopeFilters | WishlistScopeFilters,
  enabled: boolean,
): ExportScope {
  const [everything, setEverything] = useState(false);
  // The sweep's own running answer, updated from inside `queryFn` through `sweep`'s
  // `onProgress` — the only way to say "1,204 of 3,000 so far" before the whole set has
  // landed, since `useQuery`'s `data` does not exist until the promise it wraps resolves.
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });

  const query = useQuery({
    // `everything` is in the key on purpose: switching the toggle is switching *what* is being
    // asked for, exactly as a filter change is, and the two must not be served from one
    // another's cache.
    queryKey: [surface, "export", everything ? "everything" : filters],
    enabled,
    queryFn: async () => {
      setProgress({ loaded: 0, total: 0 });
      const onProgress = (loaded: number, total: number) => setProgress({ loaded, total });
      if (surface === "collection") {
        const rows = await sweep(
          (limit, offset) =>
            ipc.collectionList({
              ...(everything ? {} : (filters as CollectionScopeFilters)),
              limit,
              offset,
            }),
          onProgress,
        );
        return rows.map(fromCollectionRow);
      }
      const rows = await sweep(
        (limit, offset) =>
          ipc.wishlistList({
            ...(everything ? {} : (filters as WishlistScopeFilters)),
            limit,
            offset,
          }),
        onProgress,
      );
      return rows.map(fromWishRow);
    },
  });

  const cards = query.data ?? NO_CARDS;
  return {
    cards,
    // The finished count once it is known; the sweep's own running total until then, which is
    // the honest number to caption a still-loading dialog with.
    total: query.data ? cards.length : progress.total,
    loading: query.isFetching,
    everything,
    setEverything,
  };
}

/**
 * "1,204 cards matching your filters" / "3,000 cards, ignoring your filters" — already
 * pluralised, which is what {@link ExportDialogProps.scope}'s `label` asks its caller for.
 *
 * One function rather than one written out in each page: `CollectionPage` and `WishlistPage`
 * compose the identical sentence around a different noun for what they are exporting, and a
 * count is the one part of it neither page should be trusted to pluralise twice.
 */
export function scopeLabel(total: number, everything: boolean): string {
  const noun = total === 1 ? "card" : "cards";
  const count = total.toLocaleString();
  return everything ? `${count} ${noun}, ignoring your filters` : `${count} ${noun} matching your filters`;
}
