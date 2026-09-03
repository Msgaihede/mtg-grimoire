import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const syncStatus = vi.hoisted(() => vi.fn());
const searchCards = vi.hoisted(() => vi.fn());
const cardDetail = vi.hoisted(() => vi.fn());
const cardPrintings = vi.hoisted(() => vi.fn());
const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
const wishlistList = vi.hoisted(() => vi.fn());
const deckList = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
// The shell's title bar is the one part of it that does not go through `@/lib/ipc`: it reads
// the window itself, through `@/lib/window`. Pointed at the workbench's fakes rather than
// stubbed by hand, so this file and Storybook agree about what a window does. Left off, the
// real `@tauri-apps/api` reaches for `window.__TAURI_INTERNALS__`, which jsdom does not have —
// and because both calls are in a mount effect the rejection is unhandled rather than caught,
// so **every test in this file still passes** while the run prints hundreds of errors.
vi.mock("@tauri-apps/api/window", () => import("../.storybook/fake/window"));
vi.mock("@tauri-apps/api/event", () => import("../.storybook/fake/event"));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncStatus,
    syncRun: vi.fn(),
    // The shell mounts `useCardZoomPersistence`, which reads this row once as it launches and
    // writes back after a gesture. Mocked rather than left off for the event subscriptions'
    // reason: a `.catch` cannot catch the synchronous TypeError of calling `undefined`. An
    // empty row is a database nobody has zoomed, so every wall opens at its default.
    cardZoom: vi.fn().mockResolvedValue({}),
    // `useListViewPersistence`' launch read, beside the zoom's — `{}` leaves every list on
    // its own default.
    listView: vi.fn().mockResolvedValue({}),
    setListView: vi.fn().mockResolvedValue(undefined),
    setCardZoom: vi.fn().mockResolvedValue(undefined),
    // `useFlattenPersistence`' pair, the third row the shell reads on the way up — the two
    // cabinets' Flatten switches. Mocked for `cardZoom`'s reason exactly: the read is a bare
    // `void ipc.flattenState().then(…).catch(…)` inside a mount effect, and a `.catch` cannot
    // catch the synchronous `TypeError` of calling `undefined`. Leaving it off failed **every**
    // test in this file with `ipc.flattenState is not a function`, thrown out of the effect
    // where nothing here could reach it. `{}` is a database nobody has pressed the switch in,
    // so `hydrateFlatten` seeds nothing and both pages open on `store.ts`'s own defaults — the
    // collection flattened, the wishlist not — which is what a fresh install draws.
    flattenState: vi.fn().mockResolvedValue({}),
    setFlattenState: vi.fn().mockResolvedValue(undefined),
    // The deck editor's search column reads which way it was last left, and writes on every
    // press. Mocked rather than left off for `cardZoom`'s reason one row up — the read is a
    // query and would merely fail, but a *press* calls the setter straight out of a click
    // handler, where `undefined` is a synchronous TypeError nothing catches. `true` is the
    // shipped default, so the column is drawn open exactly as a fresh install draws it.
    deckSearchOpen: vi.fn().mockResolvedValue(true),
    setDeckSearchOpen: vi.fn().mockResolvedValue(undefined),
    // And the sidebar's own width, read once on the way up for the same reason. `false` is a
    // database nobody has collapsed the rail in, so every test here gets the six named entries
    // it has always queried by name.
    navCollapsed: vi.fn().mockResolvedValue(false),
    setNavCollapsed: vi.fn().mockResolvedValue(undefined),
    onSyncProgress: vi.fn().mockReturnValue(() => {}),
    // The shell listens for the reconcile event too, and a `.catch` cannot catch the
    // synchronous `TypeError` of calling `undefined`.
    onCollectionReconciled: vi.fn().mockReturnValue(() => {}),
    // And for a price feed's progress, which is the third event this window subscribes to —
    // the backend refreshes the selected feed at start-up, so a window that was not listening
    // would show a fetch nobody could see. Same reason it must be mocked rather than left off.
    onMarketplaceProgress: vi.fn().mockReturnValue(() => {}),
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
    // And for the Oracle tag taxonomy's progress, which is the **fourth** event this window
    // subscribes to — the backend refreshes the taxonomy at start-up for the same reason it
    // refreshes a feed, so the window has to be listening. Same failure mode as the three
    // above and it is not a hypothetical: leaving this off failed all 18 tests in this file
    // with `ipc.onOracleTagProgress is not a function`, thrown synchronously inside the
    // shell's mount effect where no `.catch` can reach it.
    onOracleTagProgress: vi.fn().mockReturnValue(() => {}),
    // Task 10's and Task 11's four — the shell now mounts `useDeviceSyncInvalidation` and
    // `useDeviceSyncLive` beside the subscriptions above, and its Android foreground effect
    // calls `syncLiveForeground`. Same failure mode as every listener above: a bare call inside
    // a mount effect, so a `vi.fn()` that is not there is a synchronous `TypeError` rather than
    // a rejection anything can catch. `"off"` is the resting state every installation that has
    // paired nothing is in, which is every fixture in this file.
    onSyncApplied: vi.fn().mockReturnValue(() => {}),
    onSyncLive: vi.fn().mockReturnValue(() => {}),
    syncLiveState: vi.fn().mockResolvedValue("off"),
    syncLiveForeground: vi.fn().mockResolvedValue(undefined),
    // The honest never-ingested row: every field null, so nothing in this file's cards is
    // filed by tag and the routing these tests are about is what they measure.
    oracleTagsStatus: vi.fn().mockResolvedValue({
      updatedAt: null,
      ingestedAt: null,
      checkedAt: null,
      tagCount: null,
      taggingCount: null,
      stale: true,
      refreshing: false,
    }),
    oracleTagsForPrintings: vi.fn().mockResolvedValue([]),
    // The Tags view's three reads. Routing to it fires all of them on the way up, so an
    // unmocked one is a rejected query rather than a compile error — and `art_tags_status`
    // answers the honest never-ingested row for the reason `oracleTagsStatus` above does.
    artTagsStatus: vi.fn().mockResolvedValue({
      updatedAt: null,
      ingestedAt: null,
      checkedAt: null,
      tagCount: null,
      taggingCount: null,
      stale: true,
      refreshing: false,
    }),
    tagChildren: vi.fn().mockResolvedValue([]),
    tagSearch: vi.fn().mockResolvedValue([]),
    // The Tags page subscribes to the art taxonomy's progress channel so a finished ingest takes
    // its notice down without a reload. Mocked for `onSyncProgress`'s reason: the registration is
    // a bare call inside a mount effect, so a `vi.fn()` that is not there is a synchronous
    // `TypeError` rather than a rejection anything can catch.
    onArtTagProgress: vi.fn().mockReturnValue(() => {}),
    // Settings' combo panel, mocked for exactly the reasons its two neighbours above are.
    // `combosStatus` answers the honest never-ingested row — `fetchedAt: null` is the state a
    // fresh install is in, and it is the one this file wants, because the panel then draws its
    // standing copy and no figures at all. `onCombosProgress` is a bare call inside a mount
    // effect, so an absent mock is a synchronous `TypeError` that no `.catch` can reach.
    combosStatus: vi.fn().mockResolvedValue({
      combos: 0,
      cards: 0,
      stamp: null,
      fetchedAt: null,
      checkedAt: null,
      stale: true,
    }),
    onCombosProgress: vi.fn().mockReturnValue(() => {}),
    // The search view is live now, so opening on it fires a real query; an unresolved
    // mock would surface here as a query error rather than as the routing this file tests.
    searchCards,
    // The filter row asks for its facet counts on the way up, beside the page. Answered
    // **cold** — `ready: false`, every map empty — which is the state in which nothing greys
    // and every control keeps the plain name this file queries by.
    facetCards: vi.fn().mockResolvedValue({
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    }),
    listSets: vi.fn().mockResolvedValue([]),
    // The grid warms the images of every page that lands, so routing to the search view
    // calls this on the way up.
    prefetchImages: vi.fn().mockResolvedValue(undefined),
    cardDetail,
    cardPrintings,
    // **The card modal's own reads, and they are new to this file with it.** The docked pane
    // asked for a card, its printings and (inside a deck) that deck; the modal also draws the
    // grimoire counts, the deck census behind them and the `Add to deck` picker's gallery — so
    // four more commands are reached the moment a card is opened. They are queries rather than
    // mount-effect calls, so an absent mock is a failing, retrying query rather than a throw,
    // which is exactly the shape of miss that leaves a suite green and slow.
    collectionFolderList: vi.fn().mockResolvedValue([]),
    wishlistFolderList: vi.fn().mockResolvedValue([]),
    deckFolderList: vi.fn().mockResolvedValue([]),
    deckIdsPlaying: vi.fn().mockResolvedValue([]),
    // The collection view is live too, and asks two questions on the way up: its rows, and
    // what they add up to.
    collectionList,
    collectionSummary,
    // And warms the art for everything it holds, on the first load that has rows. Mocked
    // even where the fixture is empty: the call site is `void ipc.prewarmCollection()
    // .catch(…)`, and a `.catch` cannot catch the synchronous `TypeError` of calling
    // `undefined` — so a fixture that later gains a row would fail inside an effect rather
    // than at the assertion.
    prewarmCollection: vi.fn().mockResolvedValue(0),
    // And so is the wishlist, which asks one question on the way up.
    wishlistList,
    // The deck gallery is the fourth live view. It reads its wall, and the create form
    // behind it reads the seeded format table — mocked here too, because a `vi.fn()` that
    // is not there is a synchronous `TypeError` inside a query rather than a rejection.
    deckList,
    // And the editor the gallery opens onto, which is the same view with a deck picked.
    deckGet,
    // The one deck write with no control in the editor: it is pressed on a tile of the printings
    // modal, which is a *different component* mounted at `App` level, and this file is where the
    // two meet. (It was the card pane's printings rows until 2026-09-03; the pane is gone and the
    // swap did not move — `AllPrintingsDialog` has always been its other host.)
    deckSwapPrinting,
    formatSpecs: vi.fn().mockResolvedValue([]),
    // And the format a new deck starts on, which the gallery resolves on the way up —
    // `DecksPage` mounts `useNewDeckFormat`, so this is read on every route into Decks whether
    // or not anybody presses New deck. `null` is the honest answer for a database no deck has
    // ever been created in.
    //
    // **Left off, this one fails quietly rather than loudly**, which is why it is worth a
    // comment of its own: the call sits inside a react-query `queryFn`, so the synchronous
    // `TypeError` of calling `undefined` is caught and turned into a failing, retrying query
    // instead of escaping a mount effect the way the listeners above would — and
    // `newDeckFormat` answers Commander for a read that has not landed, so the dialog draws
    // exactly what it draws when the read succeeds. Nothing would go red; the file would just
    // run every test down a retry path.
    deckLastFormat: vi.fn().mockResolvedValue(null),
    // `App` owns the update state for the ribbon's button and the Settings panel both, so
    // every test in this file mounts it. Both are mocked for `onSyncProgress`'s reason: the
    // listener registration is a bare call, and a `vi.fn()` that is not there is a
    // synchronous `TypeError` inside an effect rather than a rejection anything can catch.
    updateStatus: vi.fn().mockResolvedValue({
      currentVersion: "0.2.0",
      installKind: "portable",
      available: null,
      asset: null,
      lastCheckAt: "1800000000",
      busy: false,
      staged: false,
    }),
    onUpdateProgress: vi.fn().mockReturnValue(() => {}),
  },
}));

