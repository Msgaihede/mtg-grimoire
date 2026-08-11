/**
 * The only place the frontend names a Tauri command or an event.
 *
 * Every type here is a hand-written mirror of a `#[serde(rename_all = "camelCase")]`
 * struct in `src-tauri/src`, so the two can drift silently — a renamed field becomes an
 * `undefined` the compiler is happy with. Rust pins its side in
 * `sync::tests::dto_json_uses_the_camel_case_names_the_frontend_expects`; this side is
 * pinned by `ipc.test.ts` for the argument names, which are the other half of the
 * contract (`invoke` matches them by name, and a typo is a runtime rejection).
 *
 * Sources, verified field by field:
 * `SearchRequest`/`CardSummary`/`SearchResponse`/`SetSummary` — `src-tauri/src/search.rs`
 * `CardFace`/`CardDetail`/`Printing`/`PrintingsResponse`      — `src-tauri/src/card.rs`
 * `SyncOutcome`/`SyncStatus`/`Progress`          — `src-tauri/src/sync.rs`
 * `EntryInput`/`EntryPatch`/`EntryChange`/`CollectionQuery`/`CollectionRow`/
 * `CollectionPage`/`CollectionSummary`           — `src-tauri/src/collection.rs`
 * `WishInput`/`WishlistQuery`/`WishRow`/`WishlistPage` — `src-tauri/src/wishlist.rs`
 * `DeckInput`/`DeckPatch`/`DeckRow`/`DeckCardRow`/`DeckDetail`/
 * `FormatSpecRow`                                — `src-tauri/src/deck.rs`
 * `CardFilters`, flattened into both list queries — `src-tauri/src/filters.rs`
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Condition } from "./conditions";
import type { Finish } from "./finish";
import type { ImageVariant } from "./images";
import type { SortSpec } from "./sort";

/**
 * The search table's sortable columns. Mirrors `SEARCH_SORTS` in `src-tauri/src/search.rs`;
 * a key that is not there is dropped at the far end, which is a header that does nothing.
 */
export type SearchSortKey = "name" | "set" | "type" | "rarity" | "price";

/**
 * The collection's sortable columns.
 *
 * `value` and `price` are two questions about the one Value column: `value` is what the row
 * is worth (unit × copies — the figure the cell prints, and what its header sorts by), and
 * `price` what one copy costs. `added` has no column at all. Both of the latter are
 * reachable only from the filter bar's select. Mirrors `COLLECTION_SORTS` in
 * `src-tauri/src/collection.rs`.
 */
export type CollectionSortKey =
  "name" | "set" | "finish" | "quantity" | "value" | "price" | "added";

/**
 * The wishlist's sortable columns.
 *
 * There is no `set`: an any-printing wish names no set, so the Printing column is not
 * sortable at all. `cost` is what finishing a wish still costs — unit × copies still
 * missing, which is the figure the Cost cell prints. Mirrors `WISHLIST_SORTS` in
 * `src-tauri/src/wishlist.rs`.
 */
export type WishlistSortKey = "name" | "owned" | "quantity" | "cost" | "price" | "added";

/**
 * A search as the UI asks for it.
 *
 * Rust carries `#[serde(default)]`, so *every* field is optional on the wire — but
 * `limit`/`offset` stay required here on purpose: an omitted `limit` silently becomes
 * the backend's default page size, which a pager that thinks it asked for 100 would
 * then mis-count. Call sites say what they want.
 */
export interface SearchRequest {
  /** Free text, prefix-matched against name, type line and oracle/face text. */
  text?: string;
  /** A `legalities` key (`"modern"`, `"vintage"`, …). `restricted` counts as playable. */
  format?: string;
  /** Colour identity, e.g. `"WU"`; `"C"` means colourless only. Subset semantics. */
  colors?: string;
  setCode?: string;
  /** Set codes. ORed with each other, ANDed with every other filter. */
  sets?: string[];
  /** Mana-value chips: 0–7 match exactly, 8 means "8 or more". */
  manaValues?: number[];
  rarity?: string;
  /** Omitted means true: digital-only printings are hidden unless asked for. */
  paperOnly?: boolean;
  /**
   * `true` narrows to printings the collection has an entry for, `false` to those it does
   * not.
   *
   * **An entry, not a copy.** A row emptied to zero is a row the collection keeps, and this
   * filter counts it as owned — so a card whose only entry sits at zero passes `owned: true`
   * while its {@link CardSummary.ownedQuantity} reads `0`, and does *not* appear under
   * `owned: false`. The wishlist's `fulfilled` filter is the one that counts copies, because
   * a wish is filled by copies rather than by paperwork.
   */
  owned?: boolean;
  /**
   * How to order the page: columns in priority order, the first deciding and the rest
   * breaking its ties. Empty or absent is the default — relevance when `text` is set, name
   * order when it is not.
   */
  sort?: SortSpec<SearchSortKey>;
  /**
   * Fold every printing of one card into a single row, represented by the newest printing.
   *
   * Absent means false, which is what this command has always answered. A **view mode**
   * rather than a filter — see `useCardSearch`, where it is deliberately outside
   * `activeFilterCount` and `resetAll`.
   */
  collapse?: boolean;
  /** Clamped to 200 by the backend; 0 means "use the default page size". */
  limit: number;
  offset: number;
}

/** One result row — the columns a card grid needs, not the whole card. */
export interface CardSummary {
  id: string;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  typeLine: string | null;
  manaCost: string | null;
  priceUsd: number | null;
  layout: string;
  /**
   * The oracle card this printing is of. `null` mirrors `cards.oracle_id`'s nullability and
   * nothing more — no live row is null, reversible cards included (Scryfall omits only the
   * *top-level* id and `card_row` falls back to `card_faces[0]`).
   *
   * Here so a result row can be wished for as *any* printing without opening the card first
   * — a wishlist usually means the card rather than the cardboard.
   */
  oracleId: string | null;
  /**
   * JSON: the finishes this printing exists in (`["nonfoil","foil"]`). Parse it with
   * `parseFinishes` from `@/lib/finish`; `null` means the column is empty, which is
   * "unknown" rather than "nonfoil".
   *
   * A quick-add from a result row offers exactly these. Without them the grid and the table
   * offered nonfoil for every card, and a foil-only printing took a nonfoil entry that then
   * priced through a `usd` key its blob does not have.
   */
  finishes: string | null;
  /**
   * Copies the collection holds of **this printing, across every finish and condition** —
   * a badge on a search result, and finish-*blind*.
   *
   * One of **three** fields in this file with this name, and no two answer the same question.
   * {@link WishRow.ownedQuantity} is counted against one wish and *is* finish-aware, so a
   * foil wish is not satisfied by the nonfoil in the binder; {@link DeckCard.ownedQuantity}
   * is neither — it is the copies one deck's allocator *secured*, oracle-grained and clamped
   * to what the entries still hold. Read each against its own row.
   *
   * `0` rather than `null`: "you own none of these" is a fact, not an absence, and a badge
   * that has to tell `null` from `0` is a badge with a bug waiting in it.
   */
  ownedQuantity: number;
  /** Whether a wish covers this printing — pinned to it, or unpinned on its oracle card. */
  wishlisted: boolean;
  /**
   * How many printings this row stands for — `1` when the search is not collapsed, because
   * a row is a printing then.
   *
   * Collapsed, it counts the printings that **matched the filters** rather than every
   * printing that exists: a search narrowed to one set reports the printings in that set.
   */
  printings: number;
  /**
   * Cheapest and dearest {@link CardSummary.priceUsd} among the printings this row stands
   * for; both equal it when the search is not collapsed. Render a range only when the two
   * differ — most cards have one printing, and `$2.15–$2.15` is noise.
   */
  priceLow: number | null;
  priceHigh: number | null;
}

/** A page of results plus the size of the whole match set, for the pager. */
export interface SearchResponse {
  items: CardSummary[];
  /**
   * Matches, counted no further than 5 000. Only meaningful together with
   * `totalIsCapped` — an exact count of a 116 k-row browse cost a full table scan on
   * every keystroke, so the backend stops early and says it did.
   */
  total: number;
  /**
   * The count hit its ceiling: there are `total` matches *or more*. A pager must keep
   * asking for pages while this is true (and stop on the first short page instead), and
   * a caption should read `5,000+`.
   */
  totalIsCapped: boolean;
}

/** One physical side of a card. Empty for single-faced printings. */
export interface CardFace {
  /**
   * `""` for a face whose blob carried no name. Rust defaults it rather than dropping the
   * face, because a flip control addresses faces by *index* and a dropped face silently
   * renumbers every face after it.
   */
  name: string;
  typeLine: string | null;
  oracleText: string | null;
  /** Absent *and* empty both mean "no cost" — a transform's back sends `""`. */
  manaCost: string | null;
  /** Per face: a double-faced card's two sides are not always the same illustrator. */
  artist: string | null;
}

/** Everything the detail pane renders about one printing. */
export interface CardDetail {
  id: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  layout: string;
  lang: string;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  illustrationId: string | null;
  /** Required by Scryfall's image policy wherever art is shown. */
  artist: string | null;
  releasedAt: string | null;
  /** JSON: 23 legality keys and growing. Parse it, never index fixed fields. */
  legalities: string | null;
  /** JSON: six keys, decimal **strings**. A finish price is a lookup in here. */
  prices: string | null;
  finishes: string | null;
  imageStatus: string | null;
  faces: CardFace[];
}

/** One row of the "all printings" list. */
export interface Printing {
  id: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  releasedAt: string | null;
  rarity: string | null;
  /** Two printings differ in *art* iff this differs. `variation` is 0.09% true and useless. */
  illustrationId: string | null;
  artist: string | null;
  /** Scryfall's two-letter code. Every language is listed; `en` is merely the common one. */
  lang: string;
  finishes: string | null;
  prices: string | null;
  promo: boolean;
  fullArt: boolean;
  frameEffects: string | null;
  borderColor: string | null;
  layout: string;
}

