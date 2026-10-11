/**
 * The app itself: startup, windows and the database-changed event, updates, the error log, the clears, the marketplace feed, the archive and the folder mirror.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `appCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import { core } from "@/lib/core";
import type { MarketplaceId } from "../marketplace";
import { invoke, type Unlisten } from "./invoke";

/**
 * How far the native side has got with opening the data folder — the answer to
 * `startup_status` and the payload of `startup:changed`.
 *
 * Opening and migrating the two databases runs on a background thread so the window can paint
 * and the taskbar can draw its icon, and until it finishes the shared state every other command
 * reads is not there — so every other command errors. That is why `boot/DesktopBoot` asks this
 * before it mounts anything that queries.
 *
 * It only ever moves `loading → ready` or `loading → failed`, never back. `message` is a
 * human-written, multi-line sentence naming the folder that would not open, meant to be shown
 * as it is.
 *
 * **One host makes one more move, `ready → failed`, once**: the web host, when its engine's
 * Worker dies under a page that had opened (`core/web/index.ts`). Still never back — nothing
 * returns to `ready` — and never from a native host, whose engine cannot stop while its window
 * lives. `boot/useStartup.ts` keeps its listener after `ready` for exactly this.
 *
 * **`reload` is a host saying that starting again can cure the failure** — and only a host that
 * can mean it sends it. The web host does, for a second tab (the first tab holds the database, and
 * may since have closed) and for an engine that never loaded; neither native host does, because a
 * data folder that would not open will not open the second time either. The light app's boot
 * screen offers the way out it names (`apps/light/BootScreen.tsx`); the desktop's draws the message
 * and nothing else, as it always has.
 */
export type StartupStatus =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "failed"; message: string; reload?: true };

/**
 * How this copy of the app was installed, which decides what an update can do to it.
 * Mirrors `update::InstallKind`.
 *
 * `other` is an MSI install, any Linux build, or anything unrecognised — it hears about a
 * new release and is offered the release page, never an in-app install. Nobody has ever run
 * a Linux build of this app, and an MSI major upgrade is unverified; guessing at either is
 * how a user ends up with two copies.
 */
export type InstallKind = "portable" | "nsis" | "other";

/** One downloadable file on a GitHub release. Mirrors `update::Asset`. */
export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  /**
   * GitHub's own `sha256:<hex>`, and the whole of this updater's integrity story — there is
   * no signing keypair behind it. `null` means the release published no checksum, which the
   * backend treats as un-installable rather than installable-unverified.
   */
  digest: string | null;
}

/** A release newer than the running build. Mirrors `update::ReleaseInfo`. */
export interface ReleaseInfo {
  /** `tag_name` without its leading `v` — `0.3.0`. */
  version: string;
  tag: string;
  /** The release body **verbatim**, markdown and all. Rust interprets none of it;
   *  `packages/ui/lib/releaseNotes.ts` reads it and the settings panel draws the result. */
  notes: string;
  publishedAt: string | null;
  htmlUrl: string;
  assets: UpdateAsset[];
}

/**
 * One entry in the version history. Mirrors `update::ReleaseNote`.
 *
 * {@link ReleaseInfo} without its `assets`, and the subtraction is deliberate: the history is
 * up to thirty releases, each of which carries five assets with a URL and a 64-character
 * digest, and a changelog can use none of it. Only the release the app might install needs an
 * asset list.
 */
export interface ReleaseNote {
  version: string;
  tag: string;
  /** Verbatim, for {@link ReleaseInfo.notes}'s reason. */
  notes: string;
  publishedAt: string | null;
  htmlUrl: string;
}

/**
 * What the ribbon polls. Mirrors `update::UpdateStatus`.
 *
 * `available` is `null` both for "up to date" and for "never checked" — `lastCheckAt` is
 * what tells those apart, and a panel that renders "you're up to date" before the first
 * check has answered is claiming something it does not know.
 */
