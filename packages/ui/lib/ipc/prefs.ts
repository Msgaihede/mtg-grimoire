/**
 * Stored preferences: the marketplace, zooms, list layouts, mark colours, search columns, deck search widths, shelf folds, hidden stacks, deck sorting and the folder pane, and the start view.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `prefCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { MarketplaceId } from "../marketplace";
import type { ShelfFoldPage, ShelfFolds } from "./collection";
import { invoke } from "./invoke";

/**
 * How the decks page's folder tree was last left — one `app_meta` row, and the only stored
 * preference in this file that carries a struct.
 *
 * Two fields because they are one gesture's worth of state and not two settings that happen to be
 * about the same sidebar: a reader who widens the tree and then folds it has said two things about
 * one column, and a build that stored them in two rows would have two writes that can half-land —
 * a fold remembered against a width that was not, or the reverse. See this file's header for why
 * that makes it a struct rather than {@link searchOpen}'s map.
 *
 * **Neither field is clamped here and neither should be.** The drag's own floor and ceiling are
 * `FolderTree`'s and `useDeskWidth`'s, and they are a fact about the window this row was *not*
 * written in — a narrow session that stored its own squeeze would be a reader's width thrown away
 * by a window they resized once. The crate refuses a width that could never be a width at all and
 * takes every other number as typed; `@/features/decks/useFolderPane` is where it becomes the
 * pixel count the tree is drawn at.
 */
export interface DeckFolderPane {
  /** How wide the reader dragged the folder tree, in px — `null` on a database nobody has dragged. */
  width: number | null;
  /** Whether the tree is folded to its rail. `false` on a database nobody has folded it in. */
  collapsed: boolean;
}

