import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **The transport is mocked; `ipc` is not.** Replacing members of the `ipc` object with
 * `vi.fn()`s erases the typed mirror — a widget reading a field the command does not return
 * then fails at runtime instead of at `tsc`, which is exactly the class of bug the mirror
 * exists to catch. Mocking `@tauri-apps/api/core` one layer lower leaves every wrapper in
 * `lib/ipc.ts` real and typed, and still lets this file decide what a command answers.
 * `ipc.test.ts` is the precedent, verbatim.
 *
 * Its default is a promise that never settles, which is what makes the **loading** sentence a
 * state a test can hold rather than a frame it has to catch. A test that wants figures seeds
 * them into the cache through the keys in `../keys` instead, and then this mock is never reached at
 * all — the happy-path test asserts that.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionSummary, DeckRow, DeckValue, HomeWidget, WishlistSummary } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { collectionTotalKey, deckListKey, deckValuesKey, wishlistTotalKey } from "../keys";
import { SummaryWidget, SummaryWidgetSettings, sumDeckValues } from "./SummaryWidget";

/** One `deck_list` row, every field at the schema's default. `deckSort.test.ts`'s factory —
 *  this widget reads only how many there are, so nothing here is load-bearing except the type,
 *  which is what makes a renamed column a compile error in this file. */
let nextId = 1;
function deck(name: string, over: Partial<DeckRow> = {}): DeckRow {
  return {
    id: nextId++,
    name,
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    statsOpen: true,
    ...over,
  };
}

const COLLECTION: CollectionSummary = {
  totalCards: 1196,
  uniqueCards: 812,
  entries: 830,
  tradelistCards: 4,
  value: 2437.19,
  unpriced: 12,
  needsReview: 0,
};

const WISHLIST: WishlistSummary = { wishes: 18, copies: 42, cost: 310.5, unpriced: 3 };

/** One deck the marketplace could price and one it could not — the pair the sum's whole rule is
 *  about, so it is the default rather than a special case. */
const DECK_VALUES: DeckValue[] = [
  { deckId: 1, value: 120.25, unpriced: 2 },
  { deckId: 2, value: null, unpriced: 60 },
];

/** A stored entry at a footprint, with a config. The footprint here is only what the entry says;
 *  the box the body fits to is {@link fitOf}'s, which is what the page measures. */
const widgetOf = (config: unknown = null, w = 4, h = 2): HomeWidget => ({
  id: "summary",
  kind: "summary",
  x: 0,
  y: 0,
  w,
  h,
  config,
});

/** The fit of a `w × h` card on a grid of 104px cells — the grid's target cell, so a footprint
 *  here is the size a reader at an ordinary window width would see. */
function fitOf(w: number, h: number, over: Partial<{ widthPx: number; heightPx: number }> = {}) {
  return makeFit({
    w,
    h,
    widthPx: over.widthPx ?? spanPx(w, 104),
    heightPx: over.heightPx ?? spanPx(h, 104),
    density: "comfortable",
  });
}

interface Seed {
  marketplace?: MarketplaceId;
  collection?: CollectionSummary;
  decks?: DeckRow[];
  deckValues?: DeckValue[];
  wishlist?: WishlistSummary;
  config?: unknown;
  fit?: WidgetFit;
  still?: boolean;
}

/**
 * Render the body over a cache seeded through its own exported keys.
 *
 * `staleTime: Infinity` is what makes a seeded entry *fresh* rather than merely present: a
 * stale one would refetch on mount and the figures would depend on the transport mock after
 * all. `retry: false` is what makes a refusal one rejection rather than two.
 *
 * Everything a seed omits is left unanswered, which is the loading state — so a test writes
 * only the reads it is about. The default box is the kind's own default footprint, four by two,
 * which has room for all four figures.
 */