/**
 * A page of printings and the size of the list it was taken from.
 *
 * `card::list_printings` caps the page at 400 rows, so `items.length < total` is the whole
 * signal that a list was truncated — and the only thing standing between a caption reading
 * "400 printings" and the 862 paper printings Forest actually has.
 *
 * No `totalIsCapped` twin of {@link SearchResponse}'s, deliberately: that count scans
 * toward 116 k rows on every keystroke, while this one is narrowed by `idx_cards_oracle`
 * to a single card's printings, so it is counted in full every time.
 */
export interface PrintingsResponse {
  /** Newest first. Paper only — digital printings cannot be owned in paper and have no
   *  paper price, so the backend filters them out and the count agrees with the page. */
  items: Printing[];
  total: number;
}

/** One row of the set picker. */
export interface SetSummary {
  /** Lowercase, as `cards.set_code` stores it — this is what the filter sends back. */
  code: string;
  name: string;
  setType: string | null;
  releasedAt: string | null;
  /**
   * Paper printings of this set in the local database.
   *
   * `0` both for the sets `default_cards` omits entirely and for the Arena/MTGO ones the
   * search's `paperOnly` default hides — the two are indistinguishable to a picker, and
   * a row that can only ever return nothing should not be offered either way.
   */
  cardCount: number;
}

/**
 * The filters that are a statement about a *card*, shared by every list that has cards in
 * it — `filters::CardFilters`, which both list queries below `#[serde(flatten)]` into
 * themselves, so these sit inline on the payload rather than under a key.
 *
 * {@link SearchRequest} declares the same fields itself rather than extending this, because
 * Rust's `SearchRequest` does exactly that: it keeps them flat and hands a *copy* to the
 * filter builder. Two mirrors of two structs, not one mirror doing double duty.
 */
export interface CardFilters {
  /** Free text. The search prefix-matches it through FTS5; the wishlist `LIKE`s the name it
   *  stored, because a wish may have no card row to index. */
  text?: string;
  format?: string;
  /** Colour identity, e.g. `"WU"`; `"C"` means colourless only. Subset semantics. */
  colors?: string;
  setCode?: string;
  sets?: string[];
  /** 0–7 match exactly, 8 means "8 or more". */
  manaValues?: number[];
  rarity?: string;
  /** Omitted means true in the search and false in the collection: a search offers cards to
   *  own, a collection lists cards that are owned. */
  paperOnly?: boolean;
}

/**
 * One quick-add, as the popup sends it.
 *
 * `lang`, `setCode` and `collectorNumber` are deliberately absent: they are properties of
 * the printing, read from `cards` at write time, and letting a caller supply them would let
 * a caller disagree with the card it named.
 *
 * Every field is `#[serde(default)]` on the Rust side, but the three that identify what is
 * being added stay required here — an add with no card, no finish or no quantity is a write
 * the backend refuses in words, and it should not compile.
 */
export interface EntryInput {
  cardId: string;
  finish: Finish;
  /** Copies to add. Never `0`: adding nothing would conjure a row out of a card the user
   *  never said they had. Zero is a state a row is *moved* to, by `collectionSetQuantity`. */
  quantity: number;
  /** Defaults to `NM` — what an unmarked card is assumed to be. */
  condition?: Condition;
  /** What the user's file called that condition, kept because the normalisation is lossy. */
  conditionOriginal?: string;
  tradelistQuantity?: number;
  purchasePrice?: number;
  purchaseCurrency?: string;
  acquiredAt?: string;
  acquisitionSource?: string;
  serialNumber?: string;
  altered?: boolean;
  signed?: boolean;
  proxy?: boolean;
  misprint?: boolean;
  /** `{"company":"PSA","grade":"10","cert":"12345678"}` as JSON text. The backend parses and
   *  re-serialises it into canonical key order — two spellings of one slab would otherwise
   *  be two rows at the storage grain. An unknown key is refused, not dropped. */
  grading?: string;
  /** A JSON array of strings. */
  tags?: string;
  notes?: string;
}

/**
 * An edit to one existing row. Every field is optional: absent means "leave it".
 *
 * Absent and blank are *not* the same for most fields — but they are for
 * {@link EntryPatch.grading}, whose empty string reads as "no slab" and is therefore a
 * silent no-op rather than a clear. An entry editor that offers to remove a grading has
 * nothing here to do it with.
 */
export interface EntryPatch {
  finish?: Finish;
  condition?: Condition;
  /** Editable, because correcting a grade without correcting the record of what the file
   *  said would leave the row disagreeing with its own provenance. */
  conditionOriginal?: string;
  quantity?: number;
  tradelistQuantity?: number;
  purchasePrice?: number;
  purchaseCurrency?: string;
  acquiredAt?: string;
  acquisitionSource?: string;
  serialNumber?: string;
  altered?: boolean;
  signed?: boolean;
  proxy?: boolean;
  misprint?: boolean;
  grading?: string;
  tags?: string;
  notes?: string;
}

/**
 * What a write did.
 *
 * `removed` is the difference between "you now have zero" and "that row is gone", which the
 * list has to know to drop it — and the two tables answer it differently on the same input:
 * `collectionSetQuantity(id, 0)` keeps the row (it still holds a condition, a purchase price
 * and an acquisition story), while `wishlistSetQuantity(id, 0)` deletes it, because a wish
 * for none of something is not a wish.
 */
export interface EntryChange {
  id: number;
  quantity: number;
  removed: boolean;
}

/** A collection list, as the UI asks for it. */
export interface CollectionQuery extends CardFilters {
  /**
   * Ignored, and present only because the shared filter struct carries it: the collection
   * forces it off. The user owns what the user owns, and a paper test over a printing that
   * has left `cards` would throw away exactly the rows this list exists to keep showing.
   */
  paperOnly?: boolean;
  finishes?: Finish[];
  conditions?: Condition[];
  /** `true` narrows to the rows a Scryfall migration or a vanished printing flagged, `false`
   *  to those it did not touch — the complement is where a reader goes once the flagged ones
   *  are dealt with, so it is a real filter and reaches the wire as `false` rather than being
   *  dropped the way a blank string is. Absent asks nothing. */
  needsReview?: boolean;
  /** How to order the list, first column deciding. Empty or absent is name order. */
  sort?: SortSpec<CollectionSortKey>;
  /** Clamped to 500 by the backend; 0 means "use the default page size" (100). */
  limit: number;
  offset: number;
}

/**
 * One row of the collection table: the entry, plus whatever `cards` still knows about the
 * printing it names.
 *
 * Every `cards`-derived field is nullable — a row whose printing has left the database is
 * still a card the user owns. The entry's own columns (`setCode`, `collectorNumber`,
 * `lang`) never are: they were copied onto the row at write time for exactly this case.
 */
export interface CollectionRow {
  id: number;
  cardId: string;
  name: string | null;
  /** From the *entry*, not the card: this is what the user recorded owning. */
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  lang: string;
  rarity: string | null;
  manaCost: string | null;
  typeLine: string | null;
  layout: string | null;
  finish: string;
  condition: string;
  quantity: number;
  tradelistQuantity: number;
  /** Per copy, per finish, from the `prices` blob — never the derived `price_usd` column,
   *  which is a fallback chain and would price a plain copy at foil rates. */
  unitPriceUsd: number | null;
  /** The same in EUR, with the hole the data has: `eur_etched` does not exist, so an etched
   *  card is unpriced in euros rather than valued at the nonfoil rate. */
  unitPriceEur: number | null;
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
  /** A JSON array of strings, never null — the column defaults to `[]`. */
  tags: string;
  notes: string | null;
  /** A sentence when this row needs the user's attention, `null` otherwise. */
  needsReview: string | null;
  /** Unix seconds. */
  updatedAt: number;
}

export interface CollectionPage {
  items: CollectionRow[];
  /** Rows matching the filters, counted in full — a collection is thousands of rows, not
   *  the 116 k the search has to cap. No `totalIsCapped` twin, deliberately. */
  total: number;
}

/** The aggregate header, over the same filters as the list it captions. */
export interface CollectionSummary {
  /** Copies, not rows: a row emptied to zero contributes 0. */
  totalCards: number;
  /** Distinct printings **recorded**, not distinct printings currently held — a row taken to
   *  zero is still on the screen this number captions. */
  uniqueCards: number;
  entries: number;
  tradelistCards: number;
  valueUsd: number;
  valueEur: number;
  /** Copies with no price for their finish. Shown beside the value, because a total that
   *  silently omits 400 cards is a number that lies by rounding down. */
  unpricedUsd: number;
  unpricedEur: number;
  needsReview: number;
}

/**
 * One wish, as the UI sends it.
 *
 * Either identifier will do: `cardId` alone pins the wish to that printing and looks the
 * oracle id and name up from it; `oracleId` alone means "any printing", and needs a `name`
 * of its own when no printing of it is in the card database — a shopping list that cannot
 * say what it is shopping for is not a list.
 */
export interface WishInput {
  /** Absent means **any printing**, which is what a wishlist usually means. */
  cardId?: string;
  oracleId?: string;
  name?: string;
  quantity: number;
  /** A wish *for the foil* is a different wish from one for the nonfoil, and is not filled
   *  by it. Absent means no preference. */
  preferredFinish?: Finish;
  notes?: string;
}

