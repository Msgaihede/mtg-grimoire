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
import type { MarketplaceId } from "@/lib/marketplace";
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
 * **`everything` drops every row-narrowing filter and keeps `marketplace`.** `marketplace` sits
 * inside the same `filters` object as `text`/`sets`/`finishes`/… (`useCollection.ts`,
 * `useWishlist.ts`), but it does not decide *which cards appear* — it decides which price a row
 * is quoted at, and it is not one of the filter bar's own controls, so a reader ticking "ignoring
 * the filters" has no reason to read it as one of the things being ignored. `useWishlist.ts`
 * already says this about the same field, for the same reason: "The marketplace is always sent:
 * it is which prices the list is quoting rather than a refinement that can be left off." Dropping
 * it too would silently reprice every exported row at the backend's default (TCGplayer) for a
 * reader who had picked Card Kingdom, Mana Pool or Cardmarket, with nothing in the dialog saying
 * so — `everythingFilters` below is the one place that split is made, so both surfaces read it the
 * same way.
 *
 * **Stripping is not always sufficient, and the wishlist's `folderId` is the exception.** Every
 * other field this drops is a row-narrowing filter in the ordinary sense: absent, it asks nothing
 * and the backend returns every row. `folderId` is not that shape — since `64453bd`, an absent
 * `folderId` is itself a filter, "the root wishlist", because the backend cannot tell "no folder
 * named" apart from "the root folder named" any other way. So stripping `folderId` here does not
 * widen the question to everything; it silently narrows it to the root. The wishlist sweep below
 * has to say "every folder" a second, different way — `flatten: true` — rather than trusting this
 * function's usual "absent means unfiltered" reading of a dropped field.
 */
function everythingFilters<F extends { marketplace?: MarketplaceId }>(
  filters: F,
): Pick<F, "marketplace"> {
  return { marketplace: filters.marketplace } as Pick<F, "marketplace">;
}

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
    // another's cache. **`marketplace` rides along on the `everything` arm rather than being
    // implied by `filters`** — that arm's key drops `filters` entirely (see `everythingFilters`),
    // so without this a marketplace switch would collapse to the same `[surface, "export",
    // "everything"]` key it had before the switch and hand back the previous sweep's cards,
    // priced at the marketplace the reader had left — the same wrong-price symptom the request
    // fix above exists to prevent, arriving through the cache instead of the request. The
    // filtered arm needs nothing extra: `filters` already carries `marketplace` as one of its
    // own fields.
    queryKey: everything
      ? [surface, "export", "everything", filters.marketplace]
      : [surface, "export", filters],
    enabled,
    queryFn: async () => {
      setProgress({ loaded: 0, total: 0 });
      const onProgress = (loaded: number, total: number) => setProgress({ loaded, total });
      if (surface === "collection") {
        const collectionFilters = filters as CollectionScopeFilters;
        const rows = await sweep(
          (limit, offset) =>
            ipc.collectionList({
              ...(everything ? everythingFilters(collectionFilters) : collectionFilters),
              limit,
              offset,
            }),
          onProgress,
        );
        return rows.map(fromCollectionRow);
      }
      const wishlistFilters = filters as WishlistScopeFilters;
      const rows = await sweep(
        (limit, offset) =>
          ipc.wishlistList({
            // `everythingFilters` strips `folderId` along with every other row-narrowing
            // filter, but an absent `folderId` means "the root wishlist" rather than "no
            // folder filter" (`WishlistQuery.folderId`'s doc comment). On this surface
            // "everything" has to mean *every folder*, and the only field that says that is
            // `flatten` — so it rides along explicitly rather than being left to fall out of
            // the strip above, which would otherwise silently narrow "everything" to the root.
            ...(everything ? { ...everythingFilters(wishlistFilters), flatten: true } : wishlistFilters),
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
 * Where on its surface a sweep is standing — the whole of what the two sentences below need in
 * order to name the thing doing the narrowing.
 *
 * **Two bits rather than one, because the top level is a narrowing with no name.** On the
 * wishlist an absent `folderId` means "the wishes filed nowhere" rather than "every wish"
 * (`WishlistQuery.folderId`, and `everythingFilters` above at length), so a reader standing at
 * the root of a cabinet holding twenty drawers is looking at a sweep that leaves all twenty out:
 * `folder` is `null` there and `narrows` is still `true`. Both off is a surface with no filing to
 * speak of — the collection, a wishlist nobody has filed, and a *flattened* one, where the level
 * on screen already is every folder.
 */
export interface ExportFiling {
  /** The folder the reader is standing in, or `null` — at the top level, and for a folder the
   *  page cannot name because another window deleted it between two reads. */
  folder: string | null;
  /** Whether the filing is narrowing this sweep at all. */
  narrows: boolean;
}

/**
 * "1,204 cards matching your filters" / "3 cards in Ordered matching your filters" /
 * "3,000 cards, ignoring your filters and folders" — already pluralised, which is what
 * {@link ExportDialogProps.scope}'s `label` asks its caller for.
 *
 * One function rather than one written out in each page: `CollectionPage` and `WishlistPage`
 * compose the identical sentence around a different noun for what they are exporting, and a
 * count is the one part of it neither page should be trusted to pluralise twice.
 *
 * **`filing` is why the sentence is not just about filters.** Standing inside `Ordered` with
 * nothing typed and no chip pressed, the old line read `3 cards matching your filters` — true
 * about the filters and silent about the drawer, which was the only thing narrowing anything.
 * The count was always right; the sentence just did not name what produced it.
 */
export function scopeLabel(total: number, everything: boolean, filing?: ExportFiling): string {
  const noun = total === 1 ? "card" : "cards";
  const count = total.toLocaleString();
  // With the escape hatch on there is no drawer left to name — the sweep really is every folder
  // — so what the sentence owes the reader is the other half: that the filing was set aside too.
  if (everything) return `${count} ${noun}, ignoring your filters${andFolders(filing)}`;
  // The top level is deliberately unnamed here. It has no word a reader would recognise that is
  // not also the word for the whole list ("your wishlist" is the dialog's own title), and
  // "3 cards in Wishlist" would read as the whole of it rather than as the level. What says the
  // drawers are being left out at the root is {@link everythingLabel}'s offer to include them.
  const where = filing?.folder ? ` in ${filing.folder}` : "";
  return `${count} ${noun}${where} matching your filters`;
}

/**
 * The escape hatch's own words — {@link ExportDialogProps.scope}'s `everythingLabel`.
 *
 * **Here rather than written into the dialog, so both sentences are decided in one place.** The
 * checkbox and the count line above are one statement made twice, and the dialog holding half of
 * it is how the half about folders came to be missing from only one of them.
 */
export function everythingLabel(filing?: ExportFiling): string {
  return `Export everything, ignoring the filters${andFolders(filing)}`;
}

/** The clause both sentences add where the reader's filing is part of what is being set aside. */
function andFolders(filing: ExportFiling | undefined): string {
  return filing?.narrows === true ? " and folders" : "";
}
