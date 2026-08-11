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
  DeckCard,
  DeckCategory,
  DeckInput,
  DeckPatch,
  DeckRow,
  DeckTag,
  DeckVariant,
  EntryChange,
  EntryInput,
  EntryPatch,
  InstallKind,
  Printing,
  ReleaseInfo,
  SearchRequest,
  SearchSortKey,
  SetSummary,
  SwapResult,
  SyncOutcome,
  SyncStatus,
  UpdateAsset,
  UpdateStatus,
  WishInput,
  WishRow,
  WishlistQuery,
  WishlistSortKey,
} from "@/lib/ipc";
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

/** One row of `decks`. `coverKind`/`coverImagePath` are omitted: nothing reads them yet. */
export interface FakeDeck {
  id: number;
  name: string;
  formatKey: string;
  description: string | null;
  coverCardId: string | null;
  isBuilt: boolean;
  archived: boolean;
  updatedAt: number;
}

/**
 * One row of `deck_categories`: a named pile the user owns, and what schema v7 replaced the
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
 */
export type Fault =
  "busy" | "syncError" | "imageFailures" | "gone" | "updateAvailable" | "updateError";

export interface FakeDb {
  cards: FakeCard[];
  collectionEntries: FakeEntry[];
  wishlistEntries: FakeWish[];
  decks: FakeDeck[];
  deckCategories: FakeDeckCategory[];
  deckTags: FakeDeckTag[];
  deckCards: FakeDeckCard[];
  update: FakeUpdate;
  fault: Fault | null;
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
    deckCategories: [],
    deckTags: [],
    deckCards: [],
    update: defaultUpdate(),
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
    // `cmc` is REAL and nullable: a card with no cost matches no chip, and neither does a
    // fractional un-card cost.
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
  return true;
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

function toCardSummary(db: FakeDb, c: FakeCard): CardSummary {
  return {
    id: c.id,
    name: c.name,
    setCode: c.setCode,
    setName: c.setName,
    collectorNumber: c.collectorNumber,
    rarity: c.rarity,
    typeLine: c.typeLine,
    manaCost: c.manaCost,
    // The `price_usd` **column**: a display and sort fallback chain, never summed.
    priceUsd: c.priceUsd,
    layout: c.layout,
    oracleId: c.oracleId,
    finishes: c.finishes,
    ownedQuantity: ownedOfPrinting(db, c.id),
    wishlisted: wishlisted(db, c),
  };
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

function toCardDetail(c: FakeCard): CardDetail {
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
    prices: c.prices,
    finishes: c.finishes,
    imageStatus: c.imageStatus,
    faces: parseFaces(c.faces),
  };
}

function toPrinting(c: FakeCard): Printing {
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
    prices: c.prices,
    promo: c.promo,
    fullArt: c.fullArt,
    frameEffects: c.frameEffects,
    borderColor: c.borderColor,
    layout: c.layout,
  };
}

function toCollectionRow(e: FakeEntry, card: FakeCard | null): CollectionRow {
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
    unitPriceUsd: finishPriceUsd(card, e.finish),
    unitPriceEur: finishPriceEur(card, e.finish),
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

function toWishRow(db: FakeDb, w: FakeWish): WishRow {
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
    quantity: w.quantity,
    preferredFinish: w.preferredFinish,
    unitPriceUsd: finishPriceUsd(card, finish),
    unitPriceEur: finishPriceEur(card, finish),
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
  };
}

/**
 * `deck_meta::list_categories`' row: the category, and the two numbers a column heading wants
 * at the moment it is drawn.
 *
 * Both are scoped to the **variant that was asked for** and neither is a row count:
 * `card_count` is `sum(quantity)` over the copies filed here, and `total_price_usd` is the
 * nonfoil `usd` key of each printing's blob times its copies. A category holding nothing (or
 * nothing priced) reads `null` rather than `0`, because SQL's `sum()` of no non-NULL terms is
 * NULL — and "nothing here has a price" is a different statement from "this is free".
 */
