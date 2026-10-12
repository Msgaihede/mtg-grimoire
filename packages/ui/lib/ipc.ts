/**
 * The only place the frontend names a Tauri command or an event.
 *
 * Every type here is a hand-written mirror of a `#[serde(rename_all = "camelCase")]`
 * struct in `apps/desktop/src-tauri/src`, so the two can drift silently — a renamed field becomes an
 * `undefined` the compiler is happy with. Rust pins its side in
 * `sync::tests::dto_json_uses_the_camel_case_names_the_frontend_expects`; this side is
 * pinned by `ipc.test.ts` for the argument names, which are the other half of the
 * contract (`invoke` matches them by name, and a typo is a runtime rejection).
 *
 * Sources, verified field by field:
 * `SearchRequest`/`CardSummary`/`SearchResponse`/`SetSummary` — `crates/grimoire-core/src/search.rs`
 * `FacetResponse`                                 — `crates/grimoire-core/src/index/facets.rs`
 * `CardFace`/`CardDetail`/`Printing`/`PrintingsResponse`/
 * `FinishPrices`/`PrintingPrices`/`MeldRelation` — `crates/grimoire-core/src/card.rs`
 * `SyncOutcome`/`SyncStatus`/`Progress`          — `crates/grimoire-core/src/sync.rs`
 * `EntryInput`/`EntryPatch`/`EntryChange`/`CollectionQuery`/`CollectionRow`/
 * `CollectionPage`/`CollectionSummary`/`BreakdownRow` — `crates/grimoire-core/src/collection.rs`
 * `MoveOutcome`                                  — `crates/grimoire-core/src/collection_alloc.rs`
 * `WishInput`/`WishlistQuery`/`WishRow`/`WishlistPage`/
 * `WishlistSummary`                              — `crates/grimoire-core/src/wishlist.rs`
 * `DeckInput`/`DeckPatch`/`DeckViewState`/`DeckRow`/`DeckCardRow`/`DeckDetail`/
 * `FormatSpecRow`/`PipCost`/`DeckPipCosts`/
 * `BracketCardRow`/`DeckBracketRead`/`DeckValue`   — `crates/grimoire-core/src/deck.rs`
 * `ActivityEntry`                                — `crates/grimoire-core/src/activity.rs`
 * `TradeCreate`/`TradeLineInput`/`TradeLineChange`/`TradeFinishOptions`/`TradeLine`/
 * `Trade`/`TradeSummaryLine`/`TradeSummary`/`TradeOutcome` — `crates/grimoire-core/src/trade.rs`
 * `HomeWidget`/`HomeLayout`                      — `crates/grimoire-core/src/home.rs`
 * `StickyNoteRow`                                — `crates/grimoire-core/src/sticky_notes.rs`
 * `CardFilters`, flattened into both list queries — `crates/grimoire-core/src/filters.rs`
 * `MarketplaceFeedStatus`                        — `crates/grimoire-core/src/marketplace_feed.rs`
 * `CardTags`/`PrintingTags`                     — `crates/grimoire-core/src/tags/oracle.rs`
 * `TagStatus`/`TagProgressEvent`                 — `crates/grimoire-core/src/tags/mod.rs`, aliased per
 *                                                  dataset by `tags/oracle.rs`/`tags/art.rs`
 * `TagHit`/`TagRef`                              — `crates/grimoire-core/src/tags/query.rs`
 * `MutedTag`                                     — `crates/grimoire-core/src/tags/muted.rs`
 * `ComboBracketTag`/`DeckCombo`/`ComboStatus`/
 * `ComboProgress`/`ComboPiece`/`CardCombo`/
 * `ComboCountBucket`/`CardCombosPage`            — `crates/grimoire-core/src/combos.rs`
 * `MirrorStatus`                                 — `apps/desktop/src-tauri/src/mirror/settings.rs`
 * `PassReport`                                   — `apps/desktop/src-tauri/src/mirror/run.rs`
 * `TagTerms`                                     — `crates/grimoire-core/src/filters.rs`
 * `PairingStatus`/`PairingOffer`/`PairingHandshake`/`PairingSealedKey`/
 * `PairingProgress`/`QrMatrix`/`PairedDevice`      — `crates/grimoire-core/src/sync_pair/pairing.rs`,
 *                                                  `.../identity.rs`, `.../invite.rs`
 * `DeckFolderPane`                                — `crates/grimoire-core/src/deckpane.rs`
 * `ShareRow`/`ShareFields`                        — `apps/desktop/src-tauri/src/share/commands.rs`
 * `ScannerAsset`/`ScannerStatus`/`ScannerSidecar`/
 * `ScannerCaptured`/`ScannerPrefs`/
 * `ScannerTrayRow`/`ScannerTrayChoice`             — `crates/grimoire-core/src/scanner.rs`
 * `ScannerAssetsOwed`/`ScannerAssetsProgress`      — `crates/grimoire-core/src/scanner_assets.rs`
 * `ScannerSubmission`/`ScannerSubmitted`           — `crates/grimoire-core/src/scanner_submit.rs`
 * `ScannerAssetDue`                                — `crates/grimoire-core/src/downloads.rs`
 * `ScannerOptions`/`ScannerVerdict`/`ScannerFrameSize`/
 * `ScannerStages`/`ScannerStanding`/`ScannerTracked`/
 * `ScannerCollectorTry`/`ScannerCollector`/`ScannerOcr`/
 * `ScannerDecision`                                — `crates/card-scanner/src/session.rs`
 * `ScannerFinishMark`/`ScannerMarkReading`         — `crates/card-scanner/src/ocr.rs`
 * `ScannerChoice`/`ScannerTier`/`ScannerResolution` — `crates/card-scanner/src/resolve.rs`
 * `ScanFilters`                                    — `crates/card-scanner/src/filters.rs`
 * `ScannerLabel`/`ScannerCandidate`/`ScannerMatch`  — `crates/card-scanner/src/reference.rs`
 * `ScannerLock`                                    — `crates/card-scanner/src/lock.rs`
 * `ScannerScore`/`ScannerTimings`                  — `crates/card-scanner/src/detect.rs`
 * `ScannerCardness`                                — `crates/card-scanner/src/cardness.rs`
 * `ScannerTrim`                                    — `crates/card-scanner/src/trim.rs`
 *
 * **The scanner's shapes are the one block here that is _not_ camelCase**, and they are the
 * exception rather than an oversight: the detector crate carries no
 * `#[serde(rename_all = "camelCase")]`, because its JSON was the standalone debug page's before
 * it was this app's and that page reads `decide_at` and `best_distance` by those names. The
 * mirror keeps the Rust spelling verbatim; `ipc.test.ts`'s `snakeMirrors` is the table that
 * compares them with no camel step. **Three of the block are camelCase after all** —
 * `ScannerPrefs`, `ScannerTrayRow` and `ScannerTrayChoice` — because they are this app's stored
 * rows rather than the detector's JSON, and they sit on `plainMirrors` with every other one.
 *
 * **The stored settings are one `app_meta` row each, and most of them carry no struct at all.**
 * (The scanner's two rows, `scanner_prefs` and `scanner_tray`, carry structs; see
 * {@link ScannerPrefs} and {@link ScannerTrayRow}.) Of the settings without one, some answer as a
 * bare string — `getMarketplace`/`setMarketplace` (`crates/grimoire-core/src/marketplace.rs`),
 * `printingGroupBy`/`setPrintingGroupBy` (`crates/grimoire-core/src/card.rs`),
 * `deckSort`/`setDeckSort` (`crates/grimoire-core/src/decksort.rs`) and
 * `startView`/`setStartView` (`crates/grimoire-core/src/startview.rs`) — some as a bare map,
 * `cardZoom`/`setCardZoom` (`crates/grimoire-core/src/zoom.rs`), `listView`/`setListView`
 * (`crates/grimoire-core/src/listview.rs`), `markColors`/`setMarkColor`
 * (`crates/grimoire-core/src/markcolors.rs`) and `searchOpen`/`setSearchOpen`
 * (`crates/grimoire-core/src/searchopen.rs`), and one as a bare `boolean`:
 * `navCollapsed`/`setNavCollapsed` (`crates/grimoire-core/src/nav.rs`). The settings that do carry a struct
 * are `deckFolderPane`, `homeLayout` and `shelfFolds`, below. Every one of them is the shape a
 * stored preference has to have: the read falls back on its default for a row that is missing
 * *or* holds a value this build does not recognise, and only the *write* refuses. **They are
 * named here and never counted**: this paragraph said "eleven" after `shelfFolds` made the rows
 * one more, because a count is a fact a build answers (`grep -rln "app_meta::" apps/desktop/src-tauri/src`)
 * and a prose-only edit turns nothing red.
 *
 * All of those but the boolean are therefore typed loosely here rather than as their unions: the
 * narrowing belongs to the module that owns the vocabulary (`@/lib/marketplace`,
 * `@/features/card/printings`, `@/lib/cardZoom`, `@/lib/store` for its list-layout row,
 * `@/features/decks/deckSort`, `@/lib/useMarkColors`, `@/features/search/useSearchOpen`,
 * `@/features/home` for the start view), and a row a newer build wrote must reach this side as
 * what it is. **The deck sort and the start view are where the *write* refuses nothing but a
 * blank**, and they are the rule above meeting a vocabulary the backend does not have rather than
 * an exception to it: some of the sort keys are computed on this side, so `deck_sort.rs` has no
 * list to check a word against, and which views exist is a
 * fact about this app's router, so `startview.rs` has none either — see {@link ipc.setDeckSort}
 * and {@link ipc.setStartView}. **The one bare boolean left is the one with no narrowing to do**, and that is
 * the same argument arriving at nothing rather than an exception to it: a boolean has no
 * vocabulary for a later build to have widened, so there is no third state a row could come back
 * in. Its far end folds a missing row, a junk row and an unreadable one alike into one
 * default — `false` for the nav rail, which is expanded — and `boolean` here is the whole of the
 * type, with nothing left for this
 * side to decide. It stores `"1"`/`"0"` and reads anything else as that default, so a hand-edit
 * or a spelling a future build invents is already collapsed before it reaches the wire.
 *
 * **There were two of those booleans until 2026-09-07**, and where the second one went says more
 * about the split above than either paragraph does. `deckSearchOpen` was one row for one
 * column; the collection and the wishlist growing the same docked search would have made it
 * three rows, six commands, three query keys and three prefetches for one fact. It is
 * {@link ipc.searchOpen} now, a map keyed by section — so the setting moved out of the boolean
 * paragraph and into the map one without a word of either argument changing.
 *
 * **The folder pane is the first stored preference that carried a struct**: {@link DeckFolderPane}
 * (`crates/grimoire-core/src/deckpane.rs`) is how wide the decks page's folder tree was dragged *and*
 * whether it is folded to its rail, and the two are one row because they are one gesture's worth
 * of state — a reader who folds a tree they had widened must come back to both facts, and two
 * rows would be two writes that can half-land. **A struct rather than a map** for the reason
 * {@link ipc.searchOpen} is a map rather than two rows, arrived at from the other end: the
 * search-column row has one *kind* of value under keys this side invents, and this one has two
 * *different* values under names both sides already know, so a `Record<string, unknown>` here
 * would throw away the only thing worth checking. Being a struct is also what puts it on
 * `ipc.test.ts`' mirror table, where the unstructured settings cannot be — a bare `boolean` has
 * no fields to compare — so it is one of the stored settings whose *shape* cannot drift silently.
 * **`width` is nullable and `collapsed` is not**, which is the same asymmetry the unstructured
 * ones turn on: how wide is a number a reader has to have produced, so a database nobody has
 * dragged has
 * nothing honest to say and says `null`; folded-or-not has a default that is true of every
 * database from the first launch. `@/features/decks/useFolderPane` is where the `null` becomes a
 * pixel count, and `FolderTree` owns that number.
 *
 * **The home layout is the second, and it is a struct for the opposite reason.** {@link HomeLayout}
 * (`crates/grimoire-core/src/home.rs`) is the home page's tiles — their order, their widths and whatever each
 * one remembers — and where the folder pane is a struct because its two *known* fields must land
 * together, this one is a struct because most of what it holds is **unknown to the backend
 * entirely**: `kind` is a word this side invents and `config` is a shape only the widget that
 * wrote it can read. So `markcolors.rs`' third rule is the one that governs it — a write preserves
 * what this build does not understand — and a layout a newer build wrote survives a round trip
 * through an older one rather than being flattened to what that one happens to know. Being a
 * struct puts it on the same mirror table, which is what its two declared fields are worth
 * checking for; nothing on this side can fence the rest, and nothing should try.
 *
 * **The shelf folds are the third, and the struct is the one vocabulary both sides spell.**
 * {@link ShelfFolds} (`crates/grimoire-core/src/shelffolds.rs`, `shelfFolds`/`setShelfFolds`) is which
 * shelves the reader folded away from their default, per page. The *pages* are named on both
 * sides — {@link ShelfFoldPage} here and the Rust struct's fields there, held together by
 * `ipc.test.ts` (and `shelffolds::PAGES` held to those fields by the crate's own test) — and
 * under each page it is the search-column row's shape one level deeper:
 * folder ids this side sends, mapped to plain booleans. Its write follows the rules above — it
 * refuses an unknown page or a key that is not a folder id, keeps a page this build does not
 * know — and a `null` takes an override back off rather than storing the default.
 *
 * The zoom row, the list-layout row, the mark-colour row and the search-column row are the
 * unstructured settings whose *shape* is a map, and the difference is worth a sentence:
 * none has a single default to fall back on, because each covers several walls, lists, search
 * columns or marks, and each one of those has been touched or not. So
 * the backend answers only what it has, and a section it says nothing about keeps the default the
 * store was built with — which for the mark colours is the one `index.css` draws, a default this
 * side does not hold as a value at all.
 * **The search-column row is the one where the keys are a vocabulary and the values are not** —
 * which pages carry a search column is `@/features/search/useSearchOpen`'s to say, while a `bool`
 * has no junk state for a later build to have widened. So the key is narrowed on this side, and the
 * only thing asked of the value is that it really is a boolean — a check on the *wire*, not on a
 * vocabulary: this file's `boolean` is a claim about what the far end sends, and a row that has
 * been hand-edited is exactly where a claim stops being true.
 *
 * **Every price field on this page is singular, and the marketplace is how it was chosen.**
 * A query carries `marketplace`; what it answers with carries one `price` / `unitPrice` /
 * `totalPrice` / `value`, already in that marketplace's money — or, where a *card* rather than
 * a priced list is the answer, one {@link FinishPrices} triple in it. There is no twin field to
 * pick between and no fallback across marketplaces — see `@/lib/marketplace`.
 */