import App from "./App";
import { DECK_CARD_VARIANT } from "@/features/decks/cardControl";
import { card } from "@/features/decks/validation/fixtures";
import type {
  CardDetail,
  CardSummary,
  CollectionRow,
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckRow,
  Printing,
  WishRow,
} from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { useAppStore } from "@/lib/store";

/** One deck on the wall, for the trip into its editor and back. */
const BURN: DeckRow = {
  gameKey: "any",
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  // With a cover, so the tile's accessible name starts with the deck's name: the empty frame
  // says "No cover" *inside* the button, and that would be the first thing read on it.
  coverCardId: "0000419b-0bba-4488-8f7a-6194544ce91d",
  coverArtist: "Rebecca Guay",
  archived: false,
  cardCount: 0,
  updatedAt: 1_800_000_000,
  // The four v8 deck columns, the three v12 view-state ones and `separateXGroup` from v13.
  // Every real row carries all eight, so the fixture does too.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
  // How the editor was last read. These three are the defaults — a deck nobody has pressed a
  // tab, a `Group by` or a `Sort` on.
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
  bracket: 0,
};

const BOLT: CardSummary = {
  promoTypes: null,
  id: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  price: 400.5,
  layout: "normal",
  oracleId: "o1",
  finishes: '["nonfoil"]',
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
  gameChanger: false,
};

