import { act, render, screen, waitFor, within } from "@testing-library/react";
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
    setCardZoom: vi.fn().mockResolvedValue(undefined),
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
    onSyncProgress: vi.fn().mockResolvedValue(() => {}),
    // The shell listens for the reconcile event too, and a `.catch` cannot catch the
    // synchronous `TypeError` of calling `undefined`.
    onCollectionReconciled: vi.fn().mockResolvedValue(() => {}),
    // And for a price feed's progress, which is the third event this window subscribes to —
    // the backend refreshes the selected feed at start-up, so a window that was not listening
    // would show a fetch nobody could see. Same reason it must be mocked rather than left off.
    onMarketplaceProgress: vi.fn().mockResolvedValue(() => {}),
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
    // And for the Oracle tag taxonomy's progress, which is the **fourth** event this window
    // subscribes to — the backend refreshes the taxonomy at start-up for the same reason it
    // refreshes a feed, so the window has to be listening. Same failure mode as the three
    // above and it is not a hypothetical: leaving this off failed all 18 tests in this file
    // with `ipc.onOracleTagProgress is not a function`, thrown synchronously inside the
    // shell's mount effect where no `.catch` can reach it.
    onOracleTagProgress: vi.fn().mockResolvedValue(() => {}),
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
    onArtTagProgress: vi.fn().mockResolvedValue(() => {}),
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
    // The one deck write with no control in the editor: it is pressed on the card pane's
    // printings rows, which is a *different component*, and this file is where the two meet.
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
    onUpdateProgress: vi.fn().mockResolvedValue(() => {}),
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
  isBuilt: false,
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
  tags: [],
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
/** The second printing already in the category, so a swap onto it **folds** two rows into
 *  one. */
const OTHER_BOLT: DeckCard = card({
  name: "Lightning Bolt",
  cardId: "c2",
  setCode: "m10",
  collectorNumber: "146",
  quantity: 2,
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
  // A hand-kept row: `null` is what the collection says when it is not derived from the decks.
  deckCount: null,
};

/** And as a wish — **pinned to a printing**, because an any-printing wish opens no pane and
 *  a row that cannot open the card cannot test what Escape does to one. */
const BOLT_WISH: WishRow = {
  legalities: null,
  id: 11,
  oracleId: "o1",
  cardId: "c1",
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
 * The sixth view, and the second way into the corpus. The sidebar entry has to reach the real
 * page: `TagsPage`'s own tests render it directly, so nothing there can see whether `ViewId`,
 * `NAV` and `ActiveView` actually agree about the word `tags`.
 */
it("opens the tag browser on the tags entry", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Tags" }));

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
 * The whole wire, which nothing else covers: a tile writes a card id to the store, the app
 * mounts the pane beside the results for it, and the pane asks the backend for that id.
 * Every one of those is tested in isolation elsewhere and could still be joined up wrong.
 */
it("opens the detail pane for the card that was clicked, and closes it again", async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

  const pane = await screen.findByRole("complementary", { name: /card details/i });
  // The id **and** the marketplace: the pane's prices are the backend's, so a read that dropped
  // the second argument would quote whatever the default happens to be under the reader's own
  // heading. Nothing here has chosen one, so it is `tcgplayer`.
  expect(cardDetail).toHaveBeenCalledWith("c1", "tcgplayer");
  expect(within(pane).getByText("Lightning Bolt")).toBeInTheDocument();
  // The results are still there behind it: the pane is docked, not drawn over them.
  expect(screen.getByRole("group", { name: "Search results" })).toBeInTheDocument();

  await userEvent.click(within(pane).getByRole("button", { name: /close card details/i }));

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
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
  await screen.findByRole("complementary", { name: /card details/i });
  const setFilter = screen.getByRole("button", { name: "Set" });
  await userEvent.click(setFilter);
  expect(await screen.findByRole("combobox", { name: /search sets/i })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("combobox", { name: /search sets/i })).not.toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: /card details/i })).toBeInTheDocument();
  expect(setFilter).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
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
  await screen.findByRole("complementary", { name: /card details/i });
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
  expect(screen.getByRole("complementary", { name: /card details/i })).toBeInTheDocument();
  expect(trigger).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

/** A card left open through a view change would dock beside a list it did not come from —
 *  a printing from the search, pinned open next to a wall of decks. */
it("closes the card when the reader leaves the view", async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));
  await screen.findByRole("complementary", { name: /card details/i });

  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
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
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Collection" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ }).focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("row", { name: /Counterspell/ }));
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Remove Counterspell .* from your collection/ }).focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

/** The same key, the same cell shape, in the search table's quick-add — the second of the
 *  three sites, and the one a reader meets first. */
