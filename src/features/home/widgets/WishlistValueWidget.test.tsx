import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BreakdownRow, HomeWidget, WishlistSummary } from "@/lib/ipc";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { wishlistBreakdownKey, wishlistTotalKey } from "../keys";
import type { WidgetBodyProps } from "../widgetProps";
import { readDimension, WishlistValueWidget } from "./WishlistValueWidget";

/**
 * **The queries are seeded through the shared keys, and `@/lib/ipc` is never mocked.** A
 * `vi.fn()` over that module replaces the whole `ipc` object, which is what erases the mirror
 * `ipc.test.ts` asserts the Rust command names against — so a field that stopped existing would
 * still pass here. Seeding the cache instead exercises the real module and pins the key, which is
 * the other half of the contract: an invalidation of `["wishlist"]` — the one every wishlist write
 * already makes — has to reach these two entries.
 */
const MARKETPLACE = "tcgplayer";

/** 42 wishes, 63 copies, and four of those copies nobody quotes a price for. */
const SUMMARY: WishlistSummary = { wishes: 42, copies: 63, cost: 128.5, unpriced: 4 };

/** A wishlist nobody has put anything on. `cost: 0` is real here and must still not be drawn as
 *  `$0.00` — an empty list is a sentence, not a total. */
const NO_WISHES: WishlistSummary = { wishes: 0, copies: 0, cost: 0, unpriced: 0 };

/**
 * Rarity, dearest first — which is the order `wishlist_breakdown` answers in, so the widget
 * draws them as they arrive.
 *
 * `80 + 40 + 8.5` is exactly `SUMMARY.cost`, because a breakdown sums to the summary above it by
 * construction. The `unknown` bucket is the NULL rarity a wish whose printing has left the card
 * database lands in, and it is **unpriced**, which is the row that proves an em dash rather than
 * a zero.
 */
const RARITY: BreakdownRow[] = [
  { key: "mythic", name: null, cards: 12, value: 80 },
  { key: "rare", name: null, cards: 20, value: 40 },
  { key: "common", name: null, cards: 25, value: 8.5 },
  { key: "unknown", name: null, cards: 6, value: null },
];

/** The colour vocabulary, all three of its shapes: the **stored uppercase letter** for one
 *  colour, lowercase `c` for colourless, `multi` for two or more. */
const COLOR: BreakdownRow[] = [
  { key: "multi", name: null, cards: 10, value: 60 },
  { key: "U", name: null, cards: 8, value: 40 },
  { key: "c", name: null, cards: 4, value: 28.5 },
];

/** A set code with its name beside it, and the `unknown` bucket a wish with no set at all files
 *  under — the one dimension whose key is not already the word. */
const SET: BreakdownRow[] = [
  { key: "mh3", name: "Modern Horizons 3", cards: 9, value: 100 },
  { key: "unknown", name: null, cards: 2, value: 28.5 },
];

/** Finish — and `any`, the arm the wishlist has and the collection does not: a wish need not
 *  name a finish. */
const FINISH: BreakdownRow[] = [
  { key: "any", name: null, cards: 30, value: 90 },
  { key: "foil", name: null, cards: 5, value: 38.5 },
];

/** Eleven sets, dearest first, a dollar apart — `$1,045` between them. */
const ELEVEN_SETS: BreakdownRow[] = Array.from({ length: 11 }, (_, i) => ({
  key: `s${i}`,
  name: `Set ${i}`,
  cards: 2,
  value: 100 - i,
}));
const ELEVEN_SETS_SUMMARY: WishlistSummary = { wishes: 11, copies: 22, cost: 1045, unpriced: 0 };

function widgetOf(config: unknown, w = 2, h = 3): HomeWidget {
  return { id: "wishlistValue", kind: "wishlistValue", x: 0, y: 0, w, h, config };
}

/** A fit on a grid of `cell`-pixel cells, through `fit.ts`'s own arithmetic. A 2×3 at 104px has
 *  room for five bars under its figures; a 2×2 at 68px has room for none. */
