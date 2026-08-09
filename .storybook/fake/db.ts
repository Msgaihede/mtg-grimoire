/**
 * The fake backend's store: **table rows**, and the read handlers that derive the DTOs from
 * them exactly as `src-tauri/src` does.
 *
 * Rows, not DTOs, and the whole design turns on one field. `ownedQuantity` appears on three
 * DTOs in `src/lib/ipc.ts` and answers three different questions: on `CardSummary` it is
 * every copy of one *printing* and finish-blind; on `WishRow` it is the copies filling one
 * *wish* and finish-aware; on `DeckCard` it is one deck's *allocation* — oracle-grained,
 * finish-blind, condition-blind, and never claimed for the `maybe` zone. A fixture that
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
 *    The collection's text filter is the same substring but reaches through the card, which
 *    keeps `list_entries`' real property that an orphan matches no text at all; the
 *    wishlist's is over the wish's own stored `name`, as its `LIKE` is.
 * 2. **The allocator runs on read**, inside {@link readHandlers}'s `deck_get`. In the app
 *    `deck::allocate_deck` writes `deck_allocations` rows on a zone write, the Built toggle
 *    or `missing_to_wishlist`, and the read only *attributes* what was stored. There is no
 *    allocations table here, so both halves happen at read time; see `allocate` below for
 *    what that changes and what it does not.
 * 3. **`list_sets` is derived from the cards**, because there is no `sets` table in the
 *    fixture. The real one reads every set Scryfall knows, so it can answer a set with no
 *    printings at all; this one cannot produce a set with no rows, only one whose rows are
 *    all digital.
 * 4. **`collection_list`'s `sort: "added"` orders by row id**, because `FakeEntry` carries no
 *    `created_at`. `e.created_at DESC, e.id DESC` is what `collection.rs` writes; `id DESC`
 *    is its tiebreaker and is monotonic with insertion order in a hand-seeded fixture.
 * 5. **Prices come out of the blob with `Number`**, where SQLite writes
 *    `CAST(json_extract(…) AS REAL)`. The two differ only on a value that is neither a
 *    decimal string nor null (SQLite answers `0.0`, this answers `null`), which the blobs
 *    Scryfall publishes do not contain.
 *
 * Nothing here is `async`: these are synchronous functions, and the fake `invoke` in
 * `core.ts` is what makes a command a promise. That keeps `db.test.ts` free of `await` on
 * assertions that are really about arithmetic.
 */
import { CARDS, type FakeCard } from "./cards";
import type { CommandHandler } from "./core";
import { SPECS } from "@/features/decks/validation/fixtures";
import type {
  CardDetail,
  CardFace,
  CardFilters,
  CardSummary,
  CollectionQuery,
  CollectionRow,
  DeckCard,
  DeckRow,
  DeckZone,
  Printing,
  SearchRequest,
  SetSummary,
  WishRow,
  WishlistQuery,
} from "@/lib/ipc";

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

/** One row of `deck_cards`. Grain `(deckId, cardId, zone)`; `quantity > 0` by CHECK. */
export interface FakeDeckCard {
  id: number;
  deckId: number;
  cardId: string;
  zone: DeckZone;
  quantity: number;
  /** Denormalised, like the collection's — the one name an orphaned row still has. */
  name: string;
  setCode: string;
  collectorNumber: string;
  lang: string;
  needsReview: string | null;
}

/**
 * A state the backend can be in that is not a row.
 *
 * `gone` is the deck a gallery asks for after another view deleted it. `syncError` and
 * `imageFailures` are the two things `SyncStatus` reports that no other surface shows.
 * `busy` is `collection::BUSY` — **and no read here honours it**, deliberately: writes take
 * `AppState.db` and can be refused, reads go through `db_read` and answer through every
 * second of a sync. Task 5's writes are what read it.
 */
export type Fault = "busy" | "syncError" | "imageFailures" | "gone";

