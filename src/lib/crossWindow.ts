/**
 * Which queries a write in *another* window makes stale — the TypeScript half of the cross-window
 * refresh (spec `docs/superpowers/specs/2026-09-19-multi-window-design.md` §4).
 *
 * Rust supplies the fact — `db:changed { tables }`, the user tables a commit wrote — and this module
 * draws the conclusion. **Each table's entry is the union of what that table's own mutations
 * already invalidate in the window that made them**, so the second window refreshes exactly what
 * the first one did. `userTables.json` is the one list both suites read: a table added in Rust
 * without an entry here is a red test in `crossWindow.test.ts`.
 *
 * **View preferences stay per window, and two fences keep them there.** A per-window key must not
 * sit under any root a table maps to — `crossWindow.test.ts` fails one that does — because the
 * *writing* window's own invalidations carry no predicate: deck sort sat at `["decks", "sort"]`,
 * and every deck write a window made re-read whichever order another window had pressed last. It
 * is `["deckSort"]` now. The predicate below is the second fence, for this refresh alone.
 */
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { OWNED_WRITE_KEYS, RELAY_KEY, REVIEW_KEY, SYNC_KEY } from "./query";

/**
 * The `app_meta`-backed queries every window follows: Settings choices, and the home layout — a
 * whole-value save, refreshed so every window writes it from fresh data rather than overwriting
 * another window's change.
 *
 * **And the home page's count of the scanner's tray** (`features/home/keys.ts`'
 * `scannerTrayCountKey`, spelled rather than imported because `lib` imports nothing from
 * `features`). It reads the same stored row as `["scanner", "tray"]` below and is the opposite
 * case: a reader that writes nothing — `scanner_tray` is a plain `SELECT` of the row, so a refresh
 * answers no write and starts no loop — and whose key sits *beside* the tray's rather than under
 * it, so the single-writer predicate never spares it. With a second window the Scanner and the home
 * page are on screen at once, and a scan there is an `app_meta` write here.
 */
export const FOLLOW_LIVE_APP_META: readonly QueryKey[] = [
  ["startView"],
  ["homeLayout"],
  ["marketplace"],
  ["markColors"],
  ["recentCards"],
  ["decks", "lastFormat"],
  ["mirror"],
  ["scanner", "trayCount"],
];

/**
 * View preferences each window keeps for itself (spec §2, decision 4) — never refreshed by another
 * window's write, even one under the same root. Card zoom, list/grid and flatten are not here
 * because they are store state seeded once at launch, never a query.
 */
export const PER_WINDOW_KEYS: readonly QueryKey[] = [
  ["navCollapsed"],
  ["searchOpen"],
  ["deckFolderPane"],
  ["deckSort"],
  ["deckSearchTab"],
  ["printingGroupBy"],
];

/**
 * The `app_meta`-backed queries only one window ever writes, and so the two a refresh must never
 * touch while they are live: the scanner's prefs and its review tray.
 *
 * **The scanner lease is what makes them single-writer.** Only the window holding it mounts
 * `useTray` and `useScannerPrefs` — `ScannerPage` refuses before either hook in any other — and a
 * mounted view holds it on a heartbeat whatever its camera is doing, while every prefs and tray
 * write takes it too. So a live query under these keys is always the owner's, nobody else has
 * anything newer, and a window whose writes have not landed keeps the scanner until they do.
 *
 * **Refreshing the owner's would lose cards.** Its cache *is* the tray: `useTray` holds a card it
 * has just scanned only there, and stores the whole tray 400 ms after scanning pauses. The owner
 * hears its own `db:changed` too, and every one of those stores writes `app_meta` — so a refetch
 * inside that pause replaces the cache with the older stored rows, and the pending write then
 * stores *those*, taking the new cards with it. Invalidating without a refetch is no escape: an
 * invalidated live query refetches on the next focus.
 *
 * So {@link refreshForTables} leaves a live query here alone, and **removes** an idle one — a
 * window that takes the lease later then reads the stored row from scratch, rather than drawing a
 * stale tray while a background refetch catches up — **unless its hook reports something
 * unsaved** ({@link registerUnsavedCheck}). An idle entry is also where a card waits out a write
 * the view left behind: leave the Scanner during a sync and the flush answers `BUSY`, and dropping
 * the entry then either loses the card or hands the retry nothing to write, so it stores `[]` or
 * the default prefs over the row. Such an entry is left exactly as it is — not removed, and not
 * invalidated either, since an invalidated idle query refetches on its next mount.
 */
