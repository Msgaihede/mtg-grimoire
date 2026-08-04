import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardSummary, SearchRequest, SearchResponse, SetSummary } from "@/lib/ipc";

const searchCards = vi.hoisted(() => vi.fn());
// The set picker mounts with the page and asks for the set list on the way up, so the
// mock has to answer it — a missing `listSets` is a rejected query, not a compile error.
const listSets = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    listSets,
    prefetchImages,
    syncStatus: vi.fn(),
    syncRun: vi.fn(),
    onSyncProgress: vi.fn(),
  },
}));

import { SearchPage } from "./SearchPage";
import { useAppStore } from "@/lib/store";
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

const page = (
  items: CardSummary[],
  total = items.length,
  totalIsCapped = false,
): SearchResponse => ({ items, total, totalIsCapped });

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

/** One set with printings, so the picker has something to pick. */
const ALPHA: SetSummary = {
  code: "lea",
  name: "Limited Edition Alpha",
  setType: "core",
  releasedAt: "1993-08-05",
  cardCount: 295,
};

beforeEach(() => {
  viewportHeight = 600;
  scrollTo.mockClear();
  searchCards.mockReset().mockResolvedValue(page([BOLT]));
  listSets.mockReset().mockResolvedValue([ALPHA]);
  prefetchImages.mockReset().mockResolvedValue(undefined);
  // The view opens on the art grid, which has no columns to assert on. Everything below
  // except the layout toggle's own describe is about the table, so it says so.
  useAppStore.setState({ searchView: "table", selectedCardId: null });
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

  /**
   * The middle of the wiring, which nothing else covers: `toggleIn` and
   * `activeFilterCount` are unit-tested, `FilterBar` is tested against a stub search and
   * `ipc.searchCards` is pinned against `invoke` — but between the chip and the request
   * sit the hook's state, the query key and the request body, and `sets`/`manaValues`
   * could be swapped, dropped or spelled wrong there with every one of those green.
   */
  it("turns a mana-value chip and a picked set into request fields", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        expect.objectContaining({ manaValues: [3], sets: undefined }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.click(await screen.findByRole("option", { name: /Alpha/ }));

    // Both at once: a second filter must narrow the first rather than replace it.
    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        expect.objectContaining({ sets: ["lea"], manaValues: [3] }),
      ),
    );
  });

  it("clears every filter in one request when Reset all is clicked", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    await userEvent.selectOptions(screen.getByLabelText(/format/i), "modern");
    await userEvent.click(screen.getByRole("button", { name: "Blue" }));
    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));
    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.click(await screen.findByRole("option", { name: /Alpha/ }));
    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "bolt");

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "bolt",
          format: "modern",
          colors: "U",
          sets: ["lea"],
          manaValues: [3],
        }),
      ),
    );

    // The badge counts kinds, not values: five filters are on and all five are one click
    // from gone.
    const reset = screen.getByRole("button", { name: /reset all/i });
    expect(reset).toHaveTextContent("5");
    await userEvent.click(reset);

    await waitFor(() => {
      const req = lastRequest();
      expect(req.text).toBeUndefined();
      expect(req.format).toBeUndefined();
      expect(req.colors).toBeUndefined();
      expect(req.sets).toBeUndefined();
      expect(req.manaValues).toBeUndefined();
    });
    expect(screen.queryByRole("button", { name: /reset all/i })).not.toBeInTheDocument();
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

  it("counts the matches, and says `+` when the backend stopped counting", async () => {
    searchCards.mockResolvedValue(page([BOLT], 42));
    const { unmount } = wrap(<SearchPage />);
    expect(await screen.findByText("42 cards")).toBeInTheDocument();
    unmount();

    // 5 000 is where the backend gives up counting, so a bare "5,000 cards" would be a
    // number the reader has no reason to doubt and no way to check.
    searchCards.mockResolvedValue(page([BOLT], 5000, true));
    wrap(<SearchPage />);

    expect(await screen.findByText("5,000+ cards")).toBeInTheDocument();
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

  /**
   * The table is the view for comparing prices, and picking one of the rows you are
   * comparing is the next thing a reader does. A row that only answers a mouse would make
   * this half of the app keyboard-inaccessible — the art grid's tiles are buttons and have
   * always answered both.
   */
  it("opens the clicked row's card, from the mouse and from the keyboard", async () => {
    searchCards.mockResolvedValue(page([BOLT, SPARSE]));
    wrap(<SearchPage />);

    await userEvent.click(await screen.findByText("Lightning Bolt"));
    expect(useAppStore.getState().selectedCardId).toBe("1");

    // Enter on the focused row, not a click on it: the row is a `div`, so nothing about it
    // answers a keyboard unless this handler does.
    const second = screen.getByText("Nameless Race").closest('[role="row"]') as HTMLElement;
    second.focus();
    await userEvent.keyboard("{Enter}");

    expect(useAppStore.getState().selectedCardId).toBe("2");
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

describe("the result layout toggle", () => {
  /** The store as the app boots, so the default under test is the shipped one. */
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("opens on the art grid and keeps the table one click away", async () => {
    wrap(<SearchPage />);

    // Art first: a card app's default view of a card is the card.
    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Table view" }));

    // The table is the view for comparing prices, which is the one thing art cannot show.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("$400.50")).toBeInTheDocument();
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Card view" }));

    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
  });

  it("opens the clicked tile's card", async () => {
    wrap(<SearchPage />);

    await userEvent.click(await screen.findByRole("button", { name: /Lightning Bolt/ }));

    expect(useAppStore.getState().selectedCardId).toBe("1");
  });

  it("says which layout is showing", async () => {
    wrap(<SearchPage />);

    expect(screen.getByRole("button", { name: "Card view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Table view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Table view" }));

    expect(screen.getByRole("button", { name: "Table view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * The summary line, the error banner and the empty state belong to the result *area*,
   * not to either layout — a reader who switches views to see whether that helps must not
   * lose the sentence explaining why there is nothing there.
   */
  it("keeps the count and the empty state the same in both layouts", async () => {
    searchCards.mockResolvedValue(page([], 0));
    wrap(<SearchPage />);

    expect(await screen.findByText(/card database is empty/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Table view" }));

    expect(screen.getByText(/card database is empty/i)).toBeInTheDocument();
  });
});

/**
 * The other half of the grid's prefetch. Its overscan mounts two rows of off-screen
 * `<img>`s, which warms the next *scroll*; this warms the next *page*, before a single
 * tile of it is mounted.
 */
describe("page image prefetch", () => {
  beforeEach(() => useAppStore.setState({ searchView: "grid", selectedCardId: null }));

  it("warms the front faces of the page that just landed, at grid size", async () => {
    wrap(<SearchPage />);

    await waitFor(() => expect(prefetchImages).toHaveBeenCalledWith(["1"], "grid"));
  });

  /**
   * The case `pageCount` alone cannot see. `keepPreviousData` holds the old pages on
   * screen while the new search is in flight, so a one-page search followed by another
   * one-page search never moves the count — and the page the reader actually asked for
   * would be the one that never got warmed.
   */
  it("warms a new search's first page even when the page count did not change", async () => {
    searchCards.mockResolvedValueOnce(page([BOLT])).mockResolvedValue(page([SPARSE]));
    wrap(<SearchPage />);
    await waitFor(() => expect(prefetchImages).toHaveBeenCalledWith(["1"], "grid"));

    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "race");

    await waitFor(() => expect(prefetchImages).toHaveBeenCalledWith(["2"], "grid"));
  });

  it("asks once per page, not once per render", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(prefetchImages).toHaveBeenCalledTimes(1));

    // Re-renders that add no page must cost nothing: the whole point of the key is that a
    // background refetch of pages already in hand does not re-walk 50 cached images.
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));
    await waitFor(() => expect(searchCards).toHaveBeenCalledTimes(2));

    // One more for the filtered page, and no repeat of the first.
    await waitFor(() => expect(prefetchImages).toHaveBeenCalledTimes(2));
  });

  it("does not warm anything for the table, which shows no art", async () => {
    useAppStore.setState({ searchView: "table" });
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");
    expect(prefetchImages).not.toHaveBeenCalled();
  });

  /**
   * `view` guards the effect but does not trigger it. Toggling to the table and back does
   * not add a page, so re-sending the newest one would be 50 keys the grid already warmed
   * when they landed — the same wasted round trip the page key exists to avoid.
   */
  it("does not re-warm a page when the reader toggles to the table and back", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(prefetchImages).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Table view" }));
    await userEvent.click(screen.getByRole("button", { name: "Card view" }));
    await act(async () => {});

    expect(prefetchImages).toHaveBeenCalledTimes(1);
  });

  it("survives a rejected prefetch — it is a warm-up, not a dependency", async () => {
    prefetchImages.mockRejectedValue("database is locked");
    wrap(<SearchPage />);

    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
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

  /**
   * A capped `total` is a floor, not an end. Reading it as one would stop a browse of the
   * 116 k-card database at its five-thousandth row — the reader could scroll no further,
   * with no indication that there was anything left.
   */
  it("keeps paging past a capped total, and stops only on a short page", () => {
    const full = page(Array(5000).fill(BOLT), 5000, true);
    expect(nextOffset([full])).toBe(5000);
    expect(nextOffset([full, page(Array(50).fill(BOLT), 5000, true)])).toBe(5050);
    expect(nextOffset([full, page([], 5000, true)])).toBeUndefined();
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