/**
 * The one category this deck has, and therefore the one column the editor draws.
 *
 * `1` / `"Main deck"` is what `validation/fixtures`' `card()` files a `main` row under, and the
 * editor's columns **are** `deck_get`'s `categories` list — a detail that answered cards under a
 * category it did not list would draw a deck with no columns at all. Its name is also the word
 * the card pane's swap offers read back ("… in Main deck"), because a `PaneDeckContext` carries
 * the category's name alongside its id.
 */
const MAIN: DeckCategory = {
  id: 1,
  deckId: 4,
  name: "Main deck",
  kind: "main",
  // `user`, and load-bearing for the sentence above: this is the *one* column these tests
  // expect, and an `auto` pile holding no cards draws no heading at all.
  origin: "user",
  isActive: true,
  sortOrder: 0,
  cardCount: 0,
  totalPrice: null,
  cardCountAllVariants: 0,
};

/** One `deck_get` answer: this deck, the rows asked for, and the categories the editor draws
 *  them in. The counts on the category are not read by anything here — the column heading
 *  totals the rows it was handed. */
const detail = (cards: DeckCard[]): DeckDetail => ({
  deck: BURN,
  cards,
  categories: [MAIN],
  labels: [],
});

/**
 * The same card as a row of the deck, and as the two printings the pane lists for it — the
 * fixtures the printing swap needs, which is the one flow that spans both views.
 *
 * `cardId` is the search fixture's `c1`, so the deck row, the pane's card and the first
 * printing are all one printing, as they are when a reader clicks a card in a deck.
 */
const DECK_BOLT: DeckCard = card({ name: "Lightning Bolt", cardId: "c1", quantity: 1 });
/** What the deck holds after the swap: the same row, on the other printing. */
const SWAPPED_BOLT: DeckCard = card({
  name: "Lightning Bolt",
  cardId: "c2",
  setCode: "m10",
  collectorNumber: "146",
  quantity: 1,
});

const ALPHA: Printing = {
  promoTypes: null,
  id: "c1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  releasedAt: "1993-08-05",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  // Priced by the backend at the marketplace the read named — nonfoil only, because that is
  // the one finish Alpha exists in.
  finishPrices: { nonfoil: 400.5, foil: null, etched: null },
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
};

const M10: Printing = {
  ...ALPHA,
  id: "c2",
  setCode: "m10",
  setName: "Magic 2010",
  collectorNumber: "146",
  releasedAt: "2009-07-17",
  finishPrices: { nonfoil: 1.5, foil: null, etched: null },
};

