import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HomeWidget,
  OptimizePlanQuery,
  OptimizePrinting,
  WishlistFolder,
  WishlistOptimizePlan,
  WishOptimizeMove,
} from "@/lib/ipc";

/**
 * The one read, typed, in front of an intact mirror. Cases with data seed the cache through the
 * exported `wishlistSavingsKey`; the stub answers what a cache cannot — a read out, a read refused,
 * and the re-issue a marketplace switch causes, which is also where the question itself is pinned.
 */
const wishlistOptimizePlan = vi.hoisted(() =>
  vi.fn<(query: OptimizePlanQuery) => Promise<WishlistOptimizePlan>>(),
);
/** The folders a `Chosen` card expands its picks against — read only under `Chosen`. */
const wishlistFolderList = vi.hoisted(() => vi.fn<() => Promise<WishlistFolder[]>>());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, wishlistOptimizePlan, wishlistFolderList } };
});

import { wholeWishlistQuery, type SweepScope } from "@/features/wishlist/wholeWishlistQuery";
import { DEFAULT_MARKETPLACE, MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import {
  CELL_MIN,
  cellFor,
  columnsFor,
  GRID_MIN_COLUMNS,
  makeFit,
  spanPx,
  type WidgetFit,
} from "../fit";
import type { Density } from "../widgetSettings";
import { wishlistSavingsKey } from "../keys";
import {
  ALL_CHEAPEST,
  CHOSEN_GONE,
  cutFooter,
  moveCaption,
  NO_WISHES,
  NOTHING_CHOSEN,
  sweepScopeOf,
  skippedFooter,
  skippedOnly,
  splitSavings,
  unpricedFooter,
  unpricedOnly,
  WishlistSavingsWidget,
  WishlistSavingsWidgetSettings,
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
    managed: false,
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
function payloadAt(marketplace: MarketplaceId, scope: SweepScope = DEFAULT_SCOPE): OptimizePlanQuery {
  return { ...wholeWishlistQuery(marketplace, scope), limit: 0, offset: 0 };
}

/** What a card nobody has configured asks: every wishlist, the decks' managed ones included —
 *  they are still wishlists (issue #598). */
const DEFAULT_SCOPE: SweepScope = { includeManaged: true, shelves: null };

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

function widget(config: unknown = null): HomeWidget {
  return { id: "wishlistSavings", kind: "wishlistSavings", x: 0, y: 0, w: 3, h: 3, config };
}

function folder(over: Partial<WishlistFolder> & { id: number; name: string }): WishlistFolder {
  return { parentId: null, sortOrder: over.id, managedDeckId: null, managedTokens: false, ...over };
}

/** A reader's own drawer with one inside it, and a deck's managed wishlist with its Tokens child. */
const FOLDERS: WishlistFolder[] = [
  folder({ id: 1, name: "Commander" }),
  folder({ id: 2, name: "Upgrades", parentId: 1 }),
  folder({ id: 5, name: "Burn", managedDeckId: 9 }),
  folder({ id: 6, name: "Tokens", parentId: 5, managedDeckId: 9, managedTokens: true }),
];

function fitFor(w: number, h: number, cell = 104, density: Density = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, cell), heightPx: spanPx(h, cell), density });
}

const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(answer: WishlistOptimizePlan, scope: SweepScope = DEFAULT_SCOPE) {
  qc.setQueryData(wishlistSavingsKey(DEFAULT_MARKETPLACE, scope), answer);
}

