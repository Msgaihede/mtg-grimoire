import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one read, in front of an intact mirror — `RecentCardsWidget.test.tsx`'s note. */
const priceMovers = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
const wishlistFolderList = vi.hoisted(() => vi.fn());
const searchCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: { ...actual.ipc, priceMovers, collectionFolderList, wishlistFolderList, searchCards },
  };
});

import type {
  HomeWidget,
  PriceMover,
  PriceMoverDirection,
  PriceMovers,
  PriceMoverWindow,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, type WidgetFit } from "../fit";
import { priceMoversKey } from "../keys";
import {
  CHOSEN_GONE,
  chosenNoHistory,
  emptySentence,
  MAX_CHOSEN_CARDS,
  NO_HISTORY,
  NOTHING_CHOSEN,
  PRICE_MOVERS_READ,
  PriceMoversWidget,
  PriceMoversWidgetSettings,
  signedMoney,
} from "./PriceMoversWidget";

function mover(over: Partial<PriceMover> & { cardId: string; delta: number }): PriceMover {
  const now = 10 + over.delta;
  return {
    name: `Card ${over.cardId}`,
    setCode: "mh2",
    setName: "Modern Horizons 2",
    finish: "nonfoil",
    now,
    then: 10,
    ...over,
  };
}

const LOTUS = mover({
  cardId: "lotus",
  name: "Black Lotus",
  setCode: "lea",
  delta: 184,
  now: 1184,
  then: 1000,
});
const BOLT = mover({
  cardId: "bolt",
  name: "Lightning Bolt",
  setCode: "sld",
  finish: "foil",
  delta: -8.6,
  now: 11.4,
  then: 20,
});

function answer(over: Partial<PriceMovers> = {}): PriceMovers {
  return { movers: [LOTUS, BOLT], since: 1_800_000_000, days: 30, ...over };
}

function fitFor(w: number, h: number): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: w * 104 + (w - 1) * 12,
    heightPx: h * 104 + (h - 1) * 12,
    density: "comfortable",
  });
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(config: unknown = null, fit: WidgetFit = fitFor(4, 4), still = false) {
  const widget: HomeWidget = {
    id: "priceMovers",
    kind: "priceMovers",
    x: 0,
    y: 0,
    w: fit.w,
    h: fit.h,
    config,
  };
  return render(
    <PriceMoversWidget
      widget={widget}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** Seed the answer under the exact key the body reads — which is also the assertion that the
 *  window, the direction and the marketplace are all in it. */
function seed(
  data: PriceMovers,
  range: PriceMoverWindow = "7d",
  direction: PriceMoverDirection = "both",
  mp: MarketplaceId = "tcgplayer",
) {
  qc.setQueryData(priceMoversKey(range, direction, mp, PRICE_MOVERS_READ), data);
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  priceMovers.mockReset().mockResolvedValue(answer());
  collectionFolderList.mockReset().mockResolvedValue([]);
  wishlistFolderList.mockReset().mockResolvedValue([]);
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0 });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, "tcgplayer");
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
});

describe("signedMoney", () => {
  // A real minus sign, never a hyphen — and the sign is what carries the direction to a screen
  // reader, since the glyph beside the name is decoration.
  it("writes a gain with a plus and a loss with a minus sign", () => {
    expect(signedMoney(184, "usd")).toBe("+$184.00");
    expect(signedMoney(-8.6, "usd")).toBe("−$8.60");
  });
});