/** The same card as a collection row, for the Escape-from-a-stepper test below. */
const BOLT_ENTRY: CollectionRow = {
  promoTypes: null,
  legalities: null,
  // At the root, which is where a copy nobody has filed lives (schema v24).
  folderId: null,
  folderName: null,
  id: 7,
  cardId: "c1",
  name: "Lightning Bolt",
  oracleId: "o1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  layout: "normal",
  finish: "nonfoil",
  condition: "NM",
  quantity: 2,
  tradelistQuantity: 0,
  unitPrice: 400.5,
  purchasePrice: null,
  purchaseCurrency: null,
  acquiredAt: null,
  acquisitionSource: null,
  serialNumber: null,
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  tags: "[]",
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/** And as a wish — **pinned to a printing**, because an any-printing wish opens no pane and
 *  a row that cannot open the card cannot test what Escape does to one. */
const BOLT_WISH: WishRow = {
  legalities: null,
  id: 11,
  oracleId: "o1",
  cardId: "c1",
  // The root, and nothing else on this page cares which: `App`'s suite is about the shell around
  // the wishlist rather than about the cabinet inside it.
  folderId: null,
  elsewhere: 0,
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  artCardId: "c1",
  quantity: 2,
  preferredFinish: null,
  unitPrice: 400.5,
  ownedQuantity: 0,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

const BOLT_DETAIL: CardDetail = {
  promoTypes: null,
  id: "c1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: '{"modern":"legal"}',
  finishPrices: { nonfoil: 400.5, foil: null, etched: null },
  finishes: '["nonfoil"]',
  imageStatus: "highres_scan",
  faces: [],
};

/**
 * The other printing as the pane's own card — what a `card_detail` read for `c2` answers.
 *
 * **Which row is `current` is a fact the DOM now depends on.** A printings row draws the printing
 * the pane is already showing without a press — pressing where you are is nothing, in a deck or
 * out of one — so that row has no button at all, and every other row's button says what pressing
 * it does. A mock that answered `c1` for every id would leave the pane showing M10 with the LEA
 * row still drawn as the one in front of the reader, and the swap tests below reading a list no
 * running window produces.
 */
const M10_DETAIL: CardDetail = {
  ...BOLT_DETAIL,
  id: "c2",
  setCode: "m10",
  setName: "Magic 2010",
  collectorNumber: "146",
  releasedAt: "2009-07-17",
  finishPrices: { nonfoil: 1.5, foil: null, etched: null },
};

/**
 * jsdom lays nothing out, so the virtualised card wall measures a container of zero and
 * renders no tiles at all — and a test about opening a card needs a card to click.
 * `@tanstack/react-virtual` sizes its scroller with `offsetHeight` and scrolls it with
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  // `App` renders the app's own module-level client, whose `staleTime` is 30 s — so without
  // this, one test's answer is served to the next from cache and a fixture changed inside a
  // test is never asked for. Order-independence, at the price of one line.
  queryClient.clear();
  useAppStore.setState(useAppStore.getInitialState());
  searchCards.mockReset().mockResolvedValue({ items: [BOLT], total: 1, totalIsCapped: false });
  // Answered per id rather than one card for every read — see {@link M10_DETAIL} for why the
  // difference reaches the DOM now that a printings row is its own press.
  cardDetail
    .mockReset()
    .mockImplementation((id: string) => Promise.resolve(id === "c2" ? M10_DETAIL : BOLT_DETAIL));
  cardPrintings.mockReset().mockResolvedValue({ items: [], total: 0 });
  collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
  wishlistList.mockReset().mockResolvedValue({ items: [], total: 0 });
  deckList.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue(detail([]));
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 1 });
  collectionSummary.mockReset().mockResolvedValue({
    totalCards: 3,
    uniqueCards: 2,
    entries: 2,
    tradelistCards: 0,
    value: 801,
    unpriced: 0,
    needsReview: 0,
  });
  syncStatus.mockReset().mockResolvedValue({
    cardCount: 116_568,
    lastCheckAt: "1800000000",
    bulkUpdatedAt: "2026-08-03T21:16:27.869+00:00",
    lastError: null,
    dataDir: "D:\\app\\data",
    syncing: false,
  });
});

it("opens on the search view", async () => {
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Card search", level: 2 })).toBeInTheDocument();
});

it("swaps the main pane when a sidebar entry is picked", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Settings" }));

  // The ribbon's `h1` is the only place the view is named — the placeholder used to
  // repeat it as an `h2`, which was a second heading saying the same word.
  expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
  expect(screen.getByText(/coming in a later plan/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Card search" })).not.toBeInTheDocument();
});

/** The fourth live view, and the first of the deckbuilder. */
it("opens the deck gallery on the decks entry", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  expect(await screen.findByRole("button", { name: "New deck" })).toBeInTheDocument();
  expect(screen.getByText("No decks")).toBeInTheDocument();
  expect(screen.queryByText(/coming in a later plan/i)).not.toBeInTheDocument();
});

/**
 * The other half of the Decks view, and the whole wire between them: a tile writes an id to
 * the store, the app swaps the gallery for the editor on it, and the editor asks the backend
 * for that deck. The way back is the one thing neither component's own tests can see — the
 * tile that opened the editor **unmounts** while it is up, so without the store's note the
 * caret would land on `<body>` and the next Tab would restart from the top of the app.
 */
it("opens the editor on the deck a tile was picked from, and comes back to that tile", async () => {
  deckList.mockResolvedValue([BURN]);
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));

  expect(await screen.findByLabelText("Deck name")).toHaveValue("Burn");
  expect(deckGet).toHaveBeenCalledWith(4, "live", "tcgplayer");

  await userEvent.click(screen.getByRole("button", { name: /back to decks/i }));

  const tile = await screen.findByRole("button", { name: /^Burn/ });
  await waitFor(() => expect(tile).toHaveFocus());
});