/** The prefs commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const prefCommands = {
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
   * The third `app_meta` setting and the **first** whose shape is a map — see this file's header,
   * and {@link listView} and {@link markColors}, each of which copies the
   * contract below.
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
  setCardZoom: (section: string, zoom: number) => invoke<void>("set_card_zoom", { section, zoom }),
  /**
   * Whether the reader has collapsed the global navigation rail, stored so it opens the way
   * they left it.
   *
   * The **fourth** `app_meta` setting and the first that is a bare `boolean` — see this file's
   * header. It is also the one that needs no narrowing on this side: the other eight carry
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
   * How each list of cards was last left drawn, as section name → `"grid"` or `"table"`.
   *
   * The **sixth** `app_meta` setting and the second whose shape is a map — see this file's
   * header, and {@link cardZoom} beside it, whose contract this copies whole. **A section is
   * absent rather than defaulted**: which layout a page opens on is this side's (`@/lib/store`),
   * so a missing entry means the reader has never switched that list, and the backend does not
   * invent a preference it does not own. A whole unreadable row answers `{}`.
   *
   * Raw `Record<string, string>` rather than `Record<ListSection, SearchView>`, for
   * {@link cardZoom}'s reason: the keys *and* the values are whatever some build of this app
   * wrote, so `isListSection` and `isSearchView` narrow both in `@/lib/store`.
   */
  listView: () => invoke<Record<string, string>>("list_view"),
  /**
   * Remember one list's layout, leaving the other entries in the row alone.
   *
   * Two arguments where its neighbours take one, and Tauri matches by name. Rejects a blank
   * section and a word that is neither `"grid"` nor `"table"`, so `app_meta` cannot collect
   * entries every later read would discard — but *which* sections exist is not checked at the far
   * end, deliberately: the backend owns the two words and this side owns the list of lists.
   *
   * Answers `collection::BUSY` under a running sync, like every other write, and the caller
   * deliberately does not undo the layout when it does — {@link setNavCollapsed}'s trade, for its
   * reason.
   */
  setListView: (section: string, view: string) => invoke<void>("set_list_view", { section, view }),
  /**
   * What colour the reader has each card mark drawn in, as mark name → `#rrggbb`.
   *
   * The **ninth** `app_meta` setting and the fourth whose shape is a map — see this file's
   * header, and {@link listView} beside it, whose contract this copies whole. **A mark is absent
   * rather than defaulted**: what an uncustomised mark is drawn in lives in `index.css`, so a
   * missing entry means the reader has never chosen and the backend does not invent a colour the
   * stylesheet owns. **Infallible by signature** — a whole unreadable row answers `{}`, and a
   * single hand-edited entry costs that one mark its colour and leaves the others standing.
   *
   * `Record<string, string>` and not a keyed record, for {@link listView}'s reason on the key
   * half: which marks are customisable is this side's vocabulary, so `isMarkColorKey` narrows it
   * in `@/lib/useMarkColors`. The **values** are checked at the far end, which is where a hex has
   * a shape worth refusing — the split `markcolors.rs` states as "the frontend owns which marks
   * exist and this crate owns only the shape a colour may have".
   *
   * `app_meta` is not a synced table, so these colours are **this device's** — which is the
   * whole family's rule and not this row's exception.
   */
  markColors: () => invoke<Record<string, string>>("mark_colors"),
  /**
   * Remember one mark's colour — or, with `null`, **forget it**, which is what Reset means.
   *
   * `null` rather than writing the default hex, deliberately: a reader who has never chosen and
   * one who has reset must end in the same state, and a default written into the row would freeze
   * today's palette into the database — the cost `features/decks/labelColors.ts` records for a
   * stored label colour, paid for no reason.
   *
   * Two arguments where most of its neighbours take one, and Tauri matches by name: **`mark` and
   * `color`**, not `key` and `value`. Rejects a blank mark and anything that is not `#rrggbb` —
   * six digits and a hash, with no shorthand, because `markcolors.rs` expects
   * `features/decks/labelColors.ts`' `normalizeLabelColor` to have expanded `#f00` on this side
   * first. So `app_meta` cannot collect entries every later read would discard. Uppercase is
   * accepted and stored folded, so one colour has one spelling in the row.
   *
   * **Unlike its neighbours a refusal here is worth surfacing.** {@link setNavCollapsed} and
   * {@link setListView} swallow a BUSY because the reader cannot see what was lost until the next
   * launch; here they are standing in front of a swatch, so the panel says the write did not land
   * rather than leaving them to discover it at the next launch.
   */
  setMarkColor: (mark: string, color: string | null) =>
    invoke<void>("set_mark_color", { mark, color }),
  /**
   * Whether each of the app's docked card-search columns was last left open, as section name →
   * open.
   *
   * It stands exactly where `deckSearchOpen` stood, having replaced it on 2026-09-07, and its
   * shape is a map. See this file's header,
   * and {@link listView}, whose contract this copies with a `boolean` where the word is.
   * **A section is absent rather than defaulted**: which pages have a search column at all is
   * this side's (`@/features/search/useSearchOpen`), so a missing entry means the reader has
   * never touched that disclosure and the backend does not invent a preference it does not own.
   * **Infallible by signature** — a whole unreadable row answers `{}`, which is every column
   * drawn the way `DEFAULT_SEARCH_OPEN` says.
   *
   * **What it replaced was a bare `boolean` for the deck editor alone**, and the swap is the
   * header's paragraph in one line: one row, one command pair and one query key now answer for
   * three columns. The deck's old `deck_search_open` row is carried across by `searchopen.rs`'s
   * *read* rather than by a schema rung, so nothing on this side has ever heard of it.
   *
   * `Record<string, boolean>` and not `Record<SearchSection, boolean>`, for {@link listView}'s
   * reason on the key half only: the keys are whatever some build of this app wrote, so
   * `useSearchOpen` narrows them. The **values** have no vocabulary to narrow, which is why the
   * type says `boolean` — and that hook still checks it, because the word is a promise about
   * the far end rather than a fact about the row.
   */
  searchOpen: () => invoke<Record<string, boolean>>("search_open"),
  /**
   * Remember one column's disclosure, leaving the other entries in the row alone.
   *
   * Two arguments where some of its neighbours take one, and Tauri matches by name. Rejects a
   * blank section and nothing else: a `bool` off the IPC boundary has no junk state for a
   * validation to catch, so unlike {@link setListView} there is no word to refuse —
   * {@link setNavCollapsed}'s asymmetry, on a row whose *keys* belong to this side.
   *
   * Answers `collection::BUSY` under a running sync, like every other write, and the caller
   * deliberately does not put the column back when it does — {@link setNavCollapsed}'s trade,
   * for its reason: a refusal costs the reader nothing they can see this session and only the
   * next launch's starting state for that column.
   */
  setSearchOpen: (section: string, open: boolean) =>
    invoke<void>("set_search_open", { section, open }),
  /**
   * The folded-shelf overrides on both pages. {@link searchOpen}'s contract one level deeper:
   * **infallible by signature** — an unreadable row answers both pages empty, which is every
   * shelf at its default.
   */
  shelfFolds: () => invoke<ShelfFolds>("shelf_folds"),
  /**
   * Set (`true`/`false`) or remove (`null`) overrides on one page, leaving every other entry
   * alone. Refuses a page with no shelves and a key that is not a folder id; answers
   * `collection::BUSY` under a running sync, which the caller swallows — {@link setSearchOpen}'s
   * trade.
   */
  setShelfFolds: (page: ShelfFoldPage, changes: Record<string, boolean | null>) =>
    invoke<void>("set_shelf_folds", { page, changes }),
  /**
   * The category ids of the stacks the reader hid in one deck's Stacks view, ascending (issue
   * #618). {@link shelfFolds}' contract keyed by deck: **infallible by signature** — an
   * unreadable row answers `[]`, which is every stack drawn. `app_meta` is not synced, so a stack
   * hidden here is this device's alone, which was the reader's call.
   *
   * **A stale id is answered, not pruned**: a pile deleted since stays in the list until it is
   * shown again, and the editor ignores an id no pile of the deck carries.
   */
  hiddenStacks: (deckId: number) => invoke<number[]>("hidden_stacks", { deckId }),
  /**
   * Hide or show one stack, leaving every other stack and deck alone. Refuses an id that is not
   * positive; answers `collection::BUSY` under a running sync, which the caller swallows —
   * {@link setShelfFolds}' trade: the stack stays as the reader left it for this session.
   */
  setStackHidden: (deckId: number, categoryId: number, hidden: boolean) =>
    invoke<void>("set_stack_hidden", { deckId, categoryId, hidden }),
  /**
   * How wide the reader last dragged one deck's card search column, in px — or `null` for a deck
   * nobody has dragged (issue #932). {@link hiddenStacks}' contract keyed by deck: **infallible by
   * signature**, so an unreadable entry answers `null` and the column opens at its default.
   * `app_meta` is not synced, so the width is this device's alone.
   */
  deckSearchWidth: (deckId: number) => invoke<number | null>("deck_search_width", { deckId }),
  /**
   * Remember one deck's card search column width. Refuses an id that is not positive and a width
   * outside the crate's storage band (`searchwidth::MIN_SEARCH_WIDTH..=MAX_SEARCH_WIDTH`), and
   * answers `collection::BUSY` under a running sync — all swallowed by the caller, which keeps the
   * reader's width for this session either way.
   */
  setDeckSearchWidth: (deckId: number, width: number) =>
    invoke<void>("set_deck_search_width", { deckId, width }),
  /**
   * How the decks page's folder tree was last left — how wide the reader dragged it, and whether
   * it is folded to its rail.
   *
   * The **tenth** `app_meta` setting and the **first that carries a struct** — see this file's
   * header, and {@link DeckFolderPane} for why the two facts are one row. **Infallible by
   * signature**, which is {@link navCollapsed}'s contract and for its reason: the decks page reads
   * this while it is drawing, and there is nothing it could do with an error that is not just
   * "draw the tree at its default width" — so the far end answers that instead of making this side
   * spell it out. A missing row, a row this build cannot parse and a row that cannot be read at
   * all are all `{ width: null, collapsed: false }`.
   *
   * **`width` reaches this side as `number | null` and is deliberately not defaulted at the far
   * end.** `null` is *the reader has never dragged this*, which the crate can say honestly and a
   * number would be it inventing a pixel count for a column it does not draw —
   * {@link markColors}' split, where what an uncustomised mark looks like belongs to the
   * stylesheet. `@/features/decks/useFolderPane` turns the `null` into
   * `DEFAULT_FOLDER_TREE_WIDTH_PX`, which is `FolderTree`'s number.
   */
  deckFolderPane: () => invoke<DeckFolderPane>("deck_folder_pane"),
  /**
   * Remember the tree's width and its fold, together.
   *
   * Two arguments where its neighbours in this family take one or two, and Tauri matches by name:
   * **`width` and `collapsed`**. Both are sent on every write because the row is one struct — a
   * caller that only means to change the fold still has to say what the width is, which is what
   * makes the pending-write race in `@/features/decks/useFolderPane` a race worth solving there
   * rather than a shape to be fixed here.
   *
   * **`width` is a `number` and never `null` on this side of the wire**, though the read answers
   * `null` — the asymmetry {@link setMarkColor} has in the other direction. There is no "leave it
   * as it was": once a reader has dragged or folded anything, this app knows a width and says it,
   * and the hook supplies `DEFAULT_FOLDER_TREE_WIDTH_PX` for the fold that arrives before any
   * drag. What that costs is one thing and it is worth naming: a reader who folds a tree they have
   * never resized freezes *today's* default into their database, so a later build that picks a
   * different default will not reach them — `features/decks/labelColors.ts`' cost, paid here
   * because a nullable argument would be a second way to spell "unchanged" that only one of the
   * two fields could use.
   *
   * **The only refusal is a width that could never be a width** — the crate bounds the number so
   * `app_meta` cannot collect a row every later read would discard, and it does not check it
   * against the *window*, deliberately: what fits is a fact about a desk this crate never
   * measures, and a clamp here would make one narrow session permanent. That is
   * `CardSearchPanel`'s clamp split stated one level down.
   *
   * Answers `collection::BUSY` under a running sync, like every other write, and **a refusal here
   * is deliberately not surfaced** — {@link setNavCollapsed}'s trade, for its reason: the reader is
   * looking at the width they just dragged, it stays where they put it for this session, and what
   * a BUSY costs is only the next launch's starting width for that tree.
   */
  setDeckFolderPane: (width: number, collapsed: boolean) =>
    invoke<void>("set_deck_folder_pane", { width, collapsed }),
  /**
   * How the deck gallery was last ordered — one `app_meta` row holding `"<key>:<direction>"`,
   * e.g. `"updated:desc"`.
   *
   * The **eighth** `app_meta` setting and the third answered as a bare string — see this file's
   * header. **Its value is opaque to Rust on purpose, and that is the strongest version of
   * {@link printingGroupBy}'s split rather than an exception to it**: the sort keys are
   * `features/decks/deckSort.ts`' vocabulary — `updated`, `name`, `colors`, `bracket`, `cards`,
   * `format` — and three of those six are *computed on this side* (a deck's colours come from
   * `deck_pip_costs` through `countPips`, its bracket from `estimateBracket`), so there is no
   * list in the backend to check a word against and inventing one would be a second opinion
   * about a table the webview owns.
   *
   * So the narrowing is entirely this side's, and it has to be: a database outlives the app, and
   * a key a *future* build stops offering must degrade to the default rather than leaving the
   * gallery ordered by something nothing can draw. The backend answers its default
   * (`decksort::DEFAULT`, `"updated:desc"` — the same words `deckSort.ts` spells, because the two
   * halves cannot share a constant across a wire) for a row that is missing, unreadable **or
   * blank**, and hands anything else back verbatim. So a key a newer build wrote reaches this
   * side as itself, and a word *this* build does not know becomes the default order here.
   *
   * **Only the sort is remembered, and no filter is.** A filter is a thing a reader is doing
   * right now; a gallery that opened already narrowed, with no memory of having asked for it, is
   * a gallery that looks like it has lost decks.
   */
  deckSort: () => invoke<string>("deck_sort"),
  /**
   * Remember the gallery's order.
   *
   * **One refusal and it is a blank**, where {@link setPrintingGroupBy} refuses every word it
   * does not know. That is not leniency: the value has a vocabulary and the *backend does not
   * have it*, so any wider refusal could only be the backend guessing about a list this side
   * owns. A blank is refusable without a vocabulary — it is an order in nobody's — and it is
   * the one value the read discards, so storing it would be a write that reported success and
   * read back as the default for ever. Everything else survives the round trip, which is what
   * makes the *read* the thing that protects the reader: an unrecognised key degrades to the
   * default order here and costs them their ordering, never the gallery.
   *
   * **The argument is `sort`, not `value`** — `invoke` fills parameters by name and
   * `decksort::set_deck_sort` calls its one parameter `sort`, so a mismatch is a rejection at
   * run time with nothing red in either build. `ipc.test.ts` pins it, which is what that half
   * of the mirror is for.
   *
   * Answers `collection::BUSY` under a running sync like every other write, and the caller
   * deliberately does not put the picker back when it does — {@link setNavCollapsed}'s trade,
   * for its reason: a refusal costs the next launch's starting order and nothing this session.
   */
  setDeckSort: (sort: string) => invoke<void>("set_deck_sort", { sort }),

  /**
   * Which view the app opens on, as a stored word — `"home"` for a database nobody has changed.
   *
   * The **twelfth** `app_meta` setting and the fourth answered as a bare string. It is
   * {@link ipc.deckSort}'s split exactly, and for the sharper version of that reason: **the
   * vocabulary of views is TypeScript's** and `startview.rs` has no list to check a word against,
   * because which pages exist is a fact about this app's router. So the backend hands back
   * whatever was stored and this side narrows it — a word a *newer* build wrote reaches an older
   * one as itself and degrades to the default here, where a Rust-side allow-list would have
   * stranded the reader on a page that no longer exists.
   */
  startView: () => invoke<string>("start_view"),
  /**
   * Remember it. **One refusal and it is a blank** — {@link ipc.setDeckSort}'s trade, for its
   * reason: a blank is refusable without a vocabulary, and it is the one value the read discards,
   * so storing it would be a write that reported success and read back as `home` for ever. The
   * word is trimmed on the way in. Answers `collection::BUSY` under a running sync.
   */
  setStartView: (view: string) => invoke<void>("set_start_view", { view }),
};
