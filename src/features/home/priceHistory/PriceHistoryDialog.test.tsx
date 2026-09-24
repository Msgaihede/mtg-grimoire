import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";

import type { CardDetail, PriceHistory, PricePoint } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const cardDetail = vi.fn();
const priceHistory = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();
const cardTcgplayerIds = vi.fn();

/**
 * The whole IPC surface this popup reaches: the card (for the art column and the heading), the
 * history (for everything on the right), the marketplace setting and its feeds (`useMarketplace`),
 * and the id lookup the `Open on …` press spends.
 *
 * **The replacement `ipc` object is the whole of what the component can call**, so a command this
 * dialog starts reaching later fails here as `undefined is not a function` rather than passing
 * quietly — which is the point of listing them rather than spreading the real one in.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    priceHistory: (id: string, finish: string, marketplace: MarketplaceId) =>
      priceHistory(id, finish, marketplace),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
    cardTcgplayerIds: (id: string) => cardTcgplayerIds(id),
  },
}));

/** The app's one call that leaves it — faked at its own module, with every URL builder left real. */
vi.mock("@/lib/externalLinks", async (original) => ({
  ...(await original<typeof import("@/lib/externalLinks")>()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

import { openExternal } from "@/lib/externalLinks";
import { useAppStore, type PriceHistoryRequest } from "@/lib/store";
import { NO_HISTORY_SENTENCE, PriceHistoryDialog } from "./PriceHistoryDialog";

const detail: CardDetail = {
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
  legalities: null,
  // Distinct from every figure the history draws, so a price found on screen is known to be the
  // history's and not one of the art column's own cells.
  finishPrices: { nonfoil: 620, foil: 12.5, etched: null },
  // Sold both ways, so the foil copy the mover was about is a real listing to open.
  finishes: '["nonfoil","foil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
  imageUris: null,
};

const DAY = 86_400;
/** A UTC midnight, as `PriceHistory.today` always is. */
const TODAY = 20_000 * DAY;

/**
 * Forty remembered days that step once: **$5 up to twenty days ago, $8 since**, and $10 today.
 *
 * Each range's baseline is the latest snapshot at least that old, so the month measures from a $5
 * day and the week from an $8 one — and each lands well inside its band, so the figures do not
 * depend on which exact day the baseline picks.
 */
function steppedHistory(): PriceHistory {
  const points: PricePoint[] = [];
  for (let back = 40; back >= 1; back--) {
    points.push({ day: TODAY - back * DAY, price: back >= 20 ? 5 : 8 });
  }
  return { points, now: 10, today: TODAY };
}

const FOIL_MONTH: PriceHistoryRequest = { cardId: "c1", finish: "foil", window: "30d" };

function renderDialog(request: PriceHistoryRequest | null = FOIL_MONTH) {
  if (request !== null) useAppStore.getState().openPriceHistory(request);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PriceHistoryDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  cardDetail.mockReset().mockResolvedValue(detail);
  priceHistory.mockReset().mockResolvedValue(steppedHistory());
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  cardTcgplayerIds.mockReset().mockResolvedValue({ productId: 1174, etchedProductId: null });
  vi.mocked(openExternal).mockClear();
});

it("opens on the store's request, draws the card modal's art column, and credits the artist", async () => {
  renderDialog(null);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  act(() => useAppStore.getState().openPriceHistory(FOIL_MONTH));

  // Addressed as the price popup *about* the card, so it cannot be mistaken for the card modal.
  const dialog = await screen.findByRole("dialog", { name: /price history of lightning bolt/i });
  // The art is `CardModalArt`'s own frame — its `alt` is the card's name.
  expect(within(dialog).getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
  // Scryfall's rule: wherever the art is shown, the illustrator is identifiable.
  expect(within(dialog).getByText(/Illustrated by Christopher Rush\./)).toBeInTheDocument();
  // The read asked for the copy the row was about, at the marketplace the reader picked.
  expect(priceHistory).toHaveBeenCalledWith("c1", "foil", "tcgplayer");
});

it("measures the change over the range on screen, and a press on the switch re-measures it", async () => {
  const user = userEvent.setup();
  renderDialog();

  // Seeded from the widget's window — thirty days, measured from a $5 day to today's $10.
  expect(await screen.findByText("+$5.00 · +100.0%")).toBeInTheDocument();
  expect(screen.getByText("Change over 30 days")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");

  await user.click(screen.getByRole("radio", { name: "7 days" }));

  // The week measures from an $8 day instead.
  expect(await screen.findByText("+$2.00 · +25.0%")).toBeInTheDocument();
  expect(screen.getByText("Change over 7 days")).toBeInTheDocument();
  expect(screen.queryByText("+$5.00 · +100.0%")).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
});

it("hands the card to the card modal on the mover's own finish, and closes itself", async () => {
  const user = userEvent.setup();
  renderDialog();

  await user.click(await screen.findByRole("button", { name: "Open card details" }));

  const state = useAppStore.getState();
  expect(state.priceHistory).toBeNull();
  expect(state.selectedCardId).toBe("c1");
  // A foil mover opens the foil copy — the card modal's foil seed.
  expect(state.paneFinish).toBe("foil");
});

it("opens the marketplace listing for the copy the mover was about", async () => {
  const user = userEvent.setup();
  renderDialog();

  const open = await screen.findByRole("button", { name: "Open on TCGplayer" });
  // Out of reach only until the card has been read — the name search needs its name.
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);

  await waitFor(() =>
    expect(openExternal).toHaveBeenCalledWith(
      "https://www.tcgplayer.com/product/1174?Printing=Foil",
    ),
  );
});

it("says there is no history yet rather than that nothing moved, and still quotes today", async () => {
  priceHistory.mockResolvedValue({ points: [], now: 10, today: TODAY });
  renderDialog();

  expect(await screen.findByText(NO_HISTORY_SENTENCE)).toBeInTheDocument();
  expect(screen.getByText("$10.00")).toBeInTheDocument();
  // No change figure is claimed against a baseline nobody has.
  expect(screen.queryByText(/^Change over/)).not.toBeInTheDocument();
});

it("hands the caret back to the row that opened it when dismissed", async () => {
  const user = userEvent.setup();
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();

  renderDialog();
  await screen.findByRole("dialog");

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  expect(useAppStore.getState().priceHistory).toBeNull();

  opener.remove();
});