describe("emptySentence", () => {
  it("says there is no history before it says nothing moved", () => {
    expect(emptySentence(answer({ movers: [], since: null, days: 1 }), "7d", "both")).toBe(
      NO_HISTORY,
    );
    // Even a stray baseline with one day behind it is not history enough to compare.
    expect(emptySentence(answer({ movers: [], days: 1 }), "7d", "both")).toBe(NO_HISTORY);
  });

  it("says how far back prices go when the window reaches past them", () => {
    expect(emptySentence(answer({ movers: [], since: null, days: 3 }), "30d", "both")).toBe(
      "Only 3 days of price history so far. Not enough for the last thirty days yet.",
    );
  });

  it("says nothing moved, in the direction's own words, when there is history", () => {
    expect(emptySentence(answer({ movers: [] }), "7d", "both")).toBe(
      "Nothing you own changed price over the last seven days.",
    );
    expect(emptySentence(answer({ movers: [] }), "30d", "up")).toBe(
      "Nothing you own went up over the last thirty days.",
    );
    expect(emptySentence(answer({ movers: [] }), "all", "down")).toBe(
      "Nothing you own went down since the oldest price kept.",
    );
  });

  it("has nothing to say about a list with movers in it", () => {
    expect(emptySentence(answer(), "7d", "both")).toBeNull();
  });

  /**
   * Under `Chosen` the day count is the table's and says nothing about the chosen cards, so a
   * window with no baseline for them is *no history for your cards* rather than *only N days*.
   */
  it("speaks of what the reader chose under a scope", () => {
    expect(emptySentence(answer({ movers: [], since: null, days: 90 }), "7d", "both", true)).toBe(
      chosenNoHistory("7d"),
    );
    expect(emptySentence(answer({ movers: [] }), "7d", "up", true)).toBe(
      "Nothing you chose went up over the last seven days.",
    );
    expect(emptySentence(answer({ movers: [], days: 1 }), "7d", "both", true)).toBe(NO_HISTORY);
  });
});

describe("PriceMoversWidget", () => {
  it("says it is reading while the read is out", async () => {
    priceMovers.mockImplementation(() => new Promise(() => {}));
    draw();
    expect(await screen.findByText("Loading price history…")).toBeInTheDocument();
  });

  it("says a refusal in the backend's words", async () => {
    priceMovers.mockRejectedValue("no such marketplace");
    draw();
    expect(
      await screen.findByText("Couldn't load price history — no such marketplace"),
    ).toBeInTheDocument();
  });

  it("asks for the reader's window and direction at the chosen marketplace", async () => {
    qc.setQueryData(MARKETPLACE_KEY, "cardmarket");
    draw({ window: "30d", direction: "down" });
    await screen.findByText("Black Lotus");
    expect(priceMovers).toHaveBeenCalledWith("30d", "down", "cardmarket", PRICE_MOVERS_READ);
  });

  it("draws a mover's name, where it is from, and its signed move on a tinted chip", () => {
    seed(answer());
    draw();
    const lotus = screen.getByText("Black Lotus").closest("li") as HTMLElement;
    expect(within(lotus).getByText("LEA · nonfoil")).toBeInTheDocument();
    const gain = within(lotus).getByText("+$184.00");
    expect(gain.getAttribute("style")).toContain("--color-mana-g");

    const bolt = screen.getByText("Lightning Bolt").closest("li") as HTMLElement;
    expect(within(bolt).getByText("SLD · foil")).toBeInTheDocument();
    const loss = within(bolt).getByText("−$8.60");
    expect(loss.getAttribute("style")).toContain("--color-destructive");
  });

  it("names the window and the marketplace in the footer of a wide card", () => {
    seed(answer(), "all");
    draw({ window: "all" });
    expect(
      screen.getByText("TCGplayer prices since the oldest price kept."),
    ).toBeInTheDocument();
  });

  it("draws no footer on a narrow card", () => {
    seed(answer());
    draw(null, fitFor(3, 4));
    expect(screen.queryByText(/ prices (over|since) /)).not.toBeInTheDocument();
  });

  // The two sentences a reader must never confuse, drawn rather than only computed.
  it("tells no history from nothing moved", () => {
    seed(answer({ movers: [], since: null, days: 0 }));
    const { unmount } = draw();
    expect(screen.getByText(NO_HISTORY)).toBeInTheDocument();
    unmount();

    seed(answer({ movers: [] }));
    draw();
    expect(
      screen.getByText("Nothing you own changed price over the last seven days."),
    ).toBeInTheDocument();
  });

  // At two cells the move goes under the name and the chip goes with the value.
  it("moves the figure under the name on a two-cell tile", () => {
    seed(answer());
    draw(null, fitFor(2, 3));
    const lotus = screen.getByText("Black Lotus").closest("li") as HTMLElement;
    expect(within(lotus).queryByText("LEA · nonfoil")).not.toBeInTheDocument();
    expect(within(lotus).getByText("+$184.00").getAttribute("style")).toBeNull();
  });

  it("cuts the list to the rows the box holds, keeping the footer's line", () => {
    const fit = fitFor(4, 2);
    const movers = Array.from({ length: 30 }, (_, i) => mover({ cardId: `m${i}`, delta: i + 1 }));
    seed(answer({ movers }));
    draw(null, fit);
    expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(51, 22));
  });
});

