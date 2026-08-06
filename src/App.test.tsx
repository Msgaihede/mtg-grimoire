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
    // The one deck write with no control in the editor: it is pressed on the card pane's
    // printings rows, which is a *different component*, and this file is where the two meet.
    deckSwapPrinting,
    formatSpecs: vi.fn().mockResolvedValue([]),
  },
}));

import App from "./App";
import { card } from "@/features/decks/validation/fixtures";
import type {
  CardDetail,
  CardSummary,
  CollectionRow,
  DeckCard,
  DeckRow,
  Printing,
  WishRow,
} from "@/lib/ipc";
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
/** The second printing already in the zone, so a swap onto it **folds** two rows into one. */
const OTHER_BOLT: DeckCard = card({
  name: "Lightning Bolt",
  cardId: "c2",
  setCode: "m10",
  collectorNumber: "146",
  quantity: 2,
});

const ALPHA: Printing = {
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
  prices: '{"usd":"400.50","usd_foil":null,"usd_etched":null,"eur":null,"tix":null}',
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
  prices: '{"usd":"1.50","usd_foil":null,"usd_etched":null,"eur":null,"tix":null}',
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

/** And as a wish — **pinned to a printing**, because an any-printing wish opens no pane and
 *  a row that cannot open the card cannot test what Escape does to one. */
const BOLT_WISH: WishRow = {
  id: 11,
  oracleId: "o1",
  cardId: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  quantity: 2,
  preferredFinish: null,
  unitPriceUsd: 400.5,
  unitPriceEur: 350,
  ownedQuantity: 0,
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
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 1 });
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
 * "Use this printing", end to end — and this is the only file it *can* be tested in.
 *
 * The control is on the card pane's printings rows and everything it changes is in the deck
 * editor, and the two are siblings under this component with nothing between them but the
 * store and a query cache. Neither one's own suite can see the other: the pane's tests mock a
 * deck read that no editor is drawing, and the editor's tests have no pane to press.
 */
it("swaps a deck row's printing from the card pane, and follows the deck onto it", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet
    .mockResolvedValueOnce({ deck: BURN, cards: [DECK_BOLT] })
    .mockResolvedValue({ deck: BURN, cards: [SWAPPED_BOLT] });
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  // The editor's docked search panel finds nothing: a result named after the card already in
  // the deck would be a second button by that name, and the deck's card is addressed by it.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");

  // Out of the deck, into the pane: the click that writes the context.
  await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
  const pane = await screen.findByRole("complementary", { name: /card details/i });
  await userEvent.click(within(pane).getByRole("button", { name: /^Use this printing/ }));

  expect(deckSwapPrinting).toHaveBeenCalledWith(4, "c1", "c2", "main");

  // The deck redraws on the printing it now holds — the card in the column is the M10 art.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Lightning Bolt" }).querySelector("img"),
    ).toHaveAttribute("src", expect.stringContaining("/grid/c2/0")),
  );
  // And the pane has followed it: the mark is on the row that was pressed, and the row that
  // had it is offering itself again.
  const marked = await screen.findByText("This deck uses this printing");
  expect(marked.closest("li")).toHaveTextContent("M10 · 146");
  expect(
    screen.getByRole("button", { name: "Use this printing (LEA 161) in Main deck" }),
  ).toBeInTheDocument();
});

/**
 * The refused half of the same wire, which is two sentences in two components at once.
 *
 * `swap_printing` opens with `touch_deck` like every other zone write, so a deck deleted from
 * another window answers GONE — and the pane says so beside the row that was pressed while the
 * editor behind it stops painting a deck that is not there. The two are joined by the
 * mutation's own `onError` invalidation (`useDeck`), because TanStack shares a mutation's state
 * with no other observer: the editor's copy of this write never hears about the failure, and
 * without that invalidation the zone columns would go on drawing a deleted deck under a pane
 * explaining that it is gone.
 *
 * The two sentences are deliberately worded apart — "That deck" is the backend's refusal,
 * "This deck" is the editor's own re-read — so this test can tell which surface said what.
 */
