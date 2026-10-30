/**
 * The sets the Draft & Packs page offers, and one set's booster data — both MTGJSON's.
 *
 * **Never the corpus's set list.** Scryfall splits a release into sets of its own (a bonus sheet,
 * the List, a commander's promos) that no booster is sold of, so a wall built from `list_sets`
 * offers sets MTGJSON has no booster for. The wall is MTGJSON's set list (`packs_booster_sets`,
 * the sets a booster pack is sold of), fetched by the host and cached on disk for a week; a set's
 * boosters are its own file, fetched the first time it is picked and cached the same (spec §2) — so
 * this side keeps both answers for the window's life and asks again on Retry or Refresh, or when
 * the host fetched MTGJSON's files again beside a card sync (`packs:refreshed`,
 * {@link usePacksRefreshed}).
 */
import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError, type BoosterSet, type BoosterSetSummary } from "@/lib/ipc";

/** A set may be offered this long before its release date — prerelease week, when boxes open. */
const LEAD_DAYS = 7;

/** `YYYY-MM-DD` of `now` plus `days`, in UTC — how `releaseDate` is written. */
function isoDay(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The sets worth offering for boosters, newest first: out now or within {@link LEAD_DAYS}
 * (MTGJSON lists a set's packs while it is still being previewed). Pure and exported for its suite.
 */
export function boosterSets(
  sets: readonly BoosterSetSummary[],
  now: Date = new Date(),
): BoosterSetSummary[] {
  const latest = isoDay(now, LEAD_DAYS);
  return sets
    .filter((s) => s.releaseDate !== null && s.releaseDate <= latest)
    .sort(
      (a, b) =>
        (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.name.localeCompare(b.name),
    );
}

/**
 * Every MTGJSON answer this window holds (`["packs", …]`: the set list and each set's boosters)
 * asked again once the host has fetched the files again beside a card sync. Mounted by the walls
 * that hold one — an answer no page shows is only marked stale, and asked when one mounts.
 */
export function usePacksRefreshed(): void {
  const client = useQueryClient();
  useEffect(
    () => ipc.onPacksRefreshed(() => void client.invalidateQueries({ queryKey: ["packs"] })),
    [client],
  );
}

/** The cache key of MTGJSON's booster sets — what a story seeds. */
export const BOOSTER_SETS_KEY = ["packs", "boosterSets"];

/**
 * {@link boosterSets} over MTGJSON's set list, for the window's life (`staleTime: Infinity` — the
 * host caches the file for a week). **No automatic retry**, as {@link useBoosterSet}: a refusal is
 * the host's one sentence, and `retry` is the page's Retry button.
 */
export function useBoosterSets(): {
  sets: BoosterSetSummary[];
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  usePacksRefreshed();
  const query = useQuery({
    queryKey: BOOSTER_SETS_KEY,
    queryFn: () => ipc.packsBoosterSets(),
    staleTime: Infinity,
    retry: false,
    select: (rows: BoosterSetSummary[]) => boosterSets(rows),
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return {
    sets: query.data ?? [],
    loading: query.data === undefined && query.isFetching,
    error: query.error && !query.isFetching ? ipcError(query.error) : null,
    retry,
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
