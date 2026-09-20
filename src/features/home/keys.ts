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
 * ## The roots that are not those three
 *
 * {@link activityKey} sits under `["activity"]`, a root **nothing in this app invalidates** —
 * there is no activity mutation, because the feed is a record of every *other* table's writes.
 * `ActivityWidget` bridges that itself: it holds a marker query under each of the three write
 * roots so each always has something to invalidate, and subscribes to the query cache to turn an
 * `invalidate` action on any of them into an invalidation of its own key. **That bridge is the
 * widget's and stays there** — it is machinery rather than a key, and its two halves have to be
 * read together. This note is here so the exception is visible from the rule.
 *
 * {@link recentCardsKey} sits under {@link RECENT_CARDS_ROOT}, and it is the opposite case: a
 * root with **exactly one writer**. Opening a card is not a write to the collection, the wishlist
 * or a deck, so none of their invalidations has any business reaching it — and filing it under
 * `["collection"]` would refetch the strip after every add while leaving it stale after the one
 * press that actually changes it. `CardDetailModal`'s recorder invalidates this root when
 * `record_recent_card` lands, which is the whole of what keeps it fresh.
 *
 * {@link stickyNotesKey} sits under `["stickyNotes"]`, and it is {@link recentCardsKey}'s case
 * with every writer in one file. `sticky_notes` is a table **no other query in this app reads**,
 * so there is no root its data already lives under and the rule above has nothing to point at.
 * Filing it under `["collection"]` instead would re-read every note after each add to the binder
 * and leave it stale after the four presses that actually change one — and those four are all
 * `useStickyNotes`' own, which is what lets one key and one invalidation be the whole of it.
 * `crossWindow.ts` maps `sticky_notes` to exactly this key, so a note written in another window
 * lands here too. A heading counting these exceptions stood here until a third and a fourth
 * arrived within a day of each other.
 *
 * {@link NEW_PRINTINGS_ROOT} is the third, and it is the second one's case rather than the
 * first's. The feed's answer is half `deck_cards` and half the corpus, so `["decks"]` is the root
 * it *looks* like it belongs under — but a deck write says nothing about the corpus, and the
 * widget's own cursor write is not a deck write at all. Filed under `["decks"]` it would refetch
 * after every card added to any deck and stay stale after the sync that actually brings the new
 * printings in. The whole argument is at the constant itself.
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

import type { PriceMoverDirection, PriceMoverWindow } from "@/lib/ipc";
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

/**
 * How far each set the reader collects is from complete — `ipc.setCompletion`.
 *
 * Under `["collection"]` by the module doc's rule: the answer moves when a copy is added, moved or
 * removed, and every one of those writes already invalidates that root. No marketplace, because
 * nothing in the answer is priced.
 */
export const setCompletionKey: QueryKey = ["collection", "setCompletion"];

/**
 * The owned printings whose price moved most — `ipc.priceMovers`.
 *
 * Under `["collection"]` for both of the reasons that root exists: a copy added or removed changes
 * which printings are *owned*, and `invalidatePricedQueries` sweeps the same root when a feed lands,
 * which is also the moment a new price snapshot is taken. **Every segment after the root is part of
 * the question** — the window picks the baseline, the direction filters, the marketplace decides
 * every number, and the limit cuts the list — so each one has to be able to re-issue the read.
 */
export const priceMoversKey = (
  range: PriceMoverWindow,
  direction: PriceMoverDirection,
  marketplace: MarketplaceId,
  limit: number,
): QueryKey => ["collection", "priceMovers", range, direction, marketplace, limit];

/**
 * The root the recently viewed strip is filed under — the module doc's second exception, and the
 * prefix `CardDetailModal`'s recorder invalidates. A root of its own because its one writer is
 * not a collection, wishlist or deck write; see the module doc.
 */
export const RECENT_CARDS_ROOT: QueryKey = ["recentCards"];

/** The cards this device opened most recently, at most `limit` — `ipc.recentCards`. The limit is
 *  in the key for {@link activityKey}'s reason: eight is not the first eight of twenty-four once
 *  a card has been opened in between. */
export const recentCardsKey = (limit: number): QueryKey => ["recentCards", "list", limit];

/**
 * Every sticky note — `ipc.stickyNotes`, the whole table in its stored order.
 *
 * **A root of its own**, for the reason the module doc argues above: nothing else reads
 * `sticky_notes`, so there is no root this data already lives under, and `crossWindow.ts` maps
 * the table to exactly this key. One segment and no more — the read takes no argument, so there
 * is no part of a question to carry. No `limit`, because the widget draws what it fits out of a
 * list it already holds rather than asking for a shorter one, and no `marketplace`, because
 * nothing a note carries is priced.
 */
export const stickyNotesKey: QueryKey = ["stickyNotes"];

/**
 * The root the new printings feed is filed under — the module doc's **third** exception, and it is
 * {@link RECENT_CARDS_ROOT}'s case rather than {@link activityKey}'s.
 *
 * The answer is about `deck_cards` and the corpus, so `["decks"]` is the root it *looks* like it
 * belongs under — and a deck write genuinely does change it. But the other half of the answer is
 * the corpus, which a deck write says nothing about, and the cursor write below is not a deck
 * write at all: filing it under `["decks"]` would refetch the feed after every card added to any
 * deck while leaving it stale after the sync that actually brings new printings in. A root of its
 * own, invalidated by this widget's own cursor write and refetched on mount and on focus like
 * every other query in this app, is the honest arrangement.
 */
export const NEW_PRINTINGS_ROOT: QueryKey = ["newPrintings"];

/** One feed. **Every segment is part of the question** — the scope and its ids pick the decks, the
 *  window picks the far edge, each switch changes which rows are counted, and the limit cuts the
 *  list — so each one has to be able to re-issue the read. The ids are joined rather than nested
 *  so two arrays with the same members are one cache entry. */
export const newPrintingsKey = (
  scope: string,
  deckIds: readonly number[],
  days: number,
  langs: readonly string[],
  flags: { virtual: boolean; theory: boolean; basics: boolean },
  limit: number,
): QueryKey => [
  "newPrintings",
  "feed",
  scope,
  [...deckIds].sort((a, b) => a - b).join(","),
  days,
  // **The resolved list, not the mode** — the key has to be the question the backend was asked.
  // Sorted and joined so two arrays with the same members are one cache entry, and so `["en","ja"]`
  // and `["ja","en"]` do not cost two reads of one answer.
  [...langs].sort().join(","),
  `${flags.virtual ? "v" : ""}${flags.theory ? "t" : ""}${flags.basics ? "b" : ""}`,
  limit,
];