export interface WishlistQuery extends CardFilters {
  /** Ignored, exactly as {@link CollectionQuery.paperOnly} is, and for the same reason. */
  paperOnly?: boolean;
  /** `true` shows only wishes the collection already covers, `false` only those it does not
   *  — "what is still missing" being the list's usual question. Counted in **copies**, and
   *  finish-aware. */
  fulfilled?: boolean;
  /** `true` narrows to the wishes a Scryfall migration or a vanished printing flagged — the
   *  reconciler walks this table too, so this is {@link CollectionQuery.needsReview}'s
   *  question asked of the other list. */
  needsReview?: boolean;
  /** How to order the list, first column deciding. Empty or absent is name order. */
  sort?: SortSpec<WishlistSortKey>;
  /** Clamped to 500 by the backend; 0 means "use the default page size" (100). */
  limit: number;
  offset: number;
}

export interface WishRow {
  id: number;
  oracleId: string | null;
  /** `null` = any printing. */
  cardId: string | null;
  /** Never null: a wish carries its own name, because it outlives the printing it was made
   *  from and may never have had one. */
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  lang: string | null;
  rarity: string | null;
  manaCost: string | null;
  quantity: number;
  preferredFinish: string | null;
  /** The cheapest way to satisfy this wish, per copy: the preferred finish's price if one is
   *  named, else the nonfoil price of the printing (or of any printing of the oracle card). */
  unitPriceUsd: number | null;
  /** The same in EUR, with the hole the data has: `eur_etched` does not exist, so a wish for
   *  the etched printing is `null` here rather than quoted at the nonfoil rate. */
  unitPriceEur: number | null;
  /**
   * Copies the collection holds **against this wish** — narrowed by everything the wish
   * says: its printing if it names one, and its finish if it names one.
   *
   * Not the same number as {@link CardSummary.ownedQuantity}, which is every copy of one
   * printing, finish-blind; nor as {@link DeckCard.ownedQuantity}, which is what one deck
   * *claimed*. This one is finish-*aware*, so a foil wish reads `0` while the nonfoil sits
   * in a binder — which is the whole reason finish is part of what makes two wishes two
   * wishes.
   */
  ownedQuantity: number;
  notes: string | null;
  needsReview: string | null;
  /** Unix seconds. */
  updatedAt: number;
}

export interface WishlistPage {
  items: WishRow[];
  total: number;
}

/**
 * What a deck category *is for* — `schema::CATEGORY_KINDS`, which `deck_categories.kind`'s
 * own CHECK is built from.
 *
 * **This is not the category's name.** A category is a row the user makes, renames, reorders
 * and switches off; its `kind` is the fixed word the rules read, and only four of the five
 * are predefined (one `Commander`, one `Sideboard`, one `Companion`, one `Maybeboard` per
 * deck). Every category a user makes is a `main` one, and a deck may own any number.
 *
 * **The governing rule, and the one sentence to read before writing anything that counts
 * cards: the switch decides whether a pile counts *at all*; the kind decides only whether it
 * is played *beside* the deck or *in* it — and only `side` and `companion` are beside it.**
 * So a deck's size is every active category of kind `main`, `commander` or `maybe`, which
 * reads odd until the alternative is written out: an active Maybeboard that was part of the
 * card pool and part of the allocator's claims but not part of the size reported a singleton
 * error under a count that still said 100.
 *
 * `maybe` therefore exists for exactly one reason — to name the predefined Maybeboard and
 * seed it inactive. Nothing here says "counts toward nothing" any more;
 * {@link DeckCategory.isActive} does.
 */
export type CategoryKind = "main" | "side" | "commander" | "companion" | "maybe";

/**
 * The two decks every deck secretly is — `schema::DECK_VARIANTS`.
 *
 * `live` is what is actually sleeved up: the gallery's card count, the allocator's claims and
 * the "send missing to the wishlist" button all read it and nothing else. `theory` is what
 * the deck is being built toward — a plan, which reserves no copy of anything and appears on
 * no tile. The two are separate rows of `deck_cards`, so a change tried out in Theory can
 * never silently overwrite the deck as it stands.
 */
export type DeckVariant = "live" | "theory";

/**
 * One category of one deck: a named pile the user owns.
 *
 * Schema v8 replaced the fixed five-word zone with these. The four predefined ones
 * (`schema::PREDEFINED_CATEGORIES`) are seeded with every deck and cannot be renamed or
 * deleted; everything else is the user's, and `kind` is `main`.
 */
export interface DeckCategory {
  id: number;
  deckId: number;
  /** As the user wrote it — a column heading, and what every refusal about a card in it says. */
  name: string;
  kind: CategoryKind;
  /**
   * **`categoryActive` is the whole of what `maybe` used to mean.** A card in an inactive
   * category counts toward no deck size, no copy limit and no legality check, and the
   * allocator claims no copy for it — so its {@link DeckCard.ownedQuantity} is always `0`.
   * The Maybeboard is simply the one predefined category seeded inactive; a user category
   * switched off behaves identically, and nothing in the engine, the allocator or the stats
   * needs to know which is which.
   *
   * Settable on **every** category, `commander` included: deactivating that one is a legal
   * (if unwise) thing to do, and the validation engine reports a missing commander, which is
   * the honest cost. The only kind-based refusal in the backend is against *renaming* and
   * *deleting* a predefined category, and it never reaches this field.
   */
  isActive: boolean;
  sortOrder: number;
  /**
   * Copies filed here **in the variant that was asked for** — `sum(quantity)`, not a row count.
   * Two printings at 2 and 3 copies read 5.
   *
   * The number a *list* row wants: a panel drawing the deck's columns is drawing the list the
   * reader is editing. It is **not** the number a delete confirmation wants — see
   * {@link DeckCategory.cardCountAllVariants}, and read both before reaching for either.
   */
  cardCount: number;
  /** Nonfoil `usd` × copies over the same variant, `null` when nothing here has a price. */
  totalPriceUsd: number | null;
  /**
   * Copies filed here **across both variants**, live and theory together — the number a
   * destructive confirmation has to quote, and the same answer whichever variant was asked by.
   *
   * A category is not per-variant. `deck_cards.category_id` is `ON DELETE CASCADE`, so deleting
   * one takes its rows out of **both** lists, and `deckCategoryDelete`'s move arm moves both for
   * the same reason. A dialog quoting {@link DeckCategory.cardCount} therefore understates what
   * it is about to do on any theory-enabled deck — and understates the **destructive** arm in
   * particular, which is a control lying in the direction of the reader pressing it.
   */
  cardCountAllVariants: number;
}

/**
 * A tag's stored colour: a **token** from the app's palette (`gold`, `ember`, …), never a
 * CSS colour and never a hex string.
 *
 * **Deliberately `string` and not a union**, which is the one place this file declines to
 * narrow a Rust `String`. `deck_tags.color` carries no CHECK — the backend validates only
 * that it is non-empty, because picking what a colour *is* belongs to the webview
 * (CLAUDE.md's Rust/TS boundary), and `features/decks/tagColors.ts` owns the palette. A union
 * here would make a tag written by a newer build a **type error at the read**, when the
 * behaviour that was actually designed is a fallback: `tagColorCss` answers the default for
 * any token it has never heard of, so an unknown colour is a visible dot rather than a
 * crash. The alias exists to say all of that at every field that holds one.
 */
export type TagColor = string;

/**
 * One tag of one deck: a per-deck label a card can carry, at most one per card.
 *
 * The "at most one" is the `deck_cards.tag_id` column itself and nothing else — there is no
 * join table and no constraint to relax if that ever changes.
 */
export interface DeckTag {
  id: number;
  deckId: number;
  name: string;
  color: TagColor;
  /** Copies carrying it, `sum(quantity)` like {@link DeckCategory.cardCount}, and scoped to
   *  the same variant the read asked by — the two agree, deliberately. */
  cardCount: number;
}

/**
 * One row of the "New tag" dialog's autocomplete: a name, a colour, and no deck.
 *
 * **Global on purpose.** A tag is per-deck data, but the palette a dialog offers to complete
 * from is a property of the app's whole history rather than of the deck that happens to be
 * open — a reader who has typed "Cut candidate" into four decks should be offered it in the
 * fifth. `deck_tag_suggestions` is the only command in the deck surface that takes no id at
 * all, and it answers most-used first.
 *
 * Grouped on the **pair**, not on the name: nothing in the schema forces two decks to pick
 * the same colour for one word, so a name used in two colours is honestly two rows.
 */
export interface TagSuggestion {
  name: string;
  color: TagColor;
}

/**
 * One folder of the deck gallery's filing tree.
 *
 * **Flat rows; the tree is the reader's to build from `parentId`** — `deck_folders` has no
 * notion of depth and `deck_folder_list` takes no deck id, because a folder belongs to no
 * deck: it files them, the way a directory files files.
 *
 * Two cascades worth knowing before drawing a delete confirmation, and they point opposite
 * ways. `deck_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so deleting a folder
 * takes its sub-folders with it. `decks.folder_id` is `ON DELETE SET NULL`, so the decks
 * inside surface at the root, filed nowhere, otherwise untouched. A confirmation that said
 * "and everything in it" would be wrong about the half that matters.
 */
export interface DeckFolder {
  id: number;
  /** The folder this one sits inside, or `null` for the root of the tree. */
  parentId: number | null;
  name: string;
  sortOrder: number;
}

/**
 * One card the **theory** list wants more of than the live list has — a line of the plan's
 * shopping list.
 *
 * **One direction only**, and that is the design rather than an omission: what live has and
 * theory dropped is a cut the reader already made, and it needs no row. Inactive categories
 * are excluded from *both* sides, so a card parked in either Maybeboard is neither wanted nor
 * owned for this purpose.
 *
 * The comparison is by **oracle card**, not by printing: needing a second Sol Ring is not
 * answered by the live list holding a different printing of one. An orphan — a row whose
 * printing has left `cards` — has no oracle id and is compared by its own id, which is as far
 * as the data honestly goes.
 */
