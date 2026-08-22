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
 * 11. **The import's fold arm reads the whole fixture, where `import::fold_match` reads
 *    200 FTS candidates.** `cards_fts` exists to stop that arm scanning 116 k rows; over 43
 *    it is the scan that is cheap and the index that would be the fiction. Everything the cap
 *    decides — which candidates survive a truncation, and in what order — is therefore
 *    unreachable here, and a story must never be *about* it. What the arm still does exactly
 *    is the judging: {@link foldName}'s table is transcribed character for character and
 *    {@link foldRank} keeps a whole name ahead of a front face, which is the half that decides
 *    which printing a name lands on.
 *
 * Deliberately *not* on that list: `everUncommon`, `gameChanger`, `power`/`toughness`,
 * `priceUsd` and `isPaper` are **read off their columns**. They are facts the generator took
 * from the full 116 k-row corpus, and re-deriving any of them over a 43-row fixture would
 * answer a question about the fixture while looking like an answer about the card.
 * `gameChanger` is the one most tempting to re-derive — a list of names is short enough to
 * type — and a hand-typed list is exactly how a fake starts disagreeing with the Commander
 * Format Panel's.
 *
 * Nothing here is `async`: these are synchronous functions, and the fake `invoke` in
 * `core.ts` is what makes a command a promise. That keeps `db.test.ts` free of `await` on
 * assertions that are really about arithmetic.
 */
import { CARDS, type FakeCard } from "./cards";
import type { CommandHandler } from "./core";
import { emitFake } from "./event";
import { CURRENT_VERSION, NEXT_VERSION, release, releaseHistory } from "./fixtures";
import {
  DEFAULT_PRINTING_GROUP_BY,
  PRINTING_GROUP_BY_OPTIONS,
  isPrintingGroupBy,
} from "@/features/card/printings";
import { MAX_ZOOM, MIN_ZOOM } from "@/lib/cardZoom";
import { DEFAULT_GROUP_BY } from "@/features/decks/grouping";
import { DEFAULT_SORT_BY } from "@/features/decks/sorting";
import { SPECS } from "@/features/decks/validation/fixtures";
// The app's own list of the four sizes the cache stores, borrowed rather than re-spelled for
// `hasVariableCost`'s reason below: `card_image_uri` refuses a variant that is not one of them,
// and a second hand-typed list here would let the workbench and the window disagree about which
// four exist. Under Storybook this specifier is aliased to `.storybook/fake/images.ts`, which
// re-exports it from the real module unchanged — so both programs read the same tuple.
import { IMAGE_VARIANTS } from "@/lib/images";
import type {
  CardDetail,
  CacheCleared,
  CardFace,
  CardFilters,
  CardSummary,
  CardTags,
  CategoryKind,
  CategoryOrigin,
  CollectionCleared,
  CollectionImportItem,
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
  DeckFinish,
  DeckFolder,
  DeckGame,
  DeckInput,
  DeckPatch,
  DeckRow,
  DecksCleared,
  DeckTag,
  DeckVariant,
  DeckViewState,
  EntryChange,
  EntryInput,
  EntryPatch,
  FacetResponse,
  FinishPrices,
  ImportCommitOutcome,
  ImportItem,
  ImportMatch,
  ImportMode,
  ImportOutcome,
  ImportResolveLine,
  ImportResolveRow,
  InstallKind,
  MarketplaceFeedStatus,
  MeldRelation,
  MutedTag,
  OracleTagStatus,
  Printing,
  PrintingTags,
  ReleaseInfo,
  ReleaseNote,
  SearchRequest,
  SearchSortKey,
  SetSummary,
  SwapResult,
  SyncOutcome,
  SyncStatus,
  TagHit,
  TagNamespace,
  TagRef,
  TagStatus,
  GlobalTag,
  TheoryDiffRow,
  TransferImportMode,
  UpdateAsset,
  UpdateStatus,
  WishInput,
  WishRow,
  WishlistImportItem,
  WishlistQuery,
  WishlistSortKey,
} from "@/lib/ipc";
// The app's own `{X}` test, borrowed rather than re-spelled: the fake answers what Rust
// answers, and a second reading of "does this cost name X" would let the workbench and the
// window disagree about which cards are X while both looked right.
import { parseFinishes } from "@/lib/finish";
import { hasVariableCost } from "@/lib/mana";
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
  /** Which platform the deck is for, schema v18. **Optional here and `"any"` on the way out**,
   *  the shape {@link separateXGroup} and {@link defaultCategoryId} already use: the column is
   *  `NOT NULL DEFAULT 'any'`, so a seed row that says nothing is a deck nobody asked. */
  gameKey?: DeckGame;
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
   *  written, because the editor's Theory/Live control *is* this boolean — a switch the app
   *  can set and never see is a switch nothing can draw. */
  theoryEnabled: boolean;
  /**
   * What the reader was last looking at in this deck's editor: which tab, grouped how, sorted
   * how. Written by {@link writeHandlers.deck_set_view_state} and by nothing else, so that
   * opening a deck again puts them back where they left it.
   *
   * **Two of the three are `string` and not a narrowed union, deliberately, and the split is
   * about whose vocabulary each one is.** `lastVariant` is `DeckVariant` because `live`/`theory`
   * is the crate's own word list: none of the three columns carries a CHECK — `ALTER TABLE ADD
   * COLUMN` cannot add one — so Rust fences that one in words instead. The other two name
   * vocabularies that belong to TypeScript (`GroupBy` in `features/decks/grouping.ts`, `SortBy`
   * in `features/decks/sorting.ts`), and the column carries whatever it was handed: a database
   * outlives the build that wrote it, so a word a newer version chose has to survive the trip
   * rather than be refused. `asGroupBy`/`asSortBy` degrade an unknown one to the default at the
   * *reader*, which is the only place that can know what this build can draw — the opposite of
   * `printing_group_by`, whose write refuses a mode it does not know, and for the same reason
   * read the other way: that setting's vocabulary is the backend's.
   */
  lastVariant: DeckVariant;
  lastGroupBy: string;
  lastSortBy: string;
  /**
   * `decks.separate_x_group` (schema v13): whether this deck's curve gathers the `{X}` spells
   * under a heading of their own instead of counting each at the mana value Scryfall gives it.
   *
   * A **reading** preference and nothing more — `grouping.ts`'s `separateX` argument, which is
   * inert outside the `manaValue` grouping and reaches no rule. Nothing in `validation/` has
   * heard of it. Not one of the three fields above either: those are how the deck was last
   * *looked at* and are written by `deck_set_view_state`, while this one is an answer about the
   * deck's own curve and rides the ordinary `deck_update`.
   *
   * **Optional here alone**, where every other column of this row is required, and the reason is
   * the column's `NOT NULL DEFAULT 0`: a seed written before this existed is a deck the DDL
   * default answers for, not a deck missing an answer. {@link toDeckRow} is where that stops —
   * it resolves the absence to `false`, so no DTO this file hands out can carry an `undefined`
   * the app would have to think about.
   */
  separateXGroup?: boolean;
  /**
   * `decks.default_category_id` (schema v16): which of this deck's categories an add that names
   * no pile lands in, and `AUTO_CATEGORY` (`0`) for "by what the card does".
   *
   * **Optional for {@link separateXGroup}'s reason** — `NOT NULL DEFAULT 0`, so a seed that says
   * nothing is a deck on Auto rather than a deck missing an answer — and resolved in
   * {@link toDeckRow} the same way.
   *
   * **The fake owes the crate's two clean-up sites, because no foreign key does them here
   * either**: `deck_category_delete` puts a deck filing by the deleted pile back to `0`, and
   * `deck_duplicate` remaps this onto the copy's own categories. Neither is optional polish — a
   * fake that skipped them would story the editor against a state the app cannot reach.
   */
  defaultCategoryId?: number;
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
 * One row of `deck_undo`: how to put one deck write back, and whether it has been.
 *
 * **The crate stores a JSON step of four restore primitives; this stores the deck itself,
 * twice.** That is a deliberate simplification and not a shortcut around a rule: a step's whole
 * job is "make the deck look like this again", the crate expresses it as ops because SQL has no
 * other way to, and here the rows are JavaScript objects that can simply be copied. A second
 * transcription of `Op::Cards`/`Categories`/`Tags`/`Deck` would be a second implementation of
 * the reversal to keep in step with the first, which is exactly the drift the fake exists under
 * `ipc.ts` to avoid rather than to add.
 *
 * What it therefore does **not** model: the id remap (a restored pile keeps its id here because
 * nothing reassigns one), and the scope narrowing (the crate touches only the cells the write
 * was about, this replaces the deck). Neither is visible from a story — both are about not
 * disturbing rows the press never touched, and here nothing else is touching them.
 */
export interface FakeDeckUndo {
  /** The history row this reverses — **the last one the press wrote**, so a `deck_update` that
   *  changed two fields is two rows and one Ctrl+Z. */
  auditId: number;
  deckId: number;
  /** The deck before the write, and after it. */
  before: FakeDeckState;
  after: FakeDeckState;
  /** `null` while the change is still applied. **Persisted**, like the column — so undo carries
   *  on where it stopped. The *redo* stack is the webview's and dies with the window. */
  undoneAt: number | null;
}

/** Everything about one deck a step puts back. */
export interface FakeDeckState {
  deck: FakeDeck;
  cards: FakeDeckCard[];
  categories: FakeDeckCategory[];
  tags: FakeDeckTag[];
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
  /**
   * `deck_categories.origin` (schema v15) — **who made this row**, and a column rather than a
   * conclusion for the same reason `kind` is one: the name is the user's.
   *
   * Written by exactly three sites in this file, mirroring the three in `deck_meta.rs`:
   * {@link categoryForName} (the add and import paths' find-or-create) writes `"auto"`,
   * {@link ensurePredefinedCategories} and `deck_category_create` write `"user"`. Nothing else
   * may set it and no command takes it as a parameter — it is never supplied by a caller, which
   * is why neither the crate nor this fake validates it.
   *
   * **`categoryForName` finds before it creates**, so a pile the reader made keeps `"user"`
   * forever even once the app starts filing cards into it. That is the case a rule matching
   * `AUTO_CATEGORY_NAMES` gets wrong, and it is what this column exists to get right.
   */
  origin: CategoryOrigin;
}

/** One row of `deck_tags`: an **app-wide** label, at most one per card row. It carried a
 *  `deckId` until schema v21 and does not any more — a tag belongs to no deck, and what a deck
 *  has is cards that wear one. `color` is `#rrggbb`, or one of the six legacy tokens; the
 *  backend stores what it is handed and `tagColors.ts` decides what it draws as. */
export interface FakeDeckTag {
  id: number;
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
  /**
   * Which object this row plays — `deck_cards.finish`, schema v18. `null` is the regular copy,
   * and `"nonfoil"` is never stored: the crate normalises it away at the command boundary and a
   * CHECK makes any other path an error, because two spellings would be two rows on the grain
   * that draw identically.
   *
   * **It is part of the grain**, so {@link sameDeckSlot} matches on it and a pile can hold this
   * printing twice.
   */
  finish: DeckFinish;
  needsReview: string | null;
}

/**
 * What the updater knows, which is **three `app_meta` rows and one piece of process state** —
 * plus the one thing the app cannot see, which is what GitHub would answer.
 *
 * `update.rs` keeps `update_last_check_at`, `update_latest_seen` and
 * `update_release_history` in `app_meta` (the release cached **whether or not** it is newer,
 * so that `status` can re-compare it against the running build on every read and the notice
 * clears itself after an update lands), and `Updater::staged`/`Updater::kind` in memory.
 * Every field of `UpdateStatus` is derived from those by {@link toUpdateStatus} — nothing
 * here stores an `available`, an `asset` or a `staged` boolean, for the reason this file's
 * header gives about `ownedQuantity`.
 */