function renderWidget(seed: Seed = {}) {
  const marketplace = seed.marketplace ?? "tcgplayer";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  // The setting itself, so `useMarketplace` answers from the cache instead of the wire. The
  // feed list beside it is what Settings draws and this widget never reads; it is seeded only
  // so the hook has nothing left to fetch.
  client.setQueryData(MARKETPLACE_KEY, marketplace);
  client.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  if (seed.collection) client.setQueryData(collectionTotalKey(marketplace), seed.collection);
  if (seed.decks) client.setQueryData(deckListKey, seed.decks);
  if (seed.deckValues) client.setQueryData(deckValuesKey(marketplace), seed.deckValues);
  if (seed.wishlist) client.setQueryData(wishlistTotalKey(marketplace), seed.wishlist);

  const fit = seed.fit ?? fitOf(4, 2);
  render(
    <QueryClientProvider client={client}>
      <SummaryWidget
        widget={widgetOf(seed.config, fit.w, fit.h)}
        fit={fit}
        editing={false}
        still={seed.still ?? false}
        onConfig={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return client;
}

/** Everything answered, at the default marketplace. */
const FULL: Seed = {
  collection: COLLECTION,
  decks: [deck("Burn"), deck("Atraxa")],
  deckValues: DECK_VALUES,
  wishlist: WISHLIST,
};

/** The names of the figures a render drew, in order. */
const pressed = () =>
  screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  invoke.mockReset();
  // Pending for ever: an unseeded read is *not answered yet*, never a rejection.
  invoke.mockImplementation(() => new Promise(() => {}));
  nextId = 1;
});