export interface FakeDb {
  cards: FakeCard[];
  collectionEntries: FakeEntry[];
  wishlistEntries: FakeWish[];
  decks: FakeDeck[];
  deckCards: FakeDeckCard[];
  fault: Fault | null;
}

/**
 * A store, defaulting to the whole card corpus and nothing owned.
 *
 * `cards` is the shared `CARDS` array by reference rather than a copy: `cards` is the sync's
 * table, no write in this fake ever touches it, and a story that wants a different corpus
 * passes its own.
 */
export function makeDb(init: Partial<FakeDb> = {}): FakeDb {
  return {
    cards: CARDS,
    collectionEntries: [],
    wishlistEntries: [],
    decks: [],
    deckCards: [],
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

/** `x DESC NULLS LAST`, for the two nullable sort keys (`price_usd`, `unit_price_usd`). */
function descNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
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
 * `instr(coalesce(NULL,''),'W') = 0` is **true**, so an orphan passes it. `card.rs`'s
 * summary that "an orphan simply fails them" is one filter out of date; this follows the SQL.
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
const FINISHES = ["nonfoil", "foil", "etched"];
const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];

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
function wishCard(db: FakeDb, w: FakeWish): FakeCard | null {
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

/** `deck::ZONE_PRIORITY` — a permutation of the schema's five zones, with the scratchpad
 *  last because it is the pile the allocator never claims for. */
const ZONE_PRIORITY: DeckZone[] = ["commander", "main", "side", "companion", "maybe"];
const MAYBE: DeckZone = "maybe";
/** `DeckRow.cardCount`'s definition, and the engine's `SIZE_ZONES` verbatim. */
const SIZE_ZONES: DeckZone[] = ["main", "commander"];

function zoneRank(zone: DeckZone): number {
  const i = ZONE_PRIORITY.indexOf(zone);
  return i < 0 ? ZONE_PRIORITY.length : i;
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
    cardCount: db.deckCards
      .filter((dc) => dc.deckId === d.id && SIZE_ZONES.includes(dc.zone))
      .reduce((n, dc) => n + dc.quantity, 0),
    updatedAt: d.updatedAt,
  };
}

/**
 * `deck::allocate_deck`, run at read time: copies of each oracle card this deck secures,
 * keyed by collection entry id.
 *
 * Greedy in `ZONE_PRIORITY` order over the deck's cards, **never `maybe`**: for each one, the
 * entries of the same *oracle* card — a Bolt is a Bolt — taking the exact printing first,
 * real copies before proxies, then the oldest entry, and never more than the entry still has
 * free. One candidate pool per oracle card, drawn down as the walk spends it, so two zones
 * wanting the same card cannot both be told the same copies are free.
 *
 * Availability is `entry.quantity` minus the claims of **other built** decks — the whole of
 * what `is_built` means. A deck is never blocked by its own claims, which is why the real one
 * deletes them before counting and why `exclude` is passed here.
 *
 * **What allocating on read changes.** In the app those other decks' claims are *stored*
 * rows, written when each deck was last touched, so two built decks sharing a card can each
 * hold a claim made when the other's was different (`DeckCard.ownedQuantity` says so in its
 * own doc). Here they are recomputed, in deck-id order against one running pool, so they are
 * consistent with each other in a way the app does not promise. A story about *stale* claims
 * is therefore the one thing this cannot stage.
 */
function allocate(db: FakeDb, deckId: number): Map<number, number> {
  if (!db.decks.some((d) => d.id === deckId)) return new Map();

  // Claims already held by the other built decks, computed in id order so the result does
  // not depend on the order `decks` was seeded in.
  const claimed = new Map<number, number>();
  for (const other of [...db.decks]
    .filter((d) => d.isBuilt && d.id !== deckId)
    .sort((a, b) => a.id - b.id)) {
    for (const [entryId, n] of allocateAgainst(db, other.id, claimed)) {
      claimed.set(entryId, (claimed.get(entryId) ?? 0) + n);
    }
  }
  return allocateAgainst(db, deckId, claimed);
}

/** The greedy walk itself, against an availability baseline. Split out only so the
 *  other-built-decks pass above can reuse it without recursing back into itself. */
function allocateAgainst(
  db: FakeDb,
  deckId: number,
  claimed: Map<number, number>,
): Map<number, number> {
  const taken = new Map<number, number>();
  // An INNER JOIN on `cards`: an orphaned row names no oracle card, so it is listed and
  // flagged and reads owned 0 until a sync gives it its identity back.
  const wants = db.deckCards
    .filter((dc) => dc.deckId === deckId && dc.zone !== MAYBE)
    .map((dc) => ({ row: dc, card: cardById(db, dc.cardId) }))
    .filter((w): w is { row: FakeDeckCard; card: FakeCard } => w.card !== null)
    .sort((a, b) => zoneRank(a.row.zone) - zoneRank(b.row.zone) || a.row.id - b.row.id);

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
 * `deck::owned_by_oracle` then `deck::attribute_owned`: total the claims per oracle card,
 * then hand them to the rows that wanted them.
 *
 * The `min(a.quantity, e.quantity)` clamp is carried across because it is the rule — a deck
 * that reserved four copies of a row the user has since stepped to one owns one of them —
 * even though it can never bind here: nothing is stored between the allocation and the read,
 * so a claim cannot be stale. It is the app's answer to a collection that shrank under it.
 *
 * Attribution walks `ZONE_PRIORITY` then row id, which is the read's own order and not the
 * caller's: the number a row shows must not depend on how the list was displayed.
 */
function attributeOwned(
  db: FakeDb,
  rows: FakeDeckCard[],
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
  const order = [...rows].sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone) || a.id - b.id);
  for (const row of order) {
    const oracleId = cardById(db, row.cardId)?.oracleId;
    if (!oracleId) {
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

function toDeckCard(db: FakeDb, dc: FakeDeckCard, ownedQuantity: number): DeckCard {
  const card = cardById(db, dc.cardId);
  return {
    id: dc.id,
    cardId: dc.cardId,
    zone: dc.zone,
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
    // Printed at uncommon on **any** printing of this oracle card — computed, not read, and
    // `false` for an orphan, because nothing is known about a card that is not there.
    everUncommon:
      card !== null &&
      db.cards.some((c) => c.oracleId === card.oracleId && c.rarity === "uncommon"),
    // The nonfoil `usd` key: a deck names a printing, not a finish, and nonfoil is the
    // cheapest way to satisfy it. Never the `price_usd` column.
    unitPriceUsd: priceKey(card, "usd"),
    ownedQuantity,
  };
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
/** 2026-08-09T09:00:00Z, as unix seconds in a string — the column's own type. */
const SYNC_LAST_CHECK_AT = "1786266000";
/** Scryfall regenerates `default_cards` in a 21:00–21:45 UTC window, so the ingested file is
 *  from the evening before the check above. */
const SYNC_BULK_UPDATED_AT = "2026-08-08T21:16:00.000Z";
/** `scryfall.rs`'s own wording for the failure a reader is most likely to hit. */
const SYNC_ERROR = "rate limited by Scryfall; retry after 30s";
/** Enough to be a number rather than a flag, which is how the ribbon reads it. */
const IMAGE_STORE_FAILURES = 7;

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
      const sorted = [...matched].sort((a, b) => {
        switch (req.sort) {
          case "released":
            return cmp(b.releasedAt, a.releasedAt) || cmp(a.name, b.name) || cmp(a.id, b.id);
          case "price":
            return descNullsLast(a.priceUsd, b.priceUsd) || cmp(a.name, b.name) || cmp(a.id, b.id);
          // Name order, which is also where a text search lands here — see simplification 1.
          default:
            return cmp(a.name, b.name) || cmp(b.releasedAt, a.releasedAt) || cmp(a.id, b.id);
        }
      });
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
      // `CAST(collector_number AS INTEGER)` first — `order_by`'s reason is that a large
      // minority of collector numbers are not numeric (`741z`, `1★`, `A-123`) and a plain
      // string sort puts `100` before `2`. `parseInt` matches the CAST on both: a leading
      // integer wins, and a value with none is 0.
      const num = (s: string) => Number.parseInt(s, 10) || 0;
      const name = (e: FakeEntry) => cardById(db, e.cardId)?.name ?? e.cardId;
      const sorted = [...rows].sort((a, b) => {
        switch (q.sort) {
          case "set":
            return (
              cmp(a.setCode, b.setCode) ||
              num(a.collectorNumber) - num(b.collectorNumber) ||
              cmp(a.collectorNumber, b.collectorNumber) ||
              a.id - b.id
            );
          // Simplification 4: no `created_at` column, so its tiebreaker stands alone.
          case "added":
            return b.id - a.id;
          case "quantity":
            return b.quantity - a.quantity || cmp(name(a), name(b)) || a.id - b.id;
          case "price":
            return (
              descNullsLast(
                finishPriceUsd(cardById(db, a.cardId), a.finish),
                finishPriceUsd(cardById(db, b.cardId), b.finish),
              ) ||
              cmp(name(a), name(b)) ||
              a.id - b.id
            );
          // Name order, with the orphans under their card id rather than at the top under
          // an empty string.
          default:
            return (
              cmp(name(a), name(b)) ||
              cmp(a.setCode, b.setCode) ||
              num(a.collectorNumber) - num(b.collectorNumber) ||
              a.id - b.id
            );
        }
      });
      return {
        items: sorted
          .slice(q.offset, q.offset + limit)
          .map((e) => toCollectionRow(e, cardById(db, e.cardId))),
        // Counted in full: a collection is thousands of rows, not the 116 k the search caps.
        total: rows.length,
      };
    },

    /** `collection::summarise`, over the *same* rows the list is showing. */
    collection_summary: (args: { query: CollectionQuery }) => {
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
      const unitPrice = (w: FakeWish) =>
        finishPriceUsd(wishCard(db, w), w.preferredFinish ?? "nonfoil");
      const sorted = [...rows].sort((a, b) => {
        switch (q.sort) {
          case "added":
            return b.id - a.id;
          case "price":
            return descNullsLast(unitPrice(a), unitPrice(b)) || cmp(a.name, b.name) || a.id - b.id;
          case "quantity":
            return b.quantity - a.quantity || cmp(a.name, b.name) || a.id - b.id;
          default:
            return cmp(a.name, b.name) || a.id - b.id;
        }
      });
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
     * One command rather than three, because the editor and the validation engine ask the
     * same question and a screen whose curve, legality panel and owned badges come from
     * three queries is a screen whose three answers can disagree.
     */
    deck_get: (args: { id: number }) => {
      if (db.fault === "gone") return null;
      const deck = db.decks.find((d) => d.id === args.id);
      if (!deck) return null;
      const rows = db.deckCards.filter((dc) => dc.deckId === deck.id);
      const owned = attributeOwned(db, rows, allocate(db, deck.id));
      const cards = [...rows]
        // Zone order, then the name the *row* carries — which an orphan has and its card
        // does not — then row id.
        .sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone) || cmp(a.name, b.name) || a.id - b.id)
        .map((dc) => toDeckCard(db, dc, owned.get(dc.id) ?? 0));
      return { deck: toDeckRow(db, deck), cards };
    },

    /**
     * `deck::list_format_specs`, served from the validation fixtures.
     *
     * **`SPECS` and no second copy**: `fixtures.ts` is already a hand-copied mirror of
     * `schema.rs`'s `FORMAT_SPECS_SEED`, and a second mirror is a second place for a cell to
     * drift. It carries **12** of the 25 seeded rows (measured 2026-08-09) — the formats the
     * engine tests need — so a picker in a story offers 12 formats and not 24.
     */
    format_specs_list: () => Object.values(SPECS).sort((a, b) => a.sortOrder - b.sortOrder),

    /** `sync::status`. */
    sync_status: () => ({
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