it("closes the card on Escape from inside the search table's add button", async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Table view" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Add Lightning Bolt \(LEA 161\) to collection/ }).focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
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
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }).focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

  // The row's second guarded cell. Both carried the stop; a test that checked one of them
  // would have let the other keep it.
  await userEvent.click(screen.getByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Remove Lightning Bolt .* from your wishlist/ }).focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

/**
 * **One card pane at a time, and inside a deck editor it is the editor's** (issue #183).
 *
 * The shell docks the pane beside every view, which is right for a wall of search results and
 * was wrong for the deck builder: 384px plus a gap came out of the desk on every click, so
 * opening a card re-packed the piles and collapsed the search column beside them. The editor
 * draws its own as an overlay and this component steps aside for it (`inDeckEditor`).
 *
 * **Suppression, not relocation, is what has to be asserted**, and this is the only file that
 * can: leaving the docked one up would put a second `CardDetailPane` on the same card and a
 * second `complementary` landmark in the tree — which the other tests here would then hit as an
 * ambiguous `getByRole` rather than as the thing that is actually wrong. So the count is the
 * claim, twice: one pane in the editor, and one again on the way out of it, drawn by this
 * component with nothing about the trip having leaked.
 */
it("hands the card pane to the deck editor, and takes it back", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValue(detail([DECK_BOLT]));
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  await screen.findByRole("complementary", { name: /card details/i });

  // Inside the editor's own page column rather than beside it in the shell — the whole of what
  // "takes no width from the deck" rests on. The editor is the `region` its deck name field
  // sits in; a pane the shell had drawn would be a sibling of that, not a descendant.
  const panes = screen.getAllByRole("complementary", { name: /card details/i });
  expect(panes).toHaveLength(1);
  expect(screen.getByLabelText("Deck name").closest("section")).toContainElement(panes[0]);

  // Out of the deck. The card stays open — `setOpenDeckId` keeps `selectedCardId` on purpose,
  // because the pane belongs to the reader and not to the view behind it — so this is the swap
  // back, and one pane is still one pane.
  await userEvent.click(screen.getByRole("button", { name: "Back to decks" }));
  await screen.findByRole("button", { name: "New deck" });

  expect(screen.getAllByRole("complementary", { name: /card details/i })).toHaveLength(1);
});

/**
 * "Use this printing", end to end — and this is the only file it *can* be tested in.
 *
 * The control is on the card pane's printings rows and everything it changes is in the deck
 * editor, and the two are siblings under this component with nothing between them but the
 * store and a query cache. Neither one's own suite can see the other: the pane's tests mock a
 * deck read that no editor is drawing, and the editor's tests have no pane to press.
 */
it("swaps a deck row's printing from the card pane, and follows the deck onto it", async () => {
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

  // Out of the deck, into the pane: the click that writes the context.
  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  const pane = await screen.findByRole("complementary", { name: /card details/i });
  await userEvent.click(within(pane).getByRole("button", { name: /^Use this printing/ }));

  expect(deckSwapPrinting).toHaveBeenCalledWith(4, "c1", "c2", MAIN.id, "live", null);

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
  // And the pane has followed it: the mark — the `In deck` badge that replaced `DeckLine`'s
  // sentence — is on the row that was pressed, and the row that had it is offering itself again.
  const marked = await screen.findByText("In deck");
  expect(marked.closest("li")).toHaveTextContent("M10 · 146");
  expect(
    screen.getByRole("button", { name: "Use this printing (LEA 161) in Main deck" }),
  ).toBeInTheDocument();
});

/**
 * The refused half of the same wire, which is two sentences in two components at once.
 *
 * `swap_printing` opens with `touch_deck` like every other card write, so a deck deleted from
 * another window answers GONE — and the pane says so beside the row that was pressed while the
 * editor behind it stops painting a deck that is not there. The two are joined by the
 * mutation's own `onError` invalidation (`useDeck`), because TanStack shares a mutation's state
 * with no other observer: the editor's copy of this write never hears about the failure, and
 * without that invalidation the category columns would go on drawing a deleted deck under a pane
 * explaining that it is gone.
 *
 * The two sentences are deliberately worded apart — "That deck" is the backend's refusal,
 * "This deck" is the editor's own re-read — so this test can tell which surface said what.
 */