describe("SummaryWidget", () => {
  /**
   * The four figures — and each count's press label still carries the money the figure line has
   * no room to print, because the accessible name is where the whole sentence lives: a figure's
   * two lines compute into one run with no separator between the label and the number.
   */
  it("draws the collection, the decks, the wishlist and the value, each press naming its money", () => {
    renderWidget(FULL);

    expect(pressed()).toEqual([
      "Collection: 1,196 cards, $2,437.19, 12 unpriced",
      // Two decks, and only the one the marketplace priced contributes to the figure.
      "Decks: 2 decks, $120.25, 62 unpriced",
      "Wishlist: 42 cards, $310.50, 3 unpriced",
      "Collection value: $2,437.19, 12 unpriced",
    ]);

    // A seeded cache is a fresh cache: nothing crossed the wire, so these figures are the ones
    // this test wrote rather than whatever a mock happened to answer.
    expect(invoke).not.toHaveBeenCalled();
  });

  /** Money is the accent and a count is body ink — a row of four golds would emphasise nothing. */
  it("draws the value in the accent and the counts in body ink", () => {
    renderWidget(FULL);

    expect(screen.getByText("$2,437.19").classList.contains("text-accent")).toBe(true);
    expect(screen.getByText("1,196").classList.contains("text-text")).toBe(true);
    expect(screen.getByText("1,196").classList.contains("text-accent")).toBe(false);
  });

  /**
   * The unpriced note is on screen and not only in the name — a figure that silently omits copies
   * is a number that lies by rounding down. `WidgetFigures` drops a qualification where three or
   * more figures leave it no room to be read, so the note is asserted on a card showing two.
   */
  it("prints the copies the marketplace could not price beside the value when there is room", () => {
    renderWidget({ ...FULL, config: { hide: ["decks", "wishlist"] } });

    expect(screen.getByText("12 unpriced")).toBeInTheDocument();
  });

  /** `$0.00` is a price nobody quoted. A marketplace that priced nothing in any deck gets an em
   *  dash — and the copies it could not price are still counted. */
  it("says an em dash when the marketplace priced nothing in any deck", () => {
    renderWidget({
      ...FULL,
      deckValues: [
        { deckId: 1, value: null, unpriced: 100 },
        { deckId: 2, value: null, unpriced: 60 },
      ],
    });

    expect(
      screen.getByRole("button", { name: "Decks: 2 decks, —, 160 unpriced" }),
    ).toBeInTheDocument();
  });

  /** Each figure is a shortcut to the view it is about — the value to the collection it prices. */
  it("opens the view a figure names", async () => {
    const user = userEvent.setup();
    renderWidget(FULL);

    await user.click(screen.getByRole("button", { name: /^Decks:/ }));
    expect(useAppStore.getState().activeView).toBe("decks");

    await user.click(screen.getByRole("button", { name: /^Collection:/ }));
    expect(useAppStore.getState().activeView).toBe("collection");

    await user.click(screen.getByRole("button", { name: /^Wishlist:/ }));
    expect(useAppStore.getState().activeView).toBe("wishlist");

    await user.click(screen.getByRole("button", { name: /^Collection value:/ }));
    expect(useAppStore.getState().activeView).toBe("collection");
  });

  /**
   * **A catalogue preview opens nothing.** The figures are drawn as text rather than presses, so
   * there is no button to reach and no view to leave the dialog for.
   */
  it("draws a still body's figures as text that opens nothing", () => {
    renderWidget({ ...FULL, still: true });

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByText("1,196")).toBeInTheDocument();
  });

  /**
   * The marketplace the reader picked decides both halves: which cache entry holds the answer —
   * every priced key carries the id — and which currency writes it. The figures below were
   * seeded under Cardmarket's keys and under no other, so a widget reading the default would
   * draw the loading sentence instead.
   */
  it("quotes the marketplace the reader picked, in its own currency", () => {
    renderWidget({ ...FULL, marketplace: "cardmarket" });

    expect(
      screen.getByRole("button", { name: /^Collection: 1,196 cards, €2,437\.19/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Wishlist: 42 cards, €310\.50/ }),
    ).toBeInTheDocument();
  });

  /** Not yet read. Never a zero — a grimoire that briefly claims to hold nothing is a worse
   *  sentence than one that has not said. */
  it("says the totals are still being read", () => {
    renderWidget();

    expect(screen.getByText("Adding up your collection, decks and wishlist…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Collection:/ })).toBeNull();
  });

  /** Read, and there is nothing in it — all three of them. A different sentence from the one
   *  above and from the one below, because it sends the reader somewhere different. */
  it("says there is nothing to add up yet", () => {
    renderWidget({
      collection: { ...COLLECTION, totalCards: 0, value: 0, unpriced: 0 },
      decks: [],
      deckValues: [],
      wishlist: { wishes: 0, copies: 0, cost: 0, unpriced: 0 },
    });

    expect(
      screen.getByText(/Nothing to add up yet\. Cards you collect, decks you build/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Collection:/ })).toBeNull();
  });

  /** One empty list among three is not an empty grimoire: a reader with cards and no decks is
   *  owed the cards, and a plain zero beside them. */
  it("still draws the figures when only one of the three is empty", () => {
    renderWidget({ ...FULL, decks: [], deckValues: [] });

    expect(screen.getByRole("button", { name: /^Collection: 1,196 cards/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decks: 0 decks, —" })).toBeInTheDocument();
  });

  /** Refused, in the backend's own words — `ipcError` is what turns a rejected `invoke` into a
   *  sentence a reader can act on. */
  it("says the read was refused, and says what the refusal was", async () => {
    invoke.mockRejectedValue("database is locked");

    renderWidget();

    expect(
      await screen.findByText(/Your totals could not be read\. database is locked/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Collection:/ })).toBeNull();
  });
});

/**
 * What fits. Figures wrap, so the count is how many share a line times how many lines the body
 * has, capped by what the card's width in cells wants — and it is applied **after** the reader's
 * own picks, so a hidden figure never takes a place a shown one could have had.
 */
describe("fitting the figures to the box", () => {
  it("draws an honest pair on a two-cell tile", () => {
    renderWidget({ ...FULL, fit: fitOf(2, 2) });

    expect(pressed()).toEqual([
      "Collection: 1,196 cards, $2,437.19, 12 unpriced",
      "Decks: 2 decks, $120.25, 62 unpriced",
    ]);
  });

  it("draws a pair on a three-cell panel one row tall", () => {
    renderWidget({ ...FULL, fit: fitOf(3, 1) });
    expect(pressed()).toHaveLength(2);
  });

  it("draws all four on a three-cell panel two rows tall", () => {
    renderWidget({ ...FULL, fit: fitOf(3, 2) });
    expect(pressed()).toHaveLength(4);
  });

  /** **Pixels, never cells, decide the room**: four cells of a narrow pane is ~220px, where two
   *  figures fit on the one line a single-row card has. */
  it("draws only what the pixels hold when a wide footprint is drawn narrow", () => {
    renderWidget({ ...FULL, fit: fitOf(4, 1, { widthPx: 220 }) });
    expect(pressed()).toHaveLength(2);
  });

  it("skips the figures the reader hid and fits what is left", () => {
    renderWidget({ ...FULL, config: { hide: ["collection"] }, fit: fitOf(2, 2) });

    expect(pressed()).toEqual([
      "Decks: 2 decks, $120.25, 62 unpriced",
      "Wishlist: 42 cards, $310.50, 3 unpriced",
    ]);
  });

  /** A hand-edited `hide` holding things that are not words: the words still hide their figures,
   *  and the rest is ignored rather than thrown on. */
  it("reads the words in a hide list and ignores what is not one", () => {
    renderWidget({ ...FULL, config: { hide: [1, null, "decks"] } });

    expect(pressed()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /^Decks:/ })).toBeNull();
  });

  /** A card with every figure off is not an empty body — that reads as a card that failed. */
  it("says every figure is hidden rather than drawing nothing", () => {
    renderWidget({ ...FULL, config: { hide: ["collection", "decks", "wishlist", "value"] } });

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByText(/Every figure is hidden\./)).toBeInTheDocument();
  });
});