function fitOf(w: number, h: number, cell = 104): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, cell),
    heightPx: spanPx(h, cell),
    density: "comfortable",
  });
}

/** Everything a body is drawn with. None of `editing`, `still` or `onConfig` is what these tests
 *  are about, so they are filled in once. */
function body(widget: HomeWidget, over: Partial<WidgetBodyProps> = {}): WidgetBodyProps {
  return {
    widget,
    fit: fitOf(widget.w, widget.h),
    editing: false,
    still: false,
    onConfig: vi.fn(),
    ...over,
  };
}

/**
 * A world whose answers are already in the cache.
 *
 * `staleTime: Infinity` is what stops a seeded answer being refetched out from under the first
 * assertion — the widget would otherwise ask Tauri, which jsdom has nothing behind. The
 * marketplace is seeded too, because every key here carries it and the widget must be quoting
 * TCGplayer dollars for the money in these assertions to mean anything.
 */
function world(summary: WishlistSummary, rows: Partial<Record<string, BreakdownRow[]>>) {
  return function World({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
      const c = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      c.setQueryData(MARKETPLACE_KEY, MARKETPLACE);
      c.setQueryData(MARKETPLACE_FEEDS_KEY, []);
      c.setQueryData(wishlistTotalKey(MARKETPLACE), summary);
      for (const [dimension, breakdown] of Object.entries(rows)) {
        c.setQueryData(wishlistBreakdownKey(dimension as "rarity", MARKETPLACE), breakdown);
      }
      return c;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * A world with **nothing** seeded but the marketplace, so the widget really asks.
 *
 * jsdom has no Tauri behind `invoke`, so both reads reject — which is how the refusal state gets
 * driven without mocking `@/lib/ipc`, and is simultaneously the proof that the widget issues the
 * two queries at all. The message is the environment's and is never asserted; the sentence in
 * front of it is this file's.
 */
function LiveWorld({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    c.setQueryData(MARKETPLACE_KEY, MARKETPLACE);
    c.setQueryData(MARKETPLACE_FEEDS_KEY, []);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The bars' spoken sentences, in order. The drawing itself is `aria-hidden`, so this is the
 *  whole of what the widget actually says about its buckets. */
function sentences(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("li > .sr-only")).map((el) => el.textContent ?? "");
}

/** The value line under a figure's label — the number and its note. */
function figure(label: string): HTMLElement {
  return screen.getByText(label).nextElementSibling as HTMLElement;
}

describe("WishlistValueWidget", () => {
  it("draws the total cost and the note that says what it leaves out", () => {
    // A panel rather than a tile: `WidgetFigures` drops a note on a two-cell tile.
    render(<WishlistValueWidget {...body(widgetOf(null, 3, 3))} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    expect(figure("Cost (USD)")).toHaveTextContent("$128.50");
    expect(figure("Cost (USD)")).toHaveTextContent("4 copies nobody quotes a price for");
    expect(figure("Copies")).toHaveTextContent("63");
  });

  it("says nothing about a price it does not have, per bucket", () => {
    render(<WishlistValueWidget {...body(widgetOf(null))} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    // An em dash and never `$0.00`: the marketplace priced nothing in this bucket, which is a
    // different statement from a bucket worth nothing.
    expect(screen.getAllByText("—")).toHaveLength(1);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("gives every bar a sentence naming its bucket, its copies and its money", () => {
    const { container } = render(<WishlistValueWidget {...body(widgetOf(null))} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    expect(sentences(container)).toEqual([
      "Mythic: 12 copies, $80.00, 62% of the total.",
      "Rare: 20 copies, $40.00, 31% of the total.",
      "Common: 25 copies, $8.50, 7% of the total.",
      // Not "0% of the total", and not a price: a wish nobody will quote is a wish you cannot be
      // told the cost of, which is the wishlist's own version of this hole.
      "Unknown rarity: 6 copies, no price to buy at TCGplayer.",
    ]);
  });

  it("draws the picture as decoration and makes none of it a control", () => {
    const { container } = render(<WishlistValueWidget {...body(widgetOf(null))} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    // The dimension picker moved to the card's settings popover, so the body has no control at
    // all — a bar is a `<span>`, exactly as the deck stats band's are.
    expect(screen.queryAllByRole("button")).toEqual([]);
    const fills = Array.from(container.querySelectorAll("li span.h-full"));
    expect(fills).toHaveLength(4);
    for (const fill of fills) expect(fill.closest("[aria-hidden]")).not.toBeNull();
  });

  /** The widest bar is the full track and the others are fractions of it; a bucket with no price
   *  draws no fill at all rather than a sliver that reads as a small number. */
  it("draws each fill as a fraction of the widest bar", () => {
    const { container } = render(<WishlistValueWidget {...body(widgetOf(null))} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    const widths = Array.from(container.querySelectorAll<HTMLElement>("li span.h-full")).map(
      (fill) => fill.style.width,
    );
    // `8.5 / 80`; the style declaration normalises `100.0%` to `100%`.
    expect(widths).toEqual(["100%", "50%", "10.6%", "0%"]);
  });

  it("fills colour bars in their mana colour and multicolour in gold", () => {
    const { container } = render(<WishlistValueWidget {...body(widgetOf({ dimension: "color" }))} />, {
      wrapper: world(SUMMARY, { color: COLOR }),
    });

    const fills = Array.from(container.querySelectorAll<HTMLElement>("li span.h-full")).map(
      (fill) => fill.style.background,
    );
    expect(fills).toEqual(["var(--color-pie-gold)", "var(--color-mana-u)", "var(--color-mana-c)"]);
  });

  it.each([
    ["rarity", RARITY, ["Mythic", "Rare", "Common", "Unknown rarity"]],
    ["color", COLOR, ["Multicolour", "Blue", "Colorless"]],
    ["set", SET, ["Modern Horizons 3", "Unknown set"]],
    ["finish", FINISH, ["Any finish", "Foil"]],
  ] as const)("names every bucket of the %s dimension", (dimension, rows, labels) => {
    const { container } = render(<WishlistValueWidget {...body(widgetOf({ dimension }))} />, {
      wrapper: world(SUMMARY, { [dimension]: rows }),
    });

    const spoken = sentences(container);
    expect(spoken).toHaveLength(labels.length);
    labels.forEach((label, i) => expect(spoken[i]).toMatch(new RegExp(`^${label}: `)));
  });

  it("narrows a stored dimension this build has no column for", () => {
    // `widgetConfig` checks a *shape* and cannot check a vocabulary — a stored `"bogus"` is a
    // string and passes it — so the registry pick narrows the word.
    expect(readDimension(widgetOf({ dimension: "bogus" }))).toBe("rarity");
    expect(readDimension(widgetOf({ dimension: 7 }))).toBe("rarity");
    expect(readDimension(widgetOf(null))).toBe("rarity");
    expect(readDimension(widgetOf({ dimension: "finish" }))).toBe("finish");
  });

  it("draws the bars of the dimension it narrowed to, not an empty chart", () => {
    const { container } = render(
      <WishlistValueWidget {...body(widgetOf({ dimension: "bogus" }))} />,
      { wrapper: world(SUMMARY, { rarity: RARITY }) },
    );

    expect(sentences(container)[0]).toBe("Mythic: 12 copies, $80.00, 62% of the total.");
  });

  /** Cut to the five rows a 2×3 tile has under its figures, the last of them the fold of the
   *  seven that did not fit — so the bars still sum to the list's total. */
  it("cuts the buckets to the room and folds the rest into Other", () => {
    const { container } = render(<WishlistValueWidget {...body(widgetOf({ dimension: "set" }))} />, {
      wrapper: world(ELEVEN_SETS_SUMMARY, { set: ELEVEN_SETS }),
    });

    const spoken = sentences(container);
    expect(spoken).toHaveLength(5);
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(spoken[4]).toBe("Every other set: 14 copies, $651.00, 62% of the total.");
  });

  it("gives the figure line's room to the chart when totals are switched off", () => {
    const { container } = render(
      <WishlistValueWidget {...body(widgetOf({ dimension: "set", figures: false }))} />,
      { wrapper: world(ELEVEN_SETS_SUMMARY, { set: ELEVEN_SETS }) },
    );

    expect(screen.queryByText("Cost (USD)")).not.toBeInTheDocument();
    expect(sentences(container)).toHaveLength(7);
  });

  it("draws only the figures on a tile with no room for a bar", () => {
    const { container } = render(
      <WishlistValueWidget {...body(widgetOf(null, 2, 2), { fit: fitOf(2, 2, 68) })} />,
      { wrapper: world(SUMMARY, { rarity: RARITY }) },
    );

    expect(figure("Cost (USD)")).toHaveTextContent("$128.50");
    expect(container.querySelector("ul")).toBeNull();
  });

  it("draws rows instead of bars when the chart is a list", () => {
    const { container } = render(
      <WishlistValueWidget {...body(widgetOf({ chart: "list" }, 3, 3))} />,
      { wrapper: world(SUMMARY, { rarity: RARITY }) },
    );

    expect(sentences(container)).toEqual([]);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Mythic$80.00",
      "Rare$40.00",
      "Common$8.50",
      "Unknown rarity—",
    ]);
  });

  it("moves a list row's money under its name on a two-cell tile", () => {
    render(<WishlistValueWidget {...body(widgetOf({ chart: "list" }))} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    const money = screen.getByText("$80.00");
    expect(money.previousElementSibling).toHaveTextContent("Mythic");
    expect(money.classList.contains("text-text")).toBe(true);
  });

  it("names the marketplace and the cut in a footer on a band, and not on a tile", () => {
    const { unmount } = render(
      <WishlistValueWidget {...body(widgetOf({ dimension: "finish" }, 4, 6))} />,
      { wrapper: world(SUMMARY, { finish: FINISH }) },
    );
    expect(
      screen.getByText("TCGplayer prices as of the last card-data sync · split by finish"),
    ).toBeInTheDocument();
    unmount();

    render(<WishlistValueWidget {...body(widgetOf({ dimension: "finish" }))} />, {
      wrapper: world(SUMMARY, { finish: FINISH }),
    });
    expect(screen.queryByText(/split by/)).not.toBeInTheDocument();
  });

  it("says it is still working while the reads are in flight", () => {
    render(<WishlistValueWidget {...body(widgetOf(null))} />, { wrapper: LiveWorld });

    // Synchronously, before the rejection below can land: a query's first render is always
    // pending, and nothing can run between `render` and this assertion.
    expect(screen.getByText("Adding up what your wishlist would cost…")).toBeInTheDocument();
  });

  it("says the wishlist is empty in the wishlist's own words", () => {
    render(<WishlistValueWidget {...body(widgetOf(null))} />, {
      wrapper: world(NO_WISHES, { rarity: [] }),
    });

    expect(
      screen.getByText("You want nothing yet — wish for a card and its cost lands here."),
    ).toBeInTheDocument();
    // Never a total over an empty list: `$0.00` is a price nobody quoted.
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("says so when a list with wishes has no bucket to draw", () => {
    render(<WishlistValueWidget {...body(widgetOf(null))} />, {
      wrapper: world(SUMMARY, { rarity: [] }),
    });

    expect(screen.getByText("Nothing in this slice has a price yet.")).toBeInTheDocument();
  });

  it("says so when the read is refused", async () => {
    render(<WishlistValueWidget {...body(widgetOf(null))} />, { wrapper: LiveWorld });

    await waitFor(() =>
      expect(screen.getByText(/Could not price your wishlist/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Adding up/)).not.toBeInTheDocument();
  });
});
