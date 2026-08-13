/**
 * The fake backend's store: **table rows**, and the read handlers that derive the DTOs from
 * them exactly as `src-tauri/src` does.
 *
 * Rows, not DTOs, and the whole design turns on one field. `ownedQuantity` appears on three
 * DTOs in `src/lib/ipc.ts` and answers three different questions: on `CardSummary` it is
 * every copy of one *printing* and finish-blind; on `WishRow` it is the copies filling one
 * *wish* and finish-aware; on `DeckCard` it is one deck's *allocation* — oracle-grained,
 * finish-blind, condition-blind, and claimed neither for a category the user has switched
 * off nor for the `theory` list, whatever the category is called. A fixture that
 * stored DTOs would hard-code all three, they would agree, and every story built on it would
 * teach a reader a model the app does not have. Derived from rows they come out right
 * without anyone deciding that they should.
 *
 * Where a derivation came from is named on each handler. `ipc.ts` is the shape; the Rust
 * file named is the behaviour.
 *
 * **The simplifications, all of them, stated once:**
 *
 * 1. **Text matching is a case-insensitive substring**, not FTS5. The real search
 *    prefix-matches tokens against `name`, `type_line` *and* `search_text` (oracle and face
 *    text) and orders the page by `bm25` with the name weighted ten times the rest. Here it
 *    is a substring over `name` and `type_line` only, and a text search comes back in the
 *    same name order a browse does — so a story must never be *about* relevance ranking.
 *    Only that *default* differs: a sort the reader asked for is applied here exactly as
 *    `sorting::order_by` applies it, because it replaces the ranking either way.
 *    The collection's text filter is the same substring but reaches through the card, which
 *    keeps `list_entries`' real property that an orphan matches no text at all; the
 *    wishlist's is over the wish's own stored `name`, as its `LIKE` is.
 * 2. **The allocator runs on read**, inside {@link readHandlers}'s `deck_get`. In the app
 *    `deck::allocate_deck` writes `deck_allocations` rows on a card write, the Built toggle
 *    or `missing_to_wishlist`, and the read only *attributes* what was stored. There is no
 *    allocations table here, so both halves happen at read time; see `allocate` below for
 *    what that changes — the split between built decks follows deck id here and write order
 *    in the app. **No write calls an allocator**, and there is only one allocator in this
 *    file; {@link writeHandlers} lists the three consequences.
 *    One more falls out of the same choice: a **`theory`** read attributes nothing at all
 *    here, because there is nothing stored to attribute and the allocator reads `live` only.
 *    `deck_allocations` carries no variant, so the app's theory read walks the *live* deck's
 *    claims along the theory rows and can hand one a number where this answers 0 — which is
 *    only reachable with the same oracle card in both lists at once. What both agree on is
 *    the rule `deck::tests::the_allocator_claims_nothing_for_the_theory_variant` pins: a plan
 *    reserves nothing.
 * 3. **`list_sets` is derived from the cards**, because there is no `sets` table in the
 *    fixture. The real one reads every set Scryfall knows, so it can answer a set with no
 *    printings at all; this one cannot produce a set with no rows, only one whose rows are
 *    all digital. Its `setType` is therefore always `null` — `FakeCard` has no `set_type`
 *    column, and nothing renders one.
 * 4. **Both lists' `added` key orders by row id alone** — `collection_list`'s and
 *    `wishlist_list`'s — because neither row type carries a `created_at`. `collection.rs` and
 *    `wishlist.rs` write `created_at, id` in whichever direction was asked for; the id is that
 *    sort's own second term, and it is monotonic with insertion order in a hand-seeded fixture,
 *    so both directions still mean what they say.
 * 5. **Prices come out of the blob with `Number`**, where SQLite writes
 *    `CAST(json_extract(…) AS REAL)`. The two differ only on a value that is neither a
 *    decimal string nor null (SQLite answers `0.0`, this answers `null`), which the blobs
 *    Scryfall publishes do not contain.
 * 6. **No `fill_unknown_power_toughness` pass.** `deck::get_deck` gunzips `raw` to recover a
 *    P/T the `cards` columns are missing; the generator read a *synced* database, so the
 *    columns are already filled — measured over `CARDS` 2026-08-09, 0 of 43 rows lack a P/T
 *    that their type line says they could have.
 * 7. **String order is UTF-16 code units** (`cmp` below), which is SQLite's default `BINARY`
 *    collation over the ASCII names this fixture holds — never `localeCompare`, which sorts
 *    `"a"` before `"B"` and would reorder every list here.
 * 8. **A write's `updated_at` is one second past the newest row in the store**, where SQLite
 *    writes `unixepoch()`. See {@link stamp}: the gallery sorts on that column, so a write has
 *    to raise it, and a wall clock in a fixture seeded at a fixed instant would sometimes lower
 *    it instead. The consequence is that these timestamps are ordering and nothing else — no
 *    story may render one as a date, and nothing does.
 * 9. **A deck's format is validated against `SPECS`' 12 rows**, not `format_specs`' 25
 *    ({@link validFormat}). So `deck_create`/`deck_update` refuse 13 formats the app accepts —
 *    `premodern` among them — which is simplification 3's shape applied to a write: a narrower
 *    table gives a narrower answer.
 * 10. **Every refusal is its Rust sentence verbatim, with one exception.** A story renders
 *    these, so they are copied rather than paraphrased; the parenthetical *why* inside
 *    {@link canonicalGrading}'s refusal is this parser's wording, because serde's could not be.
 * 11. **The import's fold arm reads the whole fixture, where `deck_import::fold_match` reads
 *    200 FTS candidates.** `cards_fts` exists to stop that arm scanning 116 k rows; over 43
 *    it is the scan that is cheap and the index that would be the fiction. Everything the cap
 *    decides — which candidates survive a truncation, and in what order — is therefore
 *    unreachable here, and a story must never be *about* it. What the arm still does exactly
 *    is the judging: {@link foldName}'s table is transcribed character for character and
 *    {@link foldRank} keeps a whole name ahead of a front face, which is the half that decides
 *    which printing a name lands on.
 *
 * Deliberately *not* on that list: `everUncommon`, `power`/`toughness`, `priceUsd` and
 * `isPaper` are **read off their columns**. They are facts the generator took from the full
 * 116 k-row corpus, and re-deriving any of them over a 43-row fixture would answer a question
 * about the fixture while looking like an answer about the card.
 *
 * Nothing here is `async`: these are synchronous functions, and the fake `invoke` in
 * `core.ts` is what makes a command a promise. That keeps `db.test.ts` free of `await` on
 * assertions that are really about arithmetic.
 */
import { CARDS, type FakeCard } from "./cards";
import type { CommandHandler } from "./core";
import { emitFake } from "./event";
import { CURRENT_VERSION, NEXT_VERSION, release } from "./fixtures";
import {
  DEFAULT_PRINTING_GROUP_BY,
  PRINTING_GROUP_BY_OPTIONS,
  isPrintingGroupBy,
} from "@/features/card/printings";
import { SPECS } from "@/features/decks/validation/fixtures";
import type {
  CardDetail,
  CardFace,
  CardFilters,
  CardSummary,
  CategoryKind,
  CollectionQuery,
  CollectionRow,
  CollectionSortKey,
  CollectionSummary,
  DeckAuditEntry,
  DeckAuditKind,
  ErrorEntry,
  DeckCard,
  DeckCategory,
  DeckCoverKind,
  DeckFolder,
  DeckInput,
  DeckPatch,
  DeckRow,
  DeckTag,
  DeckVariant,
  EntryChange,
  EntryInput,
  EntryPatch,
  FacetResponse,
  FinishPrices,
  ImportItem,
  ImportMatch,
  ImportMode,
  ImportOutcome,
  ImportResolveLine,
  ImportResolveRow,
  InstallKind,
  MarketplaceFeedStatus,
  Printing,
  ReleaseInfo,
  SearchRequest,
  SearchSortKey,
  SetSummary,
  SwapResult,
  SyncOutcome,
  SyncStatus,
  TagSuggestion,
  TheoryDiffRow,
  UpdateAsset,
  UpdateStatus,
  WishInput,
  WishRow,
  WishlistQuery,
  WishlistSortKey,
} from "@/lib/ipc";
import {
  DEFAULT_MARKETPLACE,
  FEED_MARKETPLACES,
  MARKETPLACE_IDS,
  isMarketplaceId,
  type MarketplaceId,
} from "@/lib/marketplace";
import type { SortSpec } from "@/lib/sort";

/* ------------------------------------------------------------------ the rows ---------- */

/**
 * One row of `collection_entries` (`schema.rs`).
 *
 * `quantity` may be **0** and the row stays: it still holds the condition, the purchase
 * price and the acquisition story. The wishlist and `deck_cards` are the opposite by table
 * CHECK. Nothing in this file may treat a zero row as absent.
 */
export interface FakeEntry {
  id: number;
  cardId: string;
  finish: "nonfoil" | "foil" | "etched";
  condition: "NM" | "LP" | "MP" | "HP" | "DMG";
  quantity: number;
  tradelistQuantity: number;
  /** Denormalised from `cards` at write time, and the identity a row keeps when its
   *  printing leaves the database. Never null, and never re-read from the card. */
  lang: string;
  setCode: string;
  collectorNumber: string;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  acquiredAt: string | null;
  acquisitionSource: string | null;
  serialNumber: string | null;
  altered: boolean;
  signed: boolean;
  proxy: boolean;
  misprint: boolean;
  grading: string | null;
  conditionOriginal: string | null;
  /** A JSON array of strings, never null — the column defaults to `[]`. */
  tags: string;
  notes: string | null;
  /** A sentence, not a flag: the reconciler writes what happened. */
  needsReview: string | null;
  updatedAt: number;
}

/**
 * One row of `wishlist_entries`.
 *
 * `setCode`/`collectorNumber`/`lang` are here because the table has them and `WishRow` reads
 * them off the *wish* (`w.set_code, w.collector_number, w.lang` in `wishlist.rs`'s SELECT),
 * not off the joined card — a pinned wish outlives its printing exactly as a collection row
 * does. They are nullable, unlike the collection's, because an any-printing wish names no
 * printing to copy them from.
 */
export interface FakeWish {
  id: number;
  /** `null` = any printing. */
  cardId: string | null;
  oracleId: string | null;
  /** Never null: a wish carries its own name because it may never have had a card row. */
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  lang: string | null;
  quantity: number;
  preferredFinish: "nonfoil" | "foil" | "etched" | null;
  notes: string | null;
  needsReview: string | null;
  updatedAt: number;
}

/**
 * One row of `decks`.
 *
 * `coverImagePath` is the one column omitted: the file it names is served at
 * `<origin>/cover/<deckId>`, which is a route this fake's image handler does not have, so
 * storing the path would be storing a string nothing can follow. {@link coverKind} is here
 * without it because that column is what a *tile* reads — which of the two covers is showing —
 * and the answer is a fact whether or not the bytes behind it can be drawn.
 */
export interface FakeDeck {
  id: number;
  name: string;
  formatKey: string;
  description: string | null;
  coverCardId: string | null;
  /**
   * Which of the two covers a tile draws. **A deck may carry both at once and usually does**:
   * `deck_set_cover_image` leaves `cover_card_id` alone and a `coverCardId` patch sets this
   * back to `card_art`, so switching back and forth costs nothing — which is only coherent
   * because this column is the one answer to the question.
   */
  coverKind: DeckCoverKind;
  isBuilt: boolean;
  archived: boolean;
  /** `ON DELETE SET NULL`: deleting a folder surfaces its decks at the root rather than
   *  taking them with it. `null` **is** the root, and {@link FakeDb.deckFolders} is flat. */
  folderId: number | null;
  /** The long-form notebook, and **not** {@link description} — that is the one-line blurb the
   *  gallery tile shows. Two columns because they are two things. */
  notes: string | null;
  /** Whether this deck keeps a `theory` list beside its `live` one. Read on the row as well as
   *  written, because the editor's Live/Theory control *is* this boolean — a switch the app
   *  can set and never see is a switch nothing can draw. */
  theoryEnabled: boolean;
  updatedAt: number;
}

/**
 * One row of `deck_folders`: the gallery's filing tree, flat.
 *
 * The tree is the reader's to build from {@link parentId}, exactly as `deck_folders` has no
 * notion of depth and `deck_folder_list` takes no deck id — a folder belongs to no deck, it
 * files them.
 *
 * **No grain and no unique index**, deliberately mirroring the DDL: unlike a category or a tag,
 * two sibling folders may share a name, and {@link FOLDER_NAME_TAKEN} does not exist.
 */
export interface FakeDeckFolder {
  id: number;
  /** The folder this one sits inside, `null` for the root. `ON DELETE CASCADE` **on itself**,
   *  so deleting a folder takes its sub-folders — and only those — with it. */
  parentId: number | null;
  name: string;
  sortOrder: number;
}

/**
 * One row of `deck_audit`: **what happened, not how to say it.**
 *
 * The whole design of the table is in {@link payload}. Rust records the facts inside the
 * transaction that made the change and `features/decks/auditText.ts` turns them into the
 * sentence a person reads, so a row is never a history that has to be migrated the day the
 * wording changes.
 *
 * A seed carries the rows a deck's **past** writes wrote, and {@link record} appends the ones a
 * story writes — which is what makes "make a change, then open the history" a thing a story can
 * do rather than something a fixture has to be told about in advance.
 */
export interface FakeDeckAudit {
  id: number;
  deckId: number;
  /** Unix **seconds**, like `decks.updated_at`. */
  at: number;
  /**
   * Which list the change was made to — **for the kinds that are about a list at all.** The
   * column is NOT NULL with a CHECK over the two, so every row carries something, and for
   * `category`, `folder`, the label half of `tag` and most `deck` fields that something is the
   * DDL default (`live`, {@link DECK_LEVEL}) rather than a fact. **Do not filter a history by
   * variant.**
   */
  variant: DeckVariant;
  kind: DeckAuditKind;
  /** `null` for the three kinds about no card at all, and for the label half of `tag`. */
  cardId: string | null;
  /** Denormalised at write time: a history line still names its card the day that printing
   *  leaves the card database. */
  cardName: string | null;
  /** **JSON text**, not an object — `payload TEXT NOT NULL CHECK (json_valid(payload))`, so it
   *  arrives as a string and `auditText.ts` is the one module that looks inside it. */
  payload: string;
  /** Signed **copies**, for the day header's roll-up. `0` means "this changed no card count",
   *  never "nothing happened" — a rename, a reorder, a move and a tag all record `0`. */
  delta: number;
}

/**
 * One row of `deck_categories`: a named pile the user owns, and what schema v8 replaced the
 * fixed five-word zone with.
 *
 * Four of them are seeded with every deck ({@link PREDEFINED_CATEGORIES}) and the rest are the
 * user's, always of kind `main`. **`isActive` is the whole of "counts toward nothing"** — the
 * deck's card count, the allocator and `missing_to_wishlist` all read it, and none of them
 * reads {@link kind} for that question. Nothing in this file may branch on a category being
 * the Maybeboard.
 */
export interface FakeDeckCategory {
  id: number;
  deckId: number;
  /** As the user wrote it. Every refusal about a card in this pile names it. */
  name: string;
  kind: CategoryKind;
  isActive: boolean;
  sortOrder: number;
}

/** One row of `deck_tags`: a per-deck label, at most one per card row. `color` names a token
 *  from the app's palette, never a CSS colour — the backend stores what it is handed. */
export interface FakeDeckTag {
  id: number;
  deckId: number;
  name: string;
  color: string;
}

/**
 * One row of `deck_cards`. Grain `(deckId, variant, categoryId, cardId)`
 * (`schema::DECK_CARD_GRAIN`); `quantity > 0` by CHECK.
 *
 * `variant` is in the grain because the same printing may sit in the `live` deck and in the
 * `theory` one at once, and an edit tried out in a plan must never fold into the row the deck
 * is actually sleeved as.
 */
export interface FakeDeckCard {
  id: number;
  deckId: number;
  /** A {@link FakeDeckCategory} of the **same** deck — nothing in the DDL enforces that half,
   *  which is why every card write runs {@link categoryOfDeck} first. */
  categoryId: number;
  variant: DeckVariant;
  cardId: string;
  /** `ON DELETE SET NULL`: deleting a tag untags its cards rather than deleting them. */
  tagId: number | null;
  quantity: number;
  /** Denormalised, like the collection's — the one name an orphaned row still has. */
  name: string;
  setCode: string;
  collectorNumber: string;
  lang: string;
  needsReview: string | null;
}

/**
 * What the updater knows, which is **two `app_meta` rows and one piece of process state** —
 * plus the one thing the app cannot see, which is what GitHub would answer.
 *
 * `update.rs` keeps `update_last_check_at` and `update_latest_seen` in `app_meta` (the
 * release cached **whether or not** it is newer, so that `status` can re-compare it against
 * the running build on every read and the notice clears itself after an update lands), and
 * `Updater::staged`/`Updater::kind` in memory. Every field of `UpdateStatus` is derived from
 * those by {@link toUpdateStatus} — nothing here stores an `available`, an `asset` or a
 * `staged` boolean, for the reason this file's header gives about `ownedQuantity`.
 */
export interface FakeUpdate {
  /** `Updater::kind`. Decides which asset a download would pick, and whether there is one. */
  installKind: InstallKind;
  /** `app_meta.update_last_check_at`, unix seconds as text. `null` = never checked, which is
   *  the only thing that tells "nothing newer" from "haven't looked". */
  lastCheckAt: string | null;
  /** `app_meta.update_latest_seen` — the release the last check saw, newer or not. */
  latestSeen: ReleaseInfo | null;
  /** **Not a row the app has**: the release `api.github.com` would answer the next check
   *  with. It is the other end of the wire, and it is what makes `update_check` do
   *  something a story can watch. */
  remote: ReleaseInfo | null;
  /** `Updater::staged` — a verified build on disk, one restart away. */
  staged: { version: string } | null;
}

/**
 * A state the backend can be in that is not a row.
 *
 * `gone` is the deck a gallery asks for after another view deleted it. `syncError` and
 * `imageFailures` are the two things `SyncStatus` reports that no other surface shows.
 * `busy` is `collection::BUSY` — **and no read here honours it**, deliberately: writes take
 * `AppState.db` and can be refused, reads go through `db_read` and answer through every
 * second of a sync. {@link writeHandlers} is what reads it, all 16 of its writes but
 * `sync_run` and the four update commands, none of which take that lock.
 *
 * The two update states are states rather than errors in the way `gone` is:
 *
 * * **`updateAvailable`** — the check spawned at startup found a newer release and wrote it
 *   to `app_meta` before the window came up, which is the one thing `useUpdate`'s slow poll
 *   exists to catch (`useUpdate.ts:16`). It is read by {@link seenRelease} and
 *   {@link seenAt} together, so the world it produces is coherent: a release *and* the check
 *   that saw it.
 * * **`updateError`** — GitHub refuses the check, and a download fails its checksum. Two
 *   sentences rather than one, because they are two different failures and the panel prints
 *   whichever it got.
 *
 * **`indexCold`** is a third kind again: not a failure and not a row, but the search index
 * mid-build. `facets::run_facets` answers a cold index with `ready: false` and **empty maps**
 * rather than with an error or with zeros, and the UI leaves every control live on it —
 * not-greyed has to mean "we do not know". The fake has no warm-up of its own, so this fault
 * is the only way a story can stand in that state.
 *
 * **`deckMeta`** is the one read failure among them, and it is a read failure on purpose.
 * `busy` is a *write* lock and no read here honours it; `gone` is a row that is not there.
 * This one is `deck_meta.rs`'s own "the deck folders could not be read: …" family, plus
 * `deck_audit`'s and `deck_theory`'s — the five **satellite** reads a deck screen makes beside
 * the deck itself, each of which draws its own refusal line, and the only way to reach one now
 * that the fake answers those commands at all. Deliberately **not** `deck_get` or `deck_list`:
 * those are the deck, and a screen that could not read the deck would not be showing a panel
 * about it.
 *
 * **`feedFetchError`** is the network at the other end of a price feed. `marketplace_feed_refresh`
 * refuses, and — the whole point — **the rows already in `marketplace_prices` stay**, because a
 * failed fetch leaves the previous prices in place and writes the reason to `error_log`. It is
 * the only way a story can stand in the feed state that has prices *and* a failure, which is the
 * state the panel's wording is hardest to get right in.
 */
export type Fault =
  | "busy"
  | "syncError"
  | "imageFailures"
  | "gone"
  | "indexCold"
  | "deckMeta"
  | "updateAvailable"
  | "updateError"
  | "errorLog"
  | "feedFetchError";

export interface FakeDb {
  cards: FakeCard[];
  collectionEntries: FakeEntry[];
  wishlistEntries: FakeWish[];
  decks: FakeDeck[];
  deckFolders: FakeDeckFolder[];
  deckCategories: FakeDeckCategory[];
  deckTags: FakeDeckTag[];
  deckCards: FakeDeckCard[];
  deckAudit: FakeDeckAudit[];
  update: FakeUpdate;
  /**
   * `error_log`, which is empty in every world but the `errorLog` fault's.
   *
   * A **table**, like everything else here, rather than a canned response: `error_log_clear`
   * writes to it, and a panel whose Clear button did nothing would be a panel whose one
   * interaction no story could exercise.
   */
  errorLog: ErrorEntry[];
  /**
   * `app_meta.marketplace` — the one row this whole setting is.
   *
   * A **stored string** rather than a `MarketplaceId`, and `null` for the row not being there
   * at all, because those are the two states the backend actually has to answer for: a fresh
   * install has never written it, and a value written by a different build may name a
   * marketplace this one has never heard of. Store it narrowed and neither case could be
   * reached from a story.
   */
  marketplace: string | null;
  /**
   * `app_meta.printing_group_by` — how the card pane groups its printings list.
   *
   * A **stored string** and `null` for the row not being there, for {@link FakeDb.marketplace}'s
   * reason and it is the same reason twice: a fresh install has never written it, and a value
   * written by a different build may name a grouping this one has never heard of. Both read as
   * `artist`, and only a *write* refuses — so storing it narrowed would put the two states this
   * setting actually has out of a story's reach.
   */
  printingGroupBy: string | null;
  /**
   * `marketplace_prices` — the table that made a third and fourth marketplace possible.
   *
   * Keyed `(marketplace, cardId, finish)` and **not** a column on `cards`, for the schema's own
   * reason: `cards` is dropped and recreated by every sync, so a price stored on it would be
   * destroyed by the next one. Deliberately no foreign key against a card either — a feed and
   * the corpus are collected on different days, so a price for a card this corpus does not have
   * (and the reverse) is expected rather than an error, and {@link marketplaceFeedPrices} leaves
   * genuine holes in on purpose.
   */
  marketplacePrices: FakeMarketplacePrice[];
  /** `marketplace_feed_meta` — one row per feed that has ever been fetched, and **no row at
   *  all** for one that has not, which is the state a first selection acts on. */
  marketplaceFeeds: FakeFeedMeta[];
  fault: Fault | null;
}

/** One row of `marketplace_prices`: what one feed quotes for one printing in one finish. */
export interface FakeMarketplacePrice {
  /** `cardkingdom` | `manapool` — the two marketplaces whose prices are downloaded. */
  marketplace: string;
  /** A `scryfall_id`. Softly referenced: no card row need exist. */
  cardId: string;
  finish: string;
  /** Near Mint, in the marketplace's own currency — Card Kingdom's `price_retail`, Mana Pool's
   *  `price_cents_nm` already divided by 100. Both feeds are USD. */
  price: number;
}

/** One row of `marketplace_feed_meta`. Absent means the feed has never been fetched. */
export interface FakeFeedMeta {
  marketplace: string;
  /** Unix seconds. */
  fetchedAt: number;
  /** The feed's own stamp — Card Kingdom publishes one, Mana Pool publishes none. */
  feedBuiltAt: string | null;
  rowCount: number;
}

/**
 * `card::PRINTING_GROUP_BY_MODES` — every way the card pane groups its printings, in the order
 * the picker offers them and the order the backend's refusal names them in.
 *
 * Derived from `PRINTING_GROUP_BY_OPTIONS` rather than re-listed, for the reason
 * `isMarketplaceId` is imported one setting over: the modes are a *list*, the Rust validates
 * against a copy of that list, and a third copy living in the fake would be the one nothing
 * ever checks — it would keep passing its own tests while telling stories about a mode the app
 * had dropped.
 */
const PRINTING_GROUP_BY_MODES: readonly string[] = PRINTING_GROUP_BY_OPTIONS.map((o) => o.value);

/**
 * What the `errorLog` fault seeds: one of each shape the panel has to draw.
 *
 * A folded repeat (the ×600 an unreachable image host produces — the case the whole grain
 * exists for), a rate limit (the one kind that is the app's own behaviour to fix), a row with
 * no `detail`, and one old enough to read "days ago". Stamps are relative to *now* so the
 * relative times stay true whenever a story runs.
 */
export function errorLogSeed(now: number = Math.floor(Date.now() / 1000)): ErrorEntry[] {
  return [
    {
      id: 1,
      firstAt: now - 900,
      lastAt: now - 120,
      source: "scryfall_image",
      operation: "image_fetch",
      kind: "timeout",
      message: "timed out after 10s",
      detail: "https://cards.scryfall.io/art/front/0/0/a1b2.webp?1699999999",
      count: 617,
    },
    {
      id: 2,
      firstAt: now - 3_600,
      lastAt: now - 3_600,
      source: "scryfall_api",
      operation: "migrations",
      kind: "rate_limited",
      message: "rate limited by Scryfall; retry after 30s",
      detail: null,
      count: 2,
    },
    {
      id: 3,
      firstAt: now - 300_000,
      lastAt: now - 300_000,
      source: "image_store",
      operation: "image_store",
      kind: "io",
      message: "could not use the image cache: The disk is full.",
      detail: "D:\\MTG Grimoire\\data\\images\\grid\\a1\\a1b2-0.webp",
      count: 1,
    },
  ];
}

/**
 * A store, defaulting to the whole card corpus and nothing owned.
 *
 * `cards` is the shared `CARDS` array by reference rather than a copy: `cards` is the sync's
 * table, no write in this fake ever touches it, and a story that wants a different corpus
 * passes its own. {@link defaultUpdate} is a fresh object every call for the opposite
 * reason — `update_check` and `update_download` write to it.
 */
export function makeDb(init: Partial<FakeDb> = {}): FakeDb {
  return {
    cards: CARDS,
    collectionEntries: [],
    wishlistEntries: [],
    decks: [],
    deckFolders: [],
    deckCategories: [],
    deckTags: [],
    deckCards: [],
    deckAudit: [],
    update: defaultUpdate(),
    // Empty here, and filled by the `errorLog` **fault** rather than by any seed: "what has
    // failed" is a state of the world, not a shape of collection, so every seed can be in
    // either state. `installWorld` is where a fault is applied, so that is where it is filled.
    errorLog: [],
    // The row a fresh install has never written. `get_marketplace` answers the default for it,
    // which is what every story that says nothing about prices is standing in.
    marketplace: null,
    // The same, one row over: `printing_group_by` answers `artist` for a card pane nobody has
    // told, which is the grouping every story that says nothing about it is standing in.
    printingGroupBy: null,
    // Empty here and filled by a seed, exactly as the card corpus is: a downloaded feed is a
    // table with rows in it, and "no rows" is the honest state of an install that has never
    // chosen Card Kingdom. `starterSeed` fills both from the corpus.
    marketplacePrices: [],
    marketplaceFeeds: [],
    fault: null,
    ...init,
  };
}

/* ------------------------------------------------------------------ small helpers ----- */

/**
 * Byte order, which is SQLite's default `BINARY` collation and not `localeCompare` — the
 * latter sorts `"a"` before `"B"` and would reorder every list this file returns.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * One key of a `prices` blob as a number.
 *
 * The blob's values are decimal **strings** or null, so this is
 * `CAST(json_extract(prices, '$.<key>') AS REAL)`. A missing card is `null` rather than a
 * throw — `json_extract(NULL, …)` is NULL, and every price on this side of a LEFT JOIN is
 * reached that way.
 */
