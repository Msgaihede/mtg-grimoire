import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HomeWidget,
  OptimizePrinting,
  WishlistOptimizePlan,
  WishlistQuery,
  WishOptimizeMove,
} from "@/lib/ipc";

/**
 * The one read, typed, in front of an intact mirror. Cases with data seed the cache through the
 * exported `wishlistSavingsKey`; the stub answers what a cache cannot — a read out, a read refused,
 * and the re-issue a marketplace switch causes, which is also where the question itself is pinned.
 */
const wishlistOptimizePlan = vi.hoisted(() =>
  vi.fn<(query: WishlistQuery) => Promise<WishlistOptimizePlan>>(),
);
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, wishlistOptimizePlan } };
});

import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import { DEFAULT_MARKETPLACE, MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { wishlistSavingsKey } from "../keys";
import {
  ALL_CHEAPEST,
  cutFooter,
  moveCaption,
  NO_WISHES,
  splitSavings,
  unpricedFooter,
  unpricedOnly,
  WishlistSavingsWidget,
} from "./WishlistSavingsWidget";

function printingOf(over: Partial<OptimizePrinting> & { cardId: string }): OptimizePrinting {
  return { setCode: "2x2", collectorNumber: "117", lang: "en", price: 2.5, ...over };
}

/** One move. The default is the design's own row: pinned at $40.00, cheapest at $21.60. */
function move(over: Partial<WishOptimizeMove> & { wishId: number; name: string }): WishOptimizeMove {
  return {
    quantity: 1,
    preferredFinish: null,
    folderId: null,
    from: printingOf({ cardId: `from-${over.wishId}`, setCode: "lea", collectorNumber: "161", price: 40 }),
    to: printingOf({ cardId: `to-${over.wishId}`, price: 21.6 }),
    savedPerCopy: 18.4,
    saved: 18.4,
    ...over,
  };
}

function plan(
  moves: WishOptimizeMove[],
  over: Partial<Omit<WishlistOptimizePlan, "moves">> = {},
): WishlistOptimizePlan {
  return { moves, considered: moves.length + 3, alreadyCheapest: 3, skipped: 0, ...over };
}

/**
 * The payload the command is actually handed: the whole-list question plus the `limit`/`offset`
 * `WishlistQuery` requires and the command ignores — `useWishlistOptimize`'s own spelling, so the
 * widget and the dialog it opens put one question under one key.
 */
function payloadAt(marketplace: MarketplaceId): WishlistQuery {
  return { ...wholeWishlistQuery(marketplace), limit: 0, offset: 0 };
}

const BOLT = move({ wishId: 1, name: "Lightning Bolt" });
const RING = move({
  wishId: 2,
  name: "Sol Ring",
  quantity: 2,
  from: printingOf({ cardId: "from-2", setCode: "c21", collectorNumber: "263", price: 5 }),
  to: printingOf({ cardId: "to-2", setCode: "cmm", collectorNumber: "410", price: 1.74 }),
  savedPerCopy: 3.26,
  saved: 6.52,
});
/** Pinned to a printing this marketplace does not list: a move, and no saving to count. */
const FROG = move({
  wishId: 3,
  name: "Psychic Frog",
  from: printingOf({ cardId: "from-3", setCode: "mh3", collectorNumber: "56", price: null }),
  savedPerCopy: null,
  saved: null,
});

function widget(): HomeWidget {
  return { id: "wishlistSavings", kind: "wishlistSavings", x: 0, y: 0, w: 3, h: 3, config: null };
}

function fitFor(w: number, h: number, cell = 104): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, cell), heightPx: spanPx(h, cell), density: "comfortable" });
}

const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(answer: WishlistOptimizePlan) {
  qc.setQueryData(wishlistSavingsKey(DEFAULT_MARKETPLACE), answer);
}

