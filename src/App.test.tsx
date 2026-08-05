import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const syncStatus = vi.hoisted(() => vi.fn());
const searchCards = vi.hoisted(() => vi.fn());
const cardDetail = vi.hoisted(() => vi.fn());
const cardPrintings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncStatus,
    syncRun: vi.fn(),
    onSyncProgress: vi.fn().mockResolvedValue(() => {}),
    // The search view is live now, so opening on it fires a real query; an unresolved
    // mock would surface here as a query error rather than as the routing this file tests.
    searchCards,
    listSets: vi.fn().mockResolvedValue([]),
    // The grid warms the images of every page that lands, so routing to the search view
    // calls this on the way up.
    prefetchImages: vi.fn().mockResolvedValue(undefined),
    cardDetail,
    cardPrintings,
  },
}));

import App from "./App";
import type { CardDetail, CardSummary } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

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
  useAppStore.setState(useAppStore.getInitialState());
  searchCards.mockReset().mockResolvedValue({ items: [BOLT], total: 1, totalIsCapped: false });
  cardDetail.mockReset().mockResolvedValue(BOLT_DETAIL);
  cardPrintings.mockReset().mockResolvedValue({ items: [], total: 0 });
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

  await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

  // The ribbon's `h1` is the only place the view is named — the placeholder used to
  // repeat it as an `h2`, which was a second heading saying the same word.
  expect(screen.getByRole("heading", { name: "Wishlist", level: 1 })).toBeInTheDocument();
  expect(screen.getByText(/coming in a later plan/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Card search" })).not.toBeInTheDocument();
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

/** A card left open through a view change would dock beside a page it has nothing to do
 *  with — and the Decks placeholder has no way to dismiss it. */
it("closes the card when the reader leaves the view", async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));
  await screen.findByRole("complementary", { name: /card details/i });

  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});
