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
 * `FacetResponse`                                 — `src-tauri/src/index/facets.rs`
 * `CardFace`/`CardDetail`/`Printing`/`PrintingsResponse`/
 * `FinishPrices`/`MeldRelation`                  — `src-tauri/src/card.rs`
 * `SyncOutcome`/`SyncStatus`/`Progress`          — `src-tauri/src/sync.rs`
 * `EntryInput`/`EntryPatch`/`EntryChange`/`CollectionQuery`/`CollectionRow`/
 * `CollectionPage`/`CollectionSummary`           — `src-tauri/src/collection.rs`
 * `RowDeck`                                      — `src-tauri/src/collection_decks.rs`
 * `WishInput`/`WishlistQuery`/`WishRow`/`WishlistPage` — `src-tauri/src/wishlist.rs`
 * `DeckInput`/`DeckPatch`/`DeckViewState`/`DeckRow`/`DeckCardRow`/`DeckDetail`/
 * `FormatSpecRow`                                — `src-tauri/src/deck.rs`
 * `CardFilters`, flattened into both list queries — `src-tauri/src/filters.rs`
 * `MarketplaceFeedStatus`                        — `src-tauri/src/marketplace_feed.rs`
 * `CardTags`/`PrintingTags`                     — `src-tauri/src/tags/oracle.rs`
 * `TagStatus`/`TagProgressEvent`                 — `src-tauri/src/tags/mod.rs`, aliased per
 *                                                  dataset by `tags/oracle.rs`/`tags/art.rs`
 * `TagHit`/`TagRef`                              — `src-tauri/src/tags/query.rs`
 * `MutedTag`                                     — `src-tauri/src/tags/muted.rs`
 * `TagTerms`                                     — `src-tauri/src/filters.rs`
 *
 * **Six settings carry no struct at all.** Each is one `app_meta` row: two answered as a bare
 * string — `getMarketplace`/`setMarketplace` (`src-tauri/src/marketplace.rs`) and
 * `printingGroupBy`/`setPrintingGroupBy` (`src-tauri/src/card.rs`) — one, `cardZoom`/
 * `setCardZoom` (`src-tauri/src/zoom.rs`), as a bare `Record<string, number>`, and three as a
 * bare `boolean`: `navCollapsed`/`setNavCollapsed` (`src-tauri/src/nav.rs`),
 * `deckSearchOpen`/`setDeckSearchOpen` (`src-tauri/src/deck.rs`) and
 * `deckDrivenCollection`/`setDeckDrivenCollection` (`src-tauri/src/deck_driven.rs`). All six are
 * the shape a stored preference has to have: the read falls back on its default for a row that
 * is missing *or* holds a value this build does not recognise, and only the *write* refuses.
 *
 * Three of them are therefore typed loosely here rather than as their unions: the narrowing
 * belongs to the module that owns the vocabulary (`@/lib/marketplace`,
 * `@/features/card/printings`, `@/lib/cardZoom`), and a row a newer build wrote must reach this
 * side as what it is. **The three booleans are the ones with no narrowing to do**, and that is
 * the same argument arriving at nothing rather than an exception to it: a boolean has no
 * vocabulary for a later build to have widened, so there is no third state a row could come back
 * in. Each far end folds a missing row, a junk row and an unreadable one alike into its own
 * default — `false` for the nav rail, which is expanded; `true` for the deck editor's search
 * column, which is open; `false` for the collection's source, which is the reader's own
 * hand-kept rows — and `boolean` here is the whole of the type, with nothing left for this side
 * to decide. All three store `"1"`/`"0"` and read anything else as that default, so a hand-edit
 * or a spelling a future build invents is already collapsed before it reaches the wire.
 *
 * **The third of them is the one whose *refusal* is not swallowed**, and that is a caller's
 * decision rather than a difference in the command: `set_deck_driven_collection` answers the
 * same `BUSY` the other two do, but the flag decides what the Collection page is a list of, so
 * `@/lib/useDeckDrivenCollection` rolls the control back and shows the sentence where
 * `@/lib/useNavCollapsed` keeps the reader's choice and says nothing.
 *
 * The zoom row is the one of the five whose *shape* is a map, and the difference is worth a
 * sentence: it has no single default to fall back on, because there are seven walls and each one
 * has been zoomed or not. So the backend answers only what it has, and a section it says nothing
 * about keeps the default the store was built with.
 *
 * **Every price field on this page is singular, and the marketplace is how it was chosen.**
 * A query carries `marketplace`; what it answers with carries one `price` / `unitPrice` /
 * `totalPrice` / `value`, already in that marketplace's money — or, where a *card* rather than
 * a priced list is the answer, one {@link FinishPrices} triple in it. There is no twin field to
 * pick between and no fallback across marketplaces — see `@/lib/marketplace`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Condition } from "./conditions";
import type { Finish } from "./finish";
import type { MarketplaceId } from "./marketplace";
import type { ImageVariant } from "./images";
import type { SortSpec } from "./sort";

/**
 * The search's sortable columns. Mirrors `SEARCH_SORTS` in `src-tauri/src/search.rs`; a key
 * that is not there is dropped at the far end, which is a control that does nothing.
 *
 * The first five are the table's headers. `manaValue` and `released` have **no column to
 * press** and are reachable only from the filter bar's sort picker — the trade the
 * collection's `added` and `price` already made. There is no room for a column: the search
 * table shares its squeeze between two flexible tracks and already reaches 1280px with the
 * card pane open (see `columnsFor` in `SearchPage.tsx`), so a seventh and an eighth would come
 * out of the Name column, which is what identifies a row.
 */
export type SearchSortKey = "name" | "set" | "type" | "rarity" | "price" | "manaValue" | "released";

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
  /**
   * Every printing of one oracle card — the card, not the cardboard. Absent means unset,
   * like every other filter here; it ANDs with the rest. Mirrors
   * `CardFilters::oracle_id`/`SearchRequest::oracle_id` in `src-tauri/src/filters.rs` and
   * `search.rs`.
   */
  oracleId?: string;
  /** Set codes. ORed with each other, ANDed with every other filter. */
  sets?: string[];
  /** Mana-value chips: 0–7 match exactly, 8 means "8 or more". */
  manaValues?: number[];
  /**
   * Also match printings whose printed cost names `{X}`. Rust: `mana_x: Option<bool>`.
   *
   * **One more chip in the mana-value group, ORed with the numbers beside it** — pressing X
   * alone asks for the X spells, pressing X and `3` asks for both piles at once. And it is
   * **additive rather than a re-filing**: an X card still matches its own mana value (Fireball
   * is `{X}{R}`, mana value 1, and answers the `1` chip), so a reader who names both chips gets
   * that card once, in one row, rather than a duplicate. The deck editor's
   * `separateXGroup` is the *other* shape of this idea and deliberately not this one — there a
   * card is in the X pile **instead of** its bucket, because a heading that counted it twice
   * would make the columns add up to more than the deck.
   */
  manaX?: boolean;
  rarity?: string;
  /** Omitted means true: digital-only printings are hidden unless asked for. */
  paperOnly?: boolean;
  /**
   * `true` narrows to printings that are legal or restricted in **at least one** format —
   * `cards.legal_mask != 0`, which is what hides art series, tokens, emblems, memorabilia
   * and the acorn half of the un-sets.
   *
   * **Omitted means false**, the opposite of {@link paperOnly}: absent is what this command
   * has always answered, so nothing changes for a caller that has not heard of it. The search
   * view sends `true` on every row of its format select but the first, `Any card` — the one
   * control that decides this flag and {@link format} together (`formatParams`).
   */
  playableOnly?: boolean;
  /**
   * Scryfall **art** tags — what the picture shows, which is what a Tags-page deck is built
   * around. Matched against the closure on `cards.illustration_id`, so this is a fact about an
   * *illustration*: a card printed with five arts matches under the one that holds the motif and
   * not under the other four. See {@link TagTerms}.
   */
  artTags?: TagTerms;
  /**
   * Scryfall **oracle** tags — what the card does (`removal`, `ramp`, `recursion`). {@link
   * artTags}' shape over the other taxonomy, matched on `cards.oracle_id`; the two AND with each
   * other, so "a dog that ramps" is one request.
   */
  oracleTags?: TagTerms;
  /**
   * `"strong"` drops the art matches Scryfall called `weak`; absent or `"any"` keeps them.
   * **Nothing else on this request is affected** — not {@link artTags}' excludes, and not
   * {@link oracleTags}, whose closure has no weight at all. See {@link ArtWeightFloor}, which
   * is also where the wording a control may not use is written down.
   */
  artWeightFloor?: ArtWeightFloor;
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
   * Which marketplace every price on the page is quoted from — the source *and* the money, in
   * one parameter. Absent means `tcgplayer`, which is what this command answered before the
   * setting existed.
   *
   * **It decides the numbers, not just their order.** `price_expr(marketplace)` builds the one
   * SQL fragment every price site reads: Scryfall's blob for TCGplayer and Cardmarket, a join
   * against `marketplace_prices` for Card Kingdom and Mana Pool. So it subsumes the `currency`
   * sort parameter this field replaced — a `price` sort orders by whatever this names, and a
   * column cannot end up sorted in one marketplace's money while printing another's.
   */
  marketplace?: MarketplaceId;
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
  /**
   * The row's own price **in the marketplace the request named** — a display/sort fallback
   * chain across finishes (nonfoil → foil → etched), never a per-finish figure.
   *
   * One field, because the marketplace is a query parameter: the backend has already decided
   * whose price this is, and a cell renders it with `formatPrice(price, marketplace.currency)`.
   * `null` is *unpriced at that marketplace* and is drawn as an em dash — never a reason to
   * reach for another marketplace's number. It is `null` far more often on some than on
   * others: there is no `eur_etched` key in Scryfall's data at all, so an etched-only printing
   * is unpriced on Cardmarket, and a printing a feed has never listed is unpriced there.
   */
  price: number | null;
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
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
  /**
   * One of the cards the Commander bracket system counts as a **game changer** — a crown on
   * the tile and in the table's Name cell, beside the foil and etched marks.
   *
   * Mirrors `CardSummary::game_changer` in `src-tauri/src/search.rs`, which is `bool` and not
   * `Option<bool>`: `cards.game_changer` is nullable, a NULL there means *not on the list*, and
   * the backend reads it as an `Option` and flattens it rather than handing this side a third
   * state every crown would have to fence.
   *
   * So this is a plain `boolean`, exactly like {@link ImportMatch.gameChanger} and **unlike**
   * {@link DeckCard.gameChanger}, which is `boolean | null`. That difference is real rather than
   * mirror drift: a deck row survives its printing leaving `cards`, and an orphan knows nothing
   * about itself. A search row can never be one — a row that came back from `cards` is a card
   * that is there.
   *
   * An **oracle-level** fact, not a property of the cardboard: every printing of a card agrees,
   * so a collapsed row takes it from the representative printing and needs no aggregate.
   */
  gameChanger: boolean;
  /**
   * Copies the collection holds of **this printing, across every finish and condition** —
   * a badge on a search result, and finish-*blind*.
   *
   * One of **four** fields in this file with this name, and only one of the other three asks
   * the same question. {@link WishRow.ownedQuantity} is counted against one wish and *is*
   * finish-aware, so a foil wish is not satisfied by the nonfoil in the binder;
   * {@link DeckCard.ownedQuantity} is neither — it is the copies one deck's allocator
   * *secured*, oracle-grained and clamped to what the entries still hold. The fourth,
   * {@link ImportMatch.ownedQuantity}, **is** this number: every copy of one printing,
   * finish-blind, asked per decklist line instead of per search row. Read each against its own
   * row.
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
   * Cheapest and dearest {@link CardSummary.price} among the printings this row stands for;
   * both equal it when the search is not collapsed. Render a range only when the two differ —
   * most cards have one printing, and `$2.15–$2.15` is noise.
   *
   * Unsuffixed, like every price on this page: the pair spans the printings that have a price
   * **at the marketplace the request named**, so the same group's span legitimately differs
   * between two marketplaces — or exists at one and not at another.
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

/**
 * Facet counts for one search — how many results each filter option would leave.
 *
 * Mirrors `src-tauri/src/index/facets.rs`. **`ready: false` means the index is still
 * building**, not that everything is empty: the UI leaves every control live, because
 * not-greyed has to mean "we don't know" rather than "this is empty".
 *
 * A **separate command** from {@link SearchResponse}'s, because these depend on neither the
 * sort nor the offset — they must not be recomputed per page, and they must never delay
 * page one.
 */
