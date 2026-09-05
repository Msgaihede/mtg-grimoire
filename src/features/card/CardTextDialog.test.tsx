import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardDetail, CardFace } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const cardDetail = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();

/**
 * Every command this dialog's tree can reach, wrapped in an arrow apiece.
 *
 * The arrows are not decoration: `vi.mock` is hoisted above the `const`s above it and the mocked
 * module is pulled in by the component's own imports, so the factory is *evaluated* before those
 * bindings are initialised. Deferring the reference into a call that happens later is what makes
 * that legal — `AllPrintingsDialog.test.tsx` and `CardDetailModal.test.tsx` mock the same module
 * the same way and for the same reason.
 *
 * The two marketplace reads are here because `useMarketplace` is mounted for the key rather than
 * for a price: `card_detail` is priced per finish, so the marketplace is part of its query key,
 * and a key that dropped it would be a second cache entry for a card the modal already has.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
  },
}));

import { CardTextDialog } from "./CardTextDialog";
import { useAppStore } from "@/lib/store";

/**
 * A single-faced card, and the base every fixture below overrides.
 *
 * `faces: []` is the honest default rather than a convenience: Scryfall sends no `card_faces`
 * for a `normal` card *or* for a `meld` one, so the empty array is what most of the game
 * arrives as and the synthesis branch is the one that carries it.
 */
const BOLT: CardDetail = {
  id: "p1",
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
  oracleText: "Deal 3 damage.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: '{"modern":"legal"}',
  finishPrices: { nonfoil: 1.5, foil: null, etched: null },
  finishes: '["nonfoil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
};

const card = (over: Partial<CardDetail>): CardDetail => ({ ...BOLT, ...over });

const face = (over: Partial<CardFace>): CardFace => ({
  name: "",
  typeLine: null,
  oracleText: null,
  manaCost: null,
  artist: null,
  ...over,
});

beforeEach(() => {
  cardDetail.mockReset().mockResolvedValue(BOLT);
  // Nobody has chosen a marketplace, which is what a fresh install reads — so every key below is
  // the default's, TCGplayer.
  getMarketplace.mockReset().mockResolvedValue(null);
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  // The dialog is driven by two store fields and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
});

/**
 * The dialog, opened the way the app opens one: two store writes and nothing else moves.
 *
 * `setSelectedCardId` is written **first** and deliberately — it *clears* `cardOverlay`, because
 * an overlay outliving the card under it would silently re-answer about whichever card the store
 * moved on to. Opening the overlay second is therefore the only order that leaves it open, and a
 * refactor that reversed the two would fail every test in this file.
 */
function open(detail: CardDetail | null) {
  cardDetail.mockResolvedValue(detail);
  useAppStore.getState().setSelectedCardId("p1");
  useAppStore.getState().openCardOverlay("cardText");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CardTextDialog />
    </QueryClientProvider>,
  );
}

describe("CardTextDialog", () => {
  it("draws both faces of a double-faced card", async () => {
    // The mockup shows one picture and the pane's Flip button; the text popup shows both sides at
    // once, because a reader who opened "Card text" is asking what the card does, and half of a
    // transforming card is not an answer. This is the one place this dialog deliberately differs
    // from the `Facts` block it was lifted from, so it is the assertion that pins the difference.
    open(
      card({
        name: "Delver of Secrets // Insectile Aberration",
        layout: "transform",
        faces: [
          face({
            name: "Delver of Secrets",
            typeLine: "Creature — Human Wizard",
            oracleText: "At the beginning of your upkeep…",
            manaCost: "{U}",
          }),
          face({
            name: "Insectile Aberration",
            typeLine: "Creature — Human Insect",
            oracleText: "Flying",
          }),
        ],
      }),
    );

    // The **front** face is awaited first on purpose: it is drawn under every reading of the
    // face resolver, right and wrong alike, so it settles the query rather than the behaviour.
    // Every assertion after it is about the half a one-face reading loses, which is what makes
    // the failure message name the back face instead of the fetch.
    expect(await screen.findByText("Creature — Human Wizard")).toBeInTheDocument();
    expect(screen.getByText("Delver of Secrets")).toBeInTheDocument();
    expect(screen.getByText("Insectile Aberration")).toBeInTheDocument();
    expect(screen.getByText("Creature — Human Insect")).toBeInTheDocument();
    expect(screen.getByText("Flying")).toBeInTheDocument();
  });

  it("falls back to the card's own text when it has no faces", async () => {
    // `faces: []` is a `normal` card and a `meld` one alike — Scryfall sends `card_faces` for
    // neither — so a reading that trusted the array would draw an empty panel for most of the
    // game rather than an error anybody could see.
    open(card({ layout: "normal", faces: [], typeLine: "Instant", oracleText: "Deal 3 damage." }));

    expect(await screen.findByText("Instant")).toBeInTheDocument();
    expect(screen.getByText("Deal 3 damage.")).toBeInTheDocument();
    // The synthesised face carries no name, so the card is named once — by the header's subtitle
    // — rather than twice. `getAllByText` would pass on the duplicate this guards against.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  it("asks for nothing while it is closed", () => {
    // Mounted at `App` level for the whole life of the window, so "closed" has to mean *no
    // query function at all* rather than a disabled one. Without the `skipToken`, every card a
    // reader selected anywhere in the app would fetch `card_detail` for a popup nobody opened.
    useAppStore.getState().setSelectedCardId("p1");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CardTextDialog />
      </QueryClientProvider>,
    );

    expect(cardDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