/*
 * ## The domains
 *
 * **This file is the barrel since 2026-10-11 (issue #557); the mirror itself is in `./ipc/`, one
 * file per domain** — cards, collection, wishlist, decks, transfer, home, tags, combos, scanner,
 * share, trade, sync, prefs and the app, with the transport in `./ipc/invoke.ts`. It was one 11,000-line
 * file, three quarters of it comment, and every feature branch edited it.
 *
 * **Everything outside `packages/ui/lib/ipc*` imports `@/lib/ipc`, never a domain file** — that
 * import is the seam every suite mocks (`vi.mock("@/lib/ipc", …)`), and a component reaching
 * past it would go around every mock in the repository. ESLint refuses the deep import.
 * `ipc.test.ts` reads this file and every domain file as one text, so the struct-parity walk and
 * the argument-name checks see the mirror whole, and it fails on a command name two domains both
 * claim — a spread below would otherwise keep the last one silently.
 *
 * **Types wholesale, values by name.** `export type *` re-exports every type a domain declares, so
 * a new interface needs no line here; a value is named, so a domain's commands object never
 * reaches a page except as part of `ipc`. `AUTO_BRACKET` is the one value the domains export.
 */
export { ipcError, type Unlisten } from "./ipc/invoke";
export type * from "./ipc/cards";
export type * from "./ipc/collection";
export type * from "./ipc/wishlist";
export type * from "./ipc/decks";
export type * from "./ipc/transfer";
export type * from "./ipc/home";
export type * from "./ipc/tags";
export type * from "./ipc/combos";
export type * from "./ipc/scanner";
export type * from "./ipc/share";
export type * from "./ipc/trade";
export type * from "./ipc/sync";
export type * from "./ipc/prefs";
export type * from "./ipc/app";
export type * from "./ipc/goldfish";
export { AUTO_BRACKET } from "./ipc/decks";

