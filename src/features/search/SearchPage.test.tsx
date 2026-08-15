import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import { readDragData } from "@/features/decks/dnd";
import type { CardSummary, SearchRequest, SearchResponse, SetSummary, WishInput } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { startDrag } from "@/test-drag";

const searchCards = vi.hoisted(() => vi.fn());
// The set picker mounts with the page and asks for the set list on the way up, so the
// mock has to answer it — a missing `listSets` is a rejected query, not a compile error.
const listSets = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
// Every row and every tile carries a quick-add, and what it writes is a real `invoke`.
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
/**
 * Which marketplace the Price column quotes. Answered on every render — `useMarketplace` is a
 * query like any other, and an unmocked command is a rejected query that falls back to the
 * default, which would make every currency assertion below pass for the wrong reason.
 */
const getMarketplace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    getMarketplace,
    // The filter row asks for facet counts beside every page. Answered **cold** — `ready:
    // false`, every map empty — which leaves every control live and every accessible name
    // plain, so this file's queries say what they always said. The greying itself is
    // `FilterBar.test.tsx`'s and `facets.test.ts`'s subject.
    facetCards: vi.fn().mockResolvedValue({
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    }),
    listSets,
    prefetchImages,
    collectionAdd,
    wishlistAdd,
    syncStatus: vi.fn(),
    syncRun: vi.fn(),
    onSyncProgress: vi.fn(),
  },
}));

import { SearchPage } from "./SearchPage";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
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
  price: 400.5,
  // Not a conversion of the dollar figure: nothing in this app converts, and a euro price that
  // happened to be `usd × rate` would make a currency mix-up read as arithmetic rather than as
  // the wrong field being drawn.
  layout: "normal",
  oracleId: "o-bolt",
  finishes: `["nonfoil","foil"]`,
  // A plain boolean on this DTO — the backend flattens the nullable column — so an ordinary
  // card is `false` rather than a third state to fence. The rows that wear the crown spread
  // `gameChanger: true` over this one.
  gameChanger: false,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
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
  price: null,
  layout: "normal",
  oracleId: null,
  finishes: null,
  // Not among the nullable columns, however sparse the rest of the row is: `search.rs` reads
  // `cards.game_changer` as an `Option` and flattens a NULL to `false` before it crosses.
  gameChanger: false,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: null,
  priceHigh: null,
};

const page = (
  items: CardSummary[],
  total = items.length,
  totalIsCapped = false,
): SearchResponse => ({ items, total, totalIsCapped });

/** `n` distinct rows starting at `from`, so a page-2 row is tellable from a page-1 one. */
const cards = (n: number, from = 0): CardSummary[] =>
  Array.from({ length: n }, (_, i) => ({ ...BOLT, id: `c${from + i}`, name: `Card ${from + i}` }));

/**
 * The page, under the two providers `App` mounts above it.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider
 * is above it (so that every surface offering a right-click stays renderable on its own), which
 * means a page
 * rendered bare would suppress nothing, open nothing, and pass every menu assertion below by
 * never being asked.
 *
 * **No `CardToDeckProvider`, and a test that expands "Add to → Deck" will need one** — the deck
 * picker throws without it, deliberately, rather than swallowing the add. It goes **above**
 * `ContextMenuProvider` and not inside it: the menu panel is drawn as a *sibling* of that
 * provider's children, so a provider around this page is around none of the menu's rows.
 * `CollectionPage.test.tsx` has the wiring, and `App.tsx` uses the same nesting.
 */
function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContextMenuProvider>{ui}</ContextMenuProvider>
    </QueryClientProvider>,
  );
}

/**
 * A right-click, and nothing awaited.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads
 * `clientX`/`clientY` to place the panel — and `bubbles`, because the surface's handler is on
 * the row or the tile, never on the cell the pointer happened to be over.
 */