/**
 * Issue #162: the reader mid-build who ducks over to the Collection to check whether they own a
 * card comes back to their deck, not to the wall of tiles.
 *
 * `store.test.ts` owns the state machine; what only this file can see is that the *editor* is
 * what the app draws afterwards — `ActiveView` picks the branch, `DeckEditor` is keyed on the id
 * and asks the backend for that deck again, and the gallery's caret note does not fire into a
 * view that has no tiles in it.
 */
it("comes back to the open deck when the reader returns from another view", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValue(detail([DECK_BOLT]));
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  expect(await screen.findByLabelText("Deck name")).toHaveValue("Burn");

  // Through the sidebar, by name, because the editor draws a `Collection` of its own: the docked
  // panel's second tab. Both are buttons reading that one word, and an unscoped query finds two.
  const sidebar = within(screen.getByRole("navigation", { name: "Views" }));
  await userEvent.click(sidebar.getByRole("button", { name: "Collection" }));
  expect(await screen.findByText("$801.00")).toBeInTheDocument();
  // Gone, rather than merely covered: the editor unmounts, which is what makes coming back a
  // question about the store rather than about a hidden element.
  expect(screen.queryByLabelText("Deck name")).not.toBeInTheDocument();

  await userEvent.click(sidebar.getByRole("button", { name: "Decks" }));

  expect(await screen.findByLabelText("Deck name")).toHaveValue("Burn");
  expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New deck" })).not.toBeInTheDocument();
});

/**
 * And the way back to the wall, which is the half a reader would lose if the return above were
 * unconditional: pressing Decks while already in an editor closes it. Two presses from the
 * Collection therefore reach the gallery — the first hands the deck back, the second puts it
 * down.
 */
it("closes the deck when Decks is picked from inside the editor", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValue(detail([DECK_BOLT]));
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  expect(await screen.findByLabelText("Deck name")).toHaveValue("Burn");

  const sidebar = within(screen.getByRole("navigation", { name: "Views" }));
  await userEvent.click(sidebar.getByRole("button", { name: "Decks" }));

  expect(await screen.findByRole("button", { name: "New deck" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Deck name")).not.toBeInTheDocument();
});

/**
 * The sixth view, and the second way into the corpus. The sidebar entry has to reach the real
 * page: `TagsPage`'s own tests render it directly, so nothing there can see whether `ViewId`,
 * `NAV` and `ActiveView` actually agree about the word `tags`.
 */
it("opens the tag browser on the tags entry", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Tagger" }));

  expect(
    await screen.findByRole("heading", { name: "Browse cards by tag", level: 2 }),
  ).toBeInTheDocument();
  // And the honest empty state, since this file's database has never ingested either taxonomy.
  expect(await screen.findByText(/art tags have not been downloaded/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Card search" })).not.toBeInTheDocument();
});

/** The second live view. The sidebar entry has to reach the real thing, not the blurb that
 *  stood in for it — which is the one thing `CollectionPage`'s own tests cannot see. */
it("opens the collection on the collection entry", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Collection" }));

  expect(await screen.findByText("$801.00")).toBeInTheDocument();
  expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument();
  expect(screen.queryByText(/coming in a later plan/i)).not.toBeInTheDocument();
});

/** The third live view, and the last one Plan 3 lights up. */
it("opens the wishlist on the wishlist entry", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

  expect(await screen.findByText(/nothing on your wishlist yet/i)).toBeInTheDocument();
  expect(screen.queryByText(/coming in a later plan/i)).not.toBeInTheDocument();
});

/**
 * The whole wire, which nothing else covers: a tile writes a card id to the store, the app draws
 * the card modal for it, and the modal asks the backend for that id. Every one of those is tested
 * in isolation elsewhere and could still be joined up wrong.
 *
 * **The surface is named by the card now, not by a category word.** `Dialog` sets
 * `aria-labelledby` to its own heading and `CardDetailModal` puts the card's name in it, so the
 * query that used to read `complementary` / "Card details" reads `dialog` / the card. That is the
 * shape of every card assertion in this file since 2026-09-03.
 */
it("opens the card modal for the card that was clicked, and closes it again", async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

  const card = await screen.findByRole("dialog", { name: /lightning bolt/i });
  // The id **and** the marketplace: the card's prices are the backend's, so a read that dropped
  // the second argument would quote whatever the default happens to be under the reader's own
  // heading. Nothing here has chosen one, so it is `tcgplayer`.
  expect(cardDetail).toHaveBeenCalledWith("c1", "tcgplayer");
  // The results are still mounted behind the scrim — covered rather than unmounted, which is what
  // makes a close put the reader back where they were rather than re-running their search.
  expect(screen.getByRole("group", { name: "Search results" })).toBeInTheDocument();

  await userEvent.click(within(card).getByRole("button", { name: /close card details/i }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/**
 * **One Escape per layer, with a nested overlay open over the card** — the ladder the docked pane
 * could not have had, because nothing opened *over* it.
 *
 * `Dialog` registers the `"inner"` rung on its own open flag and `useDismissOnEscape` keeps a
 * capture stack in which only the token on top acts, so the overlay — which mounted later —
 * takes the first press and the card takes the next. Nothing in either component says any of
 * that; it falls out of mount order, which is exactly why it is worth a test at this level.
 *
 * **Legality rather than Oracle tags, deliberately**: this file mocks `oracleTagsStatus` and
 * `oracleTagsForPrintings` and not `oracleTagsForCards`, so the tag overlay would need a mock
 * added before it could stand here.
 */
it("gives one Escape to each layer: overlay, card, view", async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });

  await userEvent.click(screen.getByRole("button", { name: "Legality" }));
  await screen.findByRole("dialog", { name: /legality/i });

  await userEvent.keyboard("{Escape}");

  // The overlay goes and the card stays.
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /legality/i })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("group", { name: "Search results" })).toBeInTheDocument();
});