describe("pressing a mover", () => {
  /**
   * The press names the printing **and** the finish — Lightning Bolt is the foil row here, and a
   * foil and a nonfoil copy of one printing are two price lines — and hands over the widget's own
   * window, so the popup opens on the span the reader was looking at. Asserted on the store rather
   * than a spy, because the field is the whole of the wire: the dialog is mounted at `App` level
   * and reads nothing else.
   */
  it("opens the price history on that printing, at that finish, over the widget's window", async () => {
    const user = userEvent.setup();
    seed(answer(), "30d");
    draw({ window: "30d" });

    await user.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));

    expect(useAppStore.getState().priceHistory).toEqual({
      cardId: "bolt",
      finish: "foil",
      window: "30d",
    });
  });

  /**
   * The whole row in one name, in the order it is drawn, so the visible label is inside the
   * accessible one (WCAG 2.5.3). Asserted on the element as one phrase — `packages/ui/CLAUDE.md`'s rule,
   * since the parts separately are exactly what a run-together name still passes.
   */
  it("names the press with every word the row shows, then what it does", () => {
    seed(answer());
    draw();
    expect(screen.getByRole("button", { name: /^Black Lotus/ })).toHaveAccessibleName(
      "Black Lotus · LEA · nonfoil · +$184.00 — price history",
    );
  });

  // The name a reader speaks does not change as the card is resized, though the tile draws less.
  it("keeps the same name on a two-cell tile", () => {
    seed(answer());
    draw(null, fitFor(2, 3));
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toHaveAccessibleName(
      "Lightning Bolt · SLD · foil · −$8.60 — price history",
    );
  });

  /**
   * **A catalogue still opens nothing** (`widgetProps.ts`). Its rows are pictures of rows: the same
   * words, no button, and no store write however it is clicked.
   */
  it("draws a still body with no presses", () => {
    seed(answer());
    draw(null, fitFor(4, 4), true);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Black Lotus")).toBeInTheDocument();
    expect(useAppStore.getState().priceHistory).toBeNull();
  });
});

