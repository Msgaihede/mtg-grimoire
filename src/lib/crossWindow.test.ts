import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import USER_TABLES from "./userTables.json";
import {
  DEVICE_SYNC_INVALIDATED,
  FOLLOW_LIVE_APP_META,
  PER_WINDOW_KEYS,
  SINGLE_WRITER_KEYS,
  SYNCED_TABLES,
  TABLE_KEYS,
  isPerWindowKey,
  keysForTables,
  refreshForTables,
  registerUnsavedCheck,
} from "./crossWindow";
import { SYNC_KEY } from "./query";
import { MARK_COLORS_KEY } from "./useMarkColors";
import { MARKETPLACE_KEY } from "./useMarketplace";
import { NAV_COLLAPSED_KEY } from "./useNavCollapsed";
import { START_VIEW_KEY } from "./useStartView";
import { HOME_LAYOUT_KEY } from "@/features/home/useHomeLayout";
import { RECENT_CARDS_ROOT, scannerTrayCountKey, stickyNotesKey } from "@/features/home/keys";
import { HIDDEN_TAGS_KEY } from "@/features/settings/useHiddenTags";
import { PRINTING_GROUP_BY_KEY } from "@/features/card/usePrintingGroupBy";
import { SEARCH_OPEN_KEY } from "@/features/search/useSearchOpen";
import { FOLDER_PANE_KEY } from "@/features/decks/useFolderPane";
import { DECK_SORT_KEY } from "@/features/decks/useDeckSort";
import { DECK_SEARCH_TAB_KEY } from "@/features/decks/DeckSearchPanel";
import { MIRROR_KEY } from "@/features/settings/BackupPanel";
import { SHARE_LIST_KEY } from "@/features/share/useShares";
import { SHELF_FOLDS_KEY } from "@/features/shelves/useShelfFolds";

/** Every key seeded, so an invalidation's reach is readable off `isInvalidated`. */
function seeded(keys: readonly (readonly unknown[])[]): QueryClient {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData([...key], "seed");
  return client;
}
const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState([...key])?.isInvalidated ?? false;