export interface FakeUpdate {
  /** `Updater::kind`. Decides which asset a download would pick, and whether there is one. */
  installKind: InstallKind;
  /** `app_meta.update_last_check_at`, unix seconds as text. `null` = never checked, which is
   *  the only thing that tells "nothing newer" from "haven't looked". */
  lastCheckAt: string | null;
  /** `app_meta.update_latest_seen` — the release the last check saw, newer or not. */
  latestSeen: ReleaseInfo | null;
  /**
   * `app_meta.update_release_history` — every release that check's one page carried.
   *
   * Written by the same check that writes `latestSeen`, which is the whole design: one
   * request to `/repos/…/releases` answers both "is there an update" and "what changed
   * before now", so expanding the version history costs nothing out of GitHub's 60 an hour.
   * `[]` is what an install that has never checked has, and the panel says so.
   */
  history: ReleaseNote[];
  /** **Not a row the app has**: the release `api.github.com` would answer the next check
   *  with. It is the other end of the wire, and it is what makes `update_check` do
   *  something a story can watch. */
  remote: ReleaseInfo | null;
  /** **Not a row either** — the page `/releases` would answer, which is what a check copies
   *  into {@link FakeUpdate.history}. */
  remoteHistory: ReleaseNote[];
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
 * not-greyed has to mean "we do not know". (`manaX` is the one count that is not a map and so
 * has no empty to answer with; it reads 0, and `ready` is what stops that being read as a
 * verdict.) The fake has no warm-up of its own, so this fault is the only way a story can stand
 * in that state.
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
 *
 * **`oracleTagsMissing` is not a failure either**, and it is the pair's important half: it is
 * the taxonomy having never been ingested, which is what every install is on its first launch
 * and what the app is permanently in if Scryfall Tagger is unreachable. `oracle_tags_status`
 * **resolves** — every field `null`, `stale: true` — and both tag reads answer an empty slug
 * list for every id, so a deck screen files by card type. It empties the *rows* rather than
 * changing how a handler answers ({@link errorLogSeed}'s shape, inverted), which is what lets a
 * story press Refresh in the first-launch state and watch the piles regroup.
 *
 * **`oracleTagsFetchError`** is the other end of that wire, and `feedFetchError` one dataset
 * over: `oracle_tags_refresh` refuses, **the taxonomy already ingested stays exactly where it
 * was**, and the reason goes to `error_log`. Nothing about categorising a card may fail a deck
 * add, so this is a refusal a story has to be able to show *without* the screen behind it
 * changing at all.
 *
 * **`artTagsMissing` and `artTagsFetchError`** are that same pair over the *other* taxonomy, and
 * they are two faults rather than a reuse of the oracle two because the datasets are two files
 * on two schedules: either may be absent, or failing, while the other is fine, and the Tags page
 * has to be able to stand in each of those four worlds. `artTagsMissing` is **not a failure** —
 * it is the art taxonomy having never been ingested, which is what every install is on its first
 * launch and what a machine that cannot reach Scryfall stays in permanently. `art_tags_status`
 * **resolves** (every field `null`, `stale: true`), `tag_search` and `tag_children` answer
 * nothing for `art` while still answering for `oracle`, and a card wall filtered by an art tag
 * comes back empty rather than refusing. That is the honest floor and it is what the page says
 * it has nothing yet *for*. `artTagsFetchError` is the wire failing: `art_tags_refresh` refuses,
 * **the taxonomy already ingested stays exactly where it was**, and the reason goes to
 * `error_log`.
 *
 * **`imageUrisMissing`** is `oracleTagsMissing`'s shape one column over, and it is not a failure
 * either: every `cards.image_uris` is NULL, so {@link readHandlers.card_image_uri} answers `null`
 * for every printing at every size and the card menu's "Copy card image" copies nothing. It is
 * the one way a story can show that press doing the honest thing — a clipboard left holding the
 * *previous* card's URL is what `cardMenu.tsx` refuses to produce.
 *
 * **It is a branch in the handler where `oracleTagsMissing` empties rows, and the reason is
 * ownership rather than taste**: `seeds.ts` shares `cards` **by reference** between worlds
 * (safe precisely because no write in this fake touches that table), so nulling the two URL
 * columns would null them for every other story on the page. The taxonomy has no such
 * constraint — `oracle_tag_cards` is built per seed.
 *
 * **`exportWriteError`** is the disk at the other end of a save dialog: `export_write_file`
 * refuses, in `export.rs`' own words. The reader picked a path the process cannot write —
 * a read-only stick, a directory that has since gone — and **the dialog stays open with the
 * text still in it**, which is the whole of what that refusal has to show: an export the app
 * could not save is one the reader can still copy.
 *
 * **`syncing`** is a card update in flight, and it exists for exactly one command:
 * `cache_clear` refuses outright while one is running, because `data/tmp/` is where the corpus
 * download puts 77 MB that the ingest then reads back. It is **not** `busy` — that fault is the
 * write connection being held, and this refusal is checked before the connection is ever asked
 * for, so the two produce different sentences from different places. Nothing else here reads
 * it: a sync's *other* effects on a story are already `busy`'s.
 */
export type Fault =
  | "busy"
  | "syncing"
  | "syncError"
  | "imageFailures"
  | "gone"
  | "indexCold"
  | "deckMeta"
  | "updateAvailable"
  | "updateError"
  | "errorLog"
  | "feedFetchError"
  | "oracleTagsMissing"
  | "oracleTagsFetchError"
  | "artTagsMissing"
  | "artTagsFetchError"
  | "imageUrisMissing"
  | "exportWriteError";

/**
 * What the picture cache costs, as the Settings page's one button sees it.
 *
 * Bytes are the filesystem's, not a per-file average: a story that reports "freed 314 MB" has
 * to be able to be given that number rather than derive it from a count.
 */
export interface FakeImageCache {
  files: number;
  bytes: number;
  rows: number;
}

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
  /** `deck_undo` — one step per deck write, keyed to the history row it reverses. */
  deckUndo: FakeDeckUndo[];
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
   * `image_cache` and the two disposable directories beside it, as one number each.
   *
   * **The only entry here that stands for files rather than rows**, and the shape is the
   * concession: this fake has no filesystem, so `data/images/` and `data/tmp/` are a count and
   * a total size instead of 5 540 paths. What that buys is the property every other table here
   * has — `cache_clear` *writes* to it, so a story can press the button, watch the panel report
   * what it freed, and press it again to see the nothing-to-do state. A canned response could
   * do neither.
   *
   * `rows` is separate from `files` because the backend reports them separately, and the two
   * genuinely differ: a picture fetched while the write connection was held is bytes on disk
   * with no row vouching for them yet.
   */
  imageCache: FakeImageCache;
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
   * `app_meta.last_deck_format` — the format the last **created** deck carried, so the next
   * "New deck" dialog opens on the format this reader actually makes decks in.
   *
   * The third row of the same key/value table, a **stored string** and `null` for the row not
   * being there, for {@link FakeDb.marketplace}'s reason a third time: a reader who has never
   * made a deck has never written it, and a key written by a different build may name a format
   * this one has never heard of. Unlike its two neighbours, *neither* case is narrowed on the
   * way out — see {@link readHandlers.deck_last_format}.
   *
   * **Written by `deck_create` and by nothing else**, which is why no setter sits beside
   * `set_marketplace` and `set_printing_group_by`: this row is a side effect of making a deck
   * rather than a preference anybody chooses. Re-formatting an existing deck does not move it
   * and neither does a duplicate — the memory is of what was *created*. A seeded world
   * therefore answers `null` however many decks it holds: those decks were seeded, not created
   * through the command.
   */
  lastDeckFormat: string | null;
  /**
   * `app_meta.card_zoom` — how large each wall of cards was last left drawn, as section name →
   * multiplier.
   *
   * The fourth row of the same key/value table and the only one whose value is an *object*, which
   * is why it is `Record<string, number>` rather than `Record<ZoomSection, number>`: the keys are
   * whatever some build of this app wrote, and both states a narrowed field could not reach are
   * ones a story wants — a section this build has never drawn, and a multiplier outside the
   * ladder. `{}` rather than `null` for "nothing stored", because there is no single default to
   * fall back on here: seven walls have each been zoomed or not, and an absent key *is* the
   * answer for one nobody has touched.
   *
   * **The reads drop what they cannot use and the write refuses it**, `set_marketplace`'s split
   * one more time — see {@link readHandlers.card_zoom} and {@link writeHandlers.set_card_zoom}.
   */
  cardZoom: Record<string, number>;
  /**
   * `app_meta.nav_collapsed` — whether the reader has collapsed the global navigation sidebar
   * down to its icons.
   *
   * **A plain `boolean`, and the only one of these five rows that is not nullable** — which is
   * the whole of what is worth knowing about this field, because the shape is an argument
   * rather than a shortcut. Its four neighbours are `string | null` (or `{}`) because each has
   * two states a narrowed field could not reach: the row has never been written, and the row
   * holds a word *this* build cannot place. This one has neither. `nav_collapsed` is infallible
   * at the far end: a missing row, a junk row, a row a newer build wrote something else into —
   * every one of them answers `false`, and the reader gets the expanded shell. So there is no
   * "never set" for a story to stand in that is distinguishable from "set to the default", and
   * a `boolean | null` here would be a third state the backend cannot produce, which is exactly
   * the kind of fiction {@link FakeDb.marketplace}'s nullability exists to *avoid* rather than
   * an instance of it.
   *
   * The consequence for the pair of handlers is the same one, said twice: the read cannot fall
   * back because there is nothing to fall back from, and the write cannot refuse a value
   * because a `boolean` off the IPC boundary has no junk state — see
   * {@link readHandlers.nav_collapsed} and {@link writeHandlers.set_nav_collapsed}.
   */
  navCollapsed: boolean;
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
  /**
   * `oracle_tag_cards` — Scryfall Tagger's answer to "what does this card *do*", already
   * flattened. Empty is the honest state of an install that has never fetched the taxonomy, and
   * the one that puts every deck add on the type-line fallback.
   */
  oracleTags: FakeOracleTagCard[];
  /** `oracle_tags` — the taxonomy itself, which the closure above only names. Filled and
   *  emptied with the other two, because one ingest writes all three. */
  oracleTagTaxonomy: FakeTagRow[];
  /** `oracle_tag_parents` — one row per parent edge. */
  oracleTagParents: FakeTagEdge[];
  /** `oracle_tag_meta`, or `null` for never ingested — **the three are set together**. A
   *  watermark with no closure behind it is the one state the backend goes out of its way to
   *  never write (it is what makes the next check 304 past an empty taxonomy). */
  oracleTagMeta: FakeTagMeta | null;
  /**
   * `art_tag_illustrations` — the **art** closure, keyed on `illustration_id`.
   *
   * {@link FakeDb.oracleTags}' twin over the other taxonomy, and the key is the whole
   * difference: an art tag is a fact about a *picture*, so it belongs to the printings carrying
   * that art and to no others. A card printed with five illustrations has five, and the dog is
   * in one of them.
   */
  artTags: FakeArtTagIllustration[];
  /** `art_tags` — the art taxonomy itself. */
  artTagTaxonomy: FakeTagRow[];
  /** `art_tag_parents`. **43 % of real art tags have more than one parent** (4 970 of 11 531,
   *  measured 2026-08-20), so this is a graph and not a tree. */
  artTagParents: FakeTagEdge[];
  /** `art_tag_meta`, or `null` for never ingested. Set with the three tables above it. */
  artTagMeta: FakeTagMeta | null;
  /**
   * `muted_tags` — the tags the reader has switched off.
   *
   * **A user table**, and the only one in this group: everything else here is rebuilt on a
   * schedule and this is the reader's answer rather than Scryfall's. So it survives a card sync
   * and a taxonomy rebuild, it is on neither swap list, and — like {@link FakeDb.deckUndo} — it
   * is never seeded and always earned, because muting is a press a story makes rather than a
   * shape a fixture is in.
   */
  mutedTags: FakeMutedTag[];
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
 * One row of `oracle_tag_cards` — **the flattened closure**, not a card's own tags.
 *
 * `oracle_tags::ancestor_closures` expands the hierarchy once at ingest, so a card tagged
 * `removal-creature` gets a row for `removal` as well and every read is a plain lookup. Storing
 * the closure rather than the raw taggings is what makes this a row store of the *shipped*
 * table: a fixture that stored the leaf tags and expanded on read would be answering with an
 * expansion nobody had checked.
 *
 * Keyed on `oracle_id` and **not** on a printing: a tag is a fact about the oracle text, so all
 * four Lightning Bolts carry the same slugs. `oracle_tags_for_printings` reaches this table
 * through `cards`, which is the whole reason that second command exists.
 */
export interface FakeOracleTagCard {
  oracleId: string;
  slug: string;
}

/**
 * One row of `art_tag_illustrations` — the **art closure**, {@link FakeOracleTagCard}'s twin
 * with two differences that both matter.
 *
 * **It is keyed on `illustration_id`, not on an oracle id.** An art tag is a fact about a
 * picture rather than about a card, so it belongs to the printings carrying that art and to no
 * others: the four Lightning Bolts in this fixture have four different illustrations and a tag
 * on one of them reaches exactly one printing, where an *oracle* tag on Lightning Bolt reaches
 * all four. Ancestral Recall is the other half of the same rule — `lea` and `2ed` share
 * illustration `d20eda7b…`, so one row here would reach both printings.
 *
 * **It carries a `weight`**, which the oracle closure has no column for. Art taggings use
 * Scryfall's full scale (median 462 008, strong 5 980, weak 4 495, very_strong 2 680, measured
 * 2026-08-20) where oracle taggings are 99.74 % `median`, so a weight means something here and
 * nothing there. The stored value is the **folded** one — `tags::write_closure` resolves a
 * closure row to the strongest tagging it descends from, so a card weak under one slug and
 * strong under a sibling is strong under their shared parent. See {@link artTagIllustrations},
 * which does that fold rather than leaving it to be typed in.
 */
export interface FakeArtTagIllustration {
  illustrationId: string;
  slug: string;
  /** One of {@link WEIGHTS}. `NOT NULL` on the real column — there is no unweighted art row. */
  weight: string;
}

/**
 * One row of `art_tags` or of `oracle_tags` — a tag itself, rather than something wearing it.
 *
 * One interface for two tables because the two tables have one shape, which is also why
 * `tags::Dataset` exists in the crate: every read over a taxonomy is written once and pointed
 * at whichever one was asked for. Which array a row is in is what its namespace is; there is no
 * namespace column, here or in SQLite.
 */
export interface FakeTagRow {
  slug: string;
  /**
   * Scryfall's stable uuid, and the only key a mute may use. Not Scryfall's actual ids here —
   * see {@link tagId} — but uuid-*shaped*, because the column is opaque to everything that reads
   * it and a short invented string would let a mirror get away with treating it as a name.
   */
  id: string;
  label: string;
  description: string | null;
  /** `tags::normalize(slug)`, written by the ingest and compared against by the search. **The
   *  one function does both** — see {@link normalizeTag}. */
  slugNorm: string;
}

/** One row of `art_tag_parents` or `oracle_tag_parents`: one edge of the taxonomy graph. A tag
 *  with several parents has several rows, and is listed under every one of them. */
export interface FakeTagEdge {
  childSlug: string;
  parentSlug: string;
}

/**
 * One row of `muted_tags` — a tag the reader has switched off.
 *
 * **Keyed on `(namespace, tagId)` and never on the slug.** Scryfall's docs: "Do not treat tag
 * slugs or labels as permanent identifiers." A mute keyed on a slug un-mutes itself the week
 * Tagger renames the tag, which is exactly the week it mattered. `slug` is stored anyway, for
 * one reason only: Settings has to be able to name a muted tag without joining a taxonomy that
 * may have been rebuilt, or emptied, since the mute was made.
 */
export interface FakeMutedTag {
  namespace: string;
  tagId: string;
  slug: string;
  /** Unix seconds. */
  mutedAt: number;
}

/**
 * `oracle_tag_meta` or `art_tag_meta`, a taxonomy's watermark. **`null` on the store means never
 * ingested**, which is a real state and not an error — the app files by card type until the
 * first oracle refresh lands and says the Tags page has nothing yet until the first art one, and
 * every field of `TagStatus` is nullable for exactly that.
 *
 * One interface for both tables because Rust has one struct for both, and a second hand-copied
 * mirror of it is the drift nothing would catch.
 */
export interface FakeTagMeta {
  /** Scryfall's own stamp for the file these rows came from. */
  updatedAt: string | null;
  /** Unix seconds. */
  ingestedAt: number;
  /** Unix seconds, and **separate**: a 304 moves this one and leaves `ingestedAt` alone.
   *  Collapsing them would make an up-to-date taxonomy read as due on every launch. */
  checkedAt: number;
  /** How many tags the *file* held, and how many taggings — the real figures, not this
   *  fixture's. See {@link oracleTagMeta}. */
  tagCount: number;
  taggingCount: number;
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
 * `zoom::is_storable` — the bound the card-zoom row is kept inside.
 *
 * `MIN_ZOOM` and `MAX_ZOOM` are imported rather than re-typed, for `PRINTING_GROUP_BY_MODES`'
 * reason above: the ends are the ladder's, the Rust holds a copy of them, and a third copy here
 * would be the one nothing checks. **The stops themselves are not consulted and must not be** — the
 * backend bounds the number and leaves the ladder to the frontend, so a value between the ends
 * but off the ladder is stored here exactly as it is stored there, and reaches `snapZoom` on the
 * way back out.
 */
function isStorableZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM;
}

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
    // Never seeded, always earned: a step exists only where a *write* made one, so a story's
    // Undo button is about the edit that story made rather than about a fixture.
    deckUndo: [],
    update: defaultUpdate(),
    // Empty here, and filled by the `errorLog` **fault** rather than by any seed: "what has
    // failed" is a state of the world, not a shape of collection, so every seed can be in
    // either state. `installWorld` is where a fault is applied, so that is where it is filled.
    errorLog: [],
    // A cache with something in it, unlike `errorLog` beside it: every install that has drawn a
    // card wall has pictures on disk, so "nothing cached" is the *unusual* state and a story
    // that wants it passes zeroes. 5 540 files / 314 MB is the dev machine's real cache,
    // measured 2026-08-20 — a made-up round number would make the panel's formatting untested
    // at the sizes it actually renders.
    imageCache: { files: 5_540, bytes: 329_682_302, rows: 5_540 },
    // The row a fresh install has never written. `get_marketplace` answers the default for it,
    // which is what every story that says nothing about prices is standing in.
    marketplace: null,
    // The same, one row over: `printing_group_by` answers `artist` for a card pane nobody has
    // told, which is the grouping every story that says nothing about it is standing in.
    printingGroupBy: null,
    // The third row, and the only one of the three no command sets on purpose: `deck_create`
    // writes it, so a world whose decks were seeded rather than created has never written it —
    // which is the state the dialog's own Commander default stands in for.
    lastDeckFormat: null,
    // The fourth row, empty: every wall opens at `DEFAULT_ZOOM`, which is what every story that
    // says nothing about zoom is standing in. A story that wants a restored session passes the
    // sections it cares about and leaves the rest out — an absent key is a wall nobody has zoomed.
    cardZoom: {},
    // The fifth row, and the only one whose default is a *value* rather than an absence: a
    // shell nobody has collapsed. `false` is what the backend answers for the row never having
    // been written and for its holding something unreadable alike, so there is no third state
    // for `null` to stand in — see {@link FakeDb.navCollapsed}. Every story that says nothing
    // about the sidebar is standing in the expanded shell.
    navCollapsed: false,
    // Empty here and filled by a seed, exactly as the card corpus is: a downloaded feed is a
    // table with rows in it, and "no rows" is the honest state of an install that has never
    // chosen Card Kingdom. `starterSeed` fills both from the corpus.
    marketplacePrices: [],
    marketplaceFeeds: [],
    // **The honest "no taxonomy" state, and the default on purpose.** A database that has never
    // ingested answers every field of `OracleTagStatus` null with `stale: true`, which is the
    // shape a first launch is in and the one that exercises the type-line fallback. `starter`
    // fills both from {@link oracleTagCards}, exactly as it fills the price feeds — so the seed
    // a deck story gets shows real piles, and every other seed shows what the app does without
    // one.
    oracleTags: [],
    oracleTagTaxonomy: [],
    oracleTagParents: [],
    oracleTagMeta: null,
    // The art taxonomy's four tables, empty for the same reason and one dataset over — with one
    // difference worth naming: an install with no *oracle* tags still files decks, by card type,
    // while an install with no *art* tags has a Tags page with nothing on it at all. That is the
    // honest floor rather than a broken screen, and it is the state every seed but `starter` is
    // in.
    artTags: [],
    artTagTaxonomy: [],
    artTagParents: [],
    artTagMeta: null,
    // Never seeded, always earned — {@link FakeDb.deckUndo}'s rule: a mute exists only where a
    // story pressed the control, so a Settings list showing one is about that press.
    mutedTags: [],
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
 * `printing_price_by_finish_expr(marketplace)` — a deck card's, a category total's and a theory
 * row's figure.
 *
 * A deck names a printing and not a finish, so there is no finish to price at and the row is
 * quoted in whichever one the marketplace sells it in. **It used to read `$.usd`/`$.eur` flat, on
 * the reasoning that "no finish" means nonfoil — and 13 515 foil-only printings have no nonfoil
 * price at any marketplace**, so every one of them drew an em dash in a deck while the search
 * wall beside it quoted the same printing.
 *
 * {@link finishPriceAt} once per finish rather than {@link priceColumnAt}'s column, which is the
 * composition `sorting.rs` uses: each marketplace's own holes then travel with it, so Cardmarket
 * keeps the `eur_etched` one it has always had and an etched-only printing stays unpriced there.
 */
function deckPriceAt(db: FakeDb, card: FakeCard | null, mp: MarketplaceId): number | null {
  return (
    finishPriceAt(db, card, "nonfoil", mp) ??
    finishPriceAt(db, card, "foil", mp) ??
    finishPriceAt(db, card, "etched", mp)
  );
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

/**
 * `tags::{oracle,art}::REFRESH_INTERVAL_SECS` — **a week**, not the card sync's day and not the
 * price feeds' either. Both taxonomies are hand-curated and move in increments, so a deck's
 * categories should not regroup between two sessions on the same afternoon and neither should
 * an art theme somebody is building a deck around.
 *
 * One constant for both because the crate's two are the same number for the same reason. They
 * are still two *files* on two schedules — see {@link FakeDb.artTagMeta} — and it is only the
 * interval they share.
 */
const TAG_REFRESH_INTERVAL_SECS = 7 * 86_400;

/** `tags::is_stale`, over **`checked_at`**: a 304 means the rows are current, so asking
 *  again because they were *built* a week ago would spend an API call to learn nothing. Never
 *  checked is stale by definition, and a stamp in the future counts as stale rather than
 *  underflowing. */
function isTaxonomyStale(checkedAt: number | null, now: number): boolean {
  if (checkedAt === null) return true;
  return checkedAt > now || now - checkedAt >= TAG_REFRESH_INTERVAL_SECS;
}

/**
 * What the Oracle Tags file weighs — ~5.85 MB compressed, the figure `scryfall.md` records.
 *
 * Here so a `downloading` event carries a real denominator: the ribbon prints whole megabytes,
 * so a story stands in `0 / 6 MB` and that is the figure the app will actually show.
 */
const ORACLE_TAG_BYTES = 5_850_000;

/**
 * The tags each card in the fixture holds, **by name**, already closed over their ancestors.
 *
 * By name and not by oracle id because a table of 37 UUIDs is a table nobody can check, and
 * checking it is the entire value: these are the slugs a deck story's piles are built out of,
 * so one that is wrong teaches a reader a rule the app does not have. `cards.ts` is generated
 * wholesale, so the names are resolved against it at build time and a name it no longer carries
 * contributes nothing — `db.test.ts` fails on one rather than letting the taxonomy quietly
 * shrink.
 *
 * **Every list carries the ancestors as well as the leaf**, because that is what
 * `oracle_tags::ancestor_closures` writes: `removal-creature` never appears without `removal`,
 * and `mass-recursion` never without `recursion`. A rule reading only the leaf would work here
 * and fail on the shipped table.
 *
 * **Five cards are deliberately untagged** — both basic lands, Delver of Secrets, Tarmogoyf and
 * Little Girl — so every `starter` deck holds cards on both sides of the fallback at once. An
 * empty slug list is an answer and not a miss, and it is the answer the type line has to cover.
 *
 * The one anchor slug the corpus cannot reach is `sacrifice-outlet`: no card in these 43
 * printings is one, and tagging one that is not would be worse than the hole.
 */
const ORACLE_TAGGINGS: readonly (readonly [string, readonly string[]])[] = [
  ["Lightning Bolt", ["burn", "damage", "removal", "removal-creature", "spot-removal"]],
  ["Black Lotus", ["fast-mana", "mana-producer", "ramp", "ritual"]],
  ["Ancestral Recall", ["card-advantage", "draw", "draw-multiple"]],
  ["Urza's Saga", ["mana-producer", "repeatable-token-generator", "token-generator", "tutor"]],
  ["Ancient Tomb", ["mana-producer", "ramp"]],
  ["Fire // Ice", ["burn", "card-advantage", "damage", "draw", "removal", "removal-creature"]],
  ["Bonecrusher Giant // Stomp", ["burn", "damage", "removal", "removal-creature"]],
  ["Agadeem's Awakening // Agadeem, the Undercrypt", ["mass-recursion", "recursion"]],
  ["Bruna, the Fading Light", ["recursion"]],
  ["Prismatic Ending // Prismatic Ending", ["exile", "removal", "removal-permanent"]],
  ["Smuggler's Copter", ["card-advantage", "card-selection"]],
  // Five modes, five piles: the card a categoriser's priority order is decided by.
  ["Kenrith, the Returned King", ["card-advantage", "draw", "lifegain", "ramp", "recursion"]],
  ["Tymna the Weaver", ["card-advantage", "draw"]],
  ["Thrasios, Triton Hero", ["card-advantage", "mana-producer", "ramp"]],
  ["Lurrus of the Dream-Den", ["recursion"]],
  ["Rhystic Study", ["card-advantage", "draw", "hate", "tax"]],
  ["Dismember", ["removal", "removal-creature", "spot-removal"]],
  ["Boros Reckoner", ["damage"]],
  ["Boros Charm", ["burn", "damage", "protection", "removal"]],
  ["Kozilek, Compleated", ["card-advantage", "draw"]],
  ["Emrakul, the Aeons Torn", ["protection"]],
  ["Avacyn, Angel of Hope", ["anthem", "protection"]],
  ["Elesh Norn, Grand Cenobite", ["anthem", "hate", "mass-removal", "removal"]],
  ["Consecrated Sphinx", ["card-advantage", "draw"]],
  ["Sol Ring", ["mana-producer", "ramp"]],
  ["Counterspell", ["counterspell"]],
  ["Restart Sequence", ["recursion"]],
  ["Swords to Plowshares", ["exile", "lifegain", "removal", "removal-creature", "spot-removal"]],
  ["Llanowar Elves", ["mana-producer", "ramp"]],
  ["Jace, the Mind Sculptor", ["card-advantage", "card-selection", "mill", "removal"]],
  ["Ragavan, Nimble Pilferer", ["repeatable-token-generator", "treasure"]],
  ["A-Vivi Ornitier", ["burn", "damage", "mana-producer"]],
];

/** The names above, for a test that wants to prove every one of them still resolves. */
export const ORACLE_TAGGED_NAMES: readonly string[] = ORACLE_TAGGINGS.map(([name]) => name);

/**
 * `oracle_tag_cards` for a corpus: one row per (oracle id, slug), sorted as the table's own
 * `ORDER BY oracle_id, slug` answers.
 *
 * **Keyed by oracle card, so all four Lightning Bolts get one set of rows between them** —
 * which is what makes `oracle_tags_for_printings` a join rather than a lookup, and what a
 * fixture keyed by printing would have hidden. Derived from the corpus for
 * {@link marketplaceFeedPrices}' reason: `cards.ts` is generated, so a hand-written oracle id
 * here would be a UUID nothing regenerates.
 */
export function oracleTagCards(cards: readonly FakeCard[]): FakeOracleTagCard[] {
  const bySlug = new Map(ORACLE_TAGGINGS.map(([name, slugs]) => [name, slugs]));
  const rows: FakeOracleTagCard[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const slugs = bySlug.get(card.name);
    if (!slugs || seen.has(card.oracleId)) continue;
    seen.add(card.oracleId);
    for (const slug of slugs) rows.push({ oracleId: card.oracleId, slug });
  }
  return rows.sort((a, b) => cmp(a.oracleId, b.oracleId) || cmp(a.slug, b.slug));
}

/**
 * `oracle_tag_meta` for an ingest that has just landed.
 *
 * **`tagCount` and `taggingCount` are the real file's figures and not this fixture's**, which
 * is the one place here a number is not derived — and it is the honest one. They describe the
 * taxonomy Scryfall published (4 521 tags over 229 633 taggings, measured by `oracle_tags.rs`),
 * and these 37 rows are a slice of the corpus it applies to, not a smaller taxonomy. A settings
 * line reading "32 tags" would be describing the fixture while looking like it described the
 * app.
 */
export function oracleTagMeta(at: number): FakeTagMeta {
  return {
    // Scryfall's own stamp for the bulk file, in its own format — the string `OracleTagStatus`
    // carries verbatim and nothing parses.
    updatedAt: "2026-08-11T09:04:16.113+00:00",
    ingestedAt: at,
    checkedAt: at,
    tagCount: 4_521,
    taggingCount: 229_633,
  };
}

/* ------------------------------------------------------------------ the taxonomies ---- */

/**
 * `tags::WEIGHTS`, **weakest first** — Scryfall's four, with their own definitions:
 * `weak` "the subject is a minor detail or background element", `median` "a normal tagging",
 * `strong` "a primary focus", `very_strong` "exemplary".
 *
 * The order is the whole of what this array is for: {@link stronger} indexes into it, and
 * `art_weight_floor` is a **floor** over it rather than a selection — the predicate is
 * `weight <> 'weak'`, so it drops the first entry and admits the other three. Nothing built on
 * it may be labelled "strong matches only": `median` is 462 008 of 475 163 art taggings
 * (measured 2026-08-20), so what the floor excludes is background detail.
 */
export const WEIGHTS = ["weak", "median", "strong", "very_strong"] as const;

/** `tags::ART_WEIGHT_FLOOR_STRONG` — the one `artWeightFloor` value that turns the floor on.
 *  Anything else, `"any"` included, is no floor at all. */
const ART_WEIGHT_FLOOR_STRONG = "strong";

/**
 * `tags::stronger` — the fold {@link artTagIllustrations} resolves a closure row with.
 *
 * An unknown weight sorts **below** `weak` rather than throwing, which is the Rust's own
 * behaviour and the safe direction: a fifth weight Scryfall adds must not be able to make a row
 * disappear from a floored query before this file has heard of it.
 */
function stronger(a: string, b: string): string {
  return WEIGHTS.indexOf(b as (typeof WEIGHTS)[number]) >
    WEIGHTS.indexOf(a as (typeof WEIGHTS)[number])
    ? b
    : a;
}

/**
 * `tags::normalize` — lowercase, and every non-alphanumeric character dropped.
 *
 * **One copy, deliberately**, exactly as the crate has one. The ingest writes it into
 * `slug_norm` ({@link tagRows}) and the search compares a typed needle against that column
 * ({@link readHandlers.tag_search}); if the two ever normalised differently the search would
 * match nothing and no test would fail, because each half would still be self-consistent.
 *
 * Verified live 2026-08-20: `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and
 * `otag:SPOT-REMOVAL` all return exactly 4 907 cards.
 */
function normalizeTag(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * A stable stand-in for Scryfall's tag uuid.
 *
 * **Not Scryfall's**, and it could not be: the real ids belong to the bulk files and this
 * fixture has never downloaded one. What matters about the column is what it is *used* for —
 * `muted_tags` is keyed on it, because slugs and labels are explicitly not permanent
 * identifiers — so the requirement is that it be opaque, stable across a rebuild, and unique
 * within its namespace. It is uuid-shaped so nothing downstream can get away with rendering it,
 * and the two namespaces take different leading digits so a mute filed under the wrong one is
 * visible in a fixture rather than merely wrong.
 *
 * `""` is deliberately unreachable here even though it is a real value in the app — see
 * {@link writeHandlers.tag_mute}, which refuses one. A blank id in a *shared seed* would put an
 * unmutable tag in front of every story on the page; the refusal is exercised from `db.test.ts`
 * against a store built to hold one.
 */
function tagId(namespace: string, index: number): string {
  const family = namespace === "art" ? "a71a" : "07ac";
  return `${family}0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/**
 * A tag's display label, derived from its slug: hyphens to spaces, each word capitalised.
 *
 * **Derived rather than transcribed, and that is a simplification worth naming.** Scryfall
 * publishes a `label` of its own and this fixture has no copy of it, so `removal-creature`
 * reads "Removal Creature" here where the file may well say "Creature Removal". What a story
 * about the Tags page is ever about is the *shape* of a label — that it is title-case prose
 * rather than a slug, that it wraps, that it is what the list sorts by — and a hand-typed table
 * of 40 labels would be 40 more strings to drift from a taxonomy nothing here downloads.
 */
function tagLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => (word === "" ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/** `art_tags` / `oracle_tags` rows for a list of `[slug, description]` pairs, in slug order —
 *  the tables' own key order. Ids follow the **declaration** order rather than the sort, so
 *  adding a tag in the middle of the list does not renumber the ones after it. */
function tagRows(
  namespace: string,
  tags: readonly (readonly [string, string | null])[],
): FakeTagRow[] {
  return tags
    .map(([slug, description], i) => ({
      slug,
      id: tagId(namespace, i + 1),
      label: tagLabel(slug),
      description,
      slugNorm: normalizeTag(slug),
    }))
    .sort((a, b) => cmp(a.slug, b.slug));
}

/**
 * The **art** taxonomy this fixture holds: thirteen tags over four roots.
 *
 * **Every one of them is true of the picture it is put on.** That is the same standard
 * {@link ORACLE_TAGGINGS} is written to and it costs the same thing — the motifs are the ones
 * these 43 illustrations actually carry, so there is no `dog` here and no `hound` under it,
 * because nobody in this corpus is a dog. The crate's own fixture
 * (`tags::query::tests`) is where that branch lives; a wall of cats filed under "Dog" would
 * teach a reader that the page's whole subject — *what the art depicts* — is decorative.
 *
 * The descriptions are this file's, not Scryfall's, for {@link tagLabel}'s reason. Oracle tags
 * get `null` instead, so both states reach the UI: **most tags have no description**, and a
 * panel that only ever renders one would be untested at the shape it usually gets.
 *
 * Declaration order decides the ids and nothing else; the rows come out in slug order.
 */
const ART_TAG_DESCRIPTIONS: readonly (readonly [string, string | null])[] = [
  ["creature", "A living subject of any kind — the root every creature motif hangs under."],
  ["animal", "A creature that is not a person: beasts, birds, vermin."],
  ["cat", "A cat, of any size."],
  ["monkey", "A monkey or an ape."],
  ["angel", "A winged humanoid drawn as an angel."],
  ["elf", "An elf."],
  ["sphinx", "A sphinx."],
  ["plant", "Growing things — trees, flowers, undergrowth."],
  ["flower", "A flower, in bloom."],
  ["landscape", "The setting itself, rather than anything standing in it."],
  ["forest", "Woodland. Both a landscape and a stand of plants, and filed under each."],
  ["water", "Open water: sea, lake, river."],
  ["lightning", "A bolt of lightning."],
];

/**
 * `art_tag_parents` — the edges of the art graph.
 *
 * **`forest` has two parents on purpose.** A forest really is a landscape *and* a stand of
 * plants, and 43 % of Scryfall's art tags sit under more than one heading (4 970 of 11 531,
 * measured 2026-08-20) — so a rail, a breadcrumb or a closure walk that followed the first
 * parent and stopped would be wrong for two tags in five, and this fixture has to be able to
 * catch that.
 */
const ART_TAG_EDGES: readonly FakeTagEdge[] = [
  { childSlug: "animal", parentSlug: "creature" },
  { childSlug: "cat", parentSlug: "animal" },
  { childSlug: "monkey", parentSlug: "animal" },
  { childSlug: "angel", parentSlug: "creature" },
  { childSlug: "elf", parentSlug: "creature" },
  { childSlug: "sphinx", parentSlug: "creature" },
  { childSlug: "flower", parentSlug: "plant" },
  { childSlug: "forest", parentSlug: "plant" },
  { childSlug: "forest", parentSlug: "landscape" },
  { childSlug: "water", parentSlug: "landscape" },
];

/**
 * The **direct** art taggings: which printing's illustration carries which tag, and how
 * strongly.
 *
 * By `(name, setCode)` rather than by illustration id, for {@link ORACLE_TAGGINGS}' reason one
 * column over: `cards.ts` is generated, so a table of 10 UUIDs would be a table nobody can
 * check, and checking it is the entire value. A pair this corpus no longer holds contributes
 * nothing and `db.test.ts` fails on it rather than letting the taxonomy quietly shrink.
 *
 * **Direct taggings, not the closure** — the opposite of {@link ORACLE_TAGGINGS}, which is
 * written out already closed. The reason is the weight: `art_tag_illustrations.weight` is the
 * *folded* strongest, and a hand-typed closure would be a hand-typed fold — the one rule a story
 * about the weight control is actually standing on. {@link artTagIllustrations} does the walk and
 * the fold, and `db.test.ts` pins what comes out.
 *
 * What each row is here to make reachable:
 *
 * * **Lightning Bolt `lea` and nothing else.** Four Bolts, four illustrations, one oracle id —
 *   so `lightning` answers one printing where the *oracle* tag `burn` answers all four. That is
 *   the whole of "an art tag is a fact about a picture", and it is only visible with the other
 *   three left untagged.
 * * **Lurrus, Ragavan and Forest carry only a leaf.** Nothing is tagged `animal`, `creature` or
 *   `plant` directly, so those three answer cards *only* through the closure — the same shape as
 *   the real `removal`, which has zero direct taggings and reaches 6 686 cards.
 * * **Llanowar Elves' `forest` is `weak`.** The elf is the subject and the wood behind her is
 *   the background element Scryfall's definition of `weak` names — so an art query for
 *   `landscape` answers three illustrations, and the same query with the floor on answers two.
 *   Without a `weak` row anywhere the control would be a switch a story could not photograph.
 * * **Island `lea` is tagged twice, `water` strong and `landscape` median.** Two true taggings
 *   at two weights whose closure rows collide on `landscape`, which is the fold: the row comes
 *   out `strong`, not `median` and not the last one written. A single-tagging fixture passes a
 *   last-write-wins fold by luck.
 * * **Both Black Lotus printings, at different weights.** Two illustrations of one card, so the
 *   art taxonomy reaches both — the mirror image of the Lightning Bolt row above.
 *
 * Ancestral Recall is the case deliberately left empty: `lea` and `2ed` share illustration
 * `d20eda7b…`, so one row here would reach two printings. `db.test.ts` covers that join against
 * a store built for it rather than by inventing a motif for a picture nobody checked.
 */
const ART_TAGGINGS: readonly (readonly [
  string,
  string,
  readonly (readonly [string, string])[],
])[] = [
  ["Lightning Bolt", "lea", [["lightning", "median"]]],
  ["Black Lotus", "lea", [["flower", "very_strong"]]],
  ["Black Lotus", "vma", [["flower", "strong"]]],
  ["Forest", "unf", [["forest", "median"]]],
  [
    "Island",
    "lea",
    [
      ["water", "strong"],
      ["landscape", "median"],
    ],
  ],
  ["Bruna, the Fading Light", "emn", [["angel", "median"]]],
  ["Avacyn, Angel of Hope", "avr", [["angel", "strong"]]],
  ["Consecrated Sphinx", "mp2", [["sphinx", "median"]]],
  ["Lurrus of the Dream-Den", "iko", [["cat", "median"]]],
  ["Ragavan, Nimble Pilferer", "mh2", [["monkey", "median"]]],
  [
    "Llanowar Elves",
    "dom",
    [
      ["elf", "median"],
      ["forest", "weak"],
    ],
  ],
];

/** The `"name setCode"` keys above, for a test that wants to prove every one of them still
 *  resolves against the generated corpus — {@link ORACLE_TAGGED_NAMES}, one taxonomy over, and
 *  with the set code because four Lightning Bolts share a name and only one carries the tag. */
export const ART_TAGGED_PRINTINGS: readonly string[] = ART_TAGGINGS.map(
  ([name, setCode]) => `${name} ${setCode}`,
);

/**
 * `oracle_tag_parents` — the edges {@link ORACLE_TAGGINGS}' already-closed lists imply.
 *
 * Every one of them is *checked* rather than asserted: that fixture writes each card's ancestors
 * out beside its leaves, so an edge here is a claim that no card in it carries the child without
 * the parent, and `db.test.ts` walks every tagged card to hold this table to it. **Two edges the
 * names beg for are absent because the corpus refuses them** — `repeatable-token-generator` to
 * `token-generator` (Ragavan carries the first without the second) and `ramp` to `mana-producer`
 * (Kenrith ramps by putting lands onto the battlefield). Both were written, and both failed that
 * test rather than shipping as a hierarchy the taxonomy does not have.
 */
const ORACLE_TAG_EDGES: readonly FakeTagEdge[] = [
  { childSlug: "removal-creature", parentSlug: "removal" },
  { childSlug: "removal-permanent", parentSlug: "removal" },
  { childSlug: "mass-removal", parentSlug: "removal" },
  { childSlug: "spot-removal", parentSlug: "removal" },
  { childSlug: "mass-recursion", parentSlug: "recursion" },
  { childSlug: "draw-multiple", parentSlug: "draw" },
  { childSlug: "draw", parentSlug: "card-advantage" },
  { childSlug: "card-selection", parentSlug: "card-advantage" },
  // `ramp` is deliberately **not** a child of `mana-producer`, and the temptation is real:
  // five of the six cards carrying it carry both. Kenrith is the sixth — it ramps by putting
  // lands onto the battlefield rather than by tapping for mana — so the edge does not hold and
  // the test below is what said so.
  { childSlug: "fast-mana", parentSlug: "ramp" },
  { childSlug: "burn", parentSlug: "damage" },
  { childSlug: "tax", parentSlug: "hate" },
];

/** Every parent of `slug`, and every parent of those, following **all** edges rather than the
 *  first — `tags::ancestor_closures`. Depth-capped rather than cycle-checked for the reason
 *  `folderPath` is: a fixture cannot make a cycle, and a walk that hangs on one would hang
 *  Storybook rather than fail a test. */
function ancestorsOf(slug: string, edges: readonly FakeTagEdge[]): string[] {
  const found = new Set<string>();
  let frontier = [slug];
  for (let depth = 0; depth < 16 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const child of frontier) {
      for (const edge of edges) {
        if (edge.childSlug === child && !found.has(edge.parentSlug)) {
          found.add(edge.parentSlug);
          next.push(edge.parentSlug);
        }
      }
    }
    frontier = next;
  }
  return [...found];
}

/** `art_tags` for this fixture, in slug order. */
export function artTagRows(): FakeTagRow[] {
  return tagRows("art", ART_TAG_DESCRIPTIONS);
}

/** `art_tag_parents` for this fixture. A copy per call, because it lands on a mutable store. */
export function artTagEdges(): FakeTagEdge[] {
  return ART_TAG_EDGES.map((e) => ({ ...e }));
}

/**
 * `oracle_tags` for this fixture: **every distinct slug {@link ORACLE_TAGGINGS} names**, in slug
 * order, with no description.
 *
 * Derived rather than listed for one reason: a hand-written tag table could name a tag no card
 * carries, and a search that offered one would answer a wall of nothing. Derived, every tag in
 * the box reaches at least one card — which is a property of the real table too, since the
 * ingest writes tags and taggings from one file.
 */
export function oracleTagRows(): FakeTagRow[] {
  const slugs = new Set<string>();
  for (const [, tagSlugs] of ORACLE_TAGGINGS) for (const slug of tagSlugs) slugs.add(slug);
  return tagRows(
    "oracle",
    [...slugs].sort(cmp).map((slug) => [slug, null] as const),
  );
}

/** `oracle_tag_parents` for this fixture. */
export function oracleTagEdges(): FakeTagEdge[] {
  return ORACLE_TAG_EDGES.map((e) => ({ ...e }));
}

/**
 * `art_tag_illustrations` for a corpus — {@link ART_TAGGINGS} walked up the graph and folded,
 * which is what `tags::ancestor_closures` and `tags::write_closure` do between them.
 *
 * **Keyed on the illustration, so a printing that shares an art shares the tags** and one that
 * does not gets none of them. A `(name, setCode)` pair the corpus does not hold, or a printing
 * with no `illustration_id` (three of the 43 have none — Delver of Secrets, Agadeem's Awakening
 * and Prismatic Ending), contributes nothing rather than throwing: `cards.ts` is generated, and
 * a regenerated corpus that dropped a printing should shrink the taxonomy and fail a test, not
 * break every story on the page.
 *
 * **The weight is folded to the strongest tagging the row descends from**, never the last one
 * written. That is the rule a card weak under one slug and strong under a sibling rests on: it
 * is genuinely a strong match for their shared parent, and a per-tagging weight would put the
 * same card in one view of one hierarchy and out of the other.
 *
 * Sorted `(illustration_id, slug)`, which is the closure table's own `WITHOUT ROWID` key order.
 */
export function artTagIllustrations(cards: readonly FakeCard[]): FakeArtTagIllustration[] {
  const byPrinting = new Map(
    ART_TAGGINGS.map(([name, setCode, taggings]) => [`${name} ${setCode}`, taggings]),
  );
  /** `illustrationId` → `slug` → the strongest weight seen for it so far. */
  const folded = new Map<string, Map<string, string>>();
  for (const card of cards) {
    const taggings = byPrinting.get(`${card.name} ${card.setCode}`);
    if (!taggings || card.illustrationId === null) continue;
    let rows = folded.get(card.illustrationId);
    if (!rows) {
      rows = new Map<string, string>();
      folded.set(card.illustrationId, rows);
    }
    for (const [slug, weight] of taggings) {
      for (const reached of [slug, ...ancestorsOf(slug, ART_TAG_EDGES)]) {
        const held = rows.get(reached);
        rows.set(reached, held === undefined ? weight : stronger(held, weight));
      }
    }
  }
  const out: FakeArtTagIllustration[] = [];
  for (const [illustrationId, rows] of folded) {
    for (const [slug, weight] of rows) out.push({ illustrationId, slug, weight });
  }
  return out.sort((a, b) => cmp(a.illustrationId, b.illustrationId) || cmp(a.slug, b.slug));
}

/**
 * `art_tag_meta` for an ingest that has just landed.
 *
 * `tagCount` and `taggingCount` are **the real file's** figures, measured by `tags::art` on
 * 2026-08-20 — 11 531 tags over 475 163 taggings, which flatten into 951 499 closure rows, 2.0×
 * the taggings. {@link oracleTagMeta}'s reason: a settings line reading "13 tags" would be
 * describing this fixture while looking like it described the app.
 *
 * `updatedAt` is the **one** value here that is not measured, and it is the only one that could
 * not be: it is Scryfall's own stamp for the bulk file, it changes daily, and nothing in this
 * repo has a record of the one the 2026-08-20 download carried. It is written in the format the
 * manifest publishes, on the day the rest of these numbers were taken, and nothing parses it —
 * `TagStatus.updatedAt` is carried verbatim to be rendered.
 */
export function artTagMeta(at: number): FakeTagMeta {
  return {
    updatedAt: "2026-08-20T09:12:44.207+00:00",
    ingestedAt: at,
    checkedAt: at,
    tagCount: 11_531,
    taggingCount: 475_163,
  };
}

/**
 * What the Art Tags file weighs — 12 544 874 bytes gzipped, measured 2026-08-20.
 *
 * {@link ORACLE_TAG_BYTES}' reason, and the figure is 2.1× it: a `downloading` event needs a
 * real denominator, and the ribbon prints whole megabytes, so a story stands in `0 / 12 MB` and
 * that is what the app will actually show.
 */
const ART_TAG_BYTES = 12_544_874;

/**
 * `oracle_tags::read_tags_keyed`'s first half: the ids actually asked about, **deduped, blanks
 * dropped, in the order asked**.
 *
 * The order is the contract and it is the half a fake gets wrong for free. Both commands answer
 * one entry per *distinct* id, so `result.length` can be shorter than the request — which is
 * why `ipc.ts` tells every caller to match by id and never by position, and why a fixture that
 * quietly reordered would look right in Storybook and break a decklist import that named the
 * same card twice.
 *
 * An empty request touches nothing at all: Rust prepares no statement for one, and the two
 * handlers below return before reading a row.
 */
function requestedIds(keys: readonly string[] | undefined): string[] {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const key of keys ?? []) {
    const trimmed = key.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    wanted.push(trimmed);
  }
  return wanted;
}

/** `oracle_tag_cards` grouped by its own key, slugs in the table's `ORDER BY … slug` order.
 *  Built per call over a table of tens of rows, which is the shape every read in this file
 *  takes — the real one is a prefix scan of a `WITHOUT ROWID` table and just as cheap. */
function slugsByOracleId(db: FakeDb): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of db.oracleTags) {
    const slugs = grouped.get(row.oracleId);
    if (slugs) slugs.push(row.slug);
    else grouped.set(row.oracleId, [row.slug]);
  }
  return grouped;
}

/** `tags::status_of`, over either watermark. **Total and unfailing**: a store with no row
 *  answers every field null with `stale: true` rather than refusing, which is what lets every
 *  caller read it with no guard. `refreshing` is always false here — the fake's refresh is
 *  synchronous, so nothing is ever in flight *between* two commands; a story that wants that
 *  state emits the dataset's own progress event itself. */
function toTagStatus(meta: FakeTagMeta | null): TagStatus {
  return {
    updatedAt: meta?.updatedAt ?? null,
    ingestedAt: meta?.ingestedAt ?? null,
    checkedAt: meta?.checkedAt ?? null,
    tagCount: meta?.tagCount ?? null,
    taggingCount: meta?.taggingCount ?? null,
    stale: isTaxonomyStale(meta?.checkedAt ?? null, CLOCK_BASE),
    refreshing: false,
  };
}

/* ------------------------------------------------------------------ tag reads --------- */

/**
 * One taxonomy's three tables under one name — `tags::Dataset`, which is why the crate can write
 * every tag read once and point it at whichever was asked for.
 *
 * `reach` is the closure count, and it is a function rather than a table because the two closures
 * are keyed on different columns: illustrations on one side, oracle ids on the other. What both
 * answer is "how many *subjects*", and neither answers "how many printings" — see
 * {@link readHandlers.tag_search}.
 */
interface FakeTagDataset {
  namespace: TagNamespace;
  tags: readonly FakeTagRow[];
  parents: readonly FakeTagEdge[];
  reach: (slug: string) => number;
}

/**
 * The taxonomies a caller may name, **art first**.
 *
 * `tags::query::namespaces_for`. Art leads because that is what the page is for: the reader is
 * building a deck around a motif and types `dog` meaning the picture, and the oracle taxonomy
 * rides along.
 *
 * **An unknown namespace throws rather than answering an empty list**, exactly as the crate
 * refuses it: a typo'd namespace and a taxonomy that has never been fetched would otherwise be
 * the same answer, and only one of them is a bug.
 */
function tagDatasets(db: FakeDb, namespace: string): FakeTagDataset[] {
  const art: FakeTagDataset = {
    namespace: "art",
    tags: db.artTagTaxonomy,
    parents: db.artTagParents,
    reach: (slug) => db.artTags.filter((r) => r.slug === slug).length,
  };
  const oracle: FakeTagDataset = {
    namespace: "oracle",
    tags: db.oracleTagTaxonomy,
    parents: db.oracleTagParents,
    reach: (slug) => db.oracleTags.filter((r) => r.slug === slug).length,
  };
  if (namespace === "art") return [art];
  if (namespace === "oracle") return [oracle];
  if (namespace === "both") return [art, oracle];
  throw refuse(`unknown tag namespace: ${namespace}`);
}

/**
 * Is this tag still offered? — `tags::query::not_muted`.
 *
 * **`id !== ""` prevents one mute from hiding an entire taxonomy, silently.** `oracle_tags.id`
 * is `NOT NULL DEFAULT ''` in the app, because the rung that added it used `ALTER TABLE` and
 * that cannot add a `NOT NULL` column without a default — so every row that predates a refresh
 * by a build new enough to write ids still carries `''`. Without this clause one `muted_tags`
 * row whose `tagId` happened to be empty would equal every one of those rows, and the whole
 * oracle taxonomy would leave the search box and the rail with no error raised, nothing in
 * `error_log`, and a page that simply looks like it has no data. With it, a tag whose id was
 * never written is *unmutable* — visible, wrong in a way the reader can see and report, and
 * repaired by the next refresh.
 */
function tagVisible(db: FakeDb, namespace: TagNamespace, row: FakeTagRow): boolean {
  if (row.id === "") return true;
  return !db.mutedTags.some((m) => m.namespace === namespace && m.tagId === row.id);
}

/**
 * A tag row as the page draws it, with its counts and its parents — `tags::query::hit_select`
 * plus `attach_parents`.
 *
 * `childCount` counts only children that **exist and are not muted**, so a disclosure triangle
 * drawn from it never opens onto nothing. `parents` is **every** parent rather than the first,
 * for the same reason and a bigger one: 43 % of real art tags have more than one, so a
 * single-parent breadcrumb would be wrong for two tags in five.
 */
function toTagHit(db: FakeDb, ds: FakeTagDataset, row: FakeTagRow): TagHit {
  const named = (slug: string): FakeTagRow | undefined => ds.tags.find((t) => t.slug === slug);
  const parents: TagRef[] = ds.parents
    .filter((e) => e.childSlug === row.slug)
    .map((e) => named(e.parentSlug))
    .filter((t): t is FakeTagRow => t !== undefined && tagVisible(db, ds.namespace, t))
    .map((t) => ({ slug: t.slug, label: t.label, namespace: ds.namespace }))
    .sort((a, b) => cmp(a.label, b.label) || cmp(a.slug, b.slug));
  const childCount = ds.parents.filter((e) => {
    if (e.parentSlug !== row.slug) return false;
    const child = named(e.childSlug);
    return child !== undefined && tagVisible(db, ds.namespace, child);
  }).length;
  return {
    slug: row.slug,
    id: row.id,
    label: row.label,
    namespace: ds.namespace,
    description: row.description,
    // **Over the closure, never the direct taggings** — see {@link matchesCardFilters}, which
    // reads the same two tables for the same reason.
    cardCount: ds.reach(row.slug),
    childCount,
    parents,
  };
}

/**
 * `tags::query::rank` — match quality, then reach, then **art before oracle**, then the label.
 *
 * Art wins an equal-rank tie because the page's primary job is an art theme: a reader who types
 * `dog` wants the illustrations, and the oracle tag of the same name is the secondary reading.
 * The trailing slug is only there so the order is total — two tags with the same label would
 * otherwise come back in whatever order the two passes happened to produce, and a list that
 * reshuffles between identical keystrokes looks broken.
 */
function byTagRank(a: { band: number; hit: TagHit }, b: { band: number; hit: TagHit }): number {
  return (
    a.band - b.band ||
    b.hit.cardCount - a.hit.cardCount ||
    Number(a.hit.namespace !== "art") - Number(b.hit.namespace !== "art") ||
    cmp(a.hit.label, b.hit.label) ||
    cmp(a.hit.slug, b.hit.slug)
  );
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
  db: FakeDb,
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

  // **One question, asked of two columns.** The numeric chips and the X chip are a single OR
  // group — `push_card_filters` puts `mana_cost LIKE '%{X}%'` inside the same parenthesis as
  // `cmc IN (…)` — so a row passes if it answers *either*, and the group is only asked at all
  // when something in it is on. ANDing them would make picking `1` and `X` together return the
  // cards that are both, which is the opposite of what a chip row means.
  const manaValues = f.manaValues ?? [];
  if (manaValues.length > 0 || f.manaX) {
    const cmc = card?.cmc ?? null;
    const exact = new Set(manaValues.filter((v) => v < MANA_VALUE_OPEN_ENDED));
    const openEnded = manaValues.some((v) => v >= MANA_VALUE_OPEN_ENDED);
    // `cmc` is REAL and nullable: a card with no cost matches no chip, and a fractional
    // un-card cost matches none *below* 8 (exact equality) but is returned by the open-ended
    // chip, which is `>= 8` — the same split `push_card_filters` emits.
    const numeric = cmc !== null && (exact.has(cmc) || (openEnded && cmc >= MANA_VALUE_OPEN_ENDED));
    // **The asymmetry with the line above is the point, and it is the SQL's own**: the LIKE
    // consults `mana_cost` and never `cmc`, so a row whose mana value is unknown still matches
    // the X chip when its printed cost names `{X}`. An X in the cost is knowledge; a missing
    // `cmc` is the absence of a different fact. An **orphan** is a third case and still fails —
    // it has no `mana_cost` either, and `NULL LIKE '%{X}%'` is NULL, which is not true.
    const variable = (f.manaX ?? false) && hasVariableCost(card?.manaCost ?? null);
    if (!numeric && !variable) return false;
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

  // **Both taxonomies are matched against the CLOSURE, never the direct taggings.** The bulk
  // files store direct taggings only and a category tag has none of its own — `dog` is directly
  // tagged on 137 illustrations and reaches 439, `removal` has zero direct taggings and answers
  // 6 686 cards — so a predicate over the taggings would return 31 % of the dogs and none of the
  // removal, which looks like a data problem rather than a query one. Here that is the whole of
  // it: {@link FakeDb.artTags} and {@link FakeDb.oracleTags} *are* the closures.
  //
  // **An orphan and a printing with no `illustration_id` fail every include and pass every
  // exclude**, and that is SQL's own rule rather than a choice: the real predicate correlates on
  // `c.illustration_id`, `NULL = NULL` is not true, so an `EXISTS` finds nothing and the
  // `NOT EXISTS` around the same subquery is satisfied. Three of the 52 printings here have no
  // illustration id (4 977 of 116 712 live ones do not), and there is **no `rows` fallback** the
  // way `setCode` has one — a tag is a claim only a card row can answer.
  if (f.artTags) {
    const illustrationId = card?.illustrationId ?? null;
    // `<> 'weak'` rather than a list of the three weights above it, so a fifth weight Scryfall
    // adds is kept rather than silently hidden. It reads the **closure's** folded weight — the
    // strongest tagging the row descends from — so a card weak under one slug and strong under a
    // sibling survives the floor under their shared parent, because it is genuinely a strong
    // match for the motif.
    const floored = nonblank(f.artWeightFloor) === ART_WEIGHT_FLOOR_STRONG;
    for (const slug of pickedTags(f.artTags.include)) {
      const held = db.artTags.some(
        (r) =>
          r.illustrationId === illustrationId &&
          r.slug === slug &&
          (!floored || r.weight !== WEIGHTS[0]),
      );
      if (!held) return false;
    }
    // **The exclude arm ignores the floor, deliberately**: "not a dog" means not a dog at all,
    // including weakly. A floor here would let weak dogs back into a result the reader asked to
    // have none in.
    for (const slug of pickedTags(f.artTags.exclude)) {
      if (db.artTags.some((r) => r.illustrationId === illustrationId && r.slug === slug)) {
        return false;
      }
    }
  }

  // The oracle twin, on `oracle_tag_cards` / `oracle_id` and **with no weight clause**: that
  // closure has no `weight` column, so a copied floor would be a `no such column` error in the
  // app rather than a wrong answer, and it would have nothing to say either way — oracle
  // taggings are 99.7 % `median`, with `strong` occurring once in the whole file.
  if (f.oracleTags) {
    const oracleId = card?.oracleId ?? null;
    for (const slug of pickedTags(f.oracleTags.include)) {
      if (!db.oracleTags.some((r) => r.oracleId === oracleId && r.slug === slug)) return false;
    }
    for (const slug of pickedTags(f.oracleTags.exclude)) {
      if (db.oracleTags.some((r) => r.oracleId === oracleId && r.slug === slug)) return false;
    }
  }
  return true;
}

/**
 * `filters::picked_tags` — trimmed, blanks dropped, sorted and deduplicated.
 *
 * **An empty answer means "no tag filter", never "match nothing"**, which is `filters::picked_sets`'
 * rule one filter over and the same trap: a cleared chip row sends `[]` and some send `[""]`, and
 * a blank taken literally would be a slug no tag has and an empty wall with no chip drawn to
 * explain it.
 */
function pickedTags(slugs: readonly string[] | undefined): string[] {
  return [...new Set((slugs ?? []).map((s) => s.trim()).filter((s) => s !== ""))].sort(cmp);
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
    // The column the *kind* of foil is read from, verbatim, exactly as `search.rs` selects it
    // — the naming is `@/lib/treatment`'s and no backend, real or fake, does any of it.
    promoTypes: c.promoTypes,
    // The column, read straight through and never re-derived from a list of names — an
    // **oracle**-level fact, so every printing agrees and {@link collapseToCards} inherits
    // the representative's like `rarity`, with no aggregate needed to make a group agree
    // with itself. A plain boolean, unlike `DeckCard.gameChanger`: a search row came back
    // from `cards`, so it can never be the orphan that field's `null` is for.
    gameChanger: c.gameChanger,
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
    promoTypes: c.promoTypes,
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
    promoTypes: c.promoTypes,
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
    oracleId: card?.oracleId ?? null,
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
    // From the *card*, like every other `cards`-derived field here, and `null` for an orphan.
    // The entry's own `finish` above says which copy this is; together they are what names it.
    promoTypes: card?.promoTypes ?? null,
    // Also from the card, and the fixtures carry real Scryfall blobs — so the Arena export
    // filter answers over the corpus rather than over a hand-written yes/no.
    legalities: card?.legalities ?? null,
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
    if (!matchesCardFilters(db, card, { ...q, text: undefined, paperOnly: false }, e.setCode)) {
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
    // `c.id` from the same join, which is what makes the wall drawable: a pinned wish is its
    // own printing, an any-printing wish is the newest printing of its oracle card, and only a
    // genuine orphan is `null`.
    artCardId: card?.id ?? null,
    quantity: w.quantity,
    preferredFinish: w.preferredFinish,
    unitPrice: finishPriceAt(db, card, finish, mp),
    ownedQuantity: ownedAgainstWish(db, w),
    notes: w.notes,
    needsReview: w.needsReview,
    updatedAt: w.updatedAt,
    // The joined card's, like `typeLine` and `artCardId` above — an any-printing wish carries
    // one, and only a genuine orphan is `null`.
    legalities: card?.legalities ?? null,
  };
}

function wishlistScope(db: FakeDb, q: WishlistQuery): FakeWish[] {
  const text = nonblank(q.text);
  return db.wishlistEntries.filter((w) => {
    const card = wishCard(db, w);
    if (!matchesCardFilters(db, card, { ...q, text: undefined, paperOnly: false }, w.setCode)) {
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
    // The three v12 ones that remember where the reader was. They ride the *gallery's* row
    // rather than a read of their own because the editor already has this row when it mounts —
    // a second command to ask "which tab was I on" would be a round trip between opening a deck
    // and drawing it, which is exactly the flicker the memory exists to remove.
    lastVariant: d.lastVariant,
    lastGroupBy: d.lastGroupBy,
    lastSortBy: d.lastSortBy,
    // v13's, and the one column whose absence on the row is an answer rather than a gap —
    // `NOT NULL DEFAULT 0`, so a deck that has never been asked is a deck that says no.
    separateXGroup: d.separateXGroup ?? false,
    // v16's, and the same shape of answer: absent is `AUTO_CATEGORY`, which is what the column's
    // `DEFAULT 0` says about a deck nobody has asked.
    defaultCategoryId: d.defaultCategoryId ?? 0,
    // v18's, once more the same shape. `"any"` is what `DEFAULT 'any'` says about a deck that
    // was never asked which platform it is for, and it is what makes the format picker offer
    // every format — so a seed written before this column existed behaves as it always did.
    gameKey: d.gameKey ?? "any",
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
        const unit = deckPriceAt(db, cardById(db, dc.cardId), mp);
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
    // Carried through as the row's own, never re-derived from the name: `grouping.ts` reads it
    // to decide whether an *empty* pile draws, so a DTO that guessed here would answer the one
    // question this column was added for.
    origin: c.origin,
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
function toDeckTag(db: FakeDb, t: FakeDeckTag, deckId: number, variant: DeckVariant): DeckTag {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    cardCount: db.deckCards
      .filter((dc) => dc.tagId === t.id && dc.deckId === deckId && dc.variant === variant)
      .reduce((n, dc) => n + dc.quantity, 0),
  };
}

/**
 * `deck_meta::list_all_tags`' row — one tag and how far it reaches, over every deck and both
 * variants.
 *
 * `deckCount` counts **distinct decks with a card wearing it**, not rows: `count(DISTINCT
 * dc.deck_id)` in the SQL, and the number a delete confirmation quotes. Zero for a tag nobody
 * has used yet, which is the row this list can answer and `deck_tag_list` never can.
 */
function toGlobalTag(db: FakeDb, t: FakeDeckTag): GlobalTag {
  const wearing = db.deckCards.filter((dc) => dc.tagId === t.id);
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    cardCount: wearing.reduce((n, dc) => n + dc.quantity, 0),
    deckCount: new Set(wearing.map((dc) => dc.deckId)).size,
  };
}

/**
 * `schema::tag_name_key` — what makes two tag names the same name, in the fake.
 *
 * A third copy of a rule that already exists twice (Rust's is the authority, `tagNames.ts` is
 * the webview's courtesy), and it has to be here for the fake to refuse what the backend
 * refuses: a story that types `removal` over an existing `Removal` must see the same sentence
 * the app would show. Kept to one line so the three cannot drift far.
 */
function tagKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase().normalize("NFC");
}

/** Whether some **other** tag already holds this name, by {@link tagKey}'s comparison. `except`
 *  is the row allowed to hold it — `null` for a create, the row's own id for a rename, which is
 *  what lets a reader recapitalise `removal` to `Removal`. */
function tagNameIsTaken(db: FakeDb, name: string, except: number | null): boolean {
  const key = tagKey(name);
  return db.deckTags.some((t) => t.id !== except && tagKey(t.name) === key);
}

/**
 * `deck_meta::list_tags` — the tags one deck's one list is wearing, most-used first.
 *
 * The join `deck_get` and `deck_tag_list` both answer through, written once because the two must
 * agree exactly: they describe one list of cards, and the day they stop agreeing is the day a
 * context menu offers a label the Tags dialog says the deck does not use. Ties break on the
 * name, which is the SQL's own second term.
 */
function tagsWorn(db: FakeDb, deckId: number, variant: DeckVariant): DeckTag[] {
  const worn = new Set(
    db.deckCards
      .filter((dc) => dc.deckId === deckId && dc.variant === variant && dc.tagId !== null)
      .map((dc) => dc.tagId),
  );
  return db.deckTags
    .filter((t) => worn.has(t.id))
    .map((t) => toDeckTag(db, t, deckId, variant))
    .sort((a, b) => b.cardCount - a.cardCount || cmp(a.name, b.name));
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
    finish: dc.finish,
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
    // The same LEFT JOIN, for the same reason. What a deck row *draws* pairs this with the
    // row's own `finish` — the printing says what its foil is called, the deck says which
    // copy it sleeves, and a plain copy of a Surge Foil printing is drawn plain.
    promoTypes: card?.promoTypes ?? null,
    // Printed at uncommon on **any** printing of this oracle card, which is Pauper Commander
    // eligibility. Read off the column, never recomputed over `db.cards`: the generator took
    // it from the full 116 k-row corpus, and re-deriving it would make a fact about the
    // *card* into a fact about the 43-row fixture. Delver of Secrets is the row that proves
    // it — `everUncommon: true`, and the only Delver printing here is the `isd` common, so a
    // recomputation answers `false` and a legal commander renders ineligible. `false` for an
    // orphan, because nothing is known about a card that is not there.
    everUncommon: card?.everUncommon ?? false,
    // What this printing costs at the marketplace this read named, in whichever finish it is
    // sold in: a deck names a printing and not a finish, so a foil-only one is quoted at its
    // foil rate rather than reading as unpriced. Never the `price_usd` column, which is that
    // chain precomputed for the search's sort and is the one a total must not sum.
    unitPrice: deckPriceAt(db, card, mp),
    ownedQuantity,
  };
}

/* ------------------------------------------------------------------ the three orders -- */

/**
 * `search::SEARCH_SORTS`.
 *
 * **Two of the seven have no column to press.** `manaValue` and `released` are reached from
 * the filter bar's sort picker instead — the trade the collection's `added` already made,
 * because the search table has no room for a seventh header (`SearchSortKey` in
 * `src/lib/ipc.ts` is where that room went). This used to say there was no `released` key at
 * all, and that was true of the order `search.rs` had lost: SQL nothing could reach. The one
 * added on 2026-08-20 has a control, so a story can order by it and this file has to answer.
 *
 * A `Record` over the whole union rather than the `Partial` {@link orderBy} accepts, so a key
 * added to `SearchSortKey` and forgotten here is a compile error rather than a picker row
 * that quietly answers in browse order.
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
    // `c.cmc`, which is REAL and **nullable**: a card with no printed cost has no mana value,
    // and `nullsLast` keeps those holes at the bottom in *both* directions rather than letting
    // a reversal float them to the top. Sorting the printings and grouping afterwards is exact
    // here rather than a simplification — mana value is a fact about the oracle card, so every
    // printing in a collapsed group carries the same one, which is the same argument that lets
    // `search.rs` answer this key with `min(c.cmc)` in its group step.
    manaValue: nullsLast((c) => c.cmc, numeric),
    // `c.released_at`, which is ISO `YYYY-MM-DD` — so byte order *is* date order and {@link cmp}
    // is the whole comparison, exactly as {@link SEARCH_BROWSE_ORDER} below already reads it.
    // `nullsLast` although {@link FakeCard.releasedAt} is never null: `cards.released_at` is,
    // `search.rs` spells NULLS LAST in both directions for that reason, and a `reversible` here
    // would agree with it only for as long as this fixture stayed lucky.
    released: nullsLast((c) => c.releasedAt, cmp),
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
    rows.map((w) => [w.id, finishPriceAt(db, wishCard(db, w), w.preferredFinish ?? "nonfoil", mp)]),
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
/** `card::MAX_PRINTINGS_HARD`, the ceiling an explicit page size is clamped to — the printings
 *  modal's page. Also unreachable from the fixture, and here for the same reason: the clamp is
 *  part of the answer's shape, and a fake that let a caller past it would pass a story that the
 *  window refuses. */
const MAX_PRINTINGS_HARD = 1000;
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
    // The history a check that saw `CURRENT_VERSION` would have cached: the page **without**
    // the release published since. Pressing Check now brings that one in, which is the
    // difference a story can watch.
    history: releaseHistory().filter((r) => r.version !== NEXT_VERSION),
    remote: release(NEXT_VERSION),
    remoteHistory: releaseHistory(),
    staged: null,
  };
}

/** An install that has never asked. `seeds.ts`'s `empty` world — a first run has synced
 *  nothing and checked nothing, and `lastCheckAt: null` is the only thing that says so.
 *  Its history is empty for the same reason: nothing has fetched a page to cache. */
export function neverCheckedUpdate(): FakeUpdate {
  return { ...defaultUpdate(), lastCheckAt: null, latestSeen: null, history: [] };
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
 * `import::IMPORT_MODES` — what an import may do to the variant it lands in.
 *
 * A list rather than a union type for the Rust's reason: the refusal below **quotes it**, so
 * the two spellings a caller can name and the two the sentence offers are one array. Read
 * `IMPORT_MODES[1]` by index for the same discipline `deck_audit`'s kind constants follow.
 */
const IMPORT_MODES = ["merge", "replace"] as const;
const IMPORT_REPLACE = IMPORT_MODES[1];

/** `import::NOTHING_TO_IMPORT`. It matters most in `replace`, where "do nothing" and
 *  "clear the deck and put nothing back" are the same call with the same arguments. */
const NOTHING_TO_IMPORT = "There is nothing to import.";

/**
 * What {@link readHandlers}'s `import_read_file` says instead of inventing a decklist.
 *
 * **Not a Rust sentence, and the only handler in this file that has none.** The real command
 * takes a path the OS file picker answered, and there is no picker in a browser — so a fake
 * that returned text would be a story about a gesture no reader of that story can make. The
 * dialog's file arm is the live pass's to prove; a story that wants a decklist pastes one.
 */
const NO_FILE_PICKER = "No file picker in Storybook.";

/**
 * `import::fold_name`'s table, transcribed — every character it maps and no other.
 *
 * Keyed on the **lower-case** half of each pair only, because {@link foldName} lowercases
 * before it looks anything up where the Rust lowercases in its fallthrough arm. The two agree
 * on every character in the table: `Á`.toLowerCase() is `á`, and `Æ` is `æ`.
 */
const FOLD_LETTERS: Readonly<Record<string, string>> = {
  á: "a",
  à: "a",
  â: "a",
  ä: "a",
  ã: "a",
  å: "a",
  é: "e",
  è: "e",
  ê: "e",
  ë: "e",
  í: "i",
  ì: "i",
  î: "i",
  ï: "i",
  ó: "o",
  ò: "o",
  ô: "o",
  ö: "o",
  õ: "o",
  ø: "o",
  ú: "u",
  ù: "u",
  û: "u",
  ü: "u",
  ñ: "n",
  ç: "c",
  ý: "y",
  ÿ: "y",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  "’": "'",
  ʼ: "'",
  "`": "'",
  "–": "-",
  "—": "-",
};

/**
 * `import::fold_name` — a card name reduced to what two people typing it would agree on:
 * lowercase, no diacritics, one kind of apostrophe, single spaces.
 *
 * Anything not in {@link FOLD_LETTERS} passes through, so a name in a script the table has
 * never heard of folds to itself and still matches itself exactly.
 */
export function foldName(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase()) out += FOLD_LETTERS[ch] ?? ch;
  return out
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ");
}

/**
 * `import::fold_rank` — how well a card's name folds to what the reader typed: `0` for
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
 * `import::MATCH_ORDER` — a printing you own, then the newest, then the id.
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
 * `import::MATCH_COLUMNS` as a DTO — the card half of `DECK_CARD_SELECT`, **less its
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
 * `import::fold_match` — fold both sides and compare, the arm the three exact ones fall
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

/** `import::given` — a hint the caller actually gave: trimmed, and absent when blank.
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
      /**
       * Every printing of one oracle card — "View all printings", handed over from a menu.
       *
       * **Here rather than in {@link matchesCardFilters}, and the asymmetry with Rust is the
       * TypeScript mirror's rather than this file's.** `filters::push_card_filters` carries
       * `oracle_id`, so the collection's and the wishlist's queries emit it too; `ipc.ts`
       * declares it on `SearchRequest` **and not on `CardFilters`**, so a search is the only
       * thing that can send one. Reading it through the filter helper would therefore mean
       * widening a type to hold a field no other caller may set — and it would also apply the
       * filter to `facet_cards`, which sends it deliberately *never*: the counts come from an
       * in-memory index with no oracle axis, so faceting a narrowed wall over-counts on purpose
       * (`useCardSearch.ts` states that, and over-counting only ever leaves a control live).
       *
       * `nonblank`, like every string filter beside it: `useCardSearch`'s `resetAll` clears this
       * to exactly `""`, and a blank taken literally would bind `oracle_id = ''` and match
       * nothing — an empty wall with no chip drawn to explain it, which is the direction
       * `filters.rs` names as failing closed.
       *
       * **The tag filters are the contrasting case and went the other way**: `artTags`,
       * `oracleTags` and `artWeightFloor` *are* on `CardFilters`, because the collection and the
       * wishlist can honestly be narrowed to a motif, so they live in the helper with every other
       * card claim — and `facet_cards` drops them from its own bases explicitly rather than by
       * being unable to see them. Which of the two a new filter is depends on whether a list
       * other than the search could ever mean it.
       */
      const oracleId = nonblank(req.oracleId);
      const matched = db.cards.filter((c) => {
        if (text !== null && !cardMatchesText(c, text)) return false;
        if (oracleId !== null && c.oracleId !== oracleId) return false;
        if (!matchesCardFilters(db, c, { ...req, text: undefined }, null)) return false;
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
     *
     * **The tag filters used to sit in that same position and no longer do.** The index still
     * has no tag dimension — it cannot, since a tag is a fact about an illustration or an
     * oracle card rather than about a printing — but `run_facets` resolves each picked slug
     * through its closure into a bitset, intersects those with the FTS one and hands `compute`
     * the single narrowing set it takes. So a wall narrowed to a motif is faceted over the
     * motif, and this mirror narrows with it: {@link matchesCardFilters} already reads all
     * three fields for `search_cards`, so the whole of the change was to stop stripping them
     * out of the base below. A fake that had kept counting over the whole corpus would make
     * the workbench disagree with the window about which sets a tagged search can still reach.
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
          // `0` rather than an absence, because {@link FacetResponse.manaX} is a **number** and
          // not a map: there is no empty value for a scalar to take, and Rust's own struct
          // answers a `u32`. It says the same thing the empty maps beside it do only because
          // `ready: false` is what the UI reads — a zero here is "we did not count", exactly as
          // a missing key is, and neither may grey the chip.
          manaX: 0,
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
        // `rarity` leaves because the in-memory index has no dimension for it, so `facets::base`
        // cannot narrow by one and a request carrying it is faceted as though it did not —
        // **every count reads high**. Mirrored rather than improved on, and the direction is what
        // makes that safe: over-counting leaves a control live, where under-counting would grey
        // out options that would have worked and hide cards nobody reports missing. A fake that
        // counted better than the backend would hide the divergence instead of the app showing
        // it.
        //
        // **The three tag fields stay**, since 2026-08-20: `run_facets` resolves each picked slug
        // through its closure into a bitset and ANDs it into every base, so the counts describe
        // the tag-narrowed wall. They are in **every** base including their own for the reason
        // `text` is — none of them is a facet, and there is no tag control on this row to grey.
        const f: CardFilters = { ...req, text: undefined, rarity: undefined };
        if (skip === "colors") f.colors = undefined;
        // Both halves of the chip row leave together, because they are one OR group and
        // therefore one dimension: a base that dropped the numbers and kept the X would count
        // every numeric chip against a search still narrowed to the X cards.
        if (skip === "mana") {
          f.manaValues = undefined;
          f.manaX = undefined;
        }
        if (skip === "sets") {
          f.sets = undefined;
          f.setCode = undefined;
        }
        if (skip === "formats") f.format = undefined;
        return db.cards.filter((c) => {
          // Text is in every base **including its own**: it is not a facet, and a facet
          // describes the search the reader is looking at.
          if (text !== null && !cardMatchesText(c, text)) return false;
          if (!matchesCardFilters(db, c, f, null)) return false;
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
        rows.filter((c) => matchesCardFilters(db, c, { ...f, paperOnly: false }, null)).length;

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
      // The tenth chip of the same row, counted over the **same base** as the nine above it, so
      // it greys on the same rule and at the same moment. It is deliberately *not* a key of the
      // map: the map is keyed by mana value and `"x"` is not one, and the two **overlap** — an
      // X card is counted here and again under its own `cmc`, which is what makes pressing both
      // chips return that card once rather than twice. Adding this to the map's numbers would
      // therefore double-count, which is the arithmetic a shared key invites.
      const manaX = countWith(manaBase, { manaX: true });

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
        manaX,
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

    /**
     * `card::card_meld_parts` — the other cards a `meld` printing is part of.
     *
     * **`[]` is the answer for almost every card in the game, and this handler mirrors Rust's
     * three ways of reaching it rather than improving on any of them**, which is the argument for
     * this fake living *under* `src/lib/ipc.ts`: a handler that refused an unknown id, or that
     * answered a `transform` card with something, would let a story pass over a call the window
     * answers differently. Every layout that is not `meld`, an unknown id, and a `meld` row whose
     * blob carried no `all_parts` all come back empty — a card the reader opened must not fail to
     * open because the relationship behind an orientation control could not be read. 72 of the
     * 116 590 live rows are `meld`, 48 parts and 24 results.
     *
     * The list itself is {@link FakeCard.meldParts}, read rather than derived: `cards` has no
     * `all_parts` column, Rust parses it out of the gzipped `raw` blob, and the fixture carries
     * no `raw`. So the generator does the filtering, the ordering, the by-name exclusion of the
     * row's own card and the artist lookup once, and this hands the finished array over.
     *
     * **No `marketplace`, unlike the two reads above it.** A relationship is not a price.
     */
    card_meld_parts: (args: { id: string }): MeldRelation[] => {
      const card = cardById(db, args.id);
      if (card === null || card.meldParts === null) return [];
      return JSON.parse(card.meldParts) as MeldRelation[];
    },

    /**
     * `card::list_printings`: every **paper** printing of one oracle card, newest first,
     * capped with an uncapped count so a truncated list can say what it truncates. Every row
     * is priced per finish at the marketplace asked for, like the card above.
     *
     * **`limit` is honoured here because the mirror sends it**, which is the whole argument for
     * this fake sitting *under* `src/lib/ipc.ts` rather than beside it: a handler that quietly
     * ignored an argument would let a story pass over a call the window answers differently. The
     * card detail pane sends nothing and gets {@link MAX_PRINTINGS}; the printings modal names
     * the ceiling, because it filters client-side and a filter over a truncated list draws an
     * empty wall that reads as an answer.
     *
     * Clamped exactly as `card.rs`'s `page_size` clamps: absent, zero and negative all fall back
     * to the default rather than answering with an empty page — a page of nothing here would be
     * indistinguishable from "this card has no printings". The negative case is not defensive
     * padding: SQLite reads a negative `LIMIT` as *no limit at all*, so on the real backend it is
     * the whole table rather than nothing, and the two ends must agree about which answer a
     * caller bug gets.
     */
    card_printings: (args: { oracleId: string; marketplace?: string; limit?: number }) => {
      const mp = marketplaceOf(args.marketplace);
      const page =
        args.limit !== undefined && args.limit > 0
          ? Math.min(args.limit, MAX_PRINTINGS_HARD)
          : MAX_PRINTINGS;
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
        items: all.slice(0, page).map((c) => toPrinting(db, c, mp)),
        total: all.length,
      };
    },

    /**
     * `card::card_image_uri` — the Scryfall CDN URL for one printing at one size, or `null`.
     *
     * **The variant is checked and never interpolated**, exactly as `card.rs` checks it against
     * `schema::IMAGE_VARIANTS`: there it reaches SQL as a `json_extract` path, so an unchecked
     * one is an injection point, and a fake that shrugged at `png` would let a caller sending it
     * pass the workbench and be refused by the window. {@link IMAGE_VARIANTS} is the app's own
     * tuple rather than a fifth copy of the four names.
     *
     * **All three of Rust's ways to `null` are reachable here, and every one of them is an
     * answer rather than a fault.**
     *
     * 1. *An unknown card* — a printing this corpus does not have.
     * 2. *A card whose `image_uris` is NULL* — `Prismatic Ending // Prismatic Ending` (`amh2 5s`,
     *    `imageStatus: "missing"`) is the fixture's one such row, null in both URL columns, and
     *    the `imageUrisMissing` fault is the whole corpus in that state.
     * 3. *A variant the source lacked*, which `card_row::webp_uris` writes as JSON `null` — so a
     *    present key is not a present URL. Here that is `thumb` and `grid` on **every** row, and
     *    it is a fact about the fixture rather than a branch invented to reach the case:
     *    `gen-storybook-cards.mjs` keeps two of Scryfall's image keys, `art_crop` and `normal`,
     *    so those two variants are the only ones this corpus can answer.
     *
     * The two it can answer are answered with the **real** URL off the row —
     * `display` from `normalUrl`, `art` from `artCropUrl` — never a path minted by rewriting
     * `/normal/` into `/thumb/`. `images.ts` refuses that derivation next door for the same
     * reason: it would be a URL nobody has ever fetched, handed to a reader as one to paste.
     */
    card_image_uri: (args: { cardId: string; variant: string }): string | null => {
      const variant = IMAGE_VARIANTS.find((v) => v === args.variant);
      if (variant === undefined) throw refuse(`unknown image variant: ${args.variant}`);
      // Before the lookup, because the fault is the *column* being empty on every row and not
      // an answer about one card — a story in this state gets `null` for a card it has, which
      // is the state a reader in it is actually in.
      if (db.fault === "imageUrisMissing") return null;
      const card = cardById(db, args.cardId);
      if (card === null) return null;
      if (variant === "art") return card.artCropUrl;
      if (variant === "display") return card.normalUrl;
      return null;
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
      const tags: DeckTag[] = tagsWorn(db, deck.id, variant);
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

    /**
     * `deck_meta::list_tags` — the tags **this deck's list is wearing**, most-used first.
     *
     * Membership is a join over `deck_cards` since schema v21, not a `WHERE t.deck_id`: there is
     * no deck on a tag row to filter by, and what a deck has is cards. So `variant` scopes which
     * tags are in the answer as well as their counts — the live list and the theory list are
     * treated as separate decks where labels are concerned.
     */
    deck_tag_list: (args: { deckId: number; variant: DeckVariant }): DeckTag[] => {
      const variant = validVariant(args.variant);
      refuseIfMetaUnreadable(db, TAGS_UNREADABLE);
      return tagsWorn(db, args.deckId, variant);
    },

    /**
     * `deck_meta::list_all_tags` — every tag there is, most-used first.
     *
     * The one command in the deck surface that takes no id at all, and the only list that can
     * answer a tag no card is wearing: a `LEFT JOIN`, so an unused label is a row with two
     * zeroes rather than a row that is missing.
     *
     * It replaced `deck_tag_suggestions`, which grouped on `(name, color)` and answered names
     * without ids — a shape that existed only because two decks could hold two rows spelling one
     * word, and picking a "suggestion" copied it into the deck you were in. There is one row per
     * name now, so this answers ids and picking one **uses** that very tag.
     */
    deck_tag_all: (): GlobalTag[] => {
      refuseIfMetaUnreadable(db, TAG_PALETTE_UNREADABLE);
      return db.deckTags
        .map((t) => toGlobalTag(db, t))
        .sort((a, b) => b.cardCount - a.cardCount || cmp(a.name, b.name));
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

    /**
     * `deck_theory::theory_slots` — every card the plan asks for, as `group_key` strings.
     *
     * The deck editor's theory tick. **Not the diff and not derivable from it**: a card the
     * reader has fully acquired is absent from the shopping list and is still in the plan.
     *
     * Same two exclusions {@link theoryDiff} states — inactive categories out, the pile
     * otherwise invisible — and duplicates left in, because the caller builds a set.
     */
    deck_theory_slots: (args: { deckId: number }): string[] => {
      refuseIfMetaUnreadable(db, THEORY_UNREADABLE);
      return db.deckCards
        .filter(
          (dc) =>
            dc.deckId === args.deckId &&
            dc.variant === "theory" &&
            categoryById(db, dc.categoryId)?.isActive === true,
        )
        .map((dc) => `${dc.cardId}|${dc.finish ?? ""}`);
    },

    /** `deck_theory::theory_diff` — what the plan wants and the deck does not have. See
     *  {@link theoryDiff} for the direction, the grouping and the two exclusions. */
    deck_theory_diff: (args: { deckId: number; marketplace?: string }): TheoryDiffRow[] => {
      refuseIfMetaUnreadable(db, THEORY_UNREADABLE);
      return theoryDiff(db, args.deckId, marketplaceOf(args.marketplace)).map((g) => g.row);
    },

    /**
     * `import::resolve_lines` — every name in a parsed decklist, resolved to a printing
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
    import_resolve: (args: { lines: ImportResolveLine[] }): ImportResolveRow[] => {
      // `is_paper = 1` is on every arm, so it is applied once here.
      const paper = db.cards.filter((c) => c.isPaper);
      // `c.name >= "{name} // " AND c.name < "{name} //!"`, which over a byte-wise comparison
      // is exactly "carries that prefix" — see `import::front_face_range` for the proof.
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
              bestOf(
                db,
                inSet.filter((c) => c.name === name),
              ) ??
              bestOf(
                db,
                inSet.filter((c) => c.name.startsWith(`${name} // `)),
              );
            if (number === null) hintMissed = matched === null;
          }
        } else if (number !== null) {
          hintMissed = true;
        }

        if (matched === null && name !== "") {
          matched =
            bestOf(
              db,
              paper.filter((c) => c.name === name),
            ) ??
            bestOf(db, fronts(name)) ??
            foldMatch(db, name);
        }
        // The caller's index rides along rather than being inferred: the list that was sent is
        // the only thing that knows what line 34 said.
        return { index, matched, hintMissed };
      });
    },

    /**
     * `import::read_import_file`, which **throws here and always will**.
     *
     * The real command takes a path `@tauri-apps/plugin-dialog`'s `open()` answered — a native
     * window CDP cannot drive and a browser does not have. So there is no gesture in a story
     * that reaches this, and a handler that invented a decklist would be a story about a thing
     * that cannot happen: the file arm's refusal would be the only branch anyone ever saw, and
     * it would be the wrong one. A story that wants a list pastes one, which is the same string
     * travelling the same path from one line later.
     */
    import_read_file: (): string => {
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
     * `update::status`, one of the two update commands that are **reads** — it touches
     * `app_meta` and the process's own state and makes no network call, which is why the
     * ribbon can poll it. Annotated for {@link sync_status}' reason.
     */
    update_status: (): UpdateStatus => toUpdateStatus(db),

    /**
     * `lib::update_history` — the page the last check cached, newest first. The other read.
     *
     * **Never a request of its own**, which is the design rather than a shortcut here:
     * `update_check` fetches one page of `/repos/…/releases` to decide whether an update
     * exists and stores the whole thing, so a reader expanding the version history spends
     * nothing out of GitHub's 60 requests an hour. An install that has never checked answers
     * `[]` — `neverCheckedUpdate`'s world, and the sentence the panel has for it.
     */
    update_history: (): ReleaseNote[] => db.update.history,

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
     * `deck::last_deck_format` — the format the last **created** deck carried, or `null`.
     *
     * The third `app_meta` row, and **the one that does not narrow on the way out**: the two
     * above check what they read against a list and shrug at anything else, this one hands the
     * stored key back verbatim. Not leniency — there is no list on this side to check it
     * against. The formats are `format_specs`' rows, the narrowing is TypeScript's, and a
     * default the backend picked would be a second opinion about a table the webview is already
     * reading. So the Rust does not validate here either, and a fake that did would be telling
     * stories about a check the app does not make.
     *
     * That leaves `null` and an unplaceable key meaning the same thing to the caller — open on
     * the dialog's own default — and only the caller can tell them apart. A read, so no fault
     * touches it, and there is no write beside it: {@link writeHandlers.deck_create} is the
     * only thing that fills this row.
     */
    deck_last_format: (): string | null => db.lastDeckFormat,

    /**
     * `zoom::card_zoom` — every wall's remembered size, with the unusable entries dropped.
     *
     * The fourth `app_meta` setting, and **the one where the fallback is per entry rather than
     * for the whole row**: a marketplace or a grouping this build cannot place costs the reader
     * that one setting, while a single hand-edited zoom must cost one wall its memory and leave
     * the other six intact. That is the behaviour a fake most easily gets wrong by reaching for
     * the neighbours' shape, so it is re-implemented rather than shared.
     *
     * `isStorableZoom` and nothing about the ladder: the Rust bounds the number and deliberately
     * does not know where the ten stops are, so a value between the ends but off the ladder
     * arrives here intact and is snapped on the *frontend* side by `snapZoom`. A fake that
     * snapped would hide the one thing this split exists to make visible.
     *
     * A read, so it answers through every second of a sync — the write below does not.
     */
    card_zoom: (): Record<string, number> =>
      Object.fromEntries(
        Object.entries(db.cardZoom).filter(
          ([section, zoom]) => section !== "" && isStorableZoom(zoom),
        ),
      ),

    /**
     * `nav::nav_collapsed` — whether the global navigation sidebar was left collapsed to icons.
     *
     * The fifth `app_meta` setting, and **the one with no fallback in it at all**, which is the
     * whole of how it differs from the four above. Each of those narrows on the way out because
     * the row can hold a word this build cannot place; this row holds a boolean, and the
     * command is infallible at the far end — a missing row, a junk row, an unparseable one all
     * answer `false`, so the shell that greets a reader whose `app_meta` is nonsense is the
     * expanded one. That collapse happens in the Rust, before the value ever crosses the IPC
     * boundary, which leaves this handler with nothing to decide: the stored boolean *is* the
     * answer.
     *
     * Read at launch and only at launch — the shell asks once and then owns the state, so a
     * story that presses the toggle is looking at its own React state rather than at a re-read.
     * What this read is therefore *for* is the first frame: a story seeded collapsed has to
     * open collapsed rather than opening wide and snapping shut, which is the bug a fake that
     * always answered `false` here would hide.
     *
     * A read, so it answers through a sync like every other one here — the write below does not.
     */
    nav_collapsed: (): boolean => db.navCollapsed,

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
     * `oracle_tags::status` — whether there is a taxonomy and how old it is.
     *
     * **It cannot fail, and that is the contract rather than this fake being lenient.** The
     * command reads one small table, makes no network call and is safe before the first refresh
     * has ever run: a database with no meta row answers every field `null` with `stale: true`.
     * So it honours no fault — not `busy` (it is a read), and not the two of its own: those
     * change the *rows*, which is what a status is supposed to report.
     */
    oracle_tags_status: (): OracleTagStatus => toTagStatus(db.oracleTagMeta),

    /**
     * `oracle_tags::read_printing_tags` — the read every categorising call site makes, because
     * every one of them is holding a printing id (`CardSummary` has no `oracleId` at all).
     *
     * **One entry per requested id, in request order, and `slugs: []` for anything unknown.**
     * All four ways of being unknown answer the same empty list — a card the taxonomy says
     * nothing about, an id this corpus does not have, a printing with no oracle card, and a
     * world with no taxonomy at all — because the caller's response to every one of them is the
     * same: fall back to the type line. Nothing about categorising a card may fail a deck add.
     */
    oracle_tags_for_printings: (args: { cardIds: string[] }): PrintingTags[] => {
      const wanted = requestedIds(args.cardIds);
      if (wanted.length === 0) return [];
      const byOracle = slugsByOracleId(db);
      return wanted.map((cardId) => ({
        cardId,
        slugs: byOracle.get(cardById(db, cardId)?.oracleId ?? "") ?? [],
      }));
    },

    /** `oracle_tags::read_card_tags` — the same answer reached from the other end, for a caller
     *  holding an oracle id (`DeckCard.oracleId`, a wishlist row). Same contract, same rules,
     *  and **`oracleId` rather than `cardId` on the way out**: echoing a printing id back in a
     *  field with that name would be a lie no caller could notice. */
    oracle_tags_for_cards: (args: { oracleIds: string[] }): CardTags[] => {
      const wanted = requestedIds(args.oracleIds);
      if (wanted.length === 0) return [];
      const byOracle = slugsByOracleId(db);
      return wanted.map((oracleId) => ({ oracleId, slugs: byOracle.get(oracleId) ?? [] }));
    },

    /**
     * `tags::art::art_tags_status` — {@link readHandlers.oracle_tags_status} over the other
     * taxonomy, and it cannot fail for the same reason: one small table, no network call, safe
     * before the first refresh has ever run. It honours no fault, `artTagsMissing` included —
     * that one changes the *rows*, which is what a status is supposed to report.
     */
    art_tags_status: (): TagStatus => toTagStatus(db.artTagMeta),

    /**
     * `tags::query::tag_search` — type-ahead over one taxonomy or both.
     *
     * **Substring, and the exact hit ranked first.** That is a deliberate departure from
     * Scryfall, verified live 2026-08-20: `otag:remov` 404s and `otag:*spot*` answers nothing
     * because `*` is stripped as punctuation, so there is nothing to borrow and a reader told
     * "no such tag" until they spell `dogs-of-war` exactly is not using a search box. The three
     * bands are exact, prefix, substring, and they are compared against `slugNorm` — the column
     * the ingest wrote with {@link normalizeTag} and the needle goes through the same function,
     * because two copies that must agree will not.
     *
     * **An empty or all-punctuation `text` matches everything rather than nothing**, so an
     * untouched box answers the tags with the widest reach. That is a usable starting page; an
     * empty list would make the box look broken before it had been typed in.
     *
     * **`limit` caps the *merged* answer**, and each taxonomy is asked for its own top `limit`
     * first — which is exact rather than approximate, since the global top `limit` can hold at
     * most `limit` rows from either side.
     *
     * A muted tag is absent from this, from a parent's `childCount` and from anyone's `parents`.
     * It is **not** a card filter: a visible tag's `cardCount` is still its full reach, and
     * nothing in {@link matchesCardFilters} consults the mute table. Hiding a card because one of
     * its tags was muted would be a silent loss of results.
     */
    tag_search: (args: { text: string; namespace: string; limit: number }): TagHit[] => {
      const needle = normalizeTag(args.text);
      const scored: { band: number; hit: TagHit }[] = [];
      for (const ds of tagDatasets(db, args.namespace)) {
        const own = ds.tags
          .filter((row) => row.slugNorm.includes(needle) && tagVisible(db, ds.namespace, row))
          .map((row) => ({
            band: row.slugNorm === needle ? 0 : row.slugNorm.startsWith(needle) ? 1 : 2,
            hit: toTagHit(db, ds, row),
          }))
          .sort(byTagRank)
          .slice(0, args.limit);
        scored.push(...own);
      }
      return scored.sort(byTagRank).slice(0, args.limit).map((s) => s.hit);
    },

    /**
     * `tags::query::tag_children` — one level of the tree: the children of `slug`, or the
     * **roots** when it is absent.
     *
     * A root is a tag with no parent edge at all. A tag with several parents is listed under
     * every one of them, which is the honest reading of a graph rather than a tree — picking one
     * branch to show `forest` in would hide it from the other — and its `parents` name the rest
     * so the rail can say so.
     *
     * **Unlimited, deliberately**: this draws one level of a tree (3 219 art roots in the real
     * taxonomy) and an arbitrary cut would silently lose branches.
     *
     * **A muted tag takes its subtree off the rail with it**, since its children are not roots
     * and no other path reaches them unless they have a second parent. That is the cost of muting
     * a category, it is recoverable by unmuting, and the children stay findable through
     * {@link readHandlers.tag_search}.
     *
     * `"both"` looks the **same slug** up in each taxonomy, which is right for the roots and is
     * two unrelated questions for a named parent — the two share plenty of slugs and mean
     * different things by them. A rail that has descended into one namespace should be asking
     * about that namespace.
     */
    tag_children: (args: { namespace: string; slug: string | null }): TagHit[] => {
      const scored: { band: number; hit: TagHit }[] = [];
      for (const ds of tagDatasets(db, args.namespace)) {
        for (const row of ds.tags) {
          if (!tagVisible(db, ds.namespace, row)) continue;
          const wanted =
            args.slug === null
              ? !ds.parents.some((e) => e.childSlug === row.slug)
              : ds.parents.some((e) => e.childSlug === row.slug && e.parentSlug === args.slug);
          // No band to compute: every row here is the same kind of match.
          if (wanted) scored.push({ band: 0, hit: toTagHit(db, ds, row) });
        }
      }
      return scored.sort(byTagRank).map((s) => s.hit);
    },

    /**
     * `tags::muted::list` — everything the reader has hidden, for the Settings list that gives it
     * back.
     *
     * Ordered by taxonomy then by the **stored** slug rather than by `mutedAt`, because the list
     * exists to be searched by eye for the tag to give back; `tagId` breaks the tie so the order
     * is total even after a rename has left two rows sharing a slug.
     */
    tags_muted: (): MutedTag[] =>
      [...db.mutedTags]
        .map((m) => ({
          namespace: m.namespace as TagNamespace,
          tagId: m.tagId,
          slug: m.slug,
          mutedAt: m.mutedAt,
        }))
        .sort(
          (a, b) =>
            cmp(a.namespace, b.namespace) || cmp(a.slug, b.slug) || cmp(a.tagId, b.tagId),
        ),

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

/** `reset::SYNCING`, verbatim — the one refusal `cache_clear` has. */
const CACHE_SYNCING = "a card update is running — clear the cache once it has finished";
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
/** `deck::SAME_FINISH`. */
const SAME_FINISH = "That is already this finish.";
/** `deck::FINISH_NOT_SOLD`. Read off `cards.finishes`, so it is also what a printing that has
 *  left the corpus answers — its finish list went with it. */
const FINISH_NOT_SOLD = "That printing is not sold in that finish.";
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
/** `deck_meta::TAG_GONE` and `TAG_NAME_TAKEN` — {@link CATEGORY_GONE}'s twins, one table over.
 *  There were three until schema v21; `TAG_WRONG_DECK` refused a `tagId` resolving to another
 *  deck's tag, and there is no such thing any more. */
const TAG_GONE = "That tag is not there any more.";
const TAG_NAME_TAKEN =
  "A tag with that name already exists. Pick it from the list instead of making a second one.";
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
const TAG_PALETTE_UNREADABLE = "the tag list could not be read: database is locked";
const FOLDERS_UNREADABLE = "the deck folders could not be read: database is locked";
/** `deck_audit`'s, which the same fault produces: the history is a satellite read like the
 *  three above it, and a drawer over an editor is exactly the surface that can be open while
 *  one fails. */
const HISTORY_UNREADABLE = "the deck's history could not be read: database is locked";
/** `deck_theory`'s, for the same reason: the plan's shopping list is a fifth satellite read,
 *  made from a dialog that is already open over a deck the screen read fine. */
const THEORY_UNREADABLE = "the theory list could not be read: database is locked";
/**
 * `export::write_export`'s refusal, in its own shape — `could not write {path}: {e}`, where the
 * tail is `std::io::Error`'s own words.
 *
 * A function rather than a constant because the path is half the sentence: a reader who picked a
 * folder that has since gone needs to see *which* name was refused, and that is the one thing
 * this command knows about the failure. The OS half is Windows' `Access is denied. (os error 5)`
 * — the error a read-only stick or a file another program holds open really produces, rather
 * than an invented one.
 */
const exportDenied = (path: string) => `could not write ${path}: Access is denied. (os error 5)`;
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
  record(
    db,
    deckId,
    DECK_LEVEL,
    "folder",
    null,
    { action: "move", folder: folderPath(db, folderId) },
    0,
  );
}

/**
 * `deck::category_name` — what a pile is called, for the one `deck` history row that names one.
 *
 * `null` for `AUTO_CATEGORY` (`0`) **and** for an id with no pile behind it, and the two being
 * one answer is deliberate: this is asked about the *past* — what the deck's default pile was
 * before an edit replaced it — where "there was no pile" and "the pile has since gone" read the
 * same to somebody looking at the drawer.
 */
function categoryNameOf(db: FakeDb, categoryId: number): string | null {
  if (categoryId === 0) return null;
  return categoryById(db, categoryId)?.name ?? null;
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

/**
 * `deck::NO_MODE` — the whole of what the backend checks about a remembered grouping or sort.
 *
 * The words themselves are TypeScript's vocabulary and the crate deliberately does not know
 * them ({@link FakeDeck.lastGroupBy}), but a blank is not one of them in any vocabulary: it is a
 * bug in the caller, and storing it would hand the editor back a remembered choice of nothing.
 */
function validMode(mode: string): string {
  if (mode.trim() !== "") return mode;
  throw refuse("A remembered view mode cannot be blank.");
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
 *  CHECK: it holds `#rrggbb` (a palette token, before 2026-08-20), and deciding what a colour
 *  *is* is the webview's job (`features/decks/tagColors.ts`), not the backend's. The seeds below
 *  still hold the retired token words on purpose — a database older than the build is a shape
 *  the workbench should be able to draw. */
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
 * `schema::DECK_CARD_GRAIN` — `(deck_id, variant, category_id, card_id, coalesce(finish, ''))`.
 *
 * `categoryId` is in it for the zone's old reason: the same printing filed under the main deck
 * and under the Maybeboard is two intentions, not one row that moved — only now that is read
 * off a category the user can rename. `variant` widens it again: the same printing can sit in
 * the live deck and the theory one at once. And `finish` widens it a third time (v18): the
 * regular copy and the foil are two rows, so a deck can hold `1 × Sol Ring (foil)` beside
 * `3 × Sol Ring`.
 *
 * **`===` is the whole of the `coalesce` here**, because JavaScript has one null and SQLite's
 * distinct-NULL rule is a SQL problem rather than a model one. The crate needs the wrapper for
 * its UNIQUE index; this needs nothing, and saying so is what stops somebody adding a `?? ""`
 * that does nothing.
 */
function deckCardAt(
  db: FakeDb,
  deckId: number,
  cardId: string,
  categoryId: number,
  variant: DeckVariant,
  finish: DeckFinish,
) {
  return db.deckCards.find(
    (dc) =>
      dc.deckId === deckId &&
      dc.variant === variant &&
      dc.categoryId === categoryId &&
      dc.cardId === cardId &&
      dc.finish === finish,
  );
}

/**
 * `deck::normalise_finish` — the one place `"nonfoil"` becomes `null`.
 *
 * `null` is the regular copy and `"nonfoil"` is never stored, because two spellings of one
 * thing would be two rows on the grain above that draw identically. An unrecognised word is
 * refused rather than filed as regular: a caller sending one has a bug.
 */
function normaliseFinish(raw: string | null | undefined): DeckFinish {
  if (raw === undefined || raw === null || raw === "nonfoil") return null;
  if (raw === "foil" || raw === "etched") return raw;
  throw refuse(`\`${raw}\` is not a finish this app knows.`);
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
 *
 * **This is the one path that writes `origin: "auto"`**, and the `found` return above it is
 * half of what that means: the app asked for this pile while filing a card, so a pile it had to
 * *make* is one the reader never asked for — while a pile that was already there stays whatever
 * it was, which for anything the reader typed is `"user"`.
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
    origin: "auto",
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
      // `user`, like the panel's create and unlike the add path's find-or-create. These four are
      // the deck's fixed zones rather than piles the app filed something into, and three of them
      // draw empty for reasons of their own — so marking them `auto` would make the Sideboard of
      // every new deck disappear.
      origin: "user",
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

/**
 * `deck_theory::move_live_to_theory` — what switching the plan **on** does, and it is a move
 * rather than a copy.
 *
 * The deck the reader built *becomes* the plan: every `live` row changes variant, and the live
 * list is left **empty**. That is the whole difference from {@link seedFromLive}, which copies
 * and leaves both lists holding the same cards — and it is a difference about what the two
 * lists mean rather than about rows. Enabling the switch is the moment a reader says "this is
 * what I am working toward, not what is sleeved up"; a copy would leave a live list nobody had
 * decided was real, and every count on the gallery tile would go on claiming copies for it.
 *
 * **It releases this deck's claims, and gets that for free here.** `deck_allocations` is
 * `live`-only, so in the app the move is followed by a reallocation that drops the rows this
 * deck held. There is no allocations table in this fake (simplification 2) — `allocate` reads
 * the live rows at read time, and after the move there are none, so the next read hands the
 * copies back to every other deck without anything having to be rewritten.
 *
 * Row ids, tags and `needsReview` travel with the row because it *is* the same row. Answers the
 * number of rows moved.
 */
function moveLiveToTheory(db: FakeDb, deckId: number): number {
  const live = db.deckCards.filter((dc) => dc.deckId === deckId && dc.variant === LIVE);
  for (const row of live) row.variant = "theory";
  return live.length;
}

/** `deck_theory::theory_copies` — copies, not rows. Two printings at 2 and 3 is 5 cards. */
function theoryCopies(db: FakeDb, deckId: number): number {
  return db.deckCards
    .filter((dc) => dc.deckId === deckId && dc.variant === "theory")
    .reduce((n, dc) => n + dc.quantity, 0);
}

/**
 * `deck_theory::OWNED_SPARE_SQL` — copies of one **printing in one finish** the collection
 * holds that **no built deck has claimed**.
 *
 * Built is the whole of the test, and it is the allocator's rule read from the other end: a
 * deck on a table has its cards, a deck being planned shares copies with every other draft, so
 * an unbuilt deck's claim does not make a copy unavailable to this plan. Floored at zero — a
 * collection stepped down under a stored claim can make the subtraction negative, and "you own
 * −1 of these" is not a thing to tell anyone.
 *
 * **On the whole of {@link theoryDiff}'s key** (2026-08-20), and the two halves of one row may
 * not disagree about what a card is. `coalesce(?2, 'nonfoil')` is the translation between the
 * two spellings of the regular copy: `deckCards.finish` is `null` for it and
 * `collectionEntries.finish` says `nonfoil`. It needs no orphan arm — a collection entry's
 * `cardId` is the printing whether or not `cards` still carries it.
 */
function ownedSpare(db: FakeDb, cardId: string, finish: DeckFinish): number {
  const want = finish ?? "nonfoil";
  const mine = (e: FakeEntry) => e.cardId === cardId && e.finish === want;
  const held = db.collectionEntries.filter(mine).reduce((n, e) => n + e.quantity, 0);
  const claimed = db.decks
    .filter((d) => d.isBuilt)
    .reduce((n, d) => {
      const claims = allocate(db, d.id);
      let taken = 0;
      for (const [entryId, quantity] of claims) {
        const entry = db.collectionEntries.find((e) => e.id === entryId);
        if (entry && mine(entry)) taken += Math.min(quantity, entry.quantity);
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
 * Compared on the **exact card — `(cardId, finish)`** (changed 2026-08-20, from the oracle
 * card): a plan naming the foil retro-frame Sol Ring is answered by neither a different printing
 * of it nor the regular copy. **Which pile a card sits in is not compared at all** — the same
 * card filed in two theory categories is **one line**, for the sum, named by the category the
 * editor lists first, and re-filing a card in one list and not the other is no difference.
 * Ordered by where that representative row falls in the editor's own reading order, so the
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
    // `deck_theory::group_key` — the exact card, in the exact object played. Not the category:
    // where a card sits is placement, not possession.
    const key = `${dc.cardId}|${dc.finish ?? ""}`;
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
          // The same price the deck read uses, at the same marketplace.
          unitPrice: deckPriceAt(db, card, mp),
          setCode: dc.setCode,
          collectorNumber: dc.collectorNumber,
          finish: dc.finish,
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
    grouped.row.ownedSpare = ownedSpare(db, grouped.row.cardId, grouped.row.finish);
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
 * `collection::add_entry`, as a function rather than only a handler — the quick-add, folding
 * into the row that already holds this grain. `collection_add` and `collection_import_commit`'s
 * `add` mode both write through here, so the grain's fold rule lives in one place.
 */
function addEntry(db: FakeDb, input: EntryInput): EntryChange {
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

  const existing = db.collectionEntries.find((e) => collectionGrain(e) === collectionGrain(row));
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
}

/**
 * `collection::set_entry` — `addEntry` with one clause changed: the grain's quantity is
 * **written**, not accumulated, which is what a `set` import means. Every other column keeps
 * `addEntry`'s first-writer-wins rule, and `tradelistQuantity` follows `collection_set_quantity`'s
 * own clamp (`min(existing, new quantity)`) rather than the additive cap, because a written
 * total is not a delta.
 */
function setEntry(db: FakeDb, input: EntryInput): EntryChange {
  const finish = validFinish(input.finish);
  const condition = validCondition(input.condition);
  validQuantity(input.quantity, "collection quantity");
  const tradelist = validQuantity(input.tradelistQuantity ?? 0, "tradelist quantity");
  const grading = canonicalGrading(input.grading);
  const card = requireCard(db, input.cardId);

  const row: FakeEntry = {
    id: 0,
    cardId: input.cardId,
    finish,
    condition,
    quantity: input.quantity,
    tradelistQuantity: Math.min(tradelist, input.quantity),
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
    tags: input.tags ?? "[]",
    notes: input.notes ?? null,
    needsReview: null,
    updatedAt: stamp(db),
  };

  const existing = db.collectionEntries.find((e) => collectionGrain(e) === collectionGrain(row));
  if (existing) {
    existing.quantity = row.quantity;
    existing.tradelistQuantity = Math.min(existing.tradelistQuantity, row.quantity);
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
      return addEntry(db, args.entry);
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

    /**
     * `collection::commit_import` — one transaction for a whole imported file, mirrored here as
     * one loop over the same `addEntry`/`setEntry` operations `collection_add` performs one
     * line at a time. A refused item must roll the whole file back, and there is no real
     * transaction in an in-memory array to do that for us — so the array is snapshotted first
     * and restored if anything throws, which is this fake's stand-in for it.
     *
     * `added`/`updated` are counted by row-count before and after, exactly as the backend
     * does: a hand-written lookup on the ten-column grain here would be a second copy of
     * `collectionGrain`'s own definition.
     */
    collection_import_commit: (args: {
      items: CollectionImportItem[];
      mode: TransferImportMode;
    }): ImportCommitOutcome => {
      refuseIfBusy(db);
      if (args.mode !== "add" && args.mode !== "set") {
        throw refuse(`\`${args.mode}\` is not an import mode. Use \`add\` or \`set\`.`);
      }
      const before = db.collectionEntries.length;
      const snapshot = db.collectionEntries.map((e) => ({ ...e }));
      try {
        for (const item of args.items) {
          const entry: EntryInput = {
            cardId: item.cardId,
            finish: item.finish,
            quantity: item.quantity,
            condition: item.condition,
            conditionOriginal: item.conditionOriginal,
            purchasePrice: item.purchasePrice,
            purchaseCurrency: item.purchaseCurrency,
            acquiredAt: item.acquiredAt,
            acquisitionSource: item.acquisitionSource,
            notes: item.notes,
          };
          if (args.mode === "add") {
            addEntry(db, entry);
          } else {
            setEntry(db, entry);
          }
        }
      } catch (e) {
        db.collectionEntries = snapshot;
        throw e;
      }
      const added = db.collectionEntries.length - before;
      return { added, updated: args.items.length - added, removed: 0 };
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

    /**
     * `wishlist::commit_import` — one transaction for a whole imported file,
     * `collection_import_commit`'s rule and the same snapshot/restore stand-in for it.
     *
     * The `set` arm reaches its row through `addWish` first, exactly as the backend does — it
     * is the only code that knows the wishlist grain — and then corrects the quantity: `0`
     * **deletes** the wish rather than leaving an empty one, `wishlist_set_quantity`'s own
     * asymmetry with the collection's zero. `removed` is counted in the loop rather than
     * derived from a row count, because a delete and an insert in one file would cancel out in
     * a before/after count and report neither.
     */
    wishlist_import_commit: (args: {
      items: WishlistImportItem[];
      mode: TransferImportMode;
    }): ImportCommitOutcome => {
      refuseIfBusy(db);
      if (args.mode !== "add" && args.mode !== "set") {
        throw refuse(`\`${args.mode}\` is not an import mode. Use \`add\` or \`set\`.`);
      }
      const before = db.wishlistEntries.length;
      const snapshot = db.wishlistEntries.map((w) => ({ ...w }));
      let removed = 0;
      try {
        for (const item of args.items) {
          const wish: WishInput = {
            oracleId: item.oracleId,
            cardId: item.cardId,
            quantity: item.quantity,
            preferredFinish: item.preferredFinish,
            notes: item.notes,
          };
          if (args.mode === "add") {
            addWish(db, wish);
            continue;
          }
          const change = addWish(db, wish);
          validQuantity(item.quantity, "wishlist quantity");
          if (item.quantity === 0) {
            removeWish(db, change.id);
            removed += 1;
            continue;
          }
          const row = db.wishlistEntries.find((w) => w.id === change.id);
          if (row) {
            row.quantity = item.quantity;
            row.updatedAt = stamp(db);
          }
        }
      } catch (e) {
        db.wishlistEntries = snapshot;
        throw e;
      }
      const added = db.wishlistEntries.length - before + removed;
      return { added, updated: args.items.length - added - removed, removed };
    },

    /**
     * `deck::create_deck` — **a whole deck in one INSERT**, plus the four predefined categories
     * in the same transaction, because a deck that exists but cannot be filed into anything is
     * a state nothing downstream expects.
     *
     * Everything {@link DeckInput} carries below `formatKey` is written here rather than left
     * to a follow-up patch: create-then-patch-then-file is three writes and a half-made deck to
     * unwind by hand when the second one fails. Five of its rules are **not**
     * {@link deck_update}'s, and each is a rule a reader who knows the patch will guess wrong:
     *
     * - **Nothing here coalesces.** A patch reads an absent field as "leave it"; an insert has
     *   nothing to leave, so an absent field is the column's own default. For `folderId` that
     *   difference is the whole meaning of the field — absent **is** the top level and means
     *   it, while {@link deck_set_folder} remains the only way to un-file a deck that already
     *   exists.
     * - **`coverKind` is not settable at create** and keeps its `card_art` default. A custom
     *   picture is {@link deck_set_cover_image}, which takes a path and a deck id and therefore
     *   cannot run until the deck is there; the create dialog holds a chosen file and uploads
     *   it afterwards.
     * - **`theoryEnabled` sets the column and seeds nothing.** The patch seeds the theory list
     *   from live on the off → on transition; a deck being born has no live cards to copy, and
     *   a deck born with the switch already on has made that transition at birth.
     * - **A deck's birth is exactly one audit row**, however many fields it was born with:
     *   `deck_update` records one per changed field because each of those is an event, and
     *   being born is one event. It is also the only `deck` row whose `from` is null — there
     *   was no previous name, because there was no deck — and it is recorded rather than left
     *   out so a drawer scrolled to the bottom ends at the deck's own beginning.
     * - **It is the only deck write that touches `app_meta`**, and the only writer of
     *   {@link FakeDb.lastDeckFormat} anywhere. Re-formatting an existing deck is a correction
     *   and a duplicate is not a decision, so neither moves the memory; making a deck in a
     *   format *is* the decision, so this one does.
     *
     * `folderId` is checked **nowhere**, here or in Rust: `decks.folder_id REFERENCES
     * deck_folders(id)` is a real foreign key over two user tables, so SQLite refuses a folder
     * that is not there. This store has no foreign keys and does not invent a sentence for one
     * — {@link FOLDER_GONE} is `deck_set_folder`'s wording, which that command chose because it
     * validates in words, and borrowing it here would put a refusal in the fake's mouth that
     * the app never says. `coverCardId` is a soft reference like every card id in a user table.
     */
    deck_create: (args: { deck: DeckInput }): DeckRow => {
      refuseIfBusy(db);
      const row: FakeDeck = {
        id: nextId(db.decks),
        name: validName(args.deck.name),
        formatKey: validFormat(args.deck.formatKey),
        // No `validGame` beside {@link validFormat}, and the asymmetry mirrors the crate's: a
        // format is checked against a *seeded table* that a migration can change under a stored
        // key, while a game is one of four words in a union the compiler already holds. Rust
        // fences it because a command parameter is untyped on the wire; nothing here is.
        gameKey: args.deck.gameKey ?? "any",
        description: args.deck.description ?? null,
        coverCardId: args.deck.coverCardId ?? null,
        coverKind: COVER_CARD_ART,
        isBuilt: false,
        archived: false,
        folderId: args.deck.folderId ?? null,
        notes: args.deck.notes ?? null,
        theoryEnabled: args.deck.theoryEnabled ?? false,
        // The DDL's three defaults, and they stay defaults: the view memory is where the reader
        // *left* a deck, so a deck being born has nowhere to have been left. `lastGroupBy`/
        // `lastSortBy` are imported rather than spelled out because the column's default and the
        // editor's opening mode have to be the same word — a deck that opened on a grouping the
        // toolbar does not start in would look like a memory that had already been written to.
        lastVariant: LIVE,
        lastGroupBy: DEFAULT_GROUP_BY,
        lastSortBy: DEFAULT_SORT_BY,
        // Spelled out rather than left absent, because `create_deck` names every column it
        // writes: a new deck's curve is the plain one until the reader says otherwise.
        separateXGroup: false,
        updatedAt: stamp(db),
      };
      db.decks.push(row);
      // `app_meta.last_deck_format`, written from **`row.formatKey` and not from `args`**: the
      // memory has to be the format the deck actually carries, so a blank input remembers the
      // `casual` it became rather than the blank it arrived as. Placed here rather than beside
      // the row's construction because that is where the transaction it lives in ends — a
      // create refused above (a blank name, or a format {@link validFormat} does not know)
      // never reaches this line, which is what leaves the previous answer standing.
      db.lastDeckFormat = row.formatKey;
      ensurePredefinedCategories(db, row.id);
      record(db, row.id, DECK_LEVEL, "deck", null, { field: "name", from: null, to: row.name }, 0);
      return toDeckRow(db, row);
    },

    /**
     * `deck::update_deck` — rename, re-format, cover, notes, build, archive, the theory switch
     * and the X-group switch all arrive here.
     *
     * `coalesce(?n, column)`, so absent means "leave it" and there is no field that *clears*
     * one: `description: ""` writes an empty string rather than a NULL, `coverCardId` cannot be
     * unset, and `folderId` can file a deck but never un-file one — {@link deck_set_folder} is
     * the command that reaches the root. Sending `isBuilt` reallocates in the app; here the next
     * `deck_get` does that work, so the flag is all this has to write.
     *
     * **Two things happen beside the columns.** Sending `coverCardId` sets `coverKind` back to
     * `card_art`, which is how a deck showing an uploaded picture returns to card art without
     * the file being deleted. And switching `theoryEnabled` **on moves the live list into
     * theory** — see {@link moveLiveToTheory}: the deck the reader built becomes the plan, the
     * live list is left empty, {@link FakeDeck.lastVariant} is left at `theory` so the editor
     * opens on what they now have, and this deck's claims are released with the rows. Switching
     * it off keeps every row.
     *
     * **Two guards on that move, and both are about not destroying an edit.** It happens only on
     * the false→true *transition*, and only when the theory list is **empty** — a plan the reader
     * has already started is not something a re-press of the switch may pour the live deck over.
     * A reader who wants the deck copied into a plan they have already begun asks for it by name:
     * {@link deck_theory_copy_from_live} still copies, and still skips rather than folding.
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
      // One row, whether or not the live list moved below: the move is part of switching the
      // list on rather than a second edit, and N `add` rows for one press would read as a deck
      // somebody typed out.
      if (patch.theoryEnabled !== undefined && patch.theoryEnabled !== before.theoryEnabled) {
        field("theory", before.theoryEnabled, patch.theoryEnabled);
      }
      // Read through `?? false` on the `from` side for {@link FakeDeck.separateXGroup}'s reason:
      // an absent column is the DDL's `0`, so a deck that has never been asked and a deck
      // switched off are one state, and switching *on* is one change from either.
      //
      // **The word is `deck.rs`'s and is not derived from the column name** — the two above it
      // are (`theory_enabled` → `theory`, `is_built` → `built`), and reading that pattern
      // forward gives `separateX`, which is wrong. `deck.rs` writes `"xGroup"`, and it is the
      // one multi-word field name in the switch `auditText.ts` reads. Nothing enforces the
      // agreement: an unrecognised field falls through `auditText`'s default arm to a bland
      // "Changed the deck", so a disagreement here is a history line quietly saying less than
      // it knows rather than anything that goes red.
      const separateXWas = before.separateXGroup ?? false;
      if (patch.separateXGroup !== undefined && patch.separateXGroup !== separateXWas) {
        field("xGroup", separateXWas, patch.separateXGroup);
      }
      // v16's, and the second multi-word field name in that switch — `deck.rs` writes
      // `"defaultCategory"`, and the paragraph above applies word for word.
      //
      // **The payload carries the pile's *name*, never its id**, which is `recordFiled`'s rule
      // for the folder path applied to the one other column pointing at a row with a name of its
      // own: a bare `12` is a number no reader can resolve once the pile has been renamed. `null`
      // on either side is `AUTO_CATEGORY`, where there is no pile to name.
      const defaultCategoryWas = before.defaultCategoryId ?? 0;
      if (patch.defaultCategoryId !== undefined && patch.defaultCategoryId !== defaultCategoryWas) {
        field(
          "defaultCategory",
          categoryNameOf(db, defaultCategoryWas),
          categoryNameOf(db, patch.defaultCategoryId),
        );
      }
      // v18's, and the field name is `deck.rs`'s once more — `"game"`, a single word this time,
      // and it carries the stored **key** rather than the display word: `auditText.ts` is the
      // only thing that knows Paper from `paper`. `?? "any"` on the `from` side for
      // {@link FakeDeck.gameKey}'s reason, one column over.
      const gameWas = before.gameKey ?? "any";
      if (patch.gameKey !== undefined && patch.gameKey !== gameWas) {
        field("game", gameWas, patch.gameKey);
      }
      if (patch.folderId !== undefined && patch.folderId !== before.folderId) {
        recordFiled(db, deck.id, patch.folderId);
      }

      deck.name = name ?? deck.name;
      deck.formatKey = formatKey ?? deck.formatKey;
      deck.gameKey = patch.gameKey ?? deck.gameKey;
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
        const turnedOn = patch.theoryEnabled && !before.theoryEnabled;
        deck.theoryEnabled = patch.theoryEnabled;
        if (turnedOn && theoryCopies(db, deck.id) === 0) {
          moveLiveToTheory(db, deck.id);
          // The tab the reader is put on, because it is now the tab their deck is in. Written
          // here rather than left to `deck_set_view_state` for the reason the move itself is
          // not two commands: a reader who pressed one switch made one decision.
          deck.lastVariant = "theory";
        }
      }
      // `coalesce(?n, separate_x_group)`, and **nothing else happens**: this switch writes one
      // column and touches not one `deck_cards` row. Where the theory switch above seeds a list,
      // this one only changes how the same cards are read — the curve is regrouped in TS, by
      // `buildGroups`, on the rows the next read hands back.
      deck.separateXGroup = patch.separateXGroup ?? deck.separateXGroup;
      // `coalesce(?n, default_category_id)` again — and **`0` is a value here rather than an
      // absence**, which is the whole reason `??` is right and a truthiness test would be wrong:
      // `patch.defaultCategoryId === 0` is a reader asking to go back to Auto, and `||` would
      // read it as no change at all.
      deck.defaultCategoryId = patch.defaultCategoryId ?? deck.defaultCategoryId;
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

    /**
     * `deck::set_view_state` — remember which tab, grouping and sort the reader is looking at.
     *
     * **Three columns, and nothing else in the row moves.** No `updated_at` bump, no history
     * row, no reallocation: *looking* at a tab is not editing a deck. Each of those would be a
     * lie of a different size — a bump would resort the gallery every time somebody glanced at
     * their plan, a history row would bury the edits the drawer exists to show under a hundred
     * "changed the sort", and there is nothing to reallocate because no card moved. It is the
     * one write in this table that answers `void` for exactly that reason: there is no new
     * {@link DeckRow} worth reading back, and a caller that redrew from one would repaint the
     * editor on every toolbar press.
     *
     * **Absent means "leave it"**, per field, like a {@link DeckPatch} — so the toolbar sends
     * only what the reader touched and three controls need no shared state to be written from.
     *
     * **The three fields are checked by three different amounts, and each amount is a statement
     * about whose vocabulary the field holds.** `variant` goes through the same
     * {@link validVariant} every other deck write opens with — `live`/`theory` is the backend's
     * word list, and the column carries no CHECK to enforce it, so the fence is in words.
     * `groupBy`/`sortBy` are only checked for being **blank** ({@link validMode}): the words are
     * TypeScript's ({@link FakeDeck.lastGroupBy}) and a build that refused one it did not know
     * would refuse the future, while a blank is a caller bug in any vocabulary. That is the
     * deliberate opposite of `set_printing_group_by`, which refuses any mode outside its own
     * list — because that list is the backend's.
     *
     * An unknown deck is refused by name, like every other deck write.
     */
    deck_set_view_state: (args: { deckId: number; viewState: DeckViewState }): void => {
      refuseIfBusy(db);
      // Validated before the deck is looked up, as the Rust validates before its UPDATE: a
      // refusal about the arguments does not depend on which deck they were aimed at.
      const state = args.viewState;
      const variant = state.variant === undefined ? undefined : validVariant(state.variant);
      const groupBy = state.groupBy === undefined ? undefined : validMode(state.groupBy);
      const sortBy = state.sortBy === undefined ? undefined : validMode(state.sortBy);
      const deck = requireDeck(db, args.deckId);
      if (variant !== undefined) deck.lastVariant = variant;
      if (groupBy !== undefined) deck.lastGroupBy = groupBy;
      if (sortBy !== undefined) deck.lastSortBy = sortBy;
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
      // **The tags stay**, since schema v21: a label belongs to no deck, so deleting the deck
      // it was first typed in must not take it off the others wearing it. Only `reset_decks`,
      // which is every deck at once, sweeps the table.
      db.deckAudit = db.deckAudit.filter((a) => a.deckId !== args.id);
    },

    /**
     * `deck::duplicate_deck` — the cards come across in **both variants**, never `isBuilt` and
     * never `archived`. A copy is a **draft**: it has reserved nothing, it is not sleeved up
     * on a table, and it is not something the user filed away. The theory list comes too,
     * because a copy made to try something out is exactly the copy that wants the plan.
     *
     * `separateXGroup` comes across in the spread below with the rest of the row, and belongs
     * with the theory list rather than with the two exceptions: it is how the reader reads a
     * curve, and a copy opened onto a differently grouped curve than the deck it was made from
     * would be a copy that lost something nobody chose to change.
     *
     * **Categories and tags are new rows with new ids, and the cards are remapped onto them.**
     * This is the part a "copy the cards" implementation gets wrong invisibly: a card row
     * stores a `category_id`, so copying it verbatim would file the copy's cards under the
     * *original's* categories — and then deleting the original would take the copy's cards
     * with it through `ON DELETE CASCADE`. Two id maps are what keep a copy a copy.
     *
     * It is not handed {@link ensurePredefinedCategories}: it inherits the source's four,
     * because every deck has them.
     *
     * **The three view-state columns are reset rather than inherited**, and that is Rust's
     * answer rather than a taste: `duplicate_deck` names the columns it copies, and those three
     * are not among them, so a copy starts at `live`/`category`/`alphabetical`. It is the right
     * one for what they mean — a remembered view is where *this reader* left *this deck*, and a
     * copy is a draft nobody has opened yet. The spread would have inherited them silently,
     * which is the whole reason this is written out.
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
        lastVariant: "live",
        lastGroupBy: DEFAULT_GROUP_BY,
        lastSortBy: DEFAULT_SORT_BY,
        updatedAt: stamp(db),
      };
      db.decks.push(copy);
      const categoryMap = new Map<number, number>();
      for (const c of db.deckCategories.filter((row) => row.deckId === source.id)) {
        const made: FakeDeckCategory = { ...c, id: nextId(db.deckCategories), deckId: copy.id };
        db.deckCategories.push(made);
        categoryMap.set(c.id, made.id);
      }
      // **Remapped, not inherited** — and the spread above is precisely what would have
      // inherited it, which is why this line sits here rather than being left to `...source`.
      // The column holds a `deck_categories.id` and the copy's piles are the rows just made, so
      // carrying the number across points the duplicate at a pile of the *original*: nothing
      // breaks, and every add lands in a column of a deck the reader is not looking at.
      // `?? 0` covers a source on Auto (in no map) and a source pointing at a pile that has
      // gone, which the delete handler's clean-up means cannot happen.
      copy.defaultCategoryId = categoryMap.get(source.defaultCategoryId ?? 0) ?? 0;
      // **No tags are copied, and since schema v21 there is nothing to copy.** A duplicate used
      // to get its own `deck_tags` rows and a map from the original's ids to them, because a tag
      // belonged to a deck. It is one app-wide row now, so the copied cards keep the very
      // `tagId` they had — the duplicate wears the same labels as its original, which is what a
      // reader duplicating a deck means by "the same deck".
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
          // Verbatim: the label is the app's, so the copy wears the very same row.
          tagId: dc.tagId,
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
      finish?: DeckFinish;
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
      const finish = normaliseFinish(args.finish);
      const existing = deckCardAt(db, args.deckId, args.cardId, category.id, variant, finish);
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
        finish,
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
      finish?: DeckFinish;
      quantity: number;
    }): EntryChange => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      validQuantity(args.quantity, "deck quantity");
      const deck = requireDeck(db, args.deckId);
      const category = categoryOfDeck(db, args.deckId, args.categoryId);
      const row = deckCardAt(
        db,
        args.deckId,
        args.cardId,
        category.id,
        variant,
        normaliseFinish(args.finish),
      );
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
     * `deck::clear_category` — a pile's right-click **Clear stack**, answering the **copies**
     * it removed.
     *
     * **One variant**, which is the opposite of `deck_category_delete` below: that one cascades
     * through both lists because a category is not variant-scoped, and this one leaves the pile
     * standing so it empties only the list the reader is looking at. The `variant` in the filter
     * is what a story about a theory-enabled deck exercises.
     *
     * **An empty pile writes nothing at all** — no `updatedAt` — where `deck_set_card_quantity`'s
     * zero arm above deliberately still moves it: that path commits a transaction whatever it
     * found, and this one returns before opening one.
     */
    deck_category_clear: (args: {
      deckId: number;
      categoryId: number;
      variant: DeckVariant;
    }): number => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      const deck = requireDeck(db, args.deckId);
      const category = categoryOfDeck(db, args.deckId, args.categoryId);
      const doomed = db.deckCards.filter(
        (dc) =>
          dc.deckId === args.deckId && dc.categoryId === category.id && dc.variant === variant,
      );
      // Copies, not rows — two printings at 2 and 3 is the 5 the confirmation quoted.
      const cleared = doomed.reduce((copies, dc) => copies + dc.quantity, 0);
      if (cleared === 0) return 0;
      db.deckCards = db.deckCards.filter((dc) => !doomed.includes(dc));
      deck.updatedAt = stamp(db);
      return cleared;
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
     *
     * **Either `toCategoryId` or `toCategoryName`, and at least one** — `deck_add_card`'s two-arm
     * target, mirrored here because the crate mirrors it there. The name arm is the quick zones'
     * `Auto` and goes through {@link categoryForName}, so a pile it invents is `"auto"` and stops
     * being drawn once its last card leaves. The id wins when both arrive.
     *
     * Answers the category the copies are now in. **The `from === to` check moved below the
     * resolution and that is not a tidy-up**: the name arm cannot know the target's id until it
     * has resolved it, and a card the rule files where it already is has to be answered rather
     * than moved — so the early return is `Ok(to)` with nothing written, `updatedAt` included.
     */
    deck_move_card: (args: {
      deckId: number;
      cardId: string;
      fromCategoryId: number;
      toCategoryId: number | null;
      toCategoryName: string | null;
      variant: DeckVariant;
      finish?: DeckFinish;
    }): number => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      // Addresses the row and travels with it: moving the foil copy leaves it the foil copy.
      const finish = normaliseFinish(args.finish);
      if (args.toCategoryId === null && args.toCategoryName === null) throw refuse(NO_CATEGORY);
      const deck = requireDeck(db, args.deckId);
      const from = categoryOfDeck(db, args.deckId, args.fromCategoryId);
      const to =
        args.toCategoryId !== null
          ? categoryOfDeck(db, args.deckId, args.toCategoryId)
          : categoryForName(db, args.deckId, args.toCategoryName!);
      // After the resolution, and it writes nothing at all — not even `updatedAt`, which the
      // Rust rolls back with its transaction for the same reason.
      if (from.id === to.id) return to.id;
      const row = deckCardAt(db, args.deckId, args.cardId, from.id, variant, finish);
      if (!row) throw refuse(cardGone(from.name));
      const target = deckCardAt(db, args.deckId, args.cardId, to.id, variant, finish);
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
      return to.id;
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
      finish?: DeckFinish;
    }): SwapResult => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      // Carried across: the reader is choosing a printing, not an object, so the foil copy of
      // the old printing becomes the foil copy of the new one. Deliberately not checked against
      // the target's `finishes` — see the crate's `swap_printing`.
      const finish = normaliseFinish(args.finish);
      // Before anything else, so a no-op does not move `updatedAt` and resort the gallery.
      if (args.fromCardId === args.toCardId) throw refuse(SAME_PRINTING);
      const deck = requireDeck(db, args.deckId);
      const category = categoryOfDeck(db, args.deckId, args.categoryId);
      const row = deckCardAt(db, args.deckId, args.fromCardId, category.id, variant, finish);
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
      const target = deckCardAt(db, args.deckId, args.toCardId, category.id, variant, finish);
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
          finish,
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
     * `deck::set_card_finish` — which **object** this row plays.
     *
     * `deck_swap_printing` one axis over, so it answers the same `SwapResult` and **folds** the
     * same way: setting a row to a finish the pile already holds adds the quantities and takes
     * the row that moved away, and the surviving row keeps its own id, its tag and its sentence
     * (`add_card`'s rule — the row that was already there is the one the reader labelled).
     *
     * Three refusals, and the second is the one worth having in the fake: the target finish is
     * checked against `cards.finishes`, so a story that points this at a printing sold only in
     * nonfoil sees what the app does with a refusal rather than a silently shiny card.
     */
    deck_set_card_finish: (args: {
      deckId: number;
      cardId: string;
      categoryId: number;
      variant: DeckVariant;
      fromFinish?: DeckFinish;
      toFinish?: DeckFinish;
    }): SwapResult => {
      refuseIfBusy(db);
      const variant = validVariant(args.variant);
      const from = normaliseFinish(args.fromFinish);
      const to = normaliseFinish(args.toFinish);
      // Before anything else, so a no-op does not move `updatedAt` and resort the gallery.
      if (from === to) throw refuse(SAME_FINISH);
      const deck = requireDeck(db, args.deckId);
      const category = categoryOfDeck(db, args.deckId, args.categoryId);
      if (to !== null) {
        const sold = parseFinishes(cardById(db, args.cardId)?.finishes ?? null);
        if (!sold.includes(to)) throw refuse(FINISH_NOT_SOLD);
      }
      const row = deckCardAt(db, args.deckId, args.cardId, category.id, variant, from);
      if (!row) throw refuse(cardGone(category.name));
      const target = deckCardAt(db, args.deckId, args.cardId, category.id, variant, to);
      deck.updatedAt = stamp(db);
      if (target) {
        target.quantity += row.quantity;
        db.deckCards = db.deckCards.filter((dc) => dc !== row);
        return { folded: true, quantity: target.quantity };
      }
      // Nothing to fold into: the row changes finish in place and keeps everything else. No new
      // rowid here, unlike the move and the swap above — the crate's statement is a bare
      // `UPDATE … SET finish`, so the row does not move in the allocator's tie-break either.
      row.finish = to;
      return { folded: false, quantity: row.quantity };
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
     * `import::commit_import` — a whole decklist into one deck, in one transaction.
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
          if (!existed) {
            categoriesCreated += 1;
            // Archidekt's `{noDeck}`: the file says this pile counts toward nothing, which is
            // what `isActive: false` means. **Only a pile this import made** — a name the reader
            // already has keeps whatever they set, exactly as `commit_import` does it.
            if (item.inactive === true) category.isActive = false;
          }
          categories.set(name, category);
        }
        const card = requireCard(db, item.cardId);
        // A decklist's `*F*` / `*E*` marker, carried from `parse.ts` through `plan.ts`. It is
        // part of the grain, so a list naming the same printing foil on one line and plain on
        // another lands as two rows rather than one summed.
        const finish = normaliseFinish(item.finish);
        const existing = deckCardAt(db, deck.id, item.cardId, category.id, variant, finish);
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
            finish,
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
     * `deck_meta::create_category` — a new pile, always `kind: "main"`, always active, always
     * `origin: "user"`, appended after the deck's last one.
     *
     * **The reader pressed a button to get here**, which is the whole of what `origin` records
     * and the opposite of {@link categoryForName}'s answer. A pile made this way draws for as
     * long as it exists, empty or not, because it was made with an intent nothing on screen can
     * see — and deleting it is how they say they are done with it.
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
        origin: "user",
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
      // What an `ON DELETE SET NULL` would have done — and `decks.default_category_id` carries
      // no foreign key on either side of the IPC, because `0` is Auto and a nullable column
      // could not have said that through `DeckPatch`'s `coalesce`. Left undone, the deck keeps
      // filing every unnamed add at an id with no pile behind it, and the next quick add is
      // refused on a deck whose settings still read the deleted name.
      if (deck.defaultCategoryId === category.id) deck.defaultCategoryId = 0;
      recordCategory(db, deck.id, { action: "delete", name: category.name, cards });
      deck.updatedAt = stamp(db);
    },

    /**
     * `deck_meta::create_tag` — a new label, **app-wide**. `deckId` is where the reader was
     * standing: it goes in the history row and is not stored on the tag.
     *
     * Refuses a name **any** tag already holds, compared on {@link tagKey} rather than on the
     * word — `removal` collides with `Removal`, and a `Café` typed with a combining accent with
     * one typed without. That is the issue's second half and it is a table property, so the fake
     * enforces it the way the UNIQUE index does.
     */
    deck_tag_create: (args: { deckId: number; name: string; color: string }): GlobalTag => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A tag");
      const color = validColor(args.color);
      if (tagNameIsTaken(db, name, null)) throw refuse(TAG_NAME_TAKEN);
      const deck = requireDeck(db, args.deckId);
      const tag: FakeDeckTag = { id: nextId(db.deckTags), name, color };
      db.deckTags.push(tag);
      recordTag(db, deck.id, { action: "create", tag: name, previous: null });
      deck.updatedAt = stamp(db);
      return toGlobalTag(db, tag);
    },

    /**
     * `deck_meta::update_tag` — rename **and** recolour, **in every deck at once**: one command,
     * both arguments required. There is no patch shape here, so a caller changing one sends the
     * other back unchanged.
     *
     * **Two verbs, where `rename` used to cover both.** It covered both because a colour was one
     * of six palette tokens and never reached a sentence; the colour is the reader's own now and
     * is the same colour in every deck, so "Recoloured tag Ramp" is a line a reader may come
     * back looking for.
     */
    deck_tag_update: (args: {
      deckId: number;
      id: number;
      name: string;
      color: string;
    }): GlobalTag => {
      refuseIfBusy(db);
      const name = validMetaName(args.name, "A tag");
      const color = validColor(args.color);
      const tag = tagById(db, args.id);
      if (!tag) throw refuse(TAG_GONE);
      if (tagNameIsTaken(db, name, tag.id)) throw refuse(TAG_NAME_TAKEN);
      const deck = requireDeck(db, args.deckId);
      const previous = tag.name;
      tag.name = name;
      tag.color = color;
      recordTag(
        db,
        deck.id,
        previous === name
          ? { action: "recolour", tag: name, previous: null, color }
          : { action: "rename", tag: name, previous, color },
      );
      deck.updatedAt = stamp(db);
      return toGlobalTag(db, tag);
    },

    /**
     * `deck_meta::remove_tag_from_deck` — take a label off **this deck's cards in one list**,
     * leaving the tag itself alone. Answers how many rows lost it.
     *
     * The act the app-wide list needed and the per-deck one never did: "I am done with this
     * label here" and "this label should stop existing" were one press while a tag belonged to a
     * deck. Zero is a success, not a refusal, and writes nothing.
     */
    deck_tag_remove_from_deck: (args: {
      deckId: number;
      tagId: number;
      variant: DeckVariant;
    }): number => {
      const variant = validVariant(args.variant);
      refuseIfBusy(db);
      const tag = tagById(db, args.tagId);
      if (!tag) throw refuse(TAG_GONE);
      const wearing = db.deckCards.filter(
        (dc) => dc.tagId === tag.id && dc.deckId === args.deckId && dc.variant === variant,
      );
      if (wearing.length === 0) return 0;
      const deck = requireDeck(db, args.deckId);
      for (const dc of wearing) dc.tagId = null;
      recordTag(db, deck.id, {
        action: "remove",
        tag: tag.name,
        previous: null,
        cards: wearing.length,
      });
      deck.updatedAt = stamp(db);
      return wearing.length;
    },

    /**
     * `deck_meta::delete_tag` — **from the whole app**, and it **untags its cards rather than
     * deleting them** (`deck_cards.tag_id` is `ON DELETE SET NULL`) in every deck wearing it,
     * which is the half of the sentence a confirm dialog owes a reader.
     *
     * An id that resolves to nothing is a success: the caller wanted that tag gone, and it is
     * gone.
     */
    deck_tag_delete: (args: { deckId: number; id: number }): void => {
      refuseIfBusy(db);
      const tag = tagById(db, args.id);
      if (!tag) return;
      const deck = requireDeck(db, args.deckId);
      const cards = db.deckCards.filter((dc) => dc.tagId === tag.id).length;
      db.deckTags = db.deckTags.filter((t) => t.id !== tag.id);
      for (const dc of db.deckCards) if (dc.tagId === tag.id) dc.tagId = null;
      // `previous` is null: this row is about the label, and the label it is about is `tag`.
      // Filling it here would make a delete read as a rename that went nowhere.
      recordTag(db, deck.id, { action: "delete", tag: tag.name, previous: null, cards });
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
        // No wrong-deck fence since schema v21: there is no other deck's tag to refuse.
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
      for (let grew = true; grew;) {
        grew = false;
        for (const f of db.deckFolders) {
          if (f.parentId !== null && doomed.has(f.parentId) && !doomed.has(f.id)) {
            doomed.add(f.id);
            grew = true;
          }
        }
      }
      db.deckFolders = db.deckFolders.filter((f) => !doomed.has(f.id));
      for (const deck of db.decks)
        if (deck.folderId !== null && doomed.has(deck.folderId)) {
          deck.folderId = null;
        }
    },

    /**
     * `deck_theory::copy_from_live` — seed the theory list from the live one, answering how many
     * **rows** were written.
     *
     * **The one command that still copies**, and the reason it is worth having beside
     * {@link moveLiveToTheory}: switching the plan on *moves* the deck into it, while this
     * duplicates a live list that stays exactly where it is. It is what a reader reaches for to
     * start a plan again from what is sleeved up, and it is the only way to fill a plan that
     * already has something in it — the switch refuses to touch one of those on purpose.
     *
     * It folds nothing and overwrites nothing: a theory row the reader already made is their
     * plan for that card.
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
     * `reset::collection_clear` — the whole table, and the cascade with it.
     *
     * **`allocations` is derived rather than read**, because simplification 2 says there is no
     * allocations table here: `allocate` works out a deck's claims at read time from its live
     * rows. So the number reported is the claims that *were* standing — one per live deck row
     * whose card the reader owned — which is what the Rust counts before its `DELETE` and what
     * the panel's sentence is about.
     */
    collection_clear: (): CollectionCleared => {
      refuseIfBusy(db);
      const owned = new Set(db.collectionEntries.map((e) => e.cardId));
      const allocations = db.deckCards.filter(
        (dc) => dc.variant === LIVE && owned.has(dc.cardId),
      ).length;
      const entries = db.collectionEntries.length;
      db.collectionEntries = [];
      return { entries, allocations };
    },

    /** `reset::wishlist_clear`. Nothing references the wishlist, so nothing else moves. */
    wishlist_clear: (): number => {
      refuseIfBusy(db);
      const gone = db.wishlistEntries.length;
      db.wishlistEntries = [];
      return gone;
    },

    /**
     * `reset::decks_clear` — every deck, everything that cascades from one, and the folders.
     *
     * The folders are the half a reader does not predict and the half this handler exists to
     * make visible: `decks.folder_id` is `ON DELETE SET NULL`, so the crate clears
     * `deck_folders` in a *second* statement, and a fake that stopped at the cascade would draw
     * a gallery with an empty folder tree still standing in it.
     *
     * `covers` counts the decks showing a custom picture, which is what has a file in the app.
     * A `card_art` deck has none, so counting decks would report pictures that were never there.
     */
    decks_clear: (): DecksCleared => {
      refuseIfBusy(db);
      const decks = db.decks.length;
      const folders = db.deckFolders.length;
      const covers = db.decks.filter((d) => d.coverKind === COVER_CUSTOM).length;
      db.decks = [];
      db.deckFolders = [];
      db.deckCards = [];
      db.deckCategories = [];
      db.deckTags = [];
      db.deckAudit = [];
      db.deckUndo = [];
      return { decks, folders, covers };
    },

    /**
     * `reset::cache_clear` — the one button on this page that destroys nothing.
     *
     * Refuses mid-sync in the backend's own words, which is the state worth a story: the corpus
     * download puts 77 MB in `data/tmp/` and reads it back, so the crate fences the whole
     * command rather than skipping that one directory. That check happens *before* the write
     * connection is asked for, so it is `syncing` that produces it here and not `busy`.
     *
     * `failed` is always 0: it counts files Windows would not unlink, which needs a second
     * process holding one open and has no representation here.
     */
    cache_clear: (): CacheCleared => {
      if (db.fault === "syncing") throw refuse(CACHE_SYNCING);
      refuseIfBusy(db);
      const { files, bytes, rows } = db.imageCache;
      db.imageCache = { files: 0, bytes: 0, rows: 0 };
      return { files, bytes, rows, failed: 0 };
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
     * `zoom::set_card_zoom` — remember one wall's size, and refuse a value that could not be read
     * back.
     *
     * **The refusal is the half a fake is easiest to leave out**, `set_printing_group_by`'s
     * sentence and the same trap: the read side drops an entry it cannot use, so a fake that
     * accepted any number would let a story save 40×, read back nothing, and look like it worked.
     *
     * **What it does *not* refuse is a section name**, which is the asymmetry worth the note: the
     * seven walls are TypeScript's vocabulary and `zoom.rs` deliberately does not know them, so
     * anything but a blank string is stored. A fake that checked against `ZOOM_SECTIONS` would be
     * telling a story about a validation the backend does not do — and would hide the case the
     * frontend's own `isZoomSection` exists for.
     *
     * The other half of that asymmetry is here too: only the named section is touched, so an entry
     * this build cannot use survives a write made beside it. That is the one thing an object row
     * has to get right that a bare string does not.
     *
     * It honours `busy` like every other ordinary write here — `zoom.rs` takes the write
     * connection through `sync::with_write`. **The lock comes first and the value is checked
     * inside it**, which is the Rust's own order and `set_marketplace`'s.
     */
    set_card_zoom: (args: { section: string; zoom: number }): void => {
      refuseIfBusy(db);
      if (args.section === "") throw refuse("A card section cannot be blank.");
      if (!isStorableZoom(args.zoom)) {
        throw refuse(
          `${args.zoom} is not a card zoom this app stores. ` +
            `Expected a number between ${MIN_ZOOM} and ${MAX_ZOOM}.`,
        );
      }
      db.cardZoom = { ...db.cardZoom, [args.section]: args.zoom };
    },

    /**
     * `nav::set_nav_collapsed` — remember that the reader collapsed the sidebar, or opened it.
     *
     * **The only thing it can refuse is a running sync, and that absence is the point rather
     * than a gap.** Its three neighbours above each open with a validation — a marketplace id
     * that is not on the list, a grouping mode this build cannot draw, a zoom outside the
     * bounds — because each of those arrives as a `String` or a bare number and the read side
     * *shrugs at* what it cannot use, so an unchecked write would leave `app_meta` holding a
     * row that silently means the default forever. `set_printing_group_by`'s note calls that
     * refusal the half a fake is easiest to leave out, and it is right about all three.
     *
     * There is no fourth instance of it here, and a reader comparing the two handlers should
     * not have to wonder whether one was forgotten: a `boolean` off the IPC boundary has **no
     * junk state**. Tauri's deserializer refuses anything that is not `true` or `false` before
     * this handler is reached at all, so both values are storable, both round-trip, and there
     * is nothing left for a validation to catch. Adding one would be inventing a refusal the
     * backend does not make — the same mistake in the other direction as leaving one out.
     *
     * It honours `busy` like every other ordinary write here, which is the split that puts it
     * on this side of the file at all: `nav_collapsed` takes the read connection and answers
     * through every second of a sync, while this one takes the **write** connection and so
     * answers `crate::db::BUSY` — `set_printing_group_by`'s pair exactly. A reader pressing the
     * toggle mid-sync gets a refusal, and the sidebar that snaps back is the app telling the
     * truth about a preference that was not saved.
     */
    set_nav_collapsed: (args: { collapsed: boolean }): void => {
      refuseIfBusy(db);
      db.navCollapsed = args.collapsed;
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
      db.marketplaceFeeds = [...db.marketplaceFeeds.filter((f) => f.marketplace !== feed.id), meta];
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
     * `oracle_tags::refresh` — fetch the taxonomy if it is due and rebuild it from the file.
     *
     * **It does not honour `busy`**, and it is the sixth command here that does not: `refresh`
     * opens with a read and a network call, and only its ingest takes `db::lock_for` — so a
     * running sync delays it rather than refusing it at the door. `db.test.ts`'s busy sweep
     * lists it beside `sync_run` and the four update commands for that reason.
     *
     * **`force` skips the weekly throttle and nothing else.** A run that is not due answers the
     * status it already had and emits no event at all, which is why a story that wants to watch
     * the phases has to send `force: true` — `update_check`'s shape, for `update_check`'s
     * reason.
     *
     * The five phases are emitted around work that takes no time, exactly as
     * {@link marketplace_feed_refresh}'s two are: what they prove is that the **wiring** is real
     * — that a listener registered by `useOracleTagProgress` hears `oracle-tags:progress` with
     * the right payload — not that a bar can be watched moving. A story that wants to watch one
     * emits the event itself, which is also how it stands in for the refresh
     * `refresh_if_due` starts at launch with nobody having pressed anything.
     */
    oracle_tags_refresh: (args: { force: boolean }): OracleTagStatus => {
      if (!args.force && !isTaxonomyStale(db.oracleTagMeta?.checkedAt ?? null, CLOCK_BASE)) {
        return toTagStatus(db.oracleTagMeta);
      }
      emitFake("oracle-tags:progress", { phase: "checking", done: 0, total: 0 });
      if (db.fault === "oracleTagsFetchError") {
        // **The rows stay.** A failed fetch leaves the previous taxonomy exactly where it was —
        // stale categories beat none, and the type-line fallback is always available — so this
        // writes to `error_log` and to nothing else. `operation` names the dataset, which is
        // what lets a reader tell a tag failure from a card one in the same log.
        db.errorLog = [
          ...db.errorLog,
          {
            id: db.errorLog.length + 1,
            firstAt: CLOCK_BASE,
            lastAt: CLOCK_BASE,
            source: "scryfall_api",
            operation: "oracle_tags",
            kind: "timeout",
            message: "timed out after 30s",
            detail: null,
            count: 1,
          },
        ];
        emitFake("oracle-tags:progress", { phase: "error", done: 0, total: 0 });
        throw refuse(
          "The card tags could not be downloaded. Cards will be filed by type until the next " +
            "refresh.",
        );
      }
      emitFake("oracle-tags:progress", { phase: "downloading", done: 0, total: ORACLE_TAG_BYTES });
      emitFake("oracle-tags:progress", {
        phase: "downloading",
        done: ORACLE_TAG_BYTES,
        total: ORACLE_TAG_BYTES,
      });
      // Zeroes, and not a count of what was written: `refresh` hands `ingest_gz` a `&mut |_| {}`
      // and emits `("ingesting", 0, 0)` **once**. The ribbon draws an indeterminate bar for the
      // whole ingest because there is genuinely no number, and a fixture that invented one here
      // would be storying a bar the app cannot draw.
      emitFake("oracle-tags:progress", { phase: "ingesting", done: 0, total: 0 });
      // All four tables together, because one file writes all four and the swap is atomic: a
      // watermark with no taxonomy behind it is the state the backend goes out of its way never
      // to leave, since it is what makes the next check 304 past an empty database.
      db.oracleTags = oracleTagCards(db.cards);
      db.oracleTagTaxonomy = oracleTagRows();
      db.oracleTagParents = oracleTagEdges();
      db.oracleTagMeta = oracleTagMeta(CLOCK_BASE);
      emitFake("oracle-tags:progress", { phase: "done", done: 0, total: 0 });
      return toTagStatus(db.oracleTagMeta);
    },

    /**
     * `tags::art::art_tags_refresh` — {@link writeHandlers.oracle_tags_refresh} over the other
     * taxonomy, phase for phase and refusal for refusal.
     *
     * Two of its neighbour's properties are worth restating rather than assumed, because they are
     * what make this safe to call from a launch: **it does not honour `busy`** (the refresh opens
     * with a read and a network call, and only its ingest takes the write lock, so a running sync
     * delays it rather than refusing it at the door), and **`force` skips the weekly throttle and
     * nothing else** — a run that is not due answers the status it already had and emits no event,
     * which is why a story that wants the phases has to send `force: true`.
     *
     * The one figure that differs is the size: 12.5 MB against the oracle file's 5.85 MB, which is
     * the reason `tags::art::refresh_if_due` is emphatic that neither the launch, the card sync
     * nor the *oracle* refresh may ever wait on it.
     */
    art_tags_refresh: (args: { force: boolean }): TagStatus => {
      if (!args.force && !isTaxonomyStale(db.artTagMeta?.checkedAt ?? null, CLOCK_BASE)) {
        return toTagStatus(db.artTagMeta);
      }
      emitFake("art-tags:progress", { phase: "checking", done: 0, total: 0 });
      if (db.fault === "artTagsFetchError") {
        // **The rows stay.** A failed fetch leaves the previous taxonomy exactly where it was —
        // an art theme somebody is mid-deck on must not evaporate because a download timed out —
        // so this writes to `error_log` and to nothing else. `operation` names the dataset, which
        // is what lets a reader tell an art tag failure from an oracle one in the same log.
        db.errorLog = [
          ...db.errorLog,
          {
            id: db.errorLog.length + 1,
            firstAt: CLOCK_BASE,
            lastAt: CLOCK_BASE,
            source: "scryfall_api",
            operation: "art_tags",
            kind: "timeout",
            message: "timed out after 30s",
            detail: null,
            count: 1,
          },
        ];
        emitFake("art-tags:progress", { phase: "error", done: 0, total: 0 });
        throw refuse(
          "The art tags could not be downloaded. The Tags page will show what it already had " +
            "until the next refresh.",
        );
      }
      emitFake("art-tags:progress", { phase: "downloading", done: 0, total: ART_TAG_BYTES });
      emitFake("art-tags:progress", {
        phase: "downloading",
        done: ART_TAG_BYTES,
        total: ART_TAG_BYTES,
      });
      emitFake("art-tags:progress", { phase: "ingesting", done: 0, total: 0 });
      db.artTags = artTagIllustrations(db.cards);
      db.artTagTaxonomy = artTagRows();
      db.artTagParents = artTagEdges();
      db.artTagMeta = artTagMeta(CLOCK_BASE);
      emitFake("art-tags:progress", { phase: "done", done: 0, total: 0 });
      return toTagStatus(db.artTagMeta);
    },

    /**
     * `tags::muted::tag_mute` — stop offering a tag anywhere.
     *
     * A write on `AppState.db`, so it is refusable by a running sync like every other, and the
     * refusal comes **before** the two validations — that is the order the Rust has, because the
     * connection is taken before the arguments are looked at.
     *
     * **Keyed on `(namespace, tagId)` and idempotent by it**: muting an already-muted tag
     * refreshes the stored slug and the timestamp rather than adding a second row, which is what
     * makes a rename harmless.
     *
     * **A blank `tagId` is refused, and that refusal is load-bearing.** One `muted_tags` row with
     * an empty id would equal every un-refreshed `oracle_tags` row and take the entire oracle
     * taxonomy off the page, with no error raised and nothing in `error_log`. {@link tagVisible}
     * guards the read side against exactly that; this is the same fence at the only place the row
     * can be created, which is the honest place to stop it. Both sentences are the crate's,
     * verbatim.
     */
    tag_mute: (args: { namespace: string; tagId: string; slug: string }): void => {
      refuseIfBusy(db);
      if (args.namespace !== "art" && args.namespace !== "oracle") {
        throw refuse(
          `"${args.namespace}" is not a tag taxonomy this app knows. Expected "art" or "oracle".`,
        );
      }
      if (args.tagId === "") {
        throw refuse(
          "That tag has no Scryfall id yet, so it cannot be muted. Refresh the tag data first.",
        );
      }
      const held = db.mutedTags.find(
        (m) => m.namespace === args.namespace && m.tagId === args.tagId,
      );
      if (held) {
        held.slug = args.slug;
        held.mutedAt = CLOCK_BASE;
        return;
      }
      db.mutedTags = [
        ...db.mutedTags,
        {
          namespace: args.namespace,
          tagId: args.tagId,
          slug: args.slug,
          mutedAt: CLOCK_BASE,
        },
      ];
    },

    /**
     * `tags::muted::tag_unmute` — give a tag back.
     *
     * A tag that was never muted is **not** an error: the row is gone either way, and a Settings
     * list that raced a second window is not something to shout about.
     *
     * **Unlike {@link writeHandlers.tag_mute} this accepts a blank `tagId`**, and the asymmetry is
     * the point: a row with an empty id is unreachable by any tag it was meant to name, so the
     * only thing it can ever be is junk to delete. Refusing here would make the Settings list show
     * a row nothing could remove. It validates no namespace either, for the same reason.
     */
    tag_unmute: (args: { namespace: string; tagId: string }): void => {
      refuseIfBusy(db);
      db.mutedTags = db.mutedTags.filter(
        (m) => !(m.namespace === args.namespace && m.tagId === args.tagId),
      );
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
      // The same one page, cached whole — `check_inner` writes both keys from one response,
      // which is why a check is what refreshes the version history and nothing else is.
      db.update.history = db.update.remoteHistory;
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

    /**
     * `export::export_write_file` — the decklist text, at the path the reader named.
     *
     * **It takes no `AppState` in the crate and honours no `busy` here, and that is a fidelity
     * point rather than an omission.** Every other write in this table opens with
     * {@link refuseIfBusy} because it holds `AppState.db`; this one touches no database at all,
     * so a sync running underneath it cannot refuse it. A story that seeded `busy` to watch an
     * export fail would be watching a refusal the app cannot produce.
     *
     * **Nothing is stored, for {@link import_read_file}'s reason turned around.** There is
     * no disk here and no table this belongs in — the fake stores `cards` and the user's rows,
     * and an export is neither — so what a story can observe is exactly what the app can: that
     * the write was accepted, or the sentence it was refused with. `ExportDialog` draws no
     * confirmation on success by design, so "no `role="alert"` appeared" is the whole of the
     * happy path and is the right amount.
     *
     * The `exportWriteError` fault is the other branch, and the dialog stays open on it holding
     * the text — a refused save must not cost the reader something they can still copy.
     */
    export_write_file: (args: { path: string; contents: string }): void => {
      if (db.fault === "exportWriteError") throw refuse(exportDenied(args.path));
    },
  } satisfies Record<string, CommandHandler>;
}

/* --------------------------------------------------------------- the three plugins ---- */

/** Where a story's save dialog pretends to put a file — `SYNC_DATA_DIR`'s drive, since both
 *  are the same invented machine. */
const SAVE_DIR = "D:\\Storybook\\";

/**
 * The three Tauri **plugin** commands the page reaches, which are not this app's commands and
 * are not mirrored from `src-tauri/src` at all.
 *
 * They are here because the fake `invoke` is the whole IPC layer in Storybook: `copyText`,
 * `openExternal` and `ExportDialog`'s Save as… each go through a plugin wrapper that calls
 * `invoke` with one of these names, so without them every one of those presses is answered
 * `No fake handler registered for command "plugin:…"` — a rejection about the workbench's
 * plumbing, drawn in a `role="alert"` the app wrote for a rejection about the reader's disk.
 *
 * A third table rather than rows in either of the two above, for one reason each: they mirror
 * no Rust module, and `db.test.ts`'s busy sweep walks {@link writeHandlers} asserting that
 * everything in it can be refused by a running sync — which none of these can, because none of
 * them holds a connection.
 *
 * **`plugin:dialog|save` answers a path, and that is not the same decision as
 * `import_read_file` throwing.** Both stand in for a native window CDP cannot drive. The
 * difference is what would be invented: `open` + `read_import_file` would invent a *decklist*,
 * which is the entire subject of the screen it feeds, so a story built on one would be a story
 * about a thing that cannot happen. All this dialog produces is a **string naming a file**, and
 * the export it then writes is text the reader is already looking at — so a fixed directory
 * over the dialog's own `defaultPath` invents nothing about the export and makes the one
 * refusal that matters (`exportWriteError`) name a plausible file.
 */
export function pluginHandlers() {
  return {
    /**
     * `tauri-plugin-clipboard-manager`'s one granted command — `allow-write-text`, never the
     * read (`src/lib/clipboard.ts`).
     *
     * Accepted and **not stored**, because there is no clipboard here to hold it and no read
     * command to get it back with: this app grants `write_text` only, so a fake that kept the
     * string would offer a story a way to check something the app itself cannot ask. What a
     * story observes is what a reader observes — that the press was accepted, which for
     * `ExportDialog` is the `Copied.` line and for a menu row is the menu closing.
     */
    "plugin:clipboard-manager|write_text": (): void => undefined,

    /** `tauri-plugin-opener`'s `openUrl`, behind `src/lib/externalLinks.ts`. A no-op for
     *  `update_open_release_page`'s reason: it hands a URL to the OS, and there is no OS here
     *  to answer it. The URL is still *built* by the app, which is the half a story is about. */
    "plugin:opener|open_url": (): void => undefined,

    /**
     * The OS save dialog, answering a path under {@link SAVE_DIR}.
     *
     * The name is the dialog's own `defaultPath` — `ExportDialog` seeds it
     * `${suggestedFileName}.${EXPORT_FORMAT_EXTENSION[format]}`, so switching format really does
     * change the file this answers with, exactly as it does in the window.
     *
     * **`null` is the other real answer and is deliberately not reachable from a story.** A
     * cancelled save resolves `null`, and writing *that* to disk is the trap `ExportDialog`'s
     * own guard exists for — pinned in `ExportDialog.test.tsx`, where `save` is mocked
     * directly, because a `null` here would make every save story a story about Cancel.
     */
    "plugin:dialog|save": (args: { options?: { defaultPath?: string } }): string =>
      `${SAVE_DIR}${args.options?.defaultPath ?? "export.txt"}`,
  } satisfies Record<string, CommandHandler>;
}

/**
 * Reads ∪ writes ∪ the plugins: the whole command table, which is what a story registers.
 *
 * The first two halves close over the one `db`, so a write is visible to the next read — the
 * property that makes a story clickable rather than a snapshot. The third takes **no** store,
 * and that is the shape of what it is: three commands that mirror no table here and no module
 * in the crate, none of which can see the reader's rows or change them.
 */
export function allHandlers(db: FakeDb) {
  return {
    ...readHandlers(db),
    ...journalled(db, writeHandlers(db)),
    ...undoHandlers(db),
    ...pluginHandlers(),
  };
}

/**
 * The writes that record **no** undo step, and why each is on the list.
 *
 * `deck_create`, `deck_duplicate` and `deck_delete` are the crate's own carve-out: they are
 * gallery writes with no editor open, and undoing "this deck was born" means deleting the deck
 * the reader is standing in. The three folder writes record no history at all (a folder belongs
 * to no deck, and `deck_audit.deck_id` is NOT NULL), so there is nothing for a step to key on;
 * `deck_folder_delete` **does** record history and still gets no step — the crate argues that
 * one at its own definition, and the short form is that it changes N decks at once while a
 * cursor is per deck.
 *
 * `deck_set_view_state` is not here because it writes no history row either: looking at a deck
 * is not editing it, so the wrapper below files nothing for it without being told.
 */
const NO_UNDO_STEP: ReadonlySet<string> = new Set([
  "deck_create",
  "deck_duplicate",
  "deck_delete",
  "deck_folder_create",
  "deck_folder_rename",
  "deck_folder_move",
  "deck_folder_delete",
]);

/**
 * Every deck write, wrapped so it records an undo step exactly where its Rust twin does.
 *
 * **One wrapper rather than a line in fifteen handlers**, and the reason is the same one the
 * crate's `every_deck_write_leaves_exactly_one_audit_row` exists for: a write that silently
 * records nothing is the bug this feature is most likely to grow, and here a *new* deck write
 * is covered by construction rather than by somebody remembering.
 *
 * **The step is keyed to the last history row the call wrote**, which is what makes one press
 * one Ctrl+Z: `deck_update` with two changed fields writes two rows, and a cursor that could
 * land between them would put half a settings form back. A call that wrote no history row at
 * all — an untouched patch, a stepper landing on an already-empty slot — files nothing, because
 * a step for a change that did not happen is a press that appears to do nothing.
 *
 * **Known gap, and it is this fake's rather than this feature's**: the five card writes
 * (`deck_add_card`, `deck_set_card_quantity`, `deck_move_card`, `deck_swap_printing`,
 * `deck_category_clear`) record no history row here, though their Rust twins do and
 * `deck_audit.rs`'s `every_deck_write_leaves_exactly_one_audit_row` pins it. So Storybook's
 * history drawer has never listed a card add, and — consistently — its Undo button does not
 * offer to take one back. The app is unaffected; closing it means giving those five handlers a
 * `record(…)` call, which is a change to what the *history* stories draw and belongs with them.
 */
function journalled<T extends Record<string, (args: never) => unknown>>(db: FakeDb, writes: T): T {
  const wrapped: Record<string, (args: never) => unknown> = {};
  for (const [name, handler] of Object.entries(writes)) {
    if (NO_UNDO_STEP.has(name)) {
      wrapped[name] = handler;
      continue;
    }
    wrapped[name] = ((args: Record<string, unknown>) => {
      const deckId = deckOf(db, name, args);
      if (typeof deckId !== "number") return handler(args as never);
      const before = deckState(db, deckId);
      const written = db.deckAudit.length;
      const result = handler(args as never);
      const rows = db.deckAudit.slice(written);
      if (before !== null && rows.length > 0) {
        db.deckUndo.push({
          auditId: rows[rows.length - 1].id,
          deckId,
          before,
          after: deckState(db, deckId) as FakeDeckState,
          undoneAt: null,
        });
      }
      return result;
    }) as (args: never) => unknown;
  }
  return wrapped as T;
}

/**
 * Which deck a write is about, **before it runs**.
 *
 * Most deck commands carry a `deckId` and this is one property read. The rest are keyed by the
 * *row* they change — a category rename knows an id in `deck_categories`, a tag delete one in
 * `deck_tags` — and the crate resolves the owner from that row, which is the same lookup the
 * ownership fence in each of those handlers makes anyway. It has to happen **first**: after a
 * delete there is no row left to ask.
 *
 * `deck_update` is the odd one and is neither: its deck id is spelled `id`, because it is the
 * deck's own row it patches.
 */
function deckOf(db: FakeDb, name: string, args: Record<string, unknown>): number | undefined {
  if (typeof args?.deckId === "number") return args.deckId;
  const id = typeof args?.id === "number" ? args.id : undefined;
  if (id === undefined) return undefined;
  switch (name) {
    case "deck_update":
      return id;
    case "deck_category_rename":
    case "deck_category_set_active":
    case "deck_category_delete":
      return db.deckCategories.find((c) => c.id === id)?.deckId;
    case "deck_tag_update":
    case "deck_tag_delete":
      // **The argument's own `deckId`, not the tag's** — a tag has none since schema v21, and
      // both commands take one for exactly this: the deck the reader was standing in, which is
      // where the history row goes and which deck's undo stack the step joins.
      return typeof args?.deckId === "number" ? args.deckId : undefined;
    default:
      return undefined;
  }
}

/** One deck, copied out whole — or `null` for a deck that is not there. */
function deckState(db: FakeDb, deckId: number): FakeDeckState | null {
  const deck = db.decks.find((d) => d.id === deckId);
  if (!deck) return null;
  return {
    deck: { ...deck },
    cards: db.deckCards.filter((c) => c.deckId === deckId).map((c) => ({ ...c })),
    categories: db.deckCategories.filter((c) => c.deckId === deckId).map((c) => ({ ...c })),
    // **Every tag, not this deck's** — since schema v21 there is no such thing, and a tag write
    // is app-wide. A snapshot narrowed to one deck would let an undo leave another deck's label
    // renamed and call the deck restored.
    tags: db.deckTags.map((t) => ({ ...t })),
  };
}

/** Put one deck back to a recorded state. */
function restoreDeck(db: FakeDb, deckId: number, state: FakeDeckState): void {
  const at = db.decks.findIndex((d) => d.id === deckId);
  if (at >= 0) db.decks[at] = { ...state.deck };
  db.deckCards = [
    ...db.deckCards.filter((c) => c.deckId !== deckId),
    ...state.cards.map((c) => ({ ...c })),
  ];
  db.deckCategories = [
    ...db.deckCategories.filter((c) => c.deckId !== deckId),
    ...state.categories.map((c) => ({ ...c })),
  ];
  // The whole table, for the reason `deckState` records the whole table.
  db.deckTags = state.tags.map((t) => ({ ...t }));
}

/**
 * `deck_undo` — the cursor, and the two reversals.
 *
 * Outside {@link writeHandlers} because {@link journalled} wraps everything in there, and these
 * two must **not** record a step of their own: an undo is a deck write and belongs in the
 * history, but a reversal that were itself reversible would make Ctrl+Z twice toggle one change
 * instead of going back two. They are still refused by a running sync, like every other write.
 */
function undoHandlers(db: FakeDb) {
  return {
    /** The newest step of this deck still applied, and — for the id the caller hands in — the
     *  one it could put back. */
    deck_undo_state: (args: { deckId: number; redoId: number | null }) => {
      const undo = nextUndo(db, args.deckId);
      const redoStep =
        typeof args.redoId === "number"
          ? db.deckUndo.find(
              (s) => s.auditId === args.redoId && s.deckId === args.deckId && s.undoneAt !== null,
            )
          : undefined;
      return {
        undo: undo ? (auditById(db, undo.auditId) ?? null) : null,
        redo: redoStep ? (auditById(db, redoStep.auditId) ?? null) : null,
      };
    },

    deck_undo_apply: (args: { deckId: number; auditId: number }): void => {
      refuseIfBusy(db);
      const cursor = nextUndo(db, args.deckId);
      if (!cursor) throw refuse("There is nothing left to undo in this deck.");
      if (cursor.auditId !== args.auditId) {
        throw refuse(
          "That is not the most recent change any more — the deck has been edited since. " +
            "Open the history to see what happened.",
        );
      }
      restoreDeck(db, args.deckId, cursor.before);
      cursor.undoneAt = stamp(db);
      recordReversal(db, args.deckId, "undo", cursor.auditId);
    },

    deck_redo_apply: (args: { deckId: number; auditId: number }): void => {
      refuseIfBusy(db);
      const step = db.deckUndo.find(
        (s) => s.auditId === args.auditId && s.deckId === args.deckId,
      );
      if (!step || step.undoneAt === null) {
        throw refuse("That change has not been undone, so there is nothing to redo.");
      }
      restoreDeck(db, args.deckId, step.after);
      step.undoneAt = null;
      recordReversal(db, args.deckId, "redo", step.auditId);
    },
  };
}

/** The newest step of one deck that is still applied — `audit_id DESC`, `undone_at IS NULL`. */
function nextUndo(db: FakeDb, deckId: number): FakeDeckUndo | undefined {
  return [...db.deckUndo]
    .filter((s) => s.deckId === deckId && s.undoneAt === null)
    .sort((a, b) => b.auditId - a.auditId)[0];
}

function auditById(db: FakeDb, id: number): DeckAuditEntry | undefined {
  const row = db.deckAudit.find((a) => a.id === id);
  return row ? toDeckAudit(row) : undefined;
}

/**
 * The history row a reversal writes.
 *
 * **`kind: "deck"` and not a tenth audit kind** — `deck_audit.kind` carries a CHECK, SQLite
 * cannot alter one, and a tenth word would rebuild every reader's whole deck history for a
 * spelling. `delta` is negated on the way back so the day header's roll-up still adds up.
 */
function recordReversal(db: FakeDb, deckId: number, field: "undo" | "redo", of: number): void {
  const original = db.deckAudit.find((a) => a.id === of);
  const delta = original?.delta ?? 0;
  record(db, deckId, DECK_LEVEL, "deck", null, { field, of }, field === "undo" ? -delta : delta);
}
