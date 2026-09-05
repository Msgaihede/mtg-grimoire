import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardDetail, OracleTagStatus } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const cardDetail = vi.fn();
const oracleTagsForCards = vi.fn();
const oracleTagsStatus = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();

/**
 * Every command this dialog's tree can reach, wrapped in an arrow apiece.
 *
 * The arrows are not decoration: `vi.mock` is hoisted above the `const`s above it and the mocked
 * module is pulled in by the component's own imports, so the factory is *evaluated* before those
 * bindings are initialised. Deferring the reference into a call that happens later is what makes
 * that legal — `AllPrintingsDialog.test.tsx` mocks the same module the same way.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (cardId: string, marketplace: MarketplaceId) => cardDetail(cardId, marketplace),
    oracleTagsForCards: (oracleIds: string[]) => oracleTagsForCards(oracleIds),
    oracleTagsStatus: () => oracleTagsStatus(),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
  },
}));

import { OracleTagsDialog } from "./OracleTagsDialog";
import { useAppStore } from "@/lib/store";

/** A card the dialog can name itself after. Only three of its fields are read here — the id, the
 *  name in the subtitle and the oracle id the tag read is keyed on — and the rest are filled so
 *  the fixture is a real `CardDetail` rather than a cast. */
function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
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
    illustrationId: "art-1",
    artist: "Christopher Rush",
    releasedAt: "1993-08-05",
    legalities: null,
    finishPrices: { nonfoil: null, foil: null, etched: null },
    finishes: '["nonfoil"]',
    promoTypes: null,
    imageStatus: "highres_scan",
    faces: [],
    ...over,
  };
}

/** A taxonomy that has never been ingested — every field null, `stale: true`. The state every
 *  install is on its first launch, and the one {@link NEVER_FETCHED}'s sentence is about. */
const NEVER_INGESTED: OracleTagStatus = {
  updatedAt: null,
  ingestedAt: null,
  checkedAt: null,
  tagCount: null,
  taggingCount: null,
  stale: true,
  refreshing: false,
};

/** The same row for a database that has the file: one real stamp is all the dialog reads. */
const INGESTED: OracleTagStatus = {
  ...NEVER_INGESTED,
  // Scryfall's own stamp for the file, which is a string rather than a clock reading — the two
  // date-ish fields on this row are different kinds of thing and the DTO says so.
  updatedAt: "2026-08-20T09:00:00.000+00:00",
  ingestedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  tagCount: 12_000,
  taggingCount: 1_400_000,
  stale: false,
};

beforeEach(() => {
  cardDetail.mockReset().mockResolvedValue(card());
  oracleTagsForCards.mockReset().mockResolvedValue([]);
  // The taxonomy is *here* by default, so the empty-answer test below has to stage its own
  // never-fetched world rather than getting one from a lazy fixture. A default that already
  // said "never ingested" would make that test pass for the wrong reason.
  oracleTagsStatus.mockReset().mockResolvedValue(INGESTED);
  // Nobody has chosen a marketplace, which is what a fresh install reads.
  getMarketplace.mockReset().mockResolvedValue(null);
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  // The dialog is driven by two store fields and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
});

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/**
 * The dialog with a card open under it and the overlay raised — the two store writes a press on
 * the card modal's `Oracle tags` row makes, and nothing else.
 *
 * **The overlay is opened on every render, the third test included.** Every read in the component
 * is gated on the open flag, so a test that left it closed would assert `not.toHaveBeenCalled()`
 * about a dialog that was never asked anything — a pass that proves nothing about the oracle id.
 */
function renderWithCard(over: Partial<CardDetail> = {}) {
  cardDetail.mockResolvedValue(card(over));
  useAppStore.setState({ selectedCardId: "c1" });
  useAppStore.getState().openCardOverlay("oracleTags");
  return render(wrap(<OracleTagsDialog />));
}

it("lists the card's oracle tags as pills", async () => {
  oracleTagsForCards.mockResolvedValue([{ oracleId: "o1", slugs: ["removal", "burn"] }]);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText("removal")).toBeInTheDocument();
  expect(screen.getByText("burn")).toBeInTheDocument();
  // The card names the panel, so a reader who opened three overlays in a row can tell which card
  // this one is about without closing it.
  expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
});

it("says the taxonomy has never been fetched rather than drawing an empty box", async () => {
  // CLAUDE.md: a database that has never fetched oracle tags files by card type instead, and that
  // fallback is the floor rather than an error. An empty panel would read as "this card has no
  // tags", which is a different and wrong claim.
  //
  // **The status row is what makes the sentence sayable at all.** `oracle_tags_for_cards` answers
  // an empty slug list for an untagged card, an unknown id *and* a database with no taxonomy —
  // deliberately, because every categorising caller treats all three the same — so the empty
  // answer below cannot on its own tell which world this is.
  oracleTagsForCards.mockResolvedValue([]);
  oracleTagsStatus.mockResolvedValue(NEVER_INGESTED);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText(/no oracle tags/i)).toBeInTheDocument();
  expect(screen.getByText(/has not been downloaded/i)).toBeInTheDocument();
});

it("says the card is untagged when the taxonomy is here and answers nothing", async () => {
  // The other half of the split the status row buys, and the reason the first sentence is not
  // simply drawn for every empty answer: with the file ingested, "not downloaded" would be the
  // wrong claim in the same way an empty box is.
  oracleTagsForCards.mockResolvedValue([{ oracleId: "o1", slugs: [] }]);
  oracleTagsStatus.mockResolvedValue(INGESTED);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText(/nothing on record for this card/i)).toBeInTheDocument();
  expect(screen.queryByText(/has not been downloaded/i)).not.toBeInTheDocument();
});

it("does not ask for tags for a card with no oracle id", async () => {
  renderWithCard({ oracleId: null });

  // Awaited rather than asserted straight after `render`: the tag read is downstream of the card
  // read, so a bare synchronous check would pass before the card had even resolved and would go
  // on passing with the guard deleted. Waiting for the sentence this state draws is what puts the
  // component past the point where it would have asked.
  expect(await screen.findByText(/not linked to an oracle card/i)).toBeInTheDocument();
  expect(oracleTagsForCards).not.toHaveBeenCalled();
});

it("asks nothing at all until the overlay is opened", async () => {
  // What lets `App` mount this beside the card modal unconditionally: a dialog nobody opened
  // costs no query. Only the overlay field differs from `renderWithCard`.
  useAppStore.setState({ selectedCardId: "c1" });
  render(wrap(<OracleTagsDialog />));

  await Promise.resolve();
  expect(cardDetail).not.toHaveBeenCalled();
  expect(oracleTagsForCards).not.toHaveBeenCalled();
  expect(oracleTagsStatus).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("says where the tags came from, and does not blame the card sync for their age", async () => {
  // The two Tagger files are separate bulk downloads on a weekly interval of their own, so a
  // caption borrowing `pricesAsOf`'s "as of the last card-data sync" would name the wrong clock —
  // the thing the root CLAUDE.md asks in bold not to blur.
  oracleTagsForCards.mockResolvedValue([{ oracleId: "o1", slugs: ["removal"] }]);
  renderWithCard({ oracleId: "o1" });
  await screen.findByText("removal");

  expect(screen.getByText(/as of the last tag refresh/i)).toBeInTheDocument();
  expect(screen.queryByText(/card-data sync/i)).not.toBeInTheDocument();
});