/** A collection folder as the list answers it — only the fields the tree reads matter here. */
function collectionFolder(id: number, parentId: number | null = null) {
  return {
    id,
    parentId,
    name: `Folder ${id}`,
    kind: "user",
    deckId: null,
    sortOrder: id,
    locked: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("a widget narrowed to what the reader chose (issue #906)", () => {
  const bolt = { id: "bolt", name: "Lightning Bolt", setCode: "m21", collectorNumber: "161" };

  it("asks nothing and says so when nothing is chosen", async () => {
    draw({ scope: "chosen" });
    expect(await screen.findByText(NOTHING_CHOSEN)).toBeInTheDocument();
    expect(priceMovers).not.toHaveBeenCalled();
  });

  it("asks about the chosen cards without reading either folder tree", async () => {
    draw({ scope: "chosen", cards: [bolt] });
    await screen.findByText("Black Lotus");
    expect(priceMovers).toHaveBeenCalledWith("7d", "both", "tcgplayer", PRICE_MOVERS_READ, {
      collectionFolders: [],
      wishlistFolders: [],
      cards: ["bolt"],
    });
    expect(collectionFolderList).not.toHaveBeenCalled();
    expect(wishlistFolderList).not.toHaveBeenCalled();
  });

  it("expands a chosen folder into the folders filed inside it, the root standing alone", async () => {
    collectionFolderList.mockResolvedValue([
      collectionFolder(7),
      collectionFolder(8, 7),
      collectionFolder(9),
    ]);
    draw({ scope: "chosen", collectionFolderIds: [7, 0], wishlistFolderIds: [0] });
    await screen.findByText("Black Lotus");
    expect(priceMovers).toHaveBeenCalledWith("7d", "both", "tcgplayer", PRICE_MOVERS_READ, {
      collectionFolders: [0, 7, 8],
      wishlistFolders: [0],
      cards: [],
    });
    expect(wishlistFolderList).not.toHaveBeenCalled();
  });

  it("never measures in place of folders that are gone", async () => {
    draw({ scope: "chosen", collectionFolderIds: [42] });
    expect(await screen.findByText(CHOSEN_GONE)).toBeInTheDocument();
    expect(priceMovers).not.toHaveBeenCalled();
  });

  it("keeps the four-argument read for everything owned, with choices set aside", async () => {
    draw({ scope: "owned", cards: [bolt] });
    await screen.findByText("Black Lotus");
    expect(priceMovers).toHaveBeenCalledWith("7d", "both", "tcgplayer", PRICE_MOVERS_READ);
  });

  it("says the chosen cards have no history yet in their own words", async () => {
    priceMovers.mockResolvedValue(answer({ movers: [], since: null, days: 60 }));
    draw({ scope: "chosen", cards: [bolt] });
    expect(await screen.findByText(chosenNoHistory("7d"))).toBeInTheDocument();
  });

  /** Issue #1080: a card chosen today must not read as a widget that ignored it. */
  it("says when each window will have something to measure for a chosen card", () => {
    expect(chosenNoHistory("7d")).toContain("a week after");
    expect(chosenNoHistory("30d")).toContain("thirty days after");
    expect(chosenNoHistory("all")).toContain("from the next day on");
    for (const range of ["7d", "30d", "all"] as const) {
      expect(chosenNoHistory(range)).toContain("remembered from the day you choose them");
    }
  });
});

describe("PriceMoversWidgetSettings", () => {
  function settings(config: unknown) {
    const onConfig = vi.fn();
    const widget: HomeWidget = {
      id: "priceMovers",
      kind: "priceMovers",
      x: 0,
      y: 0,
      w: 2,
      h: 3,
      config,
    };
    render(<PriceMoversWidgetSettings widget={widget} onConfig={onConfig} />, { wrapper });
    return onConfig;
  }

  it("points at the Chosen option rather than drawing lists that change nothing", () => {
    settings(null);
    expect(
      screen.getByText(
        "Choose Chosen under Which cards to pick the folders and cards this widget follows.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Cards")).toBeNull();
  });

  it("offers both cabinets and adds a card found by search, owned or not", async () => {
    const user = userEvent.setup();
    searchCards.mockResolvedValue({
      items: [{ id: "bolt", name: "Lightning Bolt", setCode: "m21", collectorNumber: "161" }],
      total: 1,
    });
    const onConfig = settings({ scope: "chosen" });

    expect(screen.getByLabelText("Collection folders")).toBeInTheDocument();
    expect(screen.getByLabelText("Wishlist folders")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Cards"), "bolt");
    await user.click(await screen.findByRole("button", { name: "Add Lightning Bolt · M21 #161" }));
    expect(onConfig).toHaveBeenLastCalledWith({
      cards: [{ id: "bolt", name: "Lightning Bolt", setCode: "m21", collectorNumber: "161" }],
    });
    expect(searchCards).toHaveBeenCalledWith(
      expect.objectContaining({ text: "bolt", marketplace: "tcgplayer", offset: 0 }),
    );
  });

  it("stops offering cards at the most one widget follows", () => {
    const many = Array.from({ length: MAX_CHOSEN_CARDS }, (_, n) => ({
      id: `c${n}`,
      name: `Card ${n}`,
      setCode: "lea",
      collectorNumber: String(n),
    }));
    settings({ scope: "chosen", cards: many });
    expect(screen.getByLabelText("Cards")).toBeDisabled();
    expect(
      screen.getByText(
        `This widget follows ${MAX_CHOSEN_CARDS} cards, its most. Remove one to add another.`,
      ),
    ).toBeInTheDocument();
  });

  it("lists the chosen cards with a way to take each one off", async () => {
    const user = userEvent.setup();
    const ring = { id: "ring", name: "Sol Ring", setCode: "lea", collectorNumber: "270" };
    const bolt = { id: "bolt", name: "Lightning Bolt", setCode: "m21", collectorNumber: "161" };
    const onConfig = settings({ scope: "chosen", cards: [ring, bolt] });

    const list = screen.getByRole("list", { name: "Chosen cards" });
    expect(within(list).getByText("Sol Ring · LEA #270")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Sol Ring · LEA #270" }));
    expect(onConfig).toHaveBeenLastCalledWith({ cards: [bolt] });
  });
});