export interface UpdateStatus {
  currentVersion: string;
  installKind: InstallKind;
  available: ReleaseInfo | null;
  /** The asset this install kind would download, already picked by the backend. `null` when
   *  there is no update, or when the release carries nothing this install can use. */
  asset: UpdateAsset | null;
  /** Unix seconds, as a string — `SyncStatus.lastCheckAt`'s shape. */
  lastCheckAt: string | null;
  busy: boolean;
  /** A verified build is on disk and one restart away. */
  staged: boolean;
}

/** Payload of `update:progress`. One phase, and it is "downloading". */
export interface UpdateProgressEvent {
  done: number;
  total: number;
}

/**
 * Which of the app's dealings with the outside world a failure belongs to.
 *
 * Mirrors `errors::Source` and the `CHECK` on `error_log.source`. A closed union, so a new
 * arm on the Rust side is a type error here rather than a blank badge.
 */
export type ErrorSource =
  | "scryfall_api"
  | "scryfall_image"
  | "github_update"
  | "database"
  | "image_store"
  | "relay";

/** The shape of a failure. Mirrors `errors::Kind` and the `CHECK` on `error_log.kind`. */
export type ErrorKind = "rate_limited" | "timeout" | "http" | "io" | "parse" | "other";

/**
 * What one downloaded price feed's table looks like right now — `marketplace_feed_meta`, plus
 * a row for a feed that has never been fetched.
 *
 * Only the **feed-backed** marketplaces have one of these. TCGplayer and Cardmarket arrive
 * with the card data and have no refresh of their own, so their freshness is the sync's and is
 * already on the ribbon; Card trader has nothing to fetch at all.
 *
 * `fetchedAt` is `null` exactly when the feed has never been pulled — the table's own column is
 * `NOT NULL`, so a null here means "no row", which is the state a first selection acts on. The
 * three fields answer three different questions and a reader needs all three: `fetchedAt` is
 * when *this app* asked, {@link MarketplaceFeedStatus.feedBuiltAt} is when the *feed* was made,
 * and `rowCount` is how much of it landed.
 */
export interface MarketplaceFeedStatus {
  marketplace: MarketplaceId;
  /** Unix **seconds**, when this app last pulled the feed. `null` = never. */
  fetchedAt: number | null;
  /**
   * The feed's own stamp, as it published it — Card Kingdom's `meta.created_at`, which reads
   * `2026-08-11 21:07:02`. `null` for a feed that publishes none, which is Mana Pool: there is
   * nothing to show and no reason to invent one out of `fetchedAt`.
   */
  feedBuiltAt: string | null;
  /** Rows stored for this feed, as of `fetchedAt`. **`null` when never fetched** — not `0`, so
   *  "nothing downloaded" and "a fetch that landed nothing" stay two states. */
  rowCount: number | null;
  /**
   * Older than the backend's refresh interval (24 h), **or never fetched at all**.
   *
   * Computed there rather than here, and read rather than re-derived: `REFRESH_INTERVAL_SECS`
   * is the one definition of how long a price stays believable, and a second copy of the
   * arithmetic on this side would be a second place for it to drift. A stamp in the future — a
   * clock that moved — counts as stale rather than underflowing.
   */
  stale: boolean;
  /**
   * A refresh is in flight **right now**, whoever started it.
   *
   * The authoritative answer, and the reason it exists: the backend refreshes the selected feed
   * at start-up when its rows are stale or absent, so a fetch can be running before this window
   * has mounted anything. It is one of *three* sources `useMarketplace` reconciles, because
   * this one is only as fresh as the last status read.
   */
  refreshing: boolean;
  /**
   * Whether **this host** can ask the feed at all.
   *
   * `false` for a feed its host has no way to request — Mana Pool in a browser, whose endpoint
   * sends no cross-origin permission, so a page's `fetch` is refused before it leaves (the
   * light-app spec §4; measured in light-app.md §9.1). `true` otherwise, and on every native
   * host always.
   *
   * **A fact about the host and not about the feed's rows**, which is why it is its own field
   * rather than a sixth {@link FeedState}: the picker greys the row and says why, and
   * `useMarketplace` quotes another marketplace instead of drawing a window of em dashes — both
   * from this answer and from nothing a page could find out about where it runs.
   */
  reachable: boolean;
}

