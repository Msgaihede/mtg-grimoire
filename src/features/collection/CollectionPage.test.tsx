import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import { readDragData } from "@/features/decks/dnd";
import type { CollectionQuery, CollectionRow, CollectionSummary, DeckRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { startDrag } from "@/test-drag";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
const collectionSetQuantity = vi.hoisted(() => vi.fn());
const collectionRemove = vi.hoisted(() => vi.fn());
// The set picker rides the filter row and asks for the set list on the way up.
const listSets = vi.hoisted(() => vi.fn());
// The wall pre-warms its own art in the background on the first load that has rows.
const prewarmCollection = vi.hoisted(() => vi.fn());
/** Which marketplace the Value column and the header figure quote. An unmocked command is a
 *  rejected query that silently resolves to the default, so it is answered explicitly. */
const getMarketplace = vi.hoisted(() => vi.fn());
// What the row's own context menu writes. Both are real `invoke`s, so an unmocked one is a
// rejection about a missing Tauri runtime rather than a call anything here could read.
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
/**
 * The deck end of the menu's "Add to → Deck", which the type-line case below drives all the way
 * through. `deckList`/`deckFolderList` are answered as well as seeded, so a picker that stopped
 * reading the cache says "Loading decks…" rather than hanging on an undefined command.
 */
const deckList = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionSummary,
    collectionSetQuantity,
    collectionRemove,
    collectionAdd,
    wishlistAdd,
    listSets,
    prewarmCollection,
    getMarketplace,
    deckList,
    deckFolderList,
    deckGet,
    deckAddCard,
    oracleTagsForPrintings,
  },
}));

import { CollectionPage } from "./CollectionPage";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { CardToDeckProvider } from "@/features/card/cardMenu";
import { useAppStore } from "@/lib/store";

const BOLT: CollectionRow = {
  id: 7,
  cardId: "c1",
  name: "Lightning Bolt",
  oracleId: "o1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  layout: "normal",
  finish: "foil",
  condition: "NM",
  quantity: 2,
  tradelistQuantity: 0,
  unitPrice: 400.5,
  purchasePrice: null,
  purchaseCurrency: null,
  acquiredAt: null,
  acquisitionSource: null,
  serialNumber: null,
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  tags: "[]",
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/** One deck for the menu's "Add to → Deck" to reach. No theory list, so it is one row. */
const BURN: DeckRow = {
  id: 7,
  name: "Burn",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  isBuilt: false,
  archived: false,
  cardCount: 0,
  updatedAt: 0,
  folderId: null,
  notes: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
};

const summary = (over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  totalCards: 0,
  uniqueCards: 0,
  entries: 0,
  tradelistCards: 0,
  value: 0,
  unpriced: 0,
  needsReview: 0,
  ...over,
});

const page = (items: CollectionRow[], total = items.length) => ({ items, total });

/**
 * What the reconciler actually writes into `needs_review` — `reconcile::flag_deleted`'s
 * sentence, date and all, at its real length of 175 characters.
 *
 * Length is the point: the band is one line of a 44px row and holds ~110 of them, and the
 * half that goes over the edge is the half that says what to *do*. A fixture reading "This
 * printing left the card database." would pass a rendering that throws the instruction away.
 */
const REVIEW_NOTE =
  "Scryfall removed this printing from its database on 2026-04-12. Your copies are still " +
  "recorded — check the printing and re-add it if you can identify it, or remove this entry.";

const lastQuery = () =>
  collectionList.mock.calls[collectionList.mock.calls.length - 1][0] as CollectionQuery;

/**
 * The filter bar's sort control.
 *
 * By role and exact name, because every sortable column header carries a `title` reading
 * "Sort by …" — and `getByLabelText` falls back to `title`, so a loose `/sort/i` matches
 * the whole header row as well.
 */
const sortSelect = () => screen.getByRole("combobox", { name: "Sort" });