export const SINGLE_WRITER_KEYS: readonly QueryKey[] = [
  ["scanner", "prefs"],
  ["scanner", "tray"],
];

/** Whether `client` holds rows under one single-writer key that its store has not confirmed. */
type UnsavedCheck = (client: QueryClient) => boolean;

const unsavedChecks = new Map<string, UnsavedCheck>();

/**
 * Let the hook that owns a single-writer key say whether this client has anything under it that
 * is not yet stored — a write queued, on the wire, waiting to retry, or refused with nothing
 * landed since.
 *
 * **The hooks call this at module load and `lib` imports nothing from `features`**, so the
 * dependency runs the one way this folder allows. A key nobody registered reports nothing unsaved,
 * which is right: a hook that was never loaded has never put anything in the cache. Answers the
 * function that takes the check back out, which is what a test needs and the app never calls.
 */
export function registerUnsavedCheck(key: QueryKey, check: UnsavedCheck): () => void {
  const id = JSON.stringify(key);
  unsavedChecks.set(id, check);
  return () => {
    if (unsavedChecks.get(id) === check) unsavedChecks.delete(id);
  };
}

function hasUnsaved(client: QueryClient, key: QueryKey): boolean {
  return unsavedChecks.get(JSON.stringify(key))?.(client) ?? false;
}

const DECKS: readonly QueryKey[] = [["decks"]];

/**
 * The card modal's **In your grimoire** figures — `CardDetailModal`'s file-private `HOLDINGS_KEY`,
 * spelled rather than imported.
 *
 * **No mutation names it, and that is why it has to be named here.** The writing window refreshes
 * it on the falling edge of `useIsMutating` — *any* write, while a card is open — and that edge
 * never crosses a window. `card_holdings` counts `collection_entries`, `wishlist_entries` and the
 * live `deck_cards`, so those three owe it; the first two reach it through `["card"]` below.
 */
const HOLDINGS: QueryKey = ["card", "holdings"];

/**
 * The two reads a `needs_review` sentence feeds: the Needs-review list and the Sync panel's
 * `reviewCount`.
 *
 * *Looks fine* (`ReviewPanel`) is a write to whichever of the six reviewable tables holds the row,
 * and settles exactly these — `REVIEW_KEY` by `setQueryData`, `RELAY_KEY` by invalidation. It is
 * captured into `sync_ops` too, but only on a paired device (`capture.rs`'s cross join), and
 * `reconcile.rs` writes sentences on a device that has paired nothing — so the six tables carry
 * them rather than `sync_ops`.
 */
const REVIEWED: readonly QueryKey[] = [REVIEW_KEY, RELAY_KEY];