/** The phases `marketplace_feed.rs` emits. Four, against `SyncPhase`'s eight: a feed is one
 *  file, so there is no check, no set list and nothing to reclaim. */
export type FeedPhase = "downloading" | "ingesting" | "done" | "error";

/**
 * Payload of the `marketplace:progress` event.
 *
 * **Its own event rather than a new `SyncPhase`**, and that is a decision worth keeping:
 * {@link SyncPhase} is a closed union with a *total* `PHASE_LABEL` map behind it, so a ninth
 * phase arriving from Rust would render `undefined` on the ribbon rather than fail anywhere a
 * test could see. This follows `update:progress`'s precedent instead — a second event with a
 * payload of its own, and a label map that only has to be total over four words.
 *
 * `marketplace` is on the payload because two feeds exist and either can be the one running.
 * Not a complete account of a fetch, for {@link SyncProgressEvent}'s reasons: Tauri drops
 * events emitted before the webview registered its listener, and the **startup refresh can
 * begin before this window has one**. `marketplaceFeedStatus` is the reliable half of the pair.
 */
export interface FeedProgressEvent {
  marketplace: MarketplaceId;
  phase: FeedPhase;
  done: number;
  total: number;
}

/**
 * One row of the error log.
 *
 * `operation` is deliberately *not* a union: the Rust column has no `CHECK`, because a new
 * call site must not need a migration before it is allowed to report that it failed.
 */
export interface ErrorEntry {
  id: number;
  /** Unix **seconds**. A pair, because "started an hour ago and is still going" and
   *  "happened once, an hour ago" are different stories one stamp cannot tell apart. */
  firstAt: number;
  lastAt: number;
  source: ErrorSource;
  operation: string;
  kind: ErrorKind;
  message: string;
  /** The URL, card id or path. Outside the folding grain, so the most recent one wins. */
  detail: string | null;
  /** How many times this exact failure has happened. `1` unless it repeated. */
  count: number;
}

/**
 * What emptying the collection took with it — `crates/grimoire-core/src/reset.rs`.
 *
 * A shape rather than a bare count so the panel's sentence has somewhere to grow, and because
 * the command has always answered an object. The decks themselves stay: a deck is a list of
 * cards, not a list of *your* cards.
 */
export interface CollectionCleared {
  entries: number;
}

/**
 * What emptying the decks took with it.
 *
 * `folders` is its own number because the schema keeps folders their own thing —
 * `decks.folder_id` is `ON DELETE SET NULL`, so clearing them is a second statement the
 * backend takes deliberately.
 *
 * **It carried a third field, `covers`, and losing it is `reset.rs`'s only shape change**: that
 * number counted *files* beside the database rather than rows, and it went with the custom
 * cover on 2026-08-31. A deck is rows now, so the clear is a `DELETE` and nothing else. Two
 * numbers, and this mirror is hand-written with nothing checking it against the crate — a field
 * left here would have arrived `undefined` and read as zero, which is a sentence quietly
 * dropping a count rather than anything going red.
 */
export interface DecksCleared {
  decks: number;
  folders: number;
}

/**
 * What the cache sweep freed.
 *
 * `failed` is not an error: a file another thread holds open cannot be deleted on Windows, and
 * the honest answer is the count that went plus the count that would not. The panel says the
 * second number only when it is non-zero.
 */
export interface CacheCleared {
  files: number;
  bytes: number;
  /** `image_cache` rows dropped — the bookkeeping that vouched for those pictures. */
  rows: number;
  failed: number;
}