function toDeckCategory(db: FakeDb, c: FakeDeckCategory, variant: DeckVariant): DeckCategory {
  const rows = db.deckCards.filter((dc) => dc.categoryId === c.id && dc.variant === variant);
  const priced = rows
    .map((dc) => {
      const unit = priceKey(cardById(db, dc.cardId), "usd");
      return unit === null ? null : unit * dc.quantity;
    })
    .filter((n): n is number => n !== null);
  return {
    id: c.id,
    deckId: c.deckId,
    name: c.name,
    kind: c.kind,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    cardCount: rows.reduce((n, dc) => n + dc.quantity, 0),
    totalPriceUsd: priced.length === 0 ? null : priced.reduce((n, p) => n + p, 0),
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
    // Printed at uncommon on **any** printing of this oracle card, which is Pauper Commander
    // eligibility. Read off the column, never recomputed over `db.cards`: the generator took
    // it from the full 116 k-row corpus, and re-deriving it would make a fact about the
    // *card* into a fact about the 43-row fixture. Delver of Secrets is the row that proves
    // it — `everUncommon: true`, and the only Delver printing here is the `isd` common, so a
    // recomputation answers `false` and a legal commander renders ineligible. `false` for an
    // orphan, because nothing is known about a card that is not there.
    everUncommon: card?.everUncommon ?? false,
    // The nonfoil `usd` key: a deck names a printing, not a finish, and nonfoil is the
    // cheapest way to satisfy it. Never the `price_usd` column.
    unitPriceUsd: priceKey(card, "usd"),
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
const SEARCH_SORTS: Readonly<Record<SearchSortKey, SortColumn<FakeCard>>> = {
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
  // The `price_usd` **column** — the fallback chain a search row shows — never a finish's
  // price out of the `prices` blob. `search.rs` selects the column and does not read the blob.
  price: nullsLast((c) => c.priceUsd, numeric),
};

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
): Compare<FakeEntry> {
  const cards = new Map(rows.map((e) => [e.id, cardById(db, e.cardId)]));
  /** `coalesce(c.name, e.card_id)`: an orphan sorts under its card id rather than at the top
   *  under an empty string. */
  const name = (e: FakeEntry) => cards.get(e.id)?.name ?? e.cardId;
  /** `FINISH_PRICE_USD`: this row's finish, out of the blob. */
  const unitPrice = (e: FakeEntry) => finishPriceUsd(cards.get(e.id) ?? null, e.finish);
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
): Compare<FakeWish> {
  const ownedBy = new Map(rows.map((w) => [w.id, ownedAgainstWish(db, w)]));
  const priceBy = new Map(
    rows.map((w) => [w.id, finishPriceUsd(wishCard(db, w), w.preferredFinish ?? "nonfoil")]),
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
      // The count stops at the cap rather than walking the table on every keystroke.
      const counted = Math.min(matched.length, TOTAL_CAP + 1);
      // `SEARCH_SORTS` over the browse order, with `c.id ASC` appended. Simplification 1 is
      // the one place this parts from `run_search`, and only on the **default**: the real
      // fallback under text is `bm25(cards_fts, 10.0, 1.0, 1.0) ASC, c.name ASC`, and there
      // is no FTS index here to rank with, so a text search lands in the browse's name order.
      const sorted = [...matched].sort(
        orderBy(req.sort, SEARCH_SORTS, SEARCH_BROWSE_ORDER, (a, b) => cmp(a.id, b.id)),
      );
      return {
        items: sorted.slice(req.offset, req.offset + limit).map((c) => toCardSummary(db, c)),
        total: Math.min(counted, TOTAL_CAP),
        totalIsCapped: counted > TOTAL_CAP,
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

    /** `card::get_card` — **not** filtered to paper, unlike the printings list: an id asked
     *  for by name has to resolve, and a digital printing is reachable from a search with
     *  `paperOnly` off. */
    card_detail: (args: { id: string }): CardDetail | null => {
      const card = cardById(db, args.id);
      return card ? toCardDetail(card) : null;
    },

    /** `card::list_printings`: every **paper** printing of one oracle card, newest first,
     *  capped with an uncapped count so a truncated list can say what it truncates. */
    card_printings: (args: { oracleId: string }) => {
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
      return { items: all.slice(0, MAX_PRINTINGS).map(toPrinting), total: all.length };
    },

    /** `collection::list_entries`. */
    collection_list: (args: { query: CollectionQuery }) => {
      const q = args.query;
      const rows = collectionScope(db, q);
      const limit = pageLimit(q.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const sorted = [...rows].sort(collectionOrder(db, rows, q.sort));
      return {
        items: sorted
          .slice(q.offset, q.offset + limit)
          .map((e) => toCollectionRow(e, cardById(db, e.cardId))),
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
      const rows = collectionScope(db, args.query);
      const priced = rows.map((e) => {
        const card = cardById(db, e.cardId);
        return { e, usd: finishPriceUsd(card, e.finish), eur: finishPriceEur(card, e.finish) };
      });
      const sum = (f: (r: (typeof priced)[number]) => number) =>
        priced.reduce((n, r) => n + f(r), 0);
      return {
        // Copies, not rows — a row emptied to zero contributes 0.
        totalCards: sum((r) => r.e.quantity),
        // Printings **recorded**, not printings currently held: a zero row still counts.
        uniqueCards: new Set(rows.map((e) => e.cardId)).size,
        entries: rows.length,
        tradelistCards: sum((r) => r.e.tradelistQuantity),
        valueUsd: sum((r) => r.e.quantity * (r.usd ?? 0)),
        valueEur: sum((r) => r.e.quantity * (r.eur ?? 0)),
        // Copies with no price for their finish: a total that silently omits 400 cards is a
        // number that lies by rounding down.
        unpricedUsd: sum((r) => (r.usd === null ? r.e.quantity : 0)),
        unpricedEur: sum((r) => (r.eur === null ? r.e.quantity : 0)),
        needsReview: rows.filter((e) => e.needsReview !== null).length,
      };
    },

    /** `wishlist::list_wishes`. */
    wishlist_list: (args: { query: WishlistQuery }) => {
      const q = args.query;
      const rows = wishlistScope(db, q);
      const limit = pageLimit(q.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const sorted = [...rows].sort(wishlistOrder(db, rows, q.sort));
      return {
        items: sorted.slice(q.offset, q.offset + limit).map((w) => toWishRow(db, w)),
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
    deck_get: (args: { id: number; variant: DeckVariant }) => {
      const variant = validVariant(args.variant);
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
          return category ? [toDeckCard(db, dc, category, owned.get(dc.id) ?? 0)] : [];
        });
      const categories: DeckCategory[] = db.deckCategories
        .filter((c) => c.deckId === deck.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((c) => toDeckCategory(db, c, variant));
      const tags: DeckTag[] = db.deckTags
        .filter((t) => t.deckId === deck.id)
        .sort((a, b) => cmp(a.name, b.name) || a.id - b.id)
        .map((t) => toDeckTag(db, t, variant));
      return { deck: toDeckRow(db, deck), cards, categories, tags };
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
/** `deck::DEFAULT_FORMAT` — `decks.format_key`'s own DDL default, so a blank key means here
 *  exactly what it means in SQL. */
const DEFAULT_FORMAT = "casual";
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
 *    three the v7 DDL cascades from `decks`. It also cascades to `deck_allocations`, and
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
        isBuilt: false,
        archived: false,
        updatedAt: stamp(db),
      };
      db.decks.push(row);
      ensurePredefinedCategories(db, row.id);
      return toDeckRow(db, row);
    },

    /**
     * `deck::update_deck` — rename, re-format, cover, build and archive all arrive here.
     *
     * `coalesce(?n, column)`, so absent means "leave it" and there is no field that *clears*
     * one: `description: ""` writes an empty string rather than a NULL, and `coverCardId`
     * cannot be unset. Sending `isBuilt` reallocates in the app; here the next `deck_get`
     * does that work, so the flag is all this has to write.
     */
    deck_update: (args: { id: number; patch: DeckPatch }): DeckRow => {
      refuseIfBusy(db);
      const patch = args.patch;
      const name = patch.name === undefined ? undefined : validName(patch.name);
      const formatKey = patch.formatKey === undefined ? undefined : validFormat(patch.formatKey);
      const deck = requireDeck(db, args.id);
      deck.name = name ?? deck.name;
      deck.formatKey = formatKey ?? deck.formatKey;
      deck.description = patch.description ?? deck.description;
      deck.coverCardId = patch.coverCardId ?? deck.coverCardId;
      deck.isBuilt = patch.isBuilt ?? deck.isBuilt;
      deck.archived = patch.archived ?? deck.archived;
      deck.updatedAt = stamp(db);
      return toDeckRow(db, deck);
    },

    /** `deck::delete_deck`. **This one really deletes** — the deck, its cards, its categories
     *  and its tags, by cascade. Archiving is the soft path, and it is what a gallery's
     *  "remove" should reach for. */
    deck_delete: (args: { id: number }): void => {
      refuseIfBusy(db);
      db.decks = db.decks.filter((d) => d.id !== args.id);
      db.deckCards = db.deckCards.filter((dc) => dc.deckId !== args.id);
      db.deckCategories = db.deckCategories.filter((c) => c.deckId !== args.id);
      db.deckTags = db.deckTags.filter((t) => t.deckId !== args.id);
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