function draw({ fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {}) {
  return render(
    <WishlistSavingsWidget
      widget={widget()}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  wishlistOptimizePlan.mockReset().mockResolvedValue(plan([]));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("splitSavings", () => {
  it("orders the priced moves by saving, counts the unpriced ones and sums only what is priced", () => {
    const split = splitSavings([FROG, RING, BOLT]);
    expect(split.priced.map((m) => m.name)).toEqual(["Lightning Bolt", "Sol Ring"]);
    expect(split.unpriced).toBe(1);
    expect(split.total).toBeCloseTo(24.92, 10);
  });

  it("settles a tie by name", () => {
    const beta = move({ wishId: 5, name: "Beta", saved: 5, savedPerCopy: 5 });
    const alpha = move({ wishId: 6, name: "Alpha", saved: 5, savedPerCopy: 5 });
    expect(splitSavings([beta, alpha]).priced.map((m) => m.name)).toEqual(["Alpha", "Beta"]);
  });

  /** A move with no current price is never summed as zero, and nothing reads `NaN`. */
  it("answers zero and no rows for moves none of which is priced", () => {
    expect(splitSavings([FROG])).toEqual({ priced: [], unpriced: 1, total: 0 });
    expect(splitSavings([])).toEqual({ priced: [], unpriced: 0, total: 0 });
  });
});

describe("the words", () => {
  it("captions a move with both prices per copy, and the copies when there are several", () => {
    expect(moveCaption(BOLT, "usd")).toBe("Pinned $40.00 · cheapest $21.60");
    expect(moveCaption(RING, "usd")).toBe("Pinned $5.00 · cheapest $1.74 · 2 copies");
  });

  it("says what the cut rows save, in the singular and the plural", () => {
    expect(cutFooter([BOLT], "usd")).toBe("1 more wish saves $18.40");
    expect(cutFooter([BOLT, RING], "eur")).toBe("2 more wishes save €24.92");
  });

  it("says the unpriced moves in their own line", () => {
    expect(unpricedFooter(1)).toBe("1 more has no current price");
    expect(unpricedFooter(2)).toBe("2 more have no current price");
  });

  it("says why there is no saving when no move is priced", () => {
    expect(unpricedOnly(1, MARKETPLACES.tcgplayer)).toBe(
      "1 pinned wish could move to a cheaper printing, but its current printing has no price at TCGplayer — so there is no saving to count.",
    );
    expect(unpricedOnly(3, MARKETPLACES.cardmarket)).toMatch(
      /^3 pinned wishes could move .* their current printings have no price at Cardmarket/,
    );
  });
});

describe("WishlistSavingsWidget", () => {
  describe("what it draws", () => {
    it("draws the figure, the moves biggest saving first, and the unpriced line", () => {
      seed(plan([FROG, RING, BOLT]));

      draw();

      expect(
        screen.getByRole("button", { name: "Could save $24.92 on 2 wishes · Optimise prices" }),
      ).toBeInTheDocument();
      expect(screen.getByText("$24.92")).toBeInTheDocument();
      const rows = screen.getAllByRole("listitem");
      expect(rows.map((row) => row.querySelector(".font-medium")?.textContent)).toEqual([
        "Lightning Bolt",
        "Sol Ring",
      ]);
      expect(
        screen.getByRole("button", {
          name: "Lightning Bolt · Pinned $40.00 · cheapest $21.60 · saves $18.40",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("1 more has no current price")).toBeInTheDocument();
      // Everything fitted, so there is no cut line.
      expect(screen.queryByText(/more wish(es)? save/)).toBeNull();
    });

    /**
     * **At a 92px cell, not the grid's 104**: at 104 a 3×3 card fits three captioned rows whether
     * or not the cut line is reserved, so a body that forgot the reservation passed this case. The
     * guard is what keeps the cell honest if `fit.ts`'s arithmetic moves.
     */
    it("says what the rows that did not fit would save, in room reserved for it", () => {
      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      seed(plan(eight));
      const fit = fitFor(3, 3, 92);

      draw({ fit });

      // A captioned row is 51px; the figure line takes 74 and the cut line 22 before rows count.
      const shown = fit.rowsFit(51, 74 + 22);
      expect(fit.rowsFit(51, 74)).toBeGreaterThan(shown);
      expect(screen.getAllByRole("listitem")).toHaveLength(shown);
      expect(
        screen.getByText(`${8 - shown} more wishes save ${formatPrice(8 - shown, "usd")}`),
      ).toBeInTheDocument();
    });

    /** The unpriced line is furniture too, reserved before any row — at a cell where it matters. */
    it("reserves the unpriced line as well as the cut line", () => {
      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      seed(plan([...eight, FROG]));
      const fit = fitFor(3, 3, 100);

      draw({ fit });

      const shown = fit.rowsFit(51, 74 + 22 + 22);
      expect(fit.rowsFit(51, 74 + 22)).toBeGreaterThan(shown);
      expect(screen.getAllByRole("listitem")).toHaveLength(shown);
      expect(
        screen.getByText(`${8 - shown} more wishes save ${formatPrice(8 - shown, "usd")}`),
      ).toBeInTheDocument();
      expect(screen.getByText("1 more has no current price")).toBeInTheDocument();
    });

    it("moves the saving under the name on a two-cell tile", () => {
      seed(plan([BOLT]));

      draw({ fit: fitFor(2, 3) });

      const row = screen.getByRole("button", { name: /^Lightning Bolt · / });
      expect(row).toHaveTextContent("Lightning Bolt$18.40");
      expect(screen.queryByText("Pinned $40.00 · cheapest $21.60")).toBeNull();
    });

    /** The question: the whole list, flattened and unfiltered, at the reader's marketplace. */
    it("asks the plan about the whole wishlist", async () => {
      wishlistOptimizePlan.mockResolvedValue(plan([BOLT]));

      draw();

      expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
      expect(wishlistOptimizePlan).toHaveBeenCalledWith(payloadAt(DEFAULT_MARKETPLACE));
    });

    it("asks again at a new marketplace rather than relabelling the old saving", async () => {
      seed(plan([BOLT]));
      qc.setQueryData(MARKETPLACE_KEY, "cardmarket");
      wishlistOptimizePlan.mockResolvedValue(
        plan([move({ wishId: 1, name: "Lightning Bolt", saved: 12, savedPerCopy: 12 })]),
      );

      draw();

      expect(screen.getByText("Pricing your pinned wishes…")).toBeInTheDocument();
      expect(screen.queryByText("$18.40")).toBeNull();
      expect(
        await screen.findByRole("button", { name: "Could save €12.00 on 1 wish · Optimise prices" }),
      ).toBeInTheDocument();
      expect(wishlistOptimizePlan).toHaveBeenCalledWith(payloadAt("cardmarket"));
    });
  });

  describe("the states", () => {
    it("says it is pricing while the read is out", () => {
      wishlistOptimizePlan.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Pricing your pinned wishes…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      wishlistOptimizePlan.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not price your wishlist — The database is busy."),
      ).toBeInTheDocument();
    });

    it("says the wishlist is empty when the plan considered nothing", () => {
      seed(plan([], { considered: 0, alreadyCheapest: 0 }));

      draw();

      expect(screen.getByText(NO_WISHES)).toBeInTheDocument();
    });

    /** Only any-printing wishes answer here too: each is cheapest by construction. */
    it("says every pinned wish is already cheapest when there is no move", () => {
      seed(plan([], { considered: 4, alreadyCheapest: 4 }));

      draw();

      expect(screen.getByText(ALL_CHEAPEST)).toBeInTheDocument();
    });

    it("never reads $0.00 saved when no move can be priced", () => {
      seed(plan([FROG], { considered: 1, alreadyCheapest: 0 }));

      draw();

      expect(screen.getByText(unpricedOnly(1, MARKETPLACES.tcgplayer))).toBeInTheDocument();
      expect(screen.queryByText(/\$0\.00/)).toBeNull();
      expect(screen.queryByText("Could save")).toBeNull();
    });
  });

  describe("pressing", () => {
    function recordWrites(): string[] {
      const writes: string[] = [];
      const real = useAppStore.getState();
      useAppStore.setState({
        setActiveView: (view) => {
          writes.push(`view:${view}`);
          real.setActiveView(view);
        },
        setPendingOptimize: () => {
          writes.push("optimize");
          real.setPendingOptimize();
        },
      });
      return writes;
    }

    /** `setActiveView` clears every hand-off, so the view is written first. */
    it("opens the optimise dialog on the wishlist from a row, the view first", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed(plan([BOLT]));
      draw();

      await user.click(screen.getByRole("button", { name: /^Lightning Bolt · / }));

      expect(writes).toEqual(["view:wishlist", "optimize"]);
      expect(useAppStore.getState().activeView).toBe("wishlist");
      expect(useAppStore.getState().pendingOptimize).toBe(true);
    });

    it("opens the same dialog from the figure", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed(plan([BOLT]));
      draw();

      await user.click(screen.getByRole("button", { name: /^Could save / }));

      await waitFor(() => expect(writes).toEqual(["view:wishlist", "optimize"]));
    });

    it("draws a still body with no presses", () => {
      seed(plan([BOLT]));

      draw({ still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    });
  });
});