/**
 * Escape dismisses one layer, not the stack. The pane and the set filter both listen for
 * the key on `window`, and the pane has been mounted since before the filter opened — so
 * without the capture-phase handshake between them a single press closes a popup the
 * reader opened *and* the card underneath it, with two focus hand-backs racing for the
 * caret.
 */
it("closes the set filter on the first Escape and the card on the second", async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });
  // The set picker is in the filter row's tray, one press in, since the row was redesigned.
  await userEvent.click(screen.getByRole("button", { name: /^Show filters/ }));
  const setFilter = screen.getByRole("button", { name: "Set" });
  await userEvent.click(setFilter);
  expect(await screen.findByRole("combobox", { name: /search sets/i })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("combobox", { name: /search sets/i })).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();
  expect(setFilter).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/**
 * The same handshake, one view over and a different kind of inner layer.
 *
 * The test above is a popup inside the search view; this is a **modal full-window overlay** in
 * the deck editor, which is where the pair is most ordinary — the editor opens the pane from its
 * own cards and leaves its whole toolbar pressable behind it, so "paste a list" over "read this
 * card" is two presses a reader actually makes.
 *
 * Neither component's own suite can see it: `DeckEditor.test.tsx` mounts the editor with no pane
 * beside it, and the pane's tests have no dialog to open over them. What is asserted is that the
 * dialog's **capture-phase** `preventDefault` reaches the pane's bubble-phase listener —
 * registration order puts the pane first, so without capture one press closes both. Checked by
 * breaking it (2026-08-12): with the dialog's rung set to `"outer"` this fails, and it fails in
 * the revealing direction — the *pane* closes and the dialog stays, because the pane's listener
 * then runs first and the dialog returns early on `defaultPrevented`.
 */
it("closes the import dialog on the first Escape and the card on the second", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValue(detail([DECK_BOLT]));
  // The editor's docked search panel finds nothing, so the deck's own card is the only control
  // by that name — the same reason the swap tests below stub it empty.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });
  const trigger = screen.getByRole("button", { name: "Import cards" });
  await userEvent.click(trigger);
  // `findBy`, not `getBy`: the panel is a `motion` element and its first painted frame carries
  // its `initial`, so everything inside it is invisible for one commit after the press.
  expect(await screen.findByRole("dialog", { name: "Import a decklist" })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  // And `waitFor` on the way out for the mirror-image reason: the panel outlives the flag by
  // the length of its exit.
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Import a decklist" })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();
  expect(trigger).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/**
 * The bottom of the ladder, and the pair that made it need a stack on the bubble side.
 *
 * `"navigation"` and the card pane are **both** bubble-phase layers, and the view is mounted long
 * before the pane docks beside it — so in registration order the floor acts first, and this press
 * would close the deck out from under a card the reader was still reading. Rank is what orders
 * them; the assertion in the middle, that the editor is still on screen after the first press, is
 * the whole of it.
 *
 * Neither half's own suite can see this. `DeckEditor.test.tsx` mounts the editor with no pane
 * beside it, and the pane's tests have no view under them to navigate. Checked by breaking it: with
 * `"navigation"` ranked at or above `"outer"` the first press closes the *deck* and the pane goes
 * with it, so both assertions after it fail together.
 */
it("closes the card on the first Escape and the deck on the second", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValue(detail([DECK_BOLT]));
  // The editor's docked search column finds nothing, so the deck's own card is the only control
  // by that name — and, just as much to the point, its search box is empty, so the field rung
  // above these two has nothing to spend a press on.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });

  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByLabelText("Deck name")).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  // The editor is a `motion` surface, so it outlives the flag by the length of its exit — the
  // same reason the import dialog above is awaited out rather than asserted out.
  await waitFor(() => expect(screen.queryByLabelText("Deck name")).not.toBeInTheDocument());
  expect(await screen.findByRole("button", { name: /^Burn/ })).toBeInTheDocument();
});