export interface TheoryDiffRow {
  /** The printing **the theory row names**, which is the printing the reader would be buying.
   *  When the same card is filed in two theory categories this is the first row's printing. */
  cardId: string;
  name: string;
  /** The category the theory row is filed under — the pile this card is wanted *for*, which is
   *  what makes a shopping list readable ("2 more Ramp, 1 more Removal"). */
  categoryName: string;
  /** How many more copies theory wants than live has. **Always positive**: a card live has as
   *  many of is not on this list, and one it has more of is a cut rather than a purchase. */
  quantity: number;
  /** Nonfoil `usd` from this printing's prices blob, per copy — {@link DeckCard.unitPriceUsd}'s
   *  rule. Never `cards.price_usd`, which is a display fallback chain and must not be summed. */
  unitPriceUsd: number | null;
  setCode: string;
  collectorNumber: string;
  /**
   * Copies of this oracle card the collection holds that **no built deck has claimed** — the
   * number that turns "I need two more Sol Rings" into "and one is in the box already".
   *
   * **A display field, and never a term in an arithmetic.** It is deliberately not netted out
   * of {@link TheoryDiffRow.quantity}, least of all by `deckTheoryMissingToWishlist`:
   * `quantity` has already subtracted the live list and this number has not, so an unbuilt
   * deck's own live copies read as spare here — right for a person, wrong for a subtraction.
   */
  ownedSpare: number;
}

/**
 * What one `deck_audit` row says happened — `schema::AUDIT_KINDS`, narrowed.
 *
 * A `String` on the Rust struct and a CHECK constraint in SQL, a union here: the database
 * is the enforcement and this is the mirror, which is the same arrangement
 * {@link CategoryKind} and {@link DeckVariant} are in.
 *
 * The nine split three ways, and the split is why {@link DeckAuditEntry.cardId} is nullable:
 * `add`/`remove`/`quantity`/`move`/`swap` are about **one card**; `category` and `folder` are
 * about a pile or a filing cabinet; `deck` is about the deck itself.
 *
 * **`tag` is on both sides of that line**, which is the trap: one kind covers a card wearing
 * a label (`cardId` set) *and* the label itself being created, renamed or deleted (`cardId`
 * `null`, plus an `action` verb in the payload). They share a kind because they share a
 * subject. A renderer that could not see the verb reports "deleted the Cut candidate tag" as
 * "tagged as Cut candidate" — `auditText.ts` switches on `action` first for exactly that
 * reason.
 */
export type DeckAuditKind =
  "add" | "remove" | "quantity" | "move" | "swap" | "tag" | "category" | "folder" | "deck";

/**
 * One line of a deck's history — **what happened, not how to say it.**
 *
 * The whole design of this table is in {@link DeckAuditEntry.payload}: Rust records the
 * facts inside the transaction that made the change, and `features/decks/auditText.ts`
 * turns them into the sentence a person reads. A row that stored the sentence would be a
 * history that has to be migrated the day the wording changes, and one that could not be
 * re-rendered in another language or at another length at all.
 *
 * Recorded **inside** the caller's transaction, always: an audit row that committed while
 * the change it describes rolled back is a history that lies.
 */
export interface DeckAuditEntry {
  id: number;
  deckId: number;
  /** Unix **seconds**, like {@link DeckRow.updatedAt} — not milliseconds. `auditText`'s
   *  day grouping multiplies by 1000 exactly once, where the `Date` is built. */
  at: number;
  /**
   * Which of the deck's two lists the change was made to — **for the kinds that are about a
   * list at all.** `deck_audit.variant` is `NOT NULL` with a CHECK over the two, so every row
   * has to carry *something*, and for four kinds that something is filler.
   *
   * It is a fact for `add`/`remove`/`quantity`/`move`/`swap`, for the card-side half of `tag`,
   * and for the one `deck` row that records a theory copy (which deliberately says `theory`).
   * It is **filler for the rest**: a category write, a folder filing, a label being created or
   * deleted and every other `deck` field all record the column's DDL default, `live`, because
   * none of them is a fact about one variant's cards. `deck_audit::DECK_LEVEL` is literally
   * `DECK_VARIANTS[0]`.
   *
   * So **do not filter a history by variant** — a Theory reader who did would be shown every
   * category rename and deck setting they had ever changed, and a Live reader would lose half
   * their history to nothing more than a CHECK constraint. {@link DeckAuditEntry.cardId} draws
   * the same line one field down, and for the same reason.
   */
  variant: DeckVariant;
  kind: DeckAuditKind;
  /**
   * The card the change was about, **softly** referenced like every card id in a user table
   * — and `null` for the three kinds that are about no card at all (`category`, `folder`,
   * `deck`), and for the half of `tag` that is about the label rather than a card wearing it.
   */
  cardId: string | null;
  /** Denormalized at write time, for the reason `deck_cards.name` is: a history line still
   *  names its card the day that printing leaves the card database. */
  cardName: string | null;
  /**
   * **JSON text**, not an object — `payload TEXT NOT NULL CHECK (json_valid(payload))`, so
   * it arrives as a string and is parsed by the one module that reads it.
   *
   * The shape depends entirely on {@link DeckAuditEntry.kind}, and the shapes are written out
   * in `features/decks/auditText.ts`, which is the only place in the app that looks inside
   * this string. It is deliberately schemaless here: adding a fact to one kind is a change to
   * a sentence rather than a migration, which is what a log of "all changes" needs in order to
   * survive being useful. Roughly, by kind:
   *
   * | kind | payload |
   * |---|---|
   * | `add` | `{ category, quantity }` |
   * | `remove` | `{ category, quantity, reason }` |
   * | `quantity` | `{ category, from, to }` |
   * | `move` | `{ from, to }` — category **names**, not ids |
   * | `swap` | `{ category, fromSet, toSet, folded }` |
   * | `tag` | `{ tag, previous }` on a card; `{ action, tag, previous }` on the label |
   * | `category` | `{ action, name, previousName, cards }` |
   * | `folder` | `{ action, folder }` — `folder` is `null` for the root |
   * | `deck` | `{ field, from, to }`, or `{ field: "theory", copied }` |
   *
   * **Read every field as optional, including the ones that table shows.** Several payloads
   * are narrower than they look — a category `reorder` emits `{ action }` alone, because every
   * pile moved and there is no one pile to name — and the writer is still growing: this build
   * may be older *or* newer than the one that wrote a row, since a database outlives the app.
   * `deck.field` today is `name | format | cover | notes | built | theory | description |
   * archived`, and `cover` records the literal `"custom"` for an uploaded image rather than a
   * card id. Parse defensively and be total over unknowns, which is what `auditText.ts` does
   * and why nothing in it throws.
   *
   * Values are recorded **as stored**: a set code inside a `swap` is the lowercase
   * `cards.set_code` it came from, not the capitals a tile draws. Casing is the renderer's.
   */
  payload: string;
  /**
   * Signed **copies**, for the day header's `+7 / −6` roll-up: `+n` on an add, `−n` on a
   * remove, the difference on a quantity change, and **`+n` on the one `deck` row that records
   * a theory copy** — `deck_theory::copy_from_live` seeds the plan from the live list and
   * carries the copies it wrote. `0` on everything else.
   *
   * That fourth case is the one worth naming, because it is the exception to the shape of this
   * list: every *other* nonzero delta belongs to a card-shaped kind, and a reader who took
   * "card kinds move the number, deck kinds do not" as the rule would be wrong exactly once —
   * on a row that can move it by ninety-nine.
   *
   * Zero is the common case and means "this changed no card count", never "nothing
   * happened" — a rename, a reorder, a move, a tag and a printing swap all record `0`.
   */
  delta: number;
}

/**
 * One new deck, as the "New deck" dialog sends it.
 *
 * Rust carries `#[serde(default)]` so both strings are optional on the wire, but they stay
 * required here: a deck with no name is refused in words (`"A deck needs a name."`), and a
 * blank `formatKey` is not an error but a *decision* — it means `casual`, which is
 * `decks.format_key`'s own DDL default. A call site that wants casual should say so.
 */
export interface DeckInput {
  name: string;
  /** A `format_specs.key`. Validated against the table, not by a foreign key — see
   *  {@link FormatSpec}. Blank means `"casual"`. */
  formatKey: string;
  description?: string;
}

/**
 * An edit to one deck. Every field is optional: absent means "leave it"
 * (`coalesce(?n, column)`, {@link EntryPatch}'s rule).
 *
 * **Absent is the only way to say "leave it", so `null` cannot say "clear it".** Every column
 * below is written with `coalesce(?n, column)`, which reads a bound NULL as *unchanged* — so
 * there is no patch that clears a cover, empties a description, or files a deck back at the
 * **root** of the folder tree. The last of those is a thing the app actually needs, which is
 * why {@link ipc.deckSetFolder} is a command of its own: it takes `folderId: number | null`
 * and `null` there means the root. A reader looking for "un-file this deck" wants that
 * command and will not find it here.
 *
 * Un-filing through a patch would need a double-`Option` (absent versus null) across this
 * whole struct — a change to make once and deliberately, not as a side effect of adding a
 * field.
 */
