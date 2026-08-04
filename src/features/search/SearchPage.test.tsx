import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardSummary, SearchRequest, SearchResponse } from "@/lib/ipc";

const searchCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards, syncStatus: vi.fn(), syncRun: vi.fn(), onSyncProgress: vi.fn() },
}));

import { SearchPage } from "./SearchPage";
import { needsNextPage, nextOffset } from "./useCardSearch";

const BOLT: CardSummary = {
  id: "1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  priceUsd: 400.5,
  layout: "normal",
};

/** Every nullable column at once — the shape a token or an unpriced printing arrives in. */
const SPARSE: CardSummary = {
  id: "2",
  name: "Nameless Race",
  setCode: "chr",
  setName: null,
  collectorNumber: "99b",
  rarity: null,
  typeLine: null,
  manaCost: null,
  priceUsd: null,
  layout: "normal",
};

const page = (items: CardSummary[], total = items.length): SearchResponse => ({ items, total });

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** The `text` of every request the page has sent, oldest first. */
const requestedTexts = () => searchCards.mock.calls.map((c) => (c[0] as SearchRequest).text);

const lastRequest = () =>
  searchCards.mock.calls[searchCards.mock.calls.length - 1][0] as SearchRequest;

/**
 * jsdom lays nothing out: every element measures 0, so the virtualiser computes an empty
 * window and renders no rows at all. `@tanstack/react-virtual` sizes its scroll container
 * with `offsetHeight`, so one number is the whole of what it is missing.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
});

beforeEach(() => {
  searchCards.mockReset().mockResolvedValue(page([BOLT]));
});

describe("SearchPage", () => {
  it("searches after the debounce and renders the result row", async () => {
    wrap(<SearchPage />);

    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "bolt");

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "bolt", offset: 0, limit: 50 }),
      ),
    );
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("$400.50")).toBeInTheDocument();
    expect(screen.getByText(/LEA/)).toBeInTheDocument();
  });

  it("coalesces keystrokes into a single request", async () => {
    wrap(<SearchPage />);

    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "bolt");

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(expect.objectContaining({ text: "bolt" })),
    );
    // The opening browse, then one search. No `b`/`bo`/`bol` in between.
    expect(requestedTexts()).toEqual([undefined, "bolt"]);
  });

  it("leaves every optional filter off the opening request", async () => {
    wrap(<SearchPage />);

    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    const req = lastRequest();
    expect(req.text).toBeUndefined();
    expect(req.format).toBeUndefined();
    expect(req.colors).toBeUndefined();
    // Omitted on purpose: the backend reads an absent `paperOnly` as true.
    expect(req.paperOnly).toBeUndefined();
    expect(req).toMatchObject({ limit: 50, offset: 0 });
  });

  it("passes the format filter", async () => {
    wrap(<SearchPage />);

    await userEvent.selectOptions(screen.getByLabelText(/format/i), "modern");

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(expect.objectContaining({ format: "modern" })),
    );
  });

  it("sends picked colours in WUBRG order, and colourless on its own", async () => {
    wrap(<SearchPage />);

    await userEvent.click(screen.getByRole("button", { name: /blue/i }));
    await userEvent.click(screen.getByRole("button", { name: /white/i }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(expect.objectContaining({ colors: "WU" })),
    );

    // `C` is exclusive: the backend reads "C" as colourless-only, so it cannot be
    // combined with a colour without meaning something else entirely.
    await userEvent.click(screen.getByRole("button", { name: /colorless/i }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(expect.objectContaining({ colors: "C" })),
    );
  });

  it("renders every nullable column without inventing a value", async () => {
    searchCards.mockResolvedValue(page([SPARSE]));
    wrap(<SearchPage />);

    expect(await screen.findByText("Nameless Race")).toBeInTheDocument();
    // Set code uppercased, collector number verbatim.
    expect(screen.getByText(/CHR/)).toBeInTheDocument();
    expect(screen.getByText(/99b/)).toBeInTheDocument();
    // Missing type, rarity and price each read as an em dash, never as "null" or "$0.00".
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("blames the empty database, not the query, when nothing has been synced", async () => {
    searchCards.mockResolvedValue(page([], 0));
    wrap(<SearchPage />);

    expect(await screen.findByText(/card database is empty/i)).toBeInTheDocument();
    expect(screen.queryByText(/no cards match/i)).not.toBeInTheDocument();
  });

  it("says no matches when a filtered search comes back empty", async () => {
    searchCards.mockResolvedValue(page([], 0));
    wrap(<SearchPage />);

    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "bolt");

    expect(await screen.findByText(/no cards match/i)).toBeInTheDocument();
    expect(screen.queryByText(/card database is empty/i)).not.toBeInTheDocument();
  });

  it("reports a rejected search", async () => {
    searchCards.mockRejectedValue("database is locked");
    wrap(<SearchPage />);

    expect(await screen.findByText(/database is locked/i)).toBeInTheDocument();
  });
});

/**
 * The pager's arithmetic, tested away from the component: jsdom gives the virtualizer no
 * layout, so the scroll that would drive it in a real window cannot happen here.
 */
describe("nextOffset", () => {
  it("asks for the next page at the number of rows already seen", () => {
    expect(nextOffset([page(Array(50).fill(BOLT), 120)])).toBe(50);
    expect(nextOffset([page(Array(50).fill(BOLT), 120), page(Array(50).fill(BOLT), 120)])).toBe(
      100,
    );
  });

  it("stops once the whole match set is loaded", () => {
    expect(nextOffset([page(Array(50).fill(BOLT), 50)])).toBeUndefined();
    expect(nextOffset([page(Array(50).fill(BOLT), 70), page(Array(20).fill(BOLT), 70)])).toBe(
      undefined,
    );
  });

  it("stops on a short page even when the total disagrees", () => {
    // `total` and the rows can disagree while a sync swaps the table underneath a pager;
    // trusting `total` alone would refetch the same empty page forever.
    expect(nextOffset([page([], 9999)])).toBeUndefined();
  });
});

describe("needsNextPage", () => {
  it("triggers once four fifths of the loaded rows are behind the viewport", () => {
    expect(needsNextPage(38, 50)).toBe(false);
    expect(needsNextPage(39, 50)).toBe(true);
    expect(needsNextPage(49, 50)).toBe(true);
  });

  it("never triggers on an empty list", () => {
    expect(needsNextPage(-1, 0)).toBe(false);
  });
});