/** A card left open through a view change would dock beside a list it did not come from —
 *  a printing from the search, pinned open next to a wall of decks. */
it("closes the card when the reader leaves the view", async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });

  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/**
 * The other half of the Escape protocol: a control *inside* a row must not swallow the key
 * on the way to `window`.
 *
 * A row in the collection table opens the card on Enter or Space, so the cells holding its
 * stepper stop those presses from reaching the row. They used to stop the whole `keydown`,
 * and React attaches one listener at the root — so a press that never reached the root
 * never reached `window`, where the pane's Escape listens. The pane then stayed open for as
 * long as the caret sat in a stepper, which is exactly where it sits while a count is being
 * corrected. Found in the running app (2026-08-06), invisible to every suite here: a test
 * that fires Escape at the row never travels the path that was broken.
 */
it("closes the card on Escape from inside a collection row's controls", async () => {
  // Two rows, because a collection row's *other* guarded cell — the remove button — is
  // offered only at zero copies, and both cells carry the same stop.
  collectionList.mockResolvedValue({
    items: [BOLT_ENTRY, { ...BOLT_ENTRY, id: 8, name: "Counterspell", quantity: 0 }],
    total: 2,
  });
  // **The table, said out loud**, because the collection opens on art since 2026-08-26 and this
  // case is about a `role="row"` — the stepper it reaches for lives in a table cell, and a wall of
  // tiles has neither. The default is not what is under test here; the Escape protocol is.
  useAppStore.setState({ collectionView: "table" });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Collection" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ }).focus();
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

  await userEvent.click(screen.getByRole("row", { name: /Counterspell/ }));
  expect(await screen.findByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Remove Counterspell .* from your collection/ }).focus();
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/** The same key, the same cell shape, in the search table's quick-add — the second of the
 *  three sites, and the one a reader meets first. */
it("closes the card on Escape from inside the search table's add button", async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Table view" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Add Lightning Bolt \(LEA 161\) to collection/ }).focus();
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/** And the third: the wishlist's stepper cell, which had its own copy of the blanket stop
 *  and its own local helper to hide it in. Three lists, one bug, one fix — and this test
 *  exists so a fourth list is caught by the suite rather than by a reader. */
it("closes the card on Escape from inside a wishlist row's controls", async () => {
  wishlistList.mockResolvedValue({ items: [BOLT_WISH], total: 1 });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));
  // The list view, which this one is about: both guarded cells are a *row's*, and the wishlist
  // now opens on its wall. The search test above asks for its table for the same reason.
  await userEvent.click(await screen.findByRole("button", { name: "Table view" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }).focus();
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

  // The row's second guarded cell. Both carried the stop; a test that checked one of them
  // would have let the other keep it.
  await userEvent.click(screen.getByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Remove Lightning Bolt .* from your wishlist/ }).focus();
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

/**
 * **One card surface, and it is `App`'s wherever the reader is** — which is what issue #183's
 * two mounts became on 2026-09-03.
 *
 * The shell docked a 384px pane beside every view, and the deck editor drew a second copy of it
 * as an overlay over one of its own two columns because docking cost the desk 384px plus a gap on
 * every click. `App` chose between them with an `inDeckEditor` selector, and exactly one of the
 * two was ever live. There is one mount now and nothing to suppress, so what is worth asserting
 * has moved: the card is a **sibling of the shell** rather than a descendant of whatever view is
 * behind it, which is what makes the scrim cover the window and the panel outlive a view change.
 *
 * This is still the only file that can see it — the modal is mounted at `App` level and the
 * editor's own suite renders neither.
 */
it("draws the card over the deck editor rather than inside it", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValue(detail([DECK_BOLT]));
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));

  const cards = screen.getAllByRole("dialog", { name: /lightning bolt/i });
  expect(cards).toHaveLength(1);
  // The editor is the `section` its deck name field sits in. A card drawn inside it would take
  // the editor's own stacking context and its `overflow`; drawn out here it takes the window.
  expect(screen.getByLabelText("Deck name").closest("section")).not.toContainElement(cards[0]);

  // Out of the deck. The card stays open — `setOpenDeckId` keeps `selectedCardId` on purpose,
  // because the card belongs to the reader and not to the view behind it — and it is the same
  // one mount, so nothing about the trip can have left a second behind.
  await userEvent.click(screen.getByRole("button", { name: "Back to decks" }));
  await screen.findByRole("button", { name: "New deck" });

  expect(screen.getAllByRole("dialog", { name: /lightning bolt/i })).toHaveLength(1);
});

