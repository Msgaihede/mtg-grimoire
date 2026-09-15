import { render, screen } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type QueryState,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BreakdownRow, CollectionSummary, HomeWidget } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { collectionBreakdownKey, collectionTotalKey } from "../keys";
import type { WidgetBodyProps } from "../widgetProps";
import type { BreakdownDimension } from "../widgets";
import { collectionDimension, CollectionValueWidget } from "./CollectionValueWidget";

/**
 * Nothing here mocks `@/lib/ipc`, and that is the point rather than a preference: a bare
 * `vi.fn()` standing in for a command types nothing, so a field added to `CollectionSummary` or
 * to `BreakdownRow` would fail at run time inside a render instead of failing `tsc`. The two keys
 * live in `../keys` precisely so a test — and the stories — seed the cache instead.
 *
 * `staleTime: Infinity` is what makes the seeds *the* answer: a seeded entry is fresh, so no
 * observer ever reaches the real `invoke` (which rejects under jsdom) and every case below is
 * about the data it names rather than about a race with a failing round trip.
 */
const MARKETPLACE: MarketplaceId = "tcgplayer";

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({
    // `retryOnMount: false` is what lets {@link seedRefusal} below stand: without it an observer
    // mounting on a query that has never held data re-runs the read, which here is the real
    // `invoke` and would replace the refusal the case is about.
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  // The two rows `useMarketplace` reads. Seeded rather than left to answer late, so the currency
  // is settled before the first render and no figure is written in the wrong money.
  client.setQueryData(MARKETPLACE_KEY, MARKETPLACE);
  client.setQueryData(MARKETPLACE_FEEDS_KEY, []);
});

/** The aggregate, annotated so the mirror checks the fixture. */
function summary(over: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    totalCards: 1336,
    uniqueCards: 900,
    entries: 900,
    tradelistCards: 0,
    value: 3000,
    unpriced: 0,
    needsReview: 0,
    ...over,
  };
}

/** One bucket, likewise. */
function row(over: Partial<BreakdownRow> = {}): BreakdownRow {
  return { key: "common", name: null, cards: 1, value: 0, ...over };
}

/** Three buckets — `$2,100` and `$900` so the spoken shares are a round 70 % and 30 %, and one
 *  bucket the marketplace priced nothing in. */
const RARITY_ROWS: BreakdownRow[] = [
  row({ key: "common", cards: 1204, value: 2100 }),
  row({ key: "rare", cards: 120, value: 900 }),
  row({ key: "mythic", cards: 12, value: null }),
];

/** Eleven sets, each a dollar cheaper than the last. */
const ELEVEN_SETS: BreakdownRow[] = Array.from({ length: 11 }, (_, i) =>
  row({ key: `s${i}`, name: `Set ${i}`, cards: 2, value: 100 - i }),
);

function widget(config: unknown = null, w = 2, h = 3): HomeWidget {
  return { id: "collectionValue", kind: "collectionValue", x: 0, y: 0, w, h, config };
}

/**
 * A fit on a grid of `cell`-pixel cells — the page's own arithmetic, so a case names a footprint
 * and a cell size and the whole-row count falls out of `fit.ts` rather than out of this file.
 *
 * The four this suite leans on, at comfortable density:
 * * **2×3 at 104px** — body 286px; figures leave room for 5 bars, no figures 7.
 * * **2×2 at 68px** — body 98px; the figure line takes it all and room is **0**.
 * * **4×6 at 104px** — tier 2, a footer, 14 rows of room and two list columns.
 * * **3×3 at 104px** — tier 1: a list row carries its money at the right, no footer.
 */
function fitOf(w: number, h: number, cell = 104): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, cell),
    heightPx: spanPx(h, cell),
    density: "comfortable",
  });
}

/** Every prop a body is drawn with, freshly spied per call. */
function props(over: Partial<WidgetBodyProps> = {}): WidgetBodyProps {
  const drawn = over.widget ?? widget();
  return {
    widget: drawn,
    fit: fitOf(drawn.w, drawn.h),
    editing: false,
    still: false,
    onConfig: vi.fn(),
    ...over,
  };
}

/** Both reads answered, at the marketplace the suite pins. */
function seed(dimension: BreakdownDimension, rows: BreakdownRow[], total = summary()): void {
  client.setQueryData(collectionTotalKey(MARKETPLACE), total);
  client.setQueryData(collectionBreakdownKey(dimension, MARKETPLACE), rows);
}

/**
 * Put one query into the one state `setQueryData` cannot express: refused.
 *
 * A read that failed is not a value, so there is no data to seed — the cache entry is built and
 * its state written directly. It stays refused because the client above turns `retryOnMount`
 * off.
 */
