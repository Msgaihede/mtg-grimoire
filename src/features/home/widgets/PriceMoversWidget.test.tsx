import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one read, in front of an intact mirror — `RecentCardsWidget.test.tsx`'s note. */
const priceMovers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, priceMovers } };
});

import type {
  HomeWidget,
  PriceMover,
  PriceMoverDirection,
  PriceMovers,
  PriceMoverWindow,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, type WidgetFit } from "../fit";
import { priceMoversKey } from "../keys";
import {
  emptySentence,
  NO_HISTORY,
  PRICE_MOVERS_READ,
  PriceMoversWidget,
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

function draw(config: unknown = null, fit: WidgetFit = fitFor(4, 4)) {
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
      still={false}
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
  priceMovers.mockReset().mockResolvedValue(answer());
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
      "Prices have been remembered for 3 days so far — not long enough to measure the last thirty days yet.",
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
});

describe("PriceMoversWidget", () => {
  it("says it is reading while the read is out", async () => {
    priceMovers.mockImplementation(() => new Promise(() => {}));
    draw();
    expect(await screen.findByText("Reading price history…")).toBeInTheDocument();
  });

  it("says a refusal in the backend's words", async () => {
    priceMovers.mockRejectedValue("no such marketplace");
    draw();
    expect(
      await screen.findByText("Could not read price history — no such marketplace"),
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
    expect(gain.getAttribute("style")).toContain("--color-pie-g");

    const bolt = screen.getByText("Lightning Bolt").closest("li") as HTMLElement;
    expect(within(bolt).getByText("SLD · foil")).toBeInTheDocument();
    const loss = within(bolt).getByText("−$8.60");
    expect(loss.getAttribute("style")).toContain("--color-destructive");
  });

  it("names the window and the marketplace in the footer of a wide card", () => {
    seed(answer(), "all");
    draw({ window: "all" });
    expect(
      screen.getByText("Against the oldest price kept of TCGplayer prices."),
    ).toBeInTheDocument();
  });

  it("draws no footer on a narrow card", () => {
    seed(answer());
    draw(null, fitFor(3, 4));
    expect(screen.queryByText(/^Against /)).not.toBeInTheDocument();
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
