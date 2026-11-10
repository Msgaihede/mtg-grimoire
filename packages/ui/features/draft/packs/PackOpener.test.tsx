import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type {
  BoosterCard,
  BoosterSet,
  BoosterSetSummary,
  FinishPrices,
  PrintingPrices,
} from "@/lib/ipc";
import { PRICES, PRODUCT, SET as FIXTURE } from "../booster/fixture";
import { DEFAULT_ZOOM, ZOOM_SECTIONS } from "@/lib/cardZoom";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { openDropdown, pickOption } from "@/test-dropdown";

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

const SUMMARY: BoosterSetSummary = {
  code: "tst",
  name: "Test Set",
  releaseDate: "2026-01-01",
};

const SEED = 1234;

/** The ECB's rate the host answers: $1.25 to the euro. */
const RATE = { usdPerEur: 1.25, date: "2026-10-30", fetchedAt: 0 };

const packsBoosterSets = vi.hoisted(() => vi.fn());
const packsBoosterSet = vi.hoisted(() => vi.fn());
// The host's `packs:refreshed`, held so a test can fire it.
const refreshed = vi.hoisted(() => ({ fire: () => {} }));
const onPacksRefreshed = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    refreshed.fire = cb;
    return () => {};
  }),
);
const printingPrices = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const packsExchangeRate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    packsBoosterSets,
    onPacksRefreshed,
    packsBoosterSet,
    printingPrices,
    getMarketplace,
    marketplaceFeedStatus,
    packsExchangeRate,
  },
}));

vi.mock("../booster/rng", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../booster/rng")>()),
  randomSeed: () => SEED,
}));

import { packValue, finishPrice } from "../booster/value";
import { figuresOf, openOne } from "./opening";
import { openables } from "./products";
import { parseStored, STORAGE_KEY, usePackMarketplaceStore } from "./marketplacePick";
import {
  parseStored as parseReduced,
  STORAGE_KEY as REDUCED_KEY,
  usePackReducedStore,
} from "./reducedPick";
import { PackOpener } from "./PackOpener";

const halved = (p: FinishPrices): FinishPrices => ({
  nonfoil: p.nonfoil === null ? null : p.nonfoil / 2,
  foil: p.foil === null ? null : p.foil / 2,
  etched: p.etched === null ? null : p.etched / 2,
});

/** The Expected value line's figure for the stage's first product, at `priceOf`. */
function expectedLine(
  priceOf: (id: string, foil: boolean) => number | null,
  currency: "usd" | "eur",
) {
  const first = openables(SET)[0];
  const priced = (id: string, foil: boolean) => (id === "land" ? null : priceOf(id, foil));
  return `Expected value ${formatPrice(figuresOf(SET, first, priced).ev, currency)}`;
}

/** The host's `printing_prices` answer at `marketplace`. */
function answerPrices(ids: string[], marketplace: string): PrintingPrices[] {
  return ids.flatMap((cardId) => {
    const finishPrices = PRICES.get(cardId);
    if (!finishPrices) return [];
    // Card Kingdom quotes every card at half, and only the rare and the mythic: the rest is
    // TCGplayer's alone, which is what makes the lowest a per-card answer.
    if (marketplace === "cardkingdom") {
      return cardId === "rare" || cardId === "mythic"
        ? [{ cardId, finishPrices: halved(finishPrices) }]
        : [];
    }
    // Cardmarket quotes the rare alone, at half the dollar figure — in euros.
    if (marketplace === "cardmarket") {
      return cardId === "rare" ? [{ cardId, finishPrices: halved(finishPrices) }] : [];
    }
    return [{ cardId, finishPrices }];
  });
}

function setup() {
  packsBoosterSets.mockResolvedValue([SUMMARY]);
  packsBoosterSet.mockResolvedValue(SET);
  printingPrices.mockImplementation(async (ids: string[], marketplace: string) =>
    answerPrices(ids, marketplace),
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

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  getMarketplace.mockResolvedValue("tcgplayer");
  printingPrices.mockClear();
  packsExchangeRate.mockReset().mockResolvedValue(RATE);
});