export interface DeckPatch {
  name?: string;
  formatKey?: string;
  /** The one-line blurb the "New deck" dialog fills and the gallery tile shows — **not**
   *  {@link DeckPatch.notes}. Two fields because they are two things: a caption and a
   *  notebook. */
  description?: string;
  /** Point the cover at a printing's art crop. Sending it also sets `coverKind` back to
   *  `card_art`, so a deck showing an uploaded picture returns to card art without the file
   *  being deleted — see {@link DeckRow.coverKind}. */
  coverCardId?: string;
  /**
   * Sleeved up on a table, or a plan on paper. The **only** thing this means: a built deck's
   * claims are subtracted from what every *other* deck can reach, while drafts all plan with
   * the same shared copies. Sending it reallocates this deck in the same transaction.
   */
  isBuilt?: boolean;
  /** Filed away: sorted last in the gallery, never deleted. This is what a gallery's
   *  "remove" should reach for — `deckDelete` really deletes. */
  archived?: boolean;
  /**
   * Which folder the deck is filed in.
   *
   * **This field can file a deck, and cannot un-file one** — by the rule above, `null` here
   * means "leave it". {@link ipc.deckSetFolder} is the command that reaches the root.
   */
  folderId?: number;
  /** The deck's long-form notes — the v8 column, and not {@link DeckPatch.description}. */
  notes?: string;
  /**
   * Whether this deck keeps a theory list beside its live one.
   *
   * **Switching it on seeds the theory list from live when there is nothing in it**, in the
   * same transaction: an empty theory list beside a full live one reads as data loss rather
   * than as a blank page. Switching it off **keeps every row** — it hides a switch, it does
   * not delete a list, and nothing in the backend ever deletes a `theory` row except the
   * ordinary card writes the reader makes against it.
   */
  theoryEnabled?: boolean;
}

/**
 * Which of a deck's two cover fields a tile should draw — `decks.cover_kind`, and the only
 * thing that decides it.
 *
 * `card_art` means {@link DeckRow.coverCardId}'s art crop; `custom` means the file the reader
 * picked, served by the image protocol at `<origin>/cover/<deckId>` (a fifth route beside the
 * four card variants — the CSP was not edited for it).
 *
 * **A deck can carry both at once and usually does**: setting a custom cover leaves the card
 * id alone and picking a card leaves the file on disk, so switching back and forth costs
 * nothing and loses nothing. That is only coherent because this column is the one answer to
 * "which one is showing".
 */
export type DeckCoverKind = "card_art" | "custom";

/** One deck as the gallery shows it. */
export interface DeckRow {
  id: number;
  name: string;
  formatKey: string;
  /** From `format_specs`, so the gallery never re-derives a display name. `null` when the
   *  key is one the seeded table no longer carries — a LEFT JOIN, so the deck still lists. */
  formatName: string | null;
  description: string | null;
  coverCardId: string | null;
  /** Which of the two covers is showing. See {@link DeckCoverKind} — a deck usually carries
   *  both, and this is the one answer to which one a tile draws. */
  coverKind: DeckCoverKind;
  /**
   * The cover printing's illustrator, `null` when `cards` has no row for it.
   *
   * Read here so a tile can obey Scryfall's image policy: an `art` crop has no printed
   * frame, so wherever one is shown the artist must be credited. Task 11's ruling is that a
   * cover with no artist is **not drawn** — an orphaned cover heals on the next sync.
   *
   * It is about {@link DeckRow.coverCardId} and only that: a `custom` cover is the reader's
   * own picture and has no Scryfall artist to credit, so this stays `null` while the tile
   * quite properly draws one.
   */
  coverArtist: string | null;
  isBuilt: boolean;
  archived: boolean;
  /**
   * `live` copies in **active** categories of kind `main`, `commander` or `maybe` — what "a
   * 60-card deck" means in a caption, and the **same cards the validation engine sizes a deck
   * by**: `SIZE_KINDS` in `features/decks/validation/engine.ts`. One definition, so a tile and
   * the format check beside it never answer the same question with two numbers. The kind list
   * here and that constant are the same three words, and a change to one is a change to both.
   *
   * Three exclusions, and they are {@link CategoryKind}'s governing rule applied. The
   * sideboard and the companion are *beside* the deck rather than in it (CR 100.4a; EDH calls
   * a companion "effectively a 101st card", which is exactly the card a 100-card caption must
   * not add). A **theory** row is a plan and appears on no tile. And an **inactive** category
   * counts toward nothing whatever its kind, which is how a switched-off Maybeboard stays out
   * without `maybe` being excluded — a Maybeboard switched *on* counts like any other pile.
   */
  cardCount: number;
  /** Unix seconds. The gallery's sort key, and every card write moves it — including a
   *  removal that found nothing to remove. */
  updatedAt: number;
  /** Which folder the deck is filed in, or `null` for the root of the tree. Filing is
   *  {@link ipc.deckSetFolder}, which is the only write that can put it back at `null`. */
  folderId: number | null;
  /** The deck's long-form notes — the v8 column, not {@link DeckRow.description}. */
  notes: string | null;
  /**
   * Whether this deck keeps a theory list beside its live one.
   *
   * Read on the row as well as written through {@link DeckPatch}, because a switch the app can
   * set and never see is a switch nothing can draw: the editor's Live/Theory control **is**
   * this boolean. Without it every reader would have to guess from whether the theory list
   * happens to be empty — which is precisely the state the seed-on-enable exists to make
   * impossible to interpret.
   */
  theoryEnabled: boolean;
}

/**
 * One card in one category of one deck: what it is, what the validation engine needs to judge
 * it, and how much of it the user actually has.
 *
 * Three groups of fields, and the split is the design:
 *
 * * **The row's own identity** (`name`, `setCode`, `collectorNumber`, `lang`) — copied from
 *   `cards` at write time and never null since. A deck whose printing left the card database
 *   still says what it is holding.
 * * **The card facts**, every one nullable: `deck_cards LEFT JOIN cards`, so an orphaned row
 *   is listed with nulls rather than dropped — {@link CollectionRow}'s discipline, for its
 *   reason.
 * * **The availability numbers**, computed at read time and stored on no row.
 */
export interface DeckCard {
  /** `deck_cards.id`. Answered by the writes, but **never** what addresses one: every card
   *  command takes `(deckId, cardId, categoryId, variant)`, the grain the unique index is on. */
  id: number;
  cardId: string;
  categoryId: number;
  /** The category's own name, denormalized into the read so a row can be drawn without a
   *  second lookup. */
  categoryName: string;
  /** **What the rules read.** The name is the user's and can be anything; this is the fixed
   *  word the engine sizes a deck, counts copies and judges a commander by. */
  categoryKind: CategoryKind;
  /** {@link DeckCategory.isActive}, copied onto the row — `false` means this card counts
   *  toward nothing at all. */
  categoryActive: boolean;
  /** Which of the deck's two lists this row is in. Every row of one read carries the same
   *  value; it is here so a caller holding a row can write it back. */
  variant: DeckVariant;
  /** The one tag this row carries, resolved so a row can be drawn without a second lookup.
   *  All three are `null` together — deleting a tag untags its cards rather than deleting
   *  them. */
  tagId: number | null;
  tagName: string | null;
  tagColor: TagColor | null;
  quantity: number;
  /** Denormalized at write time, and the one name an orphaned row still has. */
  name: string;
  setCode: string;
  collectorNumber: string;
  lang: string;
  /** A sentence when a sync could not keep this row's printing, `null` otherwise — the
   *  reconciler walks `deck_cards` too. */
  needsReview: string | null;
  oracleId: string | null;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  /**
   * The card's colours as **concatenated letters** — `"WU"`, not `["W","U"]`. This is not
   * JSON and `JSON.parse` will throw on it: `card_row` stores the letters, so the letters
   * are what comes back. Read it a character at a time.
   */
  colors: string | null;
  /**
   * Scryfall's precomputed `color_identity`, in the same letter form — `"WU"`, again not
   * JSON. Precomputed is the point: it already folds in DFC backs, adventures, colour
   * indicators and basic land types, so one subset check answers CR 903.5c and 903.5d
   * together.
   */
  colorIdentity: string | null;
  /**
   * JSON: **this printing's** legality blob, not the oracle card's. That is what makes Old
   * School come out right with no special case — `oldschool` is the one printing-sensitive
   * key (Serra Angel is legal from `lea` and not from `8ed`), and a deck card names a
   * printing.
   */
  legalities: string | null;
  /**
   * The printed power, **as text**, because that is what it is: `"*"`, `"1+*"` and a printed
   * `"0"` all ship in real data.
   *
   * `power` and `toughness` both `null` means *unknown*, never "no P/T box" — and CR 903.3
   * turns on exactly that difference. The backend repairs what it can before answering (it
   * gunzips `raw` for the rows that are missing a P/T *and* could have one), so a null pair
   * here is a card nothing could recover it for.
   */
  power: string | null;
  toughness: string | null;
  layout: string | null;
  rarity: string | null;
  /** JSON: the `card_faces` array verbatim. Per-face mana cost, MV and P/T live only here —
   *  Tiny Leaders' per-face MV cap and DFC commander fronts both read them. */
  faces: string | null;
  gameChanger: boolean | null;
  /**
   * JSON: the finishes this printing exists in (`["nonfoil","foil"]`), or `null` for an
   * orphan.
   *
   * A deck names a *printing* and never a finish, so this is **not** "which finish is in the
   * deck" — the model has no such concept, and `deck_cards` stores none. It answers the
   * narrower question a row's art can honestly carry: whether the printing itself leaves no
   * choice. Read it with `soleFinish` from `@/lib/finish`.
   */
  finishes: string | null;
  /** Printed at uncommon on **any** printing of this oracle card, which is what makes a
   *  Pauper Commander commander eligible. Computed, not read: the `paupercommander` legality
   *  key answers a different question (the 99). `false` for an orphan — nothing is known
   *  about a card that is not there. */
  everUncommon: boolean;
  /** Nonfoil `usd` from the prices blob, per copy — {@link WishRow.unitPriceUsd}'s rule.
   *  Never `cards.price_usd`, which is a display fallback chain and must not be summed. */
  unitPriceUsd: number | null;
  /**
   * Copies of this oracle card the allocator **secured for this deck**, attributed to this
   * row in the read's own order and clamped to what each collection entry still holds.
   *
   * The third of this file's three `ownedQuantity` fields and the only one that is not a
   * count of what the user has: {@link CardSummary.ownedQuantity} is every copy of one
   * printing, {@link WishRow.ownedQuantity} is the copies that fill one wish, and this one
   * is a *claim* — oracle-grained (a Bolt is a Bolt), finish-blind, condition-blind.
   *
   * Three things it will not do, all by design:
   *
   * * a row whose `categoryActive` is `false` always reads `0`, because the allocator claims
   *   nothing for an inactive category — so no "owned" badge belongs on that pile at all;
   * * a `theory` row always reads `0` too: **the allocator claims for the `live` variant
   *   only**, and a plan reserves nothing. `deck_allocations` carries no variant column at
   *   all — there is nothing on a claim that says which list it came from, because only one
   *   list ever makes them — which is why the *read* is what filters, and why a mirror of
   *   this field that assumed a claim could be theory-scoped would be describing a column
   *   that does not exist;
   * * across **several built decks** these numbers are not guaranteed to add up to what the
   *   collection holds. A deck's claims are recomputed when *that deck* is written to, so
   *   two built decks sharing a card can each carry a claim made when the other's was
   *   different. Read as "what this deck reserved", never as an inventory.
   */
  ownedQuantity: number;
}

