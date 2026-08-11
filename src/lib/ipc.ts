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
  | "name"
  | "set"
  | "finish"
  | "quantity"
  | "value"
  | "price"
  | "added";

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
 * Nothing here says "counts toward nothing" any more — {@link DeckCategory.isActive} does.
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
 * Schema v7 replaced the fixed five-word zone with these. The four predefined ones
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
   * **The whole of "counts toward nothing."** An inactive category is left out of the deck's
   * size, its copy limits, its legality check and the gallery's card count, and the allocator
   * claims no collection copy for it — so every card in one reads
   * {@link DeckCard.ownedQuantity} `0` by design rather than because the user is short of it.
   *
   * The Maybeboard is seeded `false` and is not otherwise special: a category of the user's
   * own that they switch off behaves identically, and a Maybeboard they switch *on* counts
   * like anything else.
   */
  isActive: boolean;
  sortOrder: number;
  /** Copies filed here — `sum(quantity)`, not a row count — in the variant that was asked
   *  for. Two printings at 2 and 3 copies read 5. */
  cardCount: number;
  /** Nonfoil `usd` × copies over the same variant, `null` when nothing here has a price. */
  totalPriceUsd: number | null;
}

/**
 * One tag of one deck: a per-deck label a card can carry, at most one per card.
 *
 * `color` names a token from the app's fixed palette, never a CSS colour — picking from that
 * palette is the webview's job, which is why the backend stores whatever string it is handed.
 */
export interface DeckTag {
  id: number;
  deckId: number;
  name: string;
  color: string;
  /** Copies carrying it, `sum(quantity)` like {@link DeckCategory.cardCount}. */
  cardCount: number;
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
 * There is no field here that clears one — `description: ""` writes an empty string rather
 * than a NULL, and `coverCardId` cannot be unset. A deck editor that offers to remove a
 * cover has nothing here to do it with.
 */
export interface DeckPatch {
  name?: string;
  formatKey?: string;
  description?: string;
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
}

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
  /**
   * The cover printing's illustrator, `null` when `cards` has no row for it.
   *
   * Read here so a tile can obey Scryfall's image policy: an `art` crop has no printed
   * frame, so wherever one is shown the artist must be credited. Task 11's ruling is that a
   * cover with no artist is **not drawn** — an orphaned cover heals on the next sync.
   */
  coverArtist: string | null;
  isBuilt: boolean;
  archived: boolean;
  /**
   * `live` copies in **active** categories of kind `main` + `commander` — what "a 60-card
   * deck" means in a caption, and the **same cards the validation engine sizes a deck by**:
   * `SIZE_KINDS` in `features/decks/validation/engine.ts`. One definition, so a tile and the
   * format check beside it never answer the same question with two numbers.
   *
   * Three exclusions. The sideboard and the companion are not the deck — a companion is
   * played beside it, and EDH's is "effectively a 101st card", which is exactly the card a
   * "100-card deck" caption must not count. A **theory** row is a plan and appears on no
   * tile. And an **inactive** category counts toward nothing whatever its kind, which is how
   * the Maybeboard stays out without being named.
   */
  cardCount: number;
  /** Unix seconds. The gallery's sort key, and every card write moves it — including a
   *  removal that found nothing to remove. */
  updatedAt: number;
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
  tagColor: string | null;
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
   * * a `theory` row always reads `0` too: a plan reserves nothing;
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
   * `variant` scopes the **cards** and nothing else: every category and every tag comes back
   * either way, so the columns do not change when the reader switches between the two lists.
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
  ) => invoke<SwapResult>("deck_swap_printing", { deckId, fromCardId, toCardId, categoryId, variant }),
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
