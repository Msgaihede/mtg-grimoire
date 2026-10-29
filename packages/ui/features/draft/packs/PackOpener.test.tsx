import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { BoosterCard, BoosterSet, PrintingPrices, SetSummary } from "@/lib/ipc";
import { PRICES, PRODUCT, SET as FIXTURE } from "../booster/fixture";
import { formatPrice } from "@/lib/prices";
import { pickOption } from "@/test-dropdown";

/** Every card the fixture's sheets name, in the corpus, but for one MTGJSON alone knows. */
const CARDS: BoosterCard[] = [
  ...new Set(PRODUCT.sheets.flatMap((s) => s.cards.map((c) => c.cardId))),
]
  .concat("promo")
  .map((cardId) => ({
    cardId,
    name: `Card ${cardId}`,
    setCode: "tst",
    collectorNumber: "1",
    rarity: cardId === "mythic" ? "mythic" : cardId === "rare" ? "rare" : "common",
    typeLine: null,
    manaCost: null,
    cmc: null,
    colors: cardId.startsWith("c-") ? cardId[2].toUpperCase() : "",
    inCorpus: cardId !== "land",
  }));

const SET: BoosterSet = { ...FIXTURE, cards: CARDS, fetchedAt: Date.now() };

const SUMMARY: SetSummary = {
  code: "tst",
  name: "Test Set",
  setType: "expansion",
  releasedAt: "2026-01-01",
  cardCount: 30,
};

const SEED = 1234;

const listSets = vi.hoisted(() => vi.fn());
const packsBoosterSet = vi.hoisted(() => vi.fn());
const printingPrices = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { listSets, packsBoosterSet, printingPrices, getMarketplace, marketplaceFeedStatus },
}));

vi.mock("../booster/rng", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../booster/rng")>()),
  randomSeed: () => SEED,
}));

import { packValue, finishPrice } from "../booster/value";
import { openOne } from "./opening";
import { PackOpener } from "./PackOpener";

function setup() {
  listSets.mockResolvedValue([SUMMARY]);
  packsBoosterSet.mockResolvedValue(SET);
  printingPrices.mockImplementation(async (ids: string[]): Promise<PrintingPrices[]> =>
    ids.flatMap((cardId) => {
      const finishPrices = PRICES.get(cardId);
      return finishPrices ? [{ cardId, finishPrices }] : [];
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PackOpener onBack={onBack} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onBack };
}

describe("PackOpener", () => {
  it("opens a booster: its cards, its total and the product's figures", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    expect(packsBoosterSet).toHaveBeenCalledWith("tst", false);
    // The prices land before Open is pressed, so the total is final at once.
    await screen.findByText(/^Expected value/);
    await user.click(screen.getByRole("button", { name: "Open" }));

    const expected = openOne(SET, { kind: "booster", id: "collector", name: "" }, SEED);
    const wall = screen.getByRole("list", { name: "Opened cards" });
    expect(within(wall).getAllByRole("listitem")).toHaveLength(7);
    // The land is not in the corpus, so it is never asked a price: it counts 0.
    const total = packValue(expected.cards, (id, foil) =>
      id === "land" ? null : finishPrice(PRICES.get(id), foil),
    );
    expect(total).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /Total value/ })).toHaveTextContent(
      formatPrice(total, "usd"),
    );
    // The land is MTGJSON's alone here: a name tile, not a button.
    expect(within(wall).getByText("Card land")).toBeInTheDocument();
    expect(within(wall).queryByRole("button", { name: /Card land/ })).toBeNull();

    const figures = screen.getByRole("complementary", { name: "Figures" });
    expect(within(figures).getByText("Theoretical").nextSibling).toHaveTextContent(
      // `value.test.ts`' 4.225, less the land's 50¢ — it is not in this corpus.
      formatPrice(3.725, "usd"),
    );
    expect(
      within(figures).getByText(
        (_, el) =>
          el?.tagName === "P" &&
          /^Your pack is in the \d+(st|nd|rd|th) percentile\.$/.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
    expect(within(figures).getByText("Opened").nextSibling).toHaveTextContent("1");
  });

  it("answers what you paid with the chance to beat it", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.type(screen.getByLabelText("What you paid"), "1");
    // Every pack holds a rare and the land: none is worth $1 or less.
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("opens a sealed product: every booster in it", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    await pickOption(user, "Product", /Test Play Booster Box/);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const wall = screen.getByRole("list", { name: "Opened cards" });
    // Five boosters of seven, and the bundle's promo.
    expect(within(wall).getAllByRole("listitem")).toHaveLength(36);
    expect(screen.getByText(/3 items in it could not be opened/)).toBeInTheDocument();
  });

  it("says the host's refusal and retries", async () => {
    const { user } = setup();
    packsBoosterSet.mockRejectedValueOnce("MTGJSON could not be reached.");
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("MTGJSON could not be reached.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument());
  });

  it("walks back up the trail", async () => {
    const { user, onBack } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await user.click(screen.getByRole("button", { name: /Open Packs, choose another set/ }));
    expect(await screen.findByRole("list", { name: "Sets to open" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Draft & Packs/ }));
    expect(onBack).toHaveBeenCalled();
  });
});