/**
 * One deck and everything in it.
 *
 * One command rather than four, because the editor and the validation engine ask the same
 * question — *what is in this deck* — and a screen that draws a curve from one query, a
 * legality panel from another, an owned badge from a third and its column headings from a
 * fourth is a screen whose answers can disagree.
 */
export interface DeckDetail {
  deck: DeckRow;
  /** Category `sortOrder`, then the name the row carries, then row id. The read's own order,
   *  not the caller's: `ownedQuantity` is attributed along it, so the number a row shows must
   *  not depend on how a list was displayed. */
  cards: DeckCard[];
  /**
   * **Every** category of the deck, in `sortOrder`, never filtered by what happens to be in
   * it: an empty one still draws a column — that is where the next card goes — and an
   * inactive one always draws, which is the affordance for switching it back on.
   *
   * The counts are scoped to the variant that was asked for; the list itself is not, so
   * switching between Live and Theory changes what is in the columns and never which columns
   * there are.
   */
  categories: DeckCategory[];
  /** Every tag of the deck, alphabetically — the palette a row's label is picked from, which
   *  exists whether or not any row is wearing it. */
  tags: DeckTag[];
}

/**
 * What a printing swap answers: where the copies ended up, and whether they had company.
 *
 * The reason the swap has a return type of its own rather than the `EntryChange` its
 * neighbours share: two rows can become one. A category holds a printing at most once per
 * variant (the grain is `(deck, variant, category, card)`), so swapping onto a printing the
 * category already has *folds* — and a deck list that silently loses a line reads like a bug
 * unless something says so.
 */
export interface SwapResult {
  /** The target category already held that printing, so the two rows became one. */
  folded: boolean;
  /** What the row the copies now live in holds — the **sum**, when `folded`. */
  quantity: number;
}

/**
 * One row of `format_specs` — the rules as data (spec §6), handed to the TS engine whole.
 *
 * A new format is a seeded row rather than a code branch, and that is only true if nothing
 * decides here which cells matter. Seeded by the migration and by nothing else: a sync
 * cannot change this table, which is why it is not in `SYNC_INVALIDATED`.
 */
export interface FormatSpec {
  key: string;
  displayName: string;
  /** Whether the "New deck" picker offers it. `future` is the one row that is off — a
   *  format you can test against but not build for. */
  enabledInPicker: boolean;
  deckMin: number;
  /** `null` is CR 100.5: a 60-card format has a minimum and no maximum. */
  deckMax: number | null;
  /** `null` means unlimited — the two pseudo-formats (`casual`, `limited`) only. */
  maxCopies: number | null;
  /** `0` means *no sideboard*; `null` means *uncapped* — the two pseudo-formats, `casual` and
   *  `limited`, where Limited plays the rest of its pool and Casual caps nothing at all. */
  sideboardMax: number | null;
  singleton: boolean;
  requiresCommander: boolean;
  /** Which eligibility rule the commander zone is judged by, `null` for the formats that
   *  have no such zone. Two formats may share one rule (`predh` carries `edh`) — this is a
   *  rule name, not a format name. */
  commanderRule: "edh" | "brawl" | "oathbreaker" | "pdh" | "duel" | "tlr" | null;
  life: number;
  /**
   * What Scryfall's `"restricted"` legality means **in this format**, and it is never
   * inferred from the key: max one copy in vintage/timeless/oldschool, and *banned as
   * commander* in the two singleton formats that use it (duel, tlr), where "max one" would
   * be no restriction at all.
   */
  restrictedSemantic: "max_one" | "banned_as_commander";
  /** Whether `cards.legalities` carries a key for this format. `false` for `casual` and
   *  `limited`, which are not judged against a card pool at all. */
  hasLegalityData: boolean;
  /** A per-card mana-value ceiling. Only Tiny Leaders: Reborn has one (`3`). */
  maxManaValue: number | null;
  allowsCompanion: boolean;
  /** The order a picker shows them in — `format_specs` is read `ORDER BY sort_order`. */
  sortOrder: number;
}

/**
 * Result of a sync run.
 *
 * `updatedAt` is not a companion of `updated`: Scryfall can serve a bulk listing with
 * no `updated_at` at all, which is stored as absent and comes back `null` even though
 * cards were ingested. Read the two independently.
 */
export interface SyncOutcome {
  updated: boolean;
  cardCount: number;
  updatedAt: string | null;
}

/**
 * What the UI polls.
 *
 * `dataDir`, `syncing` and `imageStoreFailures` are always answered — none of them needs
 * the database. The five database-derived fields are `null` only when the read-only
 * connection could not be used at all; an ingest no longer blanks them. `null` there means
 * "not readable right now", never "zero" and never "cleared": a UI that renders it
 * literally reports an empty collection and throws away an error banner the user has not
 * read yet. See `mergeStatus` in `useSync.ts`, which is the one place that resolves this.
 */
export interface SyncStatus {
  cardCount: number | null;
  /** Unix seconds, as a string. */
  lastCheckAt: string | null;
  /** Scryfall's timestamp for the ingested bulk file, ISO-8601. */
  bulkUpdatedAt: string | null;
  /** Why the last run failed, still readable long after its event was dropped. */
  lastError: string | null;
  /**
   * Lines the last ingest could not read as cards (spec §8 requires the count be
   * surfaced, not swallowed). `null` before any ingest has run — which is not the same
   * as `0`, "the last ingest skipped nothing".
   */
  lastIngestSkipped: number | null;
  dataDir: string;
  syncing: boolean;
  /**
   * Card images this process fetched and then could not write to the cache — a read-only
   * data folder, a full disk. A number, never `null`: it is a counter in memory rather
   * than a database read, and the disk that would make the rest unreadable is the very
   * thing it reports on. Resets with the app.
   *
   * Non-zero is worth telling the reader about because nothing else shows it: the images
   * still display (the bytes were in hand), they are simply never cached, so the only
   * visible symptom is a grid that re-downloads itself forever.
   */
  imageStoreFailures: number;
}

/** The phases `sync.rs` emits, and the only values `SyncProgressEvent.phase` takes. */
export type SyncPhase =
  | "checking"
  | "downloading"
  | "ingesting"
  | "reclaiming"
  | "sets"
  | "compacting"
  | "done"
  | "error";

/**
 * Payload of the `sync:progress` event.
 *
 * Not a complete account of a sync: a run throttled by the 24 h check window emits
 * nothing at all, and events emitted before the webview registered its listener are
 * dropped by Tauri. Progress is the fast path; `SyncStatus` is the reliable one.
 */
export interface SyncProgressEvent {
  phase: SyncPhase;
  done: number;
  total: number;
  message: string | null;
}

/**
 * Payload of `collection:reconciled` — what one pass of Scryfall's id-migration log did to
 * the user's own rows (`sync::reconcile_ids`, from `reconcile::ReconcileStats`).
 *
 * Emitted **only when something moved**: a pass that skipped every already-applied
 * migration, which is every pass after the first, is silent. So the event's arrival is the
 * fact worth acting on, and the three numbers are for a message about it.
 */
export interface ReconciledEvent {
  /** Rows whose `card_id` was moved to the id Scryfall merged the old one into. */
  repointed: number;
  /** Rows that collided with an existing one at the new id and became one row. */
  folded: number;
  /** Rows that could be neither repointed nor folded, and now carry a sentence. */
  flagged: number;
}

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
  /** The release body as written. Plain text: this app has no markdown renderer, and half
   *  rendered markdown reads worse than none. */
  notes: string;
  publishedAt: string | null;
  htmlUrl: string;
  assets: UpdateAsset[];
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
  | "image_store";

/** The shape of a failure. Mirrors `errors::Kind` and the `CHECK` on `error_log.kind`. */
export type ErrorKind = "rate_limited" | "timeout" | "http" | "io" | "parse" | "other";

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

