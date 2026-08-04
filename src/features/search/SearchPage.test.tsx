import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

/** `n` distinct rows starting at `from`, so a page-2 row is tellable from a page-1 one. */
const cards = (n: number, from = 0): CardSummary[] =>
  Array.from({ length: n }, (_, i) => ({ ...BOLT, id: `c${from + i}`, name: `Card ${from + i}` }));

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** The `text` of every request the page has sent, oldest first. */
const requestedTexts = () => searchCards.mock.calls.map((c) => (c[0] as SearchRequest).text);

const lastRequest = () =>
  searchCards.mock.calls[searchCards.mock.calls.length - 1][0] as SearchRequest;

/**
 * How tall the scroll container pretends to be. Raise it in a test that needs the
 * virtualiser to render deep enough into the list to trip the paging effect.
 */
let viewportHeight = 600;

/** Every `scrollTo` the virtualiser performs — how the scroll reset is observed. */
const scrollTo = vi.fn();

/**
 * jsdom lays nothing out: every element measures 0, so the virtualiser computes an empty
 * window and renders no rows at all. `@tanstack/react-virtual` sizes its scroll container
 * with `offsetHeight`, so one number is the whole of what it is missing. It scrolls
 * through `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => viewportHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
});

beforeEach(() => {
  viewportHeight = 600;
  scrollTo.mockClear();
  searchCards.mockReset().mockResolvedValue(page([BOLT]));
});

afterEach(() => {
  vi.useRealTimers();
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

  it("coalesces keystrokes into one request, 300 ms after the last of them", async () => {
    // Only the two functions the debounce itself uses, so nothing else in the stack has
    // to cope with a frozen clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    wrap(<SearchPage />);
    await act(async () => {});

    // `fireEvent`, not `userEvent`: userEvent awaits Testing Library's async wrapper,
    // which drains the microtask queue through a real `setTimeout(…, 0)` and advances
    // only *jest* fake timers to get it back. Under vitest's that promise never settles
    // and the test hangs instead of failing. Four value changes are what typing "bolt"
    // amounts to as far as the debounce can tell.
    const input = screen.getByPlaceholderText(/search cards/i);
    for (const value of ["b", "bo", "bol", "bolt"]) {
      fireEvent.change(input, { target: { value } });
    }

    // Four keystrokes, and still only the opening browse: no `b`/`bo`/`bol` escaped.
    expect(requestedTexts()).toEqual([undefined]);
    await act(async () => void vi.advanceTimersByTime(299));
    expect(requestedTexts()).toEqual([undefined]);

    await act(async () => void vi.advanceTimersByTime(1));
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

  it("keeps the previous rows on screen while a new filter is still loading", async () => {
    searchCards
      .mockResolvedValueOnce(page([BOLT]))
      // The refined search never answers — as a search waiting out an ingest's lock does.
      .mockImplementationOnce(() => new Promise<SearchResponse>(() => {}));
    wrap(<SearchPage />);
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/format/i), "modern");
    await waitFor(() => expect(searchCards).toHaveBeenCalledTimes(2));

    // `keepPreviousData`: the list does not blank out while the new page is in flight.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText(/searching…/i)).toBeInTheDocument();
  });

  it("resets the scroll position when the search changes", async () => {
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");
    scrollTo.mockClear();

    await userEvent.selectOptions(screen.getByLabelText(/format/i), "modern");

    // Without this the browser clamps the old offset into the new, shorter list — which
    // strands the reader at the bottom and trips the paging effect immediately.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 })));
  });

  it("fetches the next page as the reader nears the bottom, once and not again", async () => {
    // Tall enough that the virtualiser renders past 80 % of the first page.
    viewportHeight = 2400;
    let releasePageTwo: (r: SearchResponse) => void = () => {};
    searchCards
      .mockResolvedValueOnce(page(cards(50), 120))
      .mockImplementationOnce(
        () => new Promise<SearchResponse>((resolve) => (releasePageTwo = resolve)),
      );
    wrap(<SearchPage />);

    await waitFor(() => expect(searchCards).toHaveBeenCalledTimes(2));
    expect(searchCards.mock.calls[1][0]).toMatchObject({ offset: 50, limit: 50 });

    // Page 2 is still in flight, and every re-render while it is re-runs the effect.
    // `isFetchingNextPage` is what stops that becoming a second identical request.
    await act(async () => {});
    expect(searchCards).toHaveBeenCalledTimes(2);

    await act(async () => releasePageTwo(page(cards(50, 50), 120)));
    expect(screen.getByText("Card 0")).toBeInTheDocument();
    // 100 of 120 rows loaded now puts the 80 % mark below the rendered window again.
    expect(searchCards).toHaveBeenCalledTimes(2);
  });

  it("keeps the loaded rows when a later page fails, and offers a retry", async () => {
    viewportHeight = 2400;
    searchCards
      .mockResolvedValueOnce(page(cards(50), 120))
      .mockRejectedValueOnce("database is locked")
      .mockResolvedValueOnce(page(cards(50, 50), 120));
    wrap(<SearchPage />);

    expect(await screen.findByText(/could not load more cards/i)).toBeInTheDocument();
    // query-core keeps `data` on error: the 50 rows already read must survive page 2's
    // rejection, not be replaced by a full-page error.
    expect(screen.getByText("Card 0")).toBeInTheDocument();
    expect(screen.getByText("Card 49")).toBeInTheDocument();

    // And the failure stops the auto-pager rather than letting it retry on every render.
    await act(async () => {});
    expect(searchCards).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(screen.getByText("Card 50")).toBeInTheDocument());
    expect(screen.queryByText(/could not load more cards/i)).not.toBeInTheDocument();
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