/**
 * The page, under the two providers `App` mounts above it.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider
 * is above it (so that thirteen surfaces stay renderable on their own), which means a page
 * rendered bare would open nothing and pass every menu assertion below by never being asked.
 */
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ContextMenuProvider>{ui}</ContextMenuProvider>
      </QueryClientProvider>,
    ),
  };
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
 * jsdom lays nothing out, so the virtualiser measures a scroller of zero height and renders
 * no rows at all. `@tanstack/react-virtual` sizes it with `offsetHeight` and scrolls it with
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  // One deck, no folders — the shape the menu's deck picker draws as a single row. Answered
  // rather than seeded into the cache: `useDecks` has no `staleTime`, so a seeded entry is
  // refetched on mount and the command is what the picker ends up drawing either way.
  deckList.mockReset().mockResolvedValue([BURN]);
  deckFolderList.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue({ deck: BURN, cards: [], categories: [], tags: [] });
  deckAddCard.mockReset().mockResolvedValue(undefined);
  // No taxonomy downloaded is the floor rather than an error: `autoCategoryFor` then files by
  // type line, which is exactly what the case below is about.
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  collectionList.mockReset().mockResolvedValue(page([BOLT]));
  collectionSummary.mockReset().mockResolvedValue(summary({ totalCards: 2, uniqueCards: 1 }));
  collectionSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 3, removed: false });
  collectionRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
  listSets.mockReset().mockResolvedValue([]);
  prewarmCollection.mockReset().mockResolvedValue(0);
  // TCGplayer unless a test says otherwise — the default, and what every `$` below asserts.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  useAppStore.setState({ collectionView: "table", selectedCardId: null });
});