/**
 * What one pass of the plain-text mirror did — `apps/desktop/src-tauri/src/mirror/run.rs`.
 *
 * Five counts and no list of names, because the numbers are what a panel says and the names
 * are what the folder says. **`failed` is not an error**, exactly as {@link CacheCleared}'s is
 * not: a file the mirror could not write is one file, the pass carried on past it, and the
 * honest answer is the count that landed beside the count that would not.
 *
 * `unchanged` is the number this whole design rests on. The pass hashes every file it would
 * write against what it last wrote and opens nothing for a match, so a mirror that is already
 * correct costs a read per file and no writes at all — which is why the summary says both
 * numbers rather than only the one that moved.
 */
export interface PassReport {
  written: number;
  unchanged: number;
  /**
   * Files the mirror left alone **because they are not its own** — in practice a `README.txt`
   * that was already in the folder the reader chose.
   *
   * A different fact from every other count here, which is why it is a count of its own:
   * `unchanged` says the bytes on disk are already the bytes we would write, and `failed` says
   * we tried and could not. Neither is true of a file we declined to touch. The backup root is
   * user-choosable — a synced folder, a Dropbox, a stick with a decade of somebody's notes on
   * it — and the manifest is the only authority on which files in it are ours.
   */
  skipped: number;
  /** Files this app would itself have written that it no longer would — a renamed deck's old
   *  folder. Never a file the reader put there; see the spec's pruning rule. */
  pruned: number;
  failed: number;
}

/**
 * Everything the Settings panel draws about the mirror — `apps/desktop/src-tauri/src/mirror/settings.rs`.
 *
 * Two of the five fields are stored settings and three are facts about *this process run*: a
 * pass records what it did in memory, because the numbers describe a folder that may not
 * survive a restart and a count read back after one would be a claim about a disk nobody has
 * looked at since.
 */
export interface MirrorStatus {
  enabled: boolean;
  /** An absolute path. Never blank — a missing or unusable setting reads as `data/export`. */
  root: string;
  /**
   * Unix **seconds as a string**, or `null` when no pass has finished this session.
   *
   * A string for {@link SyncStatus.lastCheckAt}'s reason: a JSON number is an `f64` on this
   * side, and seconds-since-epoch is not a value to round-trip through one.
   *
   * **`null` is an answer and the panel has a sentence for it.** A fresh app has run no pass,
   * and a panel that drew {@link MirrorStatus.lastReport}'s zeroes instead would claim a pass
   * happened and wrote nothing — which is the one thing that cannot be told from a mirror that
   * is already up to date.
   */
  lastRunAt: string | null;
  lastReport: PassReport | null;
  /** The sentence to show when the last pass could not write, or `null` when it went fine. */
  lastError: string | null;
}

/**
 * `changes::DbChanged` — which user tables a commit wrote. Sent to every window, and only while
 * two or more are open; `useCrossWindowRefresh` turns it into invalidations.
 */
export interface DbChanged {
  tables: string[];
}