/** The `Figures` checklist at the foot of the settings popover. */
describe("SummaryWidgetSettings", () => {
  function renderSettings(config: unknown) {
    const onConfig = vi.fn();
    render(<SummaryWidgetSettings widget={widgetOf(config)} onConfig={onConfig} />);
    return onConfig;
  }

  it("ticks every figure the reader has not hidden", () => {
    renderSettings({ hide: ["wishlist"] });

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toHaveAccessibleName("Collection");
    expect(screen.getByRole("checkbox", { name: "Collection" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Wishlist" })).not.toBeChecked();
  });

  it("hides a figure by adding it to the list", async () => {
    const user = userEvent.setup();
    const onConfig = renderSettings(null);

    await user.click(screen.getByRole("checkbox", { name: "Decks" }));
    expect(onConfig).toHaveBeenCalledWith({ hide: ["decks"] });
  });

  /** A key a newer build hid survives this build's press — the list is written whole, and a key
   *  this build does not know is part of it. */
  it("shows a figure again and keeps a hidden key it does not recognise", async () => {
    const user = userEvent.setup();
    const onConfig = renderSettings({ hide: ["decks", "streak"] });

    await user.click(screen.getByRole("checkbox", { name: "Decks" }));
    expect(onConfig).toHaveBeenCalledWith({ hide: ["streak"] });
  });

  /** Nothing hidden is stored as absent, so a card put back the way it was is the unconfigured
   *  card rather than one carrying an empty list. */
  it("removes the key when nothing is left hidden", async () => {
    const user = userEvent.setup();
    const onConfig = renderSettings({ hide: ["value"] });

    await user.click(screen.getByRole("checkbox", { name: "Value" }));
    expect(onConfig).toHaveBeenCalledWith({ hide: undefined });
  });
});

/**
 * The one piece of arithmetic on this card, tested without a render in the way.
 *
 * `DeckValue.value` is `number | null` and the two zeroes are different statements: `null` is
 * *this marketplace priced nothing in that deck*, `0` is *that deck is genuinely worth nothing*.
 */
describe("sumDeckValues", () => {
  it("skips a deck the marketplace priced nothing in, and still counts its unpriced copies", () => {
    expect(sumDeckValues(DECK_VALUES)).toEqual({ value: 120.25, unpriced: 62 });
  });

  it("answers null rather than zero when no deck contributed a price", () => {
    expect(
      sumDeckValues([
        { deckId: 1, value: null, unpriced: 4 },
        { deckId: 2, value: null, unpriced: 6 },
      ]),
    ).toEqual({ value: null, unpriced: 10 });
    expect(sumDeckValues([])).toEqual({ value: null, unpriced: 0 });
  });

  it("keeps a deck that really is worth nothing as the zero it is", () => {
    expect(
      sumDeckValues([
        { deckId: 1, value: 0, unpriced: 0 },
        { deckId: 2, value: null, unpriced: 3 },
      ]),
    ).toEqual({ value: 0, unpriced: 3 });
  });
});
