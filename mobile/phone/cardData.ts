import { createContext, useContext, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  comboActivity,
  marketplaceFeedActivity,
  oracleTagActivity,
  syncActivity,
  topActivity,
  type Activity,
} from "@/lib/activity";
import { useComboProgress } from "@/lib/useComboProgress";
import { useMarketplace, useMarketplaceProgress } from "@/lib/useMarketplace";
import { useOracleTagProgress } from "@/lib/useOracleTagProgress";
import { useSync } from "@/lib/useSync";
import { SYNC_INVALIDATED, useSyncInvalidation } from "@/lib/useSyncInvalidation";
import { useSyncProgress } from "@/lib/useSyncProgress";

/** What a page needs to know about the card database to say the right thing over an empty wall. */
export interface CardData {
  /** `sync_status`' count: `0` is an empty database, `null` a count not read (yet). */
  cardCount: number | null;
  /** The card sync, while one is running — `syncActivity`'s fold, so the phase is named in the
   *  desktop ribbon's words. `null` when none is. */
  sync: Activity | null;
  /** Why the last card sync failed, this session's or the persisted one. */
  error: string | null;
}

/** What a page reads with no provider above it — a story, a test of one page: nothing known. */
const UNKNOWN: CardData = { cardCount: null, sync: null, error: null };

/** Provided by `PhoneFace`; read by {@link useCardData}. */
export const CardDataContext = createContext<CardData>(UNKNOWN);

/** The card database as the phone face last heard it. */
export function useCardData(): CardData {
  return useContext(CardDataContext);
}

/**
 * **Everything a finished download makes stale, refreshed — and what is running, described.** The
 * phone face's half of what `AppShell` does for the desktop, called once by `PhoneFace`.
 *
 * Found on a real phone on 2026-10-04: a first run's card sync finished in 18.7 s and the Search
 * wall went on saying *No cards match.* half a minute later, because the wall's first read
 * answered over an empty database and nothing on this face listened for the sync's end — TanStack
 * invalidates on writes this page makes, and an ingest is a write nobody here made. So these are
 * the desktop's own listeners, mounted here for the desktop's reasons, each one subscription for
 * the life of the face:
 *
 * - **`sync:progress` and `collection:reconciled`** through `useSyncInvalidation`, which marks
 *   every root a sync can have made wrong;
 * - **the three feeds** — `useComboProgress`, `useOracleTagProgress` and `useMarketplaceProgress`,
 *   each invalidating its own roots on a terminal event, so the card sheet open over a download
 *   that lands is refilled rather than left reading the old answer.
 *
 * **Plus one trigger the desktop does not have: the polled count leaving zero.** Tauri drops an
 * event emitted before the page listens, so a first run whose `done` was missed would otherwise
 * leave the wall empty until a relaunch. `sync_status` is polled each second while a sync runs,
 * so the count is at most a second behind the event it backs up.
 *
 * Nothing here asks where it runs: over the Storybook fake no event ever comes and the count is
 * the seed's, which is the same program with no download to report.
 */
export function useCardDataWatch(): { data: CardData; activity: Activity | null } {
  const client = useQueryClient();
  const { status, error, refreshing } = useSync();
  const progress = useSyncProgress();
  useSyncInvalidation(progress, client);
  useMarketplaceProgress();
  const oracleTags = useOracleTagProgress();
  const combos = useComboProgress();
  const { refreshing: refreshingFeed, feeds, progress: feedProgress } = useMarketplace();

  const cardCount = status?.cardCount ?? null;
  const lastCount = useRef(cardCount);
  useEffect(() => {
    const before = lastCount.current;
    lastCount.current = cardCount;
    if (before === 0 && cardCount !== null && cardCount > 0) {
      for (const queryKey of SYNC_INVALIDATED) void client.invalidateQueries({ queryKey });
    }
  }, [cardCount, client]);

  // `AppShell`'s rule: either this face started the sync or the launch did.
  const sync = syncActivity(progress, refreshing || status?.syncing === true);
  const feedLabel = feeds.find((f) => f.marketplace.id === refreshingFeed)?.marketplace.label;
  // The ribbon's fold, without its registry: four jobs known in one place need no store.
  const activity = topActivity(
    [
      sync,
      marketplaceFeedActivity(feedLabel ?? null, feedProgress),
      oracleTagActivity(oracleTags.refreshing, oracleTags.progress),
      comboActivity(combos.refreshing, combos.progress),
    ].filter((job): job is Activity => job !== null),
  );

  return { data: { cardCount, sync, error }, activity };
}
