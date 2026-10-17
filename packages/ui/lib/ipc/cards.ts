/**
 * The card corpus: search, facets, a card's detail and printings, prices, holdings, and the marks a wall draws.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `cardCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { Border } from "../border";
import type { Finish } from "../finish";
import type { ImageVariant } from "../images";
import type { MarketplaceId } from "../marketplace";
import type { SortSpec } from "../sort";
import type { Universe } from "../universe";
import { invoke } from "./invoke";
import type { ArtWeightFloor, TagTerms } from "./tags";

/**
 * The search's sortable columns. Mirrors `SEARCH_SORTS` in `crates/grimoire-core/src/search.rs`; a key
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
 * `crates/grimoire-core/src/collection.rs`.
 */
export type CollectionSortKey =
  "name" | "set" | "finish" | "quantity" | "value" | "price" | "added";

/**
 * The wishlist's sortable columns.
 *
 * There is no `set`: an any-printing wish names no set, so the Printing column is not
 * sortable at all. `cost` is what the wish costs — unit × copies wanted, which is the figure
 * the Cost cell prints.
 *
 * **There is no `owned` either, since 2026-09-08.** It ordered by the copies the collection
 * held against each wish, and the wishlist compares itself to the collection nowhere any more.
 * Mirrors `WISHLIST_SORTS` in `crates/grimoire-core/src/wishlist.rs`.
 */