import { cardCommands } from "./ipc/cards";
import { collectionCommands } from "./ipc/collection";
import { wishlistCommands } from "./ipc/wishlist";
import { deckCommands } from "./ipc/decks";
import { transferCommands } from "./ipc/transfer";
import { homeCommands } from "./ipc/home";
import { tagCommands } from "./ipc/tags";
import { comboCommands } from "./ipc/combos";
import { scannerCommands } from "./ipc/scanner";
import { shareCommands } from "./ipc/share";
import { tradeCommands } from "./ipc/trade";
import { syncCommands } from "./ipc/sync";
import { prefCommands } from "./ipc/prefs";
import { appCommands } from "./ipc/app";
import { goldfishCommands } from "./ipc/goldfish";

/**
 * Every command, as one object — the domains' objects spread together. **The order is not
 * load-bearing**: no two domains may name the same method, and `ipc.test.ts` holds that, so no
 * spread here ever overwrites another.
 */
export const ipc = {
  ...cardCommands,
  ...collectionCommands,
  ...wishlistCommands,
  ...deckCommands,
  ...transferCommands,
  ...homeCommands,
  ...tagCommands,
  ...comboCommands,
  ...scannerCommands,
  ...shareCommands,
  ...tradeCommands,
  ...syncCommands,
  ...prefCommands,
  ...appCommands,
  ...goldfishCommands,
};
