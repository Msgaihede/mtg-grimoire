import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Spec } from "@json-render/core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MARKETPLACE, MARKETPLACES } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";

import { catalog, catalogContract, catalogPrompt, CATALOG_RULES } from "./catalog";
import { SpecView, type SpecHost } from "./SpecView";
import {
  DECKS_EXAMPLE,
  EXAMPLES,
  FILTER_EXAMPLE,
  GALLERY_EXAMPLE,
  RARITY_EXAMPLE,
  SETTINGS_EXAMPLE,
} from "./examples";
import { executeAction, registry } from "./registry";
import { settingsFace } from "./widgetState";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(spec: Spec, state?: Record<string, unknown>, host?: SpecHost) {
  return render(<SpecView spec={spec} state={state} host={host} />, { wrapper });
}

const money = (value: number) => formatPrice(value, MARKETPLACES[DEFAULT_MARKETPLACE].currency);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // The marketplace, so `useMarketplace` resolves without a Tauri window.
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

/** The catalogue is what a model is told it may use, and the registry is what draws it — a name
 *  on one side only is a widget that validates and then draws nothing, or a component no model
 *  is ever told about. */
describe("the catalogue and the registry", () => {
  it("draw the same components", () => {
    expect(Object.keys(registry).sort()).toEqual([...catalog.componentNames].sort());
  });

  it("draws every component in some example, so a story shows each one", () => {
    const drawn = new Set(
      Object.values(EXAMPLES).flatMap((spec) => Object.values(spec.elements).map((e) => e.type)),
    );
    expect(catalog.componentNames.filter((name) => !drawn.has(name))).toEqual([]);
  });

  it("tells a model about every component, action and function", () => {
    const prompt = catalog.prompt();
    for (const name of [...catalog.componentNames, ...catalog.actionNames]) {
      expect(prompt).toContain(name);
    }
    for (const name of ["formatPrice", "formatNumber", "formatPercent", "formatDate"]) {
      expect(prompt).toContain(name);
    }
  });

  it("adds this app's rules to json-render's prompt", () => {
    const prompt = catalogPrompt();
    for (const rule of CATALOG_RULES) expect(prompt).toContain(rule);
  });

  /**
   * **The prompt and the contract, as files** — what the desktop's MCP server will hand a model
   * and check a spec against, read by Rust with no TypeScript running. Held to the catalogue here
   * as `crates/grimoire-graph/schema.graphql` is to the graph; `pnpm vitest run -u` rewrites them
   * after an intended change, and the diff is the review.
   */
  it("matches the committed prompt and contract", async () => {
    await expect(catalogPrompt() + "\n").toMatchFileSnapshot("./catalog.prompt.md");
    await expect(JSON.stringify(catalogContract(), null, 2) + "\n").toMatchFileSnapshot(
      "./catalog.contract.json",
    );
  });

  it.each(Object.entries(EXAMPLES))("validates the %s example", (_, spec) => {
    const result = catalog.validate(spec);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("refuses a component the catalogue does not have", () => {
    const spec = {
      root: "x",
      elements: { x: { type: "Iframe", props: { src: "https://example.com" } } },
    };
    expect(catalog.validate(spec).success).toBe(false);
  });

  it("refuses a colour outside the palette", () => {
    const spec = {
      root: "x",
      elements: {
        x: {
          type: "Bars",
          props: { bars: [{ label: "a", value: 1, color: "#ff00ff" }], money: null, fill: null },
        },
      },
    };
    expect(catalog.validate(spec).success).toBe(false);
  });
});

describe("drawing a spec", () => {
  it("draws figures and rows from state, with money at the reader's currency", () => {
    draw(DECKS_EXAMPLE);

    expect(screen.getByText(money(1234.5))).toBeInTheDocument();
    expect(screen.getByText("Atraxa Superfriends")).toBeInTheDocument();
    expect(screen.getByText("Mono-Red Burn")).toBeInTheDocument();
    expect(screen.getByText(money(301.1))).toBeInTheDocument();
    expect(screen.getAllByText("3 decks · 1 complete").length).toBeGreaterThan(0);
  });

  it("opens a deck from a row whose press is bound, view first", async () => {
    draw(DECKS_EXAMPLE);

    await userEvent.click(screen.getByRole("button", { name: /Mono-Red Burn/ }));

    await expect.poll(() => useAppStore.getState().openDeckId).toBe(9);
    expect(useAppStore.getState().activeView).toBe("decks");
  });

  it("keeps a row with no press bound a picture, not a button", () => {
    const unbound = { ...DECKS_EXAMPLE.elements.deck, on: undefined };
    draw({ ...DECKS_EXAMPLE, elements: { ...DECKS_EXAMPLE.elements, deck: unbound } });

    expect(screen.getByText("Elves")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Elves/ })).toBeNull();
  });

  it("writes an input to the widget's own state, which a visible condition reads", async () => {
    draw(RARITY_EXAMPLE);

    expect(screen.getByText("Mythic")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Show breakdown" }));
    expect(screen.queryByText("Mythic")).toBeNull();
  });

  it("narrows rows by the widget's own chips and price range", async () => {
    draw(FILTER_EXAMPLE);

    // The range's ceiling starts at 100, so The One Ring is out before anything is pressed.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("Sol Ring")).toBeInTheDocument();
    expect(screen.queryByText("The One Ring")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Foil" }));
    expect(screen.queryByText("Lightning Bolt")).toBeNull();
    expect(screen.getByText("Sol Ring")).toBeInTheDocument();
  });

  it("binds a segmented choice, a chip and a stepper to state", async () => {
    draw(GALLERY_EXAMPLE);

    const week = screen.getByRole("button", { name: "Week" });
    expect(week).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(week);
    expect(week).toHaveAttribute("aria-pressed", "true");

    const chip = screen.getByRole("button", { name: "NM, Near mint" });
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");

    const rows = screen.getByRole("spinbutton", { name: "Rows" });
    expect(rows).toHaveValue(5);
    await userEvent.click(screen.getByRole("button", { name: "Increase Rows" }));
    expect(rows).toHaveValue(6);
  });

  it("draws the widgets' own settings controls, bound to state", async () => {
    draw(settingsFace(SETTINGS_EXAMPLE, "face"));

    // The compact stepper: the label, `−`, the count, `+`, and a bound it will not cross.
    expect(screen.getByText("4")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More, Rows" }));
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fewer, Columns" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    const value = screen.getByRole("button", { name: "Value" });
    await userEvent.click(value);
    expect(value).toHaveAttribute("aria-pressed", "true");

    const prices = screen.getByRole("checkbox", { name: "Prices" });
    expect(prices).not.toBeChecked();
    await userEvent.click(prices);
    expect(prices).toBeChecked();

    // The checklist ticks what state holds, and writes the rest back as a list.
    expect(screen.getByRole("checkbox", { name: "Collection value" })).toBeChecked();
    const decks = screen.getByRole("checkbox", { name: "Decks" });
    await userEvent.click(decks);
    expect(decks).toBeChecked();

    expect(screen.getByRole("group", { name: "Layout" })).toBeInTheDocument();
    expect(screen.getByLabelText("Cards to follow")).toBeInTheDocument();
  });

  it("draws a spec's widget without its settings face, which is the popover's", () => {
    draw(SETTINGS_EXAMPLE);
    expect(screen.getByText("Sorted by recent, 4 rows")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Prices" })).toBeNull();
  });

  it("asks the host to refresh", async () => {
    let refreshed = 0;
    draw(DECKS_EXAMPLE, undefined, { refresh: () => (refreshed += 1) });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expect.poll(() => refreshed).toBe(1);
  });

  it("picks a radio", async () => {
    draw(GALLERY_EXAMPLE);
    const cards = screen.getByRole("radio", { name: "Cards" });
    await userEvent.click(cards);
    expect(cards).toBeChecked();
  });

  it("formats money through a $computed function", () => {
    draw(RARITY_EXAMPLE);
    expect(screen.getByText(money(1534.2))).toBeInTheDocument();
  });

  it("draws a missing price as an em dash, not zero", () => {
    draw({
      root: "p",
      elements: { p: { type: "Price", props: { value: null, tone: null } } },
    });
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

/** Each action is a store hand-off, in the order the hand-written widgets make it. */
describe("the actions", () => {
  const run = (name: string, params: Record<string, unknown>) =>
    executeAction(name, params, () => {});

  it("opens a card", async () => {
    await run("openCard", { cardId: "bolt-lea" });
    expect(useAppStore.getState().selectedCardId).toBe("bolt-lea");
  });

  it("reads a param that arrives as a state path — a `$item` in a repeat", async () => {
    await executeAction("openDeck", { deckId: "/decks/1/id" }, () => {}, DECKS_EXAMPLE.state);
    expect(useAppStore.getState().openDeckId).toBe(9);
  });

  it("opens a card's printings", async () => {
    await run("openPrintings", { cardId: "bolt-lea", oracleId: "o-bolt", name: "Lightning Bolt" });
    expect(useAppStore.getState().printingsRequest).toEqual({
      cardId: "bolt-lea",
      oracleId: "o-bolt",
      name: "Lightning Bolt",
      deck: null,
      wish: null,
    });
  });

  it("searches for text", async () => {
    await run("searchText", { text: "t:creature otag:ramp" });
    expect(useAppStore.getState().activeView).toBe("search");
    expect(useAppStore.getState().pendingSearchText).toBe("t:creature otag:ramp");
  });

  it("shows a query in the collection", async () => {
    await run("showInCollection", { query: "e:lea" });
    expect(useAppStore.getState().activeView).toBe("collection");
    expect(useAppStore.getState().pendingCollectionQuery).toBe("e:lea");
  });

  it("reveals a card in its folder", async () => {
    await run("revealCard", { scope: "wishlist", folderId: null, query: '!"Sol Ring"' });
    expect(useAppStore.getState().activeView).toBe("wishlist");
    expect(useAppStore.getState().pendingReveal).toEqual({
      scope: "wishlist",
      folderId: null,
      query: '!"Sol Ring"',
    });
  });

  it("opens a deck folder", async () => {
    await run("openDeckFolder", { folderId: 3 });
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().pendingDeckFolder).toBe(3);
  });

  it("opens a list's flagged rows, view first", async () => {
    await run("openReview", { scope: "collection" });
    expect(useAppStore.getState().activeView).toBe("collection");
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "collection" });
  });

  it("opens a Settings panel, view first", async () => {
    await run("openSettings", { panel: "prices" });
    expect(useAppStore.getState().activeView).toBe("settings");
    expect(useAppStore.getState().pendingSettingsPanel).toBe("prices");
  });

  it("deals a goldfish game on the open deck", async () => {
    await run("goldfish", { deckId: 7 });
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(7);
    expect(useAppStore.getState().goldfish).toEqual({ deckId: 7, variant: "live" });
  });

  it("opens a folder on its page", async () => {
    await run("openFolder", { scope: "wishlist", folderId: 4 });
    expect(useAppStore.getState().activeView).toBe("wishlist");
    expect(useAppStore.getState().pendingFolder).toEqual({ scope: "wishlist", id: 4 });
  });

  it("goes to a view", async () => {
    await run("openView", { view: "scanner" });
    expect(useAppStore.getState().activeView).toBe("scanner");
  });

  it("shows a set in search", async () => {
    await run("showSet", { setCode: "mh3" });
    expect(useAppStore.getState().pendingSearchSet).toBe("mh3");
  });

  it("opens a price history", async () => {
    await run("openPriceHistory", { cardId: "bolt-lea", finish: "foil" });
    expect(useAppStore.getState().priceHistory).toEqual({
      cardId: "bolt-lea",
      finish: "foil",
      window: "30d",
    });
  });
});