function priceKey(card: FakeCard | null, key: string): number | null {
  if (!card) return null;
  const blob = parseJson(card.prices);
  if (typeof blob !== "object" || blob === null) return null;
  const value = (blob as Record<string, unknown>)[key];
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** `collection::FINISH_PRICE_USD`: the finish's own key, never the `price_usd` column. */
function finishPriceUsd(card: FakeCard | null, finish: string): number | null {
  const key = finish === "foil" ? "usd_foil" : finish === "etched" ? "usd_etched" : "usd";
  return priceKey(card, key);
}

/** `collection::FINISH_PRICE_EUR`, hole and all: **`eur_etched` does not exist**, so an
 *  etched card is unpriced in euros rather than valued at the nonfoil rate. */
function finishPriceEur(card: FakeCard | null, finish: string): number | null {
  if (finish === "etched") return null;
  return priceKey(card, finish === "foil" ? "eur_foil" : "eur");
}

/**
 * The `cards.price_eur` **column** — `card_row.rs:275`'s expression, `eur → eur_foil`.
 *
 * **Derived here where its dollar twin is stored**, and the asymmetry is a fact about the
 * fixture rather than about the schema: `cards.ts` is generated wholesale from a local sync
 * that predates this column, so `FakeCard` carries `priceUsd` and no `priceEur`. The column's
 * *definition* is this expression, so deriving it from the same `prices` blob the generator
 * copied is the same number the ingest would have written — and it keeps the fixture
 * regenerable without a hand-edited value in it.
 *
 * **The chain is two links, not three.** `price_usd` falls through `usd → usd_foil →
 * usd_etched`; there is no `eur_etched` key to fall through to, so an etched-only printing has
 * a dollar price here and `null` in euros. That is the hole, at the column level, and it must
 * not be closed by reaching for `usd`.
 */
function priceEurColumn(card: FakeCard | null): number | null {
  return priceKey(card, "eur") ?? priceKey(card, "eur_foil");
}

/* ------------------------------------------------------ price_expr(marketplace) -------- */

/**
 * Which marketplace a query is pricing at — `resolveMarketplace` on the Rust side of the wire.
 *
 * An absent or unknown value is `tcgplayer`, which is what every one of these commands answered
 * before the parameter existed, and is the same fallback `marketplace.ts` makes on this side for
 * the same reason: a query is not the place to fail over a setting.
 */
function marketplaceOf(id: string | null | undefined): MarketplaceId {
  return id && isMarketplaceId(id) ? id : DEFAULT_MARKETPLACE;
}

/** Whether this marketplace's prices come out of `marketplace_prices` rather than out of
 *  `cards.prices`. The one branch in this file that knows a marketplace by name, and it is the
 *  same branch `price_expr` is. */
function isFeed(mp: MarketplaceId): boolean {
  return mp === "cardkingdom" || mp === "manapool";
}

/** One `(marketplace, cardId, finish)` row of `marketplace_prices`, or `null` for the LEFT
 *  JOIN that found nothing — a card that feed has never listed. */
function feedPrice(db: FakeDb, cardId: string | null, finish: string, mp: MarketplaceId) {
  if (cardId === null) return null;
  const row = db.marketplacePrices.find(
    (p) => p.marketplace === mp && p.cardId === cardId && p.finish === finish,
  );
  return row ? row.price : null;
}

/**
 * `price_expr(marketplace)` at the **finish** grain — what one copy of one printing in one
 * finish costs, which is the collection's and the wishlist's figure.
 *
 * Three arms and the hole in the middle one is the data rather than an omission: Scryfall has
 * no `eur_etched` key at all, so an etched card is unpriced on Cardmarket and is never valued at
 * the nonfoil rate instead. A feed's arm has its own holes — a printing it has never listed — and
 * they are answered the same way, with `null`.
 */
function finishPriceAt(
  db: FakeDb,
  card: FakeCard | null,
  finish: string,
  mp: MarketplaceId,
): number | null {
  if (isFeed(mp)) return feedPrice(db, card?.id ?? null, finish, mp);
  if (mp === "cardmarket") return finishPriceEur(card, finish);
  return finishPriceUsd(card, finish);
}

/**
 * `card.rs`'s `FinishPrices` — all three finishes of one printing at one marketplace.
 *
 * The card pane's figures. It is {@link finishPriceAt} three times and deliberately nothing more:
 * a card detail prices exactly what the collection prices, so the two surfaces cannot disagree
 * about what an etched card costs on Cardmarket (nothing — there is no `eur_etched` key) or about
 * a printing a feed has never listed.
 */
function finishPricesAt(db: FakeDb, card: FakeCard | null, mp: MarketplaceId): FinishPrices {
  return {
    nonfoil: finishPriceAt(db, card, "nonfoil", mp),
    foil: finishPriceAt(db, card, "foil", mp),
    etched: finishPriceAt(db, card, "etched", mp),
  };
}

/**
 * `price_expr(marketplace)` at the **nonfoil** grain — a deck card's and a theory row's figure.
 *
 * A deck names a printing and not a finish, so there is no chain here and never has been:
 * `deck.rs` reads `$.usd`/`$.eur` flat, and the feed arm reads the nonfoil row flat beside it.
 */
function nonfoilPriceAt(db: FakeDb, card: FakeCard | null, mp: MarketplaceId): number | null {
  if (isFeed(mp)) return feedPrice(db, card?.id ?? null, "nonfoil", mp);
  return priceKey(card, mp === "cardmarket" ? "eur" : "usd");
}

/**
 * `price_expr(marketplace)` at the **display column** grain — the search row's price, which is a
 * fallback chain across finishes (nonfoil → foil → etched) and must never be summed.
 *
 * `cards.price_usd` is that chain precomputed; the euro column is two links because there is no
 * third key; a feed's is the same three links over its own rows.
 */
function priceColumnAt(db: FakeDb, card: FakeCard | null, mp: MarketplaceId): number | null {
  if (isFeed(mp)) {
    const id = card?.id ?? null;
    return (
      feedPrice(db, id, "nonfoil", mp) ??
      feedPrice(db, id, "foil", mp) ??
      feedPrice(db, id, "etched", mp)
    );
  }
  if (mp === "cardmarket") return priceEurColumn(card);
  return card?.priceUsd ?? null;
}

/**
 * A feed's rows, derived from the corpus a world was seeded with.
 *
 * **Derived rather than hand-written**, for `priceEurColumn`'s reason: `cards.ts` is generated
 * wholesale, so a literal price here would be a number nothing regenerates. Each feed is a fixed
 * multiple of the printing's own Scryfall figure — Card Kingdom a little dearer, Mana Pool a
 * little cheaper, which is roughly how the two sit against TCGplayer in the live data — so a
 * story that switches marketplace shows *different numbers* rather than the same ones under a
 * new label, which is the only thing a reader could check.
 *
 * **Two deliberate holes**, because they are the states the em-dash rule exists for:
 *
 * * a printing with no Scryfall price at all is skipped, so nothing is invented;
 * * **every fourth printing is skipped outright for Mana Pool**, standing in for the card a feed
 *   has simply never listed — the case where one marketplace quotes a card and another does not,
 *   which no amount of currency arithmetic can produce.
 */
export function marketplaceFeedPrices(cards: readonly FakeCard[]): FakeMarketplacePrice[] {
  const rows: FakeMarketplacePrice[] = [];
  cards.forEach((card, index) => {
    for (const finish of ["nonfoil", "foil", "etched"] as const) {
      const usd = finishPriceUsd(card, finish);
      if (usd === null) continue;
      rows.push({
        marketplace: "cardkingdom",
        cardId: card.id,
        finish,
        price: Math.round(usd * 1.1 * 100) / 100,
      });
      if (index % 4 === 3) continue;
      rows.push({
        marketplace: "manapool",
        cardId: card.id,
        finish,
        price: Math.round(usd * 0.92 * 100) / 100,
      });
    }
  });
  return rows;
}

/**
 * `marketplace_feed::REFRESH_INTERVAL_SECS` — 24 h, Card Kingdom's own regeneration cadence.
 *
 * Mirrored rather than imported for the reason every constant in this file is: the fake is a
 * *second implementation* of the backend's rules, and one that read the app's own copy would
 * agree with it by construction rather than by being right.
 */
const FEED_REFRESH_INTERVAL_SECS = 86_400;

/** `marketplace_feed::is_stale` — never fetched is stale by definition, and a stamp in the
 *  future (a clock that moved) counts as stale rather than underflowing. */
function isFeedStale(fetchedAt: number | null, now: number): boolean {
  if (fetchedAt === null) return true;
  return fetchedAt > now || now - fetchedAt >= FEED_REFRESH_INTERVAL_SECS;
}

/**
 * What each feed weighs, measured live on 2026-08-12 — 66 787 283 B for Card Kingdom and
 * 50 741 864 B for Mana Pool.
 *
 * Here so a `downloading` event carries a real denominator: the ribbon prints whole megabytes,
 * and a story showing `0 / 64 MB` is showing the figure the app will actually show.
 */
const FEED_BYTES: Record<string, number> = {
  cardkingdom: 66_787_283,
  manapool: 50_741_864,
};

/** `marketplace_feed_meta` for a set of rows: what a fetch that landed them would have written.
 *  Card Kingdom publishes a build stamp and Mana Pool publishes none, which is the difference
 *  the panel has to draw. */
export function marketplaceFeedMeta(
  rows: readonly FakeMarketplacePrice[],
  fetchedAt: number,
): FakeFeedMeta[] {
  const count = (mp: string) => rows.filter((r) => r.marketplace === mp).length;
  return [
    {
      marketplace: "cardkingdom",
      fetchedAt,
      feedBuiltAt: "2026-08-11 21:07:02",
      rowCount: count("cardkingdom"),
    },
    { marketplace: "manapool", fetchedAt, feedBuiltAt: null, rowCount: count("manapool") },
  ];
}

/** A filter the user actually set — `filters::nonblank`. A picker's "Any set" sends `""`,
 *  which taken literally would match nothing (or, for `format`, be a SQLite error). */
function nonblank(v: string | undefined | null): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/* ------------------------------------------------------------------ ordering ---------- */

/** Two rows compared: one term of an `ORDER BY`, as a function. */
type Compare<T> = (a: T, b: T) => number;

/** Numbers, for a {@link nullsLast} column over money. */
const numeric: Compare<number> = (a, b) => a - b;

/**
 * One sortable column — `sorting::SortColumn`, whose two `&'static str`s become two
 * comparators.
 *
 * Both directions are stated rather than one plus a flip, for the reason that struct's own
 * doc gives for writing out both SQL strings: a nullable column carries its null rule in
 * *both* directions rather than inheriting SQLite's, so `desc` is not always `asc` reversed.
 * {@link reversible} builds the columns where it is, {@link nullsLast} the ones where it is
 * not.
 */
interface SortColumn<T> {
  asc: Compare<T>;
  desc: Compare<T>;
}

/** A column whose `desc` SQL is its `asc` SQL with every term flipped — which is every
 *  non-nullable column in the three tables, the two `CASE` ranks included. */
function reversible<T>(asc: Compare<T>): SortColumn<T> {
  return { asc, desc: (a, b) => asc(b, a) };
}

/**
 * A nullable column carrying `NULLS LAST` in **both** directions.
 *
 * Not {@link reversible}, and that is the whole point of it: reversing `… ASC NULLS LAST`
 * moves the holes to the top, and a reader reversing a sort expects the rows reversed, not
 * the holes moved.
 */
function nullsLast<T, V>(of: (row: T) => V | null, compare: Compare<V>): SortColumn<T> {
  const order = (a: T, b: T, sign: number) => {
    const x = of(a);
    const y = of(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return sign * compare(x, y);
  };
  return { asc: (a, b) => order(a, b, 1), desc: (a, b) => order(a, b, -1) };
}

/**
 * `sorting::order_by`, as a comparator instead of a string of SQL.
 *
 * **Nothing in `src/lib/sort.ts` is reused here, because nothing there sorts rows.** That
 * module answers a header *press* — `applySort` takes a spec and a key and returns the next
 * spec — and its other three exports read a spec for the header's arrow, its rank and its
 * `aria-sort`. The spec `ipc.ts` carries is the whole of what the two sides share; ordering
 * rows is the backend's half, and this is the backend.
 *
 * Every rule `order_by` has:
 *
 * * terms in the order they arrive, the first deciding and the rest breaking its ties;
 * * a key `columns` does not list is **dropped**, never trusted — the property that a sort
 *   can only choose among fixed clauses and never write one;
 * * a repeated key keeps only its first appearance;
 * * anything that is not `"desc"` is ascending, because a typo must be a default and not a
 *   list that refuses to load;
 * * `fallback` is what an empty or wholly unrecognised spec means — the view's own order,
 *   never insertion order — and the table's unique id is appended **always**, because the
 *   pagers use `OFFSET` and a sort that is not a total order shows one row twice.
 */
function orderBy<T, K extends string>(
  spec: SortSpec<K> | undefined,
  columns: Readonly<Partial<Record<K, SortColumn<T>>>>,
  fallback: Compare<T>,
  tiebreak: Compare<T>,
): Compare<T> {
  const parts: Compare<T>[] = [];
  const used = new Set<K>();
  for (const term of spec ?? []) {
    const column = columns[term.key];
    if (column === undefined || used.has(term.key)) continue;
    used.add(term.key);
    parts.push(term.dir === "desc" ? column.desc : column.asc);
  }
  if (parts.length === 0) parts.push(fallback);
  parts.push(tiebreak);
  return (a, b) => {
    for (const part of parts) {
      const n = part(a, b);
      if (n !== 0) return n;
    }
    return 0;
  };
}

/**
 * `CAST(collector_number AS INTEGER)` — the natural collector number both `set` orders sort
 * on before the raw string.
 *
 * `parseInt` matches the CAST on the two shapes a sort can feel: a leading integer wins, and
 * a value with none is 0. Both shapes are in the fixture rather than only in the real corpus
 * — `amh2 5s` parses to 5 and `fin A-248` to 0.
 */
function castInteger(s: string): number {
  return Number.parseInt(s, 10) || 0;
}

/**
 * `search::SEARCH_SORTS`' rarity `CASE`, which is a **rank**: alphabetically `mythic` sits
 * between `common` and `rare`, an order describing nothing anybody wants. `special` and
 * `bonus` are real values with no place in the printed hierarchy and sort after it.
 */
const RARITY_RANK: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  mythic: 3,
  special: 4,
  bonus: 5,
};

/** The `CASE`'s `ELSE 6`, which a NULL rarity takes too — no `WHEN` matches a NULL, so an
 *  unknown rarity and a missing one sort together. */
const RARITY_UNKNOWN = 6;

function rarityRank(rarity: string | null): number {
  if (rarity === null) return RARITY_UNKNOWN;
  return RARITY_RANK[rarity] ?? RARITY_UNKNOWN;
}

/**
 * `collection::COLLECTION_SORTS`' condition `CASE`: grade order, because `DMG` before `LP`
 * is alphabetical order and not what anybody means by condition.
 *
 * Its `ELSE 5` has no counterpart here and needs none — `collection_entries.condition` is
 * `NOT NULL` with a `CHECK` over exactly these five (`schema.rs`), which is the statement
 * `FakeEntry["condition"]` makes in the type system.
 */
const CONDITION_RANK: Record<FakeEntry["condition"], number> = {
  NM: 0,
  LP: 1,
  MP: 2,
  HP: 3,
  DMG: 4,
};

/* ------------------------------------------------------------------ card filters ------ */

/** `filters::COLORS`, WUBRG order. */
const COLORS = ["W", "U", "B", "R", "G"];
/** `filters::MAX_SET_FILTER`. */
const MAX_SET_FILTER = 64;
/** `filters::MANA_VALUE_OPEN_ENDED` — the last chip means "8 or more". */
const MANA_VALUE_OPEN_ENDED = 8;

/**
 * `filters::push_card_filters`, over a row that may have no card.
 *
 * `rowSetCode` is the denormalised set code of the table being filtered — the collection's
 * entry, the wish — or `null` for the search, which reads `cards` and has nowhere else to
 * look. It changes exactly one filter (`coalesce(c.set_code, rows.set_code)`), and the
 * asymmetry is `push_card_filters`' own: a row *displayed* under `lea` must not vanish when
 * the reader filters to `lea`, while format, colour, rarity and mana value are claims only a
 * card row can answer.
 *
 * **What a missing card does to each filter is SQL's NULL rules, not a rule of thumb**, and
 * they do not all agree — measured against SQLite 2026-08-09 (`node:sqlite`, one all-NULL
 * row): `json_extract(NULL,…) IN (…)`, `NULL = 'rare'`, `NULL IN (1.0)`, `NULL >= 8.0` and
 * `NULL = 1` are every one of them NULL, so format, rarity, mana value and `paperOnly` drop
 * an orphan — but the colour filter is written as *exclusions*, and
 * `instr(coalesce(NULL,''),'W') = 0` is **true**, so an orphan passes it — as does the `"C"`
 * branch, whose `color_identity IS NULL` arm says so outright. `push_card_filters`' own doc
 * (`filters.rs`, above the `rows` parameter) summarises the four card-only filters as ones an
 * orphan "simply fails"; that is right for format, rarity and mana value and one filter out
 * of date for colour. This follows the SQL.
 */
function matchesCardFilters(
  card: FakeCard | null,
  f: CardFilters,
  rowSetCode: string | null,
): boolean {
  // `restricted` counts as playable — a Vintage search that hid Black Lotus would be wrong.
  const format = nonblank(f.format);
  if (format !== null) {
    const legalities = parseJson(card?.legalities ?? null);
    const value =
      typeof legalities === "object" && legalities !== null
        ? (legalities as Record<string, unknown>)[format]
        : undefined;
    if (value !== "legal" && value !== "restricted") return false;
  }

  const colors = nonblank(f.colors)?.toUpperCase();
  if (colors !== null && colors !== undefined) {
    const identity = card?.colorIdentity ?? "";
    if (colors === "C") {
      // `(color_identity = '' OR color_identity IS NULL)`.
      if (identity !== "") return false;
    } else {
      // Subset semantics as a deckbuilder means them: "RW" returns mono-R, mono-W, RW and
      // colourless. Expressed as exclusions, which is also why an orphan passes.
      for (const ch of COLORS) {
        if (!colors.includes(ch) && identity.includes(ch)) return false;
      }
    }
  }

  // The one column with two places to read it from.
  const setCode = card?.setCode ?? rowSetCode;
  const wantedSet = nonblank(f.setCode);
  if (wantedSet !== null && setCode !== wantedSet) return false;

  if (f.sets) {
    // OR within, AND without. Sorted before it is deduped and truncated, because that is
    // the order `push_card_filters` does it in and it decides *which* 64 survive.
    const picked = f.sets
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== "")
      .sort(cmp)
      .filter((s, i, all) => i === 0 || all[i - 1] !== s)
      .slice(0, MAX_SET_FILTER);
    if (picked.length > 0 && (setCode === null || !picked.includes(setCode))) return false;
  }

  if (f.manaValues && f.manaValues.length > 0) {
    const cmc = card?.cmc ?? null;
    const exact = new Set(f.manaValues.filter((v) => v < MANA_VALUE_OPEN_ENDED));
    const openEnded = f.manaValues.some((v) => v >= MANA_VALUE_OPEN_ENDED);
    // `cmc` is REAL and nullable: a card with no cost matches no chip, and a fractional
    // un-card cost matches none *below* 8 (exact equality) but is returned by the open-ended
    // chip, which is `>= 8` — the same split `push_card_filters` emits.
    const hit = cmc !== null && (exact.has(cmc) || (openEnded && cmc >= MANA_VALUE_OPEN_ENDED));
    if (!hit) return false;
  }

  const rarity = nonblank(f.rarity);
  if (rarity !== null && (card?.rarity ?? null) !== rarity) return false;

  // Omitted means true — and it keys on `is_paper`, which is the column `filters.rs` emits
  // and `PRINTINGS_WHERE` repeats. Nothing in the app filters on `digital`.
  if (f.paperOnly ?? true) {
    if (!card?.isPaper) return false;
  }

  // Omitted means **false**, which is the one place two neighbouring `…Only` flags disagree
  // about their default — see `filters::CardFilters::playable_only`. The real predicate is
  // `legal_mask != 0`, and the mask is `legalities` folded to one integer over the same two
  // playable values the format filter above accepts, so asking the blob directly is the same
  // question: is this card legal or restricted *anywhere*. An orphan fails it, as it fails
  // format, because `NULL != 0` is NULL.
  if (f.playableOnly ?? false) {
    const legalities = parseJson(card?.legalities ?? null);
    if (typeof legalities !== "object" || legalities === null) return false;
    const values = Object.values(legalities as Record<string, unknown>);
    if (!values.some((v) => v === "legal" || v === "restricted")) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ facet helpers ----- */

/** `CardIndex::COLOR_KEYS` — the six colour chips, `C` last. */
const COLOR_CHIPS = [...COLORS, "C"];

/**
 * `legalities::LEGALITY_KEYS`, the 23 keys `facets::compute` emits a count for.
 *
 * Declared rather than derived from the corpus, because {@link FacetResponse.formats}
 * promises a key is never absent and a story passing a two-card corpus of its own would
 * otherwise emit only the keys those two rows happen to carry. The order is Rust's, where it
 * is bit positions in `cards.legal_mask` and therefore **append only**; here it decides
 * nothing, and it is copied anyway so a reader can diff the two lists.
 */
const LEGALITY_KEYS = [
  "alchemy",
  "brawl",
  "commander",
  "competitivebrawl",
  "duel",
  "future",
  "gladiator",
  "historic",
  "legacy",
  "modern",
  "oathbreaker",
  "oldschool",
  "pauper",
  "paupercommander",
  "penny",
  "pioneer",
  "predh",
  "premodern",
  "standard",
  "standardbrawl",
  "timeless",
  "tlr",
  "vintage",
];

/**
 * Which filter a facet base leaves out — `facets::Skip`, minus its `Nothing` arm, which is
 * `null` here.
 *
 * `sets` covers `setCode` **and** `sets`: they are one dimension, because the picker's counts
 * have to ignore both or opening it on a request that already names a set would offer nothing
 * but that set.
 */
type FacetSkip = "colors" | "mana" | "sets" | "formats" | "owned";

/**
 * The picked-colour string after one chip is pressed — `facets::toggle_colors`, which is
 * itself the mirror of `toggleColor` in `useCardSearch.ts`.
 *
 * `C` is exclusive both ways, because the backend reads a `colors` of exactly `"C"` as
 * colourless-only and anything else as subset-of-these-letters: `"RC"` would silently mean
 * plain `"R"`, so pressing it clears the letters and pressing it again clears the filter.
 *
 * WUBRG order, so the string a count was computed for is the string the UI will send.
 */
function toggleColorString(picked: string, letter: string): string {
  if (picked.includes(letter)) return [...picked].filter((c) => c !== letter).join("");
  if (letter === "C") return "C";
  const on = [...picked].filter((c) => c !== "C");
  on.push(letter);
  return COLORS.filter((c) => on.includes(c)).join("");
}

/** The text simplification, over a card. See simplification 1 in the file header. */
function cardMatchesText(card: FakeCard | null, text: string): boolean {
  if (!card) return false;
  const needle = text.toLowerCase();
  return (
    card.name.toLowerCase().includes(needle) || (card.typeLine ?? "").toLowerCase().includes(needle)
  );
}

/* ------------------------------------------------------------------ derivations ------- */

function cardById(db: FakeDb, id: string | null): FakeCard | null {
  if (id === null) return null;
  return db.cards.find((c) => c.id === id) ?? null;
}

/**
 * `search.rs`'s two correlated subqueries, per result row.
 *
 * `sum(e.quantity)` over *this printing*: finish-blind, condition-blind, and `0` rather than
 * null because "you own none of these" is a fact.
 */
function ownedOfPrinting(db: FakeDb, cardId: string): number {
  return db.collectionEntries
    .filter((e) => e.cardId === cardId)
    .reduce((n, e) => n + e.quantity, 0);
}

/** Pinned to this printing, or unpinned on its oracle card. */
function wishlisted(db: FakeDb, card: FakeCard): boolean {
  return db.wishlistEntries.some(
    (w) =>
      w.cardId === card.id ||
      (w.cardId === null && w.oracleId !== null && w.oracleId === card.oracleId),
  );
}

function toCardSummary(db: FakeDb, c: FakeCard, mp: MarketplaceId): CardSummary {
  // The display **column** at the marketplace the request named: a fallback chain across
  // finishes, never summed, and one number rather than a pair — the backend has already
  // decided whose price this is, so the row carries no second figure to pick between.
  const price = priceColumnAt(db, c, mp);
  return {
    id: c.id,
    name: c.name,
    setCode: c.setCode,
    setName: c.setName,
    collectorNumber: c.collectorNumber,
    rarity: c.rarity,
    typeLine: c.typeLine,
    manaCost: c.manaCost,
    price,
    layout: c.layout,
    oracleId: c.oracleId,
    finishes: c.finishes,
    ownedQuantity: ownedOfPrinting(db, c.id),
    wishlisted: wishlisted(db, c),
    // Uncollapsed, a row *is* a printing: it stands for one, and its "range" is its own
    // price. One shape for both modes, exactly as `search.rs` returns it.
    printings: 1,
    priceLow: price,
    priceHigh: price,
  };
}

/**
 * `search.rs`'s `COLLAPSE_KEY` — what makes two printings the same card.
 *
 * `coalesce(oracle_id, id)`, not a bare `oracleId`: the column is nullable, and grouping on
 * it alone would put every null-oracle printing in one group, showing unrelated cards under
 * a single name. No live row is null, which is exactly why the fake has to model it — a
 * seed *can* mint one.
 */
function collapseKey(c: FakeCard): string {
  return c.oracleId ?? c.id;
}

/**
 * `search.rs`'s collapsed page: one row per card, represented by the **cheapest printing of the
 * newest release** among the printings that matched.
 *
 * Three things here are the parts a fake most easily gets wrong, so each is the real rule:
 *
 * * The **name** is `min(name)` across the group and not the representative's, because 71 of
 *   the corpus's paper groups span two names (reversible cards — `Command Tower` beside
 *   `Command Tower // Command Tower`) and the browse sorts by the same `min`.
 * * `printings` and both price spans describe **what matched**, not the database: filters
 *   narrow printings first and the survivors are grouped.
 * * `ownedQuantity` sums copies of **every** printing of the card, because "do I have this
 *   card" is the question a collapsed row asks. Uncollapsed it stays per printing.
 */
function collapseToCards(db: FakeDb, matched: FakeCard[], mp: MarketplaceId): CardSummary[] {
  const groups = new Map<string, FakeCard[]>();
  for (const c of matched) {
    const key = collapseKey(c);
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }

  return [...groups.values()].map((group) => {
    // One price per printing, at the marketplace the request named, **priced once per printing
    // and then read from this map** — by the representative below and by the span beneath it,
    // so the row cannot pick its printing at one marketplace and quote its range at another.
    //
    // Priced up front rather than inside the comparator, and that is a cost rather than a
    // tidiness point: on a feed marketplace `priceColumnAt` is up to three linear `find`s over
    // every `marketplacePrices` row, and a comparator calls it O(n log n) times per group
    // instead of n. Sorting the `large` seed's 686 groups through it is the fake's slowest path
    // there is.
    const prices = new Map<string, number | null>(
      group.map((c) => [c.id, priceColumnAt(db, c, mp)]),
    );
    const priceOf = (c: FakeCard): number | null => prices.get(c.id) ?? null;
    // `released_at DESC, price ASC NULLS LAST, id DESC` — the real pick, in three keys.
    //
    // * **The date first**, because the row stands for the card as it is printed *now*: a
    //   cheaper old printing must not pull the row back to it.
    // * **Then the price**, which is what makes the row the cheapest way into that latest
    //   release. Every printing sharing the newest date is weighed together **whatever set it
    //   is in**, and the missing set key is deliberate rather than an omission: promo sets are
    //   `p`-prefixed (`pkhm` beside `khm`), so a `set_code DESC` tie-break would hand every
    //   same-day tie to the promo printing — measured dearer far more often than not, which is
    //   the one thing a rule called "cheapest" must never do.
    // * **A `null` sorts last, never first.** It means "this marketplace does not quote this
    //   printing", not "free", so it loses to every priced printing of the same date and only
    //   represents the card when nothing of that date is priced at all.
    // * `id` last, so the pick is total and stable — unchanged.
    const rep = [...group].sort((a, b) => {
      const byDate = cmp(b.releasedAt, a.releasedAt);
      if (byDate !== 0) return byDate;
      const pa = priceOf(a);
      const pb = priceOf(b);
      if (pa !== pb) {
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      }
      return cmp(b.id, a.id);
    })[0];
    // **The span covers the printings this marketplace prices**, and no others. Not one span
    // converted: a group whose only priced printing is etched has a TCGplayer span and no
    // Cardmarket one at all, and a group a feed has never listed has none there — the hole
    // showing up as an absent range rather than as a narrower one.
    const priced = [...prices.values()].filter((p): p is number => p !== null);
    return {
      ...toCardSummary(db, rep, mp),
      name: group.reduce((min, c) => (c.name < min ? c.name : min), group[0].name),
      printings: group.length,
      priceLow: priced.length > 0 ? Math.min(...priced) : null,
      priceHigh: priced.length > 0 ? Math.max(...priced) : null,
      ownedQuantity: group.reduce((n, c) => n + ownedOfPrinting(db, c.id), 0),
      wishlisted: group.some((c) => wishlisted(db, c)),
    };
  });
}

/**
 * `card.rs`'s `parse_faces`, including the two decisions in it that are easy to lose.
 *
 * A nameless face is **defaulted, never dropped** — the flip control addresses faces by
 * index, so a skipped face silently renumbers every face after it. And a `mana_cost` of
 * `""`, which is what a transform's back carries, becomes `null` rather than rendering as a
 * cost of `{}`.
 */
function parseFaces(json: string | null): CardFace[] {
  const value = parseJson(json);
  if (!Array.isArray(value)) return [];
  return value.map((face): CardFace => {
    const str = (key: string): string | null => {
      const v = (face as Record<string, unknown>)[key];
      return typeof v === "string" ? v : null;
    };
    const manaCost = str("mana_cost");
    return {
      name: str("name") ?? "",
      typeLine: str("type_line"),
      oracleText: str("oracle_text"),
      manaCost: manaCost === "" ? null : manaCost,
      artist: str("artist"),
    };
  });
}

function toCardDetail(db: FakeDb, c: FakeCard, mp: MarketplaceId): CardDetail {
  return {
    id: c.id,
    oracleId: c.oracleId,
    name: c.name,
    setCode: c.setCode,
    setName: c.setName,
    collectorNumber: c.collectorNumber,
    rarity: c.rarity,
    layout: c.layout,
    lang: c.lang,
    manaCost: c.manaCost,
    cmc: c.cmc,
    typeLine: c.typeLine,
    oracleText: c.oracleText,
    illustrationId: c.illustrationId,
    artist: c.artist,
    releasedAt: c.releasedAt,
    legalities: c.legalities,
    // Priced here rather than handed over as a blob, because two of the four marketplaces have
    // no blob to hand over — `card_detail` takes a marketplace like every other priced read.
    finishPrices: finishPricesAt(db, c, mp),
    finishes: c.finishes,
    imageStatus: c.imageStatus,
    faces: parseFaces(c.faces),
  };
}

function toPrinting(db: FakeDb, c: FakeCard, mp: MarketplaceId): Printing {
  return {
    id: c.id,
    setCode: c.setCode,
    setName: c.setName,
    collectorNumber: c.collectorNumber,
    releasedAt: c.releasedAt,
    rarity: c.rarity,
    illustrationId: c.illustrationId,
    artist: c.artist,
    lang: c.lang,
    finishes: c.finishes,
    finishPrices: finishPricesAt(db, c, mp),
    promo: c.promo,
    fullArt: c.fullArt,
    frameEffects: c.frameEffects,
    borderColor: c.borderColor,
    layout: c.layout,
  };
}

function toCollectionRow(
  db: FakeDb,
  e: FakeEntry,
  card: FakeCard | null,
  mp: MarketplaceId,
): CollectionRow {
  return {
    id: e.id,
    cardId: e.cardId,
    // Every `cards`-derived field is nullable; the entry's own three never are.
    name: card?.name ?? null,
    setCode: e.setCode,
    setName: card?.setName ?? null,
    collectorNumber: e.collectorNumber,
    lang: e.lang,
    rarity: card?.rarity ?? null,
    manaCost: card?.manaCost ?? null,
    typeLine: card?.typeLine ?? null,
    layout: card?.layout ?? null,
    finish: e.finish,
    condition: e.condition,
    quantity: e.quantity,
    tradelistQuantity: e.tradelistQuantity,
    unitPrice: finishPriceAt(db, card, e.finish, mp),
    purchasePrice: e.purchasePrice,
    purchaseCurrency: e.purchaseCurrency,
    acquiredAt: e.acquiredAt,
    acquisitionSource: e.acquisitionSource,
    serialNumber: e.serialNumber,
    altered: e.altered,
    signed: e.signed,
    proxy: e.proxy,
    misprint: e.misprint,
    grading: e.grading,
    tags: e.tags,
    notes: e.notes,
    needsReview: e.needsReview,
    updatedAt: e.updatedAt,
  };
}

/* ------------------------------------------------------------------ scopes ------------ */

/** `collection::FINISHES`/`CONDITIONS` — a filter value outside the enum is dropped rather
 *  than matched, because it can only come from a stale payload and would empty the list
 *  with no explanation. */
const FINISHES: FakeEntry["finish"][] = ["nonfoil", "foil", "etched"];
const CONDITIONS: FakeEntry["condition"][] = ["NM", "LP", "MP", "HP", "DMG"];

function inList(value: string, picked: string[] | undefined, allowed: string[]): boolean {
  if (!picked) return true;
  const values = picked.filter((v) => allowed.includes(v));
  return values.length === 0 || values.includes(value);
}

/** `collection::scope` — the `WHERE` the page, the count and the summary all share, because
 *  a header taken over different rows than the list is a header describing another screen. */
function collectionScope(db: FakeDb, q: CollectionQuery): FakeEntry[] {
  const text = nonblank(q.text);
  return db.collectionEntries.filter((e) => {
    const card = cardById(db, e.cardId);
    // A text filter is a statement about a card, so it narrows to rows that still have one.
    if (text !== null && !cardMatchesText(card, text)) return false;
    // `paperOnly` forced off: the user owns what the user owns.
    if (!matchesCardFilters(card, { ...q, text: undefined, paperOnly: false }, e.setCode)) {
      return false;
    }
    if (!inList(e.finish, q.finishes, FINISHES)) return false;
    if (!inList(e.condition, q.conditions, CONDITIONS)) return false;
    if (q.needsReview === true && e.needsReview === null) return false;
    if (q.needsReview === false && e.needsReview !== null) return false;
    return true;
  });
}

/**
 * The printing a wish is *about*: its own, or the newest printing of its oracle card.
 *
 * `ORDER BY released_at DESC, id ASC LIMIT 1` — a printing rather than *the* printing, which
 * is what makes a set filter over an any-printing wish a loose question with a loose answer.
 */
function wishCard(db: FakeDb, w: Pick<FakeWish, "cardId" | "oracleId">): FakeCard | null {
  if (w.cardId !== null) return cardById(db, w.cardId);
  if (w.oracleId === null) return null;
  return (
    db.cards
      .filter((c) => c.oracleId === w.oracleId)
      .sort((a, b) => cmp(b.releasedAt, a.releasedAt) || cmp(a.id, b.id))[0] ?? null
  );
}

/**
 * `wishlist::OWNED_SQL` — copies the collection holds **against this wish**.
 *
 * Every term of the wish narrows it: the printing if it names one, else every printing of
 * the oracle card; and the finish if it names one, because a foil wish is not satisfied by
 * the nonfoil in the binder. Condition is deliberately not a term — a wishlist has nowhere
 * to say "and in NM". `sum(quantity)`, so a collection row stepped to zero contributes
 * nothing: a wish is filled by copies, not by paperwork.
 */
function ownedAgainstWish(db: FakeDb, w: FakeWish): number {
  return db.collectionEntries
    .filter((e) => {
      if (w.preferredFinish !== null && e.finish !== w.preferredFinish) return false;
      if (w.cardId !== null) return e.cardId === w.cardId;
      if (w.oracleId === null) return false;
      return db.cards.some((c) => c.id === e.cardId && c.oracleId === w.oracleId);
    })
    .reduce((n, e) => n + e.quantity, 0);
}

function toWishRow(db: FakeDb, w: FakeWish, mp: MarketplaceId): WishRow {
  const card = wishCard(db, w);
  // The cheapest way to satisfy the wish: the preferred finish's price, else nonfoil's.
  const finish = w.preferredFinish ?? "nonfoil";
  return {
    id: w.id,
    oracleId: w.oracleId,
    cardId: w.cardId,
    name: w.name,
    setCode: w.setCode,
    collectorNumber: w.collectorNumber,
    lang: w.lang,
    rarity: card?.rarity ?? null,
    manaCost: card?.manaCost ?? null,
    // Off the joined card like `rarity` and `manaCost` beside it, and `null` when there is no
    // card to join — an any-printing wish, or one whose printing has left the corpus. Nothing on
    // the wishlist draws it; it is what files a dragged wish into a deck category
    // (`autoCategoryFor`), which is a story `AppShell` can play.
    typeLine: card?.typeLine ?? null,
    quantity: w.quantity,
    preferredFinish: w.preferredFinish,
    unitPrice: finishPriceAt(db, card, finish, mp),
    ownedQuantity: ownedAgainstWish(db, w),
    notes: w.notes,
    needsReview: w.needsReview,
    updatedAt: w.updatedAt,
  };
}

function wishlistScope(db: FakeDb, q: WishlistQuery): FakeWish[] {
  const text = nonblank(q.text);
  return db.wishlistEntries.filter((w) => {
    const card = wishCard(db, w);
    if (!matchesCardFilters(card, { ...q, text: undefined, paperOnly: false }, w.setCode)) {
      return false;
    }
    // Matched against the **stored name**, not through the card: a wish may have no card row
    // at all. `LIKE` is case-insensitive over ASCII, which is what `toLowerCase` gives.
    if (text !== null && !w.name.toLowerCase().includes(text.toLowerCase())) return false;
    if (q.fulfilled !== undefined) {
      const owned = ownedAgainstWish(db, w);
      if (q.fulfilled && owned < w.quantity) return false;
      if (!q.fulfilled && owned >= w.quantity) return false;
    }
    if (q.needsReview === true && w.needsReview === null) return false;
    if (q.needsReview === false && w.needsReview !== null) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ decks ------------- */

/**
 * `schema::DECK_VARIANTS` — the two decks every deck secretly is.
 *
 * `live` is what is sleeved up: the gallery's count, the allocator and `missing_to_wishlist`
 * read it and nothing else. `theory` is what the deck is being built toward, and a plan
 * reserves no copy of anything. {@link LIVE} is index 0 rather than a second spelling of the
 * word, exactly as `deck::LIVE` is.
 */
const VARIANTS: DeckVariant[] = ["live", "theory"];
const LIVE = VARIANTS[0];

/**
 * `deck::KIND_PRIORITY` — a permutation of `schema::CATEGORY_KINDS`, and the order the
 * allocator spends scarce copies in: the commander first, then the deck, then the cards
 * played beside it.
 *
 * **Only the order.** What is allocated for *at all* is `isActive`, which belongs to the
 * category and not to its kind — so a Maybeboard the user switched on is allocated for like
 * anything else, and a `main` category they switched off is not. `maybe` sitting last here is
 * a preference and nothing more. Two categories of one kind (a deck may own any number of
 * `main` ones) tie and are separated by row id, which is what makes the walk deterministic.
 */
const KIND_PRIORITY: CategoryKind[] = ["commander", "main", "side", "companion", "maybe"];

/**
 * `DeckRow.cardCount`'s definition, and the engine's `SIZE_KINDS` verbatim — a third copy of
 * three words that must stay one rule (`engine.ts`, `deck.rs`'s `DECK_SELECT`, here).
 *
 * The switch decides whether a pile counts at all; the kind decides only whether it is played
 * *beside* the deck or *in* it, and only `side` and `companion` are beside it — CR 100.4a and
 * EDH's "effectively a 101st card". `maybe` is on the list for that reason and not by
 * oversight: an *active* Maybeboard is a pile the reader deliberately switched on, and leaving
 * it out of the size while the copy and legality rules counted it gave two answers to one
 * question.
 *
 * A *kind* filter and therefore only half of the count — see {@link toDeckRow}.
 */
const SIZE_KINDS: CategoryKind[] = ["main", "commander", "maybe"];

/**
 * `schema::PREDEFINED_CATEGORIES` as `(kind, name, isActive)` — the categories every deck is
 * born with, seeded by {@link ensurePredefinedCategories}.
 *
 * **There is deliberately no `main` row.** A category the user makes is always `main` and a
 * deck may own any number of them, so there is nothing singular about `main` to predefine; it
 * is the four *fixed* rules roles that get one guaranteed category each. The Maybeboard's
 * `false` is where "counts toward nothing" is decided, and it is the only thing that makes it
 * special: it is one seeded row like the other three.
 */
const PREDEFINED_CATEGORIES: [CategoryKind, string, boolean][] = [
  ["commander", "Commander", true],
  ["side", "Sideboard", true],
  ["companion", "Companion", true],
  ["maybe", "Maybeboard", false],
];

/** `deck::kind_rank`. An unknown kind — impossible past `deck_categories`' own CHECK — sorts
 *  last rather than throwing. */
function kindRank(kind: CategoryKind): number {
  const i = KIND_PRIORITY.indexOf(kind);
  return i < 0 ? KIND_PRIORITY.length : i;
}

function categoryById(db: FakeDb, id: number): FakeDeckCategory | undefined {
  return db.deckCategories.find((c) => c.id === id);
}

function toDeckRow(db: FakeDb, d: FakeDeck): DeckRow {
  return {
    id: d.id,
    name: d.name,
    formatKey: d.formatKey,
    // A LEFT JOIN on `format_specs`: a deck whose format key the table no longer carries
    // still lists, under a null name.
    formatName: SPECS[d.formatKey]?.displayName ?? null,
    description: d.description,
    coverCardId: d.coverCardId,
    coverArtist: cardById(db, d.coverCardId)?.artist ?? null,
    isBuilt: d.isBuilt,
    archived: d.archived,
    // `DECK_SELECT`'s subquery, and three exclusions rather than one. The sideboard and the
    // companion are played *beside* the deck rather than in it; a **theory** row is a plan and
    // belongs on no tile; and an **inactive** category counts toward nothing whatever its
    // kind, which is how the Maybeboard stays out of this without being named here — and how
    // an active one gets *in*. Its `JOIN deck_categories` is an *inner* join — `category_id`
    // is NOT NULL with an enforced foreign key — which is what the `undefined` check is.
    cardCount: db.deckCards
      .filter((dc) => {
        if (dc.deckId !== d.id || dc.variant !== LIVE) return false;
        const category = categoryById(db, dc.categoryId);
        return category !== undefined && category.isActive && SIZE_KINDS.includes(category.kind);
      })
      .reduce((n, dc) => n + dc.quantity, 0),
    updatedAt: d.updatedAt,
    // The four v8 deck columns, read off the row now that a deck stores them.
    coverKind: d.coverKind,
    folderId: d.folderId,
    notes: d.notes,
    theoryEnabled: d.theoryEnabled,
  };
}

/**
 * `deck_meta::folder_row`. The one derivation in this file that is the identity, and it is
 * worth being explicit about why rather than passing the stored row straight out: the DTO
 * happens to have the same four fields as the table today, and a **copy** is what stops a
 * caller mutating the store through a value it was handed back.
 */
function toDeckFolder(f: FakeDeckFolder): DeckFolder {
  return { id: f.id, parentId: f.parentId, name: f.name, sortOrder: f.sortOrder };
}

/** `deck_audit::list`'s row, copied for {@link toDeckFolder}'s reason. */
function toDeckAudit(a: FakeDeckAudit): DeckAuditEntry {
  return {
    id: a.id,
    deckId: a.deckId,
    at: a.at,
    variant: a.variant,
    kind: a.kind,
    cardId: a.cardId,
    cardName: a.cardName,
    payload: a.payload,
    delta: a.delta,
  };
}

/**
 * `deck_meta::list_categories`' row: the category, and the two numbers a column heading wants
 * at the moment it is drawn.
 *
 * Both are scoped to the **variant that was asked for** and neither is a row count:
 * `card_count` is `sum(quantity)` over the copies filed here, and `total_price` is each
 * printing's nonfoil price **at the marketplace the read named** times its copies. A category
 * holding nothing (or nothing that marketplace prices) reads `null` rather than `0`, because
 * SQL's `sum()` of no non-NULL terms is NULL — and "nothing here has a price" is a different
 * statement from "this is free".
 *
 * `cardCountAllVariants` is the **third** number and the one that is not scoped: a category is
 * not per-variant, and `deck_cards.category_id` is `ON DELETE CASCADE`, so a delete reaches
 * both lists. It is *derived here* rather than stored on `FakeDeckCategory`, like every other
 * DTO field in this file — a stored copy is a number that can disagree with the rows it claims
 * to count, which is the whole reason this fake keeps table rows and derives DTOs.
 */
function toDeckCategory(
  db: FakeDb,
  c: FakeDeckCategory,
  variant: DeckVariant,
  mp: MarketplaceId,
): DeckCategory {
  const filed = db.deckCards.filter((dc) => dc.categoryId === c.id);
  const rows = filed.filter((dc) => dc.variant === variant);
  // One sum, at one marketplace, **skipping what that marketplace does not quote** — so two
  // marketplaces' totals over one pile are two honest partial sums rather than a conversion.
  const totalPrice = ((): number | null => {
    const priced = rows
      .map((dc) => {
        const unit = nonfoilPriceAt(db, cardById(db, dc.cardId), mp);
        return unit === null ? null : unit * dc.quantity;
      })
      .filter((n): n is number => n !== null);
    return priced.length === 0 ? null : priced.reduce((n, p) => n + p, 0);
  })();
  return {
    id: c.id,
    deckId: c.deckId,
    name: c.name,
    kind: c.kind,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    cardCount: rows.reduce((n, dc) => n + dc.quantity, 0),
    totalPrice,
    cardCountAllVariants: filed.reduce((n, dc) => n + dc.quantity, 0),
  };
}

/**
 * `deck_meta::list_tags`' row, counted over the **variant that was asked for** — exactly as
 * {@link toDeckCategory} is, and for the reason the two of them are answered by one read: they
 * describe one list of cards. Scoping one and not the other is how a Theory read came back
 * once with Theory category counts beside Live tag counts.
 */
function toDeckTag(db: FakeDb, t: FakeDeckTag, variant: DeckVariant): DeckTag {
  return {
    id: t.id,
    deckId: t.deckId,
    name: t.name,
    color: t.color,
    cardCount: db.deckCards
      .filter((dc) => dc.tagId === t.id && dc.variant === variant)
      .reduce((n, dc) => n + dc.quantity, 0),
  };
}

/**
 * `deck::allocate_deck`, run at read time: copies of each oracle card this deck secures,
 * keyed by collection entry id.
 *
 * Greedy in {@link KIND_PRIORITY} order over the deck's cards: for each one, the entries of
 * the same *oracle* card — a Bolt is a Bolt — taking the exact printing first, real copies
 * before proxies, then the oldest entry, and never more than the entry still has free. One
 * candidate pool per oracle card, drawn down as the walk spends it, so two categories wanting
 * the same card cannot both be told the same copies are free.
 *
 * **Two filters decide what is allocated for at all, and neither is a kind check**: the row's
 * `variant` must be `live`, because a plan reserves nothing; and its category must be active,
 * because copies held for a card the user has not decided to play are copies another deck
 * cannot have. A Maybeboard switched on allocates like anything else; a `main` category
 * switched off does not.
 *
 * Availability is `entry.quantity` minus the claims of **other built** decks — the whole of
 * what `is_built` means. A deck is never blocked by its own claims, which is why the real one
 * deletes them before counting.
 *
 * **One id-ordered pass over every built deck, the one being read included**, against a
 * single running pool; a built deck then reads the turn it took, and a draft plans with
 * whatever that pass left. Including it is not a detail — allocating the read's own deck
 * *last*, from the leftovers of every other built deck, is a bug that hides behind a
 * plausible number: with one copy and two built decks each wanting it, reading deck 1 lets
 * deck 2 take it and reading deck 2 lets deck 1 take it, so **both read 0 and nobody holds
 * the copy**. Measured before the fix at 2 copies across 3 built decks: 0, 0, 0.
 *
 * **What allocating on read changes.** In the app these claims are *stored* rows, written
 * whenever each deck was last touched, so the split between two built decks follows **write
 * order** and they can together hold more copies than the collection has — each claim made
 * when the other's was different, which `DeckCard.ownedQuantity` warns about in its own doc.
 * Here one pass decides it, so the split follows **deck id** and the claims never overlap.
 * A story about stale or overlapping cross-deck claims is what this cannot stage.
 */
function allocate(db: FakeDb, deckId: number): Map<number, number> {
  if (!db.decks.some((d) => d.id === deckId)) return new Map();

  const claimed = new Map<number, number>();
  let mine: Map<number, number> | null = null;
  // Id order, so the split does not depend on the order `decks` was seeded in.
  for (const built of db.decks.filter((d) => d.isBuilt).sort((a, b) => a.id - b.id)) {
    const taken = allocateAgainst(db, built.id, claimed);
    if (built.id === deckId) mine = taken;
    for (const [entryId, n] of taken) claimed.set(entryId, (claimed.get(entryId) ?? 0) + n);
  }
  return mine ?? allocateAgainst(db, deckId, claimed);
}

/** The greedy walk itself, against an availability baseline. Split out so the pass above can
 *  run it once per built deck without recursing back into itself. */
function allocateAgainst(
  db: FakeDb,
  deckId: number,
  claimed: Map<number, number>,
): Map<number, number> {
  const taken = new Map<number, number>();
  // Two INNER JOINs. On `cards`, because an orphaned row names no oracle card — it is listed
  // and flagged and reads owned 0 until a sync gives it its identity back. And on
  // `deck_categories`, which is where `is_active` is read: the filter that decides whether a
  // row is allocated for at all.
  const wants = db.deckCards
    .filter((dc) => dc.deckId === deckId && dc.variant === LIVE)
    .map((dc) => ({
      row: dc,
      card: cardById(db, dc.cardId),
      category: categoryById(db, dc.categoryId),
    }))
    .filter(
      (w): w is { row: FakeDeckCard; card: FakeCard; category: FakeDeckCategory } =>
        w.card !== null && w.category !== undefined && w.category.isActive,
    )
    .sort((a, b) => kindRank(a.category.kind) - kindRank(b.category.kind) || a.row.id - b.row.id);

  interface Candidate {
    entryId: number;
    cardId: string;
    proxy: boolean;
    available: number;
  }
  const pools = new Map<string, Candidate[]>();

  for (const want of wants) {
    let pool = pools.get(want.card.oracleId);
    if (!pool) {
      pool = db.collectionEntries
        .filter((e) => cardById(db, e.cardId)?.oracleId === want.card.oracleId)
        .sort((a, b) => a.id - b.id)
        .map((e) => ({
          entryId: e.id,
          cardId: e.cardId,
          proxy: e.proxy,
          available: Math.max(0, e.quantity - (claimed.get(e.id) ?? 0)),
        }));
      pools.set(want.card.oracleId, pool);
    }
    // Exact printing, then real copies, then the oldest entry. Computed per deck card
    // rather than once per pool: "exact" is a statement about the card being served.
    const order = [...pool].sort(
      (a, b) =>
        Number(a.cardId !== want.row.cardId) - Number(b.cardId !== want.row.cardId) ||
        Number(a.proxy) - Number(b.proxy) ||
        a.entryId - b.entryId,
    );
    let still = want.row.quantity;
    for (const candidate of order) {
      if (still === 0) break;
      const draw = Math.min(candidate.available, still);
      if (draw > 0) {
        candidate.available -= draw;
        still -= draw;
        taken.set(candidate.entryId, (taken.get(candidate.entryId) ?? 0) + draw);
      }
    }
  }
  return taken;
}

/**
 * `DECK_CARD_SELECT`'s `ORDER BY cat.sort_order, cat.id, dc.name, dc.id` — the order the
 * editor reads a deck in.
 *
 * The first key belongs to the **category** and not to the row, which is why the app sorts in
 * SQL rather than in Rust; `cat.id` breaks a tie between two categories the user gave the same
 * order, so the walk is total. The name is the *row's*, which an orphan has and its `cards`
 * row does not.
 */
function deckReadOrder(db: FakeDb): Compare<FakeDeckCard> {
  const sortOrder = (dc: FakeDeckCard) => categoryById(db, dc.categoryId)?.sortOrder ?? 0;
  return (a, b) =>
    sortOrder(a) - sortOrder(b) ||
    a.categoryId - b.categoryId ||
    cmp(a.name, b.name) ||
    a.id - b.id;
}

/**
 * `deck::owned_by_oracle` then `deck::attribute_owned`: total the claims per oracle card,
 * then hand them to the rows that wanted them.
 *
 * The `min(a.quantity, e.quantity)` clamp is carried across because it is the rule — a deck
 * that reserved four copies of a row the user has since stepped to one owns one of them —
 * even though it can never bind here: nothing is stored between the allocation and the read,
 * so a claim cannot be stale. It is the app's answer to a collection that shrank under it.
 *
 * Attribution walks **the slice's own order**, which {@link deckReadOrder} has already put the
 * rows in — the read's order and never a caller's, so the number a row shows does not depend
 * on how the list was displayed. That is `attribute_owned`'s contract verbatim, which is why
 * this takes the ordered rows rather than sorting them again.
 *
 * **A row in an inactive category is passed over, not served last.** The allocator claimed
 * nothing for it, so there is nothing of its to hand out — and letting it draw on the pool
 * would move copies off the rows that *are* the deck onto a pile that reserves none of them.
 *
 * This walk and {@link allocate}'s are deliberately not the same order — the allocator spends
 * in {@link KIND_PRIORITY}, this hands out in the user's own category order — and the
 * difference shows in exactly one case: one oracle card filed in two categories with fewer
 * copies owned than the two rows want between them. The *total* is the same either way; only
 * which row wears the badge can differ.
 */
function attributeOwned(
  db: FakeDb,
  rows: readonly FakeDeckCard[],
  taken: Map<number, number>,
): Map<number, number> {
  const left = new Map<string, number>();
  for (const [entryId, quantity] of taken) {
    const entry = db.collectionEntries.find((e) => e.id === entryId);
    const oracleId = entry ? cardById(db, entry.cardId)?.oracleId : undefined;
    if (!entry || !oracleId) continue;
    left.set(oracleId, (left.get(oracleId) ?? 0) + Math.min(quantity, entry.quantity));
  }
  const owned = new Map<number, number>();
  for (const row of rows) {
    const oracleId = cardById(db, row.cardId)?.oracleId;
    if (!oracleId || categoryById(db, row.categoryId)?.isActive !== true) {
      owned.set(row.id, 0);
      continue;
    }
    const remaining = left.get(oracleId) ?? 0;
    const take = Math.max(0, Math.min(remaining, row.quantity));
    left.set(oracleId, remaining - take);
    owned.set(row.id, take);
  }
  return owned;
}

/**
 * `deck::read_deck_cards`' row: the deck card, its category, its tag and every fact about the
 * printing.
 *
 * The category arrives as an argument rather than being looked up here, because
 * `DECK_CARD_SELECT` reaches it through an **inner** join — `category_id` is NOT NULL with an
 * enforced foreign key, so a card with no category is a row the schema cannot hold, unlike
 * `card_id`, which is soft by design and reads as a LEFT JOIN's worth of nulls. The tag is the
 * opposite again: `LEFT JOIN deck_tags`, all three fields null together, because
 * `deck_cards.tag_id` is `ON DELETE SET NULL` and an untagged row is the ordinary case.
 */
function toDeckCard(
  db: FakeDb,
  dc: FakeDeckCard,
  category: FakeDeckCategory,
  ownedQuantity: number,
  mp: MarketplaceId,
): DeckCard {
  const card = cardById(db, dc.cardId);
  const tag = dc.tagId === null ? undefined : db.deckTags.find((t) => t.id === dc.tagId);
  return {
    id: dc.id,
    cardId: dc.cardId,
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: category.kind,
    categoryActive: category.isActive,
    variant: dc.variant,
    tagId: tag?.id ?? null,
    tagName: tag?.name ?? null,
    tagColor: tag?.color ?? null,
    quantity: dc.quantity,
    name: dc.name,
    setCode: dc.setCode,
    // Off the **card**, not off the row, exactly as `deck_card_select` reads `c.set_name`:
    // the code and the number are denormalised onto `deck_cards` so an orphan is still listed
    // and counted, and the set's name is not part of that promise. An orphan gets `null` here
    // for free, which is the behaviour `orphanDeckCard` pins.
    setName: card?.setName ?? null,
    collectorNumber: dc.collectorNumber,
    lang: dc.lang,
    needsReview: dc.needsReview,
    oracleId: card?.oracleId ?? null,
    manaCost: card?.manaCost ?? null,
    cmc: card?.cmc ?? null,
    typeLine: card?.typeLine ?? null,
    oracleText: card?.oracleText ?? null,
    colors: card?.colors ?? null,
    colorIdentity: card?.colorIdentity ?? null,
    legalities: card?.legalities ?? null,
    // No `fill_unknown_power_toughness` pass: the generator read a synced database, so
    // `power`/`toughness` are already the `cards` columns the repair exists to recover.
    // Measured over `CARDS` 2026-08-09: 0 of 43 rows are missing a P/T that a creature,
    // Vehicle or Spacecraft type line says they could have.
    power: card?.power ?? null,
    toughness: card?.toughness ?? null,
    layout: card?.layout ?? null,
    rarity: card?.rarity ?? null,
    faces: card?.faces ?? null,
    gameChanger: card?.gameChanger ?? null,
    // A **printing** fact, not a deck fact: `deck_cards` stores no finish, and the LEFT JOIN
    // to `cards` is where this comes from — so an orphan's is `null`, exactly as the SQL's is.
    finishes: card?.finishes ?? null,
    // Printed at uncommon on **any** printing of this oracle card, which is Pauper Commander
    // eligibility. Read off the column, never recomputed over `db.cards`: the generator took
    // it from the full 116 k-row corpus, and re-deriving it would make a fact about the
    // *card* into a fact about the 43-row fixture. Delver of Secrets is the row that proves
    // it — `everUncommon: true`, and the only Delver printing here is the `isd` common, so a
    // recomputation answers `false` and a legal commander renders ineligible. `false` for an
    // orphan, because nothing is known about a card that is not there.
    everUncommon: card?.everUncommon ?? false,
    // The nonfoil price at the marketplace this read named: a deck names a printing, not a
    // finish, and nonfoil is the cheapest way to satisfy it. Never the `price_usd` column,
    // which is a chain across finishes and must not be summed.
    unitPrice: nonfoilPriceAt(db, card, mp),
    ownedQuantity,
  };
}

/* ------------------------------------------------------------------ the three orders -- */

/**
 * `search::SEARCH_SORTS`.
 *
 * **There is no `released` key**, and that is not an omission this fake made: the search
 * table has no Released column to press and the frontend has never sent one, so the order
 * `search.rs` used to carry is gone rather than renamed.
 */
function searchSorts(
  db: FakeDb,
  mp: MarketplaceId,
): Readonly<Record<SearchSortKey, SortColumn<FakeCard>>> {
  return {
    name: reversible((a, b) => cmp(a.name, b.name)),
    // Binder order: set code, then the natural collector number, then the raw string, which
    // breaks the ties the CAST leaves (`5` against `5s`).
    set: reversible(
      (a, b) =>
        cmp(a.setCode, b.setCode) ||
        castInteger(a.collectorNumber) - castInteger(b.collectorNumber) ||
        cmp(a.collectorNumber, b.collectorNumber),
    ),
    type: nullsLast((c) => c.typeLine, cmp),
    rarity: reversible((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity)),
    // The display **column** at the marketplace the request named — the same fallback chain
    // across finishes the Price cell prints, never a finish's own price. A function of the
    // marketplace rather than a module constant, because the order and the figure have to be
    // the same number: this is what the `currency` sort parameter used to guard, now made
    // structural.
    price: nullsLast((c) => priceColumnAt(db, c, mp), numeric),
  };
}

/** `search::ORDER_NAME`, the default for a browse: the card, then its newest printing. */
const SEARCH_BROWSE_ORDER: Compare<FakeCard> = (a, b) =>
  cmp(a.name, b.name) || cmp(b.releasedAt, a.releasedAt);

/**
 * `collection::list_entries`' whole `ORDER BY`: `COLLECTION_SORTS` over
 * `COLLECTION_DEFAULT_ORDER`, with `e.id ASC` appended.
 *
 * The card behind each row is looked up **once per row**, not once per comparison, because
 * `cardById` is a linear scan of `db.cards` and a comparator runs many times more often than
 * there are rows. That is also where the real query does it: `c` is a join, evaluated per row.
 */
function collectionOrder(
  db: FakeDb,
  rows: readonly FakeEntry[],
  spec: SortSpec<CollectionSortKey> | undefined,
  mp: MarketplaceId,
): Compare<FakeEntry> {
  const cards = new Map(rows.map((e) => [e.id, cardById(db, e.cardId)]));
  /** `coalesce(c.name, e.card_id)`: an orphan sorts under its card id rather than at the top
   *  under an empty string. */
  const name = (e: FakeEntry) => cards.get(e.id)?.name ?? e.cardId;
  /** `price_expr(marketplace)` at this row's finish — the same number the Value cell prints,
   *  which is what stops a column being ordered in one marketplace's money while showing
   *  another's. */
  const unitPrice = (e: FakeEntry) => finishPriceAt(db, cards.get(e.id) ?? null, e.finish, mp);
  return orderBy(
    spec,
    {
      name: reversible((a, b) => cmp(name(a), name(b))),
      // The entry's own denormalised printing, which an orphan still has.
      set: reversible(
        (a, b) =>
          cmp(a.setCode, b.setCode) ||
          castInteger(a.collectorNumber) - castInteger(b.collectorNumber) ||
          cmp(a.collectorNumber, b.collectorNumber),
      ),
      // The finish spelled, then the condition **ranked** — see {@link CONDITION_RANK}.
      finish: reversible(
        (a, b) =>
          cmp(a.finish, b.finish) || CONDITION_RANK[a.condition] - CONDITION_RANK[b.condition],
      ),
      quantity: reversible((a, b) => a.quantity - b.quantity),
      // `unit_price_usd * e.quantity` — what the row is **worth**, which is the figure the
      // Value cell prints and therefore what its header must sort by. NULL times a quantity
      // is NULL, so an unpriced finish is a hole; a priced row at quantity 0 is a real zero.
      value: nullsLast((e) => {
        const p = unitPrice(e);
        return p === null ? null : p * e.quantity;
      }, numeric),
      // What **one copy** costs. The other question about the same column, and the one a
      // reader means by "my most expensive card"; no header sends it, the filter bar's
      // select does.
      price: nullsLast(unitPrice, numeric),
      // Simplification 4: no `created_at` column here, so the id — that sort's own second
      // term in `collection.rs` — carries the whole answer, in whichever direction was asked.
      added: reversible((a, b) => a.id - b.id),
    } satisfies Record<CollectionSortKey, SortColumn<FakeEntry>>,
    // `COLLECTION_DEFAULT_ORDER`, written out rather than composed from the `name` and `set`
    // columns above: it stops at the natural collector number and never reaches the raw
    // string those three terms end with.
    (a, b) =>
      cmp(name(a), name(b)) ||
      cmp(a.setCode, b.setCode) ||
      castInteger(a.collectorNumber) - castInteger(b.collectorNumber),
    (a, b) => a.id - b.id,
  );
}

/**
 * `wishlist::list_wishes`' whole `ORDER BY`: `WISHLIST_SORTS` over `w.name ASC`, with
 * `w.id ASC` appended.
 *
 * **There is no `set` key**, and that too is `wishlist.rs`'s decision rather than a gap here:
 * an any-printing wish names no set, and a list where half the rows sort under the same blank
 * is not an order.
 *
 * Both derived figures are taken once per row, which is again where the real query takes
 * them — `owned_quantity` is a scalar subquery and `unit_price_usd` a `json_extract` over the
 * joined printing, and both are output aliases the `ORDER BY` then names.
 */
function wishlistOrder(
  db: FakeDb,
  rows: readonly FakeWish[],
  spec: SortSpec<WishlistSortKey> | undefined,
  mp: MarketplaceId,
): Compare<FakeWish> {
  const ownedBy = new Map(rows.map((w) => [w.id, ownedAgainstWish(db, w)]));
  const priceBy = new Map(
    rows.map((w) => [
      w.id,
      finishPriceAt(db, wishCard(db, w), w.preferredFinish ?? "nonfoil", mp),
    ]),
  );
  const owned = (w: FakeWish) => ownedBy.get(w.id) ?? 0;
  /** The cheapest way to satisfy the wish, per copy: the preferred finish's price if it names
   *  one, else the nonfoil price of the printing the wish is about. */
  const unitPrice = (w: FakeWish) => priceBy.get(w.id) ?? null;
  return orderBy(
    spec,
    {
      name: reversible((a, b) => cmp(a.name, b.name)),
      // `OWNED_SQL`'s finish-aware count — the figure the Owned cell prints, and the one a
      // foil wish does not get from the nonfoil in the binder.
      owned: reversible((a, b) => owned(a) - owned(b)),
      quantity: reversible((a, b) => a.quantity - b.quantity),
      // `unit_price_usd * max(0, w.quantity - owned_quantity)` — what finishing the wish
      // still costs, which is 0 for a fulfilled wish however dear the card is, and a hole
      // when the printing has no price for that finish.
      cost: nullsLast((w) => {
        const p = unitPrice(w);
        return p === null ? null : p * Math.max(0, w.quantity - owned(w));
      }, numeric),
      price: nullsLast(unitPrice, numeric),
      // Simplification 4, exactly as the collection's `added`.
      added: reversible((a, b) => a.id - b.id),
    } satisfies Record<WishlistSortKey, SortColumn<FakeWish>>,
    (a, b) => cmp(a.name, b.name),
    (a, b) => a.id - b.id,
  );
}

/* ------------------------------------------------------------------ the handlers ------ */

/** `search.rs`'s page size when the caller does not choose one, and the ceiling when it
 *  does. `limit: 0` means "use the default", which is why `ipc.ts` keeps it required. */
const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;
/** `search::TOTAL_CAP`. The count stops here and says so; a pager renders `5,000+`. */
const TOTAL_CAP = 5000;
/** `collection.rs`'s and `wishlist.rs`'s, which share both numbers. */
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;
/** `card::MAX_PRINTINGS`, whose own note is that exactly five oracle cards exceed it and
 *  they are the five basic lands. Unreachable from a 43-row fixture; here so the shape of
 *  the answer (`items.length < total`) is the real one. */
const MAX_PRINTINGS = 400;
/** `deck_audit::MAX_LIMIT`. A cap rather than a page cursor, because this table grows by one
 *  row per edit and a built deck is hundreds of rows, not millions. */
const AUDIT_MAX_LIMIT = 500;

function pageLimit(limit: number, fallback: number, max: number): number {
  return limit === 0 ? fallback : Math.min(limit, max);
}

/** What `SyncStatus` answers. Fixed values, because a story fixture with a moving clock is a
 *  story fixture that renders differently every second. */
const SYNC_DATA_DIR = "D:\\Storybook\\data";
/**
 * 2026-08-09T09:00:00Z as unix seconds — the fixture's "now".
 *
 * One literal for three jobs now: the sync's last check, the floor {@link stamp} measures a
 * write's `updated_at` from, and the instant `seeds.ts` dates every seeded row at. Two
 * literals for one instant would be two things to drift — which is why it is exported rather
 * than copied, even though nothing outside this file reads a timestamp as a date.
 */
export const CLOCK_BASE = 1_786_266_000;
/** As a string, which is the column's own type (`sync_meta` is all text). */
const SYNC_LAST_CHECK_AT = String(CLOCK_BASE);
/** Scryfall regenerates `default_cards` in a 21:00–21:45 UTC window, so the ingested file is
 *  from the evening before the check above. */
const SYNC_BULK_UPDATED_AT = "2026-08-08T21:16:00.000Z";
/** `scryfall.rs`'s own wording for the failure a reader is most likely to hit. */
const SYNC_ERROR = "rate limited by Scryfall; retry after 30s";
/** Enough to be a number rather than a flag, which is how the ribbon reads it. */
const IMAGE_STORE_FAILURES = 7;

/* ------------------------------------------------------------------ the updater ------- */

/** `update::CHECK_INTERVAL_SECS`. Unauthenticated `api.github.com` allows 60 requests/hour
 *  per IP, so a check is daily and a poll is out of the question. */
const CHECK_INTERVAL_SECS = 86_400;

/**
 * `update::PORTABLE_SUFFIX` and `update::NSIS_SUFFIX`, verbatim.
 *
 * **Suffixes and never file names**: the version sits in the middle of both, and the name in
 * front of it changed with the app's (v0.2.0's assets still read `mtg-collection-tracker-…`).
 * `pick_asset` lowercases the asset name before the test, and so does {@link pickAsset}.
 */
const PORTABLE_SUFFIX = "-windows-x64-portable.zip";
const NSIS_SUFFIX = "_x64-setup.exe";

/** `update::check`'s 403/429 branch, verbatim. */
const UPDATE_RATE_LIMITED = "GitHub is rate limiting update checks right now. Try again later.";
/** `update::download`'s two refusals, verbatim. The second is a format string in Rust. */
const NO_UPDATE = "there is no update to download.";
const noDownloadFor = (version: string) =>
  `release ${version} has no download for this kind of install. Open the release page instead.`;
/**
 * `update::verify_digest`'s mismatch, which is a format string over the two hashes — the
 * expected one with its `sha256:` prefix already stripped, as the real comparison strips it.
 *
 * The whole of this updater's integrity story: there is no signing keypair behind it, so an
 * **absent** digest is a refusal too rather than an unverified pass. {@link WRONG_DIGEST} is
 * what a corrupted download hashed to, and it only has to differ.
 */
const checksumFailed = (want: string, got: string) =>
  `the download did not match its published checksum (expected ${want}, got ${got}). ` +
  `It has been deleted.`;
const WRONG_DIGEST = "0000000000000000000000000000000000000000000000000000000000000000";
/** `update::apply` with an empty `Updater::staged`. */
const NOTHING_STAGED = "there is no downloaded update to install.";

/**
 * A portable install that checked today and is on the newest release — and a newer one
 * published since.
 *
 * `latestSeen` is the release of the version this fixture *runs*, not `null`, because that is
 * what `update::check` really stores: it caches whatever GitHub answered whether or not it is
 * newer, and `status` re-compares on every read. So "up to date" here is a **derived** answer
 * rather than an absent row, which is the state the app is actually in most of the time.
 *
 * `remote` being one version ahead is what makes "Check now" worth pressing in a story: it is
 * the release published since the last check.
 */
export function defaultUpdate(): FakeUpdate {
  return {
    installKind: "portable",
    lastCheckAt: String(CLOCK_BASE),
    latestSeen: release(CURRENT_VERSION),
    remote: release(NEXT_VERSION),
    staged: null,
  };
}

/** An install that has never asked. `seeds.ts`'s `empty` world — a first run has synced
 *  nothing and checked nothing, and `lastCheckAt: null` is the only thing that says so. */
export function neverCheckedUpdate(): FakeUpdate {
  return { ...defaultUpdate(), lastCheckAt: null, latestSeen: null };
}

/**
 * `update::parse_version` — `v0.3.0` → `[0, 3, 0]`.
 *
 * Three components and nothing else: a tag with a prerelease or build suffix fails to parse
 * rather than being ordered by guesswork, which makes an unreadable tag "no update" instead
 * of "update to something nobody understands".
 */
function parseVersion(s: string): [number, number, number] | null {
  const trimmed = s.trim().replace(/^v/, "");
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  return nums.some(Number.isNaN) ? null : [nums[0], nums[1], nums[2]];
}

/** `update::is_newer`. An unparseable version on either side is `false`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** `update::pick_asset` — matched on the tail of the name, lowercased. `other` picks
 *  nothing, which is the whole of what makes an install kind un-updatable. */
export function pickAsset(assets: UpdateAsset[], kind: InstallKind): UpdateAsset | null {
  if (kind === "other") return null;
  const suffix = kind === "portable" ? PORTABLE_SUFFIX : NSIS_SUFFIX;
  return assets.find((a) => a.name.toLowerCase().endsWith(suffix)) ?? null;
}

/** `update::should_check`. `force` always wins, and a `last` in the future counts as due
 *  rather than throttling until the wall clock catches up. */
export function shouldCheck(last: number | null, now: number, force: boolean): boolean {
  if (force || last === null) return true;
  return last > now || now - last >= CHECK_INTERVAL_SECS;
}

/**
 * `app_meta.update_latest_seen`, with the `updateAvailable` fault folded in.
 *
 * The fault is not a second source of truth: it stands for the check that ran *before the
 * window opened* — `lib.rs` spawns one at startup, it writes `app_meta` and emits nothing —
 * so the world it describes is "the row is already there". Read together with {@link seenAt},
 * which supplies the check that wrote it.
 */
function seenRelease(db: FakeDb): ReleaseInfo | null {
  return db.fault === "updateAvailable" ? db.update.remote : db.update.latestSeen;
}

/** `app_meta.update_last_check_at`, with the same fault folded in. A release seen by no
 *  check is a state the app cannot be in, and a panel reading "Not checked yet" over a
 *  version number would be this fixture inventing one. */
function seenAt(db: FakeDb): string | null {
  return db.fault === "updateAvailable" ? String(CLOCK_BASE) : db.update.lastCheckAt;
}

/**
 * `update::status` — built from what is already known, touching no network.
 *
 * Three fields are derived rather than stored, and each is a rule worth not hard-coding:
 * `available` is the cached release **re-compared against the running version** (which is
 * what makes the notice self-clearing after an update lands), `asset` is
 * {@link pickAsset}'s answer for this install kind, and `staged` is a boolean over an object
 * that carries a version.
 *
 * `busy` is always `false`, for `sync_status`' reason: every handler here is synchronous, so
 * nothing is ever observably in flight. A download in progress is therefore not reachable
 * from a seeded world — it is an argument, and `Settings/UpdatePanel`'s `Downloading` story
 * is where it lives.
 */
function toUpdateStatus(db: FakeDb): UpdateStatus {
  const seen = seenRelease(db);
  const available = seen !== null && isNewer(seen.version, CURRENT_VERSION) ? seen : null;
  return {
    currentVersion: CURRENT_VERSION,
    installKind: db.update.installKind,
    available,
    asset: available === null ? null : pickAsset(available.assets, db.update.installKind),
    lastCheckAt: seenAt(db),
    busy: false,
    staged: db.update.staged !== null,
  };
}

/* ------------------------------------------------------------------ the import -------- */

/**
 * `deck_import::IMPORT_MODES` — what an import may do to the variant it lands in.
 *
 * A list rather than a union type for the Rust's reason: the refusal below **quotes it**, so
 * the two spellings a caller can name and the two the sentence offers are one array. Read
 * `IMPORT_MODES[1]` by index for the same discipline `deck_audit`'s kind constants follow.
 */
const IMPORT_MODES = ["merge", "replace"] as const;
const IMPORT_REPLACE = IMPORT_MODES[1];

/** `deck_import::NOTHING_TO_IMPORT`. It matters most in `replace`, where "do nothing" and
 *  "clear the deck and put nothing back" are the same call with the same arguments. */
const NOTHING_TO_IMPORT = "There is nothing to import.";

/**
 * What {@link readHandlers}'s `deck_import_read_file` says instead of inventing a decklist.
 *
 * **Not a Rust sentence, and the only handler in this file that has none.** The real command
 * takes a path the OS file picker answered, and there is no picker in a browser — so a fake
 * that returned text would be a story about a gesture no reader of that story can make. The
 * dialog's file arm is the live pass's to prove; a story that wants a decklist pastes one.
 */
const NO_FILE_PICKER = "No file picker in Storybook.";

/**
 * `deck_import::fold_name`'s table, transcribed — every character it maps and no other.
 *
 * Keyed on the **lower-case** half of each pair only, because {@link foldName} lowercases
 * before it looks anything up where the Rust lowercases in its fallthrough arm. The two agree
 * on every character in the table: `Á`.toLowerCase() is `á`, and `Æ` is `æ`.
 */
const FOLD_LETTERS: Readonly<Record<string, string>> = {
  á: "a", à: "a", â: "a", ä: "a", ã: "a", å: "a",
  é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ò: "o", ô: "o", ö: "o", õ: "o", ø: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ñ: "n",
  ç: "c",
  ý: "y", ÿ: "y",
  æ: "ae", œ: "oe", ß: "ss",
  "’": "'", "ʼ": "'", "`": "'",
  "–": "-", "—": "-",
};

/**
 * `deck_import::fold_name` — a card name reduced to what two people typing it would agree on:
 * lowercase, no diacritics, one kind of apostrophe, single spaces.
 *
 * Anything not in {@link FOLD_LETTERS} passes through, so a name in a script the table has
 * never heard of folds to itself and still matches itself exactly.
 */
export function foldName(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase()) out += FOLD_LETTERS[ch] ?? ch;
  return out.split(/\s+/u).filter((word) => word !== "").join(" ");
}

/**
 * `deck_import::fold_rank` — how well a card's name folds to what the reader typed: `0` for
 * the whole name, `1` for the front face only, `null` for neither.
 *
 * **A rank rather than a bool**, and that is what keeps an art series from winning: the SQL
 * arms hold the exact name ahead of a front face by *asking in sequence*, and this arm asks
 * once and sorts, so the same preference has to be a sort key or `"N // N"` outranks `N`.
 */
function foldRank(cardName: string, wanted: string): number | null {
  if (foldName(cardName) === wanted) return 0;
  const at = cardName.indexOf(" // ");
  if (at >= 0 && foldName(cardName.slice(0, at)) === wanted) return 1;
  return null;
}

/**
 * `deck_import::MATCH_ORDER` — a printing you own, then the newest, then the id.
 *
 * The `id` tie-break is not decoration: it is what makes an import **deterministic**, so the
 * same list pasted twice puts the same printings in the deck. `releasedAt` needs no coalesce
 * here because {@link FakeCard.releasedAt} is not nullable where `cards.released_at` is.
 */
function importOrder(db: FakeDb): Compare<FakeCard> {
  return (a, b) =>
    ownedOfPrinting(db, b.id) - ownedOfPrinting(db, a.id) ||
    cmp(b.releasedAt, a.releasedAt) ||
    cmp(b.id, a.id);
}

/**
 * `deck_import::MATCH_COLUMNS` as a DTO — the card half of `DECK_CARD_SELECT`, **less its
 * money**, plus the two facts only an import asks for.
 *
 * `everUncommon` is read off its column for {@link toDeckCard}'s reason, where the SQL
 * computes it with an `EXISTS` over `cards`: it is a fact the generator took from the full
 * 116 k-row corpus, and re-deriving it over 43 rows would answer a question about the fixture.
 *
 * **No price, and the absence is deliberate** — see `ImportMatch` in `src/lib/ipc.ts`. Unlike
 * {@link toDeckCard}, which pairs `unitPriceUsd` with `unitPriceEur` because the deck's views
 * price a row, an import preview draws no money at all; a lone `usd` key here was the field the
 * marketplace merge caught drifting, and it is gone rather than paired.
 */
function toImportMatch(db: FakeDb, c: FakeCard, printingCount: number): ImportMatch {
  return {
    cardId: c.id,
    // **The whole printed name**, so a DFC resolved from its front face comes back `"A // B"`.
    name: c.name,
    setCode: c.setCode,
    collectorNumber: c.collectorNumber,
    lang: c.lang,
    oracleId: c.oracleId,
    manaCost: c.manaCost,
    cmc: c.cmc,
    typeLine: c.typeLine,
    oracleText: c.oracleText,
    colors: c.colors,
    colorIdentity: c.colorIdentity,
    legalities: c.legalities,
    power: c.power,
    toughness: c.toughness,
    layout: c.layout,
    rarity: c.rarity,
    faces: c.faces,
    // A plain boolean where `DeckCard.gameChanger` is nullable: a resolved line always names a
    // card that exists, which is the state that `null` is reserved for.
    gameChanger: c.gameChanger,
    everUncommon: c.everUncommon,
    ownedQuantity: ownedOfPrinting(db, c.id),
    printingCount,
  };
}

/**
 * One SQL arm's answer: `MATCH_ORDER`'s winner, carrying `count(*) OVER ()` as its
 * `printingCount`.
 *
 * The count is **the arm's**, not the card's — `count(*) OVER ()` is computed before `LIMIT`,
 * so it counts every row the `WHERE` matched. That is why `ImportMatch.printingCount` means
 * six different things and only means "printings of this card" on a line with no hint.
 */
function bestOf(db: FakeDb, candidates: FakeCard[]): ImportMatch | null {
  if (candidates.length === 0) return null;
  const winner = [...candidates].sort(importOrder(db))[0];
  return toImportMatch(db, winner, candidates.length);
}

/**
 * `deck_import::fold_match` — fold both sides and compare, the arm the three exact ones fall
 * through to.
 *
 * The candidate set is the whole paper fixture rather than `cards_fts`' 200; simplification 11
 * says what that gives up. `printingCount` is the number that survived the fold, because the
 * reader is choosing between printings of *their* card rather than between everything that
 * happened to mention it.
 */
function foldMatch(db: FakeDb, name: string): ImportMatch | null {
  const wanted = foldName(name);
  // A single-faced name has no front half, so an empty `wanted` would rank every card 1.
  if (wanted === "") return null;
  const kept: { rank: number; card: FakeCard }[] = [];
  for (const card of db.cards) {
    if (!card.isPaper) continue;
    const rank = foldRank(card.name, wanted);
    if (rank !== null) kept.push({ rank, card });
  }
  if (kept.length === 0) return null;
  const order = importOrder(db);
  // The whole name ahead of a front face, then `MATCH_ORDER`'s three keys in its own order.
  kept.sort((a, b) => a.rank - b.rank || order(a.card, b.card));
  return toImportMatch(db, kept[0].card, kept.length);
}

/** `deck_import::given` — a hint the caller actually gave: trimmed, and absent when blank.
 *  `""` and `"   "` reach here from real exports (a trailing tab in a Moxfield paste is
 *  enough), and either bound into `set_code = ?1` turns every line into a missed hint. */
function givenHint(hint: string | null): string | null {
  const trimmed = (hint ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Every read command, bound to one store.
 *
 * The return type is **inferred**, not `Record<string, CommandHandler>`, and that is
 * load-bearing: `CommandHandler`'s parameter is `never`, so a value of that type can be
 * dispatched but never *called* with an argument. Tests call these directly
 * (`readHandlers(db).search_cards({ req })`), and the `satisfies` below is what still proves
 * every one of them is a legal handler at the point it is written.
 *
 * The handlers close over `db` rather than copying it, so Task 5's writes mutate the same
 * store these reads answer from.
 */
export function readHandlers(db: FakeDb) {
  return {
    /** `search::run_search`. */
    search_cards: (args: { req: SearchRequest }) => {
      const req = args.req;
      // Absent means `tcgplayer`, which is what this command answered before the parameter
      // existed — the one place the whole marketplace decision enters a search.
      const mp = marketplaceOf(req.marketplace);
      const limit = pageLimit(req.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
      const text = nonblank(req.text);
      const matched = db.cards.filter((c) => {
        if (text !== null && !cardMatchesText(c, text)) return false;
        if (!matchesCardFilters(c, { ...req, text: undefined }, null)) return false;
        // An **entry**, not a copy: a row emptied to zero is a row the collection keeps, and
        // this filter counts it as owned. The wishlist's `fulfilled` is the one that counts
        // copies, because a wish is filled by copies rather than by paperwork.
        if (req.owned !== undefined) {
          const has = db.collectionEntries.some((e) => e.cardId === c.id);
          if (req.owned !== has) return false;
        }
        return true;
      });
      // `SEARCH_SORTS` over the browse order, with `c.id ASC` appended. Simplification 1 is
      // the one place this parts from `run_search`, and only on the **default**: the real
      // fallback under text is `bm25(cards_fts, 10.0, 1.0, 1.0) ASC, c.name ASC`, and there
      // is no FTS index here to rank with, so a text search lands in the browse's name order.
      const sorted = [...matched].sort(
        orderBy(req.sort, searchSorts(db, mp), SEARCH_BROWSE_ORDER, (a, b) => cmp(a.id, b.id)),
      );

      // Collapsed, the rows are cards and so is the denominator: the pager divides by
      // `total` and the caption prints it, so counting printings over a list of cards would
      // be a lie in both places. Grouping *after* the sort keeps the representative-picking
      // and the ordering independent, which is what the two-step SQL does too.
      const rows: CardSummary[] = req.collapse
        ? collapseToCards(db, sorted, mp)
        : sorted.map((c) => toCardSummary(db, c, mp));
      // The count stops at the cap rather than walking the table on every keystroke.
      const counted = Math.min(rows.length, TOTAL_CAP + 1);
      return {
        items: rows.slice(req.offset, req.offset + limit),
        total: Math.min(counted, TOTAL_CAP),
        totalIsCapped: counted > TOTAL_CAP,
      };
    },

    /**
     * `index::facets::compute`.
     *
     * Derived from the same {@link matchesCardFilters} the fake's `search_cards` uses, so the
     * two cannot disagree about what a filter means — which is the whole reason this file
     * stores rows and derives DTOs rather than storing DTOs. Every count here is one option
     * run through that mirror over its dimension's base.
     *
     * **Every dimension is counted over a base carrying every filter EXCEPT its own** —
     * Solr's `excludeTags` rule. Counted over the full base, picking one set would report
     * zero for every other set and grey the whole picker at the moment it was first used.
     *
     * Colours are the exception that proves it: `colors` is **subset** semantics, so with `U`
     * on, pressing `W` asks for "castable in WU" — a superset. Their number is the size of the
     * result *after* toggling, read against `total`. Every other dimension is a plain count.
     *
     * The index has no rarity dimension, so `facets::base` drops `rarity` from every base and
     * a rarity-filtered request is faceted as though it were unfiltered — every count reads
     * high. Mirrored rather than improved on: a fake that counted better than the backend
     * would hide the divergence instead of the app showing it. Nothing sends it today; the
     * search view's filter bar has no rarity control.
     */
    facet_cards: (args: { req: SearchRequest }): FacetResponse => {
      // A cold index is an answer and never an error, and **every map is empty on it** —
      // not a map of zeros. `ready: false` says "we did not count", which is what lets the
      // UI leave every control live; zeros would say "this is empty" and grey the lot.
      //
      // **An empty corpus answers the same way**, and that is `facets::compute`'s own guard
      // (`if ix.all.count() == 0`) rather than a convenience here. A first launch publishes
      // an index over zero rows for the ~93 s its opening sync takes, and counted honestly
      // every option is zero: the greying rule dims the whole row, and with no filter on
      // there is no `Reset all` drawn to escape by. The `empty` seed is exactly that state,
      // and it is the seed `Search/Page`'s `Empty`, `Decks/SearchPanel` and
      // `Collection/Page` render — so without this line the workbench drew a dead filter row
      // the shipped window cannot produce.
      if (db.fault === "indexCold" || db.cards.length === 0) {
        return {
          colors: {},
          manaValues: {},
          formats: {},
          sets: {},
          owned: { owned: 0, missing: 0 },
          total: 0,
          ready: false,
        };
      }

      const req = args.req;
      const text = nonblank(req.text);
      /** The result set under every filter except `skip`'s. */
      const base = (skip: FacetSkip | null): FakeCard[] => {
        const f: CardFilters = { ...req, text: undefined, rarity: undefined };
        if (skip === "colors") f.colors = undefined;
        if (skip === "mana") f.manaValues = undefined;
        if (skip === "sets") {
          f.sets = undefined;
          f.setCode = undefined;
        }
        if (skip === "formats") f.format = undefined;
        return db.cards.filter((c) => {
          // Text is in every base **including its own**: it is not a facet, and a facet
          // describes the search the reader is looking at.
          if (text !== null && !cardMatchesText(c, text)) return false;
          if (!matchesCardFilters(c, f, null)) return false;
          // An entry and not a copy, exactly as `search_cards` reads it.
          if (skip !== "owned" && req.owned !== undefined) {
            const has = db.collectionEntries.some((e) => e.cardId === c.id);
            if (req.owned !== has) return false;
          }
          return true;
        });
      };

      /**
       * One option's count over its dimension's base.
       *
       * `paperOnly: false` because the base has already applied the request's own paper
       * decision — putting the default back here would drop the digital printings a
       * `paperOnly: false` search asked for.
       *
       * `playableOnly` needs no such line, and the asymmetry is its default rather than an
       * oversight: it is off unless asked for, so an option's own filter object cannot put
       * back a narrowing the base already made. The base is where the request's value lives.
       */
      const countWith = (rows: FakeCard[], f: CardFilters) =>
        rows.filter((c) => matchesCardFilters(c, { ...f, paperOnly: false }, null)).length;

      // **Every code in the corpus, zeros included.** A set the search narrowed away arrives
      // as an explicit 0, which is what lets the picker grey a row rather than drop it.
      const sets: Record<string, number> = {};
      for (const c of db.cards) sets[c.setCode] = 0;
      for (const c of base("sets")) sets[c.setCode] += 1;

      // Exact equality below 8 and a range at 8, which is `matchesCardFilters`' own reading
      // of a chip list — so a fractional cost belongs to no chip below 8, exactly as the
      // search's `cmc IN (…)` has it.
      const manaBase = base("mana");
      const manaValues: Record<string, number> = {};
      for (let v = 0; v <= MANA_VALUE_OPEN_ENDED; v++) {
        manaValues[String(v)] = countWith(manaBase, { manaValues: [v] });
      }

      const formatBase = base("formats");
      const formats: Record<string, number> = {};
      for (const key of LEGALITY_KEYS) formats[key] = countWith(formatBase, { format: key });

      const colorBase = base("colors");
      const colors: Record<string, number> = {};
      const picked = nonblank(req.colors)?.toUpperCase() ?? "";
      for (const letter of COLOR_CHIPS) {
        colors[letter] = countWith(colorBase, { colors: toggleColorString(picked, letter) });
      }

      // Never greyed — these two are for the chip's tooltip — but still counted over the
      // base with `owned` itself removed, so they describe both sides of the cycle.
      const ownedBase = base("owned");
      const owned = ownedBase.filter((c) =>
        db.collectionEntries.some((e) => e.cardId === c.id),
      ).length;

      return {
        colors,
        manaValues,
        formats,
        sets,
        owned: { owned, missing: ownedBase.length - owned },
        // **Printings, always**: `collapse` is a view mode and not a filter, so this counts
        // what the search matched rather than the rows it will draw.
        total: base(null).length,
        // A fake world has no warm-up, so past the guard above this is always ready; a
        // story that wants the cold state sets `indexCold`.
        ready: true,
      };
    },

    /**
     * `search::run_list_sets`, derived from the cards (simplification 3).
     *
     * `cardCount` counts **paper** printings only — the real query's
     * `FILTER (WHERE is_paper = 1)` — because a picker whose numbers disagree with what
     * clicking the row returns is worse than no numbers. A set's date is the newest of its
     * rows: measured over `CARDS` 2026-08-09, `sld` is the one code whose two fixture rows
     * carry different release dates (2024-04-08 and 2025-12-01).
     */
    list_sets: (): SetSummary[] => {
      const sets = new Map<string, SetSummary>();
      for (const c of db.cards) {
        const found = sets.get(c.setCode);
        const row = found ?? {
          code: c.setCode,
          name: c.setName,
          // `sets.set_type` has no column in `FakeCard`; nothing renders it today.
          setType: null,
          releasedAt: c.releasedAt,
          cardCount: 0,
        };
        if (c.isPaper) row.cardCount += 1;
        if (row.releasedAt === null || c.releasedAt > row.releasedAt) row.releasedAt = c.releasedAt;
        sets.set(c.setCode, row);
      }
      return [...sets.values()].sort(
        (a, b) => cmp(b.releasedAt ?? "", a.releasedAt ?? "") || cmp(a.name, b.name),
      );
    },

    /**
     * `card::get_card` — **not** filtered to paper, unlike the printings list: an id asked for
     * by name has to resolve, and a digital printing is reachable from a search with `paperOnly`
     * off.
     *
     * It takes a marketplace like every other priced read: the per-finish prices on the answer
     * are `price_expr(marketplace)`'s, not a blob for the frontend to look a key up in. Absent
     * is `tcgplayer`, which is what this command answered before the parameter existed.
     */
    card_detail: (args: { id: string; marketplace?: string }): CardDetail | null => {
      const card = cardById(db, args.id);
      return card ? toCardDetail(db, card, marketplaceOf(args.marketplace)) : null;
    },

    /** `card::list_printings`: every **paper** printing of one oracle card, newest first,
     *  capped with an uncapped count so a truncated list can say what it truncates. Every row
     *  is priced per finish at the marketplace asked for, like the card above. */
    card_printings: (args: { oracleId: string; marketplace?: string }) => {
      const mp = marketplaceOf(args.marketplace);
      if (args.oracleId.trim() === "") return { items: [], total: 0 };
      const all = db.cards
        .filter((c) => c.oracleId === args.oracleId && c.isPaper)
        .sort(
          (a, b) =>
            cmp(b.releasedAt, a.releasedAt) ||
            cmp(a.setCode, b.setCode) ||
            cmp(a.collectorNumber, b.collectorNumber) ||
            cmp(a.id, b.id),
        );
      return {
        items: all.slice(0, MAX_PRINTINGS).map((c) => toPrinting(db, c, mp)),
        total: all.length,
      };
    },

    /** `collection::list_entries`. */
    collection_list: (args: { query: CollectionQuery }) => {
      const q = args.query;
      const mp = marketplaceOf(q.marketplace);
      const rows = collectionScope(db, q);
      const limit = pageLimit(q.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const sorted = [...rows].sort(collectionOrder(db, rows, q.sort, mp));
      return {
        items: sorted
          .slice(q.offset, q.offset + limit)
          .map((e) => toCollectionRow(db, e, cardById(db, e.cardId), mp)),
        // Counted in full: a collection is thousands of rows, not the 116 k the search caps.
        total: rows.length,
      };
    },

    /**
     * `collection::summarise`, over the *same* rows the list is showing.
     *
     * **Annotated rather than inferred, like every handler with a `to*` builder behind it.**
     * This DTO has no builder — nothing else in the fake constructs a `CollectionSummary` —
     * so the return type is the only thing binding these ten fields to `ipc.ts`. Without it a
     * renamed or dropped field on the Rust side would reach `ipc.ts`, fail nothing here, and
     * leave the fake answering a shape the app no longer reads. Catching that drift is the
     * whole reason the stories go through `ipc.ts` instead of past it.
     */
    collection_summary: (args: { query: CollectionQuery }): CollectionSummary => {
      const mp = marketplaceOf(args.query.marketplace);
      const rows = collectionScope(db, args.query);
      const priced = rows.map((e) => ({
        e,
        unit: finishPriceAt(db, cardById(db, e.cardId), e.finish, mp),
      }));
      const sum = (f: (r: (typeof priced)[number]) => number) =>
        priced.reduce((n, r) => n + f(r), 0);
      return {
        // Copies, not rows — a row emptied to zero contributes 0.
        totalCards: sum((r) => r.e.quantity),
        // Printings **recorded**, not printings currently held: a zero row still counts.
        uniqueCards: new Set(rows.map((e) => e.cardId)).size,
        entries: rows.length,
        tradelistCards: sum((r) => r.e.tradelistQuantity),
        value: sum((r) => r.e.quantity * (r.unit ?? 0)),
        // Copies with no price for their finish **at this marketplace**: a total that silently
        // omits 400 cards is a number that lies by rounding down, and the count travels with
        // its own figure because no two marketplaces have the same holes.
        unpriced: sum((r) => (r.unit === null ? r.e.quantity : 0)),
        needsReview: rows.filter((e) => e.needsReview !== null).length,
      };
    },

    /** `wishlist::list_wishes`. */
    wishlist_list: (args: { query: WishlistQuery }) => {
      const q = args.query;
      const mp = marketplaceOf(q.marketplace);
      const rows = wishlistScope(db, q);
      const limit = pageLimit(q.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const sorted = [...rows].sort(wishlistOrder(db, rows, q.sort, mp));
      return {
        items: sorted.slice(q.offset, q.offset + limit).map((w) => toWishRow(db, w, mp)),
        total: rows.length,
      };
    },

    /** `deck::list_decks`: archived last, most recently touched first. */
    deck_list: (): DeckRow[] =>
      [...db.decks]
        .sort(
          (a, b) =>
            Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt || b.id - a.id,
        )
        .map((d) => toDeckRow(db, d)),

    /**
     * `deck::get_deck` — the deck and everything in it, in one answer.
     *
     * One command rather than five, because the editor and the validation engine ask the
     * same question and a screen whose curve, legality panel, owned badges and column
     * headings come from four queries is a screen whose four answers can disagree.
     *
     * **`variant` scopes the cards and nothing else.** Every category and every tag comes
     * back whole — an empty category still draws a column, because that is where the next
     * card goes, and an inactive one always draws, because that is the affordance for
     * switching it back on. Only their two numbers follow the variant that was asked for.
     */
    deck_get: (args: { id: number; variant: DeckVariant; marketplace?: string }) => {
      const variant = validVariant(args.variant);
      // Prices every card and every category heading in the answer, which is why it is part
      // of the caller's query key rather than of its presentation.
      const mp = marketplaceOf(args.marketplace);
      if (db.fault === "gone") return null;
      const deck = db.decks.find((d) => d.id === args.id);
      if (!deck) return null;
      const rows = db.deckCards
        .filter((dc) => dc.deckId === deck.id && dc.variant === variant)
        .sort(deckReadOrder(db));
      // The allocator reads `live` and nothing else, so a theory read has no claim to hand
      // out — see simplification 2 in this file's header for the one case where the app can
      // answer otherwise.
      const owned =
        variant === LIVE
          ? attributeOwned(db, rows, allocate(db, deck.id))
          : new Map<number, number>();
      const cards = rows
        // The join on `deck_categories` is inner, so a row whose category is gone is not a
        // row: `flatMap` is what drops one, and nothing in this fake can produce it.
        .flatMap((dc) => {
          const category = categoryById(db, dc.categoryId);
          return category ? [toDeckCard(db, dc, category, owned.get(dc.id) ?? 0, mp)] : [];
        });
      const categories: DeckCategory[] = db.deckCategories
        .filter((c) => c.deckId === deck.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((c) => toDeckCategory(db, c, variant, mp));
      const tags: DeckTag[] = db.deckTags
        .filter((t) => t.deckId === deck.id)
        .sort((a, b) => cmp(a.name, b.name) || a.id - b.id)
        .map((t) => toDeckTag(db, t, variant));
      return { deck: toDeckRow(db, deck), cards, categories, tags };
    },

    /**
     * `deck_meta::list_categories` — a deck's categories on their own, for a panel that wants
     * them without the cards.
     *
     * `variant` scopes each row's two numbers and **nothing else**: which categories a deck has
     * does not depend on which list is showing, which is what keeps the columns still while the
     * reader switches between Live and Theory.
     */
    deck_category_list: (args: {
      deckId: number;
      variant: DeckVariant;
      marketplace?: string;
    }): DeckCategory[] => {
      const variant = validVariant(args.variant);
      const mp = marketplaceOf(args.marketplace);
      refuseIfMetaUnreadable(db, CATEGORIES_UNREADABLE);
      return db.deckCategories
        .filter((c) => c.deckId === args.deckId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((c) => toDeckCategory(db, c, variant, mp));
    },

    /** `deck_meta::list_tags` — `ORDER BY t.name`, and the count scoped to the same variant a
     *  category's is. The two agree deliberately: they describe one list of cards. */
    deck_tag_list: (args: { deckId: number; variant: DeckVariant }): DeckTag[] => {
      const variant = validVariant(args.variant);
      refuseIfMetaUnreadable(db, TAGS_UNREADABLE);
      return db.deckTags
        .filter((t) => t.deckId === args.deckId)
        .sort((a, b) => cmp(a.name, b.name) || a.id - b.id)
        .map((t) => toDeckTag(db, t, variant));
    },

    /**
     * `deck_meta::tag_suggestions` — every tag name and colour ever used, **across every deck**,
     * most-used first.
     *
     * The one command in the deck surface that takes no id at all: a tag is per-deck data, but
     * the palette a "New tag" dialog completes from is a property of the app's whole history
     * rather than of the deck that happens to be open.
     *
     * Grouped on the **pair** and not on the name, `GROUP BY name, color`: nothing in the schema
     * forces two decks to pick the same colour for one word, so a name used in two colours is
     * honestly two rows. Ties break on the name, which is the SQL's own second term.
     */
    deck_tag_suggestions: (): TagSuggestion[] => {
      refuseIfMetaUnreadable(db, TAG_PALETTE_UNREADABLE);
      const groups = new Map<string, { name: string; color: string; uses: number }>();
      for (const t of db.deckTags) {
        const key = `${t.name} ${t.color}`;
        const found = groups.get(key);
        if (found) found.uses += 1;
        else groups.set(key, { name: t.name, color: t.color, uses: 1 });
      }
      return [...groups.values()]
        .sort((a, b) => b.uses - a.uses || cmp(a.name, b.name))
        .map(({ name, color }) => ({ name, color }));
    },

    /** `deck_meta::list_folders` — every folder there is, flat, `ORDER BY sort_order, id`. No
     *  deck scoping: a folder belongs to no deck, it files them. The tree is the reader's to
     *  build from `parentId`. */
    deck_folder_list: (): DeckFolder[] => {
      refuseIfMetaUnreadable(db, FOLDERS_UNREADABLE);
      return [...db.deckFolders]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map(toDeckFolder);
    },

    /**
     * `deck_audit::list` — one deck's history, newest first.
     *
     * `at DESC, id DESC`, because `unixepoch()` has one-second resolution and a single click can
     * write two rows inside one second — so the id is what orders them, and a fake whose
     * {@link stamp} is derived rather than wall-clock makes that the common case rather than a
     * rarity.
     *
     * `limit` is **clamped into `1..=500`** rather than obeyed: the clamp is what stops a `0` or
     * a negative from meaning *no limit at all*, which is exactly how SQLite reads a negative
     * `LIMIT`. A deck that is not there answers an **empty list**, not an error — the history of
     * a deck that does not exist is nothing, and the rows cascade with it.
     */
    deck_audit_list: (args: { deckId: number; limit: number }): DeckAuditEntry[] => {
      refuseIfMetaUnreadable(db, HISTORY_UNREADABLE);
      const limit = Math.min(Math.max(args.limit, 1), AUDIT_MAX_LIMIT);
      return [...db.deckAudit]
        .filter((a) => a.deckId === args.deckId)
        .sort((a, b) => b.at - a.at || b.id - a.id)
        .slice(0, limit)
        .map(toDeckAudit);
    },

    /** `deck_theory::theory_diff` — what the plan wants and the deck does not have. See
     *  {@link theoryDiff} for the direction, the grouping and the two exclusions. */
    deck_theory_diff: (args: { deckId: number; marketplace?: string }): TheoryDiffRow[] => {
      refuseIfMetaUnreadable(db, THEORY_UNREADABLE);
      return theoryDiff(db, args.deckId, marketplaceOf(args.marketplace)).map((g) => g.row);
    },

    /**
     * `deck_import::resolve_lines` — every name in a parsed decklist, resolved to a printing
     * this app has. **Read-only**, and one call for the whole list.
     *
     * Six arms, tried in the order the reader's own intent runs out — **narrowest first, and
     * the exact name always ahead of a front face**:
     *
     * 1. **A set and a collector number** name one printing and are taken at their word; no
     *    name is consulted at all, so a list whose names are in another language still lands.
     * 2. **The set, with the name** — a hint whose *number* named nothing usually still has the
     *    right set, and discarding it there throws away the reader's best information at the
     *    moment it is most likely to be right.
     * 3. **The set, with the name as a front face.**
     * 4. **The name**, exactly. A separate arm from 5 as a *correctness* fix rather than a
     *    performance one: one `OR`-ed arm lets the ordering choose between a real card and an
     *    art series' `"N // N"` row, and 51 names in the live corpus have one that wins.
     * 5. **The name as a front face** of an `"A // B"` printing — the commonest way a decklist
     *    writes a double-faced card down.
     * 6. **The folded name** ({@link foldMatch}), which is where case and diacritics survive.
     *
     * A name no printing bears is `matched: null` and **never a rejection**: 99 good lines must
     * not be lost to one bad one, so the preview quotes the miss and the import proceeds.
     * `hintMissed` means *some part of what the reader wrote about the printing was not used* —
     * so a collector number that named nothing sets it even when the set and name then answer,
     * and a collector number with no set beside it sets it without being tried at all (a
     * collector number is not unique across sets, so it can only ever narrow one).
     *
     * The set code is lower-cased and compared binary, as `resolve_lines` binds it: 0 of the
     * corpus's 116 695 rows carry a set code in any other case, while a parser that
     * upper-cases `(MH2)` is the ordinary source of one. The collector number keeps its
     * case-insensitivity, which is the one place `COLLATE NOCASE` survives.
     */
    deck_import_resolve: (args: { lines: ImportResolveLine[] }): ImportResolveRow[] => {
      // `is_paper = 1` is on every arm, so it is applied once here.
      const paper = db.cards.filter((c) => c.isPaper);
      // `c.name >= "{name} // " AND c.name < "{name} //!"`, which over a byte-wise comparison
      // is exactly "carries that prefix" — see `deck_import::front_face_range` for the proof.
      const fronts = (name: string) => paper.filter((c) => c.name.startsWith(`${name} // `));

      return args.lines.map((line, index) => {
        // An empty name is no name at all: the front-face range of `""` is a real range over
        // real names, so a blank line reaching the name arms would resolve to an arbitrary
        // printing rather than to nothing. A printing hint needs no name and is still honoured.
        const name = line.name.trim();
        let matched: ImportMatch | null = null;
        let hintMissed = false;

        const set = givenHint(line.setCode)?.toLowerCase() ?? null;
        const number = givenHint(line.collectorNumber);
        if (set !== null) {
          const inSet = paper.filter((c) => c.setCode === set);
          if (number !== null) {
            matched = bestOf(
              db,
              inSet.filter((c) => c.collectorNumber.toLowerCase() === number.toLowerCase()),
            );
          }
          // Set before the fallbacks below, so a number that named nothing stays reported even
          // when the set and name go on to answer.
          hintMissed = matched === null;
          if (matched === null && name !== "") {
            matched =
              bestOf(db, inSet.filter((c) => c.name === name)) ??
              bestOf(db, inSet.filter((c) => c.name.startsWith(`${name} // `)));
            if (number === null) hintMissed = matched === null;
          }
        } else if (number !== null) {
          hintMissed = true;
        }

        if (matched === null && name !== "") {
          matched =
            bestOf(db, paper.filter((c) => c.name === name)) ??
            bestOf(db, fronts(name)) ??
            foldMatch(db, name);
        }
        // The caller's index rides along rather than being inferred: the list that was sent is
        // the only thing that knows what line 34 said.
        return { index, matched, hintMissed };
      });
    },

    /**
     * `deck_import::read_import_file`, which **throws here and always will**.
     *
     * The real command takes a path `@tauri-apps/plugin-dialog`'s `open()` answered — a native
     * window CDP cannot drive and a browser does not have. So there is no gesture in a story
     * that reaches this, and a handler that invented a decklist would be a story about a thing
     * that cannot happen: the file arm's refusal would be the only branch anyone ever saw, and
     * it would be the wrong one. A story that wants a list pastes one, which is the same string
     * travelling the same path from one line later.
     */
    deck_import_read_file: (): string => {
      throw refuse(NO_FILE_PICKER);
    },

    /**
     * `deck::list_format_specs`, served from the validation fixtures.
     *
     * **`SPECS` and no second copy**: `validation/fixtures.ts` is already a hand-copied mirror of
     * `schema.rs`'s `FORMAT_SPECS_SEED`, and a second mirror is a second place for a cell to
     * drift. It carries **12** of the 25 seeded rows (measured 2026-08-09) — the formats the
     * engine tests need — so a picker in a story offers 12 formats and not 24.
     */
    format_specs_list: () => Object.values(SPECS).sort((a, b) => a.sortOrder - b.sortOrder),

    /** `sync::status`. Annotated for {@link collection_summary}'s reason — the other DTO in
     *  this file with no `to*` builder to bind it to `ipc.ts`. */
    sync_status: (): SyncStatus => ({
      cardCount: db.cards.length,
      lastCheckAt: SYNC_LAST_CHECK_AT,
      bulkUpdatedAt: SYNC_BULK_UPDATED_AT,
      lastError: db.fault === "syncError" ? SYNC_ERROR : null,
      lastIngestSkipped: 0,
      dataDir: SYNC_DATA_DIR,
      syncing: false,
      imageStoreFailures: db.fault === "imageFailures" ? IMAGE_STORE_FAILURES : 0,
    }),

    /**
     * `update::status`, and the one update command that is a **read** — it touches `app_meta`
     * and the process's own state and makes no network call, which is why the ribbon can poll
     * it. Annotated for {@link sync_status}' reason.
     */
    update_status: (): UpdateStatus => toUpdateStatus(db),

    /**
     * `marketplace::get_marketplace` — the stored id, or the default.
     *
     * **Two ways to get the default and both are here**, because they are the two the command
     * exists to absorb: the row has never been written, or it holds a value this build does not
     * recognise. A newer build's id landing in an older one is a downgrade rather than a
     * corruption, and failing every price surface over it would be the worse answer — so the
     * fallback is a `String` this side narrows, not an error.
     *
     * `isMarketplaceId` is imported rather than re-listed: the ids are a *list*, and the Rust
     * validates against the same one. The rule around it — fall back on a read, refuse on a
     * write — is re-implemented here, which is the half a mirror is for.
     */
    get_marketplace: (): string =>
      db.marketplace !== null && isMarketplaceId(db.marketplace)
        ? db.marketplace
        : DEFAULT_MARKETPLACE,

    /**
     * `card::printing_group_by` — the stored grouping, or the default.
     *
     * The second `app_meta` setting and the same shape as the one above it, deliberately: both
     * ways to the default are here, because they are the two the command exists to absorb — the
     * row has never been written, or it holds a mode this build does not recognise.
     *
     * What is different is what the fallback protects. A marketplace falling back costs a
     * reader the prices they wanted; this one costs them a grouping, on **the surface they
     * opened to look at a card**. A stale row must never be the reason a printings list refuses
     * to draw, which is why the read narrows and shrugs where the write refuses in words.
     *
     * A read, so it answers through a sync like every other one here — the write below does not.
     */
    printing_group_by: (): string =>
      db.printingGroupBy !== null && isPrintingGroupBy(db.printingGroupBy)
        ? db.printingGroupBy
        : DEFAULT_PRINTING_GROUP_BY,

    /**
     * `marketplace_feed::status` — one row per **feed-backed** marketplace, whether or not it
     * has ever been fetched.
     *
     * A row for a feed with no `marketplace_feed_meta` entry too, with `fetchedAt: null` and a
     * `rowCount` counted straight off `marketplace_prices` — because "never fetched" is the
     * state a first selection acts on, and a command that simply omitted the row would leave a
     * panel unable to tell it from "not read yet".
     *
     * A read: no network, two small tables, cheap enough to poll while a refresh is running.
     */
    marketplace_feed_status: (): MarketplaceFeedStatus[] =>
      FEED_MARKETPLACES.map((m) => {
        const meta = db.marketplaceFeeds.find((f) => f.marketplace === m.id);
        return {
          marketplace: m.id,
          fetchedAt: meta?.fetchedAt ?? null,
          feedBuiltAt: meta?.feedBuiltAt ?? null,
          // `null` and not `0` for a feed never fetched: "nothing downloaded" and "a fetch that
          // landed nothing" are two states, and only the first is one a first selection acts on.
          rowCount: meta ? db.marketplacePrices.filter((p) => p.marketplace === m.id).length : null,
          // **The backend's own answer, and never fetched is stale by definition** — that is
          // what makes the start-up pass fetch a feed that has never been pulled. A stamp in
          // the future (a clock that moved) counts as stale rather than underflowing.
          stale: meta === undefined || isFeedStale(meta.fetchedAt, CLOCK_BASE),
          // The fake's refreshes are synchronous, so nothing is ever in flight *between* two
          // commands here. A story that wants the state emits `marketplace:progress`.
          refreshing: false,
        };
      }),

    /**
     * `error_log_list` — newest first, clamped exactly as the Rust does.
     *
     * The clamp's low end is the part worth mirroring: SQLite reads a negative `LIMIT` as no
     * limit at all, so `Math.max(1, …)` is what stops a stray `-1` behaving differently here
     * from in the app.
     */
    error_log_list: (args: { limit: number }): ErrorEntry[] =>
      [...db.errorLog]
        .sort((a, b) => b.lastAt - a.lastAt || b.id - a.id)
        .slice(0, Math.min(Math.max(1, args.limit), 200)),

    /**
     * Fire-and-forget in the app, and a no-op here.
     *
     * `images::prefetch_images` resolves as soon as the work is *queued*, and an image that
     * fails to prefetch simply fetches when it is rendered — so nothing observable depends on
     * it, and the fake image handler serves whatever a story asks for regardless. The
     * arguments (`cardIds`, `variant`) are accepted and ignored; a parameter declared and
     * unused would fail `noUnusedParameters`.
     */
    prefetch_images: () => undefined,

    /** The same, answering how many images were **queued** — zero, since nothing was. */
    prewarm_collection: () => 0,
  } satisfies Record<string, CommandHandler>;
}

/* ------------------------------------------------------------------ the writes ------- */

/**
 * `collection::BUSY`, verbatim.
 *
 * Every write here opens by reading `db.fault` for it, and no read does: writes take
 * `AppState.db` through `db::lock_for` and can be refused, reads go through `db_read` and
 * answer through every second of a sync. `sync_run` is the one command in
 * {@link writeHandlers} that does *not* check it — it does not take that lock, it is the
 * thing that holds it.
 */
const BUSY = "The card database is busy finishing a sync. Try that again in a moment.";
/** `collection::GONE` — what an *adjustment* says when the row it names is not there. */
const ENTRY_GONE = "That collection entry is not there any more.";
/** `wishlist::set_wish_quantity`'s twin of the above. */
const WISH_GONE = "That wishlist entry is not there any more.";
/** `deck::GONE`. */
const DECK_GONE = "That deck is not there any more.";
/** `collection::ZERO_ADD` — one sentence for two tables, because it is one rule. */
const ZERO_ADD = "Adding a card needs a quantity of at least one.";
/** `deck::SAME_PRINTING`. */
const SAME_PRINTING = "That is already this printing.";
/** `deck::PRINTING_GONE`. Deliberately not `printing_of`'s sentence: the printing was
 *  clicked out of a live list a moment ago, so the news is the sync, not the id. */
const PRINTING_GONE =
  "That printing is not in the card database any more — a sync replaced it while the card " +
  "was open. Reopen the card for the printings it has now.";
/** `collection::friendly` — the one database error that is a user's problem rather than a
 *  bug, in the app's voice rather than the index's name. */
const GRAIN_TAKEN =
  "You already have an entry for that printing at that finish and condition — change its " +
  "quantity instead, or give this one a different condition.";
/** `deck::NO_CATEGORY`. The id and the name are alternatives — an id is a drop onto a column
 *  the user pointed at, a name is the add path's "file it where this card belongs" — but a
 *  card has to land *somewhere*, and `deck_cards.category_id` is NOT NULL. */
const NO_CATEGORY = "A card needs a category to go in.";
/** `deck_meta::CATEGORY_GONE` and `CATEGORY_WRONG_DECK`. Two sentences rather than one,
 *  because "gone" and "not yours" are different things to tell a stale editor — and nothing
 *  in the DDL stops a `category_id` naming another deck's category, so the second is a real
 *  fence rather than a formality. */
const CATEGORY_GONE = "That category is not there any more.";
const CATEGORY_WRONG_DECK = "That category belongs to a different deck.";
/** `deck_meta::CATEGORY_NAME_TAKEN` — `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, and this is
 *  the sentence a caller that skipped the check would get as a raw UNIQUE failure instead. */
const CATEGORY_NAME_TAKEN = "This deck already has a category with that name.";
/** `deck_meta::CATEGORY_SELF_MOVE`. Refused in words rather than left to be a quiet no-op that
 *  happens to end with an empty category: the fold would select the very rows it is about to
 *  re-insert, and the delete that follows would then take them away again. */
const CATEGORY_SELF_MOVE = "A category cannot be moved into itself.";
/**
 * `deck_meta::predefined_refusal`, built from the category's **own current name** rather than
 * from a fixed string — because a rename refusing to change that name is exactly what
 * guarantees the four still read `Commander`, `Sideboard`, `Companion` and `Maybeboard`.
 *
 * It guards renaming and deleting and **nothing else**: `is_active` carries no kind check at
 * all, so every one of the four can be switched off.
 */
const predefinedRefusal = (name: string) =>
  `${name} is required by this deck's rules — it can be emptied but not removed.`;
/** `deck_meta::TAG_GONE`, `TAG_NAME_TAKEN` and `TAG_WRONG_DECK` — {@link CATEGORY_GONE}'s
 *  three twins, one table over. */
const TAG_GONE = "That tag is not there any more.";
const TAG_NAME_TAKEN = "This deck already has a tag with that name.";
const TAG_WRONG_DECK = "That tag belongs to a different deck.";
/** `deck_meta::CARD_NOT_IN_CATEGORY` — `deck::card_gone` generalised, for the stale editor
 *  pointing at a row that has since moved, folded or been stepped to zero. */
const CARD_NOT_IN_CATEGORY = "That card is not in this deck's category any more.";
/** `deck_meta::FOLDER_GONE` and `FOLDER_CYCLE`. The second is not cosmetic:
 *  `deck_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so a cycle is a graph
 *  SQLite's recursive cascade would walk forever the day one of them is deleted. */
const FOLDER_GONE = "That folder is not there any more.";
const FOLDER_CYCLE = "A folder cannot be moved inside itself.";
/** `deck_meta`'s read failures, which the {@link Fault} `deckMeta` produces. Four sentences
 *  because the module writes four, and a panel prints whichever one it got. */
const CATEGORIES_UNREADABLE = "the deck's categories could not be read: database is locked";
const TAGS_UNREADABLE = "the deck's tags could not be read: database is locked";
const TAG_PALETTE_UNREADABLE = "the tag palette could not be read: database is locked";
const FOLDERS_UNREADABLE = "the deck folders could not be read: database is locked";
/** `deck_audit`'s, which the same fault produces: the history is a satellite read like the
 *  three above it, and a drawer over an editor is exactly the surface that can be open while
 *  one fails. */
const HISTORY_UNREADABLE = "the deck's history could not be read: database is locked";
/** `deck_theory`'s, for the same reason: the plan's shopping list is a fifth satellite read,
 *  made from a dialog that is already open over a deck the screen read fine. */
const THEORY_UNREADABLE = "the theory list could not be read: database is locked";
/** `deck::DEFAULT_FORMAT` — `decks.format_key`'s own DDL default, so a blank key means here
 *  exactly what it means in SQL. */
const DEFAULT_FORMAT = "casual";
/** `deck::COVER_CUSTOM`/`COVER_CARD_ART` — `decks.cover_kind`'s two values, the second being
 *  the column's DDL default. */
const COVER_CARD_ART: DeckCoverKind = "card_art";
const COVER_CUSTOM: DeckCoverKind = "custom";
/** `collection::Grading`'s three fields, in **declaration order**: the canonical text is
 *  serialised in this order and `grading` enters the grain as raw text. */
const GRADING_FIELDS = ["company", "grade", "cert"];

/**
 * A write's `updated_at`, which SQLite writes as `unixepoch()`.
 *
 * One second after the newest row in the store rather than the wall clock, and the choice is
 * forced: the gallery sorts by `decks.updated_at DESC`, so a write has to raise it or the
 * edit does not surface — while `Date.now()` in a fixture whose seeds are fixed at
 * {@link CLOCK_BASE} would sometimes land *below* them and sort a just-edited deck to the
 * bottom. Derived from the store it is monotonic by construction and deterministic: the same
 * seed and the same clicks give the same numbers every run. `deck_cards` is not scanned
 * because {@link FakeDeckCard} has no `updated_at` — nothing reads one.
 */
function stamp(db: FakeDb): number {
  let newest = CLOCK_BASE;
  for (const e of db.collectionEntries) newest = Math.max(newest, e.updatedAt);
  for (const w of db.wishlistEntries) newest = Math.max(newest, w.updatedAt);
  for (const d of db.decks) newest = Math.max(newest, d.updatedAt);
  return newest + 1;
}

/** `INTEGER PRIMARY KEY`'s default rowid: one past the largest, and 1 for an empty table. */
function nextId(rows: { id: number }[]): number {
  return rows.reduce((n, r) => Math.max(n, r.id), 0) + 1;
}

/**
 * `deck_audit::DECK_LEVEL` — `DECK_VARIANTS[0]`, spelled out.
 *
 * The filler a row carries when the change it records is about no list at all: a category
 * write, a folder filing, a label being created or deleted. It is `live` because that is the
 * column's DDL default and the CHECK allows nothing else, **not** because those changes are
 * about the live list. This is the whole reason `DeckAuditEntry.variant` says not to filter a
 * history by variant.
 */
const DECK_LEVEL = LIVE;

/**
 * `deck_audit::record` — one history row, appended.
 *
 * Called from inside the handlers that change something and from nowhere else, which is the
 * property worth having: a history the seeds alone wrote would be a fixture, while one the
 * writes wrote is the thing the app has. In Rust this runs **inside the caller's transaction**,
 * so a row that committed while its change rolled back is impossible; here the equivalent is
 * that every caller records at the point its Rust twin commits, after the last refusal it
 * could still hit.
 *
 * **`at` is the one timestamp in this fake that is a real clock**, and the exception is forced.
 * Every other one rides {@link stamp} because it is an *ordering* number that nothing renders
 * (simplification 8). This one is rendered as a **date**: `auditText`'s day grouping turns it
 * into "Today", "Yesterday" or a heading, so a row written during a story at
 * {@link CLOCK_BASE}+1 would file that story's own edit under a fixed day in the past — below
 * the seeded history rather than above it. `unixepoch()` is a wall clock, and here so is this.
 */
function record(
  db: FakeDb,
  deckId: number,
  variant: DeckVariant,
  kind: DeckAuditKind,
  card: { id: string; name: string } | null,
  payload: Record<string, unknown>,
  delta: number,
): void {
  db.deckAudit.push({
    id: nextId(db.deckAudit),
    deckId,
    at: Math.floor(Date.now() / 1000),
    variant,
    kind,
    cardId: card?.id ?? null,
    cardName: card?.name ?? null,
    // Stringified here rather than at the reader, because `payload` is TEXT with a
    // `json_valid` CHECK and `auditText.ts` is the one module in the app that parses it. A
    // fake that handed back an object would let a renderer skip the parse and drift.
    payload: JSON.stringify(payload),
    delta,
  });
}

/** A `category`-kind row: about no card, moving no copies, and the payload's `action` is the
 *  whole of what differs between the six writes that emit one. */
function recordCategory(db: FakeDb, deckId: number, payload: Record<string, unknown>): void {
  record(db, deckId, DECK_LEVEL, "category", null, payload, 0);
}

/** A `tag`-kind row **about the label itself** — created, renamed or deleted. The card-side
 *  half of the same kind carries a `cardId` and no `action`; `auditText.ts` switches on
 *  `action` first for exactly that reason. */
function recordTag(db: FakeDb, deckId: number, payload: Record<string, unknown>): void {
  record(db, deckId, DECK_LEVEL, "tag", null, payload, 0);
}

/**
 * `deck::record_filed` — a `folder`-kind row for a deck that moved.
 *
 * **Filing a deck is a `folder` row and not a `deck` one**, which is the one asymmetry in the
 * audit worth naming: `deck_folders` is the only thing a deck can point at that has a name of
 * its own, and a bare folder id in a `deck` row's `to` would be a number no reader could
 * resolve once the folder was renamed. So the *path* is resolved here, at the moment it is
 * true, and `null` is the root.
 */
function recordFiled(db: FakeDb, deckId: number, folderId: number | null): void {
  record(db, deckId, DECK_LEVEL, "folder", null, { action: "move", folder: folderPath(db, folderId) }, 0);
}

/** `deck::folder_path` — `Ideas › Modern`, root-first. Depth-capped for the reason the Rust's
 *  is: a cycle is refused at the write, and a walk that trusts that is a walk that hangs on a
 *  fixture written by hand. */
function folderPath(db: FakeDb, folderId: number | null): string | null {
  if (folderId === null) return null;
  const MAX_DEPTH = 64;
  const names: string[] = [];
  let cursor: number | null = folderId;
  while (cursor !== null && names.length < MAX_DEPTH) {
    const folder: FakeDeckFolder | undefined = folderById(db, cursor);
    if (!folder) break;
    names.push(folder.name);
    cursor = folder.parentId;
  }
  return names.reverse().join(" › ");
}

/** A refusal in the app's voice. A Rust command's error is a bare string; `core.ts`'s
 *  `invoke` documents why a handler models one by throwing an `Error` around it. */
function refuse(message: string): Error {
  return new Error(message);
}

function refuseIfBusy(db: FakeDb): void {
  if (db.fault === "busy") throw refuse(BUSY);
}

/** `collection::valid_quantity`. **Zero is allowed here** — what zero *means* is each
 *  table's own answer, and all three refuse below it in these words. */
function validQuantity(n: number, what: string): number {
  if (n >= 0) return n;
  throw refuse(`${n} is not a quantity. A ${what} cannot be less than zero.`);
}

function validFinish(finish: string): FakeEntry["finish"] {
  const found = FINISHES.find((f) => f === finish);
  if (found) return found;
  throw refuse(`\`${finish}\` is not a finish. Use one of: ${FINISHES.join(", ")}.`);
}

/** `collection::valid_condition` — an absent condition is `NM`, what an unmarked card is
 *  assumed to be, rather than an error. */
function validCondition(condition: string | undefined): FakeEntry["condition"] {
  const c = condition ?? "NM";
  const found = CONDITIONS.find((x) => x === c);
  if (found) return found;
  throw refuse(`\`${c}\` is not a condition. Use one of: ${CONDITIONS.join(", ")}.`);
}

/** `deck_meta::valid_variant` — the variant enum refused in words rather than as a CHECK
 *  failure, the same discipline {@link validFinish} applies to the finish. */
function validVariant(variant: string): DeckVariant {
  const found = VARIANTS.find((v) => v === variant);
  if (found) return found;
  throw refuse(`\`${variant}\` is not a deck variant. Use one of: ${VARIANTS.join(", ")}.`);
}

function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed !== "") return trimmed;
  throw refuse("A deck needs a name.");
}

/** `deck_meta::valid_name` — {@link validName}'s discipline for the three more tables a blank
 *  string would end up on a tile nobody can read. `what` is what the refusal names. */
function validMetaName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed !== "") return trimmed;
  throw refuse(`${what} needs a name.`);
}

/** `deck_meta::valid_color` — non-empty, and **nothing more**. `deck_tags.color` carries no
 *  CHECK: it names a token from the app's fixed palette, and picking from that palette is the
 *  webview's job (`features/decks/tagColors.ts`), not the backend's. */
function validColor(color: string): string {
  const trimmed = color.trim();
  if (trimmed !== "") return trimmed;
  throw refuse("A tag needs a colour.");
}

/** The `deckMeta` fault, which every `deck_meta` **read** honours and no other read does. Each
 *  call site passes its own module's sentence, because a panel prints whichever it got. */
function refuseIfMetaUnreadable(db: FakeDb, message: string): void {
  if (db.fault === "deckMeta") throw refuse(message);
}

/**
 * `deck::valid_format`, over {@link SPECS} rather than the `format_specs` table.
 *
 * **A narrower table, so a narrower answer**: `validation/fixtures.ts` carries 12 of the 25 seeded rows
 * (the read's `format_specs_list` says so), and this refuses the other 13 — `premodern` is a
 * format the app knows and a story cannot make a deck in. Blank is the DDL's own default and
 * is not checked against the table at all, exactly as the Rust returns early for it.
 */
function validFormat(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") return DEFAULT_FORMAT;
  if (SPECS[trimmed]) return trimmed;
  throw refuse(`\`${trimmed}\` is not a format this app knows. Pick one from the format list.`);
}

/**
 * `collection::canonical_grading`: the column's text, or nothing at all.
 *
 * `grading` is compared **byte for byte** by {@link collectionGrain}, so
 * `{"company":"PSA","grade":10}` and `{"grade":10,"company":"PSA"}` would be two rows for one
 * slab — the same physical card forking on every edit, with no constraint anywhere to catch
 * it. Parsing and re-serialising in {@link GRADING_FIELDS} order is what makes that
 * impossible rather than merely discouraged. Blank is `null` rather than an error (an empty
 * field on a form means "no slab"), an unknown key is refused rather than dropped, and a
 * grade arrives as both `10` and `"9"` in real data, so scalars are normalised to text.
 *
 * The refusal names the shape it wants. Its parenthetical `why` is this parser's wording and
 * not serde's — the only part of the sentence that could not be copied.
 */
function canonicalGrading(grading: string | undefined): string | null {
  const text = (grading ?? "").trim();
  if (text === "") return null;
  const no = (why: string) =>
    refuse(
      `\`${text}\` is not a grading (${why}). It needs a company and a grade, and may have a ` +
        `cert — like {"company":"PSA","grade":"10","cert":"12345678"}.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw no(e instanceof Error ? e.message : "it is not JSON");
  }
  // An array is refused outright, for the reason the Rust goes through a `Value` first: a
  // struct also reads itself from a *sequence*, so `["PSA", 10]` would otherwise be a second
  // spelling of one slab. Spec §6 fixes the shape at an object.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw no("it is not a JSON object");
  }
  const slab = value as Record<string, unknown>;
  for (const key of Object.keys(slab)) {
    if (!GRADING_FIELDS.includes(key)) throw no(`unknown field \`${key}\``);
  }
  const scalar = (key: string): string | null => {
    const v = slab[key];
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    throw no(`\`${key}\` is neither a string nor a number`);
  };
  const company = scalar("company");
  const grade = scalar("grade");
  if (company === null) throw no("missing field `company`");
  if (grade === null) throw no("missing field `grade`");
  const cert = scalar("cert");
  // `skip_serializing_if = "Option::is_none"`: an absent cert and an explicit null are the
  // same slab and must not be two rows. So is an empty one.
  return JSON.stringify(
    cert === null || cert === "" ? { company, grade } : { company, grade, cert },
  );
}

/** `schema::COLLECTION_GRAIN` as a key. The `coalesce(…, '')`s are load-bearing there and
 *  are `?? ""` here: NULLs in a UNIQUE index are distinct, so a nullable term left bare
 *  would stop enforcing anything the moment it was empty. */
function collectionGrain(e: FakeEntry): string {
  return JSON.stringify([
    e.cardId,
    e.finish,
    e.condition,
    e.lang,
    e.altered,
    e.signed,
    e.proxy,
    e.misprint,
    e.serialNumber ?? "",
    e.grading ?? "",
  ]);
}

/** `schema::WISHLIST_GRAIN`: an oracle card, optionally pinned to one printing and one
 *  finish. */
function wishGrain(w: FakeWish): string {
  return JSON.stringify([w.oracleId ?? "", w.cardId ?? "", w.preferredFinish ?? ""]);
}

/**
 * `schema::DECK_CARD_GRAIN` — `(deck_id, variant, category_id, card_id)`. Every column is NOT
 * NULL, so there is nothing to coalesce.
 *
 * `categoryId` is in it for the zone's old reason: the same printing filed under the main deck
 * and under the Maybeboard is two intentions, not one row that moved — only now that is read
 * off a category the user can rename. `variant` widens it again: the same printing can sit in
 * the live deck and the theory one at once.
 */
function deckCardAt(
  db: FakeDb,
  deckId: number,
  cardId: string,
  categoryId: number,
  variant: DeckVariant,
) {
  return db.deckCards.find(
    (dc) =>
      dc.deckId === deckId &&
      dc.variant === variant &&
      dc.categoryId === categoryId &&
      dc.cardId === cardId,
  );
}

/**
 * `deck::category_of_deck` — the fence every card write opens with, answering the category so
 * a refusal below can name it.
 *
 * It is not decoration: nothing in the DDL stops `deck_cards.category_id` pointing at a
 * category of a *different* deck (the foreign key only requires the row to exist), so this is
 * where "a card of deck A cannot be filed under a category of deck B" actually lives.
 */
function categoryOfDeck(db: FakeDb, deckId: number, categoryId: number): FakeDeckCategory {
  const category = categoryById(db, categoryId);
  if (!category) throw refuse(CATEGORY_GONE);
  if (category.deckId !== deckId) throw refuse(CATEGORY_WRONG_DECK);
  return category;
}

/**
 * `deck_meta::category_for_name` — find a category of this deck by name, or make a `main` one.
 *
 * The add path's "file it where this card belongs", and unlike a create it is *meant* to be
 * handed the same name over and over and answer the same id every time. The word itself is
 * computed in TypeScript (`autoCategoryFor`), because which pile a Sol Ring belongs in is
 * domain logic and this is plumbing. Matched on the name alone, `DECK_CATEGORY_GRAIN`'s shape:
 * a deck's own "Sideboard" category and the predefined one are the same row by that grain.
 */
function categoryForName(db: FakeDb, deckId: number, name: string): FakeDeckCategory {
  const trimmed = name.trim();
  if (trimmed === "") throw refuse("A category needs a name.");
  const found = db.deckCategories.find((c) => c.deckId === deckId && c.name === trimmed);
  if (found) return found;
  const row: FakeDeckCategory = {
    id: nextId(db.deckCategories),
    deckId,
    name: trimmed,
    // Always `main`: every category a user makes is one, which is why `PREDEFINED_CATEGORIES`
    // has no `main` row to collide with.
    kind: "main",
    isActive: true,
    sortOrder: nextSortOrder(db, deckId),
  };
  db.deckCategories.push(row);
  return row;
}

/** `coalesce(max(sort_order), -1) + 1` over one deck's categories — where the next one goes. */
function nextSortOrder(db: FakeDb, deckId: number): number {
  return db.deckCategories
    .filter((c) => c.deckId === deckId)
    .reduce((n, c) => Math.max(n, c.sortOrder + 1), 0);
}

/**
 * `deck_meta::ensure_predefined_categories` — create the four a deck is missing, leave the ones
 * it has.
 *
 * Idempotent by construction: each kind is checked before it is inserted, so a second call
 * writes nothing. `deck_create` is the one caller here, as it is the one caller there; a deck
 * that exists but can be filed into nothing is a state nothing downstream expects.
 */
function ensurePredefinedCategories(db: FakeDb, deckId: number): void {
  for (const [kind, name, isActive] of PREDEFINED_CATEGORIES) {
    if (db.deckCategories.some((c) => c.deckId === deckId && c.kind === kind)) continue;
    db.deckCategories.push({
      id: nextId(db.deckCategories),
      deckId,
      name,
      kind,
      isActive,
      sortOrder: nextSortOrder(db, deckId),
    });
  }
}

/**
 * `deck_meta`'s `SELECT … WHERE id = ?1` fence for a category an *adjustment* names.
 *
 * Distinct from {@link categoryOfDeck}, which a **card** write runs and which also checks the
 * deck: a rename, a set-active and a delete address the category by its own id, because a
 * category names its own deck.
 */
function requireCategory(db: FakeDb, id: number): FakeDeckCategory {
  const category = categoryById(db, id);
  if (!category) throw refuse(CATEGORY_GONE);
  return category;
}

/** `deck_meta::rename_category`/`delete_category`'s kind check. Never reached by
 *  `set_category_active`, which is the one write of the three every kind answers to. */
function refuseIfPredefined(category: FakeDeckCategory): void {
  if (category.kind !== "main") throw refuse(predefinedRefusal(category.name));
}

/** `EXISTS(… WHERE deck_id = ?1 AND name = ?2 AND id <> ?3)` — the grain check both the
 *  category create and the rename run, and the tag pair's twin one table over. */
function nameIsTaken(
  rows: { deckId: number; name: string; id: number }[],
  deckId: number,
  name: string,
  except: number | null,
): boolean {
  return rows.some((r) => r.deckId === deckId && r.name === name && r.id !== except);
}

function tagById(db: FakeDb, id: number): FakeDeckTag | undefined {
  return db.deckTags.find((t) => t.id === id);
}

function folderById(db: FakeDb, id: number): FakeDeckFolder | undefined {
  return db.deckFolders.find((f) => f.id === id);
}

/** `coalesce(max(sort_order), -1) + 1` over one folder's children. `IS`, not `=`: `parent_id`
 *  is nullable and `=` never matches a bound NULL, so the root is a sibling group like any
 *  other rather than a hole. */
function nextFolderOrder(db: FakeDb, parentId: number | null): number {
  return db.deckFolders
    .filter((f) => f.parentId === parentId)
    .reduce((n, f) => Math.max(n, f.sortOrder + 1), 0);
}

/**
 * `deck_theory::seed_from_live` — copy the live list into the theory one, leaving whatever
 * theory already holds alone.
 *
 * `ON CONFLICT … DO NOTHING` on the grain rather than a fold, and the distinction is the whole
 * point: a theory row the user already made is *their plan for that card*, and topping it up
 * with the live count would silently overwrite the very edit the theory list exists to hold.
 * So this is a seed that can also top up — idempotent, never destructive.
 *
 * `tagId` and `needsReview` travel with the copy. A label is the user's word about this card in
 * this deck and a plan inherits it; the flag says the printing left the card database, which is
 * as true of the copy as of the original.
 *
 * **Allocates nothing**, and must not: the allocator reserves copies for `live` only, so a
 * theory list that claimed anything would take copies away from decks that are real.
 *
 * Answers the number of **rows** written, which is what `execute` counts — never copies.
 */
function seedFromLive(db: FakeDb, deckId: number): number {
  let rows = 0;
  for (const live of db.deckCards.filter((dc) => dc.deckId === deckId && dc.variant === LIVE)) {
    const held = db.deckCards.some(
      (dc) =>
        dc.deckId === deckId &&
        dc.variant === "theory" &&
        dc.categoryId === live.categoryId &&
        dc.cardId === live.cardId,
    );
    if (held) continue;
    db.deckCards.push({ ...live, id: nextId(db.deckCards), variant: "theory" });
    rows += 1;
  }
  return rows;
}

/** `deck_theory::theory_copies` — copies, not rows. Two printings at 2 and 3 is 5 cards. */
function theoryCopies(db: FakeDb, deckId: number): number {
  return db.deckCards
    .filter((dc) => dc.deckId === deckId && dc.variant === "theory")
    .reduce((n, dc) => n + dc.quantity, 0);
}

/**
 * `deck_theory::group_key` — what makes two deck rows the same *card* for a difference.
 *
 * Oracle id when there is one, the printing's id when there is not, told apart by a prefix so
 * a card id can never be mistaken for an oracle id: both are UUIDs out of the same generator,
 * and a bare string key would be one collision away from comparing a printing with an
 * unrelated card. Two orphans of the same card therefore look like two cards, which is as far
 * as the data honestly goes.
 */
function groupKey(oracleId: string | null, cardId: string): string {
  return oracleId === null ? `c:${cardId}` : `o:${oracleId}`;
}

/**
 * `deck_theory::OWNED_SPARE_SQL` — copies of one oracle card the collection holds that **no
 * built deck has claimed**.
 *
 * Built is the whole of the test, and it is the allocator's rule read from the other end: a
 * deck on a table has its cards, a deck being planned shares copies with every other draft, so
 * an unbuilt deck's claim does not make a copy unavailable to this plan. Floored at zero — a
 * collection stepped down under a stored claim can make the subtraction negative, and "you own
 * −1 of these" is not a thing to tell anyone.
 *
 * The orphan arm is `?1 IS NULL AND card_id = ?2`: a row whose printing left `cards` is matched
 * by **exact printing** instead, because that is the only identity it has left.
 */
function ownedSpare(db: FakeDb, oracleId: string | null, cardId: string): number {
  const mine = (entryCardId: string) => {
    if (oracleId === null) return entryCardId === cardId;
    return cardById(db, entryCardId)?.oracleId === oracleId;
  };
  const held = db.collectionEntries
    .filter((e) => mine(e.cardId))
    .reduce((n, e) => n + e.quantity, 0);
  const claimed = db.decks
    .filter((d) => d.isBuilt)
    .reduce((n, d) => {
      const claims = allocate(db, d.id);
      let taken = 0;
      for (const [entryId, quantity] of claims) {
        const entry = db.collectionEntries.find((e) => e.id === entryId);
        if (entry && mine(entry.cardId)) taken += Math.min(quantity, entry.quantity);
      }
      return n + taken;
    }, 0);
  return Math.max(0, held - claimed);
}

/** One row of {@link theoryDiff}'s working form. The oracle id is deliberately **not** on
 *  `TheoryDiffRow` — the webview draws a printing and a count and has no use for it, while
 *  `deck_theory_missing_to_wishlist` cannot do without one: a wish is oracle-grained. */
interface GroupedDiff {
  oracleId: string | null;
  row: TheoryDiffRow;
}

/**
 * `deck_theory::grouped_diff` — cards the **theory** list holds that **live** does not.
 *
 * **One direction only**, which is the design rather than an omission: what live has and theory
 * dropped is a cut the reader already made and needs no row. **Inactive categories are excluded
 * from both sides**, so a card parked in either Maybeboard is neither wanted nor owned for this
 * purpose — filtering one side and not the other is how a scratchpad would come to fill a
 * shopping list.
 *
 * Compared by **oracle card**, not by printing: needing a second Sol Ring is not answered by
 * the live list holding a different printing of one. The same card filed in two theory
 * categories is **one line**, for the sum, named by the category the editor lists first — and
 * ordered by where that representative row falls in the editor's own reading order, so the
 * shopping list runs down the deck the way the deck is drawn.
 */
function theoryDiff(db: FakeDb, deckId: number, mp: MarketplaceId): GroupedDiff[] {
  const rows = db.deckCards
    .filter((dc) => {
      if (dc.deckId !== deckId) return false;
      return categoryById(db, dc.categoryId)?.isActive === true;
    })
    .sort(deckReadOrder(db));
  const wanted = new Map<string, number>();
  const held = new Map<string, number>();
  const order: [string, GroupedDiff][] = [];
  for (const dc of rows) {
    const card = cardById(db, dc.cardId);
    const key = groupKey(card?.oracleId ?? null, dc.cardId);
    if (dc.variant !== "theory") {
      held.set(key, (held.get(key) ?? 0) + dc.quantity);
      continue;
    }
    wanted.set(key, (wanted.get(key) ?? 0) + dc.quantity);
    if (order.some(([k]) => k === key)) continue;
    order.push([
      key,
      {
        oracleId: card?.oracleId ?? null,
        row: {
          cardId: dc.cardId,
          name: dc.name,
          categoryName: categoryById(db, dc.categoryId)?.name ?? "",
          // Filled below, once both sides are summed.
          quantity: 0,
          // The same flat nonfoil price the deck read uses, at the same marketplace.
          unitPrice: nonfoilPriceAt(db, card, mp),
          setCode: dc.setCode,
          collectorNumber: dc.collectorNumber,
          ownedSpare: 0,
        },
      },
    ]);
  }
  const diff: GroupedDiff[] = [];
  for (const [key, grouped] of order) {
    const short = (wanted.get(key) ?? 0) - (held.get(key) ?? 0);
    if (short <= 0) continue;
    grouped.row.quantity = short;
    grouped.row.ownedSpare = ownedSpare(db, grouped.oracleId, grouped.row.cardId);
    diff.push(grouped);
  }
  return diff;
}

/** `collection::printing_of` — the printing as the entry will remember it. */
function requireCard(db: FakeDb, cardId: string): FakeCard {
  const card = cardById(db, cardId);
  if (!card) throw refuse(`no card with the id \`${cardId}\` is in the card database`);
  return card;
}

/**
 * `deck::touch_deck`'s first half: the deck, or [`DECK_GONE`].
 *
 * The bump is deliberately *not* here. `touch_deck` is one UPDATE inside a transaction that
 * several paths below abandon — a `move_card` that found nothing, a `swap_printing` refused
 * for a different oracle card — and a rolled-back transaction takes the bump with it. So the
 * gallery does not resort on a refused write, and every handler stamps at the point its Rust
 * twin commits. The one place that looks like an exception and is not: `set_card_quantity`'s
 * zero path commits whether or not it deleted a row, so a removal that found nothing to
 * remove *does* move `updated_at`.
 */
function requireDeck(db: FakeDb, deckId: number): FakeDeck {
  const deck = db.decks.find((d) => d.id === deckId);
  if (!deck) throw refuse(DECK_GONE);
  return deck;
}

/** `deck::card_gone`. It names the category's **name**, never its id: a number the user never
 *  chose says nothing, and every caller has the name already — {@link categoryOfDeck} hands it
 *  back as the by-product of the fence they all run first. */
function cardGone(category: string): string {
  return `That card is not in this deck's ${category} category any more.`;
}

/**
 * `wishlist::add_wish`, as a function rather than only a handler.
 *
 * `deck::missing_to_wishlist` writes **through** this for the reason the Rust does: the
 * grain, the name lookup and the fold all live here, and a second write path would be a
 * second set of rules to keep in step. Clicking "send missing to wishlist" twice therefore
 * raises one line rather than making two, which is this function's contract and not that
 * one's.
 */
function addWish(db: FakeDb, input: WishInput): EntryChange {
  if (input.preferredFinish !== undefined) validFinish(input.preferredFinish);
  // A quantity below one is read as one rather than refused: this is the only add in the app
  // that does that, and it is `add_wish`'s own rule.
  const quantity = input.quantity <= 0 ? 1 : input.quantity;
  // Trimmed, and blank read as absent, **before** anything asks whether an id is there. A
  // wish arriving with `oracleId: ""` from a cleared form field would otherwise pass every
  // guard and land on the grain `('','','')`, which every other blank-id wish folds into —
  // one row silently accumulating unrelated cards' quantities.
  const cardId = nonblank(input.cardId);
  const sentOracleId = nonblank(input.oracleId);
  const sentName = nonblank(input.name);
  if (cardId === null && sentOracleId === null) {
    throw refuse("a wish needs either a card or an oracle id");
  }
  const printing = cardId === null ? null : cardById(db, cardId);
  if (cardId !== null && printing === null) {
    throw refuse("no card with that id is in the card database");
  }
  // The printing's own oracle id can be blank too — `cards.oracle_id` is nullable, and a row
  // carrying `''` would fold on the grain just the same.
  const oracleId = sentOracleId ?? nonblank(printing?.oracleId);
  // A wish made from an oracle card alone takes its name from *a* printing of it — any of
  // them, because `cards.name` is the oracle name on every printing — and must be given one
  // when `cards` has none. A shopping list that cannot say what it is shopping for is not a
  // list. Same ordering as the list's own LEFT JOIN, so the name and the printing the row
  // prices from are the same card.
  const named =
    sentName ?? printing?.name ?? wishCard(db, { oracleId, cardId: null })?.name ?? null;
  if (named === null) throw refuse("a wish needs a card name");

  const row: FakeWish = {
    id: 0,
    cardId,
    oracleId,
    name: named,
    // Only a *pinned* wish copies a printing onto the row: an any-printing wish is
    // deliberately not for one, so its three printing columns stay null.
    setCode: printing?.setCode ?? null,
    collectorNumber: printing?.collectorNumber ?? null,
    lang: printing?.lang ?? null,
    quantity,
    preferredFinish: input.preferredFinish ?? null,
    notes: input.notes ?? null,
    needsReview: null,
    updatedAt: stamp(db),
  };
  const existing = db.wishlistEntries.find((w) => wishGrain(w) === wishGrain(row));
  if (existing) {
    existing.quantity += quantity;
    existing.notes = existing.notes ?? row.notes;
    existing.updatedAt = row.updatedAt;
    return { id: existing.id, quantity: existing.quantity, removed: false };
  }
  row.id = nextId(db.wishlistEntries);
  db.wishlistEntries.push(row);
  return { id: row.id, quantity: row.quantity, removed: false };
}

/** `wishlist::remove_wish`. An id that resolves to nothing is a success: the caller wanted
 *  that row gone, and it is gone. */
function removeWish(db: FakeDb, id: number): EntryChange {
  db.wishlistEntries = db.wishlistEntries.filter((w) => w.id !== id);
  return { id, quantity: 0, removed: true };
}

/**
 * Every write command, bound to the same store {@link readHandlers} answers from.
 *
 * The return type is inferred and `satisfies`-checked for the reason `readHandlers`' is:
 * `CommandHandler`'s parameter is `never`, so a value of that type dispatches but never
 * *calls*, and the tests call these directly.
 *
 * Three things the app does that are absent here, all for one reason — **there is no
 * `deck_allocations` table**, because this fake allocates at read time (simplification 2):
 *
 * 1. `deck::allocate_deck` is not called by any write. Every card write, the Built toggle and
 *    `missing_to_wishlist` run it in the app; here the numbers are recomputed by `deck_get`,
 *    so a write that would have reallocated simply leaves the next read to. There is exactly
 *    one allocator in this file and it is `allocate`.
 * 2. `deck_update`'s `isBuilt` still changes what every *other* deck can see, but it does so
 *    by changing what the next read's one pass computes rather than by rewriting rows.
 * 3. `deck_delete`'s cascade reaches `deck_cards`, `deck_categories` and `deck_tags` — the
 *    three the v8 DDL cascades from `decks`. It also cascades to `deck_allocations`, and
 *    there is nothing here to cascade to.
 */
export function writeHandlers(db: FakeDb) {
  return {
    /** `collection::add_entry` — the quick-add, folding into the row that already holds this
     *  grain. */
    collection_add: (args: { entry: EntryInput }): EntryChange => {
      refuseIfBusy(db);
      const input = args.entry;
      const finish = validFinish(input.finish);
      const condition = validCondition(input.condition);
      // Not `validQuantity`: *adding* zero copies is a no-op dressed as a write, and would
      // conjure a row out of a card the user never said they had. Zero is a state a row is
      // moved to, never one it is created in.
      if (input.quantity <= 0) throw refuse(ZERO_ADD);
      const tradelist = validQuantity(input.tradelistQuantity ?? 0, "tradelist quantity");
      const grading = canonicalGrading(input.grading);
      const card = requireCard(db, input.cardId);

      const row: FakeEntry = {
        id: 0,
        cardId: input.cardId,
        finish,
        condition,
        quantity: input.quantity,
        // A tradelist bigger than the pile it is drawn from is not a promise anyone can
        // keep, and the importer is the caller that will send one.
        tradelistQuantity: Math.min(tradelist, input.quantity),
        // Read from `cards` at write time and never from the caller: letting a caller supply
        // these would let a caller disagree with the card it named.
        lang: card.lang,
        setCode: card.setCode,
        collectorNumber: card.collectorNumber,
        purchasePrice: input.purchasePrice ?? null,
        purchaseCurrency: input.purchaseCurrency ?? null,
        acquiredAt: input.acquiredAt ?? null,
        acquisitionSource: input.acquisitionSource ?? null,
        serialNumber: input.serialNumber ?? null,
        altered: input.altered ?? false,
        signed: input.signed ?? false,
        proxy: input.proxy ?? false,
        misprint: input.misprint ?? false,
        grading,
        conditionOriginal: input.conditionOriginal ?? null,
        // The column's own `DEFAULT '[]'`: a tags string is never null.
        tags: input.tags ?? "[]",
        notes: input.notes ?? null,
        needsReview: null,
        updatedAt: stamp(db),
      };

      const existing = db.collectionEntries.find(
        (e) => collectionGrain(e) === collectionGrain(row),
      );
      if (existing) {
        // The quantities add; everything else is first-writer-wins. A second add of a card
        // you already own is "one more of these", not "and here is what I paid this time".
        // `tags` and `conditionOriginal` are not in the DO UPDATE at all, for opposite
        // reasons: tags are a set the user curates on the row, and `conditionOriginal` is the
        // provenance of the condition already there, which a later add cannot retroactively
        // change. The entry editor is where both change.
        existing.quantity += row.quantity;
        existing.tradelistQuantity = Math.min(
          existing.tradelistQuantity + tradelist,
          existing.quantity,
        );
        existing.purchasePrice = existing.purchasePrice ?? row.purchasePrice;
        existing.purchaseCurrency = existing.purchaseCurrency ?? row.purchaseCurrency;
        existing.acquiredAt = existing.acquiredAt ?? row.acquiredAt;
        existing.acquisitionSource = existing.acquisitionSource ?? row.acquisitionSource;
        existing.notes = existing.notes ?? row.notes;
        existing.updatedAt = row.updatedAt;
        return { id: existing.id, quantity: existing.quantity, removed: false };
      }
      row.id = nextId(db.collectionEntries);
      db.collectionEntries.push(row);
      return { id: row.id, quantity: row.quantity, removed: false };
    },

    /** `collection::set_quantity` — the stepper. **Zero keeps the row**, with its condition,
     *  its purchase price and its acquisition story. Deleting is `collection_remove` and only
     *  ever `collection_remove`. */
    collection_set_quantity: (args: { id: number; quantity: number }): EntryChange => {
      refuseIfBusy(db);
      validQuantity(args.quantity, "collection quantity");
      const row = db.collectionEntries.find((e) => e.id === args.id);
      if (!row) throw refuse(ENTRY_GONE);
      row.quantity = args.quantity;
      // At zero copies there is nothing to offer.
      row.tradelistQuantity = Math.min(row.tradelistQuantity, args.quantity);
      row.updatedAt = stamp(db);
      return { id: row.id, quantity: row.quantity, removed: false };
    },

    /** `collection::update_entry`. Absent fields are left alone (`coalesce(?n, column)`),
     *  which is what makes this usable from a form that only sends what it changed — and a
     *  `quantity` of zero is applied like any other, because nothing typed into an edit form
     *  should delete the row being edited. */
    collection_update: (args: { id: number; patch: EntryPatch }): EntryChange => {
      refuseIfBusy(db);
      const patch = args.patch;
      if (patch.finish !== undefined) validFinish(patch.finish);
      if (patch.condition !== undefined) validCondition(patch.condition);
      if (patch.quantity !== undefined) validQuantity(patch.quantity, "collection quantity");
      if (patch.tradelistQuantity !== undefined) {
        validQuantity(patch.tradelistQuantity, "tradelist quantity");
      }
      // Blank grading is a silent no-op, not a clear: `coalesce(NULL, grading)` leaves the
      // column. An entry editor that offers to remove a grading has nothing to do it with.
      const grading = canonicalGrading(patch.grading);
      const row = db.collectionEntries.find((e) => e.id === args.id);
      if (!row) throw refuse(ENTRY_GONE);

      const quantity = patch.quantity ?? row.quantity;
      const next: FakeEntry = {
        ...row,
        finish: patch.finish ?? row.finish,
        condition: patch.condition ?? row.condition,
        conditionOriginal: patch.conditionOriginal ?? row.conditionOriginal,
        quantity,
        tradelistQuantity: Math.min(patch.tradelistQuantity ?? row.tradelistQuantity, quantity),
        purchasePrice: patch.purchasePrice ?? row.purchasePrice,
        purchaseCurrency: patch.purchaseCurrency ?? row.purchaseCurrency,
        acquiredAt: patch.acquiredAt ?? row.acquiredAt,
        acquisitionSource: patch.acquisitionSource ?? row.acquisitionSource,
        serialNumber: patch.serialNumber ?? row.serialNumber,
        altered: patch.altered ?? row.altered,
        signed: patch.signed ?? row.signed,
        proxy: patch.proxy ?? row.proxy,
        misprint: patch.misprint ?? row.misprint,
        grading: grading ?? row.grading,
        tags: patch.tags ?? row.tags,
        notes: patch.notes ?? row.notes,
        updatedAt: stamp(db),
      };
      // The one edit that cannot just be applied — SQLite would answer "UNIQUE constraint
      // failed: index 'idx_collection_grain'", which names an implementation detail and no
      // way forward. `collection::friendly` is the app talking instead.
      const key = collectionGrain(next);
      if (db.collectionEntries.some((e) => e.id !== row.id && collectionGrain(e) === key)) {
        throw refuse(GRAIN_TAKEN);
      }
      Object.assign(row, next);
      return { id: row.id, quantity: row.quantity, removed: false };
    },

    /** `collection::remove_entry` — the **only** thing in the collection that deletes. An id
     *  that resolves to nothing is a success: a delete that finds nothing already has what it
     *  wanted, and telling a stale list otherwise is an error dialog over a success. */
    collection_remove: (args: { id: number }): EntryChange => {
      refuseIfBusy(db);
      db.collectionEntries = db.collectionEntries.filter((e) => e.id !== args.id);
      return { id: args.id, quantity: 0, removed: true };
    },

    /** `wishlist::add_wish`. */
    wishlist_add: (args: { wish: WishInput }): EntryChange => {
      refuseIfBusy(db);
      return addWish(db, args.wish);
    },

    /** `wishlist::set_wish_quantity`. **Zero removes the row** — the collection's opposite,
     *  because `wishlist_entries` carries `CHECK (quantity > 0)` and a wish holds nothing
     *  worth keeping once it is emptied. */
    wishlist_set_quantity: (args: { id: number; quantity: number }): EntryChange => {
      refuseIfBusy(db);
      validQuantity(args.quantity, "wishlist quantity");
      if (args.quantity === 0) return removeWish(db, args.id);
      const row = db.wishlistEntries.find((w) => w.id === args.id);
      if (!row) throw refuse(WISH_GONE);
      row.quantity = args.quantity;
      row.updatedAt = stamp(db);
      return { id: row.id, quantity: row.quantity, removed: false };
    },

    /** `wishlist::remove_wish`. */
    wishlist_remove: (args: { id: number }): EntryChange => {
      refuseIfBusy(db);
      return removeWish(db, args.id);
    },

    /** `deck::create_deck`, which gives the deck its four predefined categories in the same
     *  transaction — a deck that exists but cannot be filed into anything is a state nothing
     *  downstream expects. */
    deck_create: (args: { deck: DeckInput }): DeckRow => {
      refuseIfBusy(db);
      const row: FakeDeck = {
        id: nextId(db.decks),
        name: validName(args.deck.name),
        formatKey: validFormat(args.deck.formatKey),
        description: args.deck.description ?? null,
        coverCardId: null,
        coverKind: COVER_CARD_ART,
        isBuilt: false,
        archived: false,
        folderId: null,
        notes: null,
        theoryEnabled: false,
        updatedAt: stamp(db),
      };
      db.decks.push(row);
      ensurePredefinedCategories(db, row.id);
      return toDeckRow(db, row);
    },

    /**
     * `deck::update_deck` — rename, re-format, cover, notes, build, archive and the theory
     * switch all arrive here.
     *
     * `coalesce(?n, column)`, so absent means "leave it" and there is no field that *clears*
     * one: `description: ""` writes an empty string rather than a NULL, `coverCardId` cannot be
     * unset, and `folderId` can file a deck but never un-file one — {@link deck_set_folder} is
     * the command that reaches the root. Sending `isBuilt` reallocates in the app; here the next
     * `deck_get` does that work, so the flag is all this has to write.
     *
     * **Two things happen beside the columns.** Sending `coverCardId` sets `coverKind` back to
     * `card_art`, which is how a deck showing an uploaded picture returns to card art without
     * the file being deleted. And switching `theoryEnabled` **on** seeds the theory list from
     * live when there is nothing in it, in the same write: an empty theory list beside a full
     * live one reads as data loss rather than as a blank page. Switching it off keeps every row.
     *
     * The history is written **per changed field**, and only for fields that actually changed:
     * a dialog that saves an untouched form must not fill the drawer with edits nobody made.
     */
    deck_update: (args: { id: number; patch: DeckPatch }): DeckRow => {
      refuseIfBusy(db);
      const patch = args.patch;
      const name = patch.name === undefined ? undefined : validName(patch.name);
      const formatKey = patch.formatKey === undefined ? undefined : validFormat(patch.formatKey);
      const deck = requireDeck(db, args.id);
      const before = { ...deck };
      const field = (key: string, from: unknown, to: unknown) =>
        record(db, deck.id, DECK_LEVEL, "deck", null, { field: key, from, to }, 0);

      if (name !== undefined && name !== before.name) field("name", before.name, name);
      if (formatKey !== undefined && formatKey !== before.formatKey) {
        field("format", before.formatKey, formatKey);
      }
      if (patch.description !== undefined && patch.description !== before.description) {
        field("description", before.description, patch.description);
      }
      // `cover_value`: a cover change is "which picture is showing", so the `from` side says the
      // literal `"custom"` when the deck was showing an uploaded file rather than the card id
      // underneath it — and a card id that is already stored still *changes* the cover in that
      // case, which a `from !== to` guard over the id alone would swallow.
      const coverWas = before.coverKind === COVER_CUSTOM ? COVER_CUSTOM : before.coverCardId;
      if (patch.coverCardId !== undefined && patch.coverCardId !== coverWas) {
        field("cover", coverWas, patch.coverCardId);
      }
      if (patch.isBuilt !== undefined && patch.isBuilt !== before.isBuilt) {
        field("built", before.isBuilt, patch.isBuilt);
      }
      if (patch.archived !== undefined && patch.archived !== before.archived) {
        field("archived", before.archived, patch.archived);
      }
      if (patch.notes !== undefined && patch.notes !== before.notes) {
        field("notes", before.notes, patch.notes);
      }
      // One row, whether or not the theory list was seeded below: the seeding is part of
      // switching the list on rather than a second edit, and N `add` rows for one press would
      // read as a deck somebody typed out.
      if (patch.theoryEnabled !== undefined && patch.theoryEnabled !== before.theoryEnabled) {
        field("theory", before.theoryEnabled, patch.theoryEnabled);
      }
      if (patch.folderId !== undefined && patch.folderId !== before.folderId) {
        recordFiled(db, deck.id, patch.folderId);
      }

      deck.name = name ?? deck.name;
      deck.formatKey = formatKey ?? deck.formatKey;
      deck.description = patch.description ?? deck.description;
      if (patch.coverCardId !== undefined) {
        deck.coverCardId = patch.coverCardId;
        deck.coverKind = COVER_CARD_ART;
      }
      deck.isBuilt = patch.isBuilt ?? deck.isBuilt;
      deck.archived = patch.archived ?? deck.archived;
      deck.folderId = patch.folderId ?? deck.folderId;
      deck.notes = patch.notes ?? deck.notes;
      if (patch.theoryEnabled !== undefined) {
        deck.theoryEnabled = patch.theoryEnabled;
        if (patch.theoryEnabled && theoryCopies(db, deck.id) === 0) seedFromLive(db, deck.id);
      }
      deck.updatedAt = stamp(db);
      return toDeckRow(db, deck);
    },

    /**
     * `deck::set_cover_image` — point the deck at a picture on disk.
     *
     * `sourcePath` is a **path the backend reads**, never bytes and never a `file://` URL. There
     * is no disk here and no `cover/<deckId>` route on the fake image handler, so what this
     * models is the *state change* the command makes and not the encode: `coverKind` becomes
     * `custom` and {@link FakeDeck.coverCardId} is deliberately **left alone**, which is what
     * makes switching back to card art lose nothing.
     *
     * The history row is written **even when both sides read `custom`** — replacing one picture
     * with another is exactly the change this command exists to make, and the payload
     * deliberately does not name the file, so the two sides matching is what "a different
     * picture" looks like from here.
     */
    deck_set_cover_image: (args: { deckId: number; sourcePath: string }): DeckRow => {
      refuseIfBusy(db);
      const deck = requireDeck(db, args.deckId);
      const coverWas = deck.coverKind === COVER_CUSTOM ? COVER_CUSTOM : deck.coverCardId;
      record(
        db,
        deck.id,
        DECK_LEVEL,
        "deck",
        null,
        { field: "cover", from: coverWas, to: COVER_CUSTOM },
        0,
      );
      deck.coverKind = COVER_CUSTOM;
      deck.updatedAt = stamp(db);
      return toDeckRow(db, deck);
    },

    /**
     * `deck::set_folder` — file the deck, or with `folderId: null` put it back at the **root**.
     *
     * A command rather than a {@link DeckPatch} field, and the reason is the convention every
     * column in that struct is written under: `coalesce(?n, column)` reads a bound NULL as
     * "leave it", so within a patch `null` cannot mean "clear it". Here `null` genuinely means
     * root, because there is nothing else it could mean — and it must travel as an **explicit
     * key**, since Tauri fills parameters by name and an absent one is a refusal.
     *
     * The folder is validated in words rather than left to the foreign key, and the history row
     * is written only when the deck actually moves.
     */
    deck_set_folder: (args: { deckId: number; folderId: number | null }): DeckRow => {
      refuseIfBusy(db);
      if (args.folderId !== null && !folderById(db, args.folderId)) throw refuse(FOLDER_GONE);
      const deck = requireDeck(db, args.deckId);
      if (args.folderId !== deck.folderId) recordFiled(db, deck.id, args.folderId);
      deck.folderId = args.folderId;
      deck.updatedAt = stamp(db);
      return toDeckRow(db, deck);
    },

    /** `deck::delete_deck`. **This one really deletes** — the deck, its cards, its categories,
     *  its tags and its history, by cascade. Archiving is the soft path, and it is what a
     *  gallery's "remove" should reach for. Its **folder** is not touched: a folder files decks
     *  and is not owned by one. */
    deck_delete: (args: { id: number }): void => {
      refuseIfBusy(db);
      db.decks = db.decks.filter((d) => d.id !== args.id);
      db.deckCards = db.deckCards.filter((dc) => dc.deckId !== args.id);
      db.deckCategories = db.deckCategories.filter((c) => c.deckId !== args.id);
      db.deckTags = db.deckTags.filter((t) => t.deckId !== args.id);
      db.deckAudit = db.deckAudit.filter((a) => a.deckId !== args.id);
    },

    /**
     * `deck::duplicate_deck` — the cards come across in **both variants**, never `isBuilt` and
     * never `archived`. A copy is a **draft**: it has reserved nothing, it is not sleeved up
     * on a table, and it is not something the user filed away. The theory list comes too,
     * because a copy made to try something out is exactly the copy that wants the plan.
     *
     * **Categories and tags are new rows with new ids, and the cards are remapped onto them.**
     * This is the part a "copy the cards" implementation gets wrong invisibly: a card row
     * stores a `category_id`, so copying it verbatim would file the copy's cards under the
     * *original's* categories — and then deleting the original would take the copy's cards
     * with it through `ON DELETE CASCADE`. Two id maps are what keep a copy a copy.
     *
     * It is not handed {@link ensurePredefinedCategories}: it inherits the source's four,
     * because every deck has them.
     */
    deck_duplicate: (args: { id: number }): DeckRow => {
      refuseIfBusy(db);
      const source = requireDeck(db, args.id);
      const copy: FakeDeck = {
        ...source,
        id: nextId(db.decks),
        name: `${source.name} (copy)`,
        isBuilt: false,
        archived: false,
        updatedAt: stamp(db),
      };
      db.decks.push(copy);
      const categoryMap = new Map<number, number>();
      for (const c of db.deckCategories.filter((row) => row.deckId === source.id)) {
        const made: FakeDeckCategory = { ...c, id: nextId(db.deckCategories), deckId: copy.id };
        db.deckCategories.push(made);
        categoryMap.set(c.id, made.id);
      }
      const tagMap = new Map<number, number>();
      for (const t of db.deckTags.filter((row) => row.deckId === source.id)) {
        const made: FakeDeckTag = { ...t, id: nextId(db.deckTags), deckId: copy.id };
        db.deckTags.push(made);
        tagMap.set(t.id, made.id);
      }
      // `needsReview` travels with the row: the sentence says this printing left the card
      // database, which is just as true of the copy.
      for (const dc of db.deckCards.filter((row) => row.deckId === source.id)) {
        db.deckCards.push({
          ...dc,
          id: nextId(db.deckCards),
          deckId: copy.id,
          // `?? dc.categoryId` cannot happen — a card's category is a category of its own
          // deck — and is the honest answer if it ever does, as the Rust's `NULL` fallback is.
          categoryId: categoryMap.get(dc.categoryId) ?? dc.categoryId,
          tagId: dc.tagId === null ? null : (tagMap.get(dc.tagId) ?? null),
        });
      }
      return toDeckRow(db, copy);
    },

    /**
     * `deck::add_card` — the drag-in and the click-to-add, folding on the grain.
     *
     * It reads `cards` to denormalize the printing **and the name** onto the row, so it
     * refuses a card the database does not have: an orphaned deck row can be stepped and
     * moved but never re-added. The name is here for the wishlist's reason — a deck list that
     * cannot say what an orphaned row *is* is not a list.
     *
     * **Either `categoryId` or `categoryName`, and at least one** ({@link NO_CATEGORY}). An id
     * is a drop onto a column the user pointed at; a name is found-or-created through
     * {@link categoryForName}. When both arrive the id wins: it is the more specific
     * instruction, and it is the one a drag carries.
     */
    deck_add_card: (args: {
      deckId: number;
      cardId: string;
      categoryId: number | null;
      categoryName: string | null;
      variant: DeckVariant;
      quantity: number;
    }): EntryChange => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      if (args.quantity <= 0) throw refuse(ZERO_ADD);
      if (args.categoryId === null && args.categoryName === null) throw refuse(NO_CATEGORY);
      const card = requireCard(db, args.cardId);
      const deck = requireDeck(db, args.deckId);
      let category: FakeDeckCategory;
      if (args.categoryId !== null) {
        category = categoryOfDeck(db, args.deckId, args.categoryId);
      } else if (args.categoryName !== null) {
        category = categoryForName(db, args.deckId, args.categoryName);
      } else {
        // Unreachable past the guard above, and written as a second refusal rather than an
        // assertion so that an edit which ever drops that guard answers the sentence instead
        // of throwing something nobody can read.
        throw refuse(NO_CATEGORY);
      }
      const existing = deckCardAt(db, args.deckId, args.cardId, category.id, variant);
      deck.updatedAt = stamp(db);
      if (existing) {
        // The quantities add; `tagId` and `needsReview` are left alone, because the row that
        // is already there is the one the user labelled.
        existing.quantity += args.quantity;
        return { id: existing.id, quantity: existing.quantity, removed: false };
      }
      const row: FakeDeckCard = {
        id: nextId(db.deckCards),
        deckId: args.deckId,
        categoryId: category.id,
        variant,
        cardId: args.cardId,
        tagId: null,
        quantity: args.quantity,
        name: card.name,
        setCode: card.setCode,
        collectorNumber: card.collectorNumber,
        lang: card.lang,
        needsReview: null,
      };
      db.deckCards.push(row);
      return { id: row.id, quantity: row.quantity, removed: false };
    },

    /**
     * `deck::set_card_quantity` — the stepper, and the write that works on a row whose
     * printing has left the card database. **Zero removes the row.**
     *
     * The wishlist's asymmetry rather than the collection's: a category slot holds an
     * intention and nothing else, and an intention stepped down to none of is withdrawn. A
     * slot the caller wanted empty and that is already empty answers `removed: true` with
     * `id: 0` — and still moves the deck's `updatedAt`, because that path commits.
     */
    deck_set_card_quantity: (args: {
      deckId: number;
      cardId: string;
      categoryId: number;
      variant: DeckVariant;
      quantity: number;
    }): EntryChange => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      validQuantity(args.quantity, "deck quantity");
      const deck = requireDeck(db, args.deckId);
      const category = categoryOfDeck(db, args.deckId, args.categoryId);
      const row = deckCardAt(db, args.deckId, args.cardId, category.id, variant);
      if (args.quantity === 0) {
        db.deckCards = db.deckCards.filter((dc) => dc !== row);
        deck.updatedAt = stamp(db);
        return { id: row?.id ?? 0, quantity: 0, removed: true };
      }
      // The `GONE` asymmetry: an *adjustment* to a row that is not there could not do what it
      // was asked. Putting a card into a category is `deck_add_card`.
      if (!row) throw refuse(cardGone(category.name));
      row.quantity = args.quantity;
      deck.updatedAt = stamp(db);
      return { id: row.id, quantity: row.quantity, removed: false };
    },

    /**
     * `deck::move_card` — every copy from one category to another, folding into what the
     * target already holds. **Within one variant**: a move is a re-filing, never a promotion
     * of a theory row into the live deck.
     *
     * The identity travels **from the moved row**, never from a fresh `cards` lookup: a deck
     * whose printing left the card database is exactly the deck whose scratchpad someone is
     * tidying, and a move that needed the id to resolve would refuse the one row that most
     * needs moving. `tagId` travels with it for the same reason — a label is the user's word
     * about this card in this deck, and re-filing it is not a reason to lose it.
     */
    deck_move_card: (args: {
      deckId: number;
      cardId: string;
      fromCategoryId: number;
      toCategoryId: number;
      variant: DeckVariant;
    }): void => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      // Before the deck is even looked up, exactly as the Rust returns before its transaction.
      if (args.fromCategoryId === args.toCategoryId) return;
      const deck = requireDeck(db, args.deckId);
      const from = categoryOfDeck(db, args.deckId, args.fromCategoryId);
      const to = categoryOfDeck(db, args.deckId, args.toCategoryId);
      const row = deckCardAt(db, args.deckId, args.cardId, from.id, variant);
      if (!row) throw refuse(cardGone(from.name));
      const target = deckCardAt(db, args.deckId, args.cardId, to.id, variant);
      if (target) {
        // `needs_review` is left alone where the target row already exists, and comes across
        // with a row that lands in an empty category — the fold's rule, and the reconciler's.
        target.quantity += row.quantity;
      } else {
        // A **new row**, not the old one re-filed: the statement is `INSERT … SELECT` followed
        // by a `DELETE`, so the copies land on a fresh rowid. Worth reproducing rather than
        // mutating `categoryId` in place, because row id is the allocator's tie-break within a
        // kind (`kindRank`, then `id`) — a moved row sorts *after* the rows already there, and
        // mutating would have left it sorting where it used to be.
        db.deckCards.push({ ...row, id: nextId(db.deckCards), categoryId: to.id });
      }
      db.deckCards = db.deckCards.filter((dc) => dc !== row);
      deck.updatedAt = stamp(db);
    },

    /**
     * `deck::swap_printing` — the card pane's "Use this printing".
     *
     * The one card write whose identity comes from a **fresh `cards` lookup** rather than
     * from the row being changed: a move keeps a printing the reader already chose, a swap
     * *is* the reader choosing a new one, off a list read out of `cards` a moment ago. So a
     * `toCardId` that does not resolve is a sync that raced the click, not an orphan to
     * preserve.
     *
     * "Another printing of the same card" is **enforced**, because nothing below would
     * enforce it: the insert carries the quantity onto whatever id it is handed, so a caller
     * that paired the wrong two would turn four Bolts into four Black Lotuses at the same
     * count, silently. The pair that cannot be compared is allowed through — a `from`
     * printing that has left `cards` has no oracle id, and refusing on "cannot tell" would
     * fence the copies onto a dead printing, which is the one row this command most needs to
     * be able to move. (A null on the **to** side skips the comparison too. That is a fence
     * around a nullable column rather than a card anyone can reach: no live row is null.)
     *
     * `needsReview` is deliberately not carried across — the flag says the row's printing
     * left the card database, and a swap onto one that is in it is exactly the cure.
     */
    deck_swap_printing: (args: {
      deckId: number;
      fromCardId: string;
      toCardId: string;
      categoryId: number;
      variant: DeckVariant;
    }): SwapResult => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      // Before anything else, so a no-op does not move `updatedAt` and resort the gallery.
      if (args.fromCardId === args.toCardId) throw refuse(SAME_PRINTING);
      const deck = requireDeck(db, args.deckId);
      const category = categoryOfDeck(db, args.deckId, args.categoryId);
      const row = deckCardAt(db, args.deckId, args.fromCardId, category.id, variant);
      if (!row) throw refuse(cardGone(category.name));
      const to = cardById(db, args.toCardId);
      if (!to) throw refuse(PRINTING_GONE);
      const fromOracle = cardById(db, args.fromCardId)?.oracleId ?? null;
      if (fromOracle !== null && to.oracleId !== null && fromOracle !== to.oracleId) {
        // Named as the deck lists the one it holds and as `cards` has the target now, which
        // is what the reader is looking at on each side of the press.
        throw refuse(
          `\`${to.name}\` is not another printing of \`${row.name}\`. Swapping a printing ` +
            `changes which printing of a card this deck plays, never which card it plays.`,
        );
      }
      const quantity = row.quantity;
      const target = deckCardAt(db, args.deckId, args.toCardId, category.id, variant);
      let landed: number;
      if (target) {
        target.quantity += quantity;
        landed = target.quantity;
      } else {
        // `add_card`'s insert, which means a **new row** — and then the old one is deleted.
        // Same reason `move_card` above pushes rather than mutating: the rowid is what the
        // allocator breaks ties on.
        db.deckCards.push({
          id: nextId(db.deckCards),
          deckId: args.deckId,
          categoryId: category.id,
          variant,
          cardId: args.toCardId,
          // `add_card`'s insert names no `tag_id`, so the copies land unlabelled.
          tagId: null,
          quantity,
          name: to.name,
          setCode: to.setCode,
          collectorNumber: to.collectorNumber,
          lang: to.lang,
          needsReview: null,
        });
        landed = quantity;
      }
      db.deckCards = db.deckCards.filter((dc) => dc !== row);
      deck.updatedAt = stamp(db);
      // `CHECK (quantity > 0)` means a row that was already there contributed at least one
      // copy, so the landed total is strictly greater than what moved exactly when it folded.
      return { folded: landed > quantity, quantity: landed };
    },

    /**
     * `deck::missing_to_wishlist` — everything this deck is short of, onto the wishlist.
     *
     * Answers how many **wishes were touched**, one per oracle card: the same card short in
     * two categories is one wish for the sum, and pressing twice raises a line rather than
     * making a second one. Always an **any-printing** wish — a shopping list is not a printing
     * preference, and the copy that fills the hole is whichever one turns up.
     *
     * It reallocates before counting, and here that is `deck_get`: the read is where this
     * fake allocates, so asking it *is* the reallocate-then-read the Rust spells out in two
     * calls. It reads the **live** list and skips an **inactive** category — a card the user
     * has not decided to play is not a card they need to buy, whether the undecidedness is a
     * switched-off category or a whole plan — and so is an orphan, which has neither an oracle
     * card nor a printing to wish for and is already carrying a sentence that says so.
     */
    deck_missing_to_wishlist: (args: { deckId: number }): number => {
      refuseIfBusy(db);
      const detail = readHandlers(db).deck_get({ id: args.deckId, variant: LIVE });
      if (!detail) throw refuse(DECK_GONE);
      const missing = new Map<string, { name: string; quantity: number }>();
      for (const row of detail.cards) {
        if (!row.categoryActive || row.oracleId === null) continue;
        const short = row.quantity - row.ownedQuantity;
        if (short <= 0) continue;
        const found = missing.get(row.oracleId) ?? { name: row.name, quantity: 0 };
        found.quantity += short;
        missing.set(row.oracleId, found);
      }
      // A `BTreeMap` in the Rust, so the wishes are written in oracle-id order — which is
      // what decides their row ids, and therefore the wishlist's `added` sort.
      for (const oracleId of [...missing.keys()].sort(cmp)) {
        const want = missing.get(oracleId)!;
        // The deck row's own name: the one name an orphan-safe row always has, and the same
        // name the deck list shows for it.
        addWish(db, { oracleId, name: want.name, quantity: want.quantity });
      }
      return missing.size;
    },

    /**
     * `deck_import::commit_import` — a whole decklist into one deck, in one transaction.
     *
     * **The command exists for the allocator.** Looping {@link deck_add_card} would be correct
     * in every other respect and would rebuild the deck's claims once per line. In the app it
     * runs once, at the end, over the finished deck; here it runs at the next `deck_get` like
     * every other write in this file (simplification 2), so the saving is invisible and the
     * shape is what matters.
     *
     * Three decisions borrowed verbatim, because each is a thing that would be wrong the other
     * way. **`replace` clears the cards and leaves the categories** — a category is the
     * reader's filing, not the list's, and sweeping them would delete piles somebody named,
     * reordered and switched off to import a file that mentions none of that. **It clears one
     * variant**, which is the reason `variant` is in the grain at all. And **the history is one
     * row per *effect*, never one per card**: an import of 117 cards would otherwise bury every
     * other event of that day, so it writes an `add` row carrying the counts plus — on a
     * `replace` that actually cleared something — a `remove` row, neither naming a card.
     *
     * **Every refusal is raised before anything is written**, which is this fake's stand-in for
     * the transaction: the Rust checks each line as it reaches it and rolls back, and the only
     * difference a caller can see is that there is no half-made category behind a refusal here
     * either. That is the observable contract — a line naming a printing the card database has
     * not got refuses the import and leaves the deck, including the one a `replace` was about
     * to clear, exactly as it was.
     */
    deck_import_commit: (args: {
      deckId: number;
      variant: DeckVariant;
      mode: ImportMode;
      items: ImportItem[];
    }): ImportOutcome => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      if (!IMPORT_MODES.some((m) => m === args.mode)) {
        throw refuse(
          `\`${args.mode}\` is not an import mode. Use one of: ${IMPORT_MODES.join(", ")}.`,
        );
      }
      // A write that writes nothing is not a write — `add_card`'s refusal for a quantity of
      // zero, one level up.
      if (args.items.length === 0) throw refuse(NOTHING_TO_IMPORT);
      const deck = requireDeck(db, args.deckId);
      // The whole list is judged before the first row moves; see the doc above.
      for (const item of args.items) {
        if (item.quantity <= 0) throw refuse(ZERO_ADD);
        validMetaName(item.categoryName, "A category");
        requireCard(db, item.cardId);
      }

      // **Copies, not rows** — the number the `remove` row's `delta` carries and the number a
      // reader recognises.
      let removed = 0;
      if (args.mode === IMPORT_REPLACE) {
        const cleared = db.deckCards.filter(
          (dc) => dc.deckId === deck.id && dc.variant === variant,
        );
        removed = cleared.reduce((n, dc) => n + dc.quantity, 0);
        db.deckCards = db.deckCards.filter((dc) => !cleared.includes(dc));
      }

      // Keyed on the **trimmed** name, which is the form `categoryForName` stores and therefore
      // the form two lines have to agree on: `Ramp` and `  Ramp  ` are one pile in the database,
      // and a map keyed on the raw string would count them as two in the history row.
      const categories = new Map<string, FakeDeckCategory>();
      let categoriesCreated = 0;
      let added = 0;
      for (const item of args.items) {
        const name = item.categoryName.trim();
        let category = categories.get(name);
        if (!category) {
          // Asked *before* the find-or-create, because afterwards there is no way to tell a
          // category that was made from one that was already there — and "3 new categories" is
          // a sentence the preview promises.
          const existed = db.deckCategories.some((c) => c.deckId === deck.id && c.name === name);
          category = categoryForName(db, deck.id, name);
          if (!existed) categoriesCreated += 1;
          categories.set(name, category);
        }
        const card = requireCard(db, item.cardId);
        const existing = deckCardAt(db, deck.id, item.cardId, category.id, variant);
        if (existing) {
          // `DECK_CARD_GRAIN`'s `ON CONFLICT … DO UPDATE`: a list naming a card on two lines
          // lands as one row with the sum, and a merge folds onto what the deck already held.
          existing.quantity += item.quantity;
        } else {
          db.deckCards.push({
            id: nextId(db.deckCards),
            deckId: deck.id,
            categoryId: category.id,
            variant,
            cardId: item.cardId,
            tagId: null,
            quantity: item.quantity,
            name: card.name,
            setCode: card.setCode,
            collectorNumber: card.collectorNumber,
            lang: card.lang,
            needsReview: null,
          });
        }
        // What the list *asked for*, not what the deck landed on: a merge that folded 3 onto an
        // existing 2 reports 3 and the row now holds 5.
        added += item.quantity;
      }

      // Facts only — `auditText.ts` words them. No card is named, because an import is about no
      // one card, and the counts are what a reader is owed instead.
      if (removed > 0) {
        record(
          db,
          deck.id,
          variant,
          "remove",
          null,
          { import: { mode: args.mode, cleared: removed } },
          -removed,
        );
      }
      record(
        db,
        deck.id,
        variant,
        "add",
        null,
        {
          import: {
            mode: args.mode,
            lines: args.items.length,
            cards: added,
            categories: categories.size,
          },
        },
        added,
      );
      deck.updatedAt = stamp(db);
      return { added, removed, categoriesCreated };
    },

    /* ------------------------------------------------- categories, tags and folders ---- */

    /**
     * `deck_meta::create_category` — a new pile, always `kind: "main"`, always active, appended
     * after the deck's last one.
     *
     * The duplicate check runs **before** the deck is touched: a refused create should not move
     * `updated_at` and resort the gallery over a write that never happened.
     */
    deck_category_create: (args: { deckId: number; name: string }): DeckCategory => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A category");
      if (nameIsTaken(db.deckCategories, args.deckId, name, null)) {
        throw refuse(CATEGORY_NAME_TAKEN);
      }
      const deck = requireDeck(db, args.deckId);
      const category: FakeDeckCategory = {
        id: nextId(db.deckCategories),
        deckId: deck.id,
        name,
        kind: "main",
        isActive: true,
        sortOrder: nextSortOrder(db, deck.id),
      };
      db.deckCategories.push(category);
      recordCategory(db, deck.id, { action: "create", name });
      deck.updatedAt = stamp(db);
      // `LIVE` and the default marketplace, both for one reason: a category **write** carries
      // neither, so the row it answers with is a courtesy rather than the read the panel then
      // does. Every caller invalidates and re-reads through its own variant and marketplace.
      return toDeckCategory(db, category, LIVE, DEFAULT_MARKETPLACE);
    },

    /**
     * `deck_meta::rename_category` — `id`, not `deckId`, because a category names its own deck.
     *
     * **Refused for the four predefined ones**, and that refusal is what guarantees they still
     * read those words: the rules role is `kind`, but every heading, every refusal sentence and
     * every payload in the history quotes the *name*.
     */
    deck_category_rename: (args: { id: number; name: string }): DeckCategory => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A category");
      const category = requireCategory(db, args.id);
      refuseIfPredefined(category);
      if (nameIsTaken(db.deckCategories, category.deckId, name, category.id)) {
        throw refuse(CATEGORY_NAME_TAKEN);
      }
      const deck = requireDeck(db, category.deckId);
      const previousName = category.name;
      category.name = name;
      recordCategory(db, deck.id, { action: "rename", name, previousName });
      deck.updatedAt = stamp(db);
      // `LIVE` and the default marketplace, both for one reason: a category **write** carries
      // neither, so the row it answers with is a courtesy rather than the read the panel then
      // does. Every caller invalidates and re-reads through its own variant and marketplace.
      return toDeckCategory(db, category, LIVE, DEFAULT_MARKETPLACE);
    },

    /**
     * `deck_meta::set_category_active` — switch a pile on or off.
     *
     * **Allowed on every kind, the Commander included**: the predefined guard is about renaming
     * and deleting and never reaches this. It reallocates in the app, because `isActive` is the
     * whole of what the allocator allocates *for*; here the next `deck_get` does that work, so
     * the flag is all this has to write — but the effect is the same and it is real: switching a
     * category off hands its copies back to every other deck.
     *
     * Two verbs in the history rather than one with a boolean, because that is what the change
     * *is* — a renderer deriving "switched off" from `{"active": false}` would be reading a
     * field about state to write a sentence about what happened.
     */
    deck_category_set_active: (args: { id: number; isActive: boolean }): DeckCategory => {
      refuseIfBusy(db);
      const category = requireCategory(db, args.id);
      const deck = requireDeck(db, category.deckId);
      category.isActive = args.isActive;
      recordCategory(db, deck.id, {
        action: args.isActive ? "activate" : "deactivate",
        name: category.name,
      });
      deck.updatedAt = stamp(db);
      // `LIVE` and the default marketplace, both for one reason: a category **write** carries
      // neither, so the row it answers with is a courtesy rather than the read the panel then
      // does. Every caller invalidates and re-reads through its own variant and marketplace.
      return toDeckCategory(db, category, LIVE, DEFAULT_MARKETPLACE);
    },

    /**
     * `deck_meta::reorder_categories` — `sortOrder` from position in `ids`, answering the whole
     * list back in its new order.
     *
     * An id that is not this deck's — stale, or gone — matches no row and is **silently
     * skipped** rather than failing the reorder over one entry. Send every id: this is the
     * order, not a move.
     *
     * The history names no category, because every one of them moved: there is no "from" and no
     * "to" that is about one pile, and listing the whole order would be storing the state rather
     * than the change.
     */
    deck_category_reorder: (args: { deckId: number; ids: number[] }): DeckCategory[] => {
      refuseIfBusy(db);
      const deck = requireDeck(db, args.deckId);
      args.ids.forEach((id, at) => {
        const category = db.deckCategories.find((c) => c.id === id && c.deckId === deck.id);
        if (category) category.sortOrder = at;
      });
      recordCategory(db, deck.id, { action: "reorder" });
      deck.updatedAt = stamp(db);
      return db.deckCategories
        .filter((c) => c.deckId === deck.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((c) => toDeckCategory(db, c, LIVE, DEFAULT_MARKETPLACE));
    },

    /**
     * `deck_meta::delete_category` — with or without keeping its cards.
     *
     * **`moveToCategoryId` is the whole of the difference, and `null` is destructive**: an id
     * moves the cards first, folding into whatever the target already holds — `null` lets the
     * cascade take the cards with the category, which is what a confirm dialog has to say out
     * loud. One command for both, because a caller doing the move and the delete as two round
     * trips could lose the cards between them.
     *
     * The move covers **both variants**, folding on the grain, so a `live` row and a `theory`
     * row of one printing land in their own matching rows in the target and never in each
     * other. A row the target already holds keeps its own `tagId` and `needsReview` — the
     * existing row wins a fold.
     *
     * The card count in the history is taken **before** anything moves, in copies rather than
     * rows: two printings at 2 and 3 is 5 cards, which is what the dialog warned about and the
     * only part of a deleted category a reader cannot get back.
     */
    deck_category_delete: (args: { id: number; moveToCategoryId: number | null }): void => {
      refuseIfBusy(db);
      if (args.moveToCategoryId === args.id) throw refuse(CATEGORY_SELF_MOVE);
      const category = requireCategory(db, args.id);
      refuseIfPredefined(category);
      if (args.moveToCategoryId !== null) {
        const target = categoryById(db, args.moveToCategoryId);
        if (!target) throw refuse(CATEGORY_GONE);
        if (target.deckId !== category.deckId) throw refuse(CATEGORY_WRONG_DECK);
      }
      const deck = requireDeck(db, category.deckId);
      const held = db.deckCards.filter((dc) => dc.categoryId === category.id);
      const cards = held.reduce((n, dc) => n + dc.quantity, 0);
      if (args.moveToCategoryId !== null) {
        const target = args.moveToCategoryId;
        for (const dc of held) {
          const landed = db.deckCards.find(
            (row) =>
              row.deckId === dc.deckId &&
              row.variant === dc.variant &&
              row.categoryId === target &&
              row.cardId === dc.cardId,
          );
          if (landed) landed.quantity += dc.quantity;
          else dc.categoryId = target;
        }
      }
      // Whatever did not fold has been re-filed above; what is left under this id either folded
      // (and is now a duplicate) or is being taken by the cascade.
      db.deckCards = db.deckCards.filter((dc) => dc.categoryId !== category.id);
      db.deckCategories = db.deckCategories.filter((c) => c.id !== category.id);
      recordCategory(db, deck.id, { action: "delete", name: category.name, cards });
      deck.updatedAt = stamp(db);
    },

    /** `deck_meta::create_tag` — a new label for this deck. Refuses a name the deck already has;
     *  the colour is a palette token and only its non-emptiness is checked here. */
    deck_tag_create: (args: { deckId: number; name: string; color: string }): DeckTag => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A tag");
      const color = validColor(args.color);
      if (nameIsTaken(db.deckTags, args.deckId, name, null)) throw refuse(TAG_NAME_TAKEN);
      const deck = requireDeck(db, args.deckId);
      const tag: FakeDeckTag = { id: nextId(db.deckTags), deckId: deck.id, name, color };
      db.deckTags.push(tag);
      recordTag(db, deck.id, { action: "create", tag: name, previous: null });
      deck.updatedAt = stamp(db);
      return toDeckTag(db, tag, LIVE);
    },

    /**
     * `deck_meta::update_tag` — rename **and** recolour, one command, both arguments required.
     * There is no patch shape here, so a caller changing one sends the other back unchanged.
     *
     * `rename` covers a recolour too, which is the honest simplification: the colour is a token
     * from a fixed palette and never appears in a history line, so a second verb would name a
     * distinction no reader could see.
     */
    deck_tag_update: (args: { id: number; name: string; color: string }): DeckTag => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A tag");
      const color = validColor(args.color);
      const tag = tagById(db, args.id);
      if (!tag) throw refuse(TAG_GONE);
      if (nameIsTaken(db.deckTags, tag.deckId, name, tag.id)) throw refuse(TAG_NAME_TAKEN);
      const deck = requireDeck(db, tag.deckId);
      const previous = tag.name;
      tag.name = name;
      tag.color = color;
      recordTag(db, deck.id, { action: "rename", tag: name, previous });
      deck.updatedAt = stamp(db);
      return toDeckTag(db, tag, LIVE);
    },

    /**
     * `deck_meta::delete_tag` — **untags its cards rather than deleting them**
     * (`deck_cards.tag_id` is `ON DELETE SET NULL`), which is the half of the sentence a confirm
     * dialog owes a reader.
     *
     * An id that resolves to nothing is a success: the caller wanted that tag gone, and it is
     * gone — and it touches no deck, having none left to touch.
     */
    deck_tag_delete: (args: { id: number }): void => {
      refuseIfBusy(db);
      const tag = tagById(db, args.id);
      if (!tag) return;
      const deck = requireDeck(db, tag.deckId);
      db.deckTags = db.deckTags.filter((t) => t.id !== tag.id);
      for (const dc of db.deckCards) if (dc.tagId === tag.id) dc.tagId = null;
      // `previous` is null: this row is about the label, and the label it is about is `tag`.
      // Filling it here would make a delete read as a rename that went nowhere.
      recordTag(db, deck.id, { action: "delete", tag: tag.name, previous: null });
      deck.updatedAt = stamp(db);
    },

    /**
     * `deck_meta::set_card_tag` — put the one tag a deck card carries on it, or take it off with
     * `tagId: null`.
     *
     * A **card** write wearing a tag command's name: it addresses the slot by the full grain
     * like every other card write, and answers {@link CARD_NOT_IN_CATEGORY} for a row that has
     * since moved, folded or been stepped to zero. A `tagId` belonging to another deck is
     * refused before anything is written.
     *
     * The history row carries the card id — which is what marks it the *card's* half of the
     * `tag` kind — and `tag: null` is how a row says the card wears nothing now: clearing a
     * label is as much a change as applying one, and `previous` is the only place the label it
     * lost is written down.
     */
    deck_card_set_tag: (args: {
      deckId: number;
      cardId: string;
      categoryId: number;
      variant: DeckVariant;
      tagId: number | null;
    }): void => {
      const variant = validVariant(args.variant);
      refuseIfBusy(db);
      let applied: string | null = null;
      if (args.tagId !== null) {
        const tag = tagById(db, args.tagId);
        if (!tag) throw refuse(TAG_GONE);
        if (tag.deckId !== args.deckId) throw refuse(TAG_WRONG_DECK);
        applied = tag.name;
      }
      const deck = requireDeck(db, args.deckId);
      const row = db.deckCards.find(
        (dc) =>
          dc.deckId === args.deckId &&
          dc.cardId === args.cardId &&
          dc.categoryId === args.categoryId &&
          dc.variant === variant,
      );
      if (!row) throw refuse(CARD_NOT_IN_CATEGORY);
      const previous = row.tagId === null ? null : (tagById(db, row.tagId)?.name ?? null);
      row.tagId = args.tagId;
      record(
        db,
        deck.id,
        variant,
        "tag",
        { id: row.cardId, name: row.name },
        { tag: applied, previous },
        0,
      );
      deck.updatedAt = stamp(db);
    },

    /**
     * `deck_meta::create_folder` — at the root with `parentId: null`, or inside another one.
     *
     * **No uniqueness rule on the name**, mirroring the DDL: unlike a category or a tag,
     * `deck_folders` carries no grain constant and no unique index, so two sibling folders may
     * share a name. Writes no history: a folder belongs to no deck, and `deck_audit.deck_id` is
     * NOT NULL — the `folder` kind records a *deck being filed*, which is `deck_set_folder`.
     */
    deck_folder_create: (args: { parentId: number | null; name: string }): DeckFolder => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A folder");
      if (args.parentId !== null && !folderById(db, args.parentId)) throw refuse(FOLDER_GONE);
      const folder: FakeDeckFolder = {
        id: nextId(db.deckFolders),
        parentId: args.parentId,
        name,
        sortOrder: nextFolderOrder(db, args.parentId),
      };
      db.deckFolders.push(folder);
      return toDeckFolder(folder);
    },

    deck_folder_rename: (args: { id: number; name: string }): DeckFolder => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A folder");
      const folder = folderById(db, args.id);
      if (!folder) throw refuse(FOLDER_GONE);
      folder.name = name;
      return toDeckFolder(folder);
    },

    /**
     * `deck_meta::move_folder` — re-parent a folder, or with `parentId: null` move it back to
     * the root.
     *
     * **Refuses a cycle**, by walking `parentId` upward from the *proposed* parent: if that walk
     * ever meets `id` — immediately, when `parentId` names `id` itself — it refuses rather than
     * writing a loop. Not cosmetic: `parent_id` is `ON DELETE CASCADE` on itself, so a cycle is
     * a graph SQLite's recursive cascade would walk forever the day one of them is deleted.
     */
    deck_folder_move: (args: { id: number; parentId: number | null }): DeckFolder => {
      refuseIfBusy(db);
      let cursor = args.parentId;
      while (cursor !== null) {
        if (cursor === args.id) throw refuse(FOLDER_CYCLE);
        cursor = folderById(db, cursor)?.parentId ?? null;
      }
      const folder = folderById(db, args.id);
      if (!folder) throw refuse(FOLDER_GONE);
      folder.parentId = args.parentId;
      return toDeckFolder(folder);
    },

    /**
     * `deck_meta::delete_folder`. **Its decks are not deleted** — `decks.folder_id` is
     * `ON DELETE SET NULL`, so they surface at the root, filed nowhere and otherwise exactly as
     * they were. **Sub-folders do go with it**, `parent_id` being `ON DELETE CASCADE` on itself.
     * A confirmation that said "and everything in it" would be wrong about the half that
     * matters. An id that resolves to nothing is a success.
     */
    deck_folder_delete: (args: { id: number }): void => {
      refuseIfBusy(db);
      const doomed = new Set<number>([args.id]);
      // The cascade is recursive, so it is walked to a fixed point rather than one level deep.
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of db.deckFolders) {
          if (f.parentId !== null && doomed.has(f.parentId) && !doomed.has(f.id)) {
            doomed.add(f.id);
            grew = true;
          }
        }
      }
      db.deckFolders = db.deckFolders.filter((f) => !doomed.has(f.id));
      for (const deck of db.decks) if (deck.folderId !== null && doomed.has(deck.folderId)) {
        deck.folderId = null;
      }
    },

    /**
     * `deck_theory::copy_from_live` — seed the theory list from the live one, answering how many
     * **rows** were written.
     *
     * Normally implicit (a `theoryEnabled: true` patch does this in the same write when the
     * theory list is empty) and offered separately for the reader who wants to start again from
     * what is sleeved up. It folds nothing and overwrites nothing: a theory row the reader
     * already made is their plan for that card.
     *
     * **Records exactly one history row**, kind `deck`, field `theory`, carrying the *copies* it
     * added in both the payload and `delta` — which makes it the one `deck`-kind row that can
     * move the day header's arithmetic, by up to ninety-nine. One row and not one per card: N
     * `add` rows would read as a deck somebody typed out.
     */
    deck_theory_copy_from_live: (args: { deckId: number }): number => {
      refuseIfBusy(db);
      const deck = requireDeck(db, args.deckId);
      // Measured either side of the insert rather than derived from its row count: a row is a
      // line and a copy is a card, and this app counts decks in cards everywhere else.
      const before = theoryCopies(db, deck.id);
      const rows = seedFromLive(db, deck.id);
      const copied = theoryCopies(db, deck.id) - before;
      record(db, deck.id, "theory", "deck", null, { field: "theory", copied }, copied);
      deck.updatedAt = stamp(db);
      return rows;
    },

    /**
     * `deck_theory::missing_to_wishlist` — everything the **plan** is short of, onto the
     * wishlist, answering how many wishes were touched.
     *
     * A second command rather than a variant argument on {@link deck_missing_to_wishlist},
     * because the two are different questions: that one reads `live` and only `live` — what the
     * deck as it stands is short of — while this one reads the difference between the plan and
     * the deck.
     *
     * **The wish is the diff row's quantity and nothing is subtracted from it.** Netting out
     * `ownedSpare` here counts the live list's copies twice: `quantity` is already *wanted minus
     * held*, while `ownedSpare` nets out only the claims of decks that are **built** — so an
     * unbuilt deck's own live copies read as spare, which is right for a person and wrong for a
     * subtraction. An orphan is skipped: a wish needs an oracle card, and an orphan has none.
     */
    deck_theory_missing_to_wishlist: (args: { deckId: number }): number => {
      refuseIfBusy(db);
      if (!db.decks.some((d) => d.id === args.deckId)) throw refuse(DECK_GONE);
      let touched = 0;
      // The marketplace decides no part of *which* rows are short — it only prices them — so
      // the default is enough here, where nothing reads a price.
      for (const grouped of theoryDiff(db, args.deckId, DEFAULT_MARKETPLACE)) {
        if (grouped.oracleId === null) continue;
        addWish(db, {
          oracleId: grouped.oracleId,
          name: grouped.row.name,
          quantity: grouped.row.quantity,
        });
        touched += 1;
      }
      return touched;
    },

    /**
     * `lib::sync_run`, answering the 304 path — the answer most runs get.
     *
     * Nothing here downloads anything, so a run changes nothing and says so; `updatedAt` is
     * `null` because `sync::unchanged` sets it that way, and a caller can never mistake stale
     * metadata for freshly ingested data. `force` is accepted and ignored: there is no
     * throttle to skip.
     *
     * **The one command in this table that does not honour `busy`**, because it does not take
     * the write lock — it is the thing that holds it. Under `syncError` it throws the sentence
     * `sync_status` reports, which is the only way a story reaches a failed Refresh.
     */
    sync_run: (): SyncOutcome => {
      if (db.fault === "syncError") throw refuse(SYNC_ERROR);
      return { updated: false, cardCount: db.cards.length, updatedAt: null };
    },

    /**
     * `lib::error_log_clear` — the panel's one write, answering how many rows went.
     *
     * A real write against the table rather than a stub, so a story can press Clear and see
     * the panel fall to its empty state. It honours `busy` like every other write here: the
     * command takes `AppState.db` through `lock_for`, so it is refusable, which the reading
     * side (`error_log_list`, on `db_read`) is not.
     */
    error_log_clear: (): number => {
      if (db.fault === "busy") throw refuse(BUSY);
      const gone = db.errorLog.length;
      db.errorLog = [];
      return gone;
    },

    /**
     * `marketplace::set_marketplace` — choose one, and refuse anything else.
     *
     * The refusal is what keeps `app_meta` from collecting junk: the read side falls back on an
     * id it does not know, so an unchecked write would leave a row that silently means
     * "TCGplayer" forever. `marketplace::store`'s sentence, verbatim.
     *
     * It honours `busy` like every other ordinary write here — `marketplace.rs:110` takes the
     * write connection through `db::lock_for` rather than the update commands' blocking
     * `sync::lock_db`. **The lock comes first and the id is checked inside it**, which is the
     * Rust's own order: a bad id sent while a sync holds the connection answers BUSY, because
     * nothing has looked at the id yet.
     */
    set_marketplace: (args: { id: string }): void => {
      refuseIfBusy(db);
      if (!isMarketplaceId(args.id)) {
        throw refuse(
          `"${args.id}" is not a marketplace this app knows. ` +
            `Expected one of: ${MARKETPLACE_IDS.join(", ")}.`,
        );
      }
      db.marketplace = args.id;
    },

    /**
     * `card::set_printing_group_by` — choose how the card pane groups its printings, and refuse
     * anything else.
     *
     * **The refusal is the half a fake is easiest to get wrong by leaving out**, and the one
     * this file's job description is about: the read side falls back on a mode it does not
     * know, so a fake that accepted any string would let a story save `"rarity"`, read back
     * `"artist"`, and look like it worked — the exact bug the backend's validation exists to
     * make impossible. `card::store_group_by`'s sentence, verbatim.
     *
     * It honours `busy` like every other ordinary write here — the command takes the write
     * connection through `db::lock_for`, not `sync::lock_db`. **The lock comes first and the
     * mode is checked inside it**, which is the Rust's own order and `set_marketplace`'s: a bad
     * mode sent while a sync holds the connection answers BUSY, because nothing has looked at
     * the mode yet.
     */
    set_printing_group_by: (args: { mode: string }): void => {
      refuseIfBusy(db);
      if (!isPrintingGroupBy(args.mode)) {
        throw refuse(
          `"${args.mode}" is not a way this app groups printings. ` +
            `Expected one of: ${PRINTING_GROUP_BY_MODES.join(", ")}.`,
        );
      }
      db.printingGroupBy = args.mode;
    },

    /**
     * `marketplace_feed::refresh` — download one feed and rewrite its rows.
     *
     * Three refusals, and they are three different sentences on purpose: a busy database (the
     * ordinary write lock, like every other write here), a marketplace that has no feed to
     * fetch, and the fetch itself failing.
     *
     * **The third one leaves the previous prices in place**, which is the behaviour the whole
     * fault exists to make visible: stale prices under an honest as-of line beat an empty
     * table, so nothing is deleted before the new rows are in hand and a failure writes to
     * `error_log` rather than to `marketplace_prices`.
     *
     * A success rebuilds this feed's rows from the corpus — the fake's stand-in for 63.7 MiB of
     * JSON — and stamps `marketplace_feed_meta`, which is what moves a feed from `never` to
     * `fresh` while a story watches.
     */
    marketplace_feed_refresh: (args: { marketplace: string }): MarketplaceFeedStatus => {
      refuseIfBusy(db);
      const feed = FEED_MARKETPLACES.find((m) => m.id === args.marketplace);
      if (!feed) {
        throw refuse(
          `"${args.marketplace}" has no price feed to refresh. ` +
            `Expected one of: ${FEED_MARKETPLACES.map((m) => m.id).join(", ")}.`,
        );
      }
      // The same two-frame arc `update_download` emits, and for its reason: the work here is
      // synchronous, so a story cannot watch a bar move — what these prove is that the
      // **wiring** is real, that a listener registered by `useMarketplaceProgress` hears the
      // right event name with the right payload. A story that wants to *watch* a fetch emits
      // `marketplace:progress` itself, which is also how it stands in for the refresh the
      // backend starts at app start with nobody having pressed anything.
      emitFake("marketplace:progress", {
        marketplace: feed.id,
        phase: "downloading",
        done: 0,
        total: FEED_BYTES[feed.id] ?? 0,
      });
      if (db.fault === "feedFetchError") {
        db.errorLog = [
          ...db.errorLog,
          {
            id: db.errorLog.length + 1,
            firstAt: CLOCK_BASE,
            lastAt: CLOCK_BASE,
            source: "scryfall_api",
            operation: "marketplace_feed",
            kind: "timeout",
            message: `${feed.label}'s price feed timed out after 30s`,
            detail: null,
            count: 1,
          },
        ];
        emitFake("marketplace:progress", {
          marketplace: feed.id,
          phase: "error",
          done: 0,
          total: 0,
        });
        throw refuse(
          `${feed.label}'s price feed could not be downloaded. The prices already here are ` +
            `still being shown.`,
        );
      }
      const fresh = marketplaceFeedPrices(db.cards).filter((p) => p.marketplace === feed.id);
      db.marketplacePrices = [
        ...db.marketplacePrices.filter((p) => p.marketplace !== feed.id),
        ...fresh,
      ];
      const meta = marketplaceFeedMeta(fresh, CLOCK_BASE).find((m) => m.marketplace === feed.id)!;
      db.marketplaceFeeds = [
        ...db.marketplaceFeeds.filter((f) => f.marketplace !== feed.id),
        meta,
      ];
      emitFake("marketplace:progress", {
        marketplace: feed.id,
        phase: "done",
        done: meta.rowCount,
        total: meta.rowCount,
      });
      return {
        marketplace: feed.id,
        fetchedAt: meta.fetchedAt,
        feedBuiltAt: meta.feedBuiltAt,
        rowCount: meta.rowCount,
        // It has just been fetched, and it is no longer running: the command answers the state
        // it *left* the feed in, which is the same shape `marketplace_feed_status` reads back.
        stale: isFeedStale(meta.fetchedAt, CLOCK_BASE),
        refreshing: false,
      };
    },

    /**
     * `update::check` — ask GitHub, honouring the 24 h throttle unless `force`.
     *
     * The throttle is checked **before** anything else, exactly as the real one is, and a
     * throttled run is not an error: it answers the status it already had. That is why "Check
     * now" sends `force: true` (`useUpdate.ts:133`) and why a story that wants the check to
     * find something must press that button rather than wait for the poll.
     *
     * The release is cached **whether or not it is newer**, which is `update::check`'s own
     * comment: `status` re-compares on every read, so one rule covers both directions and the
     * cache is correct across an update with no clearing step.
     *
     * Like {@link sync_run} it does not honour `busy` — `update::check` takes the write
     * connection through `sync::lock_db`, which is a *blocking* lock and not
     * `db::lock_for`'s bounded one, so a check waits for a sync rather than being refused by
     * it.
     */
    update_check: (args: { force: boolean }): UpdateStatus => {
      const last = db.update.lastCheckAt === null ? null : Number(db.update.lastCheckAt);
      if (!shouldCheck(last, CLOCK_BASE, args.force)) return toUpdateStatus(db);
      if (db.fault === "updateError") throw refuse(UPDATE_RATE_LIMITED);
      db.update.lastCheckAt = String(CLOCK_BASE);
      db.update.latestSeen = db.update.remote;
      return toUpdateStatus(db);
    },

    /**
     * `update::download` — fetch the asset, verify it against the release's checksum, and
     * stage it. **Changes nothing about the running app**: it answers with the window still
     * open and one more file on disk, and installing is a separate, deliberate call.
     *
     * The two refusals in front are the real ones and they are different questions: there is
     * no update at all, or there is one and this install kind has no asset on it (an MSI or a
     * Linux build, which `pick_asset` answers `None` for). An absent checksum is a failure
     * rather than a pass in the app, and {@link CHECKSUM_FAILED} is what the `updateError`
     * fault raises here.
     *
     * **The two `update:progress` events bracket a download that takes no time**, which is
     * the one thing this cannot show. The real one emits every 256 KB while bytes arrive;
     * this handler is synchronous, so by the time `useUpdate`'s promise settles it has already
     * cleared `progress` — the bar is on screen for no frame at all. It is emitted anyway
     * because the event is half the command's contract, and the bar itself is storied where it
     * is an argument (`Settings/UpdatePanel`'s `Downloading`).
     */
    update_download: (): UpdateStatus => {
      const current = toUpdateStatus(db);
      const release = current.available;
      if (release === null) throw refuse(NO_UPDATE);
      if (current.asset === null) throw refuse(noDownloadFor(release.version));
      const size = current.asset.size;
      emitFake("update:progress", { done: 0, total: size });
      if (db.fault === "updateError") {
        const want = (current.asset.digest ?? "").replace(/^sha256:/, "");
        throw refuse(checksumFailed(want, WRONG_DIGEST));
      }
      emitFake("update:progress", { done: size, total: size });
      db.update.staged = { version: release.version };
      return toUpdateStatus(db);
    },

    /**
     * `update::apply` — swap the staged build in and leave.
     *
     * Nothing observable happens here, and that is faithful: the real command answers and the
     * window closes 200 ms later, so the only outcome a UI ever sees is the refusal below.
     * The staged build is left in place rather than cleared, because the process that would
     * have cleared it is the one that no longer exists.
     */
    update_apply: (): void => {
      if (db.update.staged === null) throw refuse(NOTHING_STAGED);
    },

    /** `lib::update_open_release_page`. A no-op for {@link prefetch_images}' reason: it hands
     *  a URL to the OS opener, and there is no browser here to answer it. */
    update_open_release_page: (): void => undefined,
  } satisfies Record<string, CommandHandler>;
}

/**
 * Reads ∪ writes: the whole command table, which is what a story registers.
 *
 * Both halves close over the one `db`, so a write is visible to the next read — the property
 * that makes a story clickable rather than a snapshot.
 */
export function allHandlers(db: FakeDb) {
  return { ...readHandlers(db), ...writeHandlers(db) };
}
