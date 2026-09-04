import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { CardDetail } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const cardDetail = vi.fn();
const getMarketplace = vi.fn();
/** Read beside the setting by `useMarketplace`. Nothing here draws a price; this exists only
 *  so that hook's second query resolves rather than rejecting on a handler that is not there. */
const marketplaceFeedStatus = vi.fn();

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
  },
}));

import { LegalityDialog } from "./LegalityDialog";
import { useAppStore } from "@/lib/store";

/**
 * All four statuses on one card, which is what makes this fixture worth having: `standard` is
 * the row `legalityChips` would have dropped, and it is the first assertion of the first test.
 */
const LEGALITIES = JSON.stringify({
  standard: "not_legal",
  modern: "legal",
  vintage: "restricted",
  historic: "banned",
});

const detail: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Ancestral Recall",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "47",
  rarity: "rare",
  layout: "normal",
  lang: "en",
  manaCost: "{U}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Target player draws three cards.",
  illustrationId: "art-a",
  artist: "Mark Poole",
  releasedAt: "1993-08-05",
  legalities: LEGALITIES,
  finishPrices: { nonfoil: null, foil: null, etched: null },
  finishes: '["nonfoil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
  imageUris: null,
};

const card = (over: Partial<CardDetail> = {}): CardDetail => ({ ...detail, ...over });

/**
 * The dialog, opened the way the app opens it — through the store's two writers, in that order.
 *
 * `setSelectedCardId` **clears** `cardOverlay` (an overlay outliving the card under it would be
 * a legality grid for a card nobody has open), so a helper that wrote them the other way round
 * would render a closed dialog and every assertion below would fail for a reason that is not
 * the component's.
 */
function renderWithCard(over: Partial<CardDetail> = {}) {
  cardDetail.mockResolvedValue(card(over));
  useAppStore.getState().setSelectedCardId("p1");
  useAppStore.getState().openCardOverlay("legality");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LegalityDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cardDetail.mockReset();
  // Nobody has chosen one, which is what a fresh install reads.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  useAppStore.setState(useAppStore.getInitialState());
});

it("draws every format including the ones the card is not legal in", async () => {
  // `legalityChips` drops `not_legal` before drawing and the docked pane said so in a caption.
  // This popup shows them, so it reads the JSON directly — a regression to `legalityChips`
  // here would silently lose about half the rows, Standard first among them.
  renderWithCard();

  expect(await screen.findByText("Standard")).toBeInTheDocument();
  expect(screen.getByText("Modern")).toBeInTheDocument();
  expect(screen.getByText("Vintage")).toBeInTheDocument();
  expect(screen.getByText("Historic")).toBeInTheDocument();
});

it("says the status in words, never in colour alone", async () => {
  renderWithCard();

  // Each row's badge carries the word. A reader who cannot tell the green from the red still
  // gets the answer, which is the app's rule wherever a status is coloured.
  const banned = (await screen.findByText("Historic")).closest("li") as HTMLElement;
  expect(within(banned).getByText(/banned/i)).toBeInTheDocument();

  // And the three that are not banned say their own word rather than sharing one absence —
  // `not_legal` in particular, which is the whole reason this surface exists.
  const standard = screen.getByText("Standard").closest("li") as HTMLElement;
  expect(within(standard).getByText(/not legal/i)).toBeInTheDocument();
  const vintage = screen.getByText("Vintage").closest("li") as HTMLElement;
  expect(within(vintage).getByText(/restricted/i)).toBeInTheDocument();
});

it("draws a format FORMAT_ORDER has never heard of, last rather than not at all", async () => {
  // Scryfall adds formats without asking — `timeless`, `predh` and `oathbreaker` all arrived
  // after the field lists that were published at the time. A key this build cannot rank goes
  // last and is still drawn, which is the whole direction this surface exists to protect: a
  // format a reader plays, silently missing, reads as data that failed to load.
  renderWithCard({ legalities: JSON.stringify({ explorer: "legal", modern: "legal" }) });

  await screen.findByText("Modern");
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Modern");
  // Capitalised by the rule rather than dropped or drawn raw — which is also the right name
  // for the real Arena format this key belongs to.
  expect(rows[1]).toHaveTextContent("Explorer");
});

it("asks for nothing until a reader opens it", () => {
  // Mounted for the whole life of the app beside the card modal, so a card merely being open
  // must cost no `card_detail` round trip of its own — the query function is `skipToken` until
  // the rail entry is pressed.
  useAppStore.getState().setSelectedCardId("p1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LegalityDialog />
    </QueryClientProvider>,
  );

  expect(cardDetail).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