export const ipc = {
  searchCards: (req: SearchRequest) => invoke<SearchResponse>("search_cards", { req }),
  /** Every set, newest first. Cached for the session — it changes once a sync, at most. */
  listSets: () => invoke<SetSummary[]>("list_sets"),
  /** One printing in full, or `null` when no row has that id. */
  cardDetail: (id: string) => invoke<CardDetail | null>("card_detail", { id }),
  /** Every paper printing of the oracle card, newest first, capped at 400 with a full count. */
  cardPrintings: (oracleId: string) => invoke<PrintingsResponse>("card_printings", { oracleId }),
  /**
   * Warm the image cache for a page of results. Fire-and-forget: it resolves as soon as
   * the work is queued, and an image that fails to prefetch simply fetches when it is
   * rendered. The backend takes the front face only and caps the batch at 100.
   */
  prefetchImages: (cardIds: string[], variant: ImageVariant) =>
    invoke<void>("prefetch_images", { cardIds, variant }),
  /**
   * Warm the image cache for every card in the collection and the wishlist, so what the
   * user owns browses without a network (spec §5). Fire-and-forget like `prefetchImages`,
   * and it answers how many images were *queued*, not fetched.
   *
   * Resumable by construction and therefore cheap to repeat: a key already on disk is not
   * selected, so a second call after a full pass queues nothing.
   */
  prewarmCollection: () => invoke<number>("prewarm_collection"),
  /** Add copies. The same printing, finish and condition twice is one row with a bigger
   *  number — the backend upserts on the grain. */
  collectionAdd: (entry: EntryInput) => invoke<EntryChange>("collection_add", { entry }),
  /** An absolute quantity. `0` keeps the row — with its condition, its purchase price and
   *  its acquisition story — and says so in `removed: false`. Deleting is `collectionRemove`
   *  and only ever `collectionRemove`. */
  collectionSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("collection_set_quantity", { id, quantity }),
  collectionUpdate: (id: number, patch: EntryPatch) =>
    invoke<EntryChange>("collection_update", { id, patch }),
  collectionRemove: (id: number) => invoke<EntryChange>("collection_remove", { id }),
  collectionList: (query: CollectionQuery) => invoke<CollectionPage>("collection_list", { query }),
  /** The aggregate header, over the same filters as the list it captions. */
  collectionSummary: (query: CollectionQuery) =>
    invoke<CollectionSummary>("collection_summary", { query }),
  wishlistAdd: (wish: WishInput) => invoke<EntryChange>("wishlist_add", { wish }),
  /** An absolute quantity — and here `0` *removes* the row, because a wish holds nothing
   *  worth keeping once it is emptied. The opposite of the collection's, on purpose. */
  wishlistSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("wishlist_set_quantity", { id, quantity }),
  wishlistRemove: (id: number) => invoke<EntryChange>("wishlist_remove", { id }),
  wishlistList: (query: WishlistQuery) => invoke<WishlistPage>("wishlist_list", { query }),
  /** The gallery: every deck, archived last, most recently touched first. */
  deckList: () => invoke<DeckRow[]>("deck_list"),
  /**
   * One deck and everything in it, or `null` when no deck has that id — a gallery that has
   * not refreshed since another view deleted it asks for a deck that is not there.
   *
   * `variant` scopes the **cards, and the two counts on every category and tag row** — it is
   * threaded into all three reads. What it does *not* scope is which categories and tags come
   * back: every one of them does either way, so switching between the two lists changes the
   * numbers in the column headings and never the columns themselves.
   */
  deckGet: (id: number, variant: DeckVariant) =>
    invoke<DeckDetail | null>("deck_get", { id, variant }),
  deckCreate: (deck: DeckInput) => invoke<DeckRow>("deck_create", { deck }),
  /** Rename, re-format, cover, build and archive all arrive here. Sending `isBuilt`
   *  reallocates the deck in the same transaction. */
  deckUpdate: (id: number, patch: DeckPatch) => invoke<DeckRow>("deck_update", { id, patch }),
  /** **This one really deletes** — the deck, its cards and its claims, by cascade. Archiving
   *  is `deckUpdate(id, { archived: true })`, and it is what a gallery's "remove" wants.
   *  An id that resolves to nothing is a success: the caller wanted that deck gone. */
  deckDelete: (id: number) => invoke<void>("deck_delete", { id }),
  /** Copy the deck: its categories and tags as new rows, its cards in **both** variants
   *  remapped onto them — never its claims, never `isBuilt`, never `archived`. A copy is a
   *  draft. */
  deckDuplicate: (id: number) => invoke<DeckRow>("deck_duplicate", { id }),
  /**
   * Point the deck at a picture on disk: decode it, re-encode it as this app's cover shape
   * (626×457, the same crop a card cover draws) and store it beside the database.
   *
   * `sourcePath` is a **path the backend reads**, not bytes and not a `file://` URL — the
   * file picker's answer, handed straight across. The re-encode happens *before* the write
   * lock is taken, so a big photograph does not put every collection edit in the app behind
   * one file dialog.
   *
   * Answers the deck as the gallery would read it, with {@link DeckRow.coverKind} now
   * `custom`. It does **not** clear {@link DeckRow.coverCardId}: switching back to card art is
   * `deckUpdate(id, { coverCardId })` and loses nothing either way.
   */
  deckSetCoverImage: (deckId: number, sourcePath: string) =>
    invoke<DeckRow>("deck_set_cover_image", { deckId, sourcePath }),
  /**
   * File the deck under a folder — or, with `folderId: null`, back at the **root** of the
   * tree.
   *
   * **The one thing {@link DeckPatch} cannot express, and the reason this is a command rather
   * than a field.** A patch writes every column with `coalesce(?n, column)`, which reads a
   * bound NULL as "leave it": there is no patch that un-files a deck. Here `null` is an
   * argument with a meaning, and it must travel as an explicit key — Tauri fills parameters by
   * name and an absent one is a refusal, not a default.
   */
  deckSetFolder: (deckId: number, folderId: number | null) =>
    invoke<DeckRow>("deck_set_folder", { deckId, folderId }),
  /**
   * A deck's categories on their own — the same list `deckGet` already carries, for a panel
   * that wants it without the cards.
   *
   * `variant` scopes each row's `cardCount`/`totalPriceUsd` and **nothing else**: which
   * categories a deck has does not depend on which list is showing, which is what keeps the
   * columns still while the reader switches between Live and Theory.
   */
  deckCategoryList: (deckId: number, variant: DeckVariant) =>
    invoke<DeckCategory[]>("deck_category_list", { deckId, variant }),
  /** A new category, always `kind: "main"` and always active, appended after the deck's last
   *  one. Refuses a name the deck already has — the grain is `(deckId, name)`. */
  deckCategoryCreate: (deckId: number, name: string) =>
    invoke<DeckCategory>("deck_category_create", { deckId, name }),
  /**
   * Rename one category — `id`, not `deckId`, because a category names its own deck.
   *
   * **Refused for the four predefined ones** (`Commander`, `Sideboard`, `Companion`,
   * `Maybeboard`), and that refusal is what guarantees they still read those words: the rules
   * role is `kind`, but every heading, every refusal sentence and every payload in the history
   * quotes the *name*.
   */
  deckCategoryRename: (id: number, name: string) =>
    invoke<DeckCategory>("deck_category_rename", { id, name }),
  /**
   * Switch a pile on or off — {@link DeckCategory.isActive}, which is the whole of "counts
   * toward nothing".
   *
   * **Allowed on every kind**, the Commander included: the backend's predefined guard is
   * about renaming and deleting and never reaches this. It reallocates in the same
   * transaction, because an inactive category claims no copies — so this changes what the deck
   * has reserved without touching a single card.
   */
  deckCategorySetActive: (id: number, isActive: boolean) =>
    invoke<DeckCategory>("deck_category_set_active", { id, isActive }),
  /**
   * Write `sortOrder` from position in `ids`, and answer the whole list back in its new order.
   *
   * An id that is not this deck's — stale, or gone — is **silently skipped** rather than
   * failing the reorder over one entry, so a list that raced a delete still lands. Send every
   * id: this is the order, not a move.
   */
  deckCategoryReorder: (deckId: number, ids: number[]) =>
    invoke<DeckCategory[]>("deck_category_reorder", { deckId, ids }),
  /**
   * Delete a `main` category, with or without keeping its cards.
   *
   * **`moveToCategoryId` is the whole of the difference, and `null` is destructive**: an id
   * moves the cards first, in the same transaction, folding into whatever the target already
   * holds — `null` lets `ON DELETE CASCADE` take the cards with the category, which is what a
   * confirm dialog has to say out loud. One command for both, because a caller doing the move
   * and the delete as two round trips could lose the cards between them.
   *
   * The move covers **both variants**: a `live` row and a `theory` row of one printing fold
   * into their own matching rows in the target and never into each other. Refuses a predefined
   * category, a target belonging to another deck, and a move into itself.
   */
  deckCategoryDelete: (id: number, moveToCategoryId: number | null) =>
    invoke<void>("deck_category_delete", { id, moveToCategoryId }),
  /** A deck's tags on their own, alphabetically — `deckGet` carries the same list. `variant`
   *  scopes each row's `cardCount` and nothing else, exactly as it does for categories. */
  deckTagList: (deckId: number, variant: DeckVariant) =>
    invoke<DeckTag[]>("deck_tag_list", { deckId, variant }),
  /** A new label for this deck. Refuses a name the deck already has; the colour is a palette
   *  token and the backend checks only that it is non-empty — see {@link TagColor}. */
  deckTagCreate: (deckId: number, name: string, color: TagColor) =>
    invoke<DeckTag>("deck_tag_create", { deckId, name, color }),
  /** Rename **and** recolour: one command, both arguments required. There is no patch shape
   *  here, so a caller changing one sends the other back unchanged. */
  deckTagUpdate: (id: number, name: string, color: TagColor) =>
    invoke<DeckTag>("deck_tag_update", { id, name, color }),
  /** Delete a label. **Untags its cards rather than deleting them** — `deck_cards.tag_id` is
   *  `ON DELETE SET NULL` — which is the half of the sentence a confirm dialog owes a reader. */
  deckTagDelete: (id: number) => invoke<void>("deck_tag_delete", { id }),
  /** The autocomplete palette for a "New tag" dialog: every name and colour used across
   *  **every** deck, most-used first. Takes no deck id at all — see {@link TagSuggestion}. */
  deckTagSuggestions: () => invoke<TagSuggestion[]>("deck_tag_suggestions"),
  /**
   * Put the one tag a deck card carries on it, or take it off with `tagId: null`.
   *
   * A **card** write wearing a tag command's name: it addresses the slot by the full grain
   * `(deckId, cardId, categoryId, variant)` like every other card write, and answers "that
   * card is not in this deck's category any more" for a row that has since moved, folded or
   * been stepped to zero. A `tagId` belonging to another deck is refused before anything is
   * written.
   */
  deckCardSetTag: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    tagId: number | null,
  ) => invoke<void>("deck_card_set_tag", { deckId, cardId, categoryId, variant, tagId }),
  /** Every folder there is, flat — the tree is the reader's to build from `parentId`. No deck
   *  scoping, because a folder belongs to no deck: it files them. */
  deckFolderList: () => invoke<DeckFolder[]>("deck_folder_list"),
  /** A new folder, at the root with `parentId: null` or inside another one. */
  deckFolderCreate: (parentId: number | null, name: string) =>
    invoke<DeckFolder>("deck_folder_create", { parentId, name }),
  deckFolderRename: (id: number, name: string) =>
    invoke<DeckFolder>("deck_folder_rename", { id, name }),
  /**
   * Re-parent a folder — `parentId: null` moves it back to the root.
   *
   * Refuses a move into itself or into one of its own descendants, and that guard is not
   * cosmetic: `deck_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so a cycle is a
   * graph SQLite's recursive cascade would walk forever the day the folder is deleted.
   */
  deckFolderMove: (id: number, parentId: number | null) =>
    invoke<DeckFolder>("deck_folder_move", { id, parentId }),
  /**
   * Delete a folder. **Its decks are not deleted** — `decks.folder_id` is `ON DELETE SET
   * NULL`, so they surface at the root, filed nowhere and otherwise exactly as they were.
   * Sub-folders *do* go with it. An id that resolves to nothing is a success.
   */
  deckFolderDelete: (id: number) => invoke<void>("deck_folder_delete", { id }),
  /**
   * One deck's history, newest first — `at DESC, id DESC`, because `unixepoch()` has
   * one-second resolution and a single click can write two rows inside one second.
   *
   * `limit` is **required and clamped into `1..=500`** by the backend: a cap rather than a
   * page cursor, because this table grows by one row per edit and a built deck is hundreds of
   * rows, not millions. The clamp is also what stops a `0` or a negative from meaning *no
   * limit at all*, which is exactly how SQLite reads a negative `LIMIT`.
   *
   * A deck that is not there answers an **empty list**, not an error: the history of a deck
   * that does not exist is nothing, and the rows cascade with it.
   */
  deckAuditList: (deckId: number, limit: number) =>
    invoke<DeckAuditEntry[]>("deck_audit_list", { deckId, limit }),
  /** What the plan wants and the deck does not have — see {@link TheoryDiffRow}. One
   *  direction only, inactive categories excluded from both sides. */
  deckTheoryDiff: (deckId: number) => invoke<TheoryDiffRow[]>("deck_theory_diff", { deckId }),
  /**
   * Seed the theory list from the live one. Answers how many **rows** were written.
   *
   * Normally implicit — `deckUpdate(id, { theoryEnabled: true })` does this in the same
   * transaction when the theory list is empty — and offered separately for the reader who
   * wants to start again from what is sleeved up.
   *
   * **It skips rather than folding, and the difference is the whole point of the command.**
   * `deck_theory::seed_from_live` is `ON CONFLICT(deck, variant, category, card) DO NOTHING`:
   * a theory row the reader already made is *their plan for that card*, and topping it up with
   * the live count would silently overwrite the very edit the theory list exists to hold. So a
   * card the plan already holds one of stays at **one** however many are sleeved up — this is
   * the one place in this file where a repeated card is not summed, and "fold" (which means
   * *sum the quantities* in {@link SwapResult.folded}, {@link ipc.deckAddCard} and
   * {@link ipc.deckCategoryDelete}'s move arm) is the wrong word for it. Idempotent, never
   * destructive, and the number it answers is **rows written** — the ones that were missing.
   */
  deckTheoryCopyFromLive: (deckId: number) =>
    invoke<number>("deck_theory_copy_from_live", { deckId }),
  /**
   * Everything the **plan** is short of, onto the wishlist. Answers how many wishes were
   * touched, like its live twin.
   *
   * A second command rather than a variant argument on `deckMissingToWishlist`, because the
   * two are different questions: that one reads `live` and only `live` — what the deck as it
   * stands is short of — while this one reads the difference between the plan and the deck.
   * Neither nets out {@link TheoryDiffRow.ownedSpare}: it is a display field, and subtracting
   * it here would count the live list twice.
   */
  deckTheoryMissingToWishlist: (deckId: number) =>
    invoke<number>("deck_theory_missing_to_wishlist", { deckId }),
  /**
   * Put copies into a category, folding on `(deck, variant, category, card)` — the drag-in
   * and the click-to-add write, and **not** the stepper's.
   *
   * **`categoryId` or `categoryName`, and at least one.** An id is a drop onto a column the
   * reader pointed at; a name is "file it where this card belongs", found-or-created — the
   * word being `autoCategoryFor`'s to compute, because which pile a Sol Ring goes in is
   * domain logic. Passing both uses the id. Passing neither is refused in words.
   *
   * It reads `cards` to denormalize the printing onto the new row, so it refuses a card the
   * database does not have: an orphaned deck row can be stepped and moved but never
   * re-added. `quantity` must be positive; zero is refused rather than treated as a removal.
   */
  deckAddCard: (
    deckId: number,
    cardId: string,
    categoryId: number | null,
    categoryName: string | null,
    variant: DeckVariant,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_add_card", {
      deckId,
      cardId,
      categoryId,
      categoryName,
      variant,
      quantity,
    }),
  /**
   * An absolute quantity — **the stepper's write**, and the one that works on a row whose
   * printing has left the card database.
   *
   * `0` *removes* the row, the wishlist's asymmetry rather than the collection's: a category
   * slot holds an intention and nothing else, and an intention stepped down to none of is
   * withdrawn. The answer then reads `removed: true` with `id: 0` when there was no row to
   * remove in the first place.
   *
   * Adjusts what is there; it does not create. Putting a card into a category is
   * `deckAddCard`.
   */
  deckSetCardQuantity: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_set_card_quantity", {
      deckId,
      cardId,
      categoryId,
      variant,
      quantity,
    }),
  /** Move every copy from one category to another **within one variant**, folding into
   *  whatever the target already holds. The identity travels from the moved row, so an orphan
   *  can be tidied out of the scratchpad like anything else. */
  deckMoveCard: (
    deckId: number,
    cardId: string,
    fromCategoryId: number,
    toCategoryId: number,
    variant: DeckVariant,
  ) => invoke<void>("deck_move_card", { deckId, cardId, fromCategoryId, toCategoryId, variant }),
  /**
   * Swap a deck card to **another printing of the same card**: same category, same variant,
   * same copies, folding into whatever that category already holds of the printing swapped
   * to. The card pane's "Use this printing".
   *
   * The one card write whose identity comes from a fresh `cards` lookup rather than from the
   * row being changed — a move keeps a printing the reader already chose, a swap *is* the
   * reader choosing a new one — so a `toCardId` that no longer resolves is answered as a sync
   * that raced the click, not as an orphan to preserve. The backend refuses two printings of
   * different cards outright; an orphaned `fromCardId` is the exception, because a printing
   * the database has lost has no oracle id to compare and is exactly the row a swap has to be
   * able to rescue.
   */
  deckSwapPrinting: (
    deckId: number,
    fromCardId: string,
    toCardId: string,
    categoryId: number,
    variant: DeckVariant,
  ) =>
    invoke<SwapResult>("deck_swap_printing", { deckId, fromCardId, toCardId, categoryId, variant }),
  /**
   * Everything this deck is short of, onto the wishlist. Answers how many **wishes were
   * touched** — one per oracle card, so the same card short in two categories is one wish for
   * the sum, and pressing twice raises a line rather than making a second one.
   *
   * Reads the `live` variant and skips inactive categories: a plan is not a shopping list,
   * and neither is a pile the reader switched off.
   *
   * `deckId`, where the four commands above take `id`: the odd one out, and Tauri matches by
   * name. It reallocates before counting — a button that shopped for cards already bought
   * would be worse than no button.
   */
  deckMissingToWishlist: (deckId: number) => invoke<number>("deck_missing_to_wishlist", { deckId }),
  /** The format rules as data, in picker order. Seeded by the migration, so this changes at
   *  most once per app version — cached for the session by `useFormatSpecs`. */
  formatSpecs: () => invoke<FormatSpec[]>("format_specs_list"),
  /** `force` skips the 24 h throttle. Rejects if a sync is already running. */
  syncRun: (force: boolean) => invoke<SyncOutcome>("sync_run", { force }),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  onSyncProgress: (cb: (e: SyncProgressEvent) => void): Promise<UnlistenFn> =>
    listen<SyncProgressEvent>("sync:progress", (evt) => cb(evt.payload)),
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
  updateStatus: () => invoke<UpdateStatus>("update_status"),
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
  onUpdateProgress: (cb: (e: UpdateProgressEvent) => void): Promise<UnlistenFn> =>
    listen<UpdateProgressEvent>("update:progress", (evt) => cb(evt.payload)),
  /** A reconcile pass that moved user rows. See {@link ReconciledEvent}. */
  onCollectionReconciled: (cb: (e: ReconciledEvent) => void): Promise<UnlistenFn> =>
    listen<ReconciledEvent>("collection:reconciled", (evt) => cb(evt.payload)),
};

/**
 * The message out of a rejected `invoke`.
 *
 * All three commands return `Result<_, String>`, so the rejection value is that bare
 * string — not an `Error`. Rendering it with `String(e)` would be right for those and
 * `"[object Object]"` for anything the IPC layer itself throws, so both are handled.
 */
export function ipcError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Unexpected error: " + JSON.stringify(e);
}
