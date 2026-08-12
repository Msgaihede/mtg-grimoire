import { useEffect } from "react";
import {
  skipToken,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc, ipcError, type FeedProgressEvent, type MarketplaceFeedStatus } from "@/lib/ipc";
import {
  DEFAULT_MARKETPLACE,
  FEED_MARKETPLACES,
  resolveMarketplace,
  type Marketplace,
  type MarketplaceId,
} from "@/lib/marketplace";

export const MARKETPLACE_KEY = ["marketplace"];

/** Every feed's state, read together — one command, one cache entry, one row per feed. */
export const MARKETPLACE_FEEDS_KEY = ["marketplace", "feeds"];

/**
 * The refresh mutation's key, and it is load-bearing rather than tidy.
 *
 * A `useMutation` is **per observer** — TanStack shares a query's cache between observers and a
 * mutation's state with nobody — so the panel that presses Refresh is the only component that
 * would know a fetch is running. The ribbon has to know too, and it is a sibling. A keyed
 * mutation is readable from anywhere through `useMutationState`, which is what makes the state
 * below one answer for the whole window instead of one per caller.
 */
export const FEED_REFRESH_KEY = ["marketplace", "feedRefresh"];

/**
 * Where the latest `marketplace:progress` event is kept.
 *
 * A cache entry rather than a `useState`, and that is the whole of how a fetch **this window
 * did not start** becomes visible. The backend refreshes the selected feed at start-up when its
 * rows are older than a day or absent, so a refresh can be running before any component has
 * mounted a mutation — and a `fetching` state derived only from this window's own
 * `useMutation` would report `stale` through the whole of it. The event is the fact; the
 * mutation is only one way of causing it.
 *
 * Written by {@link useMarketplaceProgress}, which subscribes exactly once, and read by every
 * `useMarketplace()` observer through a query that never fetches.
 */
export const MARKETPLACE_PROGRESS_KEY = ["marketplace", "progress"];

// How old a feed's rows may be before they are stale is **not defined here**. It is 24 h — Card
// Kingdom's own regeneration cadence, so the shortest interval at which asking again could tell
// a reader anything new — and it lives in `marketplace_feed.rs`'s `REFRESH_INTERVAL_SECS`,
// which is also what decides whether the backend refreshes at start-up. `MarketplaceFeedStatus`
// carries the answer as a boolean; re-deriving it from `fetchedAt` on this side would be a
// second copy of a number two behaviours already turn on.

/**
 * What a downloaded price feed is doing, in the five words a reader needs.
 *
 * `never` is the state a first selection acts on — there is nothing to quote, so the prices
 * would all be em dashes until someone fetched. `stale` and `failed` both still have rows:
 * **a failed fetch leaves the previous prices in place** on purpose, because stale prices with
 * an honest as-of line beat an empty table.
 */
export type FeedState = "never" | "fetching" | "fresh" | "stale" | "failed";

/** One feed-backed marketplace, and everything a surface can say about its prices. */
export interface FeedInfo {
  marketplace: Marketplace;
  state: FeedState;
  /** The backend's row, or `null` while the status read has not answered (or could not). */
  status: MarketplaceFeedStatus | null;
  /** Why the last refresh failed, `null` otherwise. */
  error: string | null;
}

/**
 * The clock, as a function rather than a `Date.now()` in a render body.
 *
 * `formatWhen` in `ErrorLogPanel` reads the clock the same way, through a default parameter,
 * and for the same reason: **"two hours ago" is a fact about the render, deliberately not
 * state.** Nothing here re-renders when a minute passes, and nothing should — a settings panel
 * that repainted itself on a timer to keep a relative date current would be motion without
 * information, and the number it is qualifying (a feed's age, in hours) does not move that
 * fast. The `react-hooks/purity` rule is about *unstable* results; this one is stable within a
 * render, which is the whole granularity anything here reads it at.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Which of the five words describes a feed, given what the backend says and what this window
 * is doing about it.
 *
 * Pure and exported so the ordering is testable, because the ordering is the whole content:
 *
 * * **`fetching` first** — it is happening now, and a fetch over stale rows is not "stale".
 * * **`failed` before `never`** — "we tried and it did not work" is a different sentence from
 *   "nobody has tried", and only one of them is worth offering a retry against.
 * * **`failed` before `fresh`/`stale`** — the rows on screen are the *previous* fetch's, which
 *   is exactly what the reader has to be told before they price a deck off them.
 *
 * **`never` is read off `fetchedAt` and not off `rowCount`**, because the two are different
 * questions: a feed that has been fetched and landed nothing is not a feed nobody has fetched,
 * and only the second is a state a first selection should act on. `stale` is the backend's
 * boolean, not arithmetic done here — see the note above this function.
 */