it("says a refused swap in the pane, and the deck behind it goes with it", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValueOnce(detail([DECK_BOLT])).mockResolvedValue(null);
  deckSwapPrinting.mockRejectedValue("That deck is not there any more.");
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  // The editor's docked search panel finds nothing: a result named after the card already in
  // the deck would be a second button by that name, and the deck's card is addressed by it.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));

  const pane = await screen.findByRole("complementary", { name: /card details/i });
  const pressed = within(pane).getByRole("button", { name: /^Use this printing/ });
  await userEvent.click(pressed);

  expect(await within(pane).findByRole("alert")).toHaveTextContent(
    "Could not use this printing — That deck is not there any more.",
  );
  expect(
    await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
  ).toBeInTheDocument();

  // **And the caret has not moved — there is nothing left here to strand it.**
  //
  // This used to be a hand-back, and it was one because `DeckLine`'s button broke it: the button
  // *disabled* itself for the write, so the browser blurred it to `<body>`, and the re-read this
  // refusal triggers then unmounted every offer in the list. The pane was where the sentence
  // lived, so the pane took the caret. The press is now the row's own name button, which is
  // drawn whether the deck is there or not and never leaves the tab order (`aria-disabled`,
  // never the attribute) — so a refusal unmounts nothing, and the pane's fallback
  // (`deckGone && refused && activeElement === body`) correctly never fires.
  //
  // What changes is only what the button *says*: the deck is gone, so the offer language goes
  // with it and the same element goes back to naming the trip it makes with no deck behind the
  // pane. Same element, same caret, a different sentence on it.
  await waitFor(() => expect(pressed).toHaveAccessibleName("Show M10 · 146"));
  expect(pressed).toHaveFocus();
  // Greyed is a paint here and never the attribute, so "still reachable" is asserted as the
  // pair: nothing in the DOM took this control out of the tab order under the reader.
  expect(pressed).toHaveAttribute("aria-disabled", "false");
  expect(pressed).not.toBeDisabled();
  expect(pane).not.toHaveFocus();
  expect(within(pane).getByRole("alert")).toBeInTheDocument();

  // And it is a working caret rather than an attribute: the row it sits on still answers the
  // keyboard, which is what `aria-disabled` bought and `disabled` would have cost. Pressed with
  // `userEvent.keyboard` on a caret nothing here placed by hand — the click under test put it
  // there — so this cannot pass by having focused what it then asserts about. With the deck
  // gone the row means what it means everywhere else: show me this printing.
  await userEvent.keyboard("{Enter}");

  await waitFor(() => expect(cardDetail).toHaveBeenCalledWith("c2", "tcgplayer"));
});

/**
 * A deck already known to be gone offers nothing, rather than forty buttons whose only way of
 * finding out is to be pressed.
 *
 * The pane reads the deck through the same query the editor draws from (`useSwapFromPane` takes
 * the whole hook for exactly this), so the two surfaces agree **before** the press: the editor
 * says the deck is not there and the pane stops claiming a printing is in it.
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
  const pane = await screen.findByRole("complementary", { name: /card details/i });
  expect(within(pane).getByRole("button", { name: /^Use this printing/ })).toBeInTheDocument();
  // Both claims are on screen **before** the deck goes, so each negative below is a change this
  // test watched happen rather than a string that was never there to begin with.
  expect(within(pane).getByText("In deck")).toBeInTheDocument();

  // The deck goes, and the editor's own re-read is what tells both surfaces. Any deck write
  // would do it; the format select is the cheapest one to press that is not the swap.
  await userEvent.selectOptions(screen.getByLabelText("Deck format"), "modern");
  expect(
    await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
  ).toBeInTheDocument();

  // What a deleted deck takes down is the **offers**, not the list: every row is still a row,
  // and the one that was an offer has gone back to naming the trip it makes with no deck behind
  // the pane. Asserted both ways round, because the row *is* the press now — a query for the
  // offer's name alone would also pass if the printings list had vanished entirely.
  expect(
    within(pane).queryByRole("button", { name: /^Use this printing/ }),
  ).not.toBeInTheDocument();
  expect(within(pane).getByRole("button", { name: "Show M10 · 146" })).toBeInTheDocument();
  // And the mark with it: `In deck` is not true of a deck that is gone.
  expect(within(pane).queryByText("In deck")).not.toBeInTheDocument();
});

/**
 * The two things a successful swap owes the reader afterwards, both of which have to survive
 * the pane being **re-keyed** by the write itself (`App` keys the pane on `selectedCardId`).
 *
 * 1. **The fold.** A category holds a printing at most once, so a swap onto one it already had
 *    merges two rows into one and a line disappears from the deck list — `ipc.ts`'s `SwapResult`
 *    exists to say so, and nothing said it.
 * 2. **The caret.** The re-key unmounts the row the press came from, so the browser has nothing
 *    to leave the caret on. (It used to be the pressed button that did this, by disabling itself
 *    for the write; that button is gone and the re-key does it on its own.) Escape out of the new
 *    pane has to land somewhere, and the somewhere is the deck's card for the printing the deck
 *    now holds — the control the reader opened the card from, as the swap has just rebuilt it.
 */
