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
import { collectionTotalKey, deckListKey, deckValuesKey, wishlistTotalKey } from "../keys";
import { SummaryWidget, sumDeckValues } from "./SummaryWidget";

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

const WIDGET: HomeWidget = { id: "summary", kind: "summary", span: 2, config: null };

interface Seed {
  marketplace?: MarketplaceId;
  collection?: CollectionSummary;
  decks?: DeckRow[];
  deckValues?: DeckValue[];
  wishlist?: WishlistSummary;
}

/**
 * Render the widget over a cache seeded through its own exported keys.
 *
 * `staleTime: Infinity` is what makes a seeded entry *fresh* rather than merely present: a
 * stale one would refetch on mount and the figures would depend on the transport mock after
 * all. `retry: false` is what makes a refusal one rejection rather than two.
 *
 * Everything a seed omits is left unanswered, which is the loading state — so a test writes
 * only the reads it is about.
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

  render(
    <QueryClientProvider client={client}>
      <SummaryWidget
        widget={WIDGET}
        editing={false}
        onConfig={vi.fn()}
        onRemove={vi.fn()}
        onSpan={vi.fn()}
        dragHandleRef={vi.fn()}
        onNudge={vi.fn()}
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

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  invoke.mockReset();
  // Pending for ever: an unseeded read is *not answered yet*, never a rejection.
  invoke.mockImplementation(() => new Promise(() => {}));
  nextId = 1;
});

describe("SummaryWidget", () => {
  /**
   * The three figures, each with the copies it counts and the money it is worth — and the
   * accessible name is where the whole sentence lives, because a flex column's text nodes
   * compute into one run with no separator between the label and the number.
   */
  it("draws the collection, the decks and the wishlist, each with its copies and its value", () => {
    renderWidget(FULL);

    expect(
      screen.getByRole("button", { name: "Collection: 1,196 cards, $2,437.19, 12 unpriced" }),
    ).toBeInTheDocument();
    // Two decks, and only the one the marketplace priced contributes to the figure.
    expect(
      screen.getByRole("button", { name: "Decks: 2 decks, $120.25, 62 unpriced" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Wishlist: 42 cards, $310.50, 3 unpriced" }),
    ).toBeInTheDocument();

    // A seeded cache is a fresh cache: nothing crossed the wire, so these figures are the ones
    // this test wrote rather than whatever a mock happened to answer.
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * The unpriced note is on screen and not only in the name — a figure that silently omits
   * sixty copies is a number that lies by rounding down, and the note has to be readable by the
   * eye as well as by a screen reader.
   */
  it("prints the copies the marketplace could not price beside the figure they are missing from", () => {
    renderWidget(FULL);

    expect(screen.getByText("12 unpriced")).toBeInTheDocument();
    expect(screen.getByText("62 unpriced")).toBeInTheDocument();
    expect(screen.getByText("3 unpriced")).toBeInTheDocument();
  });

  /** `$0.00` is a price nobody quoted. A marketplace that priced nothing in any deck gets an em
   *  dash — and the copies it could not price are still counted. */
  it("draws an em dash when the marketplace priced nothing in any deck", () => {
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

  /** Each figure is a shortcut to the view it is about. */
  it("opens the view a figure names", async () => {
    const user = userEvent.setup();
    renderWidget(FULL);

    await user.click(screen.getByRole("button", { name: /^Collection:/ }));
    expect(useAppStore.getState().activeView).toBe("collection");

    await user.click(screen.getByRole("button", { name: /^Decks:/ }));
    expect(useAppStore.getState().activeView).toBe("decks");

    await user.click(screen.getByRole("button", { name: /^Wishlist:/ }));
    expect(useAppStore.getState().activeView).toBe("wishlist");
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