describe("the cross-window table map", () => {
  it("maps every user table — the list Rust holds to its own registry", () => {
    expect(Object.keys(TABLE_KEYS).sort()).toEqual([...USER_TABLES].sort());
  });

  it("spells each key the way its own hook does", () => {
    const follow = FOLLOW_LIVE_APP_META.map((k) => JSON.stringify(k));
    for (const key of [
      START_VIEW_KEY,
      HOME_LAYOUT_KEY,
      MARKETPLACE_KEY,
      MARK_COLORS_KEY,
      RECENT_CARDS_ROOT,
      MIRROR_KEY,
      scannerTrayCountKey,
    ]) {
      expect(follow).toContain(JSON.stringify(key));
    }
    const perWindow = PER_WINDOW_KEYS.map((k) => JSON.stringify(k));
    for (const key of [
      NAV_COLLAPSED_KEY,
      SEARCH_OPEN_KEY,
      FOLDER_PANE_KEY,
      DECK_SORT_KEY,
      DECK_SEARCH_TAB_KEY,
      PRINTING_GROUP_BY_KEY,
    ]) {
      expect(perWindow).toContain(JSON.stringify(key));
    }
  });

  it("refreshes every follow-live app_meta key and no per-window one", () => {
    const client = seeded([...FOLLOW_LIVE_APP_META, ...PER_WINDOW_KEYS]);
    refreshForTables(client, ["app_meta"]);
    for (const key of FOLLOW_LIVE_APP_META) expect(invalidated(client, key)).toBe(true);
    for (const key of PER_WINDOW_KEYS) expect(invalidated(client, key)).toBe(false);
  });

  it("names the scanner's tray and prefs as single-writer, and follows neither live", () => {
    const single = SINGLE_WRITER_KEYS.map((k) => JSON.stringify(k));
    expect(single).toEqual([JSON.stringify(["scanner", "prefs"]), JSON.stringify(["scanner", "tray"])]);
    for (const key of FOLLOW_LIVE_APP_META) expect(single).not.toContain(JSON.stringify(key));
  });

  it("leaves the scanning window's own tray and prefs alone — not refetched, not marked stale", () => {
    // The scanning window hears its own `app_meta` event. Its tray holds cards the 400 ms quiet
    // write has not stored yet, so a refetch here is the stored, older tray written back over them.
    const client = seeded(FOLLOW_LIVE_APP_META);
    const stored = vi.fn(() => "stored");
    const stops = SINGLE_WRITER_KEYS.map((key) => {
      client.setQueryData([...key], "unsaved");
      return new QueryObserver(client, {
        queryKey: [...key],
        queryFn: stored,
        staleTime: Infinity,
        structuralSharing: false,
      }).subscribe(() => undefined);
    });

    refreshForTables(client, ["app_meta"]);

    for (const key of SINGLE_WRITER_KEYS) {
      expect(client.getQueryData([...key])).toBe("unsaved");
      expect(client.getQueryState([...key])?.isInvalidated).toBe(false);
      expect(client.getQueryState([...key])?.fetchStatus).toBe("idle");
    }
    expect(stored).not.toHaveBeenCalled();
    // The rest of the rows still follow.
    for (const key of FOLLOW_LIVE_APP_META) expect(invalidated(client, key)).toBe(true);
    for (const stop of stops) stop();
  });

  /**
   * **The home page's count of the tray follows a scan in another window, where the tray itself
   * cannot.** With a second window the Scanner and the home page *are* on screen at once, and a
   * scan there is an `app_meta` write here — which, without this, left To review's `Scanned cards`
   * row at its old count until the page next mounted. It can follow because `scanner_tray` is a
   * plain read of the stored row that writes nothing (so no refresh loop), and because its key sits
   * *beside* `["scanner", "tray"]` rather than under it, so the single-writer predicate that spares
   * the owner's tray never spares the count.
   */
  it("refetches a live tray count on another window's app_meta write, and leaves the tray alone", async () => {
    const client = seeded([scannerTrayCountKey]);
    const count = vi.fn(() => "fresh");
    const stored = vi.fn(() => "stored");
    client.setQueryData(["scanner", "tray"], "unsaved");
    const stops = [
      new QueryObserver(client, {
        queryKey: [...scannerTrayCountKey],
        queryFn: count,
        staleTime: Infinity,
      }).subscribe(() => undefined),
      new QueryObserver(client, {
        queryKey: ["scanner", "tray"],
        queryFn: stored,
        staleTime: Infinity,
        structuralSharing: false,
      }).subscribe(() => undefined),
    ];
    try {
      expect(count, "the premise: a count on screen is not refetched by mounting").not.toHaveBeenCalled();

      refreshForTables(client, ["app_meta"]);

      await vi.waitFor(() => expect(client.getQueryData([...scannerTrayCountKey])).toBe("fresh"));
      expect(count).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(["scanner", "tray"])).toBe("unsaved");
      expect(stored).not.toHaveBeenCalled();
    } finally {
      for (const stop of stops) stop();
    }
  });

  it("drops an idle tray and prefs, so the next scanning window reads them from scratch", () => {
    const client = seeded([...SINGLE_WRITER_KEYS, ...FOLLOW_LIVE_APP_META]);
    refreshForTables(client, ["app_meta"]);
    for (const key of SINGLE_WRITER_KEYS) {
      expect(client.getQueryCache().find({ queryKey: [...key], exact: true })).toBeUndefined();
    }
    // Removal is for the single-writer keys alone: an idle follow-live read is marked, not dropped.
    for (const key of FOLLOW_LIVE_APP_META) expect(invalidated(client, key)).toBe(true);
  });

  /**
   * **An idle tray or prefs is dropped only when its hook has nothing unsaved.** The cache is
   * where a card lives until its write lands, so dropping an entry whose write is refused, waiting
   * or on the wire takes the card with it — or hands the pending write nothing, so it stores `[]`
   * or the default prefs over the row. Asked per client, which is the grain the hooks keep their
   * queues at.
   */
  it("keeps an idle tray and prefs while their hooks report something unsaved, and drops them after", () => {
    const dirty = new Set<QueryClient>();
    const stops = SINGLE_WRITER_KEYS.map((key) => registerUnsavedCheck(key, (client) => dirty.has(client)));
    try {
      const unsaved = seeded([...SINGLE_WRITER_KEYS]);
      const clean = seeded([...SINGLE_WRITER_KEYS]);
      dirty.add(unsaved);
      refreshForTables(unsaved, ["app_meta"]);
      refreshForTables(clean, ["app_meta"]);
      for (const key of SINGLE_WRITER_KEYS) {
        expect(unsaved.getQueryData([...key]), "an unsaved entry was dropped").toBe("seed");
        // Kept as it is — an invalidated idle entry refetches on the next mount, which is the
        // stored row read back over the rows it was keeping.
        expect(unsaved.getQueryState([...key])?.isInvalidated).toBe(false);
        expect(clean.getQueryCache().find({ queryKey: [...key], exact: true })).toBeUndefined();
      }

      dirty.delete(unsaved);
      refreshForTables(unsaved, ["app_meta"]);
      for (const key of SINGLE_WRITER_KEYS) {
        expect(unsaved.getQueryCache().find({ queryKey: [...key], exact: true })).toBeUndefined();
      }
    } finally {
      for (const stop of stops) stop();
    }
  });

  it("does not pull another window's deck sort in with a deck write", () => {
    const client = seeded([["decks", "list"], DECK_SORT_KEY]);
    refreshForTables(client, ["deck_cards"]);
    expect(invalidated(client, ["decks", "list"])).toBe(true);
    expect(invalidated(client, DECK_SORT_KEY)).toBe(false);
  });

  /**
   * **No per-window key may sit under a root a table maps to.** The predicate spares them from
   * *this* refresh, but the writing window's own invalidations carry no predicate: deck sort under
   * `["decks"]` was refetched by every deck write the window made itself, which pulled in whichever
   * window had pressed last.
   */
  it("puts no per-window key under a root any table's write reaches", () => {
    const roots = keysForTables(Object.keys(TABLE_KEYS));
    for (const key of PER_WINDOW_KEYS) {
      for (const root of roots) {
        const under = root.every((part, i) => key[i] === part);
        expect(under, `${JSON.stringify(key)} sits under ${JSON.stringify(root)}`).toBe(false);
      }
    }
  });

  /**
   * `cancelRefetch: false`, observed rather than read off the call: the writing window hears its
   * own event after its own mutation has already started the refetch, and cancelling that to start
   * the same read again is one more round trip for every write.
   *
   * **The list already holds rows, and the test is vacuous without them**: TanStack only ever
   * cancels a fetch for a query that has data, so a first read is joined whatever the option says.
   * A refetch over rows on screen is the case the writing window is actually in.
   */
  it("joins a refetch already running rather than cancelling and restarting it", async () => {
    const client = new QueryClient();
    client.setQueryData(["collection", "list"], "before");
    let answer: (rows: string) => void = () => {};
    const read = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    const stop = new QueryObserver(client, { queryKey: ["collection", "list"], queryFn: read }).subscribe(
      () => undefined,
    );
    try {
      expect(read, "the premise: subscribing started a refetch over stale rows").toHaveBeenCalledTimes(1);
      refreshForTables(client, ["collection_entries"]);
      expect(read).toHaveBeenCalledTimes(1);
      answer("rows");
      await vi.waitFor(() => expect(client.getQueryData(["collection", "list"])).toBe("rows"));
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it("dedupes keys and ignores a table it has never heard of", () => {
    expect(keysForTables(["deck_labels", "deck_notes", "no_such_table"])).toEqual([["decks"]]);
  });

  it("reaches no share query, because reading the share list writes collection_shares", () => {
    // `share_list` upserts every row the relay names on each call, so a write that refreshed it
    // would be answered by a write that refreshes it — a loop across windows, one round trip a lap.
    const client = seeded([SHARE_LIST_KEY]);
    refreshForTables(client, Object.keys(TABLE_KEYS));
    expect(invalidated(client, SHARE_LIST_KEY)).toBe(false);
  });

  it("treats a key under a per-window root as per-window", () => {
    expect(isPerWindowKey([...DECK_SORT_KEY, 3])).toBe(true);
    expect(isPerWindowKey(["decks", "list"])).toBe(false);
  });
});

describe("the shelves' stored folds", () => {
  /** One value in two places, because `lib` may not import it from `features` — this is the
   *  fence that keeps the spelling here and the hook's key the same key. */
  it("stay per window, under the key the hook reads", () => {
    expect(PER_WINDOW_KEYS).toContainEqual(SHELF_FOLDS_KEY);
    expect(isPerWindowKey(SHELF_FOLDS_KEY)).toBe(true);
    expect(keysForTables(["app_meta"])).not.toContainEqual(SHELF_FOLDS_KEY);
  });
});

/**
 * A pull is a write no window here made, so nothing settles what it moved but
 * `useDeviceSyncInvalidation` — `db:changed` is emitted only while two windows are open, and
 * WebView2 never fires the `visibilitychange` a refetch on focus waits for. What it refreshes is
 * this map read at the synced tables, and these are the fences that keep it the whole of them.
 */
describe("a pull from another device", () => {
  /** The TypeScript half of the census; `changes.rs` holds the file to `schema::SYNCED_TABLES`. */
  it("maps every synced table, and every one of them is a user table", () => {
    expect(SYNCED_TABLES.length, "the premise: the file is not empty").toBeGreaterThan(0);
    for (const table of SYNCED_TABLES) {
      expect(Object.keys(TABLE_KEYS), `${table} has no entry in TABLE_KEYS`).toContain(table);
      expect(USER_TABLES, `${table} is not a user table`).toContain(table);
    }
  });

  /**
   * By reach rather than by membership: the constant keeps only the outermost roots, so
   * `["cards", "search"]` is refreshed through `["cards"]` rather than listed beside it.
   */
  it("reaches every root a synced table's write reaches, and the sync root", () => {
    const owed = [...keysForTables(SYNCED_TABLES), SYNC_KEY];
    const client = seeded(owed);
    for (const queryKey of DEVICE_SYNC_INVALIDATED) void client.invalidateQueries({ queryKey });
    for (const key of owed) expect(invalidated(client, key), JSON.stringify(key)).toBe(true);
    // And nothing the map does not owe: every root is one of those keys, not a wider one.
    const spelled = owed.map((key) => JSON.stringify(key));
    for (const root of DEVICE_SYNC_INVALIDATED) expect(spelled).toContain(JSON.stringify(root));
  });

  /**
   * **The bug this was, one query per table it missed.** The list used to be
   * `[...OWNED_WRITE_KEYS, SYNC_KEY]`: a note written on the other device left the home page's
   * copy as it was — and the next edit here saved a body built from it over theirs — a mute
   * refreshed no tag root, and a copy filed there left the card modal's holdings where they were.
   */
  it("refreshes the sticky notes, the muted tags and a card's holdings", () => {
    const holdings = ["card", "holdings", "some-oracle-id"];
    const client = seeded([stickyNotesKey, HIDDEN_TAGS_KEY, holdings, ["sets"]]);
    for (const queryKey of DEVICE_SYNC_INVALIDATED) void client.invalidateQueries({ queryKey });
    expect(invalidated(client, stickyNotesKey)).toBe(true);
    expect(invalidated(client, HIDDEN_TAGS_KEY)).toBe(true);
    expect(invalidated(client, holdings)).toBe(true);
    // The corpus is still out of reach: a pull writes the reader's rows, never the set list.
    expect(invalidated(client, ["sets"])).toBe(false);
  });

  /**
   * **Why the device sync can invalidate with no predicate** where `refreshForTables` needs one:
   * no synced table is `app_meta`, so nothing a window keeps for itself, and neither of the
   * scanner's single-writer entries, sits under a root a pull refreshes.
   */
  it("puts no per-window or single-writer key under a root a pull refreshes", () => {
    for (const key of [...PER_WINDOW_KEYS, ...SINGLE_WRITER_KEYS]) {
      for (const root of DEVICE_SYNC_INVALIDATED) {
        const under = root.every((part, i) => key[i] === part);
        expect(under, `${JSON.stringify(key)} sits under ${JSON.stringify(root)}`).toBe(false);
      }
    }
  });

  /** Each live query once: two roots reaching one would start its read twice. */
  it("names only outermost roots, each once", () => {
    for (const [i, key] of DEVICE_SYNC_INVALIDATED.entries()) {
      for (const [j, root] of DEVICE_SYNC_INVALIDATED.entries()) {
        if (i === j) continue;
        const under = root.length <= key.length && root.every((part, k) => key[k] === part);
        expect(under, `${JSON.stringify(key)} sits under ${JSON.stringify(root)}`).toBe(false);
      }
    }
  });
});