export function feedState(
  status: MarketplaceFeedStatus | null,
  refreshing: boolean,
  failed: boolean,
): FeedState {
  if (refreshing) return "fetching";
  if (failed) return "failed";
  if (status === null || status.fetchedAt === null) return "never";
  return status.stale ? "stale" : "fresh";
}

/** The last refresh attempted for each marketplace — a later attempt replaces an earlier
 *  one's verdict, so a retry that worked is not reported as a failure forever. */
type Attempt = { marketplace: MarketplaceId; failed: boolean; error: string | null };

/**
 * Every query whose rows carry a price, invalidated because a feed's table has just been
 * rewritten underneath them.
 *
 * **None of their keys moved** — the marketplace is the same one it was — so nothing would
 * refetch on its own. Called from both ends of a refresh: the mutation this window made, and
 * the `done` event of one it did not.
 */
function invalidatePricedQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: MARKETPLACE_FEEDS_KEY });
  void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  void queryClient.invalidateQueries({ queryKey: ["collection"] });
  void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
  void queryClient.invalidateQueries({ queryKey: ["decks"] });
}

/**
 * Subscribe to `marketplace:progress` and keep the latest event where every observer can read
 * it.
 *
 * **Call this once.** `AppShell` is that one caller — `useSyncProgress`'s rule, for its reason:
 * every extra call is another `listen` registration for the life of the app. It returns
 * nothing, because the event is not this component's to render; the ribbon reads it back out of
 * `useMarketplace()` like everything else.
 *
 * A terminal `done` invalidates the priced queries, which is what makes a **start-up** refresh
 * visible: nobody in this window pressed anything, no query key moved, and the numbers on
 * screen have just changed.
 */