function draw({
  fit = ROOMY,
  still = false,
  config = null,
}: { fit?: WidgetFit; still?: boolean; config?: unknown } = {}) {
  return render(
    <WishlistSavingsWidget
      widget={widget(config)}
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
  wishlistFolderList.mockReset().mockResolvedValue(FOLDERS);
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

  /**
   * **Each footer has two spellings** — the short `line` its one line draws and the sentence it is
   * `said` as (the hint, and what a screen reader hears). The sentences are the ones the card has
   * always said; the lines are for a two-cell tile, because the skipped sentence (288–318px of 12px
   * Geist) wrapped onto two lines at every two-cell width and three at a 1024px window.
   */
  it("says what the cut rows save, in the singular and the plural", () => {
    expect(cutFooter([BOLT], "usd")).toEqual({
      line: "1 more saves $18.40",
      said: "1 more wish saves $18.40",
    });
    expect(cutFooter([BOLT, RING], "eur")).toEqual({
      line: "2 more save €24.92",
      said: "2 more wishes save €24.92",
    });
  });

  /** The number and the sum are both over what is priced, and a cut with nothing priced in it
   *  says nothing rather than `$0.00`. */
  it("never counts or sums an unpriced move in the cut line", () => {
    expect(cutFooter([BOLT, FROG], "usd")?.said).toBe("1 more wish saves $18.40");
    expect(cutFooter([FROG], "usd")).toBeNull();
  });

  it("says the unpriced moves in their own line", () => {
    expect(unpricedFooter(1)).toEqual({
      line: "1 more: no current price",
      said: "1 more has no current price",
    });
    expect(unpricedFooter(2).said).toBe("2 more have no current price");
  });

  it("says the wishes the plan could not compare, naming the marketplace", () => {
    expect(skippedFooter(1, MARKETPLACES.tcgplayer)).toEqual({
      line: "1 more: no TCGplayer price",
      said: "1 more has no price at TCGplayer to compare against",
    });
    expect(skippedFooter(2, MARKETPLACES.cardkingdom)).toEqual({
      line: "2 more: no Card Kingdom price",
      said: "2 more have no price at Card Kingdom to compare against",
    });
    expect(skippedOnly(1, MARKETPLACES.tcgplayer)).toBe(
      "1 pinned wish has no price at TCGplayer to compare against — so there is no saving to count.",
    );
    expect(skippedOnly(3, MARKETPLACES.manapool)).toBe(
      "3 pinned wishes have no price at Mana Pool to compare against — so there is no saving to count.",
    );
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

      // A captioned row is 51px; the figure line takes 74 and the cut line 24 before rows count.
      const shown = fit.rowsFit(51, 74 + 24);
      expect(fit.rowsFit(51, 74)).toBeGreaterThan(shown);
      expect(screen.getAllByRole("listitem")).toHaveLength(shown);
      expect(
        screen.getByText(`${8 - shown} more wishes save ${formatPrice(8 - shown, "usd")}`),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`${8 - shown} more save ${formatPrice(8 - shown, "usd")}`),
      ).toHaveAttribute("aria-hidden", "true");
    });

    /** The unpriced line is furniture too, reserved before any row — at a cell where it matters. */
    it("reserves the unpriced line as well as the cut line", () => {
      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      seed(plan([...eight, FROG]));
      const fit = fitFor(3, 3, 100);

      draw({ fit });

      const shown = fit.rowsFit(51, 74 + 24 + 24);
      expect(fit.rowsFit(51, 74 + 24)).toBeGreaterThan(shown);
      expect(screen.getAllByRole("listitem")).toHaveLength(shown);
      expect(
        screen.getByText(`${8 - shown} more wishes save ${formatPrice(8 - shown, "usd")}`),
      ).toBeInTheDocument();
      expect(screen.getByText("1 more has no current price")).toBeInTheDocument();
    });

    /**
     * **Every footer line is reserved at what it draws: a 16px line and the body's 8px gap**, 24
     * comfortable, against the 22 each used to reserve (the live pass measured both on
     * 2026-09-26). Three lines are 6px apart under the two rules, and at 92px cells that is a row:
     * a 3×3 holds two under 3 × 22 and one under 3 × 24, so a body that went back to the old
     * reservation draws a row into its footers' space and fails here.
     */
    it("reserves each footer line's 16px and the 8px gap above it", () => {
      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      seed(plan([...eight, FROG], { considered: 12, alreadyCheapest: 2, skipped: 1 }));
      const fit = fitFor(3, 3, 92);
      expect(fit.rowsFit(51, 74 + 22 * 3)).toBeGreaterThan(fit.rowsFit(51, 74 + 24 * 3));

      draw({ fit });

      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(51, 74 + 24 * 3));
    });

    /**
     * Moves and wishes the plan could not compare, together: the face is unchanged, the skipped
     * count is a line of its own — reserved like the other two, which the guard makes observable
     * at this cell — and it is never folded into the figure.
     */
    it("says the wishes it could not compare in a line of their own, beside the moves", () => {
      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      seed(plan(eight, { considered: 10, alreadyCheapest: 1, skipped: 1 }));
      const fit = fitFor(3, 3, 100);

      draw({ fit });

      expect(
        screen.getByRole("button", { name: "Could save $8.00 on 8 wishes · Optimise prices" }),
      ).toBeInTheDocument();
      const shown = fit.rowsFit(51, 74 + 24 + 24);
      expect(fit.rowsFit(51, 74 + 24)).toBeGreaterThan(shown);
      expect(screen.getAllByRole("listitem")).toHaveLength(shown);
      // One line, the short words drawn and the sentence spoken — the sentence wrapped at every
      // two-cell width (the live pass, 2026-09-26).
      const drawn = screen.getByText("1 more: no TCGplayer price");
      expect(drawn).toHaveAttribute("aria-hidden", "true");
      expect(drawn.closest("p")?.classList.contains("truncate")).toBe(true);
      expect(screen.getByText("1 more has no price at TCGplayer to compare against")).toHaveClass(
        "sr-only",
      );
      expect(screen.queryByText(ALL_CHEAPEST)).toBeNull();
    });

    /**
     * **Never a row or a footer line the body cannot hold, down to `CELL_MIN`** (round 2 of the
     * final fix wave). The live re-check (2026-09-26, debug build) measured a 2×2 at the smallest
     * window the app allows, 1024px: the card was **181px**, the body drew the figure, one wish row
     * and its footers, and scrolled — 3px under the cut line alone, 27px comfortable and 16px
     * compact under two lines. `rowsFit` floors at one row, so the arithmetic that had answered
     * *no row fits* drew one anyway. Rows are counted with `fitCount` now, and a box with room
     * for none draws the figure and as many of its other lines as fit.
     */
    describe("a two-cell tile at the smallest boxes", () => {
      /**
       * The 1024px window's cell, derived the way the live pass read it: a two-cell card there
       * measured 181px, so the grid is at its eight-column floor and a cell is `(181 − 12) / 2`.
       * The canvas that gives is 760px, and `fit.ts` is asked to agree rather than trusted to.
       */
      const CANVAS_1024 = 760;
      const CELL_1024 = cellFor(CANVAS_1024, columnsFor(CANVAS_1024));
      it("measures the 1024px window's two-cell card at the 181px the live pass read", () => {
        expect(columnsFor(CANVAS_1024)).toBe(GRID_MIN_COLUMNS);
        expect(spanPx(2, CELL_1024)).toBe(181);
      });

      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      /** Eight priced moves; with `lines`, the unpriced FROG and then a skipped wish as well. */
      function seedLines(lines: 0 | 1 | 2) {
        seed(
          plan(lines === 0 ? eight : [...eight, FROG], {
            considered: 12,
            alreadyCheapest: 2,
            skipped: lines === 2 ? 1 : 0,
          }),
        );
      }
      const UNPRICED = "1 more: no current price";
      const SKIPPED = "1 more: no TCGplayer price";
      /** What the figure line reserves and one footer line costs, by density — the widget's own
       *  two numbers (74 and 62) and `footerLinePx`'s 24 and 21. */
      const FIG = { comfortable: 74, compact: 62 } as const;
      const LINE = { comfortable: 24, compact: 21 } as const;

      it.each([
        ["1024px", CELL_1024, "comfortable", 0, []],
        ["1024px", CELL_1024, "comfortable", 1, [UNPRICED]],
        ["1024px", CELL_1024, "comfortable", 2, [UNPRICED, SKIPPED]],
        ["1024px", CELL_1024, "compact", 0, []],
        ["1024px", CELL_1024, "compact", 2, [UNPRICED, SKIPPED]],
        ["CELL_MIN", CELL_MIN, "comfortable", 2, [UNPRICED]],
        ["CELL_MIN", CELL_MIN, "compact", 2, [UNPRICED]],
      ] as const)(
        "at the %s cell (%spx), %s, with %i more line(s): the figure and the lines that fit, no row",
        (_, cell, density, lines, drawn) => {
          seedLines(lines);
          const fit = fitFor(2, 2, cell, density);
          // The guard: the old floor would have drawn a wish row here, under every line it had.
          const cut = FIG[density] + (lines + 1) * LINE[density];
          expect(fit.rowsFit(51, cut)).toBe(1);
          expect(fit.fitCount(51, cut)).toBe(0);

          draw({ fit });

          expect(screen.queryByRole("listitem")).toBeNull();
          expect(screen.queryByRole("list")).toBeNull();
          // The figure still counts every wish, so a cut line would only say it again.
          expect(
            screen.getByRole("button", { name: "Could save $8.00 on 8 wishes · Optimise prices" }),
          ).toBeInTheDocument();
          expect(screen.queryByText(/more (wishes )?save/)).toBeNull();
          const lineTexts = [UNPRICED, SKIPPED].filter((t) => screen.queryByText(t) !== null);
          expect(lineTexts).toEqual(drawn);
          // And what is drawn fits: the figure less the gap nothing follows, then each line.
          const gap = density === "compact" ? 5 : 8;
          expect(FIG[density] - gap + drawn.length * LINE[density]).toBeLessThanOrEqual(
            fit.bodyHeightPx,
          );
        },
      );

      /** Where a row does fit under the cut line, the tile is rows and a cut line as before. */
      it("draws the rows that fit and a cut line where there is room for both", () => {
        seedLines(0);
        const fit = fitFor(2, 3, CELL_1024, "comfortable");
        const shown = fit.fitCount(51, 74 + 24);
        expect(shown).toBeGreaterThan(0);

        draw({ fit });

        expect(screen.getAllByRole("listitem")).toHaveLength(shown);
        expect(screen.getByText(`${8 - shown} more wishes save $${8 - shown}.00`)).toHaveClass(
          "sr-only",
        );
      });
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

    /**
     * `skipped` is a wish the plan could not compare at all — no printing of its card priced at
     * this marketplace and finish (a feed not downloaded yet, a foil wish where nobody quotes
     * foil), a vanished printing, no oracle id. **Not** already cheapest, so never that sentence.
     */
    it("says the pinned wishes have no price to compare against, never that they are cheapest", () => {
      seed(plan([], { considered: 3, alreadyCheapest: 0, skipped: 3 }));

      draw();

      expect(screen.getByText(skippedOnly(3, MARKETPLACES.tcgplayer))).toBeInTheDocument();
      expect(screen.queryByText(ALL_CHEAPEST)).toBeNull();
    });

    it("never reads $0.00 saved when no move can be priced", () => {
      seed(plan([FROG], { considered: 1, alreadyCheapest: 0 }));

      draw();

      expect(screen.getByText(unpricedOnly(1, MARKETPLACES.tcgplayer))).toBeInTheDocument();
      expect(screen.queryByText(/\$0\.00/)).toBeNull();
      expect(screen.queryByText("Could save")).toBeNull();
    });

    it("still says the skipped wishes under the sentence for moves none of which is priced", () => {
      seed(plan([FROG], { considered: 3, alreadyCheapest: 0, skipped: 2 }));

      draw();

      expect(screen.getByText(unpricedOnly(1, MARKETPLACES.tcgplayer))).toBeInTheDocument();
      expect(
        screen.getByText("2 more have no price at TCGplayer to compare against"),
      ).toBeInTheDocument();
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
        setPendingOptimize: (scope) => {
          writes.push("optimize");
          real.setPendingOptimize(scope);
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
      // The card's own question travels with the press, so the dialog plans what it counted.
      expect(useAppStore.getState().pendingOptimize).toEqual(DEFAULT_SCOPE);
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

/**
 * **Issue #598: the decks' managed wishlists are still wishlists**, and a reader can narrow the
 * card to the wishlists they choose. Both are the question, so both ride in the key and the press.
 */
describe("which wishes it counts", () => {
  describe("sweepScopeOf", () => {
    it("counts every wishlist, the managed ones included, on a card nobody has configured", () => {
      expect(sweepScopeOf(widget(), FOLDERS)).toEqual(DEFAULT_SCOPE);
    });

    it("leaves the managed wishlists out once the switch is off", () => {
      expect(sweepScopeOf(widget({ managed: false }), FOLDERS)).toEqual({
        includeManaged: false,
        shelves: null,
      });
    });

    /** A chosen drawer is the drawer: the plan answers direct members only, so its sub-folders
     *  are named too — a deck's Tokens child with the deck's folder. */
    it("expands each chosen folder into every folder inside it, sorted", () => {
      expect(sweepScopeOf(widget({ scope: "chosen", folderIds: [5, 1] }), FOLDERS)).toEqual({
        includeManaged: true,
        shelves: [1, 2, 5, 6],
      });
    });

    it("keeps the root and drops a chosen folder that no longer exists", () => {
      expect(sweepScopeOf(widget({ scope: "chosen", folderIds: [0, 404] }), FOLDERS)).toEqual({
        includeManaged: true,
        shelves: [0],
      });
    });
  });

  it("asks the plan with the managed wishlists in scope by default", async () => {
    wishlistOptimizePlan.mockResolvedValue(plan([BOLT]));

    draw();

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(wishlistOptimizePlan).toHaveBeenCalledWith(
      expect.objectContaining({ includeManaged: true }),
    );
    // Every wishlist: no folder is read to answer it.
    expect(wishlistFolderList).not.toHaveBeenCalled();
  });

  it("asks without them once the switch is off", async () => {
    wishlistOptimizePlan.mockResolvedValue(plan([BOLT]));

    draw({ config: { managed: false } });

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(wishlistOptimizePlan).toHaveBeenCalledWith(payloadAt(DEFAULT_MARKETPLACE, {
      includeManaged: false,
      shelves: null,
    }));
    expect(wishlistOptimizePlan.mock.calls[0][0]).not.toHaveProperty("includeManaged");
  });

  it("asks about the chosen folders and everything inside them", async () => {
    wishlistOptimizePlan.mockResolvedValue(plan([BOLT]));

    draw({ config: { scope: "chosen", folderIds: [1] } });

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(wishlistOptimizePlan).toHaveBeenCalledWith(
      payloadAt(DEFAULT_MARKETPLACE, { includeManaged: true, shelves: [1, 2] }),
    );
  });

  it("says nothing is chosen rather than counting everything", () => {
    draw({ config: { scope: "chosen", folderIds: [] } });

    expect(screen.getByText(NOTHING_CHOSEN)).toBeInTheDocument();
    expect(wishlistOptimizePlan).not.toHaveBeenCalled();
  });

  it("says the chosen wishlists are gone rather than counting everything", async () => {
    draw({ config: { scope: "chosen", folderIds: [404] } });

    expect(await screen.findByText(CHOSEN_GONE)).toBeInTheDocument();
    expect(wishlistOptimizePlan).not.toHaveBeenCalled();
  });

  it("hands the chosen scope to the dialog with the press", async () => {
    const user = userEvent.setup();
    const scope: SweepScope = { includeManaged: false, shelves: [1, 2] };
    seed(plan([BOLT]), scope);

    draw({ config: { scope: "chosen", folderIds: [1], managed: false } });
    await user.click(await screen.findByRole("button", { name: /^Lightning Bolt · / }));

    expect(useAppStore.getState().pendingOptimize).toEqual(scope);
  });

  describe("its settings", () => {
    function settings(config: unknown, onConfig = vi.fn()) {
      render(<WishlistSavingsWidgetSettings widget={widget(config)} onConfig={onConfig} />, {
        wrapper,
      });
      return onConfig;
    }

    it("points at the scope row instead of drawing a picker that would do nothing", () => {
      settings(null);

      expect(screen.queryByRole("button", { name: "Wishlists to count" })).toBeNull();
      expect(
        screen.getByText(
          "Choose Chosen under Which wishlists to pick the wishlists this card counts.",
        ),
      ).toBeInTheDocument();
    });

    /** The tree's own order, the root first, a deck's managed wishlist saying so. */
    it("offers the root and every folder in the tree's order, the managed ones marked", async () => {
      const user = userEvent.setup();
      settings({ scope: "chosen" });

      await user.click(await screen.findByRole("button", { name: "Wishlists to count" }));

      await waitFor(() =>
        expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual([
          expect.stringContaining("Not in a folder"),
          expect.stringContaining("Commander"),
          expect.stringContaining("Upgrades"),
          expect.stringContaining("Burn (managed)"),
          expect.stringContaining("Burn › Tokens (managed)"),
        ]),
      );
    });

    /** Ticking one would count nothing while the plan leaves them out, so they are not offered. */
    it("leaves the managed wishlists out of the list while the switch is off", async () => {
      const user = userEvent.setup();
      settings({ scope: "chosen", managed: false });

      await user.click(await screen.findByRole("button", { name: "Wishlists to count" }));

      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
      expect(screen.queryByRole("option", { name: /managed/ })).toBeNull();
    });

    it("adds a ticked folder at the end of the chosen set", async () => {
      const user = userEvent.setup();
      const onConfig = settings({ scope: "chosen", folderIds: [0] });

      await user.click(await screen.findByRole("button", { name: "Wishlists to count" }));
      await user.click(await screen.findByRole("option", { name: /Commander/ }));

      await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ folderIds: [0, 1] }));
    });
  });
});