it("announces a fold and hands the caret to the deck's card when the pane closes", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet
    .mockResolvedValueOnce(detail([DECK_BOLT, OTHER_BOLT]))
    .mockResolvedValue(detail([SWAPPED_BOLT]));
  deckSwapPrinting.mockResolvedValue({ folded: true, quantity: 3 });
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  // **The printing the swap moves to is a card this pane has never read.** Held open, so the
  // replacing pane spends the whole assertion below in the state it really mounts in: no
  // `card.data`, and therefore no art, no facts and no printings list. Whatever says what the
  // write did has to be outside all of that — the announcement is a change *inside a mounted
  // region*, and a region that first appears with its sentence already in it announces nothing.
  let arrive!: (card: CardDetail) => void;
  cardDetail.mockImplementation((id: string) =>
    id === "c1"
      ? Promise.resolve(BOLT_DETAIL)
      : new Promise<CardDetail>((resolve) => {
          arrive = resolve;
        }),
  );
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getAllByRole("button", { name: /^Lightning Bolt/ })[0]);

  const pane = await screen.findByRole("complementary", { name: /card details/i });
  // The region exists before there is anything to say — on a pane whose card has arrived and
  // whose reader has done nothing. That is the half of the shape a text assertion cannot see.
  expect(within(pane).getByRole("status")).toBeEmptyDOMElement();

  await userEvent.click(within(pane).getByRole("button", { name: /^Use this printing/ }));

  const swapped = await screen.findByRole("complementary", { name: /card details/i });
  expect(within(swapped).getByRole("status")).toHaveTextContent(
    "Folded into one row of 3 in Main deck.",
  );
  // …while the card itself is still on its way, which is what pins the region to the pane's
  // shell: everything below the heading is drawn behind `card.data`.
  expect(within(swapped).getByRole("heading", { level: 2 })).toHaveTextContent("Loading…");
  expect(within(swapped).queryByText(/printings/i)).not.toBeInTheDocument();

  // `M10_DETAIL` and not the card the pane came from: a `c2` read answers `c2`, and which row
  // the list draws as the one in front of the reader now follows from that.
  act(() => arrive(M10_DETAIL));
  // And the row's own mark is back once the list is. Two marks, two places, two facts: the badge
  // says which printing the deck holds, the live region above says what the write did to it.
  expect(await within(swapped).findByText("In deck")).toBeInTheDocument();

  // What a real window leaves behind and jsdom does not model on its own: the re-key unmounted
  // the row the press came from, so by now the caret is on nothing a reader put it on.
  (document.activeElement as HTMLElement).blur();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toBeInTheDocument(),
  );

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  // The deck's card for the printing the deck now holds — not `<body>`, and not the element the
  // press was made from, which the swap deleted along with its row.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toHaveFocus(),
  );
});

/**
 * The same hand-back, asked the other way: one card, no fold — what is being asked is where the
 * caret lands, and the announcement is the other test's subject.
 *
 * The pane finds its way home through an attribute on the control that stands for the slot
 * (`DECK_CARD_ATTR`, stamped by `cardControl.tsx`'s `deckCardProps` and therefore by all four
 * views). Deleting it from the card left every suite green until this existed, and the deck
 * builder's rebuild proved that the hard way: for one task no view stamped it, and this was the
 * only test in the repo that noticed.
 */
it("hands the caret back to the deck's card after a swap", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValueOnce(detail([DECK_BOLT])).mockResolvedValue(detail([SWAPPED_BOLT]));
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  // The editor's docked search panel finds nothing: a result named after the card already in
  // the deck would be a second button by that name, and the deck's row is addressed by it.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
  const pane = await screen.findByRole("complementary", { name: /card details/i });
  await userEvent.click(within(pane).getByRole("button", { name: /^Use this printing/ }));

  expect(deckSwapPrinting).toHaveBeenCalledWith(4, "c1", "c2", MAIN.id, "live", null);
  // The row the swap rebuilt, on the printing the deck now holds — a *row*, so it is read by
  // its set and number rather than by the art the other view draws. Read off the deck's own card
  // and not off the screen: the pane followed the swap onto that printing, so its facts line says
  // the same two words about the same piece of cardboard, and an unscoped query would be
  // satisfied by either surface.
  //
  // Scoped to the card's `<li>` rather than to its button, because the stack's data line is a
  // **sibling** of the button and not a child of it (`CardStack.tsx`, "It is outside the button
  // on purpose" — inside, its text was swallowed by the button's `aria-label` and the printing
  // had no reader at all). Scoping to the button passed until that moved and then failed here
  // with the set still plainly on screen, which is the tell for this whole class of miss: the
  // card is the object this assertion is about, so the card is what it should have been reading.
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("button", { name: /^Lightning Bolt/ }).closest("li") as HTMLElement,
      ).getByText("M10 · 146"),
    ).toBeInTheDocument(),
  );

  // What a real window leaves behind and jsdom does not model on its own: the re-key unmounted
  // the row the press came from, so the caret is on nothing.
  (document.activeElement as HTMLElement).blur();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toHaveFocus(),
  );
});
