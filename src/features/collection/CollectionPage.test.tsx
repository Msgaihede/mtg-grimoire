import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CollectionQuery, CollectionRow, CollectionSummary } from "@/lib/ipc";
import { PRICES_AS_OF } from "@/lib/prices";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
const collectionSetQuantity = vi.hoisted(() => vi.fn());
const collectionRemove = vi.hoisted(() => vi.fn());
// The set picker rides the filter row and asks for the set list on the way up.
const listSets = vi.hoisted(() => vi.fn());
// The wall pre-warms its own art in the background on the first load that has rows.
const prewarmCollection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionSummary,
    collectionSetQuantity,
    collectionRemove,
    listSets,
    prewarmCollection,
  },
}));

import { CollectionPage } from "./CollectionPage";
import { useAppStore } from "@/lib/store";

const BOLT: CollectionRow = {
  id: 7,
  cardId: "c1",
  name: "Lightning Bolt",
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
  unitPriceUsd: 400.5,
  unitPriceEur: 350,
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

const summary = (over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  totalCards: 0,
  uniqueCards: 0,
  entries: 0,
  tradelistCards: 0,
  valueUsd: 0,
  valueEur: 0,
  unpricedUsd: 0,
  unpricedEur: 0,
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

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
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
  collectionList.mockReset().mockResolvedValue(page([BOLT]));
  collectionSummary.mockReset().mockResolvedValue(summary({ totalCards: 2, uniqueCards: 1 }));
  collectionSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 3, removed: false });
  collectionRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
  listSets.mockReset().mockResolvedValue([]);
  prewarmCollection.mockReset().mockResolvedValue(0);
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

  it("adds the collection up in the header, and says how old the prices are", async () => {
    collectionSummary.mockResolvedValue(
      summary({ totalCards: 1240, uniqueCards: 812, valueUsd: 9876.5, valueEur: 8100 }),
    );
    wrap(<CollectionPage />);

    expect(await screen.findByText("1,240")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("$9,876.50")).toBeInTheDocument();
    expect(screen.getByText("€8,100.00")).toBeInTheDocument();

    // Spec §5: no price on screen without saying how old it is. The header has no room for
    // the sentence beside four figures, so it rides on the figures it is about.
    expect(screen.getByText("Value (USD)").closest("div")).toHaveAttribute("title", PRICES_AS_OF);
    expect(screen.getByText("Value (EUR)").closest("div")).toHaveAttribute("title", PRICES_AS_OF);
  });

  /** A total that silently omits the cards it has no price for is a number that lies by
   *  rounding down. */
  it("shows how many copies the value could not price", async () => {
    collectionSummary.mockResolvedValue(
      summary({ totalCards: 1240, valueUsd: 100, unpricedUsd: 2, unpricedEur: 7 }),
    );
    wrap(<CollectionPage />);

    expect(await screen.findByText("2 unpriced")).toBeInTheDocument();
    expect(screen.getByText("7 unpriced")).toBeInTheDocument();
  });

  it("leaves the unpriced note off when everything has a price", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 3, valueUsd: 10, valueEur: 9 }));
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
          unitPriceUsd: null,
          unitPriceEur: null,
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
    await userEvent.selectOptions(screen.getByLabelText(/sort/i), "price");

    await waitFor(() => {
      const q = lastQuery();
      expect(q.finishes).toEqual(["etched"]);
      expect(q.conditions).toEqual(["LP"]);
      expect(q.sort).toBe("price");
      expect(q.limit).toBe(100);
    });
    // The header describes the same rows as the table under it, or it is worse than no
    // header at all.
    const asked = collectionSummary.mock.calls[collectionSummary.mock.calls.length - 1][0];
    expect(asked).toMatchObject({ finishes: ["etched"], conditions: ["LP"] });
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