describe("CollectionPage", () => {
  /**
   * An empty collection is not a failed search. "No cards match" would blame the reader for
   * a table nobody has put anything in yet, and say nothing about how to.
   */
  it("explains an empty collection instead of blaming the reader for it", async () => {
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);

    expect(
      await screen.findByText(/nothing here yet\. add cards from search, or import a collection/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/match these filters/i)).not.toBeInTheDocument();
  });

  /** With a filter on, an empty answer *is* about the filter — and says so instead. */
  it("blames the filters when a filtered collection comes back empty", async () => {
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);
    await screen.findByText(/nothing here yet/i);

    await userEvent.click(screen.getByRole("button", { name: "Foil" }));

    expect(
      await screen.findByText(/no cards in your collection match these filters/i),
    ).toBeVisible();
  });

  /**
   * Spec §5's pre-warm, from the one screen that knows the collection has anything in it:
   * the art for every owned and wished card is fetched in the background so the wall browses
   * without a network. Once per session — the backend skips what is already on disk, but a
   * call per re-render would still be a round trip per re-render.
   */
  it("warms the images for what the user owns, once, on the first load that has rows", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await waitFor(() => expect(prewarmCollection).toHaveBeenCalledTimes(1));

    // A filter click re-renders and re-fetches; the warm must not go again with it.
    await userEvent.click(screen.getByRole("button", { name: "Foil" }));
    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(1));
    expect(prewarmCollection).toHaveBeenCalledTimes(1);
  });

  /** Nothing owned is nothing to warm, and a first launch should not spend a round trip
   *  finding that out. */
  it("does not warm anything for an empty collection", async () => {
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);
    await screen.findByText(/nothing here yet/i);

    expect(prewarmCollection).not.toHaveBeenCalled();
  });

  /** A pre-warm is best-effort background work: a refusal must never reach the user as an
   *  unhandled rejection, and must not disturb the list it ran behind. */
  it("swallows a failed pre-warm", async () => {
    prewarmCollection.mockRejectedValue("no such command");
    wrap(<CollectionPage />);

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * **One Value figure, not the pair this header used to draw.**
   *
   * Two totals for one collection was two answers to the question this row exists to answer,
   * and it was only there because there was no way for a reader to *say* which one they
   * wanted. The setting is that way, so the header quotes the marketplace they picked and the
   * other currency is not on screen at all.
   */
  it("adds the collection up in the selected currency, and says whose prices they are", async () => {
    collectionSummary.mockResolvedValue(
      summary({ totalCards: 1240, uniqueCards: 812, value: 9876.5 }),
    );
    wrap(<CollectionPage />);

    expect(await screen.findByText("1,240")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("$9,876.50")).toBeInTheDocument();
    expect(screen.queryByText("Value (EUR)")).not.toBeInTheDocument();

    // Spec §5: no price on screen without saying how old it is — and, with five marketplaces
    // in the picker, whose it is. The header has no room for the sentence beside the figures,
    // so it rides on the figure it is about.
    expect(screen.getByText("Value (USD)").closest("div")).toHaveAttribute(
      "title",
      pricesAsOf(MARKETPLACES.tcgplayer),
    );
  });

  /**
   * The other side of the same switch: Cardmarket's figure, Cardmarket's label, Cardmarket's
   * sentence — and no dollars anywhere.
   *
   * **The euro figure is a different answer to the same query, not a second field.** The
   * marketplace is in `collection_summary`'s payload and in the query's key, so switching
   * re-runs the aggregate; the mock therefore answers a different number rather than the same
   * object with a second key on it.
   */
  it("adds it up in euros when the marketplace is Cardmarket", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionSummary.mockResolvedValue(
      summary({ totalCards: 1240, uniqueCards: 812, value: 8100 }),
    );
    wrap(<CollectionPage />);

    await waitFor(() => expect(screen.getByText("€8,100.00")).toBeInTheDocument());
    expect(screen.getByText("Value (EUR)").closest("div")).toHaveAttribute(
      "title",
      pricesAsOf(MARKETPLACES.cardmarket),
    );
  });

  /**
   * A total that silently omits the cards it has no price for is a number that lies by
   * rounding down — **and the count belongs to the figure beside it.**
   *
   * No two marketplaces have the same holes: `eur_etched` does not exist in Scryfall's data, so
   * an etched printing is priced on TCGplayer and unpriced on Cardmarket at once, and a card a
   * bulk feed has never listed is unpriced on that feed alone. Rust counts at the marketplace
   * it summed at, so the note is never about another one's gaps.
   */
  it("shows how many copies the value could not price", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 1240, value: 100, unpriced: 2 }));
    wrap(<CollectionPage />);

    expect(await screen.findByText("2 unpriced")).toBeInTheDocument();
  });

  it("shows the other marketplace's own unpriced count when it is chosen", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionSummary.mockResolvedValue(summary({ totalCards: 1240, value: 100, unpriced: 7 }));
    wrap(<CollectionPage />);

    await waitFor(() => expect(screen.getByText("7 unpriced")).toBeInTheDocument());
    expect(screen.queryByText("2 unpriced")).not.toBeInTheDocument();
  });

  it("leaves the unpriced note off when everything has a price", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 3, value: 10 }));
    wrap(<CollectionPage />);

    await screen.findByText("$10.00");
    expect(screen.queryByText(/unpriced/i)).not.toBeInTheDocument();
  });

  /**
   * A collection table is where quantities are *maintained*: making the reader open an
   * editor to change a 3 to a 4 is the difference between a tool and a form.
   */
  it("writes a quantity straight through from the row", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    const step = screen.getByRole("button", {
      name: "Increase Quantity of Lightning Bolt (Foil, NM)",
    });
    await userEvent.click(step);

    expect(collectionSetQuantity).toHaveBeenCalledWith(7, 3);
    // The row's own number follows the press rather than the round trip.
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ })).toHaveValue(3),
    );
    // Three copies at $400.50 — the value column is arithmetic over the number that moved.
    expect(screen.getByText("$1,201.50")).toBeInTheDocument();
  });

  /**
   * A row is the printing it lists, and can be carried off it — spec §1's second source.
   *
   * What it carries is the *card*, not the entry: a deck names a printing, and the finish and
   * condition that make this row an entry are the collection's own business (which is also
   * why the collection is never a drop *target*). This asks the drag rather than the
   * `draggable="true"` attribute, because a registration that closed over the wrong row would
   * still set it.
   */
  it("carries the row's printing when the row is dragged", async () => {
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    const rows = [...container.querySelectorAll('[draggable="true"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Lightning Bolt");

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const held = await startDrag(rows[0], { pressOn: screen.getByText("Lightning Bolt") });
    await held.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
  });

  /**
   * **A press on the stepper is a press on the stepper.**
   *
   * The whole row is the drag handle and the row is full of controls, so this is the failure
   * that costs a reader their counts: Chromium starts a drag from the nearest draggable
   * *ancestor* of whatever was pressed, and the drag library excludes nothing of its own — so
   * without the mark, a press on `−` that travels five pixels drags the row and the press is
   * never delivered as a click. `cardDraggable` reads where the *press* landed, which is why
   * this presses one place and drags from another, exactly as the platform does.
   */
  it("does not drag a row when the press landed on its stepper", async () => {
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const row = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(row, {
      pressOn: screen.getByRole("button", {
        name: "Decrease Quantity of Lightning Bolt (Foil, NM)",
      }),
    });
    expect(held.started).toBe(false);
    await held.cancel();

    // And the row itself still is one: the guard is a control's press, not a row's.
    const again = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * Everything else that counts these copies. The header is re-read because a wrong total is
   * a worse lie than a slow one, and the *wishlist* is re-read because a wish's
   * `ownedQuantity` is computed from `collection_entries` — a stepper press has just made
   * every cached wish for this card wrong. The same pair the quick-add invalidates.
   */
  it("re-reads the header and the wishlist after a write, and marks the search stale", async () => {
    const { client } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Foil, NM)" }),
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection", "summary"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    // And refetched, not merely marked: Task 12's badges put `ownedQuantity` on every result
    // row, so a search left on screen behind this write is now visibly wrong rather than
    // stale in a field nothing draws.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    // And every deck: a deck's claims are `min(claim, entry.quantity)` at read time, so a
    // copy stepped away from under a built deck has just changed what that deck reads as
    // owning — and the shortfall its "missing to wishlist" button would push.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    // And the header really is re-read — not just marked.
    await waitFor(() => expect(collectionSummary).toHaveBeenCalledTimes(2));
    // The list is not: the row's own number came back from the write, and re-reading a
    // hundred rows because one changed by one is a round trip nobody is waiting for.
    expect(collectionList).toHaveBeenCalledTimes(1);
  });

  /**
   * Task 5's ruling: `set_quantity(0)` keeps the row, with its condition, its purchase price
   * and its acquisition story. So the list keeps it too — dimmed, because a row with no
   * copies is a record rather than a holding — and offers the explicit removal that is the
   * only thing that actually deletes one.
   */
  it("keeps a row that has been emptied to zero, and offers to remove it", async () => {
    collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: false });
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 1 }]));
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    // And the reader is told so before they get there: removal is offered on a row at zero
    // and nowhere else, so a mis-added four-copy row would otherwise only be got rid of by
    // accidental discovery.
    expect(screen.getByText(/to remove an entry, set its copies to zero/i)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Decrease Quantity of Lightning Bolt (Foil, NM)" }),
    );

    expect(collectionSetQuantity).toHaveBeenCalledWith(7, 0);
    const row = (await screen.findByText("Lightning Bolt")).closest('[role="row"]');
    expect(row).toBeInTheDocument();
    expect(row).toHaveClass("text-dim");

    const remove = screen.getByRole("button", {
      name: /^Remove Lightning Bolt \(Foil, NM\) from your collection/,
    });
    await userEvent.click(remove);

    expect(collectionRemove).toHaveBeenCalledWith(7);
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
  });

  /**
   * The other write, whose failure path was missing entirely: a removal the backend refuses
   * is the same story as a stepper press it refuses — a row something else already changed —
   * and it has to reach the same three lists. Without it the row stayed on screen with no
   * word about why, and the header went on counting it.
   */
  it("re-reads every list that counts these copies when a removal is refused", async () => {
    collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: false });
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 0 }]));
    collectionRemove.mockRejectedValue("That collection entry is not there any more.");
    const { client } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(Foil, NM\) from your collection/,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/not there any more/i);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    // And the row is still there — the removal did not happen, so the list must not pretend
    // it did.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /** A row something else already deleted answers GONE, and the reader has to hear it — a
   *  stepper that silently does nothing is a stepper the reader presses again. */
  it("says so when the row a stepper writes to is not there any more", async () => {
    collectionSetQuantity.mockRejectedValue("That collection entry is not there any more.");
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Foil, NM)" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not there any more/i);
    // And the number goes back to what the collection actually holds.
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ })).toHaveValue(2),
    );
    // The whole view, not just the list: a collection that has lost a row has also lost the
    // copies, the value and the unique count that row was part of. Seen live — the header
    // went on counting a deleted entry until the refusal reached past the table.
    await waitFor(() => expect(collectionSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(collectionList).toHaveBeenCalledTimes(2));
  });

  it("offers the flagged rows when a sync left any behind", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 2, needsReview: 3 }));
    wrap(<CollectionPage />);

    // The region is mounted with the view and the banner is swapped into it — a live region
    // that arrives together with its own text announces nothing, because nothing changed for
    // a screen reader to notice.
    const banner = screen.getByRole("status", { name: /needs review/i });
    await waitFor(() => expect(banner).toHaveTextContent("3"));

    await userEvent.click(within(banner).getByRole("button", { name: /show them/i }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    // The list is those rows now, so the banner has nothing left to offer — and the region
    // it lived in stays, empty.
    await waitFor(() => expect(banner).toBeEmptyDOMElement());
    expect(banner).toBeInTheDocument();
  });

  it("says nothing about review when nothing is flagged", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("status", { name: /needs review/i })).toBeEmptyDOMElement();
  });

  /**
   * The third state the chip gained, and the one place the banner's guard has to be exact.
   *
   * It is hidden for `true` and only for `true` — `!== true`, not a falsy test. The reason it
   * hides is that the list *is* the answer, and that is true of exactly one of the three
   * states: under `false` the reader is looking at the healthy rows, which is the opposite of
   * the answer, so three entries still needing attention is news and Show them is one click
   * from them. A guard of `=== undefined` would have swallowed the offer precisely where it
   * is most worth making.
   */
  it("hides the banner only while the reader is looking at the flagged rows", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 2, needsReview: 3 }));
    wrap(<CollectionPage />);
    const banner = screen.getByRole("status", { name: /needs review/i });
    await waitFor(() => expect(banner).toHaveTextContent("3"));

    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    expect(banner).toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(false));
    expect(screen.getByRole("button", { name: "Not flagged" })).toBeInTheDocument();
    expect(banner).toHaveTextContent("3");
    // And it still goes where it says: pressing it from the complement lands on the flagged
    // rows rather than cycling the chip to the next state.
    await userEvent.click(within(banner).getByRole("button", { name: /show them/i }));
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
  });

  /**
   * The row a Scryfall update orphaned: `cards` knows nothing about it any more, so every
   * card-derived column is null — and the entry's own denormalized set and number are what
   * keep it a row the reader can recognise.
   */
  it("keeps a flagged orphan identifiable, and prints what happened to it", async () => {
    collectionList.mockResolvedValue(
      page([
        {
          ...BOLT,
          name: null,
          setName: null,
          rarity: null,
          manaCost: null,
          typeLine: null,
          unitPrice: null,
          needsReview: REVIEW_NOTE,
        },
      ]),
    );
    wrap(<CollectionPage />);

    const row = (await screen.findByText(/LEA · 161/)).closest('[role="row"]') as HTMLElement;
    const band = within(row).getByText(REVIEW_NOTE);
    expect(within(row).getByText("Needs review:")).toBeInTheDocument();
    // The band is one line and the sentence is 175 characters, so what is on screen is the
    // half that says what happened and not the half that says what to do about it. The whole
    // of it is one hover away — and a screen reader reads the text, never the clip.
    expect(band).toHaveAttribute("title", REVIEW_NOTE);
    // A price the data does not have is a dash, never an invented `$0.00`.
    expect(within(row).queryByText(/\$/)).not.toBeInTheDocument();
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("sends the collection's own filters and its sort", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: "Etched" }));
    await userEvent.click(screen.getByRole("button", { name: /^LP/ }));
    await userEvent.selectOptions(sortSelect(), "price");

    await waitFor(() => {
      const q = lastQuery();
      expect(q.finishes).toEqual(["etched"]);
      expect(q.conditions).toEqual(["LP"]);
      // The select sets one term, and the direction is the column's own first — "Highest
      // price" is the label, so descending is what it means.
      expect(q.sort).toEqual([{ key: "price", dir: "desc" }]);
      expect(q.limit).toBe(100);
    });
    // The header describes the same rows as the table under it, or it is worse than no
    // header at all.
    const asked = collectionSummary.mock.calls[collectionSummary.mock.calls.length - 1][0];
    expect(asked).toMatchObject({ finishes: ["etched"], conditions: ["LP"] });
  });

  /**
   * The select and the headers are one state seen from two ends. Picking from the select
   * replaces the sort; a header refines it; and once the sort starts somewhere the select
   * has no option for — the Value column, which is unit × copies rather than the unit price
   * the select offers — it says so rather than showing an order that is not the one running.
   */
  it("drives one sort from the headers and the select together", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "Copies" }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    // A header the select also offers reads back on it.
    expect(sortSelect()).toHaveValue("quantity");

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastQuery().sort).toEqual([
        { key: "quantity", dir: "desc" },
        { key: "value", dir: "desc" },
      ]),
    );

    // Still "Most copies": the select reads the sort's *first* term, and that is still one
    // it knows.
    expect(sortSelect()).toHaveValue("quantity");

    // Now start from Value alone, which the select has no option for at all.
    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "value", dir: "desc" }]));
    expect(sortSelect()).toHaveValue("");
    expect(screen.getByRole("option", { name: "Custom…" })).toBeDisabled();
  });

  /**
   * **The Value column follows the marketplace, unit price and all.**
   *
   * The `ea` line under the total is the one that would go unnoticed: it is only drawn on
   * multi-copy rows, so a currency mix-up there survives every single-copy fixture in this
   * file.
   */
  it("prices the Value column in the selected currency", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 3, unitPrice: 350 }]));
    wrap(<CollectionPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(screen.getByText("€1,050.00")).toBeInTheDocument());
    expect(screen.getByText("€350.00 ea")).toBeInTheDocument();
  });

  /**
   * A row the selected marketplace does not quote — an etched printing on Cardmarket, where
   * `eur_etched` does not exist, or a printing a bulk feed has never listed — arrives with a
   * `null` unit price, so its Value cell is an em dash and no `ea` line is drawn under a total
   * that does not exist. Nothing is borrowed from anywhere: there is no other number on the row.
   */
  it("shows an em dash for a row this marketplace does not price", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 3, unitPrice: null }]));
    wrap(<CollectionPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
    expect(screen.queryByText(/ea$/)).not.toBeInTheDocument();
  });

  /**
   * **The marketplace crosses the wire on every read, not only a money-sorted one.**
   *
   * It used to be a `currency` sent only while a money column was deciding the order, because
   * everything else about a price was decided on this side off the twin fields every row
   * carried. It decides the *figures* now — Card Kingdom's numbers come out of a different
   * table from TCGplayer's — so it is on every payload and in every key, and a Value column
   * cannot end up ordered in one marketplace's money while printing another's.
   */
  it("sends the marketplace on every read, sorted by money or not", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(lastQuery().marketplace).toBe("cardmarket"));

    await user.click(screen.getByRole("button", { name: /^Copies/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    expect(lastQuery().marketplace).toBe("cardmarket");

    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "value", dir: "desc" }]));
    expect(lastQuery().marketplace).toBe("cardmarket");
  });

  /** The wall is a wall of *cards*: two entries for one printing (a foil and a nonfoil) are
   *  one tile carrying what the reader owns of it. */
  it("shows the collection as art, badged with how many are owned", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const { container } = wrap(<CollectionPage />);

    const art = await screen.findAllByAltText("Lightning Bolt");
    expect(art).toHaveLength(1);
    expect(screen.getByText("3 in your collection")).toBeInTheDocument();
    // One backing, not two. The wall owns the corner and the table felt behind a mark, and
    // the mark it is handed is plain — a pill inside a pill painted the felt over itself and
    // doubled the horizontal padding on a 170px tile.
    expect(container.querySelectorAll('[class*="bg-bg/85"]')).toHaveLength(1);
  });

  /**
   * A row at zero copies is a real row — the table offers removal *only* there — so the wall
   * has to answer for one, and "×0" over the art is a sticker that says nothing. The guard
   * is `OwnedBadge`'s, which is the whole reason this view shares it instead of keeping a
   * second badge that never asked the question.
   */
  it("draws no mark on a tile the reader owns none of", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 0 }]));
    const { container } = wrap(<CollectionPage />);

    await screen.findByAltText("Lightning Bolt");
    expect(screen.queryByText("×0")).not.toBeInTheDocument();
    expect(screen.queryByText(/in your collection/)).not.toBeInTheDocument();
    // And no corner either: the backing collapses on a mark that rendered nothing, so a wall
    // of unowned tiles is not a wall of empty chips. (`CardGrid`'s own test pins the rule.)
    expect(container.querySelector('[class*="bg-bg/85"]')).toBeEmptyDOMElement();
  });
});