/** User table → the query roots a write to it makes stale. */
export const TABLE_KEYS: Readonly<Record<string, readonly QueryKey[]>> = {
  activity: [["activity"]],
  app_meta: [...FOLLOW_LIVE_APP_META, ...SINGLE_WRITER_KEYS],
  card_migrations: [],
  // `OWNED_WRITE_KEYS` is what an ordinary collection write owes; Settings' *Clear collection*
  // owes the two whole card roots on top (`useDataReset`'s `COLLECTION_ROOTS`) — the facets'
  // owned tri-state is under `["cards"]`, and every printing's count and the holdings under
  // `["card"]`.
  collection_entries: [...OWNED_WRITE_KEYS, ["cards"], ["card"], ...REVIEWED],
  // A folder write moves no quantity but does move the effective lock, which the deck builder's
  // search counts by — `useCollectionFolders` settles all three roots for that reason.
  collection_folders: [["collection"], ["cards", "search"], ["decks"], ...REVIEWED],
  // **Nothing, and it cannot be `["share"]`.** `share_list` is a read that *writes*: it reconciles
  // against the relay and upserts every row it hears of on each call (`share/cache.rs`), so an
  // entry reaching the list turns a mounted collection page into a refetch loop across windows —
  // one relay round trip a lap, each holding the write lock. It is latent only while
  // `SHARE_BASE` is a placeholder. The cost of `[]` is a second window's share list going stale
  // until it remounts.
  collection_shares: [],
  deck_audit: DECKS,
  deck_cards: [["decks"], HOLDINGS, ...REVIEWED],
  deck_categories: DECKS,
  deck_folders: [["decks"], ...REVIEWED],
  deck_labels: DECKS,
  deck_note_cards: DECKS,
  deck_notes: DECKS,
  deck_tokens: DECKS,
  deck_undo: DECKS,
  // A deck's name titles its group in the collection's cabinet — `mirror/watch.rs` maps it to both
  // surfaces for the same reason.
  decks: [["decks"], ["collection"]],
  device_names: [SYNC_KEY],
  error_log: [["errorLog"]],
  muted_tags: [["tags-muted"], ["tag-search"], ["tag-children"], ["tags"]],
  price_snapshots: [],
  // The home page's sticky notes, and **one key** because one query reads the whole table: the
  // list is small, every one of the four writes changes its order or its contents, and
  // `useStickyNotes` invalidates exactly this root in the window that made them. It is its own
  // root rather than a child of `["home", …]` because no other query reads `sticky_notes`.
  //
  // ⚠️ Checked against the refresh-loop rule (`multi-window.md`), which is what `collection_shares`
  // above maps to nothing for: a query whose command *writes* the table its own key reads is
  // answered by a write that makes it stale again, once a lap, for ever. `sticky_notes` reads and
  // writes nothing on the way past — the read is a plain `SELECT` — so this table maps normally.
  sticky_notes: [["stickyNotes"]],
  sync_clock: [],
  sync_devices: [SYNC_KEY],
  sync_group: [SYNC_KEY],
  sync_identity: [SYNC_KEY],
  sync_ops: [],
  sync_peers: [],
  // The membership lives here (`entitlement::SUPPORTER_STATUS`), and *Connect Patreon*'s claim is
  // a press that writes it and settles three keys under `["sync"]`. The table is `WITHOUT ROWID`,
  // which the update hook never sees, so Rust marks it by hand from that command and from *Leave
  // group* (`changes::MARKED_BY_COMMAND`).
  sync_state: [SYNC_KEY],
  // Every search row and every printing draws `wishlisted` (`["cards"]`, `["card"]` — the
  // *Clear wishlist* roots), and a deck's missing plan lists the wishes each shortfall could take
  // down — *Send missing to wishlist* settles `["decks"]` for it.
  wishlist_entries: [["wishlist"], ["cards"], ["card"], ["decks"], ...REVIEWED],
  wishlist_folders: [["wishlist"], ...REVIEWED],
};

const BY_TABLE = new Map(Object.entries(TABLE_KEYS));

/** Whether `key` is, or sits under, one of `roots`. */
function under(roots: readonly QueryKey[], key: QueryKey): boolean {
  return roots.some((root) => root.every((part, i) => key[i] === part));
}

/** Whether `key` is, or sits under, a per-window root. */
export function isPerWindowKey(key: QueryKey): boolean {
  return under(PER_WINDOW_KEYS, key);
}

/** Every query root the `tables` make stale, once each. An unknown table maps to nothing. */
export function keysForTables(tables: readonly string[]): QueryKey[] {
  const seen = new Map<string, QueryKey>();
  for (const table of tables) {
    for (const key of BY_TABLE.get(table) ?? []) seen.set(JSON.stringify(key), key);
  }
  return [...seen.values()];
}

/**
 * Invalidate what another window's write made stale, sparing the per-window keys — and settle the
 * single-writer keys the one safe way: a live one untouched, an idle one dropped unless its hook
 * still holds something unsaved ({@link SINGLE_WRITER_KEYS} has why).
 *
 * `cancelRefetch: false` because the writing window hears the event too, after already refreshing
 * itself: this joins that fetch rather than cancelling and restarting it. **The cost lands in the
 * other window**: a read it already had in flight from before the commit is joined as well, and
 * can settle on pre-commit data that stays on screen until the next trigger refreshes it.
 */
export function refreshForTables(client: QueryClient, tables: readonly string[]): void {
  for (const queryKey of keysForTables(tables)) {
    void client.invalidateQueries(
      {
        queryKey,
        predicate: (query: Query) =>
          !isPerWindowKey(query.queryKey) && !under(SINGLE_WRITER_KEYS, query.queryKey),
      },
      { cancelRefetch: false },
    );
    client.removeQueries({
      queryKey,
      predicate: (query: Query) =>
        under(SINGLE_WRITER_KEYS, query.queryKey) &&
        query.getObserversCount() === 0 &&
        !hasUnsaved(client, query.queryKey),
    });
  }
}