export interface FacetResponse {
  /**
   * Keyed `W`/`U`/`B`/`R`/`G`/`C`, and **the size of the result set after toggling that
   * chip** rather than a count of cards carrying that colour. Colours are subset semantics,
   * so pressing one with another already on *broadens*; compare against {@link total}.
   */
  colors: Record<string, number>;
  /** Keyed `"0"`–`"8"`, `8` meaning eight-or-more. Plain counts. */
  manaValues: Record<string, number>;
  /**
   * How many printings name `{X}` in their printed cost — the X chip's count. Rust:
   * `mana_x: i64`.
   *
   * **A field beside the map and not an `"x"` key inside it**, because that map is keyed *by
   * mana value* and X is not one: every other key parses as a number and the chips above read
   * it as one. A string key that only looks like the others is the kind of thing a
   * `Number(key)` somewhere turns into `NaN` and files at the head of the curve. And it
   * **overlaps** the map rather than carving a slice out of it: an X card is counted here *and*
   * under its own mana value, matching {@link SearchRequest.manaX}'s additive semantics, so
   * this number must never be added to the map's.
   */
  manaX: number;
  /** Keyed by `legalities` key. Plain counts. */
  formats: Record<string, number>;
  /**
   * Keyed by set code. Plain counts, and **every code in the corpus arrives, zeros
   * included** — 1 047 keys on the live corpus, on every **ready** response, whatever the
   * filters are. A cold one carries this map empty; that is what {@link ready} is for.
   *
   * **An absent key means "unknown", never zero.** The set picker's options come from a
   * session-cached `list_sets()` and its counts come from the index, so the two sources can
   * disagree — a set the corpus has since lost is a code the picker still offers and this
   * map has never heard of, and it stays live rather than greying.
   */
  sets: Record<string, number>;
  /**
   * Both sides of the tri-state chip, for its tooltip. The chip is never disabled. Mirrors
   * Rust's `OwnedFacets`, inline because nothing else here needs the name.
   */
  owned: { owned: number; missing: number };
  /**
   * The current result size, which a colour count is read against.
   *
   * **Printings, and not {@link SearchResponse.total}** — the two are different numbers
   * under one name. `collapse` folds printings into cards for the *page*, and this count
   * ignores it; `SearchResponse.total` also stops counting at 5 000 and says so in
   * `totalIsCapped`, while this one is exact. The colour rule is only correct against this
   * one.
   */
  total: number;
  ready: boolean;
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

/**
 * What one printing costs per finish, **at the marketplace the request named**.
 *
 * Keyed by the `Finish` union's own three words, so a price cell is `finishPrices[finish]` and
 * there is no table in between to get wrong. `null` is *unpriced at that marketplace* and draws
 * as an em dash — never a reason to reach for another marketplace's number, and the holes are
 * different at every one of them: Scryfall carries no `eur_etched` key at all, so etched is
 * `null` on Cardmarket for every card in the game, while Mana Pool publishes real etched prices
 * and either bulk feed can simply never have listed a printing.
 *
 * This replaced a raw `prices` blob on {@link CardDetail} and {@link Printing}. The blob is
 * TCGplayer's six keys and Cardmarket's, and it is *structurally* blind to the two marketplaces
 * whose prices live in `marketplace_prices` — a card pane reading it could only ever draw em
 * dashes on half the picker.
 */
export interface FinishPrices {
  nonfoil: number | null;
  foil: number | null;
  etched: number | null;
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
  /** Per finish, at the marketplace `cardDetail` was called with. See {@link FinishPrices}. */
  finishPrices: FinishPrices;
  finishes: string | null;
  /**
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
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
  /** Per finish, at the marketplace `cardPrintings` was called with — the figures a reader
   *  compares printings by. See {@link FinishPrices}. */
  finishPrices: FinishPrices;
  promo: boolean;
  /**
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
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

/**
 * One of the *other* cards a `meld` printing is part of — the third card two halves make, or
 * the two halves a melded card was made from.
 *
 * Read out of Scryfall's `all_parts` on the row's `raw` blob, which is why it is a command
 * rather than a column: nothing in `cards` carries the relationship, and the blob is a gzip
 * member the frontend has no copy of.
 *
 * **The card the question was asked about is excluded by _name_, not by id.** A meld row's
 * `all_parts` can name a *different printing* of the same card — measured on
 * `Brisela, Voice of Nightmares` id `0cd83c0e-…`, whose own `meld_result` entry is id
 * `bbcd6747-…` — so an id-based exclusion leaves the open card in its own list of relatives.
 */
export interface MeldRelation {
  id: string;
  name: string;
  /**
   * Scryfall's `component`, verbatim: `"meld_part"` or `"meld_result"` — which side of the
   * relationship this row is, and the only thing telling "the card this melds into" from "the
   * halves this melded from". Handed over unread, like every other Scryfall vocabulary in this
   * file.
   */
  component: string;
  /**
   * The illustrator of *that* card, carried on the relation rather than fetched with a second
   * `cardDetail`: an orientation control swaps the **picture** to the melded card while the
   * pane's facts stay those of the card the reader opened, and Scryfall's image policy requires
   * the credit to name the illustrator whose art is on screen.
   *
   * `null` when the id names no row in `cards` — which no live row does: all 72 `meld` rows'
   * references resolve (measured on the 116 590-row corpus).
   */
  artist: string | null;
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
  /** Also match printings whose printed cost names `{X}` — see
   *  {@link SearchRequest.manaX}, which is the same field on the same chip group: ORed with
   *  the numbers above and additive, never a re-filing. Rust: `mana_x: Option<bool>`. */
  manaX?: boolean;
  rarity?: string;
  /** Omitted means true in the search and false in the collection: a search offers cards to
   *  own, a collection lists cards that are owned. */
  paperOnly?: boolean;
  /** Omitted means **false** everywhere — see {@link SearchRequest.playableOnly}, which is
   *  the only place anything sends it. A collection lists what the user owns, and an art
   *  card in a binder is still in the binder. */
  playableOnly?: boolean;
  /**
   * Scryfall art tags, on the closure keyed by `cards.illustration_id` — see
   * {@link SearchRequest.artTags}.
   *
   * **Declared here as well as on the search, because `filters::push_card_filters` emits it for
   * all three lists** — the collection's and the wishlist's queries flatten this struct, so an
   * owned-cards wall can be narrowed to a motif without a second filter path. `oracleId` above
   * is the field that is deliberately *not* here, and the asymmetry is Rust's own.
   *
   * **A tag is a claim only a card row can answer**, so unlike `setCode` there is no fallback to
   * the row's own columns: an orphaned collection entry fails every `include` and passes every
   * `exclude`, exactly as `cards.illustration_id` being NULL does (4 977 of 116 712 live
   * printings, measured 2026-08-20).
   */
  artTags?: TagTerms;
  /** Scryfall oracle tags, on the closure keyed by `cards.oracle_id` — see
   *  {@link SearchRequest.oracleTags}. */
  oracleTags?: TagTerms;
  /** `"strong"` drops the `weak` art matches; absent or `"any"` keeps them. Art includes only —
   *  see {@link ArtWeightFloor}. */
  artWeightFloor?: ArtWeightFloor;
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

/**
 * What a bulk import writes into the collection or the wishlist. `add` folds onto the grain like
 * a quick-add repeated per line; `set` writes each line's number as the truth rather than adding
 * to what is already there. There is deliberately no `replace`: the deck's `replace` clears one
 * variant of one deck, and the same word over a collection would empty a 3,000-card record from
 * a 40-line paste with the file that caused it looking completely ordinary. An unknown mode is
 * refused by the backend rather than defaulted.
 */
export type TransferImportMode = "add" | "set";

/**
 * One line of a bulk import, after this side has decided everything a *collection* decision is.
 *
 * `condition` is `undefined` rather than defaulted here: an absent one means the file said
 * nothing, and the **dialog** is where the reader chose what that becomes. Defaulting it in two
 * places is how the preview and the write come to disagree.
 */
export interface CollectionImportItem {
  cardId: string;
  quantity: number;
  finish: Finish;
  condition?: Condition;
  conditionOriginal?: string;
  purchasePrice?: number;
  purchaseCurrency?: string;
  acquiredAt?: string;
  acquisitionSource?: string;
  notes?: string;
}

/**
 * What a bulk import did. `removed` is the wishlist's alone — a `set` of 0 deletes a wish and
 * leaves a zero-quantity collection row — and it is `0` here rather than absent, so one shape
 * covers both commands.
 */
export interface ImportCommitOutcome {
  added: number;
  updated: number;
  /** The wishlist's alone: a `set` of 0 deletes a wish. Always 0 from the collection. */
  removed: number;
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
  /** Which marketplace every price is quoted from, and therefore what the `value` and `price`
   *  orders rank by. Absent means `tcgplayer`; see {@link SearchRequest.marketplace}. */
  marketplace?: MarketplaceId;
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
  /**
   * The oracle card this printing is of — read off `cards.oracle_id`, never denormalised
   * onto the entry.
   *
   * **`null` means exactly one thing: this entry is orphaned.** No live `cards` row is ever
   * null (0 of 116,590), so a healthy entry's card row always answers one — the fact the card
   * menu's "View all printings" reads to tell "this printing has left the card database" from
   * "the reader's copy is fine".
   */
  oracleId: string | null;
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
  /**
   * What state the copy is in, and **`null` when the collection is derived from the decks** —
   * a deck card has nowhere to record a condition.
   *
   * Not the column's `NM` default, which would be a fact nobody stated: this field reaches the
   * reader's exported file through `fromCollectionRow`, and `NM` on every derived row would be
   * this app writing a grade into their CSV on their behalf.
   */
  condition: string | null;
  quantity: number;
  tradelistQuantity: number;
  /**
   * Per copy, per finish, at the marketplace the query named — never the derived `price_usd`
   * column, which is a fallback chain and would price a plain copy at foil rates.
   *
   * `null` is unpriced *there*, and the holes are not the same at every marketplace:
   * `eur_etched` does not exist in Scryfall's data, so an etched card is unpriced on
   * Cardmarket; a printing a bulk feed has never listed is unpriced on that feed. Neither is
   * ever filled in from another marketplace's number.
   */
  unitPrice: number | null;
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
  /**
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
  /**
   * JSON: **this printing's** legality blob, the same shape {@link DeckCard.legalities}
   * carries — 23 keys and growing, so parse it and never index fixed fields.
   *
   * **It rides here for one reader, the Arena export filter** — issue #192,
   * `src/features/transfer/export/arena.ts`. Nothing the collection screen draws touches it.
   * The blob rather than `cards.legal_mask`, which would have been 8 bytes against this
   * field's 483-byte average (528 at most, over the 116,712-printing corpus of 2026-08-22,
   * where `promoTypes` above averages 23): bit positions are stored data Rust owns and freezes
   * — `src-tauri/src/legalities.rs` — and a copy of that order over here would be a second
   * place for it to drift. Scryfall's key *names* are public vocabulary and cannot.
   *
   * `null` is an orphan — the printing this entry names has left `cards`.
   */
  legalities: string | null;
  /**
   * How many decks these copies are spread across — `null` unless the collection is derived
   * from them, because the hand-kept table has no such fact.
   *
   * Free: it rides along in the same aggregate the quantity is summed by. The deck *names* do
   * not — {@link ipc.collectionRowDecks} answers those, asked on hover rather than putting
   * several hundred of them on a 100-row page.
   */
  deckCount: number | null;
}

/**
 * One deck holding copies of a collection row's printing. `src-tauri/src/collection_decks.rs`.
 *
 * Read lazily, per row, behind {@link CollectionRow.deckCount} — never returned with the page.
 */
export interface RowDeck {
  deckId: number;
  deckName: string;
  /** Copies in **this** deck, summed across its categories — the inactive ones included,
   *  because these lines have to add up to the count the row shows. */
  quantity: number;
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
  /** Summed at the marketplace the query named, over the copies it has a price for. */
  value: number;
  /** Copies with no price for their finish **at that marketplace**. Shown beside the value,
   *  because a total that silently omits 400 cards is a number that lies by rounding down —
   *  and the count travels with its own figure, since the two marketplaces do not have the
   *  same holes. */
  unpriced: number;
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

/** One line of a bulk import, after this side has decided everything a *wishlist* decision is. */
export interface WishlistImportItem {
  oracleId?: string;
  /** Absent is a wish for **any printing** — what a wishlist usually means, and what the
   *  planner writes for a line that named no set. Not a looser version of a pinned wish: the
   *  storage grain already treats the two as different rows. */
  cardId?: string;
  quantity: number;
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
  /** Which marketplace every price is quoted from, and therefore what the `cost` and `price`
   *  orders rank by. Absent means `tcgplayer`; see {@link SearchRequest.marketplace}. */
  marketplace?: MarketplaceId;
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
  /**
   * The joined card's type line, for one reader: a **pinned wish dragged onto the sidebar's
   * Decks entry**, which lands in a deck with no column to have been pointed at, so
   * `autoCategoryFor` names the pile from this and nothing else.
   *
   * `null` only when the join found no card at all — an orphan. An *any-printing* wish does
   * carry one, because the query coalesces to the newest printing of its oracle card, the same
   * way `rarity` and `manaCost` beside it do. Nothing on the wishlist draws it.
   */
  typeLine: string | null;
  /**
   * The printing this wish is **drawn as** — what the wall puts a picture of on its tile.
   *
   * Not {@link WishRow.cardId} and never to be read as one: that is what the wish is *for* and
   * is `null` for an any-printing wish, while this is answered for both kinds by the same join
   * `rarity` and `manaCost` come off. A pinned wish resolves to its own printing; an unpinned
   * one to the newest printing of its oracle card, so the tile has art while its caption goes
   * on saying "Any printing".
   *
   * `null` is a genuine orphan — no printing in `cards`, no oracle match — and draws the
   * no-art frame with the name.
   */
  artCardId: string | null;
  quantity: number;
  preferredFinish: string | null;
  /** The cheapest way to satisfy this wish, per copy, at the marketplace the query named: the
   *  preferred finish's price if one is named, else the nonfoil price of the printing (or of
   *  any printing of the oracle card). `null` is unpriced there — {@link CollectionRow.unitPrice}
   *  has the rule and the two ways a hole happens. */
  unitPrice: number | null;
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
  /**
   * JSON: the joined printing's legality blob — the fact the Arena export filter reads
   * (issue #192), and its only reader. {@link CollectionRow.legalities} carries the argument
   * for the blob over a mask.
   *
   * **An any-printing wish carries one**, the same way {@link WishRow.typeLine} and
   * {@link WishRow.artCardId} beside it do: the join coalesces to the newest printing of the
   * wish's oracle card. `null` is a genuine orphan — no pinned printing, no oracle match.
   */
  legalities: string | null;
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
 * Who made a category — `deck_categories.origin`, schema v15.
 *
 * **Rust records the provenance as a fact; this layer draws the conclusion from it.** `'auto'`
 * is written by `category_for_name`, the find-or-create the add and import paths file a card
 * with; `'user'` by `create_category` (the panel's "New category" button) and by the four seeds
 * in `ensure_predefined_categories`. `category_for_name` **finds before it creates**, so a pile
 * the reader made keeps `'user'` for ever even once the app starts filing cards into it.
 *
 * That last sentence is the entire reason this is a column and not a name list. "Ramp", "Draw",
 * "Removal" and "Lands" are exactly what a person calls their own piles, and
 * `DECK_CATEGORY_GRAIN` is `(deck_id, name)` — one pile per name per deck — so a rule reading
 * the *name* would quietly take over the pile a reader made deliberately. **The name is the
 * user's; the kind is what the rules read**, and provenance is the same kind of fact as the
 * kind.
 *
 * No CHECK behind it (`ALTER TABLE ADD COLUMN` cannot add one) and no Rust validation either,
 * which is the deliberate difference from `decks.last_variant`: `origin` is never supplied by a
 * caller, so there is no untrusted value to fence.
 */
export type CategoryOrigin = "user" | "auto";

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
 * Which object a deck row plays — `deck_cards.finish`, schema v18.
 *
 * **`null` is the regular copy, and `"nonfoil"` is not in this type.** Rust's
 * `deck::normalise_finish` maps the word to NULL at the one command boundary and the column's
 * CHECK makes any other path a hard error, because two spellings of "regular" would be two rows
 * on `DECK_CARD_GRAIN` that draw identically on screen and sum apart. Narrowing it here means a
 * surface cannot send the spelling that does not exist.
 *
 * It is the same shape `soleFinish` in `src/lib/finish.ts` already answers in, and for the same
 * reason: nonfoil is the finish a price is assumed to be, so it is the one that needs no word.
 *
 * **This is part of a deck row's address, not just its content.** A foil copy and a regular copy
 * of one printing in one pile are two rows, so every card command carries it.
 */
export type DeckFinish = Exclude<Finish, "nonfoil"> | null;

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
   * Who made this pile — {@link CategoryOrigin} — and, beside `kind`, the only thing
   * `grouping.ts`'s `drawsWhenEmpty` reads.
   *
   * `'auto'` means the app made it while filing a card and the reader never asked for it, so it
   * is drawn only while it holds one: *Ramp* arrives with the first ramp spell and goes with
   * the last. `'user'` is a pile made with intent — **including the four seeded zones**, which
   * the schema writes as `user` because nobody wants the Sideboard disappearing — and it draws
   * until the reader deletes it. There is no hide flag and none is wanted; delete is the
   * removal, and {@link DeckCategory.isActive} still means "counts toward nothing" rather than
   * "goes away".
   *
   * Rows that predate v15 were backfilled by a one-time name guess, which is the one place this
   * field is not evidence: both ways of being wrong are mild and self-correcting.
   */
  origin: CategoryOrigin;
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
  /** Nonfoil unit price × copies over the same variant, at the marketplace the read named;
   *  `null` when nothing here has a price there. A partial sum rather than nothing, and two
   *  marketplaces' totals over one pile are legitimately not a conversion of each other — each
   *  omits the copies *it* cannot price. */
  totalPrice: number | null;
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
 * A tag's stored colour: `#rrggbb`, the colour itself.
 *
 * **It was a palette token — `gold`, `ember`, … — until 2026-08-20**, and rows written before
 * then still hold one. `features/decks/tagColors.ts` owns both ends of that: what the picker
 * writes, and the six retired words it still reads. Nothing here changed shape, because nothing
 * here ever described one.
 *
 * **Deliberately `string` and not a union**, which is the one place this file declines to
 * narrow a Rust `String`. `deck_tags.color` carries no CHECK — the backend validates only
 * that it is non-empty, because picking what a colour *is* belongs to the webview
 * (CLAUDE.md's Rust/TS boundary). A union here would make a colour written by a newer build a
 * **type error at the read**, when the behaviour that was actually designed is a fallback:
 * `tagColorCss` answers the default for any string it cannot read, so an unknown colour is a
 * visible dot rather than a crash. The alias exists to say all of that at every field that
 * holds one.
 */
export type TagColor = string;

/**
 * One tag **in use in one list of one deck** — a label a card can carry, at most one per card.
 *
 * The "at most one" is the `deck_cards.tag_id` column itself and nothing else — there is no
 * join table and no constraint to relax if that ever changes.
 *
 * **It carried a `deckId` until schema v21 and no longer can**, because there is no such fact:
 * a tag is one app-wide row ({@link GlobalTag}) and what a deck has is not a list of tags but a
 * list of cards, some of which wear one. So this row is a tag *and* a fact about the deck and
 * variant it was read by — which is why `deckTagList` cannot answer a tag nothing is wearing,
 * and why `deckTagAll` exists.
 */
export interface DeckTag {
  id: number;
  name: string;
  color: TagColor;
  /** Copies carrying it, `sum(quantity)` like {@link DeckCategory.cardCount}, and scoped to
   *  the same deck **and variant** the read asked by. Never zero: a zero would mean the row is
   *  not in this list at all, and then it is not in the answer. */
  cardCount: number;
}

/**
 * One tag as a thing in itself — every tag there is, worn or not.
 *
 * **The whole list is app-wide, and that is the feature rather than a convenience.** A tag was
 * per-deck until schema v21: `Cut candidate` in four decks was four rows, four colours and four
 * things to rename. It is one row now, so recolouring it recolours it everywhere, and a name a
 * tag already holds cannot be taken by a second one — compared with
 * {@link tagNameKey}'s normalisation, not by the word.
 *
 * This replaced `TagSuggestion`, which had a name and a colour and no id, because picking one
 * *copied* it into the deck you were in. Picking one now **uses** that very tag.
 */
export interface GlobalTag {
  id: number;
  name: string;
  color: TagColor;
  /** Copies wearing it anywhere — every deck, both variants. `0` for a tag nothing wears,
   *  which is a row this list can answer and {@link DeckTag} never can. */
  cardCount: number;
  /** Decks with at least one card wearing it — what a delete confirmation quotes, because the
   *  reach of that press is the app's and not the open deck's. */
  deckCount: number;
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
 * The comparison is on the **exact card — `(cardId, finish)`**, and it was the oracle card
 * until 2026-08-20. A plan that names the foil retro-frame Sol Ring is a plan for that piece of
 * cardboard: neither a different printing of it nor the regular copy in the live list answers
 * it, and the two objects are separate lines here, priced apart. An orphan needs no special case
 * under that rule — its `cardId` is its identity like everything else's.
 *
 * **Which pile a card is in is not compared at all.** Placement is not possession, so a card the
 * two lists file differently is no difference, and each side is summed across its categories
 * before they are subtracted — the row is captioned by the category the editor lists first
 * purely so the shopping list reads.
 *
 * **So neither `cardId` nor `finish` is unique on its own**: a list is keyed by the pair.
 */
export interface TheoryDiffRow {
  /** The printing **the theory row names**, which is the printing the reader would be buying.
   *  When the same card is filed in two theory categories this is the first row's category.
   *  **Not unique across the list** — pair it with {@link TheoryDiffRow.finish} to key a
   *  render. */
  cardId: string;
  name: string;
  /** The category the theory row is filed under — the pile this card is wanted *for*, which is
   *  what makes a shopping list readable ("2 more Ramp, 1 more Removal"). */
  categoryName: string;
  /** How many more copies theory wants than live has. **Always positive**: a card live has as
   *  many of is not on this list, and one it has more of is a cut rather than a purchase. */
  quantity: number;
  /** What one copy of this printing costs at the marketplace the read named —
   *  {@link DeckCard.unitPrice}'s rule, so a foil-only printing is quoted at its foil rate
   *  rather than reading as unpriced. Never `cards.price_usd`, the same chain precomputed for
   *  the search's sort, which nothing here sums. */
  unitPrice: number | null;
  setCode: string;
  collectorNumber: string;
  /**
   * Which **object** this line is for — `deck_cards.finish`, so `null` is the regular copy.
   *
   * **Half of the row's identity**, with {@link TheoryDiffRow.cardId}: a foil Sol Ring and a
   * regular one are two pieces of cardboard to go and find, two rows in `deck_cards`, and two
   * different prices — {@link TheoryDiffRow.unitPrice} is already quoted per finish, so folding
   * them would be one line charged at whichever of the two came first.
   */
  finish: DeckFinish;
  /**
   * Copies of **this printing, in this finish**, the collection holds that **no built deck has
   * claimed** — the number that turns "I need two more of these" into "and one is in the box
   * already". It answers on the row's whole identity because the comparison above does, which is
   * also what keeps the strip's plain sum of this field honest: any wider answer counts one
   * binder copy once per row that could have used it.
   *
   * **A display field, and never a term in an arithmetic.** It is deliberately not netted out
   * of {@link TheoryDiffRow.quantity}, least of all by `deckTheoryMissingToWishlist`:
   * `quantity` has already subtracted the live list and this number has not, so an unbuilt
   * deck's own live copies read as spare here — right for a person, wrong for a subtraction.
   */
  ownedSpare: number;
  /**
   * How many of this row's {@link TheoryDiffRow.quantity} the **live list already plays as a
   * different printing or finish of the same card** — the copies that are an upgrade rather
   * than a hole.
   *
   * The diff compares the exact card, so a plan naming one Sol Ring against a deck sleeving
   * another is a full row here and reads as a card the reader has not got. For buying, that is
   * right — they would still have to find it. For *playing*, it is not: the deck runs. This
   * field is the difference between the two readings, and it is what the dialog's
   * `Missing` / `Different printing` filter is computed from.
   *
   * **Never greater than {@link TheoryDiffRow.quantity}, and 0 for an orphan.** Copies are
   * claimed per oracle card, in the list's own reading order, out of a pool the backend sizes
   * as *live copies of that card minus the ones an exact line already matched* — so one live
   * Bolt cannot excuse two rows, and a row whose printing has left the card database has no
   * oracle card to be matched by.
   *
   * A row can be **partly both**: theory 2× art A against live 1× art B is `quantity: 2`,
   * `heldAsOtherPrinting: 1` — one copy to find, one already on the table. Such a row shows
   * under both filters at its full quantity, because the full quantity is what a press writes.
   */
  heldAsOtherPrinting: number;
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
/**
 * What the deck editor's two reversal buttons would do — each the history row it would put
 * back, or `null` when there is nothing there.
 *
 * The **entry** rather than a sentence, because a sentence is domain logic: `auditText.ts`
 * words it, and the button reads "Undo — Removed 2 × Lightning Bolt" by asking that module the
 * same question every row of the history drawer goes through.
 *
 * **The two halves are not symmetrical, and the asymmetry is the design.** `undo` is a fact
 * about the deck: Rust stamps `deck_undo.undone_at`, so the cursor persists and undo carries on
 * below where it stopped after a restart. `redo` is answered only for an id this webview hands
 * *in* — the reader's position in a session, thrown away with the window.
 */
export interface DeckUndoState {
  undo: DeckAuditEntry | null;
  redo: DeckAuditEntry | null;
}

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
 * One new deck, as the "New deck" dialog sends it — **the whole deck, in one INSERT**.
 *
 * Rust carries `#[serde(default)]` so both strings are optional on the wire, but they stay
 * required here: a deck with no name is refused in words (`"A deck needs a name."`), and a
 * blank `formatKey` is not an error but a *decision* — it means `casual`, which is
 * `decks.format_key`'s own DDL default. A call site that wants casual should say so.
 *
 * Everything below `formatKey` is a field the "New deck" dialog now offers, and they travel
 * together on purpose: create-then-patch-then-file is three transactions and a half-made deck
 * to unwind by hand when the second one fails — the trap {@link ipc.deckImportCommit} exists to
 * avoid. One call, one row.
 *
 * **And one audit row.** A deck's birth stays the single `{field:"name", from:null, to:name}`
 * however many fields it was born with. {@link ipc.deckUpdate} writes one row per changed field
 * because each of those is an event; being born is one event.
 *
 * **Nothing here follows {@link DeckPatch}'s `coalesce` rule, because this is an INSERT.**
 * There is no previous value to leave alone: an absent field means the column's own default,
 * and for {@link DeckInput.folderId} that difference is the whole meaning of the field.
 */
export interface DeckInput {
  name: string;
  /** A `format_specs.key`. Validated against the table, not by a foreign key — see
   *  {@link FormatSpec}. Blank means `"casual"`. */
  formatKey: string;
  /**
   * Which platform the deck is for, or `"any"` for none in particular.
   *
   * Optional here and `#[serde(default)]` in Rust, so a caller that has not thought about it
   * makes exactly the deck it always made: absent is blank is `"any"`, the column's own DDL
   * default. **The format is not checked against it** — a Modern deck may say Arena, because
   * the game narrows a *picker* and never the deck.
   */
  gameKey?: DeckGame;
  /** The one-line blurb the gallery tile shows — **not** {@link DeckInput.notes}. Two fields
   *  because they are two things: a caption and a notebook. The "New deck" dialog fills this
   *  now that it hosts the whole settings form; before that it sent name and format alone, and
   *  a blurb could only arrive afterwards through {@link ipc.deckUpdate}. */
  description?: string;
  /** The deck's long-form notes — the v8 column, and not {@link DeckInput.description}. */
  notes?: string;
  /**
   * Point the new deck's cover at a printing's art crop.
   *
   * **`coverKind` is not settable at create**: it keeps its DDL default, `card_art`, which is
   * the kind this field *is* — so a deck born with a card cover already draws it and needs no
   * follow-up. A *custom picture* does need one, and always will: that is
   * {@link ipc.deckSetCoverImage}, which takes a path on disk and a **deck id**, so it cannot
   * run until the deck exists. The create dialog holds a chosen file until the deck is made
   * and uploads it after. See {@link DeckCoverKind} for why a deck carries both at once.
   *
   * A soft reference like every card id in a user table: nothing checks the printing is in
   * `cards`, and an orphaned cover heals on the next sync.
   */
  coverCardId?: string;
  /**
   * Which folder to file the new deck in — and **absent is the top level, deliberately**.
   *
   * **{@link DeckPatch.folderId}'s `coalesce` trap does not apply here, and a reader who knows
   * that rule will assume it does.** A patch writes `coalesce(?n, folder_id)`, which reads a
   * bound NULL as "leave it", so no patch can un-file a deck and {@link ipc.deckSetFolder} is
   * the only command that reaches the root. This is an INSERT with nothing to leave: omitting
   * `folderId` writes the root because that is what the caller asked for. Nothing about
   * `deckSetFolder` changes — it is still the way to un-file a deck that already **exists**.
   *
   * Typed `number | undefined` rather than `number | null` for the same reason: there is one
   * way to say the root here, which is to leave it out. A form whose draft holds
   * `number | null` sends `folderId ?? undefined`.
   *
   * Fenced by a real foreign key — `decks.folder_id REFERENCES deck_folders(id)`, enforced
   * because both are user tables — so a folder id that is not there is refused by SQLite
   * rather than checked in Rust.
   */
  folderId?: number;
  /**
   * Whether the new deck keeps a theory list beside its live one.
   *
   * **At create this sets the column and moves nothing**, because a deck being born has no live
   * cards to move. Contrast {@link DeckPatch.theoryEnabled}, where switching it on makes the
   * deck the reader already has into the plan and leaves the live list empty — there is nothing
   * here for that to move, so the two routes differ in what they *do* and agree exactly on what
   * a new deck ends up with.
   *
   * Worth knowing one step further out: the patch acts on the **transition** off → on, so a deck
   * born with theory already on has made that transition at birth and no later patch will ever
   * move anything for it. Filling the plan from a live list built up afterwards is
   * {@link ipc.deckTheoryCopyFromLive}, which is the reader's button for exactly that and is
   * unchanged.
   */
  theoryEnabled?: boolean;
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
 *
 * **The rule is this struct's, not the deck module's.** {@link DeckInput} carries the same
 * field names and is an INSERT, where an absent `folderId` really does mean the top level —
 * see {@link DeckInput.folderId}, which says so at the field.
 */
export interface DeckPatch {
  name?: string;
  formatKey?: string;
  /** Which platform the deck is for. `"any"` is a value like any other and is written like
   *  one — absent still means "leave it", which is why the column is not nullable. Setting it
   *  moves no format, and setting a format moves no game. */
  gameKey?: DeckGame;
  /** The one-line blurb the gallery tile shows — **not** {@link DeckPatch.notes}. Two fields
   *  because they are two things: a caption and a notebook. Both dialogs write it now: the
   *  "New deck" one through {@link DeckInput.description} at birth, the settings one through
   *  here. */
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
   * **Switching it on _moves_ the live list into theory**, in the same transaction: the deck
   * the reader has built becomes the plan, and the live list starts **empty**. A plan is what a
   * deck is being built toward, and the honest starting point for one is the deck as it stands
   * — so the cards go there rather than being duplicated into two lists that then drift apart.
   * The deck's {@link DeckRow.lastVariant} is left at `"theory"` with them, so the editor opens
   * on the list the cards are now in.
   *
   * It used to *copy*, which is what {@link ipc.deckTheoryCopyFromLive} still does and is now
   * the only thing that does.
   *
   * Switching it off **keeps every row** — it hides a switch, it does not delete a list, and
   * nothing in the backend ever deletes a `theory` row except the ordinary card writes the
   * reader makes against it.
   */
  theoryEnabled?: boolean;
  /**
   * Gather this deck's `{X}` spells under a heading of their own instead of counting each at
   * the mana value Scryfall gives it. See {@link DeckRow.separateXGroup} — a **reading**
   * preference, so switching it writes one column and touches not one `deck_cards` row.
   */
  separateXGroup?: boolean;
  /**
   * Which of this deck's categories an add that names none lands in. See
   * {@link DeckRow.defaultCategoryId} — `0` is `AUTO_CATEGORY` and is a **value**, not an
   * absence: sending it puts the deck back on "by what the card does".
   *
   * That is the one thing to know about this field against the rest of the patch. Every other
   * key here reads absent as "leave it" (`coalesce(?n, column)`) and has no way to say "clear
   * it" — {@link ipc.deckSetFolder} exists because `folderId` cannot. This column needs no such
   * command, because its cleared state is a number.
   *
   * A non-zero id must name a category **of this deck**; Rust refuses anything else by name,
   * since no foreign key says so.
   */
  defaultCategoryId?: number;
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

/**
 * Where a card can be played, as Scryfall spells it — `schema::GAMES`, and the vocabulary of a
 * {@link FormatSpec.games} entry.
 *
 * Three words and not four: these are Scryfall's own, `cards.games` already carries them, and a
 * fourth platform is a word no card in this database holds.
 */
export type Game = "paper" | "arena" | "mtgo";

/**
 * What a deck's own game answer may be — {@link Game}, plus the word for a deck that has not
 * been pinned to a platform. `schema::DECK_GAMES`.
 *
 * **`"any"` is a stored value and not an absence**, which is why `decks.game_key` is `NOT NULL`
 * with a `DEFAULT 'any'` rather than nullable: {@link DeckPatch} is written with
 * `coalesce(?n, column)`, so a bound NULL means *leave it* and could never have said "back to
 * Any". `decks.default_category_id`'s sentinel argument, one column over.
 */
export type DeckGame = Game | "any";

/** One deck as the gallery shows it. */
export interface DeckRow {
  id: number;
  name: string;
  formatKey: string;
  /** From `format_specs`, so the gallery never re-derives a display name. `null` when the
   *  key is one the seeded table no longer carries — a LEFT JOIN, so the deck still lists. */
  formatName: string | null;
  /**
   * Which platform the deck is for — `"any"` on every deck that predates schema v18 or has
   * never been asked.
   *
   * **No `gameName` beside it, unlike {@link DeckRow.formatName}**: a format's display name is
   * a seeded cell the gallery would otherwise re-derive, while a game's is four words in a
   * picker's own list (`GAME_OPTIONS`). There is no table to read one from.
   */
  gameKey: DeckGame;
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
   * this boolean. Without it every reader would have to guess from whether one of the two
   * lists happens to be empty — and an empty list says nothing at all here, since enabling the
   * switch *moves* the live list into theory and quite deliberately leaves live empty.
   */
  theoryEnabled: boolean;
  /**
   * Which of the deck's two lists the editor was last reading — the tab the reader left this
   * deck on, restored when they open it again.
   *
   * Written by {@link ipc.deckSetViewState} and by nothing else, which is what keeps it honest:
   * **looking at a tab is not editing a deck**, so that command moves no `updatedAt`, writes no
   * history row and reallocates nothing. `deckUpdate(id, { theoryEnabled: true })` leaves it at
   * `"theory"`, because that write moves the deck's cards there.
   *
   * A deck whose {@link DeckRow.theoryEnabled} is `false` can still carry `"theory"` here — the
   * switch being turned off does not rewrite it — so a reader is put back on **Live** whatever
   * this says when the deck keeps no plan. There is no list to get back from otherwise.
   */
  lastVariant: DeckVariant;
  /**
   * The editor's `Group by` as the reader left it: `GroupBy`'s vocabulary
   * (`category | manaValue | type`), and `"category"` on a deck nobody has changed it on.
   *
   * **Typed `string` and deliberately not narrowed on the wire**, unlike
   * {@link DeckRow.lastVariant} beside it. The vocabulary is TypeScript's — `GroupBy` lives in
   * `features/decks/grouping.ts`, and this file may not import from `features/` — and, more to
   * the point, a database outlives the app: a word a *future* build stops offering has to
   * degrade to the default rather than putting the editor in a mode nothing can leave. The
   * narrowing is `asGroupBy`, which answers `"category"` for anything it has not heard of. The
   * same arrangement `getMarketplace` and `printingGroupBy` are in — see this file's header.
   */
  lastGroupBy: string;
  /**
   * The editor's `Sort` as the reader left it: `SortBy`'s vocabulary
   * (`alphabetical | manaCost | price | type`), and `"alphabetical"` by default.
   *
   * `string` for {@link DeckRow.lastGroupBy}'s reason, and narrowed the same way — `asSortBy` in
   * `features/decks/sorting.ts`, which answers `"alphabetical"` for a word this build does not
   * offer.
   */
  lastSortBy: string;
  /**
   * Whether this deck's curve gathers the `{X}` spells under a heading of their own.
   *
   * `decks.separate_x_group INTEGER NOT NULL DEFAULT 0`, schema v13 — per **deck**, because it
   * is an answer about a particular curve: a storm list where half the spells are `{X}` reads
   * quite differently from an aggro deck with one Fireball in it, and a single app-wide setting
   * would make the reader re-decide every time they opened a different deck.
   *
   * **It is a reading preference and changes nothing about what is in the deck.** It moves a
   * card between two headings — `buildGroups`' `separateX` and the curve the stats strip counts
   * — and reaches no rule: not size, not copies, not legality, not the allocator. Nothing in
   * `validation/` has heard of it and nothing there should.
   *
   * It is not one of the three `last*` fields above, and the split is the point: those are how
   * the reader was *looking* at this deck a moment ago, written by a command that moves no
   * `updatedAt`, while this is an answer about the deck's own curve and rides the ordinary
   * {@link ipc.deckUpdate} with the rename and the Built toggle.
   */
  separateXGroup: boolean;
  /**
   * Which of this deck's categories an add that names no pile lands in — `decks.default_category_id`,
   * schema v16, and **`AUTO_CATEGORY` (`0`) for "let the card's own text decide"**.
   *
   * Read on the row for {@link theoryEnabled}'s reason — a setting the app can write and never
   * see is a setting nothing can draw — and it is the deck editor's "Add to" answer: the docked
   * search panel's Add button and the quick-add field both file by it. It is chosen in **deck
   * settings** and nowhere else; it was a `useState` in `DeckEditor` until then, which is why a
   * reader who set it lost it the moment they closed the deck.
   *
   * Zero can never collide with a real pile — `deck_categories.id` is an `INTEGER PRIMARY KEY`,
   * so rowids start at 1 — and Rust spells the same sentinel `deck::AUTO_CATEGORY`.
   *
   * **An id this deck's `categories` does not carry reads as Auto**, and no writer has to
   * arrange that: deleting a pile puts every deck filing by it back to zero in the same
   * transaction, and a duplicate is remapped onto its own copy of the pile.
   */
  defaultCategoryId: number;
}

/**
 * How a deck is being read, as the editor asks for it to be remembered: the tab, the grouping
 * and the sort.
 *
 * **Every field is optional and absent means "leave it"** ({@link DeckPatch}'s rule, one command
 * over). The editor writes the single control that moved, so pressing Sort can never write back
 * a stale grouping — and the three controls do not have to be read together at the call site.
 *
 * `groupBy` and `sortBy` are `string` rather than the unions that produce them, for the reason
 * {@link DeckRow.lastGroupBy} gives: the vocabularies belong to `features/decks`, and the round
 * trip has to survive a build that no longer offers one of their words.
 */
export interface DeckViewState {
  variant?: DeckVariant;
  groupBy?: string;
  sortBy?: string;
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
   *  command takes `(deckId, cardId, categoryId, variant, finish)`, the grain the unique index
   *  is on. */
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
  /**
   * The set's printed name, for a surface that shows the three-letter code and has room to say
   * what it stands for on hover — `PF26` is not a word anybody knows.
   *
   * **From `cards`, so `null` for an orphan**, unlike `setCode` beside it: the code, the
   * collector number and the name are denormalized onto `deck_cards` precisely so a printing
   * that has left the corpus is still listed and counted, and a set name is not part of that
   * promise. Draw the code alone when this is `null` rather than inventing one.
   */
  setName: string | null;
  collectorNumber: string;
  lang: string;
  /**
   * Which object this row plays — {@link DeckFinish}, so `null` is the regular copy.
   *
   * **Part of the row's address, not just its content.** A foil copy and a regular copy of one
   * printing in one pile are two rows since schema v18, so every card write carries it and a
   * write aimed at one must never find the other.
   *
   * What a surface draws is `card.finish ?? soleFinish(card.finishes)` — the reader's own
   * statement first, the printing's second. `soleFinish` says what the *object* is (a foil-only
   * printing) and deliberately says nothing about a printing sold in both; this says what the
   * deck plays, and it is the reader's.
   */
  finish: DeckFinish;
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
  /**
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
  /** Printed at uncommon on **any** printing of this oracle card, which is what makes a
   *  Pauper Commander commander eligible. Computed, not read: the `paupercommander` legality
   *  key answers a different question (the 99). `false` for an orphan — nothing is known
   *  about a card that is not there. */
  everUncommon: boolean;
  /**
   * What one copy of this printing costs at the marketplace the read named.
   *
   * **The row's own finish where it names one** (schema v18), at that finish and no other —
   * the reader has said which object is in the sleeve, and quoting the plain copy's rate against
   * a foil row would be a price nobody published.
   *
   * **The printing's own figure where it does not**, which is every row that predates v18 and
   * every row a reader has not spoken about: the first finish that marketplace quotes it in,
   * `nonfoil → foil → etched`. Both arms are `sorting::deck_card_price_expr`.
   *
   * **It was the flat nonfoil rate until 2026-08-15, and that was a bug with a reader-visible
   * shape.** 13 515 foil-only and 892 etched-only printings have no nonfoil price at *any*
   * marketplace, so an Invocation, a Secret Lair or a set promo drew an em dash on its card
   * foot, was skipped by its pile's heading total and by the deck's, and did all of that beside
   * a search panel quoting the same printing.
   *
   * Still never `cards.price_usd`: that is this chain precomputed for the search's `ORDER BY`,
   * the numbers agree, and the column is the one nothing here may sum. A `null` is still the
   * answer and never a reason to reach for another marketplace's figure — an etched-only
   * printing has no euro price at all, because Scryfall has no `eur_etched` key.
   */
  unitPrice: number | null;
  /**
   * Copies of this oracle card the allocator **secured for this deck**, attributed to this
   * row in the read's own order and clamped to what each collection entry still holds.
   *
   * The only one of this file's four `ownedQuantity` fields that is not a count of what the
   * user has: {@link CardSummary.ownedQuantity} is every copy of one printing,
   * {@link ImportMatch.ownedQuantity} is that same count taken per decklist line,
   * {@link WishRow.ownedQuantity} is the copies that fill one wish, and this one is a *claim* —
   * oracle-grained (a Bolt is a Bolt), finish-blind, condition-blind.
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
 * One line of a parsed decklist, on its way to be turned into a printing.
 *
 * **The quantity is deliberately not here.** {@link ipc.importResolve} answers *which
 * printing a name means* — the one question this side cannot answer, because it is a question
 * about 116 k rows of card data — and how many copies the line asked for is this side's
 * arithmetic all the way to {@link ImportItem}. Both hints are optional because most decklist
 * formats carry neither.
 *
 * A blank hint costs nothing: the backend trims and reads `""` or `"   "` as *absent*, which is
 * what a trailing tab in a pasted export leaves behind and would otherwise turn every line of
 * that paste into a missed hint.
 */
export interface ImportResolveLine {
  /** As the line wrote it. Case and diacritics are both survivable — the backend folds a name
   *  that no exact rule matched — and so is a double-faced card written as its front face only,
   *  which is the commonest way a decklist writes one. */
  name: string;
  /** The set code in any case: the backend lower-cases it, because 0 of the corpus's 116 695
   *  rows carry a set code in any other case while a parser that upper-cases `(MH2)` is the
   *  ordinary source of one. */
  setCode: string | null;
  /** Only ever *narrows* a set — a collector number is not unique across sets — so one arriving
   *  with no `setCode` beside it is reported as a missed hint without being tried at all. */
  collectorNumber: string | null;
}

/**
 * The printing a decklist line resolved to, and every fact the preview and the validation engine
 * need about it.
 *
 * **The card fields are {@link DeckCard}'s less its money, deliberately**, so an imported card
 * and a card already in a deck are described by the same *judgeable* facts: a preview that
 * judged legality on a narrower set of columns than the editor would show a legal deck the
 * editor then refuses. Four differences, named here so a reader diffing the two does not have to
 * guess which are drift — `finishes` is absent (it says which finishes a printing is *sold* in,
 * which is what the editor's foil marking reads; a line's own finish rides on
 * {@link ImportItem.finish} instead, off the file's `*F*` marker), **`unitPriceUsd`/`unitPriceEur`
 * are both absent**,
 * {@link ImportMatch.gameChanger} is a plain boolean where `DeckCard`'s is nullable, and
 * `ownedQuantity`/`printingCount` are the import's own.
 *
 * **No price rides here on purpose.** This interface carried `unitPriceUsd` alone while
 * `DeckCard` still did too; the marketplace work gave `DeckCard` its euro twin and left this one
 * a currency behind, which is the drift "the card fields are `DeckCard`'s" was written to
 * prevent. It is removed rather than paired up because nothing reads it — swept 2026-08-12,
 * every `unitPriceUsd` on an `ImportMatch` was a fixture writing `null` — and because a lone
 * dollar figure is now wrong by rule: money is drawn with `formatPrice(value, currency)` off
 * `useMarketplace()`, so a DTO carrying one currency can only be used incorrectly. A field that
 * does not exist cannot drift; a preview that one day prices a line adds the pair.
 */
export interface ImportMatch {
  cardId: string;
  /** **The whole printed name**, so a double-faced card resolved from its front face comes back
   *  as `"A // B"` — what `deck_cards.name` denormalizes and what the reader is shown. A
   *  preview that echoed the line's own name would hide the one case worth checking. */
  name: string;
  setCode: string;
  collectorNumber: string;
  lang: string;
  oracleId: string | null;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  /** Concatenated letters — `"WU"`, not `["W","U"]`, and not JSON. {@link DeckCard.colors}. */
  colors: string | null;
  /** The same letter form, precomputed by Scryfall — DFC backs, adventures, colour indicators
   *  and basic land types already folded in. {@link DeckCard.colorIdentity}. */
  colorIdentity: string | null;
  /** JSON: **this printing's** blob, not the oracle card's, which is what makes `oldschool`
   *  come out right with no special case. {@link DeckCard.legalities}. */
  legalities: string | null;
  /** Printed power **as text** — `"*"`, `"1+*"` and a printed `"0"` all ship in real data. Both
   *  `null` means *unknown*, never "no P/T box", and CR 903.3 turns on that difference. */
  power: string | null;
  toughness: string | null;
  layout: string | null;
  rarity: string | null;
  /** JSON: the `card_faces` array verbatim. {@link DeckCard.faces}. */
  faces: string | null;
  /**
   * On Wizards' Game Changer list.
   *
   * **A plain boolean where {@link DeckCard.gameChanger} is `boolean | null`**, and the
   * difference is real rather than a mirror slip: `cards.game_changer` is nullable and a NULL
   * means *not on the list*, so the backend flattens it here rather than handing this side a
   * third state to fence. A resolved line always names a card that exists, which is the state
   * `DeckCard`'s `null` is reserved for.
   *
   * One of **three** fields in this file with this name, and the split is two-to-one:
   * {@link CardSummary.gameChanger} is flattened for the same reason this one is — a search row
   * is a card that is there — and `DeckCard`'s is the only nullable one.
   */
  gameChanger: boolean;
  /** Printed at uncommon on **any** printing of this oracle card — what makes a Pauper Commander
   *  commander eligible. Computed; the `paupercommander` legality key answers the 99. */
  everUncommon: boolean;
  /**
   * Every copy of **this printing** the collection holds, finish-blind — and the reason this
   * printing won: a printing you own beats a newer one you do not, then the newest wins, then
   * the id (which is what makes the same list pasted twice build the same deck).
   *
   * The same question {@link CardSummary.ownedQuantity} answers, asked per decklist line rather
   * than per search row. Not {@link DeckCard.ownedQuantity}, which is a deck's *claim* — nothing
   * has been allocated at resolve time, and nothing will be until
   * {@link ipc.deckImportCommit} runs.
   */
  ownedQuantity: number;
  /**
   * **How many rows the rule that matched this line found** — not how many printings the card
   * has, which is a different number and one nothing computes.
   *
   * It is per *matching arm*, and the backend has **six**, so this field means six things:
   * through a set-and-collector-number hint it is how many printings that pair named (1, in a
   * corpus with no duplicates); through a set-scoped name, that name's printings **within that
   * set**, and through a set-scoped front face, that set's printings whose front face is the
   * name; through a bare name, that name's paper printings corpus-wide, and through a bare
   * front face, the paper printings whose front face is the name; through the fold arm, how many
   * candidates survived the fold comparison.
   *
   * So "how many printings is the reader choosing between" is only what it means on a line that
   * carried **no hint** — which is most of a pasted list, and the only case an affordance built
   * on this number may claim to be about the card. Even there it counts *paper* printings of
   * that exact name, so it is not what Scryfall would list. On a hinted line it describes the
   * hint. Stated this narrowly on purpose: a true per-name count would cost a second query per
   * line, and the arms are one indexed lookup each precisely because they do not do that.
   */
  printingCount: number;
}

/**
 * One resolved line. `matched` is `null` for a name no printing bears — **not an error**: the
 * preview quotes it and the import proceeds without it.
 *
 * `hintMissed` says the line carried a `(SET) 123` this app has no printing for, and that the
 * name rule answered instead. Both can be true at once: a missed hint whose name also matched
 * nothing comes back `matched: null, hintMissed: true`.
 */
export interface ImportResolveRow {
  /** **The caller's index**, not a row number — the list that was sent is the only thing that
   *  knows what line 34 said. The two are the same today, and a filter between them would make
   *  them differ silently, which is why it rides along rather than being inferred. */
  index: number;
  matched: ImportMatch | null;
  /** *Some part of what the reader wrote about the printing was not used.* So a collector number
   *  that named nothing sets it even when the set and name then answer, and a collector number
   *  with no set beside it sets it without being tried. Never a reason to lose the card. */
  hintMissed: boolean;
}

/**
 * What an import does to the variant it lands in.
 *
 * `merge` folds onto the deck-card grain — the same printing in the same category becomes one
 * row with the sum, so a list naming a card on two lines lands as one row. `replace` clears
 * that variant's **cards** first and leaves its **categories**: a category is the reader's
 * filing, not the list's, and a replace that swept them would delete piles somebody named,
 * reordered and switched off to import a file that mentions none of that.
 *
 * It clears **one variant**. Replacing the plan never touches what is sleeved up, and the other
 * way round — the reason `variant` is part of the grain at all.
 *
 * Spelled out here rather than derived from anything: the backend validates against its own
 * list and quotes it back in the refusal, so a third mode is a Rust change first.
 */
export type ImportMode = "merge" | "replace";

/**
 * One line of a decklist after this side has decided everything a *deck* decision is.
 *
 * The first three fields are the three answers the backend cannot compute for itself: which
 * printing (resolved by {@link ipc.importResolve}, and perhaps overridden in the preview),
 * how many, and which pile.
 */
export interface ImportItem {
  cardId: string;
  /** Copies, and it must be **positive**. Zero is refused rather than read as a removal — and it
   *  is refused for the whole import, because one line that cannot land rolls the transaction
   *  back. */
  quantity: number;
  /**
   * The line's `*F*` / `*E*` marker, as {@link DeckFinish} — `null` where it carried neither.
   *
   * Part of the grain, so a list naming the same printing foil on one line and plain on another
   * lands as **two rows** rather than one summed. `parse.ts` reads the marker, `plan.ts` carries
   * it here, and nothing in between makes a decision about it: a finish is a fact about the
   * line, not a filing decision.
   *
   * **Optional, exactly as {@link ImportItem.inactive} is and for its reason.** Rust takes it
   * `#[serde(default)]`, and an absent field means the regular copy — which is what an import
   * has always made. It is the same call `useDeck.addCard`'s optional `finish` makes and the
   * opposite of the one `Slot` makes: this creates a row, where a default is the honest answer,
   * rather than addressing one, where a default steps the wrong card.
   */
  finish?: DeckFinish;
  /**
   * **A name, not an id**, which is the one place this command's shape differs from
   * {@link ipc.deckAddCard}'s id arm and the difference is deliberate: an imported list names
   * sections the deck may not have yet, and the word itself is `autoCategoryFor`'s to compute,
   * because which pile a Sol Ring belongs in is domain logic.
   *
   * Found-or-created, matched **by name alone**, so a `Sideboard` section lands on the deck's
   * seeded `side` category rather than making a second pile with the same word on it. Trimmed
   * before it is keyed, so `Ramp` and `  Ramp  ` are one pile and count as one creation.
   */
  categoryName: string;
  /**
   * The file said this pile counts toward nothing — Archidekt's `{noDeck}`, which is this app's
   * `is_active = 0`.
   *
   * **Applied only to a pile the import creates.** A name the reader already has keeps whatever
   * they set; an import must not reach into filing somebody did by hand.
   *
   * Optional because absent has always meant "an ordinary, counted pile" and the backend reads it
   * that way (`#[serde(default)]`) — so every caller written before Archidekt's maybeboard existed
   * is unchanged, the Storybook fake's literals included.
   */
  inactive?: boolean;
}

/**
 * What an import did, in the three numbers the "Imported 117 cards" report is written from.
 *
 * `added` and `removed` are **copies, not rows** — a reader counts cards — and `added` is what
 * the list asked for rather than what the deck landed on, so a merge that folded 3 onto an
 * existing 2 reports 3 and the row now holds 5.
 */
export interface ImportOutcome {
  added: number;
  /** Copies cleared before the list went in. Always `0` on a `merge`; `0` on a `replace` over an
   *  empty variant too, which is also when no `remove` row is written to the history. */
  removed: number;
  /** The piles the import had to make — the part of the outcome a reader could not have
   *  predicted from the file. A section name their deck already had costs nothing. */
  categoriesCreated: number;
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
  /**
   * Which platforms the format is playable on (schema v18) — an **array**, split by Rust out
   * of the one comma-joined cell `format_specs.games` stores.
   *
   * **Never empty**: a spec naming no platform would be a format no filtered picker could ever
   * offer, and the seed writes all 25 rows. It is the only input `pickerFormats`' game filter
   * reads, and it is a *fact* — which formats a picker then offers is the conclusion.
   */
  games: Game[];
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
  /** The release body **verbatim**, markdown and all. Rust interprets none of it;
   *  `src/lib/releaseNotes.ts` reads it and the settings panel draws the result. */
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
  "scryfall_api" | "scryfall_image" | "github_update" | "database" | "image_store";

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
 * A card's Oracle tags, keyed by the **oracle** id — Scryfall Tagger's answer to "what does
 * this card *do*", which is what `autoCategoryFor` files a deck add by.
 *
 * `slugs` carries the card's own tags **and every ancestor of them**, already expanded by
 * `oracle_tags::ancestor_closures` and sorted. That expansion is the fact; picking which of
 * them names a pile is the conclusion, and it stays in `features/decks/autoCategory.ts`. Rust
 * knows nothing about "Removal" or the order the piles are tried in, deliberately.
 *
 * **An empty `slugs` is an answer, not a miss**, and the two are indistinguishable on purpose:
 * an untagged card, a card id that is not in `cards`, and a printing whose `oracle_id` is NULL
 * all come back empty, because the rule's response to all three is the same — fall back to the
 * type line. Nothing about categorising a card may fail an add.
 */
export interface CardTags {
  oracleId: string;
  slugs: string[];
}

/**
 * The same answer keyed by a **printing** id (`cards.id`), for the callers that hold one.
 *
 * Almost every categorising call site does: a drag payload, `useDeck.addCard` and
 * `import_resolve`'s rows all name a printing. A separate DTO rather than reusing
 * {@link CardTags} because a printing id in a field called `oracleId` would be a lie, and this
 * mirror is the one place that lie would never be caught.
 */
export interface PrintingTags {
  cardId: string;
  slugs: string[];
}

/**
 * One tag taxonomy's own freshness — its `*_tag_meta` row, plus the shape of a database that
 * has never fetched the file.
 *
 * **Every field is nullable and `null` means "never ingested"**, which is a real state and not
 * an error: each taxonomy is a separate bulk dataset with its own weekly refresh, and the app
 * works without either — an untagged deck add simply files by card type, and a Tags page with
 * no art taxonomy says it has nothing yet.
 *
 * `checkedAt` and `ingestedAt` are separate because a 304 moves only the former. Collapsing
 * them would make an up-to-date taxonomy read as due on every launch and cost one API call per
 * start.
 *
 * **One interface for both datasets because Rust has one struct for both** — `tags::TagStatus`,
 * which `tags/oracle.rs` and `tags/art.rs` each re-export under their own name. Two hand-copied
 * mirrors of one struct is the drift this whole file is written to avoid, and it would be a
 * drift nothing could catch: the two shapes would stay compatible for as long as they were
 * identical and part in silence the day one gained a field.
 */
export interface TagStatus {
  /** Scryfall's own stamp for the file these rows came from. */
  updatedAt: string | null;
  /** Unix **seconds**. `null` = the taxonomy has never been ingested. */
  ingestedAt: number | null;
  /** Unix **seconds**. Moves on a 304; `ingestedAt` does not. */
  checkedAt: number | null;
  tagCount: number | null;
  taggingCount: number | null;
  stale: boolean;
  /** A refresh **of this dataset** is in flight right now. The two taxonomies are separate
   *  files on separate schedules, so either may be refreshing while the other is. */
  refreshing: boolean;
}

/** `tags::oracle::OracleTagStatus` — what a card *does*. {@link TagStatus} under the name the
 *  command answering it carries. */
export type OracleTagStatus = TagStatus;

/** `tags::art::ArtTagStatus` — what an illustration *depicts*. The same shape again, and the
 *  larger of the two files: ~12.5 MB gzipped against the oracle taxonomy's ~5.85 MB. */
export type ArtTagStatus = TagStatus;

/** `tags::PHASES` — the five a taxonomy refresh emits, against `SyncPhase`'s eight. */
export type TagPhase = "checking" | "downloading" | "ingesting" | "done" | "error";

/** {@link TagPhase} under the name callers spelled before the art taxonomy existed. Both
 *  datasets emit the same five, because they are one `PHASES` in the crate. */
export type OracleTagPhase = TagPhase;

/**
 * Payload of a taxonomy's progress event — `tags::TagProgress`.
 *
 * A progress event of its own rather than a ninth `SyncPhase`, following `marketplace:progress`'
 * precedent for the same reason: the card sync's phase list is a closed union mirrored by hand
 * on this page, and a dataset with its own schedule has no business widening it.
 *
 * **Each taxonomy has its own channel** — `oracle-tags:progress` and `art-tags:progress`. One
 * shared line would have the two fighting over it, since either may refresh while the other is.
 */
export interface TagProgressEvent {
  phase: TagPhase;
  done: number;
  total: number;
}

/** Payload of `oracle-tags:progress`. */
export type OracleTagProgressEvent = TagProgressEvent;

/** Payload of `art-tags:progress`. */
export type ArtTagProgressEvent = TagProgressEvent;

/**
 * Which taxonomy a tag came from — `tags::query`'s `namespace`, as a hit carries it.
 *
 * **Never `"both"`.** That is an *input*: `tagSearch` and `tagChildren` accept it and mean
 * "ask each of them", and a hit always came from exactly one. The two are separate files with
 * separate id spaces that share plenty of slugs — `dog` is in both and they mean different
 * things by it — so a stored mute names one namespace and a breadcrumb that lost this field
 * would climb the wrong tree.
 */
export type TagNamespace = "art" | "oracle";

/**
 * How strong an art match has to be — `filters::CardFilters::art_weight_floor`.
 *
 * `"strong"` drops the closure rows Scryfall called `weak`, which their docs define as "the
 * subject is a minor detail or background element". **It is a floor and not a narrowing to
 * strong matches**: the predicate is `weight <> 'weak'`, so `median` — 462 008 of 475 163 art
 * taggings, measured 2026-08-20 — is admitted. Any control built on this must say it excludes
 * background detail; "strong matches only" would be a promise the query does not keep.
 *
 * Anything else, this union's `"any"` included, is no floor at all: an unrecognised value fails
 * **open**, showing more rather than hiding cards nobody would report missing.
 *
 * **The art side only, and the include side only.** `oracle_tag_cards` carries no `weight`
 * column at all — oracle taggings are 99.7 % `median` — and "not a dog" means not a dog at all,
 * so a floor on an *exclude* would let weak dogs back into a result the reader asked to have
 * none in.
 */
export type ArtWeightFloor = "any" | "strong";

/**
 * One taxonomy's tag chips: the tags a row must carry, and the tags it must not.
 *
 * **`include` INTERSECTS.** A themed deck asks for dogs AND snow, so each included slug is its
 * own `EXISTS` rather than one `slug IN (…)` — which is the union, and would answer a superset
 * that looks plausible. `exclude` is the same subquery under `NOT EXISTS`, and the two lists AND
 * with each other and with every other filter.
 *
 * Both lists are `#[serde(default)]` on the Rust side, so naming one omits the other, and an
 * absent `artTags`/`oracleTags` adds no SQL at all. Blanks are dropped and the rest sorted and
 * deduplicated (`filters::picked_tags`), so an empty list means "no filter" and never "match
 * nothing".
 *
 * **Both taxonomies are matched through their pre-flattened closure**, so a query for a parent
 * tag answers the cards tagged only with its children — `dog` is directly tagged on 137
 * illustrations and reaches 439, and `removal` has *zero* direct taggings while answering 6 686
 * cards (both measured 2026-08-20).
 */
export interface TagTerms {
  include?: string[];
  exclude?: string[];
}

/**
 * A tag named from somewhere else — enough to draw a breadcrumb and to ask about it again.
 * `tags::query::TagRef`.
 */
export interface TagRef {
  slug: string;
  label: string;
  namespace: TagNamespace;
}

/**
 * One tag a reader named in a card search box — `tags::query::TagLookup`, the ask half of
 * {@link ipc.tagResolve}.
 *
 * `tagQuery.ts`'s token minus what is the *box's* business: where the term sat in the string,
 * and whether it was negated. Resolution answers "is there such a tag"; which of
 * {@link TagTerms}' two lists the slug lands in is decided in TypeScript, because that is a
 * conclusion rather than a fact.
 */
export interface TagLookup {
  /** **Never `"both"`**, unlike {@link ipc.tagSearch}'s: a typed `o:` names one taxonomy, and
   *  answering across both would let `o:dog` filter by the picture. */
  namespace: TagNamespace;
  /** What the reader typed after the keyword. Normalised by Rust, never here — two copies of
   *  that rule would leave both halves self-consistent and the search matching nothing. */
  value: string;
}

/**
 * One tag, as the Tags page draws it — `tags::query::TagHit`.
 *
 * Answered by both {@link ipc.tagSearch} and {@link ipc.tagChildren}, and a muted tag is absent
 * from both, from `childCount` and from anyone's `parents`. Muting hides a *tag*; it never hides
 * a card, and nothing in the card filters consults the mute table.
 */
export interface TagHit {
  slug: string;
  /**
   * Scryfall's stable uuid, and **the only thing a mute may be keyed on** — their docs say "do
   * not treat tag slugs or labels as permanent identifiers". A mute keyed on a slug un-mutes
   * itself the week the tag is renamed, which is exactly the week it mattered.
   *
   * **`""` is a real value**: `oracle_tags.id` was added by an `ALTER TABLE` that could not add
   * a `NOT NULL` column without a default, so every row that predates a refresh by a build new
   * enough to write ids still carries the empty string. Such a tag is *unmutable* — {@link
   * ipc.tagMute} refuses it in words — and the next refresh repairs it. That refusal is
   * deliberate: one stored mute with a blank id would otherwise equal every one of those rows
   * and take the whole taxonomy off the page with nothing logged.
   */
  id: string;
  label: string;
  /** Never `"both"` — see {@link TagNamespace}. */
  namespace: TagNamespace;
  description: string | null;
  /**
   * How many subjects the tag reaches **through the closure** — illustrations for the art
   * taxonomy, oracle ids for the oracle one, and in neither case a count of *printings*.
   *
   * The direct taggings are the wrong number and they look right: a category tag has none of
   * its own, so counting them would report `dog: 137` where the closure reaches 439, and
   * `removal: 0` where it answers 6 686.
   */
  cardCount: number;
  /** Direct children that are not muted, so a disclosure triangle drawn from this never opens
   *  onto nothing. */
  childCount: number;
  /**
   * Every parent, not the first one — **43 % of art tags have more than one** (4 970 of 11 531,
   * measured 2026-08-20), so a tag reached through one branch of the rail routinely sits under
   * another as well and a single-parent breadcrumb would be wrong for two tags in five.
   */
  parents: TagRef[];
}

/**
 * One muted tag, as Settings lists it — `tags::muted::MutedTag`.
 *
 * Every field is stored rather than joined, which is the point of the table: a taxonomy that has
 * been rebuilt since — or never fetched on this machine at all — must still be able to show the
 * reader what they hid and offer to give it back.
 */
export interface MutedTag {
  /** The two taxonomies are separate files with separate id spaces, so one uuid appearing in
   *  both is two mutes. */
  namespace: TagNamespace;
  /** Scryfall's stable uuid — the key, with the namespace. */
  tagId: string;
  /** The slug as it read when the mute was made. Display only, and possibly stale by design. */
  slug: string;
  /** Unix **seconds**. */
  mutedAt: number;
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
 * What emptying the collection took with it — `src-tauri/src/reset.rs`.
 *
 * `allocations` is the number nobody predicts and is why this is a shape rather than a count:
 * `deck_allocations.collection_entry_id` cascades from `collection_entries`, so every deck's
 * reservation against an owned copy goes with the collection. The decks themselves stay.
 */
export interface CollectionCleared {
  entries: number;
  allocations: number;
}

/**
 * What emptying the decks took with it.
 *
 * `folders` is its own number because the schema keeps folders their own thing —
 * `decks.folder_id` is `ON DELETE SET NULL`, so clearing them is a second statement the
 * backend takes deliberately. `covers` is files beside the database, not rows.
 */
export interface DecksCleared {
  decks: number;
  folders: number;
  covers: number;
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

export const ipc = {
  searchCards: (req: SearchRequest) => invoke<SearchResponse>("search_cards", { req }),
  /**
   * Facet counts for one search — the same request shape as `searchCards`, whose `sort`,
   * `offset` and `limit` are ignored. Its own command so a page turn does not recompute
   * them and so they never delay page one; key it on the filter half of the search alone.
   */
  facetCards: (req: SearchRequest) => invoke<FacetResponse>("facet_cards", { req }),
  /** Every set, newest first. Cached for the session — it changes once a sync, at most. */
  listSets: () => invoke<SetSummary[]>("list_sets"),
  /**
   * One printing in full, or `null` when no row has that id.
   *
   * `marketplace` decides {@link CardDetail.finishPrices} and nothing else about the answer —
   * but it decides them completely, so it belongs in the caller's query key like every other
   * priced read. The backend's fallback for an unknown id is `tcgplayer`.
   */
  cardDetail: (id: string, marketplace: MarketplaceId) =>
    invoke<CardDetail | null>("card_detail", { id, marketplace }),
  /**
   * Every paper printing of the oracle card, newest first, with a full count.
   *
   * `marketplace` prices every row per finish — the figures a reader is choosing a printing by.
   *
   * `limit` is the page size, and **absent is the card pane's 400** — `MAX_PRINTINGS`, exactly
   * what this command answered before the argument existed, so the pane's query and its cache
   * key are unchanged by it. The printings modal names the backend's ceiling instead, because it
   * **filters client-side**: a filter over a truncated list lies, and narrowing to a set that
   * fell outside the newest 400 would draw an empty wall that reads as an answer rather than as
   * a truncation. Rust clamps whatever it is sent into `1..=MAX_PRINTINGS_HARD` (1000, chosen
   * against the corpus — Forest, the most-printed card, has 862), so the number here is a
   * request rather than a promise, and a zero or a negative falls back to the default instead of
   * answering "this card has no printings".
   *
   * `total` stays uncapped either way, so a caption can always tell a truncation from a filter.
   */
  cardPrintings: (oracleId: string, marketplace: MarketplaceId, limit?: number) =>
    invoke<PrintingsResponse>("card_printings", { oracleId, marketplace, limit }),
  /**
   * The cards this printing melds with — see {@link MeldRelation}.
   *
   * **`[]` is the answer for almost every card in the game, and it never rejects.** Every layout
   * that is not `meld`, an unknown id, and a `meld` row whose `raw` carries no `all_parts` all
   * come back empty: a card the reader opened must not fail to open because the relationship
   * behind an orientation control could not be read. 72 of the 116 590 live rows are `meld` — 48
   * parts and 24 results — and every meld id they name resolves to a row in `cards` (0 missing).
   *
   * **No `marketplace`, unlike every other card read on this object.** This is a relationship
   * rather than a price, so nothing about the answer moves when the setting does, and putting it
   * in a priced query key would refetch a fixed fact on every switch.
   */
  cardMeldParts: (id: string) => invoke<MeldRelation[]>("card_meld_parts", { id }),
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
  /**
   * The decks holding one deck-driven collection row's copies — the names behind its
   * {@link CollectionRow.deckCount}, asked for on hover rather than shipped with the page.
   *
   * **`finish` is the collection row's own spelling and is passed straight through.** A plain
   * copy is `'nonfoil'` on a collection row and NULL on a deck card; the far end translates
   * (`src-tauri/src/collection_decks.rs`), so a caller that helpfully sent `null` here would get
   * a deserialization error rather than an empty list. Hand it `row.finish`.
   *
   * **Not gated on the setting.** `row_decks` has no flag check and queries `deck_cards`
   * unconditionally, which is right: "which decks hold this printing" is a fact about decks and
   * is true in either mode. What is mode-specific is who asks — the page only reaches for this
   * where a {@link CollectionRow.deckCount} exists to explain, and that is `null` while the
   * collection is hand-kept.
   *
   * A row whose decks have since changed answers whatever they hold now — it is a read, never
   * a promise that the count it explains is still current.
   */
  collectionRowDecks: (cardId: string, finish: string, lang: string) =>
    invoke<RowDeck[]>("collection_row_decks", { cardId, finish, lang }),
  /**
   * One transaction for a whole imported file, rather than one `collectionAdd` per line — a
   * 500-row CSV would otherwise be 500 transactions, and a failure halfway through would leave
   * a collection nobody can reason about. A refusal rolls the whole file back.
   */
  collectionImportCommit: (items: CollectionImportItem[], mode: TransferImportMode) =>
    invoke<ImportCommitOutcome>("collection_import_commit", { items, mode }),
  wishlistAdd: (wish: WishInput) => invoke<EntryChange>("wishlist_add", { wish }),
  /** An absolute quantity — and here `0` *removes* the row, because a wish holds nothing
   *  worth keeping once it is emptied. The opposite of the collection's, on purpose. */
  wishlistSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("wishlist_set_quantity", { id, quantity }),
  wishlistRemove: (id: number) => invoke<EntryChange>("wishlist_remove", { id }),
  wishlistList: (query: WishlistQuery) => invoke<WishlistPage>("wishlist_list", { query }),
  /**
   * One transaction for a whole imported file — {@link ipc.collectionImportCommit}'s rule. The
   * `set` arm reaches its row through `add_wish` first and corrects the quantity after, so a
   * `set` of 0 **deletes** the wish rather than leaving an empty one.
   */
  wishlistImportCommit: (items: WishlistImportItem[], mode: TransferImportMode) =>
    invoke<ImportCommitOutcome>("wishlist_import_commit", { items, mode }),
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
   *
   * `marketplace` decides every price in the answer — each card's {@link DeckCard.unitPrice}
   * and each category's {@link DeckCategory.totalPrice} — so it is part of the question rather
   * than of the presentation, and it belongs in the caller's query key.
   */
  deckGet: (id: number, variant: DeckVariant, marketplace: MarketplaceId) =>
    invoke<DeckDetail | null>("deck_get", { id, variant, marketplace }),
  /**
   * The format the last deck made on this install was given — or `null` where no deck has ever
   * been made.
   *
   * **One `app_meta` row, written by `deck_create` and by nothing else.** That is what makes it
   * true of *every* way of making a deck rather than of one dialog's: the gallery's New deck
   * panel and the import dialog's into-a-new-deck arm both go through that command, so neither
   * has to remember to record anything and no third route can be added that forgets to. It
   * moves on a **create** and not on a re-format: the question it answers is what a reader
   * *starts* a deck on, which is a different fact from what their decks currently are.
   *
   * A bare `string` rather than a narrowed format key — the same shape, for the same reason, as
   * {@link getMarketplace} and {@link printingGroupBy} above. This is the **stored fact,
   * unvalidated**: `decks.format_key` is deliberately not a foreign key and `format_specs` is
   * re-seeded by migrations, so a key this build no longer offers really can come back out of
   * the row, and a row a newer build wrote must reach this side as the string it is. The
   * narrowing belongs to the module that owns the vocabulary, and here that vocabulary is
   * `format_specs` and that module is `@/features/decks/useNewDeckFormat` — whose
   * `newDeckFormat` tests the key against the picker and falls back rather than refusing.
   *
   * `null` is an answer and not a failure: it is the same sentence as "this reader has never
   * made a deck", which is precisely the case the default exists for.
   */
  deckLastFormat: () => invoke<string | null>("deck_last_format"),
  /**
   * Make a deck — **the whole deck, in one INSERT**, with its four predefined categories and
   * its one birth row of history in the same transaction. Every field of {@link DeckInput}
   * travels in this one call rather than as a create followed by a patch and a filing, which
   * would be three transactions with a half-made deck to unwind between them.
   *
   * The one thing it cannot do is a *custom* cover picture: that is
   * {@link ipc.deckSetCoverImage}, which needs the id this call answers with, so it is always
   * a follow-up and always has to handle failing on its own — the deck exists by then.
   */
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
   * Remember how this deck is being read: which of its two lists, which `Group by`, which
   * `Sort`. Absent fields are left alone — see {@link DeckViewState}.
   *
   * **A third deck write that is not a {@link DeckPatch}, and for a reason of its own: looking
   * at a tab is not editing a deck.** It writes the three columns it was given and nothing
   * else — no `updatedAt`, so a deck the reader only *read* does not climb to the top of a
   * gallery sorted by when it was touched; **no history row**, because a `deck_audit` full of
   * "changed the sort to Price" is a history nobody can read the edits out of; and no
   * reallocation, because no card moved. A deck id that resolves to nothing is refused by name,
   * like every other deck write.
   *
   * Answers nothing. What it stored is on the next {@link DeckRow} — `lastVariant`,
   * `lastGroupBy`, `lastSortBy` — and the editor is already showing it, which is why nothing
   * here invalidates (`useDeck`'s `rememberView` says why at length).
   */
  deckSetViewState: (deckId: number, viewState: DeckViewState) =>
    invoke<void>("deck_set_view_state", { deckId, viewState }),
  /**
   * A deck's categories on their own — the same list `deckGet` already carries, for a panel
   * that wants it without the cards.
   *
   * `variant` scopes each row's `cardCount`/`totalPrice` and **nothing else**: which categories
   * a deck has does not depend on which list is showing, which is what keeps the columns still
   * while the reader switches between Live and Theory. `marketplace` decides what
   * {@link DeckCategory.totalPrice} is a total *of*.
   */
  deckCategoryList: (deckId: number, variant: DeckVariant, marketplace: MarketplaceId) =>
    invoke<DeckCategory[]>("deck_category_list", { deckId, variant, marketplace }),
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
  /** The tags **this deck's list is wearing**, most-used first — `deckGet` carries the same
   *  list. `variant` scopes membership as well as the counts, because the live list and the
   *  theory list are treated as separate decks where labels are concerned. */
  deckTagList: (deckId: number, variant: DeckVariant) =>
    invoke<DeckTag[]>("deck_tag_list", { deckId, variant }),
  /** A new label, **app-wide**. `deckId` is where the reader was standing — it goes in the
   *  history row and is not stored on the tag. Refuses a name any tag already holds; the
   *  colour is `#rrggbb` and the backend checks only that it is non-empty — see
   *  {@link TagColor}. */
  deckTagCreate: (deckId: number, name: string, color: TagColor) =>
    invoke<GlobalTag>("deck_tag_create", { deckId, name, color }),
  /** Rename **and** recolour, **in every deck at once**: one command, both arguments required.
   *  There is no patch shape here, so a caller changing one sends the other back unchanged. */
  deckTagUpdate: (deckId: number, id: number, name: TagColor, color: TagColor) =>
    invoke<GlobalTag>("deck_tag_update", { deckId, id, name, color }),
  /** Delete a label **from the whole app**. It **untags its cards rather than deleting them**
   *  — `deck_cards.tag_id` is `ON DELETE SET NULL` — in every deck wearing it, which is what
   *  {@link GlobalTag.deckCount} exists for a confirm dialog to say first. */
  deckTagDelete: (deckId: number, id: number) => invoke<void>("deck_tag_delete", { deckId, id }),
  /** Take a label off **this deck's cards in one list**, leaving the tag itself alone —
   *  the row-level act the app-wide list needed and the per-deck one never did. Answers how
   *  many rows lost it; zero is a success. */
  deckTagRemoveFromDeck: (deckId: number, tagId: number, variant: DeckVariant) =>
    invoke<number>("deck_tag_remove_from_deck", { deckId, tagId, variant }),
  /** Every tag there is, most-used first — the only list that can answer a tag no card is
   *  wearing. Takes no deck id at all; see {@link GlobalTag}. */
  deckTagAll: () => invoke<GlobalTag[]>("deck_tag_all"),
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
    finish: DeckFinish,
    tagId: number | null,
  ) => invoke<void>("deck_card_set_tag", { deckId, cardId, categoryId, variant, finish, tagId }),
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
  /**
   * What the deck editor's Undo and Redo buttons would do — see {@link DeckUndoState}.
   *
   * **`redoId` is the caller's**, because the redo stack lives in this webview and dies with
   * the window. Rust stamps `undone_at` so *undo* survives a restart and carries on where it
   * stopped; which of those undone changes the reader could still put back is their position
   * in a session, not a fact about the deck, and a database-backed redo would offer to
   * resurrect a fortnight-old branch of edits they had forgotten making.
   */
  deckUndoState: (deckId: number, redoId: number | null) =>
    invoke<DeckUndoState>("deck_undo_state", { deckId, redoId }),
  /**
   * Undo one change. `auditId` must be the deck's cursor — the id `deckUndoState` handed back
   * — or the call is refused in words rather than undoing something else.
   *
   * A deck write like any other: it moves `updated_at`, records its own history row and
   * reallocates. What it does *not* record is a step of its own, so pressing Ctrl+Z twice goes
   * back two changes rather than toggling one.
   */
  deckUndoApply: (deckId: number, auditId: number) =>
    invoke<void>("deck_undo_apply", { deckId, auditId }),
  /** Put back a change that was undone. Refused in words if it was not. */
  deckRedoApply: (deckId: number, auditId: number) =>
    invoke<void>("deck_redo_apply", { deckId, auditId }),
  /** What the plan wants and the deck does not have — see {@link TheoryDiffRow}. One
   *  direction only, on the exact card (printing **and** finish), categories not compared,
   *  inactive ones excluded from both sides. `marketplace` prices the shopping list, which is
   *  the whole point of drawing one. */
  deckTheoryDiff: (deckId: number, marketplace: MarketplaceId) =>
    invoke<TheoryDiffRow[]>("deck_theory_diff", { deckId, marketplace }),
  /**
   * Every card the plan asks for, as `deck_theory.rs`'s own `group_key` strings —
   * `` `${cardId}|${finish ?? ""}` ``, one per theory row, in no particular order and with
   * duplicates left in for the caller's set to fold.
   *
   * The deck editor's theory tick, and **the one question about the pair that
   * {@link ipc.deckTheoryDiff} cannot answer**: a card the reader has fully acquired is absent
   * from the diff and is still in the plan. See `features/decks/theoryMatch.ts`, which builds
   * the same string for a live row and looks it up.
   *
   * **Not a `deckGet` of the other variant**, deliberately: that read prices every row and rolls
   * up allocations, and `DeckEditor.test.tsx` pins that nothing may call it for the list the
   * reader is not looking at. This is two columns of one indexed scan and no marketplace.
   *
   * Inactive categories are excluded, which is `deck_theory_diff`'s rule and the same reasoning:
   * a card parked in the theory Maybeboard is not something the reader has decided to play.
   */
  deckTheorySlots: (deckId: number) => invoke<string[]>("deck_theory_slots", { deckId }),
  /**
   * Copy the live list into the theory one. Answers how many **rows** were written.
   *
   * **This is no longer what enabling the switch does, and it used to be.**
   * `deckUpdate(id, { theoryEnabled: true })` now *moves* the live list into theory — the deck
   * becomes the plan and live starts empty — so nothing calls this implicitly any more. It
   * stays as the explicit gesture it always also was: *copy what is sleeved up into the plan*,
   * for the reader who wants to start the plan again from the deck as it stands.
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
   *
   * **`only` narrows it to the rows the reader ticked** — `deck_theory.rs`'s own `group_key`
   * strings, `` `${cardId}|${finish ?? ""}` ``, which is the same spelling
   * {@link ipc.deckTheorySlots} answers in and `theoryMatch.ts` builds. Absent means the whole
   * difference, so the footer's untouched press and every older caller mean what they always
   * did. A key naming no row of the current difference writes nothing rather than refusing:
   * the diff is re-read inside the write, so a row the reader ticked and then acquired in
   * another window is simply not short any more.
   *
   * **An include list rather than an exclude list**, though the gesture it serves is exclusion.
   * The two differ only for rows that appeared between the read and the press — and those are
   * rows the reader never saw, so sending them would be the dialog acting on its own.
   *
   * **The wish is pinned to the printing the plan names** (2026-08-22), carrying its `foil` or
   * `etched` finish with it, which is the same rule the comparison itself has followed since
   * 2026-08-20: a plan naming a printing is a plan for that cardboard, and answering it with a
   * wish for any printing hands the reader back the substitution they were tracking. The
   * regular copy pins no finish — `null` is the unmarked case in `deck_cards`, and writing
   * `nonfoil` would split this wish from every other one the app makes for that card.
   *
   * Because a pinned wish and an any-printing one are **different rows** on the wishlist grain
   * `(oracleId, cardId, preferredFinish)`, a reader who pressed this before that change keeps
   * their old any-printing line and gains a pinned one. Nothing is lost or double-counted; the
   * upsert folds each into its own row.
   */
  deckTheoryMissingToWishlist: (deckId: number, only?: readonly string[]) =>
    invoke<number>("deck_theory_missing_to_wishlist", { deckId, only }),
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
    finish: DeckFinish,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_add_card", {
      deckId,
      cardId,
      categoryId,
      categoryName,
      variant,
      finish,
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
    finish: DeckFinish,
    quantity: number,
  ) =>
    invoke<EntryChange>("deck_set_card_quantity", {
      deckId,
      cardId,
      categoryId,
      variant,
      finish,
      quantity,
    }),
  /**
   * Empty one category of one variant — a pile's right-click **Clear stack** — and answer the
   * **copies** it removed.
   *
   * One command rather than a `deckSetCardQuantity(…, 0)` per row, and the arithmetic is
   * `deckImportCommit`'s: a loop over a forty-card pile is forty transactions, forty allocator
   * runs and forty invalidations. This is one of each.
   *
   * **This variant only**, which is the opposite of `deckCategoryDelete` — that takes the live
   * list and the theory list together, because `deck_cards.category_id` cascades and a category
   * is not variant-scoped. A clear leaves the pile standing, so what it empties is the list the
   * reader is looking at, and the confirmation says so.
   *
   * An empty pile answers `0` and writes nothing at all: no history row, no `updated_at`, no
   * allocator run.
   */
  deckCategoryClear: (deckId: number, categoryId: number, variant: DeckVariant) =>
    invoke<number>("deck_category_clear", { deckId, categoryId, variant }),
  /**
   * Move every copy from one category to another **within one variant**, folding into whatever
   * the target already holds. The identity travels from the moved row, so an orphan can be
   * tidied out of the scratchpad like anything else.
   *
   * **Either `toCategoryId` or `toCategoryName`, and at least one** — `deckAddCard`'s two-arm
   * target, and the id wins when both arrive. An id is a drop onto a column the reader pointed
   * at; a **name** is the quick zones' `Auto`, found-or-created in the same transaction by
   * `category_for_name`, which is what makes a pile the app invents come out `origin: 'auto'`
   * and therefore stop being drawn once its last card leaves. The word is `autoCategoryFor`'s
   * and is computed here, never in Rust.
   *
   * Answers **the category the copies are now in**, which is the only way the name arm's caller
   * learns what was found or made — the caret follows a moved card to its new pile, so that id
   * is load-bearing rather than a convenience. A name that resolves to the pile the card is
   * already in writes nothing at all, answers that pile, and does not bump `updated_at`.
   */
  deckMoveCard: (
    deckId: number,
    cardId: string,
    fromCategoryId: number,
    toCategoryId: number | null,
    toCategoryName: string | null,
    variant: DeckVariant,
    finish: DeckFinish,
  ) =>
    invoke<number>("deck_move_card", {
      deckId,
      cardId,
      fromCategoryId,
      toCategoryId,
      toCategoryName,
      variant,
      finish,
    }),
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
    finish: DeckFinish,
  ) =>
    invoke<SwapResult>("deck_swap_printing", {
      deckId,
      fromCardId,
      toCardId,
      categoryId,
      variant,
      finish,
    }),
  /**
   * Change **which object** a deck row plays — the regular copy, the foil or the etched one.
   *
   * `deckSwapPrinting` one axis over, and the same shape for the same reason: the deck plays a
   * different physical object of the same card. It **folds** the same way, so setting a row to
   * a finish the pile already holds adds the quantities and takes the row that moved away, and
   * `SwapResult.quantity` is the sum.
   *
   * Refused in words for three things: a finish the row already is (`nonfoil` and `null` are
   * the same finish, so that pair is refused too), a finish the printing is not **sold** in,
   * and a row that is not in that pile.
   */
  deckSetCardFinish: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    fromFinish: DeckFinish,
    toFinish: DeckFinish,
  ) =>
    invoke<SwapResult>("deck_set_card_finish", {
      deckId,
      cardId,
      categoryId,
      variant,
      fromFinish,
      toFinish,
    }),
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
  /**
   * Every name in a decklist, resolved to a printing this app has. **Read-only**, and one call
   * for the whole list rather than one per line — ~100 names is six prepared statements and a
   * few hundred index lookups (11.6 ms for a 105-line commander list, measured over the live
   * corpus), where a call per line would be a hundred IPC hops for the same work.
   *
   * **A name no printing bears is a row, never a rejection**: 99 good lines must not be lost to
   * one bad one, so `matched: null` is the ordinary answer for a typo and the preview quotes it.
   * The rows come back in the order the lines went out and carry
   * {@link ImportResolveRow.index} besides.
   */
  importResolve: (lines: ImportResolveLine[]) =>
    invoke<ImportResolveRow[]>("import_resolve", { lines }),
  /**
   * A whole decklist into one deck: one transaction, one allocation, one or two history rows.
   *
   * **This command exists for the allocator.** Looping {@link ipc.deckAddCard} would be correct
   * in every other respect and would rebuild the deck's claims once per line — a hundred
   * delete-and-rebuild passes for one import. Here it runs once, at the end, over the finished
   * deck.
   *
   * All-or-nothing: a line naming a printing the card database has not got refuses the import
   * and leaves the deck — including the one a `replace` was about to clear — exactly as it was,
   * with no history row and no half-made category behind it. An empty `items` is refused in
   * words, and a `replace` most of all: it would clear the deck and put nothing back.
   *
   * The history it writes is **one row per effect, never one per card** — an import of 117 cards
   * would otherwise bury every other event of that day in the drawer.
   */
  deckImportCommit: (deckId: number, variant: DeckVariant, mode: ImportMode, items: ImportItem[]) =>
    invoke<ImportOutcome>("deck_import_commit", { deckId, variant, mode, items }),
  /**
   * A decklist file the reader picked, as text.
   *
   * **Takes a path — Rust opens the file.** That is the contract that makes `dialog:allow-open`
   * sufficient and is why **no `fs:` permission is granted anywhere**: pass the path
   * `@tauri-apps/plugin-dialog`'s `open()` answered and let the backend read it. A page that
   * read the bytes itself would need a filesystem capability this app deliberately does not
   * have.
   *
   * Capped at 1 MB, and read **lossily** on purpose: a Windows-1252 apostrophe in one card name
   * costs that one line — it comes back carrying `U+FFFD`, resolves to nothing and is quoted in
   * the preview — rather than failing the other hundred. What comes back is a string and nothing
   * more; parsing it is this side's, exactly as it is for a paste.
   */
  importReadFile: (path: string) => invoke<string>("import_read_file", { path }),
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
  /**
   * The four Settings can throw away — `src-tauri/src/reset.rs`.
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
   * which the app refetches on demand. It never touches `data/covers/` — a deck cover is a
   * picture the reader chose — and never a table but `image_cache`.
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
  onUpdateProgress: (cb: (e: UpdateProgressEvent) => void): Promise<UnlistenFn> =>
    listen<UpdateProgressEvent>("update:progress", (evt) => cb(evt.payload)),
  /** A reconcile pass that moved user rows. See {@link ReconciledEvent}. */
  onCollectionReconciled: (cb: (e: ReconciledEvent) => void): Promise<UnlistenFn> =>
    listen<ReconciledEvent>("collection:reconciled", (evt) => cb(evt.payload)),
  /**
   * The marketplace whose prices the app quotes, as a stored id.
   *
   * A raw string rather than a `MarketplaceId`: the value came out of the database and may
   * have been written by a different build, so narrowing it is `resolveMarketplace`'s job on
   * this side of the wire. The backend answers the default for a missing row.
   */
  getMarketplace: () => invoke<string>("get_marketplace"),
  /** Choose one. Rejects an id the backend does not know, so `app_meta` cannot collect junk. */
  setMarketplace: (id: MarketplaceId) => invoke<void>("set_marketplace", { id }),
  /**
   * How the card pane groups its printings list — `artist` | `released` | `price` | `set`,
   * stored so the choice survives a restart.
   *
   * A raw string rather than a `PrintingGroupBy`, for {@link getMarketplace}'s reason and it is
   * the same reason: the value came out of `app_meta` and may have been written by a build that
   * offered a mode this one does not, so narrowing it is `isPrintingGroupBy`'s job in
   * `@/features/card/printings` on this side of the wire. The backend answers `artist` for a
   * missing row **and for an unrecognised one** — a stale preference costs the reader their
   * grouping, never the pane.
   */
  printingGroupBy: () => invoke<string>("printing_group_by"),
  /**
   * Choose one. Rejects a mode the backend does not know, so `app_meta` cannot collect junk —
   * which matters more here than it looks, because the read side discards an unknown mode in
   * silence and an unchecked write would read back as `artist` forever.
   */
  setPrintingGroupBy: (mode: string) => invoke<void>("set_printing_group_by", { mode }),
  /**
   * How large each wall of cards was last left drawn, as section name → multiplier.
   *
   * The third `app_meta` setting and the only one whose shape is a map — see this file's header.
   * **A section is absent rather than defaulted**: the ladder's stops are this side's
   * (`@/lib/cardZoom`), so a missing entry means the reader has never zoomed that wall, and the
   * backend does not invent a number it does not own. A whole unreadable row answers `{}`.
   *
   * Raw `Record<string, number>` rather than `Record<ZoomSection, number>`, for
   * {@link getMarketplace}'s reason a third time: the keys are whatever some build of this app
   * wrote, so `isZoomSection` narrows them here and `snapZoom` puts each value back on the
   * ladder.
   */
  cardZoom: () => invoke<Record<string, number>>("card_zoom"),
  /**
   * Remember one wall's zoom, leaving the other entries in the row alone.
   *
   * Two arguments where its neighbours take one, and Tauri matches by name. Rejects a blank
   * section and a multiplier outside 0.5–2, so `app_meta` cannot collect entries every later read
   * would discard — but the *ladder* is not checked at the far end, deliberately: the backend
   * bounds the number and this side owns where the stops are.
   */
  setCardZoom: (section: string, zoom: number) =>
    invoke<void>("set_card_zoom", { section, zoom }),
  /**
   * Whether the reader has collapsed the global navigation rail, stored so it opens the way
   * they left it.
   *
   * The **fourth** `app_meta` setting and the first that is a bare `boolean` — see this file's
   * header. It is also one of the two that need no narrowing on this side: the other three carry
   * a vocabulary a newer build could have widened, and `true`/`false` has none, so there is no
   * third state to fall back from. **The far end is infallible**: a missing row, a row holding
   * something that is not a boolean, and a row that cannot be read at all all answer `false` —
   * the rail expanded, which is what a reader who has never touched the control sees.
   */
  navCollapsed: () => invoke<boolean>("nav_collapsed"),
  /**
   * Remember the rail's state. Answers `collection::BUSY` under a running sync, like every
   * other write — and the caller deliberately does not undo the rail when it does, because the
   * setting is worth less than the reader's hand: `@/lib/useNavCollapsed` has the argument.
   */
  setNavCollapsed: (collapsed: boolean) => invoke<void>("set_nav_collapsed", { collapsed }),
  /**
   * Whether the deck editor's card search column was last left open.
   *
   * The **fifth** `app_meta` setting and the second bare `boolean`, arriving on the same day as
   * {@link navCollapsed} above and answering the same way — see this file's header. Its default
   * is the other one's mirror image and both are the state the reader has never asked about:
   * `true`, the column open, which is issue #183's reversal of a disclosure that used to open
   * shut. `true` again for a row holding anything but the `"1"`/`"0"` the backend writes.
   */
  deckSearchOpen: () => invoke<boolean>("deck_search_open"),
  /**
   * Remember the answer. Nothing to refuse — a `bool` cannot carry a value the row could not
   * hold — so unlike {@link setPrintingGroupBy} this one's only failure is the BUSY every write
   * command takes while a sync holds the write connection, which costs the reader the next
   * launch's starting state and nothing this session.
   */
  setDeckSearchOpen: (open: boolean) => invoke<void>("set_deck_search_open", { open }),
  /**
   * Whether the collection is the sum of the reader's live decks rather than a hand-kept list.
   *
   * The **sixth** `app_meta` setting and the third bare `boolean` — see this file's header, and
   * `src-tauri/src/deck_driven.rs`. Nothing to narrow, and the far end is infallible the way the
   * other two are: a missing row, a junk row and an unreadable one all answer `false`, the
   * hand-kept collection, which is where a reader who has never touched this switch keeps their
   * cards.
   */
  deckDrivenCollection: () => invoke<boolean>("deck_driven_collection"),
  /**
   * Remember it. Answers `collection::BUSY` under a running sync like every other write — and
   * **unlike {@link setNavCollapsed}, that refusal is surfaced and the control is put back**.
   * This flag decides what the Collection page is a *list of*, so a switch left disagreeing with
   * the page under it is worse than a moment's interruption. `@/lib/useDeckDrivenCollection`
   * has the argument.
   */
  setDeckDrivenCollection: (enabled: boolean) =>
    invoke<void>("set_deck_driven_collection", { enabled }),
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
  onMarketplaceProgress: (cb: (e: FeedProgressEvent) => void): Promise<UnlistenFn> =>
    listen<FeedProgressEvent>("marketplace:progress", (evt) => cb(evt.payload)),
  /**
   * The Oracle tags for a set of **printings** — the read every categorising call site makes.
   *
   * **Match the answers back by `cardId`, never by position.** Blank ids and duplicates are
   * dropped, so the answer is one entry per *distinct* id and `result.length` can be shorter
   * than what was asked. Reading `result[i]` against `input[i]` works right up until a caller
   * sends the same card twice — which a decklist with two printings of one card does.
   *
   * One statement per 500 ids, so a whole import asks once. An unknown id answers `slugs: []`
   * rather than being absent, because {@link CardTags} makes "no tags" and "no such card" the
   * same answer on purpose.
   */
  oracleTagsForPrintings: (cardIds: string[]) =>
    invoke<PrintingTags[]>("oracle_tags_for_printings", { cardIds }),
  /**
   * The same read keyed by oracle id, for a caller holding one — `DeckCard.oracleId`, a
   * wishlist row. Same contract, same match-by-id rule.
   */
  oracleTagsForCards: (oracleIds: string[]) =>
    invoke<CardTags[]>("oracle_tags_for_cards", { oracleIds }),
  /**
   * The taxonomy's freshness. Reads one small table, makes no network call, and **is safe
   * before the first refresh has ever run** — a database with no meta row answers every field
   * `null` with `stale: true` rather than rejecting, so no caller needs a guard.
   */
  oracleTagsStatus: () => invoke<OracleTagStatus>("oracle_tags_status"),
  /**
   * Fetch the taxonomy if it is due. `force` skips the weekly throttle, **not** the ETag check
   * — a forced refresh of an unchanged file still costs one request and no ingest.
   *
   * ~5.8 MiB compressed and a few seconds of ingest, so it reports through the same `Activity`
   * mechanism every other long job uses. **A failed fetch leaves the previous taxonomy in
   * place**: stale categories beat none, and a rejection here is never a reason to stop filing
   * cards — the type-line fallback is always available.
   */
  oracleTagsRefresh: (force: boolean) => invoke<OracleTagStatus>("oracle_tags_refresh", { force }),
  /**
   * The taxonomy being fetched, phase by phase — beside `sync:progress`, `marketplace:progress`
   * and `update:progress`.
   *
   * **Subscribe once**, like all three: every extra call is another `listen` registration for
   * the life of the app. Tauri drops events emitted before the webview registered its listener
   * and the startup refresh can begin before this window has one, so
   * {@link ipc.oracleTagsStatus} is the reliable half of the pair.
   */
  onOracleTagProgress: (cb: (e: OracleTagProgressEvent) => void): Promise<UnlistenFn> =>
    listen<OracleTagProgressEvent>("oracle-tags:progress", (evt) => cb(evt.payload)),
  /**
   * The **art** taxonomy's freshness — {@link ipc.oracleTagsStatus} one dataset over, and safe
   * before the first refresh for the same reason: a database with no meta row answers every
   * field `null` with `stale: true` rather than rejecting.
   *
   * A never-ingested art taxonomy is not a failure. It is what every install is on its first
   * launch and what a machine that cannot reach Scryfall stays in, and the honest answer to it
   * is a Tags page that says it has nothing yet.
   */
  artTagsStatus: () => invoke<ArtTagStatus>("art_tags_status"),
  /**
   * Fetch the art taxonomy if it is due. `force` skips the weekly throttle, **not** the ETag
   * check — a forced refresh of an unchanged file still costs one request and no ingest.
   *
   * ~12.5 MiB compressed (measured 2026-08-20), a little over twice the oracle file, flattening
   * 475 163 taggings into 951 499 closure rows. It reports through the same `Activity` mechanism
   * every other long job uses, and **a failed fetch leaves the previous taxonomy in place**:
   * nothing here may break a launch or a card sync.
   */
  artTagsRefresh: (force: boolean) => invoke<ArtTagStatus>("art_tags_refresh", { force }),
  /**
   * The art taxonomy being fetched, phase by phase — a channel of its own beside
   * `oracle-tags:progress`, because either taxonomy may be refreshing while the other is.
   *
   * **Subscribe once**, like every other listener here. Tauri drops events emitted before the
   * webview registered a listener and the startup refresh can begin before this window has one,
   * so {@link ipc.artTagsStatus} is the reliable half of the pair.
   */
  onArtTagProgress: (cb: (e: ArtTagProgressEvent) => void): Promise<UnlistenFn> =>
    listen<ArtTagProgressEvent>("art-tags:progress", (evt) => cb(evt.payload)),
  /**
   * Type-ahead over the tag taxonomies — the Tags page's search box.
   *
   * `namespace` is `"art"`, `"oracle"` or `"both"`, and **`"both"` puts art first on an equal
   * rank**: the page's job is an art theme, so a reader who types `dog` means the illustrations
   * and the oracle tag of the same name is the secondary reading.
   *
   * **Substring, not prefix, and that is a deliberate departure from Scryfall** — verified live
   * 2026-08-20, `otag:remov` 404s and `otag:*spot*` answers nothing, so there is nothing to
   * borrow and a reader told "no such tag" until they spell `dogs-of-war` exactly is not using a
   * search box. The exact hit is ranked first, then the prefix hits, then the rest.
   *
   * **An empty or all-punctuation `text` matches every tag rather than none**, so an untouched
   * box answers the tags with the widest reach. `limit` caps the *merged* answer.
   */
  tagSearch: (text: string, namespace: TagNamespace | "both", limit: number) =>
    invoke<TagHit[]>("tag_search", { text, namespace, limit }),
  /**
   * One level of the tag tree: the children of `slug`, or the **roots** when it is `null`.
   *
   * Unlimited, deliberately — this draws one level of a tree (3 219 art roots, measured
   * 2026-08-20) and an arbitrary cut would silently lose branches.
   *
   * A tag with several parents is listed under every one of them, which is the honest reading of
   * a graph rather than a tree; its {@link TagHit.parents} name the rest so the rail can say so.
   * **A muted tag takes its subtree off the rail with it** — its children are not roots and no
   * other path reaches them unless they have a second parent. That is recoverable by unmuting,
   * and the children stay findable through {@link ipc.tagSearch}.
   */
  tagChildren: (namespace: TagNamespace | "both", slug: string | null) =>
    invoke<TagHit[]>("tag_children", { namespace, slug }),
  /**
   * Turn tag names typed into a card search box into the slugs {@link SearchRequest.artTags} and
   * {@link SearchRequest.oracleTags} match on — `tagQuery.ts`'s tokens, resolved.
   *
   * **One answer per ask, in the order asked, `null` where there is no such tag.** The misses
   * ride along rather than being filtered out, because the box has to be able to name the token
   * it could not find and a shortened list cannot say which one is missing.
   *
   * **Exact, where {@link ipc.tagSearch} is a substring, and the difference is the job.** That
   * one is a type-ahead and should find `removal` from `remov`; this one builds a *filter*, and
   * a substring here would resolve one token to many tags that would have to be ORed — while
   * every tag filter in this app intersects, so `a:dragon` would silently also answer
   * `dragonborn`. Separators and case are still noise (`otag:"spot removal"`,
   * `otag:spot-removal` and `otag:SPOT-REMOVAL` are one tag, verified live 2026-08-20), because
   * Rust matches through `slug_norm`.
   *
   * **A muted tag still resolves.** Muting hides a tag from the search box and the rail; it is
   * documented never to hide a *card*, and nothing in the card filters consults that table. A
   * reader who spells a tag out has named it rather than browsed onto it.
   *
   * A blank or all-punctuation value answers `null` and never a tag — see the Rust for why that
   * is a guard rather than an accident.
   */
  tagResolve: (asks: readonly TagLookup[]) =>
    invoke<(TagRef | null)[]>("tag_resolve", { asks }),
  /**
   * Stop offering a tag anywhere — Scryfall asks downstream apps for this in as many words,
   * because Tagger is crowdsourced and they cannot guarantee the data is free from abuse.
   *
   * **Keyed on {@link TagHit.id}, never on the slug**, and a blank id is refused in words rather
   * than stored: one row with an empty `tagId` would equal every un-refreshed `oracle_tags` row
   * and take the whole taxonomy off the page silently. `slug` rides along so Settings can name
   * the tag later without joining a taxonomy that may since have been rebuilt or emptied.
   *
   * Idempotent by `(namespace, tagId)`: muting an already-muted tag refreshes the stored slug and
   * the timestamp, which is what makes a rename harmless.
   */
  tagMute: (namespace: TagNamespace, tagId: string, slug: string) =>
    invoke<void>("tag_mute", { namespace, tagId, slug }),
  /** Offer a tag again. A tag that was never muted is **not** an error — the row is gone either
   *  way, and a Settings list that raced a second window is not worth shouting about. Unlike
   *  {@link ipc.tagMute} this accepts a blank `tagId`, because a row with one is unreachable by
   *  any tag it was meant to name and junk to delete is all it can ever be. */
  tagUnmute: (namespace: TagNamespace, tagId: string) =>
    invoke<void>("tag_unmute", { namespace, tagId }),
  /** Everything the reader has hidden, for the Settings list that gives it back — by taxonomy,
   *  then by the stored slug, because this list exists to be searched by eye. */
  tagsMuted: () => invoke<MutedTag[]>("tags_muted"),
  /**
   * The Scryfall CDN URL for one printing at one size, or `null`.
   *
   * A command rather than a field on the list DTOs, and called **on the press** — see
   * `card_image_uri` in the crate. Three ways to `null`, all of them answers: an unknown
   * card, a card with no `image_uris`, and a variant the source lacked.
   */
  cardImageUri: (cardId: string, variant: ImageVariant) =>
    invoke<string | null>("card_image_uri", { cardId, variant }),
  /**
   * Write an export at a path the reader chose in the OS save dialog.
   *
   * Rust writes the file because `dialog:allow-save` answers a *path* and nothing more, and
   * writing at it from here would need an `fs:` permission this app grants nowhere. Same
   * shape as `deck_set_cover_image`.
   */
  exportWriteFile: (path: string, contents: string) =>
    invoke<void>("export_write_file", { path, contents }),
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