function seedRefusal(key: QueryKey, message: string): void {
  const state: Partial<QueryState<unknown, Error>> = {
    status: "error",
    fetchStatus: "idle",
    error: new Error(message),
    errorUpdatedAt: Date.now(),
  };
  client.getQueryCache().build(client, { queryKey: key }).setState(state);
}

function draw(over: Partial<WidgetBodyProps> = {}) {
  return render(
    <QueryClientProvider client={client}>
      <CollectionValueWidget {...props(over)} />
    </QueryClientProvider>,
  );
}

/** The value line under a figure's label, which is where the number and its note both live. */
function figure(label: string): HTMLElement {
  return screen.getByText(label).nextElementSibling as HTMLElement;
}

/** The bars' spoken sentences, in order — the drawing is `aria-hidden`, so this is the whole of
 *  what the chart says. */
function sentences(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("li > .sr-only")).map((el) => el.textContent ?? "");
}

describe("CollectionValueWidget", () => {
  /**
   * The four dimensions the backend answers, each with the key vocabulary it actually returns —
   * the rarity word, an **uppercase** colour letter beside the lowercase `"c"` and `"multi"`,
   * a set code with its name beside it, and a finish. Getting one of those wrong is a bar
   * labelled with a raw column value, which no other case here would catch.
   */
  it.each([
    ["rarity" as const, RARITY_ROWS, ["Common", "Rare", "Mythic"]],
    [
      "color" as const,
      [
        row({ key: "U", cards: 300, value: 500 }),
        row({ key: "multi", cards: 90, value: 300 }),
        row({ key: "c", cards: 40, value: 100 }),
      ],
      ["Blue", "Multicolour", "Colorless"],
    ],
    [
      "set" as const,
      [
        row({ key: "lea", name: "Limited Edition Alpha", cards: 4, value: 900 }),
        // An orphaned bucket: the printing left the corpus and took the set's name with it.
        row({ key: "xyz", name: null, cards: 2, value: 10 }),
      ],
      ["Limited Edition Alpha", "XYZ"],
    ],
    [
      "finish" as const,
      [
        row({ key: "nonfoil", cards: 900, value: 700 }),
        row({ key: "foil", cards: 40, value: 400 }),
        row({ key: "etched", cards: 4, value: 40 }),
      ],
      ["Nonfoil", "Foil", "Etched"],
    ],
  ])("draws the %s breakdown with its own vocabulary", (dimension, rows, labels) => {
    seed(dimension, rows);

    draw({ widget: widget({ dimension }) });

    for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument();
  });

  /**
   * **The sentences are the accessible story and the bars are decoration over them** — so this is
   * what a screen reader gets and what a test asserts. Each names the count, the money and the
   * share of the whole.
   *
   * The unpriced bucket says so in words rather than carrying an em dash: `"worth —"` read aloud
   * is a punctuation mark, and `null` means this marketplace priced nothing here rather than that
   * the bucket is worth nothing.
   */
  it("speaks one sentence per bar, naming the count, the money and the share", () => {
    seed("rarity", RARITY_ROWS);

    const { container } = draw({ widget: widget({ dimension: "rarity" }) });

    expect(sentences(container)).toEqual([
      "1,204 cards of Common rarity, worth $2,100.00, 70% of the total",
      "120 cards of Rare rarity, worth $900.00, 30% of the total",
      "12 cards of Mythic rarity, with no TCGplayer price",
    ]);
  });

  /** Ranked by money whatever order the rows arrive in, and the unpriced bucket sinks to the foot
   *  — the order is the information this widget exists to give. */
  it("ranks the buckets by value, dearest first, with the unpriced ones last", () => {
    seed("rarity", [
      row({ key: "mythic", cards: 12, value: null }),
      row({ key: "rare", cards: 120, value: 900 }),
      row({ key: "common", cards: 1204, value: 2100 }),
    ]);

    const { container } = draw({ widget: widget({ dimension: "rarity" }) });

    expect(sentences(container)).toEqual([
      "1,204 cards of Common rarity, worth $2,100.00, 70% of the total",
      "120 cards of Rare rarity, worth $900.00, 30% of the total",
      "12 cards of Mythic rarity, with no TCGplayer price",
    ]);
  });

  /**
   * The total, and the count that keeps it honest. A value that silently omits 7 copies is a
   * number that lies by rounding down, and `unpriced` is counted at the marketplace the value was
   * summed at — so the note travels with the figure rather than standing on its own.
   *
   * On a panel rather than a tile, because `WidgetFigures` drops a note on a two-cell tile.
   */
  it("draws the total and the unpriced note beside it", () => {
    seed("rarity", RARITY_ROWS, summary({ value: 3000, unpriced: 7, totalCards: 1336 }));

    draw({ widget: widget({ dimension: "rarity" }, 3, 3) });

    expect(figure("Value (USD)")).toHaveTextContent("$3,000.00");
    expect(figure("Value (USD)")).toHaveTextContent("7 unpriced");
    expect(figure("Cards")).toHaveTextContent("1,336");
  });

  /** No note where there is nothing to qualify — a permanent "0 unpriced" is chrome that has
   *  never once been the answer to anything. */
  it("says nothing about unpriced copies when there are none", () => {
    seed("rarity", RARITY_ROWS, summary({ unpriced: 0 }));

    draw({ widget: widget({ dimension: "rarity" }, 3, 3) });

    expect(screen.queryByText(/unpriced/)).toBeNull();
  });

  /**
   * **A bucket the marketplace priced nothing in draws an em dash, never a zero** — and never
   * another marketplace's number. `$0.00` would be a claim the feed made and did not.
   */
  it("draws an em dash for a bucket with no price", () => {
    seed("rarity", RARITY_ROWS);

    draw({ widget: widget({ dimension: "rarity" }) });

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  /** Colour buckets are drawn in the colour they are, multicolour in gold; every other dimension
   *  is the accent, and a rarity says itself with a gem instead. */
  it("fills a colour bar in its mana colour and multicolour in gold", () => {
    seed("color", [
      row({ key: "U", cards: 300, value: 500 }),
      row({ key: "multi", cards: 90, value: 300 }),
    ]);

    const { container } = draw({ widget: widget({ dimension: "color" }) });

    const fills = Array.from(container.querySelectorAll<HTMLElement>("li span.h-full")).map(
      (fill) => fill.style.background,
    );
    expect(fills).toEqual(["var(--color-mana-u)", "var(--color-pie-gold)"]);
  });

  it("puts a rarity gem before a rarity bar's label", () => {
    seed("rarity", RARITY_ROWS);

    const { container } = draw({ widget: widget({ dimension: "rarity" }) });

    // `RarityGem`'s word is its accessible half; one per bar.
    expect(
      Array.from(container.querySelectorAll("li .sr-only"))
        .map((el) => el.textContent)
        .filter((text) => /^Rarity: \w/.test(text ?? "")),
    ).toEqual(["Rarity: common", "Rarity: rare", "Rarity: mythic"]);
  });

  /**
   * **`pickOf` checks a vocabulary where `widgetConfig` only checks a shape**, so a stored
   * `dimension: "bogus"` reads as the registry's first option — and the backend never sees a
   * fifth word it would refuse.
   */
  it("falls back to the default dimension when the stored word is not one of the four", () => {
    expect(collectionDimension(widget({ dimension: "bogus" }))).toBe("rarity");
    expect(collectionDimension(widget({ dimension: 7 }))).toBe("rarity");
    expect(collectionDimension(widget(null))).toBe("rarity");
    expect(collectionDimension(widget({ dimension: "finish" }))).toBe("finish");

    seed("rarity", RARITY_ROWS);
    draw({ widget: widget({ dimension: "bogus" }) });
    expect(screen.getByText("Common")).toBeInTheDocument();
  });

  /**
   * **The chart is cut to the whole rows the card has, and what does not fit is one `Other`** — so
   * the bars still sum to the total. A 2×3 tile at 104px cells holds five rows under its figures:
   * four sets and the fold of the other seven, `null` contributing nothing, a number lifting the
   * fold out of `null`.
   */
  it("cuts the buckets to the room and folds the rest into Other, keeping its figures", () => {
    seed("set", ELEVEN_SETS);

    const { container } = draw({ widget: widget({ dimension: "set" }) });

    const spoken = sentences(container);
    expect(spoken).toHaveLength(5);
    expect(screen.getByText("Other")).toBeInTheDocument();
    // Sets 4 to 10 — 96 + 95 + … + 90 — with their fourteen cards, of the eleven's $1,045.
    expect(spoken[4]).toBe("14 cards from every other set, worth $651.00, 62% of the total");
  });

  /** The same eleven sets with the totals switched off: the figure line's pixels go to the chart,
   *  and seven rows fit where five did. */
  it("gives the figure line's room to the chart when totals are switched off", () => {
    seed("set", ELEVEN_SETS);

    const { container } = draw({ widget: widget({ dimension: "set", figures: false }) });

    expect(screen.queryByText("Value (USD)")).toBeNull();
    expect(screen.queryByText("Cards")).toBeNull();
    expect(sentences(container)).toHaveLength(7);
  });

  /**
   * **A tile too short for a bar under its figures draws the figures and no bars** — two honest
   * numbers rather than a bar the card's edge cuts through. Zero is a real answer, and the footer
   * goes with the chart.
   */
  it("draws only the figures on a tile with no room for a bar", () => {
    seed("rarity", RARITY_ROWS);

    const { container } = draw({
      widget: widget({ dimension: "rarity" }, 2, 2),
      fit: fitOf(2, 2, 68),
    });

    expect(figure("Value (USD)")).toHaveTextContent("$3,000.00");
    expect(sentences(container)).toEqual([]);
    expect(container.querySelector("ul")).toBeNull();
    expect(screen.queryByText(/split by/)).toBeNull();
  });

  /** One slot draws the dearest bucket alone rather than a lone `Other` — a fold with nothing
   *  beside it would be the total a second time, in a sentence that does not parse. */
  it("draws the dearest bucket alone when only one row fits", () => {
    seed("set", ELEVEN_SETS);
    // 2×2 at 80px cells: a 122px body, one 32px row under the 74px figure line.
    const fit = fitOf(2, 2, 80);
    expect(fit.fitCount(32, 74)).toBe(1);

    const { container } = draw({ widget: widget({ dimension: "set" }, 2, 2), fit });

    expect(sentences(container)).toEqual([
      "2 cards from Set 0, worth $100.00, 10% of the total",
    ]);
  });

  /** `chart: list` draws the buckets as rows — a name and its money — and no bars. */
  it("draws rows instead of bars when the chart is a list", () => {
    seed("rarity", RARITY_ROWS);

    const { container } = draw({ widget: widget({ dimension: "rarity", chart: "list" }, 3, 3) });

    expect(sentences(container)).toEqual([]);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((item) => item.textContent)).toEqual([
      "Common$2,100.00",
      "Rare$900.00",
      "Mythic—",
    ]);
  });

  /** On a two-cell tile a list row has no width for a name and a figure side by side, so the money
   *  is the caption under the name, in body ink. */
  it("moves a list row's money under its name on a two-cell tile", () => {
    seed("rarity", RARITY_ROWS);

    draw({ widget: widget({ dimension: "rarity", chart: "list" }) });

    const money = screen.getByText("$2,100.00");
    expect(money.previousElementSibling).toHaveTextContent("Common");
    expect(money.classList.contains("text-text")).toBe(true);
  });

  /** A band carries the provenance and the cut at its foot; a tile does not. */
  it("names the marketplace and the cut in a footer on a band", () => {
    seed("finish", [row({ key: "nonfoil", cards: 900, value: 700 })]);

    draw({ widget: widget({ dimension: "finish" }, 4, 6) });

    expect(
      screen.getByText("TCGplayer prices as of the last card-data sync · split by finish"),
    ).toBeInTheDocument();
  });

  it("draws no footer on a tile", () => {
    seed("finish", [row({ key: "nonfoil", cards: 900, value: 700 })]);

    draw({ widget: widget({ dimension: "finish" }) });

    expect(screen.queryByText(/split by/)).toBeNull();
  });

  /**
   * The read is in flight: a sentence, and never an empty card that reads as a cleared one.
   *
   * Nothing is seeded, which **is** the state — a query with no cache entry is one that has not
   * answered. The assertion is synchronous for that reason.
   */
  it("says it is counting while the reads are in flight", () => {
    draw({ widget: widget({ dimension: "rarity" }) });

    expect(screen.getByText("Counting your collection…")).toBeInTheDocument();
  });

  /** Nothing owned yet — a real answer, and a different sentence from the one above it. */
  it("says the collection is empty when the breakdown answers nothing", () => {
    seed("rarity", [], summary({ totalCards: 0, value: 0, unpriced: 0 }));

    draw({ widget: widget({ dimension: "rarity" }) });

    expect(screen.getByText("Nothing in your collection yet.")).toBeInTheDocument();
  });

  /**
   * A refused read is words, through `ipcError`, and it **outranks the loading sentence** — a
   * card that went on saying "counting" over a read which will never answer is the one failure a
   * reader cannot act on.
   */
  it("says so when a read is refused, in the backend's own words", () => {
    // The breakdown is left in flight beside it, which is what makes the *order* of the two
    // states testable: a refusal outranks a read that has not answered.
    seedRefusal(collectionTotalKey(MARKETPLACE), "BUSY: a sync holds the write connection");

    draw({ widget: widget({ dimension: "rarity" }) });

    expect(screen.getByText(/Your collection could not be read/)).toHaveTextContent(
      "BUSY: a sync holds the write connection",
    );
    expect(screen.queryByText("Counting your collection…")).toBeNull();
  });

  /** A catalogue preview is the same drawing, and nothing in it is a control to press. */
  it("draws nothing pressable, still or not", () => {
    seed("rarity", RARITY_ROWS);

    draw({ widget: widget({ dimension: "rarity" }), still: true });

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByText("Common")).toBeInTheDocument();
  });
});