it("says a refused swap in the pane, and the deck behind it goes with it", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet.mockResolvedValueOnce({ deck: BURN, cards: [DECK_BOLT] }).mockResolvedValue(null);
  deckSwapPrinting.mockRejectedValue("That deck is not there any more.");
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  // The editor's docked search panel finds nothing: a result named after the card already in
  // the deck would be a second button by that name, and the deck's card is addressed by it.
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));

  const pane = await screen.findByRole("complementary", { name: /card details/i });
  await userEvent.click(within(pane).getByRole("button", { name: /^Use this printing/ }));

  expect(await within(pane).findByRole("alert")).toHaveTextContent(
    "Could not use this printing — That deck is not there any more.",
  );
  expect(
    await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
  ).toBeInTheDocument();
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
  deckGet.mockResolvedValueOnce({ deck: BURN, cards: [DECK_BOLT] }).mockResolvedValue(null);
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
  const pane = await screen.findByRole("complementary", { name: /card details/i });
  expect(within(pane).getByRole("button", { name: /^Use this printing/ })).toBeInTheDocument();

  // The deck goes, and the editor's own re-read is what tells both surfaces. Any deck write
  // would do it; the format select is the cheapest one to press that is not the swap.
  await userEvent.selectOptions(screen.getByLabelText("Deck format"), "modern");
  expect(
    await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
  ).toBeInTheDocument();

  expect(
    within(pane).queryByRole("button", { name: /^Use this printing/ }),
  ).not.toBeInTheDocument();
  // And the mark with it: "this deck uses this printing" is not true of a deck that is gone.
  expect(within(pane).queryByText(/this deck uses this printing/i)).not.toBeInTheDocument();
});

/**
 * The two things a successful swap owes the reader afterwards, both of which have to survive
 * the pane being **re-keyed** by the write itself (`App` keys the pane on `selectedCardId`).
 *
 * 1. **The fold.** A zone holds a printing at most once, so a swap onto one the zone already had
 *    merges two rows into one and a line disappears from the deck list — `ipc.ts`'s `SwapResult`
 *    exists to say so, and nothing said it.
 * 2. **The caret.** The pressed button disabled itself for the write, so the browser left the
 *    caret on `<body>`; then the pane it was in unmounted. Escape out of the new pane has to
 *    land somewhere, and the somewhere is the deck's card for the printing the deck now holds —
 *    the control the reader opened the card from, as the swap has just rebuilt it.
 */
it("announces a fold and hands the caret to the deck's card when the pane closes", async () => {
  deckList.mockResolvedValue([BURN]);
  deckGet
    .mockResolvedValueOnce({ deck: BURN, cards: [DECK_BOLT, OTHER_BOLT] })
    .mockResolvedValue({ deck: BURN, cards: [SWAPPED_BOLT] });
  deckSwapPrinting.mockResolvedValue({ folded: true, quantity: 3 });
  cardPrintings.mockResolvedValue({ items: [ALPHA, M10], total: 2 });
  searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Decks" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Burn/ }));
  await screen.findByLabelText("Deck name");
  await userEvent.click(screen.getAllByRole("button", { name: "Lightning Bolt" })[0]);

  const pane = await screen.findByRole("complementary", { name: /card details/i });
  await userEvent.click(within(pane).getByRole("button", { name: /^Use this printing/ }));

  // Said in the pane that replaced the one the press was made in, on the row that is now the
  // deck's — a live region drawn empty of this sentence on its first commit and filled one
  // commit later, which is the only shape a screen reader announces.
  expect(await screen.findByText(/folded into one row of 3 in Main deck/i)).toBeInTheDocument();

  // What a browser does to a control that disables itself and jsdom does not: the caret is on
  // `<body>` by the time the pane is re-keyed.
  (document.activeElement as HTMLElement).blur();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument(),
  );

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  // The deck's card for the printing the deck now holds — not `<body>`, and not the element the
  // press was made from, which the swap deleted along with its row.
  await waitFor(() => expect(screen.getByRole("button", { name: "Lightning Bolt" })).toHaveFocus());
});