/** The app commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const appCommands = {
  /**
   * Whether the data folder has finished opening. Answerable before every other command is —
   * it reads no database — so it is the one thing `boot/DesktopBoot` may ask while the rest
   * would error.
   */
  startupStatus: () => invoke<StartupStatus>("startup_status"),
  /**
   * `startup_status`'s fast path: emitted once, when the state leaves `loading`. **Never the
   * only half** — `listen` registers asynchronously, so an emit that lands between the first
   * `startupStatus()` and the registration is dropped, and the poll is what catches it.
   */
  onStartupChanged: (cb: (e: StartupStatus) => void): Unlisten =>
    core.listen<StartupStatus>("startup:changed", cb),

  /** `changes::DB_CHANGED`. Call this once — `useCrossWindowRefresh` does. */
  onDbChanged: (cb: (e: DbChanged) => void): Unlisten => core.listen<DbChanged>("db:changed", cb),
  /** `desktop::window_new` — open another window beside this one (Ctrl+Shift+N). Desktop only. */
  windowNew: () => invoke<void>("window_new"),
  /** `desktop::window_count` — how many windows are open. */
  windowCount: () => invoke<number>("window_count"),

  /** What is already known about a newer release. Reads `app_meta`; makes no network call. */
  /**
   * The error log, newest first. Repeats are folded, so a row's `count` is how many times
   * that exact failure happened rather than how many rows it wrote.
   *
   * `limit` is clamped to `1..=200` by the backend — the low end load-bearing, since SQLite
   * reads a negative `LIMIT` as no limit at all.
   */
  errorLogList: (limit: number) => invoke<ErrorEntry[]>("error_log_list", { limit }),
  /** Empty the log. Answers how many rows went. */
  errorLogClear: () => invoke<number>("error_log_clear"),
  /**
   * The four Settings can throw away — `crates/grimoire-core/src/reset.rs`.
   *
   * **The first three are irreversible and write no history**, which is not an oversight: the
   * deck audit log is per-deck and cascades away with the decks it describes, so there is
   * nowhere for a wipe to be recorded. The typed confirmation in `ConfirmDialog` is the whole
   * of the safety, and it is this side's — the backend takes no `confirm` argument, because a
   * fence the caller passes is a fence the caller can forget.
   *
   * Every one of them is a **table**, not a row: none takes an id, and none can be scoped.
   */
  collectionClear: () => invoke<CollectionCleared>("collection_clear"),
  wishlistClear: () => invoke<number>("wishlist_clear"),
  decksClear: () => invoke<DecksCleared>("decks_clear"),
  /**
   * The fourth, and the one that is not destructive: `data/images/` and `data/tmp/`, both of
   * which the app refetches on demand, and never a table but `image_cache`. (It used to name
   * a third directory it deliberately spared, `data/covers/`; there is no such directory any
   * more — a cover is a card id, so there is no file to spare.)
   *
   * **Rejects while a sync is running**, in a sentence meant to be shown: the corpus download
   * puts 77 MB in `data/tmp/` and reads it back, so a sweep landing between the two fails a
   * job the reader is watching a progress bar for.
   */
  cacheClear: () => invoke<CacheCleared>("cache_clear"),
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  /**
   * Every release the last check saw, newest first — the version history.
   *
   * **Reads a cache and never the network.** `update_check` fetches one page of
   * `/repos/…/releases` to decide whether an update exists and writes the whole page to
   * `app_meta`, so expanding the history costs nothing out of GitHub's 60 requests an hour.
   * An install that has never checked answers `[]`, which the panel says out loud rather
   * than drawing an app with no past.
   */
  updateHistory: () => invoke<ReleaseNote[]>("update_history"),
  /** Ask GitHub. `force` skips the 24 h throttle, which is what the Check now button sends. */
  updateCheck: (force: boolean) => invoke<UpdateStatus>("update_check", { force }),
  /**
   * Download the update, verify it against the release's checksum, and stage it.
   *
   * Changes nothing about the running app — it resolves with the window still open and one
   * more file on disk. Installing is a separate, deliberate call.
   */
  updateDownload: () => invoke<UpdateStatus>("update_download"),
  /** Install what was staged and restart. The window closes moments after this resolves. */
  updateApply: () => invoke<void>("update_apply"),
  /** Open the release on github.com — what an install kind that cannot update itself gets. */
  updateOpenReleasePage: () => invoke<void>("update_open_release_page"),
  onUpdateProgress: (cb: (e: UpdateProgressEvent) => void): Unlisten =>
    core.listen<UpdateProgressEvent>("update:progress", cb),

  /**
   * Download one marketplace's price feed and rewrite its rows. Answers the feed's state
   * afterwards.
   *
   * **Only the feed-backed marketplaces have a feed to refresh** — see
   * {@link MarketplaceFeedStatus} — and asking for another one is refused rather than quietly
   * doing nothing.
   *
   * Long: 63.7 MiB for Card Kingdom, 48.4 MiB for Mana Pool, so it reports through the same
   * `Activity` mechanism every other long job uses and answers `collection::BUSY` under a
   * running sync, like every other write. **A failed fetch leaves the previous prices in
   * place** and writes the reason to `error_log` — stale prices with an honest as-of line beat
   * an empty table — so a rejection here is not a reason to blank a price column.
   */
  marketplaceFeedRefresh: (marketplace: MarketplaceId) =>
    invoke<MarketplaceFeedStatus>("marketplace_feed_refresh", { marketplace }),
  /**
   * Every feed-backed marketplace's state, whether or not it has ever been fetched — one row
   * each, so a panel can draw the list without knowing which ones exist.
   *
   * Reads two small tables and makes no network call, so it is cheap to poll while a refresh
   * is running.
   */
  marketplaceFeedStatus: () => invoke<MarketplaceFeedStatus[]>("marketplace_feed_status"),
  /**
   * A feed being fetched, phase by phase — the ribbon's fast path, beside `sync:progress` and
   * `update:progress`.
   *
   * **Subscribe once**, like both of those: every extra call is another `listen` registration
   * for the life of the app. `useMarketplaceProgress` is that one caller.
   */
  onMarketplaceProgress: (cb: (e: FeedProgressEvent) => void): Unlisten =>
    core.listen<FeedProgressEvent>("marketplace:progress", cb),

  /**
   * The plain-text mirror's whole state, in one round trip — the Backup panel's only read.
   *
   * **Infallible by signature at the far end**, which is the contract rather than an accident:
   * a missing setting row, a hand-edited one and a row a newer build wrote all read as the
   * default, so there is nothing for this call to reject with. It still returns a promise that
   * can reject, because the IPC boundary itself can.
   */
  mirrorStatus: () => invoke<MirrorStatus>("mirror_status"),
  /** Native save picker and a complete ZIP snapshot. False means the picker was cancelled. */
  archiveExport: (): Promise<boolean> => invoke<boolean>("archive_export"),
  /** Native open picker and destructive confirmation, then complete replacement. False means
   *  either dialog was cancelled; true requires all frontend state to be reloaded. */
  archiveImport: (): Promise<boolean> => invoke<boolean>("archive_import"),
  /** A restore replaces row identities and settings; every open window must reload its state. */
  onArchiveRestored: (cb: () => void): Unlisten => core.listen<void>("archive:restored", cb),
  /** Switch the mirror on or off. Takes effect without a restart — the pass thread consults the
   *  setting on every tick rather than reading it once at startup. Answers `BUSY` if a sync
   *  holds the write connection, like every other write here. */
  mirrorSetEnabled: (enabled: boolean) => invoke<void>("mirror_set_enabled", { enabled }),
  /**
   * Let the reader choose the mirror's folder — the OS folder picker, opened at the current
   * root — and point the mirror there. Resolves `true` when it moved and `false` for Cancel,
   * which is not a failure.
   *
   * **Takes no path** (issue #545): Rust opens the picker and saves what it answered, so nothing
   * here can aim the mirror's writes at a folder. It used to be `mirror_set_root(root)`. The
   * rejection is the picker's own sentence, `BUSY` if a sync holds the write connection, or
   * the crate's refusal of a folder it cannot store.
   *
   * **The old folder is left alone**, deliberately: those files are the reader's cards in plain
   * text, and changing a setting is not consent to delete them.
   */
  mirrorPickRoot: () => invoke<boolean>("mirror_pick_root"),
  /**
   * Rewrite every file the mirror owns, now, and answer what the pass did.
   *
   * Runs whether or not the mirror is enabled — an explicit press is an explicit press — and
   * against a **fresh** digest cache, because this is the button a reader reaches for when they
   * suspect the folder is wrong: reusing the thread's cache would let a file somebody deleted
   * by hand read as unchanged, which is the one state this command exists to get out of.
   */
  mirrorRebuild: () => invoke<PassReport>("mirror_rebuild"),
};
