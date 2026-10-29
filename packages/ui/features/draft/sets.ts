/**
 * The sets the Draft & Packs page offers, and one set's booster data.
 *
 * **Two reads, two lifetimes.** The set list is the corpus's (`list_sets`, the Search page's set
 * picker's own cache entry, `["sets"]`), narrowed here to sets that can have boosters. A set's
 * boosters are MTGJSON's, fetched by the host the first time a set is picked and cached on disk for
 * a week (spec §2) — so this side keeps an answer for the window's life and asks again only on
 * Refresh.
 */
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError, type BoosterSet, type SetSummary } from "@/lib/ipc";

/**
 * Scryfall's set types a booster is sold in. Left out: `alchemy` (Arena only), `masterpiece`,
 * `promo`, `token`, `memorabilia`, the preconstructed decks (`duel_deck`, `premium_deck`,
 * `planechase`, `archenemy`, `from_the_vault`, `spellbook`, `box`, …). `commander` is kept because
 * some of its sets are sold in collector boosters, and `eternal` for the Eternal-legal sets that
 * are. Whether a set really has boosters is MTGJSON's to say when it is picked; a set this keeps
 * that has none is refused in the host's sentence.
 */
export const BOOSTER_SET_TYPES: ReadonlySet<string> = new Set([
  "core",
  "expansion",
  "masters",
  "draft_innovation",
  "funny",
  "starter",
  "commander",
  "eternal",
]);

/** A set may be offered this long before its release date — prerelease week, when boxes open. */
const LEAD_DAYS = 7;

/** `YYYY-MM-DD` of `now` plus `days`, in UTC — how `releasedAt` is written. */
function isoDay(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The sets worth offering for boosters, newest first: a booster set type (or none stated — a set
 * `sets` does not list still has a corpus, and MTGJSON decides), printings in the corpus, and out
 * now or within {@link LEAD_DAYS}. Pure and exported for its suite.
 */
export function boosterSets(sets: readonly SetSummary[], now: Date = new Date()): SetSummary[] {
  const latest = isoDay(now, LEAD_DAYS);
  return sets
    .filter(
      (s) =>
        (s.setType === null || BOOSTER_SET_TYPES.has(s.setType)) &&
        s.cardCount > 0 &&
        s.releasedAt !== null &&
        s.releasedAt <= latest,
    )
    .sort(
      (a, b) =>
        (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || a.name.localeCompare(b.name),
    );
}

/**
 * {@link boosterSets} over the corpus's set list. `["sets"]` and its `staleTime` are
 * `SetCombobox`'s, so the two share one read: kept for good once it has answered with rows, asked
 * again while it is empty (the first launch's sync may still be writing `sets`).
 */
export function useBoosterSets(): { sets: SetSummary[]; loading: boolean; error: string | null } {
  const query = useQuery({
    queryKey: ["sets"],
    queryFn: () => ipc.listSets(),
    staleTime: (q) => (q.state.data?.length ? Infinity : 0),
    select: (rows: SetSummary[]) => boosterSets(rows),
  });
  return {
    sets: query.data ?? [],
    loading: query.isPending,
    error: query.error ? ipcError(query.error) : null,
  };
}

/** The cache key of one set's booster data — what a story seeds. */
export function boosterSetKey(code: string | null) {
  return ["packs", "boosterSet", code];
}

/**
 * One set's booster data, for the window's life (`staleTime: Infinity` — the host caches the file
 * for a week; there is nothing newer to ask for on a remount). `null` asks nothing.
 *
 * **No automatic retry**: a refusal is the host's one sentence (no boosters, MTGJSON unreachable),
 * and asking a network again behind the reader's back only delays it. `retry` is the page's Retry
 * button; `refresh` asks the host to fetch the file again now.
 */
export function useBoosterSet(code: string | null): {
  set: BoosterSet | undefined;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  retry: () => void;
  refresh: () => Promise<void>;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: boosterSetKey(code),
    queryFn: () => ipc.packsBoosterSet(code as string, false),
    enabled: code !== null,
    staleTime: Infinity,
    retry: false,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const refresh = useCallback(async () => {
    if (code === null) return;
    await client.fetchQuery({
      queryKey: boosterSetKey(code),
      queryFn: () => ipc.packsBoosterSet(code, true),
      staleTime: 0,
      retry: false,
    });
  }, [client, code]);
  return {
    set: query.data,
    // Read off the data rather than the status: a Retry after a refusal fetches with the status
    // still `error`, and the page should say it is fetching again, not the old sentence.
    loading: code !== null && query.isFetching && query.data === undefined,
    refreshing: query.isFetching && query.data !== undefined,
    error: query.error && !query.isFetching ? ipcError(query.error) : null,
    retry,
    refresh,
  };
}