function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/**
 * The set picker's disclosure button.
 *
 * Named by its expanded state because the *column header* is a button named "Set" too, now
 * that the table sorts by its headers — and only a disclosure has an expanded state.
 */
const setPicker = () => screen.getByRole("button", { name: "Set", expanded: false });

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
  collectionAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  // TCGplayer unless a test says otherwise — the default, and what every `$` below asserts.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
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

  it("collapses printings by default, and asks the backend for it", async () => {
    wrap(<SearchPage />);

    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(lastRequest().collapse).toBe(true);
    expect(screen.getByRole("button", { name: "All printings" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stops collapsing when all printings are asked for", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "All printings" }));

    await waitFor(() => expect(lastRequest().collapse).toBeUndefined());
    expect(screen.getByRole("button", { name: "All printings" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * A view mode, not a filter. Reset all clears what you are *looking at*; it must not also
   * change whether you are looking at cards or at cardboard — the same reasoning that keeps
   * the sort out of it.
   */
  it("does not count All printings as a filter, and Reset all leaves it alone", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "All printings" }));
    // Nothing to reset: a view mode is not a filter, so Reset all stays greyed. It is drawn
    // from the first render — a button that appeared here would slide the whole row — so the
    // claim is that it is dead, not that it is absent.
    expect(screen.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await userEvent.type(screen.getByPlaceholderText("Search cards…"), "bolt");
    const reset = await screen.findByRole("button", { name: "Reset all — 1 filter active" });
    await userEvent.click(reset);

    expect(screen.getByRole("button", { name: "All printings" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(lastRequest().collapse).toBeUndefined());
  });

  it("says how many printings a collapsed row stands for, and prices across them", async () => {
    searchCards.mockResolvedValue(
      page([
        {
          ...BOLT,
          name: "Sol Ring",
          printings: 132,
          price: 2.15,
          priceLow: 0.75,
          priceHigh: 4200,
        },
      ]),
    );
    wrap(<SearchPage />);

    await screen.findByText("Sol Ring");
    expect(screen.getByText("×132 printings")).toBeInTheDocument();
    expect(screen.getByText("$0.75–$4,200.00")).toBeInTheDocument();
  });

  it("says nothing about printings when a row stands for one", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);

    await screen.findByText(BOLT.name);
    // `/printings/` alone would match the All-printings toggle, which is always mounted.
    expect(screen.queryByText(/×\d+ printings/)).not.toBeInTheDocument();
    // Both ends are the row's own price, so the range renders as the single price it is.
    expect(screen.getByText("$400.50")).toBeInTheDocument();
  });

  /**
   * **The Price column is written in the selected marketplace's currency.**
   *
   * The span is the one the backend answered for that marketplace — a group's range covers the
   * printings *it* prices, so it is legitimately narrower at one than at another — and the cell
   * only has to write it. What this pins is the currency the writing uses: a column of euro
   * figures wearing dollar signs would be the same lie either way round.
   */
  it("prices in the selected marketplace's currency", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    searchCards.mockResolvedValue(page([{ ...BOLT, priceLow: 1.5, priceHigh: 900 }]));
    wrap(<SearchPage />);

    await screen.findByText(BOLT.name);
    await waitFor(() => expect(screen.getByText("€1.50–€900.00")).toBeInTheDocument());
    expect(screen.queryByText("$1.50–$900.00")).not.toBeInTheDocument();
  });

  /**
   * A row the selected marketplace does not quote — an etched-only printing on Cardmarket,
   * where there is no `eur_etched` key, or a printing a bulk feed has never listed. It is an em
   * dash, never another marketplace's figure wearing a euro sign.
   */
  it("shows an em dash for a row this marketplace does not price", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    searchCards.mockResolvedValue(
      page([{ ...BOLT, price: null, priceLow: null, priceHigh: null }]),
    );
    wrap(<SearchPage />);

    await screen.findByText(BOLT.name);
    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
  });

  /**
   * **The marketplace crosses the wire on every search, sorted by money or not.**
   *
   * It used to be a `currency` sent only while the Price header was deciding the order, because
   * every row carried both figures and the cell picked. Rust answers one price per row now, so
   * the marketplace decides the *numbers* — and a search that omitted it would be answered in
   * TCGplayer's dollars however the picker was set.
   */
  it("sends the marketplace on every search", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    wrap(<SearchPage />);

    await screen.findByText(BOLT.name);
    await waitFor(() => expect(lastRequest().marketplace).toBe("cardmarket"));

    await userEvent.click(screen.getByRole("button", { name: /^Price/ }));
    await waitFor(() => expect(lastRequest().sort).toEqual([{ key: "price", dir: "desc" }]));
    expect(lastRequest().marketplace).toBe("cardmarket");
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

    await userEvent.click(setPicker());
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
    await userEvent.click(setPicker());
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
    // Greyed where it stands rather than gone: the button holds its width so that pressing it
    // does not slide the row it sits in out from under the cursor that pressed it.
    expect(reset).toHaveAttribute("aria-disabled", "true");
    expect(reset).toHaveTextContent("0");
  });

  it("renders every nullable column without inventing a value", async () => {
    searchCards.mockResolvedValue(page([SPARSE]));
    wrap(<SearchPage />);

    expect(await screen.findByText("Nameless Race")).toBeInTheDocument();
    // Set code uppercased, collector number verbatim.
    expect(screen.getByText(/CHR/)).toBeInTheDocument();
    expect(screen.getByText(/99b/)).toBeInTheDocument();
    // A missing type and a missing price read as an em dash, never as "null" or "$0.00".
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    // A missing rarity gets a word rather than a dash, because `RarityGem`'s dash would be
    // the *accessible name* of the gem — and "Rarity: —" is announced as "Rarity:" and then
    // nothing at all. An em dash is a mark that reads as blank; "unknown" is what it means.
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  /**
   * The table and the art grid show the same five facts about the same printing, so they
   * are held to one presentation: data in the mono face, and a rarity as a gem dot beside
   * a tinted word rather than as a fifth column of grey prose. The direction spends its
   * colour budget on mana and card art, which is why a rarity gets 6px and a tint and
   * never a filled badge.
   */
  it("prints the data columns in the mono face and tints the rarity like a tile does", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");
    const cells = screen.getAllByRole("cell");
    const [, set, , rarity, price] = cells;

    expect(set).toHaveClass("font-mono");
    expect(price).toHaveClass("font-mono");
    // Aligned on the decimal too — a price column that is not is a column nobody can scan.
    expect(price).toHaveClass("tabular-nums");

    // The dot carries the colour and nothing else; the word beside it says which rarity it
    // is, so the dot stays out of the accessibility tree rather than repeating it.
    const dot = rarity.querySelector("[aria-hidden='true']");
    expect(dot).not.toBeNull();
    expect(dot).toHaveStyle({ backgroundColor: "var(--color-rarity-common)" });
    expect(screen.getByText("common")).toHaveStyle({ color: "var(--color-rarity-common)" });
  });

  /**
   * Spec §5: a price is never shown without saying how old it is. The pane says it in the
   * open; the table has a 36px header row, so it says it on the column it is about.
   */
  it("says how old the prices are, on the price column", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");
    const header = screen.getByRole("columnheader", { name: /^Price/ });

    // On the button, because the button fills the header cell — a `title` on the cell is a
    // tooltip nothing can reach. And beside the sort hint rather than instead of it: a
    // sortable price column has two things to say and may drop neither.
    expect(screen.getByRole("button", { name: /^Price/ })).toHaveAttribute(
      "title",
      `${pricesAsOf(MARKETPLACES.tcgplayer)}\nSort by Price — Shift-click to add to the sort`,
    );
    // And in the accessible name, because a tooltip is not an answer for anyone who is not
    // holding a mouse over the right four pixels. It still *starts* with "Price", so the
    // column is still addressable by the word on screen.
    expect(header).toHaveAccessibleName(`Price. ${pricesAsOf(MARKETPLACES.tcgplayer)}`);
    // And it names the marketplace, which is the half that stopped being a constant: with five
    // in the picker, "prices as of the last sync" leaves the reader guessing whose these are.
    expect(header).toHaveAccessibleName(/TCGplayer/);
  });

  it("sends nothing about sorting until a header is pressed", async () => {
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");
    expect(lastRequest().sort).toBeUndefined();
  });

  it("asks the backend for the column a pressed header names", async () => {
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");

    // Descending first: "highest first" is what pressing a money column means.
    await userEvent.click(screen.getByRole("button", { name: "Price" }));
    await waitFor(() => expect(lastRequest().sort).toEqual([{ key: "price", dir: "desc" }]));

    // Second press reverses it; the third takes the sort off altogether, which is how a
    // reader who sorted by accident gets back to the view's own order.
    await userEvent.click(screen.getByRole("button", { name: "Price" }));
    await waitFor(() => expect(lastRequest().sort).toEqual([{ key: "price", dir: "asc" }]));
    await userEvent.click(screen.getByRole("button", { name: "Price" }));
    await waitFor(() => expect(lastRequest().sort).toBeUndefined());
  });

  /**
   * The whole point of the feature, and the thing one sort key cannot express: dearest
   * *within* each rarity.
   */
  it("builds a two-key sort from a shifted press, keeping the first key first", async () => {
    // A bound instance, because a held modifier is *its* state: the bare `userEvent.click`
    // makes a fresh one per call, so the Shift pressed by one call is not down for the next
    // and the additive press silently becomes an ordinary one.
    const user = userEvent.setup();
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "Rarity" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Price/ }));
    await user.keyboard("{/Shift}");

    await waitFor(() =>
      expect(lastRequest().sort).toEqual([
        { key: "rarity", dir: "asc" },
        { key: "price", dir: "desc" },
      ]),
    );

    // And both columns say so, with their place in the order.
    expect(screen.getByRole("columnheader", { name: "Rarity" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByRole("button", { name: "Rarity, sort priority 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Price, sort priority 2" })).toBeInTheDocument();
  });

  /**
   * A sort is not a filter: it is not counted by the Reset all badge and is not cleared by
   * it. Clearing what you are looking at should not throw away the order you read it in.
   */
  it("keeps the sort through Reset all, and does not count it as a filter", async () => {
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "bolt");
    await waitFor(() => expect(lastRequest().text).toBe("bolt"));

    const reset = screen.getByRole("button", { name: /reset all/i });
    expect(reset).toHaveTextContent("1");
    await userEvent.click(reset);

    await waitFor(() => {
      expect(lastRequest().text).toBeUndefined();
      expect(lastRequest().sort).toEqual([{ key: "name", dir: "asc" }]);
    });
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

  /**
   * The table's own entry point. The row opens the card on any click it hears, so the cell
   * holding the quick-add has to stop the one that lands on it — otherwise recording a copy
   * also opens the card, and the popup ends up behind a pane that just took the focus.
   */
  it("adds a card from its row without opening the card", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: /^Add Lightning Bolt \(LEA 161\)/ }));

    expect(await screen.findByRole("dialog", { name: "Add Lightning Bolt" })).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();

    // The quantity box lives in a row that answers Space by opening the card and scrolling
    // the list a screenful. Typing in it must do neither.
    await userEvent.click(screen.getByRole("button", { name: /^Increase Quantity/ }));
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The row builds the popup from what it was sent, and `finishes` is on the search DTO for
   * exactly this: the backend takes any finish for any card, so a table that always offered
   * nonfoil is how a foil-only printing gets a nonfoil entry — one that then prices through
   * a `usd` key its blob does not have.
   */
  it("offers a row's real finishes, and can wish for any printing from it", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, finishes: `["foil"]` }]));
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: /^Add Lightning Bolt \(LEA 161\)/ }));

    const chips = within(await screen.findByRole("group", { name: "Finish" })).getAllByRole(
      "button",
    );
    expect(chips.map((c) => c.textContent)).toEqual(["Foil"]);

    // And the oracle id rides along too, so a wish made from a result row can be for the
    // card rather than for this piece of cardboard.
    await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));
    await userEvent.click(screen.getByRole("button", { name: "Any printing" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));

    const wish = wishlistAdd.mock.calls[0][0] as WishInput;
    expect(wish).toMatchObject({ oracleId: "o-bolt", preferredFinish: "foil" });
    expect(wish.cardId).toBeUndefined();
  });

  /** A row whose columns are all null is a row that knows no finishes — which is not the
   *  same as knowing it is nonfoil, but nonfoil is what an unqualified copy of a card is. */
  it("falls back to nonfoil for a row with no finishes recorded", async () => {
    searchCards.mockResolvedValue(page([SPARSE]));
    wrap(<SearchPage />);
    await screen.findByText("Nameless Race");

    await userEvent.click(screen.getByRole("button", { name: /^Add Nameless Race/ }));

    const chips = within(await screen.findByRole("group", { name: "Finish" })).getAllByRole(
      "button",
    );
    expect(chips.map((c) => c.textContent)).toEqual(["Nonfoil"]);
  });

  /**
   * Two stacking rules that no other test would miss, because both are invisible until a
   * popup is open over a scrolling list.
   *
   * A row is positioned *and* transformed, so it is a stacking context and the popup's own
   * `z-20` cannot lift it over the next row — the row it is open in has to come forward.
   * And the header it then competes with is sticky over the same list: at an equal
   * `z-index` the row wins for being later in the DOM, and scrolls *over* the header.
   */
  it("lifts the row holding an open popup, and keeps the sticky header above it", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);
    await screen.findByText("Lightning Bolt");

    const row = screen.getByText("Lightning Bolt").closest('[role="row"]');
    expect(row).toHaveClass("has-[[aria-expanded=true]]:z-10");
    expect(screen.getByRole("columnheader", { name: "Name" }).closest('[role="row"]')).toHaveClass(
      "sticky",
      "z-20",
    );
  });

  it("gives the actions column a header, for the readers who cannot see it is empty", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  /**
   * Spec §7: "'owned' badges appear in search once a wish is fulfilled." Both facts, on the
   * row the reader is looking at — a quantity in the data face, and the wishlist's own mark
   * from the sidebar — and both spelled out, because a badge that exists only as a shape is
   * not a badge for everyone.
   */
  it("badges a row the reader owns, and one they have wished for", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 3, wishlisted: true }]));
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");

    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.getByText("3 in your collection")).toBeInTheDocument();
    expect(screen.getByText("On your wishlist")).toBeInTheDocument();
  });

  /**
   * The Commander bracket's crown, in the Name cell — beside the owned badge and the finish
   * mark, because all three are facts about the *card* and the table's other five columns are
   * about the printing.
   *
   * Named rather than shaped: a screen reader saying "crown" beside a card would be describing
   * the icon, so the glyph carries the word as its accessible name. The table has no
   * `aria-hidden` overlay to work around — that trap is the wall's, where the chip sits inside
   * the tile's button.
   */
  it("crowns a game changer's row, and only that row", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, gameChanger: true }, SPARSE]));
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");
    const crowns = screen.getAllByRole("img", { name: GAME_CHANGER_LABEL });
    expect(crowns).toHaveLength(1);
    expect(screen.getByText("Lightning Bolt").closest('[role="row"]')).toContainElement(crowns[0]);
    expect(screen.getByText("Nameless Race").closest('[role="row"]')).not.toContainElement(
      crowns[0],
    );
  });

  /** Nothing owned and nothing wished is not a fact worth a badge — it is every other row
   *  in a 116 k-card database. */
  it("says nothing about a card the reader neither owns nor wants", async () => {
    searchCards.mockResolvedValue(page([BOLT]));
    wrap(<SearchPage />);

    await screen.findByText("Lightning Bolt");

    expect(screen.queryByText(/in your collection/)).not.toBeInTheDocument();
    expect(screen.queryByText("On your wishlist")).not.toBeInTheDocument();
  });

  /**
   * Three states in one chip, because the useful questions are opposites: what have I
   * already got, and what am I still missing. The label says which one is on — an unpressed
   * chip cannot mean "not owned" and be the same chip that means it when pressed.
   */
  it("filters by what the collection holds, in three states", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Owned" }));
    await waitFor(() => expect(lastRequest().owned).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Owned" }));
    await waitFor(() => expect(lastRequest().owned).toBe(false));
    expect(screen.getByRole("button", { name: "Missing" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Missing" }));
    // Absent, not `false`: an untouched filter row produces the same payload it always did.
    await waitFor(() => expect(lastRequest().owned).toBeUndefined());
    expect(screen.getByRole("button", { name: "Owned" })).toHaveAttribute("aria-pressed", "false");
  });

  it("counts the owned filter among what Reset all would clear", async () => {
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Owned" }));

    const reset = await screen.findByRole("button", { name: "Reset all — 1 filter active" });
    expect(reset).toHaveTextContent("1");

    await userEvent.click(reset);

    await waitFor(() => expect(lastRequest().owned).toBeUndefined());
    expect(reset).toHaveAttribute("aria-disabled", "true");
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

    // The tile's art is named for the card exactly; the quick-add beside it is named for
    // what it does to the card.
    await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(useAppStore.getState().selectedCardId).toBe("1");
  });

  /**
   * The wall is generic now — it draws anything with a name, a set and a number, and the
   * collection view draws its own rows through it — so the tile's quick-add is built *here*,
   * from the search row it is about. Which is the only place it can be honest: the backend
   * takes any finish for any card, and a tile that always offered nonfoil is how a foil-only
   * printing takes a nonfoil entry that then prices through a `usd` key its blob lacks.
   */
  it("builds a tile's quick-add from the row it is about", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, finishes: `["foil"]` }]));
    wrap(<SearchPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /^Add Lightning Bolt \(LEA 161\)/ }),
    );

    const chips = within(await screen.findByRole("group", { name: "Finish" })).getAllByRole(
      "button",
    );
    expect(chips.map((c) => c.textContent)).toEqual(["Foil"]);
  });

  /**
   * The same two facts, over the art. One truth stated the same way in both layouts — and
   * *outside* the tile's button, or a wall of forty cards would be forty buttons called
   * "Lightning Bolt 3 in your collection".
   */
  it("badges a tile with what the reader owns and wants, without renaming it", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 3, wishlisted: true }]));
    wrap(<SearchPage />);

    await screen.findByAltText("Lightning Bolt");

    expect(screen.getByText("3 in your collection")).toBeInTheDocument();
    expect(screen.getByText("On your wishlist")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toHaveAccessibleName(
      "Lightning Bolt",
    );
  });

  /**
   * The same crown as the table's, over the art instead of beside the name — and it shares the
   * finish chip rather than taking a fourth corner, because the tile's other two are spoken for
   * (bottom-left the owned badge, top-left the printing count).
   *
   * The chip is inside the tile's button and the whole overlay is `aria-hidden`, so the picture
   * is decoration and the caption is the statement. Both halves are asserted here: the mark is
   * drawn, the words are reachable, and the button is still called nothing but the card.
   */
  it("crowns a tile whose card the bracket counts, and says so in words", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, gameChanger: true }]));
    wrap(<SearchPage />);

    await screen.findByAltText("Lightning Bolt");

    expect(screen.getByRole("img", { name: GAME_CHANGER_LABEL, hidden: true })).toBeInTheDocument();
    expect(screen.getByText(`, ${GAME_CHANGER_LABEL}`)).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toHaveAccessibleName(
      "Lightning Bolt",
    );
  });

  /**
   * The tile's top-left corner **names what it counts, on the card** — `132 printings`, not
   * `×132` and not a bare `132`. Two earlier shapes each put the meaning somewhere the eye is
   * not: in a tooltip, and in a banner's silhouette. This asks for the whole string, which is
   * the only assertion that fails for either of them.
   *
   * The words are visible text rather than an `sr-only` twin, so the same query reaches a
   * screen reader's reading of the wall — `getByText` would pass on a hidden span, so the
   * corner's *box* is checked too: the app's table felt at 85 %, which is what makes words
   * legible on a photograph and is the same backing the owned badge opposite it carries.
   *
   * The `title` keeps the one word the corner has no room for — **matched** — because a
   * collapsed row groups the printings that got past the filters, not the card's whole print
   * run.
   */
  it("names what a tile's printings corner counts, in words on the card", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, printings: 132 }]));
    wrap(<SearchPage />);

    await screen.findByAltText("Lightning Bolt");

    const mark = screen.getByText("132 printings");
    expect(mark).toBeVisible();
    expect(mark).toHaveAttribute("title", "132 printings matched these filters");
    expect(mark.parentElement).toHaveClass("bg-bg/85", "absolute", "top-1", "left-1");
  });

  /**
   * A tile is a printing you can carry somewhere — spec §1's first source.
   *
   * The wall is generic, so the payload is built *here*, from the search row: what a tile
   * carries is the card it draws, and the wall's own tests pin that a caller who says nothing
   * gets no drag at all. This asks the drag itself rather than the `draggable="true"`
   * attribute, because a registration that closed over the wrong card would still set it.
   */
  it("carries the card a tile draws when the tile is dragged", async () => {
    const { container } = wrap(<SearchPage />);
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });

    const tiles = [...container.querySelectorAll('[draggable="true"]')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContainElement(art);

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const held = await startDrag(tiles[0]);
    await held.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      { kind: "card", cardId: "1", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
  });

  /**
   * The tile's one control keeps its press.
   *
   * Chromium starts a drag from the nearest draggable *ancestor* of whatever was pressed, so
   * a press on the quick-add that travels five pixels would drag the tile and never deliver
   * the click — the popup would simply not open. The mark is the control's own
   * (`AddToCollectionButton`), which is why this holds on the printings list too. The art
   * beside it is a button as well and is deliberately still the drag handle: the exclusion is
   * marked, never guessed from the tag.
   */
  it("does not drag a tile when the press landed on its quick-add", async () => {
    const { container } = wrap(<SearchPage />);
    const add = await screen.findByRole("button", { name: /^Add Lightning Bolt \(LEA 161\)/ });
    const tile = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(tile, { pressOn: add });
    expect(held.started).toBe(false);
    await held.cancel();

    const again = await startDrag(tile, {
      pressOn: screen.getByRole("button", { name: "Lightning Bolt" }),
    });
    expect(again.started).toBe(true);
    await again.cancel();
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
 * The card menu, over both of this view's layouts.
 *
 * The two are one surface as far as the menu is concerned — one adapter from a `CardSummary`,
 * one `CardMenuDeps` for the page — so what is asserted on the table is asserted through the
 * *writes* rather than through the panel's markup, which is `ContextMenu.test.tsx`'s subject.
 */
describe("the card menu", () => {
  it("opens on a right-click of a result row, without opening the card", async () => {
    wrap(<SearchPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    rightClick(row);

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // The pane belongs to a left click; a right-click asks a question about the row. `App`
    // owns the pane, so the store is the whole of what opening the card means from here —
    // asserting on a `complementary` this page never renders would be an assertion that
    // cannot fail.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  it("wishes for the printing that was right-clicked", async () => {
    const user = userEvent.setup();
    wrap(<SearchPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    // This exact printing, one copy, and no finish preference — the row named none.
    await waitFor(() =>
      expect(wishlistAdd).toHaveBeenCalledWith({
        cardId: "1",
        quantity: 1,
        preferredFinish: undefined,
      }),
    );
  });

  /**
   * The other half of the finish rule, and the counterpart to the collection's row: a search
   * row is a *printing* rather than a copy, so it names no finish and the menu has to ask.
   */
  it("asks which finish, because a search row is a printing and names none", async () => {
    const user = userEvent.setup();
    wrap(<SearchPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));

    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);
    await user.click(await screen.findByRole("menuitem", { name: "Foil" }));

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "1",
        finish: "foil",
        condition: "NM",
        quantity: 1,
      }),
    );
  });

  /**
   * The keyboard's route to the same menu, which is a feature rather than a nicety: the reader
   * was asked and chose a menu that opens by keyboard over a mouse-only one.
   *
   * Shift+F10 on the row itself. The other press the primitive answers is the dedicated
   * ContextMenu key, and which presses count is its rule rather than this surface's.
   */
  it("opens from the keyboard on a result row, without opening the card", async () => {
    wrap(<SearchPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * And the row's own keys still work, which is the half a single `onKeyDown` would have eaten:
   * the menu's handler is added to the row's, never in place of it.
   */
  it("still opens the card on Enter, which the menu's handler sits beside", async () => {
    wrap(<SearchPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "Enter" });

    expect(useAppStore.getState().selectedCardId).toBe("1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens from the keyboard on a tile of the art wall", async () => {
    useAppStore.setState({ searchView: "grid" });
    wrap(<SearchPage />);
    // The press lands on the art button and bubbles to the tile, which is what carries the
    // handler — the tile is the card, and the button inside it is what holds the caret.
    fireEvent.keyDown(await screen.findByRole("button", { name: "Lightning Bolt" }), {
      key: "F10",
      shiftKey: true,
    });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * **Where the caret goes when a tile's menu closes** — the half "a menu opened" cannot see.
   *
   * `menu()`/`menuKey()` hand the panel the element their handler is attached to, which here is
   * the tile's wrapper rather than the art button inside it, and the panel focuses that element
   * back when Escape closes and before every row it runs. **`focus()` on a node with no
   * `tabIndex` is a no-op**, so a wrapper without one leaves the caret on a panel that is
   * unmounting, drops it on `<body>`, and the next Tab restarts from the top of the app.
   *
   * The assertion is on the **opener** and not merely on "something inside the tile": the opener
   * is what `focus()` is called on, so a caret that landed on the art button would be a
   * different bug wearing this one's clothes. One wall here, three in the app — the collection's
   * and the deck editor's docked panel are the same component with the same two props.
   */
  it("gives the caret back to the tile when the menu closes", async () => {
    useAppStore.setState({ searchView: "grid" });
    const user = userEvent.setup();
    wrap(<SearchPage />);
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });
    // The tile is two boxes out from the art: the button sits in the `relative` box that holds
    // the corner marks, and the wrapper around that is what carries the menu handlers.
    const tile = art.parentElement?.parentElement as HTMLElement;

    art.focus();
    fireEvent.keyDown(art, { key: "F10", shiftKey: true });
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(tile);
  });

  it("opens on a tile of the art wall, about that tile's card", async () => {
    useAppStore.setState({ searchView: "grid" });
    const user = userEvent.setup();
    wrap(<SearchPage />);
    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    await waitFor(() =>
      expect(wishlistAdd).toHaveBeenCalledWith(expect.objectContaining({ cardId: "1" })),
    );
    expect(useAppStore.getState().selectedCardId).toBeNull();
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