export type WishlistSortKey = "name" | "quantity" | "cost" | "price" | "added";

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
  /**
   * Colour identity, e.g. `"WU"`; `"C"` means colourless only.
   *
   * **Subset semantics unless {@link colorsStrict} says otherwise** — the default reads these
   * letters as a ceiling, so `"WU"` answers mono-W, mono-U, WU and the colourless cards alike.
   * That is the Commander question ("what may go in this deck"); strict is the other one
   * ("what *is* this colour pair"), and the letters are the same on both.
   */
  colors?: string;
  /**
   * Read {@link colors} as an **exact** identity rather than a subset: `"RW"` answers the RW
   * cards alone, not mono-R, mono-W, or the colourless cards that fit in any deck.
   *
   * Degenerate for `"C"`, which already means colourless-only in both modes. A `true` with no
   * {@link colors} filters nothing — the chip is not drawn until a colour is picked.
   */
  colorsStrict?: boolean;
  setCode?: string;
  /**
   * Every printing of one oracle card — the card, not the cardboard. Absent means unset,
   * like every other filter here; it ANDs with the rest. Mirrors
   * `CardFilters::oracle_id` in `crates/grimoire-core/src/filters.rs` and
   * `SearchRequest::oracle_id` in `crates/grimoire-core/src/search.rs`.
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
  /**
   * Rarity chips: `["rare", "mythic"]` means "either". ORed with each other, ANDed with every
   * other filter — {@link sets}' shape one dimension along.
   *
   * **A field beside {@link rarity} rather than a widening of it.** That one is single-valued
   * and is what `PrintingsFilterBar`'s `<select>` sends; a multi-select has to be able to say
   * "none picked", which for an array is `[]` and which a lone string cannot spell. Rust:
   * `rarities: Option<Vec<String>>`.
   */
  rarities?: string[];
  /**
   * Card-type chips — `Artifact`/`Battle`/`Creature`/`Enchantment`/`Instant`/`Land`/
   * `Planeswalker`/`Sorcery`. ORed with each other, ANDed with every other filter.
   *
   * **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
   * (`Land Creature — Forest Dryad`) answers both `Land` and `Creature`.
   */
  types?: string[];
  /**
   * Border chips — `regular`/`borderless`/`fullart` (`@/lib/border`). ORed with each other,
   * ANDed with every other filter: the type chips' shape one dimension along. `regular` is a
   * printing that is **neither** borderless nor full art; a borderless full-art printing
   * answers both of the other two. Rust: `borders: Option<Vec<String>>`.
   */
  borders?: Border[];
  /**
   * Finish chips over the **printing** — "is this printing published in foil", Scryfall's
   * `is:foil` — ORed with each other. Answered from `cards.finishes`, so a printing that exists
   * in nonfoil and foil answers both chips.
   *
   * **Not the collection's {@link CollectionQuery.finishes}**, which is the finish one *copy*
   * is in. The two share the tray's Finish cell and nothing else; the different name is what
   * keeps them from colliding on the collection's flattened payload. Rust:
   * `printed_finishes: Option<Vec<String>>`.
   */
  printedFinishes?: Finish[];
  /**
   * Universes Beyond (`beyond`) or Universes Within (`within`), absent for both — one value,
   * because the two partition the printings (`@/lib/universe`). Beyond is Scryfall's
   * `universesbeyond` promo type and Within every printing without it. Rust:
   * `universe: Option<String>`.
   */
  universe?: Universe;
  /**
   * The price band, at {@link marketplace}. Inclusive at both ends, either half usable alone.
   *
   * **An unpriced printing matches neither bound** — a shop that does not list a card has not
   * offered it at zero. So a range narrows away every printing the chosen marketplace is silent
   * about, which on Card Kingdom and Mana Pool is most of the corpus until that feed has been
   * fetched. Rust: `price_min`/`price_max`, applied in `run_search` over
   * `sorting::printing_price_expr` — the same expression the Price column shows.
   *
   * **The facet counts ignore both**, and that is deliberate: `CardIndex` has no price
   * dimension, so a bounded search is faceted over the unbounded corpus and every count reads
   * high. Fails open, which is the rule the whole row is built on — an over-read count only
   * ever leaves a control live that a real count would have greyed.
   */
  priceMin?: number;
  priceMax?: number;
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
   * **An entry, not a copy.** A card whose only entry holds no copies passes `owned: true`
   * while its {@link CardSummary.ownedQuantity} reads `0`, and does *not* appear under
   * `owned: false`. What this filter asks is whether the collection has *paperwork* for the
   * printing, and the count beside it is what says how much.
   *
   * Rare since schema v24 — `collectionSetQuantity` deletes at zero now — but the rule is
   * about what this filter asks rather than about what the collection happens to store, and
   * `collectionUpdate` still keeps the row it is editing.
   */
  owned?: boolean;
  /**
   * The deck this search is being run **for** — the deck builder's card search tab and nothing
   * else. Absent everywhere else, and absent means "every copy, wherever it is filed", which is
   * what this command answered before the field existed.
   *
   * **Not a filter over cards.** It changes no row's presence and no row's order; it decides
   * which of the reader's copies count as *available to this deck*, for {@link owned} and
   * {@link CardSummary.ownedQuantity} together. A copy sleeved into another deck's group, or
   * set aside in a locked drawer, stops counting; a copy in this deck's own group, on the desk,
   * in a binder or in `Recently removed` still does.
   *
   * Why the deck builder is the one asker
   * ([#349](https://github.com/Msgaihede/mtg-grimoire/issues/349)): a badge reading `×4` over a
   * card whose four copies are all in other decks told the reader they had something they could
   * not use, while the Collection tab in the same panel — which has sent
   * `allocation: "unallocated"` since folders landed — showed none of them.
   *
   * **The two halves move together.** Narrowing the count and leaving the filter alone would
   * put a card under the Owned chip wearing `×0`. `Availability` in
   * `crates/grimoire-core/src/collection_source.rs` is the one place the arms are written.
   */
  availableForDeck?: number;
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
  /**
   * The Scryfall-syntax terms the box was parsed into — see {@link QueryPredicate}.
   *
   * **`typeLine` and `oracleText` ride {@link text}'s `MATCH` string rather than becoming SQL**,
   * so they narrow the facet counts for free and a purely negative one (`-t:goblin`) becomes a
   * `NOT IN` subquery of its own, FTS5's `NOT` being binary. Nothing here has to know that; it
   * is why the list is read by `filters::fts_match` as well as by `push_card_filters`.
   */
  predicates?: QueryPredicate[];
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
   * Mirrors `CardSummary::game_changer` in `crates/grimoire-core/src/search.rs`, which is `bool` and not
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
   * The printing's release date, `YYYY-MM-DD`, or `null` where the corpus has none.
   *
   * Here so the wall can stamp a card that is **not out yet** (issue #940) with its set and
   * this date — `unreleasedStamp` in `@/lib/unreleased` draws the conclusion. Collapsed, it is
   * the representative printing's, which is the one whose art the tile shows.
   */
  releasedAt: string | null;
  /**
   * Copies the collection holds of **this printing, across every finish and condition** —
   * a badge on a search result, and finish-*blind*.
   *
   * One of **three** fields in this file with this name, and only one of the other two asks
   * the same question. {@link DeckCard.ownedQuantity} is what one deck's own collection group
   * physically holds, matched to the row's exact `(card_id, finish)` since 2026-09-07 rather
   * than to the oracle card. The third, {@link ImportMatch.ownedQuantity}, **is** this number:
   * every copy of one printing, finish-blind, asked per decklist line instead of per search
   * row. Read each against its own row.
   *
   * **`WishRow` carried a fourth until 2026-09-08** — copies counted against one wish,
   * finish-aware, so a foil wish read `0` while the nonfoil sat in a binder. It is gone with
   * every other comparison the wishlist made against the collection: that list is the reader's
   * own, kept by hand, and a wish leaves it when they acquire the card rather than being
   * quietly marked as filled.
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
 * Mirrors `crates/grimoire-core/src/index/facets.rs`. **`ready: false` means the index is still
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
   * chip** rather than a count of cards carrying that colour. Compare against {@link total}.
   *
   * **Which direction a press moves in depends on {@link SearchRequest.colorsStrict}, which is
   * why the number is "after the press" rather than "cards carrying this".** Loose, colours are
   * subset semantics and pressing one with another already on *broadens*; strict, the same
   * press *narrows*. The count is computed under whichever mode the request carried, so the
   * rule that reads it — greying when a press would not change the result set — holds either
   * way without knowing which mode it is in.
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
   * Keyed `common`/`uncommon`/`rare`/`mythic`. Plain counts, and all four arrive on every
   * **ready** response, zeros included — the chips grey a counted zero and stay live on an
   * absent key, so a key that went missing would silently stop greying.
   *
   * **They do not sum to {@link total}.** The corpus also holds `special` and `bonus`
   * printings, which no chip offers and nothing counts, so these four are a filter's
   * vocabulary rather than a partition of the result set.
   */
  rarities: Record<string, number>;
  /**
   * Keyed by card type. Plain counts, and all eight are sent on every ready response, zeros
   * included.
   *
   * **These do not sum to {@link total} and do not bound it** — the eight overlap (a card can
   * be Artifact and Creature) and the corpus holds types no chip offers. The same reading
   * {@link rarities} needs.
   */
  types: Record<string, number>;
  /**
   * Keyed `regular`/`borderless`/`fullart`. Plain counts, all three on every ready response,
   * zeros included. **They overlap** — a borderless full-art printing is counted under both —
   * so, like {@link types}, they do not sum to {@link total}. Rust: `borders`.
   */
  borders: Record<string, number>;
  /**
   * Keyed `nonfoil`/`foil`/`etched`: how many printings are **published** in each finish. Plain
   * counts, all three on every ready response. They overlap (51,628 paper printings come in
   * both nonfoil and foil), so they do not sum to {@link total}. Rust: `finishes`.
   */
  finishes: Record<string, number>;
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

/**
 * One printing's {@link FinishPrices}, keyed by its id — an entry of
 * {@link ipc.printingPrices}' answer, and `PrintingPrices` in `card.rs`.
 */
export interface PrintingPrices {
  cardId: string;
  finishPrices: FinishPrices;
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
 * One printing of **any** token or emblem in the game — `token_printings`' row, the read behind
 * Add printing's `All tokens` (managed tokens spec §3.6).
 *
 * **A {@link Printing} with the token's own facts beside it**, and that is the shape on purpose:
 * `deck_tokens::TokenPrinting` flattens `card::Printing` into itself (`#[serde(flatten)]`), so the
 * picker's tile code — written against `card_printings`' rows — draws these with no branch, and the
 * facts it groups and subtitles by ride alongside. They are the ones `DeckTokenRow` carries for
 * `tokenSubtitle`, because a token's name does not identify it: the whole game's tokens include
 * `Wurmcoil Engine`'s two `Wurm`s, separated only by their rules text.
 *
 * **No `layout` of its own**: {@link Printing.layout} is already on the flattened printing, and a
 * second field would serialise the key twice — the Rust struct is pinned to one.
 *
 * `ipc.test.ts` holds the fields here to the Rust struct's own, less the flattened one.
 */
export interface TokenPrinting extends Printing {
  /** The token — the grain every printing of it shares, and what the picker groups by. */
  oracleId: string;
  name: string;
  /** The token's type line — {@link DeckTokenRow.typeLine}'s, so a row hands `tokenSubtitle`
   *  the whole shape its parameter names, as a deck's token row does. */
  typeLine: string | null;
  /** Scryfall's colour letters, concatenated — {@link DeckTokenRow.colors}' form. */
  colors: string | null;
  /** Printed sizes, strings for {@link DeckTokenRow.power}'s reason (`*`, `1+*`). */
  power: string | null;
  toughness: string | null;
  oracleText: string | null;
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

/**
 * What the reader holds of one card — the three figures the card pane's **In your grimoire**
 * block states, in one read.
 *
 * **Every one of them is at the oracle grain**, because that is what "in your grimoire" means: a
 * reader who owns the Alpha Bolt and opens the M10 one owns *Lightning Bolt*. The per-printing
 * question — how many of *this* printing are in a binder, which is what the pane's stepper writes
 * to — is a different one and is not answered here.
 *
 * **Facts, not a sentence.** Rust counts; what the block says about the counts, and whether it
 * draws at all when all three are zero, is this side's. Three zeros is a real answer about a card
 * nobody holds — never `null`, and never a rejection.
 */
export interface CardHoldings {
  /**
   * Copies in the collection — **every printing, every finish and every folder together**. A
   * copy on a locked shelf or sleeved into a deck is still a copy the reader owns, which is the
   * scope every surface outside the deck builder's own card search asks for.
   *
   * A copy whose printing the corpus has lost is **not** counted: the row joins `cards` to find
   * its oracle card and an orphan joins nothing. That is the same figure `collectionList({
   * oracleId })` answered before this command existed, so it is a limit rather than a change.
   */
  owned: number;
  /**
   * Copies the wishlist asks for, every wish for the card together. The wishlist's grain makes a
   * foil wish and a nonfoil wish two rows for one card, so this is a sum across rows and not a
   * row count — and it narrows by neither finish nor folder, because "how many are wished for"
   * is a fact about the card.
   */
  wished: number;
  /**
   * How many **decks** play the card — decks, not copies: a deck playing four counts once, and so
   * does a deck listing it in two piles.
   *
   * **Live lists only**, which is `deckIdsPlaying`'s own rule rather than a second one: a plan
   * holds no cards, so a deck that has only *thought about* this card is not one that plays it.
   * Archived decks count, for the same reason — that read has never had a deck filter.
   */
  decks: number;
}

/**
 * The TCGplayer product ids Scryfall stores for one printing — both of them, unread.
 *
 * **Two ids because etched foil is a separate product on TCGplayer rather than an option on
 * one.** The catalogue lists `484936 The Ur-Dragon (Foil Etched)` as its own product, whose own
 * subtype is `Foil`; that is why Scryfall carries `tcgplayer_etched_id` beside `tcgplayer_id` at
 * all. Measured on the corpus 2026-09-09: **892** printings carry only the etched id and **333**
 * carry both, so neither field is derivable from the other and a single "the product id" would be
 * wrong for 1 225 printings.
 *
 * **Both come over unread because only the caller knows the finish.** Rust supplies facts and TS
 * draws conclusions (root `CLAUDE.md`), and the fact here is *which products exist*; the
 * conclusion — which one a reader pressing "Open on TCGplayer" wants — needs the finish the
 * surface named (a collection row's own, a deck row's, a wishlist preference), which no query
 * against `cards` can see. `packages/ui/features/card/openMarketplace.ts` is where that conclusion is
 * drawn, once, for both call sites.
 *
 * **Either field is `null` for a printing TCGplayer does not sell, and that is common enough to
 * be the normal case rather than an error.** Coverage of `tcgplayer_id ?? tcgplayer_etched_id`,
 * measured 2026-09-09: **98.38 %** of paper English non-token printings (99 885 rows), 93.90 % of
 * all paper, 86.44 % of the whole corpus — and **0.04 %** of digital-only cards, which are not
 * sold there at all. So a caller must have a fallback for two nulls; it is not a failure path.
 */
export interface TcgplayerIds {
  /** Scryfall's `tcgplayer_id`: the ordinary product, sold as `Normal` and `Foil`. */
  productId: number | null;
  /** Scryfall's `tcgplayer_etched_id`: the etched product, which is sold as `Foil` only. */
  etchedProductId: number | null;
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
  /**
   * Colour identity, e.g. `"WU"`; `"C"` means colourless only.
   *
   * **Subset semantics unless {@link colorsStrict} says otherwise** — see
   * {@link SearchRequest.colors}, which is the same field on the same control. The default
   * reads these letters as a ceiling; strict reads them as the whole identity.
   */
  colors?: string;
  /**
   * Read {@link colors} as an **exact** identity rather than a subset: `"RW"` answers the RW
   * cards alone, not mono-R, mono-W, or the colourless cards that fit in any deck.
   *
   * Degenerate for `"C"`, which already means colourless-only in both modes. A `true` with no
   * {@link colors} filters nothing — the chip is not drawn until a colour is picked.
   *
   * Declared here as well as on {@link SearchRequest} because `filters::push_card_filters`
   * emits it for all three lists, exactly as {@link oracleId} below is. Rust:
   * `colors_strict: Option<bool>`.
   */
  colorsStrict?: boolean;
  setCode?: string;
  /**
   * Narrow to every printing of one oracle card — the card, not the cardboard.
   *
   * **Declared here as well as on {@link SearchRequest}, because `filters::push_card_filters`
   * emits it for all three lists.** The collection's and the wishlist's queries flatten
   * `filters::CardFilters`, which has carried `oracle_id` since the field was added, so a
   * collection list can be narrowed to one card server-side — which is what the deck builder's
   * `own` add does before it hunts for a free copy. This mirror said the opposite in a doc
   * comment for one PR, and a caller wanting the field had to declare a local type to reach it.
   *
   * The exact-card filter `text` is not: that is FTS **prefix** matching, so a name query
   * answers other cards too.
   */
  oracleId?: string;
  sets?: string[];
  /** 0–7 match exactly, 8 means "8 or more". */
  manaValues?: number[];
  /** Also match printings whose printed cost names `{X}` — see
   *  {@link SearchRequest.manaX}, which is the same field on the same chip group: ORed with
   *  the numbers above and additive, never a re-filing. Rust: `mana_x: Option<bool>`. */
  manaX?: boolean;
  rarity?: string;
  /** Rarity chips, ORed with each other — see {@link SearchRequest.rarities}, which is the same
   *  field on the same control. Declared here as well because `filters::push_card_filters` emits
   *  it for all three lists, exactly as {@link oracleId} above is. Rust:
   *  `rarities: Option<Vec<String>>`. */
  rarities?: string[];
  /**
   * Card-type chips — `Artifact`/`Battle`/`Creature`/`Enchantment`/`Instant`/`Land`/
   * `Planeswalker`/`Sorcery`. ORed with each other, ANDed with every other filter.
   *
   * **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
   * (`Land Creature — Forest Dryad`) answers both `Land` and `Creature`.
   *
   * Declared here as well as on {@link SearchRequest} for {@link rarities}' reason:
   * `filters::push_card_filters` emits it for all three lists, so a binder or a wishlist can
   * be narrowed to a type without a second filter path. Rust: `types: Option<Vec<String>>`.
   */
  types?: string[];
  /** Border chips — see {@link SearchRequest.borders}, the same field on the same control.
   *  Declared here as well because `filters::push_card_filters` emits it for all three lists, so
   *  a binder and a wishlist narrow by the printing's frame too. Rust:
   *  `borders: Option<Vec<String>>`. */
  borders?: Border[];
  /** The printing's published finishes — see {@link SearchRequest.printedFinishes}. On the
   *  collection's payload this sits beside {@link CollectionQuery.finishes}, the copy's own
   *  finish, which is a different question; nothing in the app sends this one there. Rust:
   *  `printed_finishes: Option<Vec<String>>`. */
  printedFinishes?: Finish[];
  /** Universes Beyond or Within — see {@link SearchRequest.universe}, the same field on the same
   *  control. Declared here as well because `filters::push_card_filters` emits it for all three
   *  lists. Rust: `universe: Option<String>`. */
  universe?: Universe;
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
   * owned-cards wall can be narrowed to a motif without a second filter path. {@link oracleId}
   * above is emitted for the same three and is here for the same reason; this comment claimed
   * the opposite until 2026-08-23, and a mirror that says a field does not exist is a field
   * nobody sends.
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
  /**
   * The Scryfall-syntax terms the search box was parsed into — see {@link QueryPredicate}.
   *
   * **Declared here as well as on {@link SearchRequest}, because `filters::push_card_filters`
   * emits them for all three lists** — {@link oracleId} and {@link artTags} above are here for
   * exactly that reason, and this is the same fact one field along. So `t:goblin cmc>=3`
   * narrows a binder and a wishlist as well as the search wall, and Rust needed one edit for
   * the three.
   */
  predicates?: QueryPredicate[];
}

/**
 * What one {@link QueryPredicate} is a statement about — `filters::PredicateField`, whose
 * variants carry `#[serde(rename_all = "camelCase")]`, so these strings are the wire.
 *
 * **`name`, `typeLine` and `oracleText` emit no SQL at the top level.** They travel in the same
 * list as the rest and are folded into the FTS5 `MATCH` string instead, because `LIKE` over
 * either text column measured 80× to 250× slower on the real corpus. Nothing on this side has to
 * know that — it is recorded because the three are the fields whose behaviour differs from their
 * neighbours', and the difference is invisible in the payload. (The wishlist is the exception
 * for `name`: it answers one from its own denormalised name column, as it does its free text.)
 * Two exceptions since issue #909: a `name` whose op is `eq` — Scryfall's `!"exact name"` — is
 * plain SQL equality and never FTS, and inside a group every FTS field becomes its own
 * `rowid IN (… MATCH …)` sub-select, because one `MATCH` string cannot sit under an `OR`.
 *
 * `name` is what `queryLanguage.ts` sends for a leading `-` on free text — `-bolt`,
 * `-"lightning bolt"` — for the `name:` keyword, and for `!` (op `eq`).
 *
 * # The fields issue #909 added
 *
 * - **`anyOf` / `allOf` are the two groups.** They carry no value (`""`), their op is ignored
 *   (`"colon"` is sent), and {@link QueryPredicate.terms} holds what they combine: `anyOf` is
 *   Scryfall's `or`, `allOf` a parenthesised conjunction that had to stay one unit — negated,
 *   `-(t:goblin c:r)`, or nested under an `or`. A plain top-level `(a b)` is flattened by the
 *   parser and never arrives as an `allOf`.
 * - **`text`, `oracleTag` and `artTag` exist only for what sits inside a group.** At the top level
 *   free text rides `SearchRequest.text` and a tag rides `tag_resolve` and `oracleTags`/`artTags`,
 *   as they always have; inside an `or` neither path can carry them, so a bare word becomes a
 *   `text` term (FTS over every column) and a tag term an `oracleTag`/`artTag` term that Rust
 *   resolves by normalised name in SQL. An unknown name inside a group matches nothing, and the
 *   other branches of its `or` still answer.
 * - **The other thirty-odd are Scryfall keywords** — `queryLanguage.ts`' `QUERY_KEYWORDS` is the
 *   table that names each one's spellings, and `docs/reference/search-syntax.md` says how each
 *   is matched.
 */
export type PredicateField =
  | "name"
  | "typeLine"
  | "oracleText"
  | "keyword"
  | "artist"
  | "colors"
  | "colorIdentity"
  | "cmc"
  | "power"
  | "toughness"
  | "rarity"
  | "setCode"
  | "format"
  | "anyOf"
  | "allOf"
  | "text"
  | "oracleTag"
  | "artTag"
  | "flavor"
  | "watermark"
  | "manaCost"
  | "devotion"
  | "produces"
  | "loyalty"
  | "powTou"
  | "collectorNumber"
  | "setType"
  | "block"
  | "inPrinting"
  | "game"
  | "language"
  | "year"
  | "date"
  | "usd"
  | "eur"
  | "tix"
  | "border"
  | "frame"
  | "stamp"
  | "banned"
  | "restricted"
  | "prints"
  | "paperPrints"
  | "sets"
  | "paperSets"
  | "newFeature"
  | "is"
  | "has";

/**
 * A {@link QueryPredicate}'s comparison — `filters::PredicateOp`, camelCase on the wire.
 *
 * **`"colon"` is Scryfall's `:` and means a different thing on each field**: `c:rg` is `c>=rg`
 * and answers 676 cards, while `id:rg` is `id<=rg` and answers 13,399 (both measured on
 * Scryfall, 2026-09-22). `queryLanguage.ts` resolves it per keyword before sending, so a
 * `"colon"` on the wire is one of the fields whose default really is `:` — and Rust
 * resolves it the same way for anything else, rather than refusing.
 */
export type PredicateOp = "colon" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/**
 * One parsed term of a search box — `t:goblin`, `cmc>=3`, `-a:rebecca`, `(t:goblin or t:elf)`.
 * Rust: `filters::QueryPredicate`.
 *
 * **Parsing happens here and never in Rust.** `packages/ui/features/search/queryLanguage.ts` reads the
 * box into free text, tag tokens and a list of these; the crate receives closed enums and emits
 * SQL. Rust supplies facts, TypeScript draws conclusions, and a query grammar is a conclusion.
 *
 * **One list rather than ten fields on {@link CardFilters}**, because a list carries three
 * things no field can spell: negation, repetition (`t:creature t:goblin` is two terms and both
 * must hold) and an operator per term. Terms in the list AND with each other and with every
 * other filter; Scryfall's `or` and parentheses arrive as **one** term of the list, an `anyOf` or
 * `allOf` whose {@link terms} are the branches (issue #909), so the list itself stays a
 * conjunction and every reader of it that predates grouping is still right about it.
 */
export interface QueryPredicate {
  field: PredicateField;
  op: PredicateOp;
  /** What the reader typed, **canonicalised only where the parser owns a vocabulary**: `c:RG`
   *  and `s:NEO` arrive with their case, and Rust folds it. Rarity is expanded and lower-cased
   *  (`r:c` is sent as `"common"`), every closed vocabulary — `is:`, `game:`, `border:`,
   *  `frame:`, `stamp:`, `has:`, `new:` — is lower-cased, a language name becomes its code, and
   *  a numeric field compared with another (`pow>tou`) carries `"@toughness"`. `""` on the two
   *  groups. */
  value: string;
  /** A leading `-` in the box (or `not:`). Rust reads an absent field as `false`. */
  negated: boolean;
  /** What an `anyOf` or `allOf` combines — sent **only** on those two fields, absent on every
   *  other. Rust reads an absent list as empty (`#[serde(default)]`), and a group with nothing
   *  usable in it adds no clause. */
  terms?: QueryPredicate[];
}

/**
 * The three switches the publish dialog offers — `ShareFieldsArg` on the Rust side.
 *
 * **A struct of three booleans and not a list of names**, deliberately: a list would let the page
 * invent a fourth field by spelling one, where an unknown *key* is simply dropped. There is no
 * default here for the same reason the crate declines to give its own type one — spec §3 lists
 * six columns that are absent from the format rather than switched off in it, so "none ticked"
 * is a share of names, quantities and printings and is a legitimate answer rather than a
 * degenerate one.
 *
 * ⚠️ **Each field is `#[serde(default)]` on the far side, so a misspelling here is not a
 * refusal.** It arrives `false`, the publish succeeds, and the column the reader ticked is
 * missing from every card in the snapshot — which is why `ipc.test.ts` pins all three by name.
 */
/**
 * Which rows of a loaded search to re-read the badges of — mirrors `search::MarksRequest`.
 *
 * `collapse` and `availableForDeck` are the loaded search's own, because they decide the grain
 * and the scope {@link CardSummary.ownedQuantity} was counted at; the ids stand in for every
 * filter, which decided which rows a page holds and nothing about what a row's badge reads.
 */
export interface MarksRequest {
  ids: string[];
  collapse?: boolean;
  availableForDeck?: number;
}

/** One row's badges, re-read — mirrors `search::CardMarks`. */
export interface CardMarks {
  id: string;
  ownedQuantity: number;
  wishlisted: boolean;
}

/** The cards commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const cardCommands = {
  searchCards: (req: SearchRequest) => invoke<SearchResponse>("search_cards", { req }),
  /**
   * The two badges of rows a search already holds, re-read after a write — what
   * `@/lib/searchMarks` patches into the cached pages instead of refetching every one of them
   * (issue #552). An id the corpus no longer holds is left out of the answer.
   */
  searchMarks: (req: MarksRequest) => invoke<CardMarks[]>("search_marks", { req }),
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
   * Every printing in `cardIds` priced per finish at `marketplace`, in one round trip — the
   * scanner tray's read, whose rows are printings no priced list has carried yet.
   *
   * **An id the corpus does not hold is absent from the answer**, not an entry of nulls, and a
   * repeated id answers once; the caller reads a missing entry as unpriced.
   */
  printingPrices: (cardIds: string[], marketplace: MarketplaceId) =>
    invoke<PrintingPrices[]>("printing_prices", { cardIds, marketplace }),
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
   * The TCGplayer product ids for one printing — see {@link TcgplayerIds}.
   *
   * **Two `null`s is the answer and it never rejects**, which is `cardMeldParts`' rule one command
   * over: an unknown id, an unreadable `raw` blob and a row carrying neither field all come back
   * `{ productId: null, etchedProductId: null }`. A press that leaves the app must never fail to
   * do *something*, and the something here is the marketplace's name search — the shape this row
   * opened before the ids existed. `openMarketplaceForCard` owns that fallback.
   *
   * **Resolved on the press rather than with the card**, so it is a command and not a field on
   * {@link CardDetail}: `externalLinks.ts`'s doctrine is that a menu merely *offering* to open a
   * marketplace has visited nothing, and a card opened is a card whose menu was never used far
   * more often than not. One id lookup on a keyed index costs less than carrying two integers
   * through every printing of every wall.
   *
   * **No `marketplace`**, unlike every other card read here — these are TCGplayer's own ids, so
   * the setting decides *whether* this is called at all and never what it answers.
   */
  cardTcgplayerIds: (id: string) => invoke<TcgplayerIds>("card_tcgplayer_ids", { id }),
  /**
   * What the reader holds of one oracle card — see {@link CardHoldings}.
   *
   * **One read where the pane made three.** The card modal's "In your grimoire" block used to
   * fire `collectionList({ oracleId })`, `wishlistList({ oracleId })` and `deckIdsPlaying` on
   * every card open, and summed two pages of rows in the webview to draw two numbers. Rust sums
   * them, through the same three rules those reads use, so a figure here cannot disagree with the
   * list it sits beside.
   *
   * **It answers counts and nothing addressable**, which is the line between this and the reads it
   * replaces: a surface that needs a *row* to write to — the stepper, the wishlist's edit — still
   * asks for the rows. This is for the block that only ever states numbers.
   *
   * **No `marketplace`**, unlike every other card read on this object: these are counts, and
   * nothing about them moves when the setting does. Keying it on the marketplace would refetch a
   * fixed fact on every switch.
   *
   * A blank `oracleId` answers three zeros rather than rejecting — a card with no oracle id is a
   * card nothing can be held *of*, and a pane must not fail to fill a block over it.
   */
  cardHoldings: (oracleId: string) => invoke<CardHoldings>("card_holdings", { oracleId }),
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

  /**
   * The Scryfall CDN URL for one printing at one size, or `null`.
   *
   * A command rather than a field on the list DTOs, and called **on the press** — see
   * `card_image_uri` in the crate. Three ways to `null`, all of them answers: an unknown
   * card, a card with no `image_uris`, and a variant the source lacked.
   */
  cardImageUri: (cardId: string, variant: ImageVariant) =>
    invoke<string | null>("card_image_uri", { cardId, variant }),
};