/**
 * The card menu, over both of this view's layouts.
 *
 * The two are one surface as far as the menu is concerned — one `CardMenuDeps` for the page —
 * but they are **not** one adapter: a table row is an entry and therefore *is* a finish, while
 * a tile is a card the reader may hold in two of them. That difference is what the two writes
 * below are about; the panel's own markup is `ContextMenu.test.tsx`'s subject.
 */
describe("the card menu", () => {
  it("opens on a right-click of a row, without opening the card", async () => {
    wrap(<CollectionPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    rightClick(row);

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // The pane belongs to a left click; a right-click asks a question about the row. `App`
    // owns the pane, so the store is the whole of what opening the card means from here —
    // asserting on a `complementary` this page never renders would be an assertion that
    // cannot fail.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The keyboard's route to the same menu, which is a feature rather than a nicety: the reader
   * was asked and chose a menu that opens by keyboard over a mouse-only one. Shift+F10 here;
   * the dedicated ContextMenu key is the primitive's other arm and its rule, not this surface's.
   */
  it("opens from the keyboard on a row, without opening the card", async () => {
    wrap(<CollectionPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** And the row's own keys still work: the menu's handler is added to the row's, not put in
   *  place of it. A single `onKeyDown` would have eaten this. */
  it("still opens the card on Enter, which the menu's handler sits beside", async () => {
    wrap(<CollectionPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "Enter" });

    expect(useAppStore.getState().selectedCardId).toBe("c1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * A collection row *is* a finish — it is one of the ten columns its identity is made of — so
   * the menu does not ask. `BOLT` is the foil entry, and a nonfoil copy recorded from it would
   * be a different row in the same table.
   */
  it("adds the row's own finish without asking", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));

    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    // An action, not a submenu: the surface named the finish.
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "foil",
        condition: "NM",
        quantity: 1,
      }),
    );
  });

  /**
   * "View all printings", live rather than greyed, reaching the oracle card the entry is of.
   *
   * This item is fenced on `oracleId`, and until `CollectionRow` carried one every row and tile
   * of the reader's collection drew it greyed with the reason *"this printing has left the card
   * database"* — a true sentence about a perfectly healthy card, which is a worse failure than
   * no item at all. The column exists to make that reason fire only when it is true, so the
   * assertion is on both halves: the row is pressable, and pressing it asks about **this**
   * card's oracle id rather than some fallback.
   *
   * `requestAllPrintings` writes the intent and the navigation in one `set`, so the store is
   * where the press is observed — `App` owns the view this page is drawn in.
   */
  it("offers View all printings, and asks about the entry's own oracle card", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");

    const printings = screen.getByRole("menuitem", { name: /View all printings/ });
    // `aria-disabled`, never the `disabled` attribute — the house rule, and what the menu's
    // greyed rows are drawn with.
    expect(printings).not.toHaveAttribute("aria-disabled", "true");

    await user.click(printings);

    expect(useAppStore.getState().pendingCardSearch).toEqual({
      oracleId: "o1",
      name: "Lightning Bolt",
    });
    expect(useAppStore.getState().activeView).toBe("search");
  });

  /**
   * The other side of the same fence, and the reason the adapter passes the column through with
   * no fallback: `cards.oracle_id` is null for 0 of 116 590 live rows, so a null here really is
   * an entry whose printing has left the corpus — and the greyed row's sentence is then true.
   */
  it("greys View all printings for an orphaned entry, which is what a null oracle id means", async () => {
    collectionList.mockResolvedValue(page([{ ...BOLT, oracleId: null }]));
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");

    expect(screen.getByRole("menuitem", { name: /View all printings/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * The rule the shared `useCardMenuDeps` exists to hold in one place, asserted rather than
   * assumed: a menu's collection add re-reads **four** keys and a wish re-reads **two**.
   *
   * They differ because the writes differ. A copy recorded changes what every wish counts as
   * owned (`ownedQuantity` is summed from `collection_entries`), what every search row is
   * badged with, and what every deck reads as claimed. A wish is a copy the reader does *not*
   * have, so it moves no collection figure and no deck's arithmetic — only the heart on a
   * result row. Three pages writing that out again is three places for one rule to drift, and
   * the drift is silent: a stale badge fails nothing.
   */
  it("re-reads what a menu add changed, and only that", async () => {
    const user = userEvent.setup();
    const { client } = wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Collection" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });

    // And the wish's two, which are a strict subset — so the assertion that matters is the one
    // that must *not* fire: nothing a wishlist add did could have moved a deck's claims.
    invalidate.mockClear();
    rightClick(screen.getByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });
  });

  /**
   * The banner is superseded by the next add rather than standing until one succeeds — the same
   * rule the stepper's and the removal's banner follow, and for the reason written beside them:
   * an alert about something the reader has already dealt with is worse than no alert.
   */
  it("clears a refused add's sentence when the next add starts", async () => {
    collectionAdd.mockRejectedValue("that card is not in the database");
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Collection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not add to your collection — that card is not in the database",
    );

    // A *wishlist* add, so the sentence that replaces it is not merely the same one written
    // again — and this one is answered.
    rightClick(screen.getByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  /**
   * The one field on the target nothing else here can see, and the reason it is carried: a
   * deck add naming no category is filed by what the card *does*, and the type line is
   * `autoCategoryFor`'s fallback. A drag of the same row carries it; a menu add would be the
   * one path that did not.
   *
   * This is also the only test on these three surfaces that drives the deck picker, so it is
   * what says the `lazy` row is reachable from a real page and that the provider nesting the
   * app uses is the one that works — the panel's own cascade is `cardMenu.test.tsx`'s subject.
   */
  it("carries the row's type line into a deck add, so the pile is chosen by what the card does", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        {/* **Above `ContextMenuProvider`, and that nesting is the whole of what makes this
            work** — it is the arrangement `App.tsx` uses, for the reason it documents. The
            panel is a *sibling* of the menu provider's children, not a descendant of them, so a
            `CardToDeckProvider` mounted inside the surface is not above the picker at all and
            `useAddCardToDeck` throws on expand. A page rendered on its own has to supply this,
            because the picker throws without it rather than swallowing the add.

            No `value`: the provider mounts the real `useCardToDeck`, so the assertion below is
            on `ipc.deckAddCard` — the write itself, which is stronger than a spy on the callback
            that was supposed to reach it. */}
        <CardToDeckProvider>
          <ContextMenuProvider>
            <CollectionPage />
          </ContextMenuProvider>
        </CardToDeckProvider>
      </QueryClientProvider>,
    );

    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Deck" }));
    await user.click(await screen.findByRole("menuitem", { name: "Burn" }));

    // `deck_add_card(deckId, cardId, categoryId, typeLine, variant, quantity)` — no category,
    // so the app's own `autoCategoryFor` files the card, and the type line is what it files it
    // by. That is the arm a drag with no column under it and an imported line both take.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "c1", null, "Instant", "live", 1),
    );
  });

  /**
   * The wall's tile is a *card* — `CollectionPage` sums the entries behind one printing into
   * one piece of art — so unlike the row it cannot *be* one finish. What it offers instead is
   * the finishes its own entries are in, and with one entry that is one finish and no question.
   *
   * The wrong answer here is not a hypothetical: a tile that said nothing about finishes fell
   * to the menu's unknown-list rule and recorded a **nonfoil** copy for a reader whose only
   * copy of this card is a foil.
   */
  it("records the one finish the reader owns, from a tile that is a card rather than an entry", async () => {
    useAppStore.setState({ collectionView: "grid" });
    const user = userEvent.setup();
    // The default page is the foil entry and nothing else.
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");
    await user.click(collection);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "foil",
        condition: "NM",
        quantity: 1,
      }),
    );
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The other arm, and the one that says the tile is a *card*: two entries for one printing are
   * one piece of art, so the wall has two finishes behind it and has to ask which one the reader
   * means. The same component asks the same question on the search wall for the same reason —
   * one wall behaving two ways would be the bug.
   *
   * Offered in `FINISHES` order rather than in the order the entries arrived, which is why the
   * fixtures below are deliberately foil-first.
   */
  it("asks which, when the reader owns the printing in two finishes", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);
    const offered = (await screen.findAllByRole("menuitem")).filter((item) =>
      ["Nonfoil", "Foil", "Etched"].includes(item.textContent ?? ""),
    );
    expect(offered.map((item) => item.textContent)).toEqual(["Nonfoil", "Foil"]);

    await user.click(screen.getByRole("menuitem", { name: "Nonfoil" }));
    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "nonfoil",
        condition: "NM",
        quantity: 1,
      }),
    );
  });
});