/**
 * The printings modal, opened from the card modal — the handle every swap test below reaches it
 * by.
 *
 * **Both dialogs are named after the same card**, because `AllPrintingsDialog`'s title is the
 * card's name and `CardDetailModal`'s is too, so a `getByRole("dialog", { name: /…/ })` finds
 * two the moment the printings wall is up. The close button's label is what tells them apart,
 * and it is a label rather than a heuristic: `closeLabel` is a required prop of `Dialog`, so
 * every host has one and no two of these say the same thing.
 */
async function openPrintings() {
  await userEvent.click(await screen.findByRole("button", { name: "View all printings (2)" }));
  const close = await screen.findByRole("button", { name: "Close printings" });
  return close.closest('[role="dialog"]') as HTMLElement;
}

/**
 * A swap, end to end — and this is the only file it *can* be tested in.
 *
 * The press is a tile of the printings modal and everything it changes is in the deck editor, and
 * the two are siblings under this component with nothing between them but the store and a query
 * cache. Neither one's own suite can see the other: `AllPrintingsDialog.test.tsx` mocks a deck
 * read that no editor is drawing, and the editor's tests have no printings wall to press.
 *
 * **The route is one press longer than it was**, and that is the whole of what the card modal
 * changed here. The docked pane listed every printing down its right-hand side and a row *was*
 * the swap; the modal draws a picker and a `View all printings (N)` button, and the wall behind
 * that button is `AllPrintingsDialog` — which has hosted this same `useSwapFromPane` write all
 * along. Nothing about the write moved.
 */
it("swaps a deck row's printing from the printings modal, and follows the deck onto it", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValueOnce(detail([DECK_BOLT])).mockResolvedValue(detail([SWAPPED_BOLT]));
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  // The editor's docked search panel finds nothing: a result named after the card already in
  // the deck would be a second button by that name, and the deck's card is addressed by it.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  // Out of the deck, into the card: the click that writes the context the swap is addressed by.
  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });
  const printings = await openPrintings();

  await userEvent.click(await within(printings).findByRole("button", { name: /M10/ }));

  await waitFor(() =>
    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "c1", "c2", MAIN.id, "live", null),
  );

  // The deck redraws on the printing it now holds — the row's picture is the M10 card. The
  // variant in that path is `DECK_CARD_VARIANT`; what this test is about is the **id**, `c2`.
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: /^Lightning Bolt/ })
        .closest("li")
        ?.querySelector("img"),
    ).toHaveAttribute("src", expect.stringContaining(`/${DECK_CARD_VARIANT}/c2/0`)),
  );
});

/**
 * The refused half of the same wire, which is two sentences in two components at once.
 *
 * `swap_printing` opens with `touch_deck` like every other card write, so a deck deleted from
 * another window answers GONE — and the printings modal says so beside the wall while the editor
 * behind it stops painting a deck that is not there. The two are joined by the mutation's own
 * `onError` invalidation (`useDeck`), because TanStack shares a mutation's state with no other
 * observer: the editor's copy of this write never hears about the failure, and without that
 * invalidation the category columns would go on drawing a deleted deck under a modal explaining
 * that it is gone.
 *
 * The two sentences are deliberately worded apart — "That deck" is the backend's refusal, "This
 * deck" is the editor's own re-read — so this test can tell which surface said what.
 */
it("says a refused swap in the printings modal, and the deck behind it goes with it", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValueOnce(detail([DECK_BOLT])).mockResolvedValue(null);
  deckSwapPrinting.mockRejectedValue("That deck is not there any more.");
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });
  const printings = await openPrintings();

  await userEvent.click(await within(printings).findByRole("button", { name: /M10/ }));

  expect(await within(printings).findByRole("alert")).toHaveTextContent(
    "Could not use that printing — That deck is not there any more.",
  );
  // Still open. The refusal is drawn *in* the modal rather than closing it, which is the one
  // thing the docked pane could not do with this sentence.
  expect(within(printings).getByRole("button", { name: "Close printings" })).toBeInTheDocument();

  expect(
    await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
  ).toBeInTheDocument();
});

/**
 * A deck already known to be gone offers no swap at all — a press on a tile is a *look*.
 *
 * The modal reads the deck through the same query the editor draws from (`useSwapFromPane` takes
 * the whole hook for exactly this), so the two surfaces agree **before** the press: the editor
 * says the deck is not there and the wall stops claiming a tile would rewrite a row in it.
 * Offering a write the backend can only refuse is worse than offering none.
 */
it("stops offering swaps into a deck the read says is gone", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValueOnce(detail([DECK_BOLT])).mockResolvedValue(null);
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });

  // The deck goes, and the editor's own re-read is what tells both surfaces. Any deck write would
  // do it; the name field is the cheapest one left in that header that is not the swap.
  const name = screen.getByLabelText("Deck name");
  await userEvent.clear(name);
  await userEvent.type(name, "Sunday burn{Enter}");
  expect(
    await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
  ).toBeInTheDocument();

  const printings = await openPrintings();
  await userEvent.click(await within(printings).findByRole("button", { name: /M10/ }));

  // A look: the card opens on the printing that was pressed, no deck row travels with it, and
  // nothing was written.
  await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("c2"));
  expect(useAppStore.getState().paneDeckContext).toBeNull();
  expect(deckSwapPrinting).not.toHaveBeenCalled();
});
