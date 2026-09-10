import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BreakdownRow, HomeWidget, WishlistSummary } from "@/lib/ipc";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { pickOption } from "@/test-dropdown";
import type { WidgetChrome } from "../widgetProps";
import { wishlistBreakdownKey, wishlistTotalKey } from "../keys";
import { readDimension, WishlistValueWidget } from "./WishlistValueWidget";

/**
 * **The queries are seeded through the widget's own exported keys, and `@/lib/ipc` is never
 * mocked.** A `vi.fn()` over that module replaces the whole `ipc` object, which is what erases
 * the mirror `ipc.test.ts` asserts the Rust command names against — so a field that stopped
 * existing would still pass here. Seeding the cache instead exercises the real module and pins
 * the key, which is the other half of the contract: an invalidation of `["wishlist"]` — the one
 * every wishlist write already makes — has to reach these two entries.
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

function widgetOf(config: unknown, span = 1): HomeWidget {
  return { id: "wishlistValue", kind: "wishlistValue", span, config };
}

/** Everything the page does to a widget. None of it is what these tests are about, so it is one
 *  object rather than five props repeated per case. */
function chrome(): WidgetChrome {
  return {
    editing: false,
    onRemove: vi.fn(),
    onSpan: vi.fn(),
    dragHandleRef: vi.fn(),
    onNudge: vi.fn(),
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

const card = () => screen.getByRole("region", { name: "Wishlist value" });

/** The bars' spoken sentences, in order. The drawing itself is `aria-hidden`, so this is the
 *  whole of what the widget actually says about its buckets. */
function sentences(): string[] {
  return Array.from(card().querySelectorAll("li > .sr-only")).map((el) => el.textContent ?? "");
}

describe("WishlistValueWidget", () => {
  it("draws the total cost and the note that says what it leaves out", () => {
    render(<WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    expect(within(card()).getByText("$128.50")).toBeInTheDocument();
    expect(within(card()).getByText("4 copies nobody quotes a price for")).toBeInTheDocument();
  });

  it("says nothing about a price it does not have, per bucket", () => {
    render(<WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    // An em dash and never `$0.00`: the marketplace priced nothing in this bucket, which is a
    // different statement from a bucket worth nothing. Two of them, because a bucket with no
    // money in it also has no share of the total — `percent(null)` is the same statement about
    // the same hole.
    expect(within(card()).getAllByText("—")).toHaveLength(2);
    expect(within(card()).queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("gives every bar a sentence naming its bucket, its copies and its money", () => {
    render(<WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    expect(sentences()).toEqual([
      "Mythic: 12 copies, $80.00, 62% of the total.",
      "Rare: 20 copies, $40.00, 31% of the total.",
      "Common: 25 copies, $8.50, 7% of the total.",
      // Not "0% of the total", and not a price: a wish nobody will quote is a wish you cannot be
      // told the cost of, which is the wishlist's own version of this hole.
      "Unknown rarity: 6 copies, no price to buy at TCGplayer.",
    ]);
  });

  it("draws the picture as decoration and makes none of it a control", () => {
    const { container } = render(
      <WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />,
      { wrapper: world(SUMMARY, { rarity: RARITY }) },
    );

    // The only control in the card is the dimension dropdown — a bar is a `<span>`, exactly as
    // the deck stats band's are.
    expect(within(card()).getAllByRole("button")).toHaveLength(1);
    // Every track is hidden from the accessibility tree, and every fill is a CSS colour string
    // rather than an interpolated Tailwind class, which would emit no rule at all.
    const tracks = Array.from(container.querySelectorAll("li > span[aria-hidden] > span"));
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) expect(track.closest("[aria-hidden]")).not.toBeNull();
  });

  it.each([
    ["rarity", RARITY, ["Mythic", "Rare", "Common", "Unknown rarity"]],
    ["color", COLOR, ["Multicolor", "Blue", "Colorless"]],
    ["set", SET, ["Modern Horizons 3", "Unknown set"]],
    ["finish", FINISH, ["Any finish", "Foil"]],
  ] as const)("names every bucket of the %s dimension", (dimension, rows, labels) => {
    render(
      <WishlistValueWidget widget={widgetOf({ dimension })} onConfig={vi.fn()} {...chrome()} />,
      { wrapper: world(SUMMARY, { [dimension]: rows }) },
    );

    const spoken = sentences();
    expect(spoken).toHaveLength(labels.length);
    labels.forEach((label, i) => expect(spoken[i]).toMatch(new RegExp(`^${label}: `)));
  });

  it("writes the chosen dimension back once, keeping the rest of the config", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    render(
      <WishlistValueWidget
        // A key this build has never heard of, sitting beside the one it owns. Spreading is what
        // stops this build deleting a newer one's settings on the reader's next press.
        widget={widgetOf({ dimension: "rarity", sparkline: true })}
        onConfig={onConfig}
        {...chrome()}
      />,
      { wrapper: world(SUMMARY, { rarity: RARITY, set: SET }) },
    );

    await pickOption(user, /Break down/, "Set");

    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig).toHaveBeenCalledWith({ dimension: "set", sparkline: true });
  });

  it("narrows a stored dimension this build has no column for", () => {
    // `widgetConfig` checks a *shape* and cannot check a vocabulary — a stored `"bogus"` is a
    // string and passes it — so the widget narrows the word itself.
    expect(readDimension(widgetOf({ dimension: "bogus" }))).toBe("rarity");
    expect(readDimension(widgetOf({ dimension: 7 }))).toBe("rarity");
    expect(readDimension(widgetOf(null))).toBe("rarity");
    expect(readDimension(widgetOf({ dimension: "finish" }))).toBe("finish");
  });

  it("draws the bars of the dimension it narrowed to, not an empty chart", () => {
    render(
      <WishlistValueWidget
        widget={widgetOf({ dimension: "bogus" })}
        onConfig={vi.fn()}
        {...chrome()}
      />,
      { wrapper: world(SUMMARY, { rarity: RARITY }) },
    );

    expect(sentences()[0]).toBe("Mythic: 12 copies, $80.00, 62% of the total.");
  });

  it("says it is still working while the reads are in flight", () => {
    render(<WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: LiveWorld,
    });

    // Synchronously, before the rejection below can land: a query's first render is always
    // pending, and nothing can run between `render` and this assertion.
    expect(within(card()).getByText("Adding up what your wishlist would cost…")).toBeInTheDocument();
  });

  it("says the wishlist is empty in the wishlist's own words", () => {
    render(<WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: world(NO_WISHES, { rarity: [] }),
    });

    expect(
      within(card()).getByText("You want nothing yet — wish for a card and its cost lands here."),
    ).toBeInTheDocument();
    // Never a total over an empty list: `$0.00` is a price nobody quoted.
    expect(within(card()).queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("says so when the read is refused", async () => {
    render(<WishlistValueWidget widget={widgetOf(null)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: LiveWorld,
    });

    await waitFor(() =>
      expect(within(card()).getByText(/Could not price your wishlist/)).toBeInTheDocument(),
    );
    expect(within(card()).queryByText(/Adding up/)).not.toBeInTheDocument();
  });

  it("is drawn across the whole line when the stored span says so", () => {
    render(<WishlistValueWidget widget={widgetOf(null, 2)} onConfig={vi.fn()} {...chrome()} />, {
      wrapper: world(SUMMARY, { rarity: RARITY }),
    });

    // `classList.contains`, never a string match — a `hover:` variant makes that assertion
    // vacuous.
    expect(card().classList.contains("basis-full")).toBe(true);
  });
});
