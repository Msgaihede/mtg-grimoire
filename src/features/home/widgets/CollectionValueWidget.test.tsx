import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type QueryState,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickOption } from "@/test-dropdown";
import type { BreakdownRow, CollectionSummary, HomeWidget } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import type { WidgetProps } from "../widgetProps";
import type { BreakdownDimension } from "../widgets";
import { collectionBreakdownKey, collectionTotalKey } from "../keys";
import { CollectionValueWidget } from "./CollectionValueWidget";

/**
 * Nothing here mocks `@/lib/ipc`, and that is the point rather than a preference: a bare
 * `vi.fn()` standing in for a command types nothing, so a field added to `CollectionSummary` or
 * to `BreakdownRow` would fail at run time inside a render instead of failing `tsc`. The widget
 * exports its two query keys precisely so a test — and Wave 6's stories — seed the cache
 * instead, which is `useHomeLayout`'s own arrangement one folder up.
 *
 * `staleTime: Infinity` is what makes the seeds *the* answer: a seeded entry is fresh, so no
 * observer ever reaches the real `invoke` (which rejects under jsdom) and every case below is
 * about the data it names rather than about a race with a failing round trip.
 */
const MARKETPLACE: MarketplaceId = "tcgplayer";

const HEADING = "Collection value";
const PICKER = `${HEADING} by`;

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

/** The four buckets every priced case below is written against — `$2,100` and `$900` so the
 *  spoken shares are a round 70 % and 30 %, and one bucket the marketplace priced nothing in. */
const RARITY_ROWS: BreakdownRow[] = [
  row({ key: "common", cards: 1204, value: 2100 }),
  row({ key: "rare", cards: 120, value: 900 }),
  row({ key: "mythic", cards: 12, value: null }),
];

function widget(config: unknown = null, over: Partial<HomeWidget> = {}): HomeWidget {
  return { id: "collectionValue", kind: "collectionValue", span: 1, config, ...over };
}

/** Every prop the widget cannot be drawn without, freshly spied per call — a shared spy makes
 *  `toHaveBeenCalledTimes(1)` a fact about vitest's file order. */
function props(over: Partial<WidgetProps> = {}): WidgetProps {
  return {
    widget: widget(),
    editing: false,
    onConfig: vi.fn(),
    onRemove: vi.fn(),
    onSpan: vi.fn(),
    dragHandleRef: vi.fn(),
    onNudge: vi.fn(),
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
 * off; left on, the observer would re-run the read the moment it mounted and this case would be
 * about the real `invoke` failing under jsdom rather than about the sentence the widget draws.
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

function draw(over: Partial<WidgetProps> = {}) {
  return render(
    <QueryClientProvider client={client}>
      <CollectionValueWidget {...props(over)} />
    </QueryClientProvider>,
  );
}

/** The `<dd>` beside a figure's label, which is where the value and its note both live. */
function figure(label: string): HTMLElement {
  return screen.getByText(label).nextElementSibling as HTMLElement;
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
   * **The sentences are the accessible story and the bars are decoration over them**, which is
   * `StatsCard`'s standing rule — so this is what a screen reader gets and what a test asserts.
   * Each names the count, the money and the share the (aria-hidden) track is drawing.
   *
   * The unpriced bucket says so in words rather than carrying an em dash: `"worth —"` read aloud
   * is a punctuation mark, and `null` means this marketplace priced nothing here rather than that
   * the bucket is worth nothing.
   */
  it("speaks one sentence per bar, naming the count, the money and the share", () => {
    seed("rarity", RARITY_ROWS);

    draw({ widget: widget({ dimension: "rarity" }) });

    expect(
      screen.getByText("1,204 cards of Common rarity, worth $2,100.00, 70% of the total"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("120 cards of Rare rarity, worth $900.00, 30% of the total"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("12 cards of Mythic rarity, with no TCGplayer price"),
    ).toBeInTheDocument();
  });

  /**
   * The total, and the count that keeps it honest. A value that silently omits 7 copies is a
   * number that lies by rounding down, and `unpriced` is counted at the marketplace the value was
   * summed at — so the note travels with the figure rather than standing on its own.
   */
  it("draws the total and the unpriced note beside it", () => {
    seed("rarity", RARITY_ROWS, summary({ value: 3000, unpriced: 7, totalCards: 1336 }));

    draw({ widget: widget({ dimension: "rarity" }) });

    expect(figure("Value (USD)")).toHaveTextContent("$3,000.00");
    expect(figure("Value (USD)")).toHaveTextContent("7 unpriced");
    expect(figure("Cards")).toHaveTextContent("1,336");
  });

  /** No note where there is nothing to qualify — a permanent "0 unpriced" is chrome that has
   *  never once been the answer to anything. */
  it("says nothing about unpriced copies when there are none", () => {
    seed("rarity", RARITY_ROWS, summary({ unpriced: 0 }));

    draw({ widget: widget({ dimension: "rarity" }) });

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
  });

  /**
   * Choosing a dimension writes the config **once**, and writes it by spreading what was stored.
   *
   * The spread is the half worth pinning: `widgetConfig` carries through keys this build does not
   * know about, so replacing the object wholesale is how an older build silently deletes a newer
   * one's settings. `ranked` stands in for that key here.
   */
  it("writes the picked dimension exactly once, keeping the config it did not name", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    seed("rarity", RARITY_ROWS);

    draw({ widget: widget({ dimension: "rarity", ranked: true }), onConfig });
    await pickOption(user, PICKER, "Set");

    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig).toHaveBeenCalledWith({ dimension: "set", ranked: true });
  });

  /**
   * **`widgetConfig` checks a shape and cannot check a vocabulary**, so a stored
   * `dimension: "bogus"` passes it as a string — and the backend refuses a fifth word in a
   * sentence rather than answering it. Narrowing here is what turns a hand-edited row, or a
   * newer build's word, into the default rather than into a refusal the reader has to read.
   */
  it("falls back to the default dimension when the stored word is not one of the four", () => {
    seed("rarity", RARITY_ROWS);

    draw({ widget: widget({ dimension: "bogus" }) });

    expect(screen.getByRole("button", { name: PICKER })).toHaveTextContent("Rarity");
    expect(screen.getByText("Common")).toBeInTheDocument();
  });

  /**
   * Everything past the eighth bucket is one bar, and the fold keeps both figures — so the bars
   * still sum to the total above them. `null` contributes nothing and a number lifts the fold out
   * of `null`, which is `sum()` over a `NULL` one statement lower down.
   */
  it("folds everything past the eighth bucket into one bar that keeps its figures", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      row({ key: `s${i}`, name: `Set ${i}`, cards: 2, value: 100 - i }),
    );
    seed("set", rows);

    draw({ widget: widget({ dimension: "set" }) });

    // The three smallest — 92 + 91 + 90 — with their six cards.
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText(/^6 cards from every other set, worth \$273\.00/)).toBeInTheDocument();
  });

  /**
   * The read is in flight: a sentence, and never an empty card that reads as a cleared one.
   *
   * Nothing is seeded, which **is** the state — a query with no cache entry is one that has not
   * answered. The assertion is synchronous for that reason: what the widget draws on its first
   * render is the whole of what this case is about.
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
});