describe("PackOpener", () => {
  /** Issue #1433: ctrl+wheel over a set's stage steps the opened wall's own section. */
  it("zooms the opened wall on a ctrl+wheel, and no other wall", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const wall = screen.getByRole("list", { name: "Opened cards" });
    expect(wall.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(152px, 1fr))");

    fireEvent.wheel(wall.closest(".overflow-y-auto")!, { deltaY: -100, ctrlKey: true });

    const { cardZoom, zoomSection } = useAppStore.getState();
    expect(cardZoom.packs).toBe(1.1);
    for (const section of ZOOM_SECTIONS.filter((s) => s !== "packs")) {
      expect(cardZoom[section]).toBe(DEFAULT_ZOOM);
    }
    expect(zoomSection).toBe("packs");
    expect(wall.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(167px, 1fr))");
  });

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
    // The land is MTGJSON's alone here: a tile with no picture, not a button.
    expect(within(wall).getByText("Card land")).toBeInTheDocument();
    expect(within(wall).queryByRole("button", { name: /Card land/ })).toBeNull();
    // Issue #1462: every tile is the app's own, its chin naming the printing — the land's too.
    expect(within(wall).getAllByText("TST · 1")).toHaveLength(7);

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

  /** Issue #1503: the session's tally starts over without a restart; the opened pack stays. */
  it("resets the session's tally, leaving the opened pack on the wall", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Open another" }));

    const expected = openOne(SET, { kind: "booster", id: "collector", name: "" }, SEED);
    const one = packValue(expected.cards, (id, foil) =>
      id === "land" ? null : finishPrice(PRICES.get(id), foil),
    );
    const figures = screen.getByRole("complementary", { name: "Figures" });
    const opened = () => within(figures).getByText("Opened").nextSibling;
    const total = () => within(figures).getByText("Total value").nextSibling;
    expect(opened()).toHaveTextContent("2");
    expect(total()).toHaveTextContent(formatPrice(one * 2, "usd"));

    const reset = within(figures).getByRole("button", { name: "Reset this session" });
    await user.click(reset);
    expect(opened()).toHaveTextContent("0");
    expect(total()).toHaveTextContent(formatPrice(0, "usd"));
    expect(within(figures).getByText("Total expected").nextSibling).toHaveTextContent(
      formatPrice(0, "usd"),
    );
    // Nothing left to reset; the pack just opened is still drawn.
    expect(reset).toBeDisabled();
    expect(screen.getByRole("list", { name: "Opened cards" })).toBeInTheDocument();

    // The next press counts from nothing.
    await user.click(screen.getByRole("button", { name: "Open another" }));
    expect(opened()).toHaveTextContent("1");
    expect(total()).toHaveTextContent(formatPrice(one, "usd"));
    expect(reset).toBeEnabled();
  });

  it("opens a sealed product: every booster in it", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    // Issue #1496: the pick is the first press — no Open after it.
    await pickOption(user, "Product", /Test Play Booster Box/);
    const wall = screen.getByRole("list", { name: "Opened cards" });
    // Five boosters of seven, and the bundle's promo.
    expect(within(wall).getAllByRole("listitem")).toHaveLength(36);
    expect(screen.getByText(/3 items in it could not be opened/)).toBeInTheDocument();
  });

  /** Issue #1496: nobody picks a product and does not want to open it. */
  describe("a product pick opens one", () => {
    const openedCount = () =>
      within(screen.getByRole("complementary", { name: "Figures" })).getByText("Opened")
        .nextSibling;

    it("opens the picked product at once, and a pick of the same one is no press", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByText(/^Expected value/);
      expect(screen.queryByRole("list", { name: "Opened cards" })).toBeNull();

      await pickOption(user, "Product", /Test Collector Booster/);
      const wall = screen.getByRole("list", { name: "Opened cards" });
      expect(within(wall).getAllByRole("listitem")).toHaveLength(7);
      expect(screen.getByRole("button", { name: "Open another" })).toBeInTheDocument();
      expect(openedCount()).toHaveTextContent("1");

      // The list closed on what was already open: the wall and the tally stay as they were.
      await pickOption(user, "Product", /Test Collector Booster/);
      expect(openedCount()).toHaveTextContent("1");

      // Another product is another open, onto the same session's tally.
      await pickOption(user, "Product", /Test Play Booster Box/);
      expect(screen.getByText(/3 items in it could not be opened/)).toBeInTheDocument();
      expect(openedCount()).toHaveTextContent("2");
    });

    it("opens on a pick of the shown product once Back has put the pack down", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByText(/^Expected value/);
      // The stage opens on its first product; picking it is still the reader's first press.
      await pickOption(user, "Product", /Test Collector Booster/);
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.queryByRole("list", { name: "Opened cards" })).toBeNull();
      await pickOption(user, "Product", /Test Collector Booster/);
      expect(screen.getByRole("list", { name: "Opened cards" })).toBeInTheDocument();
      expect(openedCount()).toHaveTextContent("2");
    });

    it("waits for the prices before it opens, so the tally never counts a pack as $0", async () => {
      const { user } = setup();
      // Every price read hangs until the test lets it answer.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      printingPrices.mockImplementation(async (ids: string[], marketplace: string) => {
        await gate;
        return answerPrices(ids, marketplace);
      });
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByRole("button", { name: "Product" });
      expect(screen.queryByText(/^Expected value/)).toBeNull();

      await pickOption(user, "Product", /Test Collector Booster/);
      expect(screen.queryByRole("list", { name: "Opened cards" })).toBeNull();

      await act(async () => release());
      const wall = await screen.findByRole("list", { name: "Opened cards" });
      const expected = openOne(SET, { kind: "booster", id: "collector", name: "" }, SEED);
      const total = packValue(expected.cards, (id, foil) =>
        id === "land" ? null : finishPrice(PRICES.get(id), foil),
      );
      expect(within(wall).getAllByRole("listitem")).toHaveLength(7);
      expect(openedCount()).toHaveTextContent("1");
      const figures = screen.getByRole("complementary", { name: "Figures" });
      // The session's value is the pack's own, priced — not the $0 of an open before the prices.
      expect(within(figures).getAllByText(formatPrice(total, "usd")).length).toBeGreaterThan(0);
    });
  });

  /** Issue #1464: the product picker is a combobox — type to narrow, pick from what is left. */
  it("searches the products by name, kind and category", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    // Named: the marketplace picker beside it is a combobox of its own.
    await openDropdown(user, "Product");
    await user.type(screen.getByRole("combobox", { name: "Search products" }), "sealed bundle");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Test Bundle"),
    ]);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Product" })).toHaveTextContent("Test Bundle");
    await openDropdown(user, "Product");
    await user.type(screen.getByRole("combobox", { name: "Search products" }), "nothing like it");
    expect(screen.getByText("No product matches.")).toBeInTheDocument();
  });

  it("says the host's refusal and retries", async () => {
    const { user } = setup();
    packsBoosterSet.mockRejectedValueOnce("MTGJSON could not be reached.");
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("MTGJSON could not be reached.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument());
  });

  /** Issue #1588: a refused Refresh keeps the cached set and the pack opened from it. */
  it("says a refused Refresh beside the button, leaving the opened pack in place", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("list", { name: "Opened cards" })).toBeInTheDocument();

    packsBoosterSet.mockRejectedValueOnce("MTGJSON could not be reached.");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refresh failed: MTGJSON could not be reached.",
    );
    expect(packsBoosterSet).toHaveBeenLastCalledWith("tst", true);
    expect(screen.getByRole("list", { name: "Opened cards" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    // A Refresh that goes through clears the sentence.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("draws MTGJSON's set list, says its refusal and retries", async () => {
    // Queued before the first render's fetch; a `Once` answer outranks setup's default.
    packsBoosterSets.mockClear().mockRejectedValueOnce("MTGJSON could not be reached.");
    const { user } = setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("MTGJSON could not be reached.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Test Set/ })).toBeInTheDocument();
    expect(packsBoosterSets).toHaveBeenCalledTimes(2);
  });

  it("asks MTGJSON's sets again when the host fetched them beside a card sync", async () => {
    packsBoosterSets.mockClear();
    setup();
    expect(await screen.findByRole("button", { name: /Test Set/ })).toBeInTheDocument();
    packsBoosterSets.mockResolvedValue([
      SUMMARY,
      { code: "nxt", name: "Next Set", releaseDate: "2026-02-01" },
    ]);
    act(() => refreshed.fire());
    expect(await screen.findByRole("button", { name: /Next Set/ })).toBeInTheDocument();
    expect(packsBoosterSets).toHaveBeenCalledTimes(2);
  });

  /** Issues #1446 and #1463: several marketplaces, and the lowest price any of them quotes. */
  describe("prices from several marketplaces", () => {
    const tcg = (id: string, foil: boolean) => finishPrice(PRICES.get(id), foil);
    const lowest = (id: string, foil: boolean) =>
      id === "rare" || id === "mythic" ? finishPrice(halved(PRICES.get(id)!), foil) : tcg(id, foil);
    /** TCGplayer's dollars against Cardmarket's euros at $1.25: the rare is half of TCGplayer's in
     *  euros, so 0.625 of it in dollars, and every other card TCGplayer's alone. */
    const mixed = (id: string, foil: boolean) => {
      const price = tcg(id, foil);
      return id === "rare" && price !== null ? price * 0.625 : price;
    };

    const chips = () =>
      within(screen.getByRole("list", { name: "Marketplaces priced at" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent);

    async function openStage(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByText(/^Expected value/);
      return screen.getByRole("combobox", { name: "Prices from" });
    }

    it("starts at the app's marketplace, and prices at the lowest of the ones picked", async () => {
      const { user } = setup();
      const box = await openStage(user);
      expect(chips()).toEqual(["TCGplayer"]);
      expect(screen.getByText(/^Expected value/)).toHaveTextContent(expectedLine(tcg, "usd"));

      await user.click(box);
      await user.click(screen.getByRole("option", { name: /Card Kingdom/ }));

      expect(chips()).toEqual(["TCGplayer", "Card Kingdom"]);
      expect(screen.getByRole("option", { name: /Card Kingdom/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(printingPrices).toHaveBeenCalledWith(expect.any(Array), "cardkingdom");
      await waitFor(() =>
        expect(screen.getByText(/^Expected value/)).toHaveTextContent(expectedLine(lowest, "usd")),
      );
      expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual([
        "tcgplayer",
        "cardkingdom",
      ]);
      // One currency: nothing converted, so no rate asked and no line about one.
      expect(packsExchangeRate).not.toHaveBeenCalled();
      expect(screen.queryByText(/ECB/)).not.toBeInTheDocument();
    });

    it("searches the marketplaces as you type, and Enter picks the first match", async () => {
      const { user } = setup();
      const box = await openStage(user);
      await user.type(box, "king");
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Card KingdomUSD"]);
      await user.keyboard("{Enter}");
      expect(chips()).toEqual(["TCGplayer", "Card Kingdom"]);
      expect(box).toHaveValue("");

      await user.type(box, "eur");
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "CardmarketEUR",
        "Card traderEUR",
      ]);
      await user.clear(box);
      await user.type(box, "zzz");
      expect(screen.getByText("No marketplace matches “zzz”.")).toBeInTheDocument();
    });

    it("walks the rows with the arrow keys, passing over one that cannot be pressed", async () => {
      const { user } = setup();
      const box = await openStage(user);
      await user.click(box);
      // TCGplayer, Cardmarket, Card Kingdom, Mana Pool — and up from the first, Card trader is
      // passed over for Mana Pool.
      await user.keyboard("{ArrowUp}");
      const active = box.getAttribute("aria-activedescendant");
      expect(document.getElementById(active!)).toHaveTextContent("Mana Pool");
      expect(screen.getByRole("option", { name: /Card trader/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.keyboard("{Enter}");
      expect(chips()).toEqual(["TCGplayer", "Mana Pool"]);
    });

    it("prices TCGplayer and Cardmarket together, in the app's currency at the ECB's rate", async () => {
      const { user } = setup();
      const box = await openStage(user);
      await user.click(box);
      await user.click(screen.getByRole("option", { name: /Cardmarket/ }));

      expect(chips()).toEqual(["TCGplayer", "Cardmarket"]);
      expect(packsExchangeRate).toHaveBeenCalledTimes(1);
      expect(printingPrices).toHaveBeenCalledWith(expect.any(Array), "cardmarket");
      await waitFor(() =>
        expect(screen.getByText(/^Expected value/)).toHaveTextContent(expectedLine(mixed, "usd")),
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Lowest of TCGplayer and Cardmarket, in dollars — converted at €1 = $1.2500, the ECB's rate of 2026-10-30.",
      );
    });

    it("leaves the other currency out, and says so, when the rate cannot be had", async () => {
      packsExchangeRate.mockReset().mockRejectedValue("The exchange rate could not be fetched.");
      const { user } = setup();
      const box = await openStage(user);
      await user.click(box);
      await user.click(screen.getByRole("option", { name: /Cardmarket/ }));

      expect(chips()).toEqual(["TCGplayer", "Cardmarket"]);
      expect(
        await screen.findByText(/^Cardmarket left out: the exchange rate could not be fetched/),
      ).toBeInTheDocument();
      expect(screen.getByText(/^Expected value/)).toHaveTextContent(expectedLine(tcg, "usd"));
      expect(printingPrices).not.toHaveBeenCalledWith(expect.any(Array), "cardmarket");
    });

    it("puts a chip down with its ✕ or Backspace, but never the last", async () => {
      const { user } = setup();
      const box = await openStage(user);
      // The one picked has no ✕, and pressing its row keeps it.
      expect(screen.queryByRole("button", { name: /Stop pricing at/ })).not.toBeInTheDocument();
      await user.click(box);
      await user.click(screen.getByRole("option", { name: /TCGplayer/ }));
      expect(chips()).toEqual(["TCGplayer"]);

      await user.click(screen.getByRole("option", { name: /Card Kingdom/ }));
      await user.click(screen.getByRole("option", { name: /Mana Pool/ }));
      expect(chips()).toEqual(["TCGplayer", "Card Kingdom", "Mana Pool"]);
      await user.click(screen.getByRole("button", { name: "Stop pricing at Card Kingdom" }));
      expect(chips()).toEqual(["TCGplayer", "Mana Pool"]);
      await user.keyboard("{Backspace}");
      expect(chips()).toEqual(["TCGplayer"]);
      await user.keyboard("{Backspace}");
      expect(chips()).toEqual(["TCGplayer"]);
    });

    it("opens on the pick this device remembers, not the app's marketplace", async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["cardkingdom", "tcgplayer"]));
      // The store reads the device's pick once, as the window loads; this is that load.
      usePackMarketplaceStore.setState({
        stored: parseStored(window.localStorage.getItem(STORAGE_KEY)),
      });
      getMarketplace.mockResolvedValue("cardmarket");
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await waitFor(() =>
        expect(screen.getByText(/^Expected value/)).toHaveTextContent(expectedLine(lowest, "usd")),
      );
      expect(chips()).toEqual(["TCGplayer", "Card Kingdom"]);
      expect(printingPrices).not.toHaveBeenCalledWith(expect.any(Array), "cardmarket");
    });
  });

  /** The page's own sell percentage and minimum, apart from Settings' collection value. */
  describe("the reduced price", () => {
    /** The opened pack's prices as the page reads them: the land is not in the corpus. */
    const priceOf = (id: string, foil: boolean) =>
      id === "land" ? null : finishPrice(PRICES.get(id), foil);

    /** `(full − below the minimum) × percent + cards below × bulk`, worked here rather than by the
     *  page's own helper. */
    function reducedOf(
      prices: (number | null)[],
      percent: number,
      minimum: number,
      bulk = 0,
    ): number {
      const full = prices.reduce<number>((s, p) => s + (p ?? 0), 0);
      const under = prices.filter((p): p is number => p !== null && p < minimum);
      const below = under.reduce((s, p) => s + p, 0);
      const sold = Math.round((full - below) * percent) / 100;
      return Math.round((sold + under.length * bulk) * 100) / 100;
    }

    it("draws none until a figure is set", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByText(/^Expected value/);
      await user.click(screen.getByRole("button", { name: "Open" }));
      expect(screen.queryByRole("button", { name: /^Reduced price/ })).toBeNull();
    });

    /** Issue #1502: set, the reduced price is the figure — the opening's, the session's, and every
     *  expected and simulated value — and the cards it leaves out are drawn red. */
    it("makes it every figure on the page, and keeps the figures", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByText(/^Expected value/);
      await user.type(screen.getByLabelText("Sell at"), "50");
      await user.type(screen.getByLabelText("Minimum"), "0.50{Enter}");
      await user.click(screen.getByRole("button", { name: "Open" }));

      const expected = openOne(SET, { kind: "booster", id: "collector", name: "" }, SEED);
      const prices = expected.cards.map((c) => priceOf(c.cardId, c.foil));
      // The commons, at 10¢, are under the minimum: the reduced price is not merely half.
      expect(prices.some((p) => p !== null && p < 0.5)).toBe(true);
      const money = formatPrice(reducedOf(prices, 50, 0.5), "usd");

      const heading = screen.getByRole("heading", { name: /Total value/ });
      expect(
        within(heading).getByRole("button", { name: `Reduced price ${money}` }),
      ).toBeInTheDocument();
      // The full value is not drawn: only the tooltip's breakdown states it.
      expect(heading).not.toHaveTextContent(formatPrice(packValue(expected.cards, priceOf), "usd"));
      expect(heading).not.toHaveTextContent(`(${money})`);
      const figures = screen.getByRole("complementary", { name: "Figures" });
      expect(
        within(figures).getByRole("button", { name: `Reduced price ${money}` }),
      ).toBeInTheDocument();

      // The expected value is figured at the same prices, card by card.
      const reducedPriceOf = (id: string, foil: boolean) => {
        const p = priceOf(id, foil);
        return p === null ? null : p < 0.5 ? 0 : p / 2;
      };
      const reducedEv = figuresOf(
        SET,
        { kind: "booster", id: "collector", name: "" },
        reducedPriceOf,
      ).ev;
      expect(within(figures).getByText("Theoretical").nextElementSibling).toHaveTextContent(
        formatPrice(reducedEv, "usd"),
      );
      expect(within(figures).getByText("Total expected").nextElementSibling).toHaveTextContent(
        formatPrice(reducedEv, "usd"),
      );
      expect(
        within(figures).getByText("Cards under $0.50 are not counted; the rest at 50%."),
      ).toBeInTheDocument();

      // Each card under the minimum has its price in red, and says why.
      const under = prices.filter((p) => p !== null && p < 0.5).length;
      const wall = screen.getByRole("list", { name: "Opened cards" });
      const marked = within(wall).getAllByText(/under the \$0\.50 minimum: not counted/);
      expect(marked).toHaveLength(under);
      for (const m of marked) expect(m.parentElement).toHaveClass("text-destructive");

      expect(parseReduced(window.localStorage.getItem(REDUCED_KEY))).toEqual({
        sellPercent: 50,
        minimumValue: 0.5,
        bulkPrice: 0,
      });
    });

    /** Issue #1477: each card under the minimum is worth the bulk price instead of nothing. */
    it("counts the cards under the minimum at the bulk price, once a minimum is set", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await screen.findByText(/^Expected value/);
      // A bulk price prices the cards under the minimum: with none, there is nothing to price.
      expect(screen.getByLabelText("Bulk")).toBeDisabled();
      await user.type(screen.getByLabelText("Sell at"), "50");
      await user.type(screen.getByLabelText("Minimum"), "0.50{Enter}");
      expect(screen.getByLabelText("Bulk")).toBeEnabled();
      await user.type(screen.getByLabelText("Bulk"), "0.05{Enter}");
      await user.click(screen.getByRole("button", { name: "Open" }));

      const expected = openOne(SET, { kind: "booster", id: "collector", name: "" }, SEED);
      const prices = expected.cards.map((c) => priceOf(c.cardId, c.foil));
      const money = formatPrice(reducedOf(prices, 50, 0.5, 0.05), "usd");
      expect(money).not.toBe(formatPrice(reducedOf(prices, 50, 0.5), "usd"));
      expect(screen.getAllByRole("button", { name: `Reduced price ${money}` })).toHaveLength(2);

      expect(parseReduced(window.localStorage.getItem(REDUCED_KEY))).toEqual({
        sellPercent: 50,
        minimumValue: 0.5,
        bulkPrice: 0.05,
      });
    });

    it("refuses a bulk price it cannot read and keeps nothing", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await user.type(await screen.findByLabelText("Minimum"), "1{Enter}");
      await user.type(screen.getByLabelText("Bulk"), "cheap");
      await user.tab();
      expect(screen.getByText("Bulk has to be a price of zero or more.")).toBeInTheDocument();
      expect(usePackReducedStore.getState().settings.bulkPrice).toBe(0);
    });

    it("opens on the figures this device remembers", async () => {
      window.localStorage.setItem(
        REDUCED_KEY,
        JSON.stringify({ sellPercent: 70, minimumValue: 0 }),
      );
      // The store reads the device's figures once, as the window loads; this is that load.
      usePackReducedStore.setState({
        settings: parseReduced(window.localStorage.getItem(REDUCED_KEY)),
      });
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      expect(await screen.findByLabelText("Sell at")).toHaveValue("70");
      expect(screen.getByLabelText("Minimum")).toHaveValue("");
      await screen.findByText(/^Expected value/);
      await user.click(screen.getByRole("button", { name: "Open" }));

      const expected = openOne(SET, { kind: "booster", id: "collector", name: "" }, SEED);
      const prices = expected.cards.map((c) => priceOf(c.cardId, c.foil));
      expect(
        screen.getAllByRole("button", {
          name: `Reduced price ${formatPrice(reducedOf(prices, 70, 0), "usd")}`,
        }),
      ).toHaveLength(2);
    });

    it("refuses a percentage out of bounds and keeps nothing", async () => {
      const { user } = setup();
      await user.click(await screen.findByRole("button", { name: /Test Set/ }));
      await user.type(await screen.findByLabelText("Sell at"), "150");
      await user.tab();
      expect(screen.getByText("Sell at has to be above 0 and at most 100%.")).toBeInTheDocument();
      expect(window.localStorage.getItem(REDUCED_KEY)).toBeNull();
      expect(usePackReducedStore.getState().settings.sellPercent).toBe(100);
    });
  });

  /** Issue #1466: another set from the set page's bar, searched by name or code. */
  it("switches to another set from the bar's searchable set picker", async () => {
    const NEXT: BoosterSetSummary = { code: "nxt", name: "Next Set", releaseDate: "2026-02-01" };
    // Queued before the first render's fetch; a `Once` answer outranks setup's default.
    packsBoosterSets.mockResolvedValueOnce([SUMMARY, NEXT]);
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /Test Set/ }));
    await screen.findByText(/^Expected value/);

    const trigger = screen.getByRole("button", { name: "Set" });
    expect(trigger).toHaveTextContent("Test Set");
    // The page holds other comboboxes (the product and marketplace pickers): type into this one's.
    await openDropdown(user, "Set");
    await user.type(screen.getByRole("combobox", { name: "Search sets" }), "NXT");
    // The code finds it, as the wall's filter does; the page's own set is filtered out.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Next Set"),
    ]);
    await user.click(screen.getByRole("option", { name: /Next Set/ }));

    expect(packsBoosterSet).toHaveBeenCalledWith("nxt", false);
    expect(await screen.findByRole("heading", { name: "Next Set" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set" })).toHaveTextContent("Next Set");
    // The trail still walks back to the wall from the new set.
    expect(
      screen.getByRole("button", { name: /Open Packs, choose another set/ }),
    ).toBeInTheDocument();
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
