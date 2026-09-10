/**
 * Every query key the home page reads through, in one file.
 *
 * ## Why this file exists
 *
 * The six widgets were written independently against one contract, and three of them needed the
 * same two reads. They agreed — `SummaryWidget` and `CollectionValueWidget` both spelled the
 * collection total, `SummaryWidget` and `WishlistValueWidget` both spelled the wishlist total —
 * and because a key is compared by *value*, agreeing meant TanStack deduped each pair into one
 * fetch. That is the behaviour the page wants and it was held up by nothing: two spellings of one
 * key are one cache entry only for as long as nobody edits either side, and the day one drifts
 * the page quietly costs a second round trip and a second entry that no invalidation keeps in
 * step with the first. Nothing would go red. **One definition per key is the fence**, and
 * `keys.test.tsx` asserts each pair still resolves to one key.
 *
 * ## The rule every key here keeps
 *
 * **A key sits under the root its data already lives under** — `["collection"]`, `["wishlist"]`,
 * `["decks"]`. Every write in this app already ends in `invalidateQueries({ queryKey:
 * ["collection"] })` or one of its two siblings, and `invalidatePricedQueries` sweeps the same
 * roots when a price feed lands, so the dashboard refreshes after an add, a move, a rename or a
 * removal with **no mutation anywhere learning a new key**. A `["home", …]` root would have
 * needed every one of those writes to grow a line, and a `staleTime` would have hidden whichever
 * one was forgotten.
 *
 * It also means the home page shares an entry with the page each figure is about, deliberately:
 * {@link deckListKey} is `useDecks`' own key verbatim, so the gallery and the widget can never
 * come to disagree about how many decks there are, and one read serves both.
 *
 * **A key's shape is load-bearing, and changing one changes what invalidation reaches it.** Two
 * segments look arbitrary and are not: `"home"` in {@link collectionTotalKey} is what keeps the
 * unfiltered total from sharing an entry with `useCollection`'s summary, which asks about the
 * wall the reader is standing at rather than the whole cabinet — both still sit under
 * `["collection", "summary"]`, which is the prefix `CollectionPage` invalidates, so one press
 * refreshes both. And every priced key carries the marketplace id, because it is what decides the
 * number: switching marketplace has to re-issue the read rather than re-render a second field
 * that does not exist.
 *
 * ## The one exception
 *
 * {@link activityKey} sits under `["activity"]`, a root **nothing in this app invalidates** —
 * there is no activity mutation, because the feed is a record of every *other* table's writes.
 * `ActivityWidget` bridges that itself: it holds a marker query under each of the three write
 * roots so each always has something to invalidate, and subscribes to the query cache to turn an
 * `invalidate` action on any of them into an invalidation of its own key. **That bridge is the
 * widget's and stays there** — it is machinery rather than a key, and its two halves have to be
 * read together. This note is here so the exception is visible from the rule.
 *
 * ## What is deliberately not here
 *
 * `FoldersWidget` reads through `useCollectionFolders` and `useWishlistFolders`, which own their
 * own keys — `["collection", "folders"]`, `["collection", "folderSummary", marketplace]` and the
 * two `["wishlist", …]` mirrors. Those already have exactly one definition each, in the hook that
 * fetches them, and re-spelling them here would create the second spelling this file exists to
 * prevent. They keep the rule above; they are named in this paragraph rather than exported below.
 */

import type { QueryKey } from "@tanstack/react-query";

import type { MarketplaceId } from "@/lib/marketplace";

import type { BreakdownDimension } from "./widgets";

/**
 * The whole collection's total, priced at one marketplace — `ipc.collectionSummary` with no
 * filters at all.
 *
 * `"home"` where `useCollection`'s summary carries its filter key: this one asks about the whole
 * cabinet rather than about the wall a reader is standing at, so the two must not share an entry.
 * Read by both `SummaryWidget` and `CollectionValueWidget`, which is one fetch between them.
 */
export const collectionTotalKey = (marketplace: MarketplaceId): QueryKey => [
  "collection",
  "summary",
  "home",
  marketplace,
];

/** The collection sliced one way, priced at one marketplace — `ipc.collectionBreakdown`.
 *  {@link collectionTotalKey}'s reasons, and the dimension is in the key because it is the
 *  question rather than a slice of one answer. */
export const collectionBreakdownKey = (
  dimension: BreakdownDimension,
  marketplace: MarketplaceId,
): QueryKey => ["collection", "breakdown", dimension, marketplace];

/**
 * The wishlist's own total, priced at one marketplace — `ipc.wishlistSummary`.
 *
 * Named for the money rather than for the command so it reads beside {@link collectionTotalKey}:
 * the two are the same question asked of two tables, and each is read by `SummaryWidget` and by
 * the value widget that draws it. One fetch apiece.
 */
export const wishlistTotalKey = (marketplace: MarketplaceId): QueryKey => [
  "wishlist",
  "summary",
  marketplace,
];

/** The same money one dimension at a time. Both the dimension and the marketplace are in the
 *  key: each decides what comes back, so each has to be able to re-issue the read. */
export const wishlistBreakdownKey = (
  dimension: BreakdownDimension,
  marketplace: MarketplaceId,
): QueryKey => ["wishlist", "breakdown", dimension, marketplace];

/**
 * The deck gallery's own key, **reused rather than invented**.
 *
 * `features/decks/useDecks.ts` reads `["decks", "list"]` and every deck write in the app
 * invalidates the `["decks"]` root, so sharing the key means the home page is refreshed by a
 * rename, a delete or a card added from any surface with no mutation learning a new one — and a
 * home page open beside a gallery costs one read between them rather than two. Keep it verbatim.
 */
export const deckListKey: QueryKey = ["decks", "list"];

/**
 * Every deck's worth, at one marketplace.
 *
 * The marketplace is **in the key** because it is what the answer depends on: a switch has to
 * refetch rather than re-render, since Rust answers one price per row. `["decks", …]` again, so
 * the same invalidations reach it. `useDeckPips`' `["decks", "pips"]` is the shape.
 */
export const deckValuesKey = (marketplace: MarketplaceId): QueryKey => [
  "decks",
  "values",
  marketplace,
];

/**
 * Where the activity feed is filed — the module doc's one exception to the root rule.
 *
 * Under `["activity", …]`, which nothing invalidates, and **carrying the limit**, because a limit
 * is part of the question rather than a slice of one answer: fifty rows is not the first fifty of
 * two hundred once a row has been written in between. `ActivityWidget`'s own cache bridge is what
 * keeps it fresh.
 */
export const activityKey = (limit: number): QueryKey => ["activity", "recent", limit];
