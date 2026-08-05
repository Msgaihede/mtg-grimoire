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
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncStatus,
    syncRun: vi.fn(),
    onSyncProgress: vi.fn().mockResolvedValue(() => {}),
    // The shell listens for the reconcile event too, and a `.catch` cannot catch the
    // synchronous `TypeError` of calling `undefined`.
    onCollectionReconciled: vi.fn().mockResolvedValue(() => {}),
    // The search view is live now, so opening on it fires a real query; an unresolved
    // mock would surface here as a query error rather than as the routing this file tests.
    searchCards,
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
    formatSpecs: vi.fn().mockResolvedValue([]),
  },
}));

import App from "./App";
import type { CardDetail, CardSummary, CollectionRow, DeckRow } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { useAppStore } from "@/lib/store";

/** One deck on the wall, for the trip into its editor and back. */
const BURN: DeckRow = {
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
};

const BOLT: CardSummary = {
  id: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  priceUsd: 400.5,
  layout: "normal",
  oracleId: "o1",
  finishes: '["nonfoil"]',
  ownedQuantity: 0,
  wishlisted: false,
};

/** The same card as a collection row, for the Escape-from-a-stepper test below. */
const BOLT_ENTRY: CollectionRow = {
  id: 7,
  cardId: "c1",
  name: "Lightning Bolt",
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
  unitPriceUsd: 400.5,
  unitPriceEur: 350,
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

const BOLT_DETAIL: CardDetail = {
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
  prices: '{"usd":"400.50","usd_foil":null,"usd_etched":null}',
  finishes: '["nonfoil"]',
  imageStatus: "highres_scan",
  faces: [],
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
  cardDetail.mockReset().mockResolvedValue(BOLT_DETAIL);
  cardPrintings.mockReset().mockResolvedValue({ items: [], total: 0 });
  collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
  wishlistList.mockReset().mockResolvedValue({ items: [], total: 0 });
  deckList.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue({ deck: BURN, cards: [] });
  collectionSummary.mockReset().mockResolvedValue({
    totalCards: 3,
    uniqueCards: 2,
    entries: 2,
    tradelistCards: 0,
    valueUsd: 801,
    valueEur: 700,
    unpricedUsd: 0,
    unpricedEur: 0,
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
  expect(screen.getByText(/a deck is a list you build for a format/i)).toBeInTheDocument();
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
  expect(deckGet).toHaveBeenCalledWith(4);

  await userEvent.click(screen.getByRole("button", { name: /back to decks/i }));

  const tile = await screen.findByRole("button", { name: /^Burn/ });
  await waitFor(() => expect(tile).toHaveFocus());
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
  expect(cardDetail).toHaveBeenCalledWith("c1");
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
it("closes the card on Escape from inside a collection row's stepper", async () => {
  collectionList.mockResolvedValue({ items: [BOLT_ENTRY], total: 1 });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Collection" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  const stepper = screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ });
  stepper.focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

/** The same key, the same cell shape, in the search table's quick-add — the second of the
 *  two sites the live pass found, and the one a reader meets first. */
it("closes the card on Escape from inside the search table's add button", async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Table view" }));

  await userEvent.click(await screen.findByRole("row", { name: /Lightning Bolt/ }));
  expect(await screen.findByRole("complementary", { name: /card details/i })).toBeInTheDocument();

  screen.getByRole("button", { name: /Add Lightning Bolt \(LEA 161\) to collection/ }).focus();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});