export function useMarketplaceProgress(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    ipc
      .onMarketplaceProgress((event) => {
        queryClient.setQueryData(MARKETPLACE_PROGRESS_KEY, event);
        if (event.phase === "done") invalidatePricedQueries(queryClient);
      })
      .then((unlisten) => {
        // `listen` resolves a tick later than the unmount can happen, so the handle has to be
        // dropped here too — otherwise it outlives the component for the app's lifetime.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // Registering a listener fails outside a Tauri window (a plain `vite dev`, a story).
      // Losing the fast path is not worth taking the app down for: `marketplaceFeedStatus` is
      // the reliable half of the pair and still answers.
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);
}

/**
 * Which marketplace the app is quoting, the write that changes it, and the state of the two
 * feeds it downloads.
 *
 * TanStack Query rather than the zustand store: `store.ts` scopes itself to UI state and hands
 * anything backed by the database to Query, and this setting lives in `app_meta` so it
 * outlives the process.
 *
 * **Switching marketplace now refetches, and that is the design rather than a regression.**
 * It used to be a re-render: Rust returned both currencies on every priced row, so a cell
 * changed which field it *read* and nothing crossed the wire. That shape does not survive a
 * third source. Card Kingdom's and Mana Pool's prices live in `marketplace_prices` rather than
 * in `cards.prices`, so carrying every marketplace on every row would mean four numbers per
 * row today and five the day Card trader lands — each one a figure four out of five renders
 * ignore. **So the marketplace became a query parameter and Rust answers one number per row**,
 * and the marketplace is part of the key of every price-bearing query.
 *
 * The trade is a good one because of what the refetch actually is: a local SQLite read over an
 * index, which is what every other filter in this app already does, against a page of at most
 * 500 rows. What it buys is that adding a marketplace costs one row of `MARKETPLACES` and one
 * arm of `price_expr` instead of a field on six DTOs and a branch at every price cell.
 *
 * There is still no first-paint flash of the wrong money, and it is structural rather than
 * lucky: no price is on screen until its own (far more expensive) query resolves, and this one
 * is issued alongside them.
 */
export function useMarketplace() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: MARKETPLACE_KEY,
    queryFn: () => ipc.getMarketplace(),
    staleTime: Infinity,
  });

  /**
   * Both feeds' rows and stamps.
   *
   * Not `staleTime: Infinity` like the setting above: this one is a fact about a table two
   * commands write to, and it is re-read after every refresh. It answers even for a feed that
   * has never been fetched, so an empty array means the read has not landed rather than that
   * there are no feeds.
   */
  const feedsQuery = useQuery({
    queryKey: MARKETPLACE_FEEDS_KEY,
    queryFn: () => ipc.marketplaceFeedStatus(),
  });

  /**
   * Every refresh this window has run, newest last, whatever its outcome — read out of the
   * mutation cache rather than out of one observer's `useMutation`, so the ribbon and the
   * settings panel agree about what is happening.
   *
   * All statuses, not just the failures: the *latest* attempt per marketplace is what decides,
   * and a success that followed a failure has to be able to clear it.
   */
  const attempts = useMutationState<Attempt>({
    filters: { mutationKey: FEED_REFRESH_KEY },
    select: (mutation) => ({
      marketplace: mutation.state.variables as MarketplaceId,
      failed: mutation.state.status === "error",
      error: mutation.state.error ? ipcError(mutation.state.error) : null,
    }),
  });
  const pending = useMutationState<MarketplaceId>({
    filters: { mutationKey: FEED_REFRESH_KEY, status: "pending" },
    select: (mutation) => mutation.state.variables as MarketplaceId,
  });

  /**
   * The latest `marketplace:progress` event, read straight out of the cache.
   *
   * `skipToken` rather than `enabled: false`, and it says the true thing: there is nothing to
   * fetch here. A non-fetching observer still subscribes to the cache entry and still
   * re-renders when {@link useMarketplaceProgress} writes it, which is the whole mechanism —
   * one listener, every consumer.
   */
  const progress =
    useQuery<FeedProgressEvent | null>({
      queryKey: MARKETPLACE_PROGRESS_KEY,
      queryFn: skipToken,
    }).data ?? null;

  const lastAttempt = new Map<MarketplaceId, Attempt>();
  for (const attempt of attempts) lastAttempt.set(attempt.marketplace, attempt);

  const statusOf = (id: MarketplaceId) =>
    feedsQuery.data?.find((row) => row.marketplace === id) ?? null;

  /** The feed-backed marketplaces, in picker order. Nothing else has a feed to describe. */
  const feeds: FeedInfo[] = FEED_MARKETPLACES.map((marketplace) => {
    const status = statusOf(marketplace.id);
    const attempt = lastAttempt.get(marketplace.id);
    // The event only speaks for the feed it names. `null` here means "no news about this one",
    // which is not the same as "nothing is happening to it".
    const event = progress?.marketplace === marketplace.id ? progress : null;
    // **Three sources, and none of them is redundant.** The backend's own flag is the
    // authoritative one and is only as fresh as the last status read; the mutation is pending
    // from the moment a press lands, before any status or event has moved; and the event is
    // what carries a start-up refresh through a window that pressed nothing.
    const refreshing =
      status?.refreshing === true ||
      pending.includes(marketplace.id) ||
      event?.phase === "downloading" ||
      event?.phase === "ingesting";
    // **This window's own last press wins where there is one**, because it is the more recent
    // deliberate act; the event decides for a feed nobody here has touched. A `FeedError::Empty`
    // refusal — a feed that parsed to zero rows, which is refused rather than allowed to wipe a
    // working table — lands here as an ordinary failure, which is right: the prior rows are
    // still there, and `feedNote` says so rather than claiming the table is empty.
    const failed = attempt ? attempt.failed : event?.phase === "error";
    return {
      marketplace,
      status,
      state: feedState(status, refreshing, failed),
      // Cleared by a later attempt, because `lastAttempt` holds only the newest one. `null` for
      // a failure this window did not cause: there is no message on a progress event, and
      // inventing one would be worse than the state alone.
      error: attempt?.failed ? attempt.error : null,
    };
  });

  /**
   * Pull one feed and rewrite its rows.
   *
   * **Every price-bearing query is invalidated on the way out**, and only then: the numbers in
   * the collection, the search, the decks and the wishlist have just changed underneath the
   * pages already on screen, and none of their keys moved — the marketplace is the same one it
   * was. A failure invalidates nothing, because a failed fetch leaves the previous rows in
   * place and the pages showing them are still right.
   */
  const refresh = useMutation({
    mutationKey: FEED_REFRESH_KEY,
    mutationFn: (id: MarketplaceId) => ipc.marketplaceFeedRefresh(id),
    // The same sweep the `done` event makes — because either can be the one that lands, and a
    // window with no event listener (a story, a plain `vite dev`) still has to end up right.
    // Invalidating twice costs one deduplicated refetch; invalidating in only one place would
    // leave one of the two paths showing the prices from before.
    onSuccess: () => invalidatePricedQueries(queryClient),
    // The status row moves even when the fetch fails — `fetched_at` is not written, but a
    // reader looking at the panel is owed the state it is actually in.
    onError: () => void queryClient.invalidateQueries({ queryKey: MARKETPLACE_FEEDS_KEY }),
  });

  const select = useMutation({
    mutationFn: (id: MarketplaceId) => ipc.setMarketplace(id),
    // Write the answer straight into the cache. The command has already committed it, so a
    // refetch would only ask the database to repeat itself. Every price query keys off this
    // value, so the write *is* what re-issues them — no invalidation is needed, and one here
    // would throw away the answers for the marketplace being switched away from.
    onSuccess: (_result, id) => {
      queryClient.setQueryData(MARKETPLACE_KEY, id);
      // **Choosing a feed with nothing in it fetches it**, here rather than in the panel: the
      // reader has just asked for prices this app does not have, and every surface in the
      // window would otherwise fill with em dashes until somebody found a button. Guarded on a
      // status the app has actually read — an unknown state is not a reason to download
      // 63.7 MiB — and on the row count, where `null` is "never fetched" and `0` is "a fetch
      // that landed nothing": both are no prices, and both are worth one attempt. A feed that
      // has rows is left alone however old they are, because staleness is the backend's to act
      // on at start-up and it already has.
      const status = statusOf(id);
      if (resolveMarketplace(id).feed && status !== null && (status.rowCount ?? 0) === 0) {
        refresh.mutate(id);
      }
    },
  });

  const chosen = resolveMarketplace(query.data ?? DEFAULT_MARKETPLACE);

  return {
    /** Never null — an unset or unrecognised stored id resolves to the default. */
    marketplace: chosen,
    /** Convenience: what every price *formatter* in this app takes. The marketplace decides
     *  which number arrives; this decides how it is written. */
    currency: chosen.currency,
    select: (id: MarketplaceId) => select.mutate(id),
    selecting: select.isPending,
    error: select.error ? ipcError(select.error) : null,
    /** Both downloaded feeds, in picker order — what Settings draws. Empty until the status
     *  read lands, so a surface must treat "no rows" as "not known yet". */
    feeds,
    /** The chosen marketplace's feed, or `null` when its prices come with the card data (or
     *  when it has no feed at all). The one thing a price surface would ever ask for. */
    feed: feeds.find((f) => f.marketplace.id === chosen.id) ?? null,
    /** Fetch one feed now. Refused by the backend for a marketplace that has none. */
    refresh: (id: MarketplaceId) => refresh.mutate(id),
    /**
     * Which feed is being fetched right now, or `null`.
     *
     * Read off {@link FeedInfo.state} rather than off the mutation, so it covers a refresh
     * **nobody in this window started** — the backend's own start-up pass over a selected feed
     * whose rows are a day old. That is exactly the case the ribbon must not miss.
     */
    refreshing: feeds.find((f) => f.state === "fetching")?.marketplace.id ?? null,
    /** The latest `marketplace:progress` event, for the one surface that counts bytes — the
     *  ribbon. `null` until one arrives, which is most of the time. */
    progress,
  };
}

export type MarketplaceState = ReturnType<typeof useMarketplace>;
export type { Marketplace };
