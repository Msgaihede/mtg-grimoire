import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import { readDragData } from "@/features/decks/dnd";
import type { WishlistQuery, WishRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { startDrag } from "@/test-drag";

const wishlistList = vi.hoisted(() => vi.fn());
const wishlistSetQuantity = vi.hoisted(() => vi.fn());
const wishlistRemove = vi.hoisted(() => vi.fn());
/** Which marketplace the Cost column and the header figure quote. An unmocked command is a
 *  rejected query that silently resolves to the default, so it is answered explicitly. */
const getMarketplace = vi.hoisted(() => vi.fn());
// What the row's own context menu writes. Both are real `invoke`s, so an unmocked one is a
// rejection about a missing Tauri runtime rather than a call anything here could read.
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    wishlistList,
    wishlistSetQuantity,
    wishlistRemove,
    wishlistAdd,
    collectionAdd,
    getMarketplace,
  },
}));

import { WishlistPage } from "./WishlistPage";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { useAppStore } from "@/lib/store";

/** A wish pinned to one printing, one copy of four already in the binder. */
const BOLT: WishRow = {
  id: 7,
  oracleId: "o-bolt",
  cardId: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  artCardId: "c1",
  quantity: 4,
  preferredFinish: "foil",
  unitPrice: 400.5,
  ownedQuantity: 1,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/**
 * A wish for the *card*, which is what a shopping list usually means.
 *
 * `cardId` is null and `artCardId` is not, which is the pair the wall is built on: the wish
 * names no printing, and the backend's join still hands over one to draw (`wishlist.rs`).
 */
const ANY: WishRow = {
  ...BOLT,
  id: 8,
  cardId: null,
  setCode: null,
  collectorNumber: null,
  lang: null,
  rarity: null,
  artCardId: "c-recall",
  name: "Ancestral Recall",
  manaCost: "{U}",
  preferredFinish: null,
  quantity: 1,
  ownedQuantity: 0,
  unitPrice: 12,
};

const page = (items: WishRow[], total = items.length) => ({ items, total });

/**
 * What the reconciler actually writes into `needs_review` — `reconcile::flag_deleted`'s
 * sentence at its real length. The wishlist is flagged by the same pass as the collection
 * (`reconcile::sweep_orphans` walks both tables), so the band has the same job here.
 */
const REVIEW_NOTE =
  "Scryfall removed this printing from its database on 2026-04-12. Your copies are still " +
  "recorded — check the printing and re-add it if you can identify it, or remove this entry.";

const lastQuery = () =>
  wishlistList.mock.calls[wishlistList.mock.calls.length - 1][0] as WishlistQuery;

/**
 * The filter bar's sort control.
 *
 * By role and exact name, because every sortable column header carries a `title` reading
 * "Sort by …" — and `getByLabelText` falls back to `title`, so a loose `/sort/i` matches the
 * whole header row as well.
 */
const sortSelect = () => screen.getByRole("combobox", { name: "Sort" });

/**
 * The header's money figure, scoped — a two-row wishlist prints the same amount in the total
 * and in the row it came from, and an unscoped query cannot tell the sum from a term.
 *
 * **One figure now, not the pair this header used to draw.** The label names the currency
 * because the figure changes denomination in Settings, so the scoping selector takes it.
 */
const total = async (currency: "USD" | "EUR" = "USD") =>
  (await screen.findByText(`Still to buy (${currency})`)).closest("div") as HTMLElement;

/**
 * The page, under the two providers `App` mounts above it.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider
 * is above it (so that every surface offering a right-click stays renderable on its own), which
 * means a page
 * rendered bare would open nothing and pass every menu assertion below by never being asked.
 *
 * **No `CardToDeckProvider`, and a test that expands "Add to → Deck" will need one** — the deck
 * picker throws without it, deliberately, rather than swallowing the add. It goes **above**
 * `ContextMenuProvider` and not inside it: the menu panel is drawn as a *sibling* of that
 * provider's children, so a provider around this page is around none of the menu's rows.
 * `CollectionPage.test.tsx` has the wiring, and `App.tsx` uses the same nesting.
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
 * the row, never on the cell the pointer happened to be over.
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
  wishlistList.mockReset().mockResolvedValue(page([BOLT]));
  wishlistSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 5, removed: false });
  wishlistRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
  // TCGplayer unless a test says otherwise — the default, and what every `$` below asserts.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  // The table, which is not this view's default — the wall is (`store.ts`). Everything in the
  // first block below is about the list view and says so by asking for it; `the wall` block at
  // the end switches to the grid, and one test there holds the default itself. The same
  // arrangement `CollectionPage.test.tsx` uses from the other end.
  useAppStore.setState({ wishlistView: "table", selectedCardId: null });
});

describe("WishlistPage", () => {
  /**
   * The whole question a wishlist answers, per row: how far along am I. A fraction in the
   * data face and nothing else — no bar, because the direction's motion and colour budget is
   * spent on the mana line and the card art, and forty progress bars would out-shout both.
   */
  it("says what is still needed, in the data face and without a bar", async () => {
    wrap(<WishlistPage />);

    const readout = await screen.findByText("1 of 4 owned");
    expect(readout).toHaveClass("font-mono", "tabular-nums");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /**
   * A wishlist that deletes its own entries loses the record of why they were there — so a
   * covered wish is marked rather than removed, in the same cell and the same word.
   */
  it("marks a fulfilled wish instead of hiding it", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 4 }]));
    wrap(<WishlistPage />);

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("Fulfilled")).toBeInTheDocument();
    expect(screen.queryByText(/of 4 owned/)).not.toBeInTheDocument();
  });

  /** "What is still missing" is the list's usual question, so it is one press away. */
  it("narrows to the wishes the collection has not covered", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: "Still missing" }));

    await waitFor(() => expect(lastQuery().fulfilled).toBe(false));

    // And round the other way, because the opposite question — what did I already get? — is
    // the reason a fulfilled wish is kept in the first place.
    await userEvent.click(screen.getByRole("button", { name: "Still missing" }));

    expect(await screen.findByRole("button", { name: "Fulfilled" })).toBeInTheDocument();
    await waitFor(() => expect(lastQuery().fulfilled).toBe(true));
  });

  /**
   * Spec §6's distinction, said in words: a wish with no `card_id` is for the *card*, and a
   * shopping list that showed it as a printing would send the reader hunting one particular
   * piece of cardboard they never asked for.
   */
  it("says when a wish is for any printing, and which one when it is not", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    expect(await screen.findByText(/LEA · 161/)).toBeInTheDocument();
    expect(screen.getByText(/Any printing/)).toBeInTheDocument();
  });

  /**
   * A wish *for the foil* is not filled by the nonfoil in the binder — that is why finish is
   * part of what makes two wishes two wishes, and why `ownedQuantity` on a wish row is
   * finish-aware where the search's field of the same name is not. A row that did not say so
   * would show two identical lines for one card.
   */
  it("says which finish a wish is for", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    expect(await screen.findByText(/LEA · 161 · Foil/)).toBeInTheDocument();
    // And says nothing where there is no preference, rather than inventing "Nonfoil".
    expect(screen.getByText("Any printing")).toBeInTheDocument();
  });

  /** A shopping list is where the number of copies is *maintained*: the stepper writes
   *  straight through, as the collection table's does. */
  it("writes the wanted quantity straight through from the row", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Increase Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    );

    expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 5);
    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }),
      ).toHaveValue(5),
    );
  });

  /**
   * `wishlistSetQuantity(0)` *deletes* the row — the deliberate opposite of the collection's,
   * because a wish for none of something is not a wish. So the stepper never reaches zero and
   * the removal is its own control, always offered: crossing something off is what a shopping
   * list is for.
   */
  it("removes a wish through its own control, never through the stepper", async () => {
    // At one copy, which is where the stepper would step into a deletion if it could.
    wishlistList.mockResolvedValue(page([{ ...BOLT, quantity: 1 }]));
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(
      screen.getByRole("button", {
        name: "Decrease Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    ).toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
      }),
    );

    expect(wishlistRemove).toHaveBeenCalledWith(7);
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
  });

  /**
   * What the list is *for*: the money still to spend. Counted over what is missing rather
   * than over what is wanted — three of the four Bolts at $400.50, plus the Recall — because
   * a total that charged the reader for cards already in the binder is a number nobody can
   * act on. Spec §5: it says how old the prices are, and whose.
   */
  it("adds up what is still to buy, and says how old the prices are", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    // Three of the four Bolts at $400.50, plus the Recall.
    expect(await within(await total()).findByText("$1,213.50")).toBeInTheDocument();
    expect(await total()).toHaveAttribute("title", pricesAsOf(MARKETPLACES.tcgplayer));
    // One figure, not the pair this header drew before the marketplace setting existed: two
    // totals over one shopping list is two answers to the question it is open to ask.
    expect(screen.queryByText("Still to buy (EUR)")).not.toBeInTheDocument();
  });

  /** A fulfilled wish costs nothing to finish, so it adds nothing to the total. */
  it("charges nothing for a wish the collection already covers", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 4 }, ANY]));
    wrap(<WishlistPage />);

    expect(await within(await total()).findByText("$12.00")).toBeInTheDocument();
  });

  /** A total that silently omits the cards it has no price for is a number that lies by
   *  rounding down — the same rule the collection header follows. */
  it("says how many wishes the total could not price", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPrice: null }, ANY]));
    wrap(<WishlistPage />);

    const figure = await total();
    // The note is its own node beside the figure, so the sum reads off the pair.
    expect(await within(figure).findByText("1 unpriced")).toBeInTheDocument();
    expect(figure).toHaveTextContent("$12.00");
  });

  /**
   * Spec §7: this header mirrors the collection's, and that one now quotes the marketplace the
   * reader picked. On Cardmarket the figure, the label and the as-of sentence all move
   * together, and the dollars are not on screen at all.
   *
   * **And the unpriced count is summed from the rows on screen, which is the half that
   * matters.** No two marketplaces have the same holes — an etched wish has no `eur_etched` key
   * on Cardmarket, and a card a bulk feed has never listed is unpriced on that feed alone — so
   * a row this marketplace does not quote arrives with a `null` unit price, contributes nothing
   * to the sum, and is counted. Nothing is borrowed, because there is nothing to borrow from.
   */
  it("prices what is still to buy in euros, and counts what it could not price", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const UNQUOTED: WishRow = {
      ...ANY,
      id: 9,
      name: "Sol Ring",
      preferredFinish: "etched",
      unitPrice: null,
    };
    // What a Cardmarket read answers: the Bolt at €320, the etched wish at nothing at all.
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPrice: 320 }, UNQUOTED]));
    wrap(<WishlistPage />);

    // Three of the four Bolts at €320, and nothing at all for the etched wish.
    const eur = await total("EUR");
    expect(await within(eur).findByText("€960.00")).toBeInTheDocument();
    expect(within(eur).getByText("1 unpriced")).toBeInTheDocument();
    expect(eur).toHaveAttribute("title", pricesAsOf(MARKETPLACES.cardmarket));
    expect(screen.queryByText("Still to buy (USD)")).not.toBeInTheDocument();
  });

  /**
   * The Cost column, per row, in the selected currency — including the `ea` line, which is
   * only drawn where more than one copy is missing and therefore survives every single-copy
   * fixture above it.
   *
   * The marketplace is the other half, and it is on **every** read rather than only a
   * money-sorted one: it decides the figures now, not just the order, so a Cost header cannot
   * rank in one marketplace's money while its cells print another's.
   */
  it("prices the Cost column in the selected currency and sends the marketplace with every read", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const user = userEvent.setup();
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPrice: 320 }]));
    wrap(<WishlistPage />);

    const row = (await screen.findByText("Lightning Bolt")).closest('[role="row"]') as HTMLElement;
    // Three of four still missing, at €320 each. Scoped to the row: with one wish on the list
    // the header's total is the same number, and an unscoped query cannot tell a sum from a
    // term — the same reason `total()` above is scoped.
    await waitFor(() => expect(within(row).getByText("€960.00")).toBeInTheDocument());
    expect(within(row).getByText("€320.00 ea")).toBeInTheDocument();

    await waitFor(() => expect(lastQuery().marketplace).toBe("cardmarket"));
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "cost", dir: "desc" }]));
    expect(lastQuery().marketplace).toBe("cardmarket");
  });

  /**
   * The chip is not permanent. A filter for a state a healthy wishlist never reaches is a
   * control that spends its whole life saying nothing — the same reasoning that keeps the
   * collection's banner off the screen until the reconciler has left something behind.
   */
  it("keeps the needs-review chip off a wishlist with nothing flagged", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.queryByRole("button", { name: /needs review/i })).not.toBeInTheDocument();
  });

  /**
   * The half plan 3 could not build: the flagged band renders on a wish, and there was no way
   * to ask for only the wishes that carry one. Three-way, like every other filter in this app
   * that has a meaningful complement — "everything the sync did not touch" is a real question
   * once a reader has worked through the flagged ones.
   */
  it("narrows to the wishes a sync flagged, once there are any", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, needsReview: REVIEW_NOTE }, ANY]));
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(await screen.findByRole("button", { name: "Needs review" }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(true));

    // And round the other way, then off — the tri-state the backend takes.
    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));
    expect(await screen.findByRole("button", { name: "Not flagged" })).toBeInTheDocument();
    await waitFor(() => expect(lastQuery().needsReview).toBe(false));

    await userEvent.click(screen.getByRole("button", { name: "Not flagged" }));
    await waitFor(() => expect(lastQuery().needsReview).toBeUndefined());
  });

  /**
   * The wishlist is flagged by the same reconciler pass as the collection
   * (`reconcile::sweep_orphans` walks both tables), so it renders the sentence the same way:
   * inside the name's cell, so a screen reader reads it with the row it belongs to, and with
   * the whole of it on the `title` because one line holds ~110 of its 175 characters and the
   * half that goes over the edge is the half that says what to do.
   */
  it("prints what a sync left against a flagged wish, without clipping the instruction", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, needsReview: REVIEW_NOTE }]));
    wrap(<WishlistPage />);

    const row = (await screen.findByText("Lightning Bolt")).closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText("Needs review:")).toBeInTheDocument();
    expect(within(row).getByText(REVIEW_NOTE)).toHaveAttribute("title", REVIEW_NOTE);
  });

  /** An empty wishlist is not a failed search: it says how to fill one. */
  it("explains an empty wishlist instead of blaming the reader for it", async () => {
    wishlistList.mockResolvedValue(page([]));
    wrap(<WishlistPage />);

    expect(await screen.findByText(/nothing on your wishlist yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/match these filters/i)).not.toBeInTheDocument();
  });

  it("blames the filters when a filtered wishlist comes back empty", async () => {
    wishlistList.mockResolvedValue(page([]));
    wrap(<WishlistPage />);
    await screen.findByText(/nothing on your wishlist yet/i);

    await userEvent.click(screen.getByRole("button", { name: "Still missing" }));

    expect(await screen.findByText(/no wishes match these filters/i)).toBeVisible();
  });

  /** A write the backend refused has to be said out loud — a stepper that silently does
   *  nothing is a stepper the reader presses again. */
  it("says so when the wish a stepper writes to is not there any more", async () => {
    wishlistSetQuantity.mockRejectedValue("That wishlist entry is not there any more.");
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: /^Increase Copies wanted of Lightning Bolt/ }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/not there any more/i);
    // And the number goes back to what the wishlist actually holds.
    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }),
      ).toHaveValue(4),
    );
  });

  /**
   * Every list that counts these copies. A wish's `ownedQuantity` is computed from
   * `collection_entries`, and a search result's `wishlisted`/`ownedQuantity` from both — so a
   * write here makes cached rows in two other views wrong.
   */
  it("re-reads the search results after a write, now that they carry the badges", async () => {
    const { client } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: /^Increase Copies wanted of Lightning Bolt/ }),
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] }));
  });

  it("sends the wishlist's own filters and its sort", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.type(screen.getByLabelText(/search your wishlist/i), "bolt");
    await userEvent.selectOptions(sortSelect(), "price");

    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBe("bolt");
      // The select sets one term, and the direction is the column's own first — "Highest
      // price" is the label, so descending is what it means.
      expect(q.sort).toEqual([{ key: "price", dir: "desc" }]);
      expect(q.limit).toBe(100);
    });
  });

  /**
   * The select and the headers are one state seen from two ends — and the Printing column
   * is the one header in this app that is not a control at all: an any-printing wish names
   * no set, so there is nothing to sort by.
   */
  it("drives one sort from the headers and the select together, and leaves Printing alone", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("columnheader", { name: /^Printing/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Printing/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Wanted" }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    expect(sortSelect()).toHaveValue("quantity");

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastQuery().sort).toEqual([
        { key: "quantity", dir: "desc" },
        { key: "cost", dir: "desc" },
      ]),
    );

    // Cost alone is an order the select has no option for — it offers the *unit* price.
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "cost", dir: "desc" }]));
    expect(sortSelect()).toHaveValue("");
    expect(screen.getByRole("option", { name: "Custom…" })).toBeDisabled();
  });

  /**
   * Alphabetical by the words on screen, the one order an option list in this app is drawn
   * in (`lib/options.ts`). These four are named for what they *answer* — "Most wanted",
   * "Highest price" — so the order they are declared in is a train of thought rather than
   * anything a reader can see, and a picker showing it would be showing the author's notes.
   * The whole sequence is asserted rather than one entry, because that is the only thing
   * that tells a sorted list from the constant passed straight through.
   *
   * "Custom…" is pinned above them: it is the state of the control rather than an order to
   * pick, and it must not drift into the middle of the list if either it or an order is
   * ever renamed.
   */
  it("offers the sort orders alphabetically, under a pinned Custom…", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    const options = () =>
      within(sortSelect())
        .getAllByRole("option")
        .map((o) => o.textContent);
    const orders = ["Highest price", "Most wanted", "Name", "Recently added"];
    expect(options()).toEqual(orders);

    // A header this select has no option for is the only way to reach "Custom…": Cost sorts
    // by what finishing the wish costs, where the select offers the *unit* price.
    await user.click(screen.getByRole("button", { name: /^Cost/ }));

    await waitFor(() => expect(sortSelect()).toHaveValue(""));
    expect(options()).toEqual(["Custom…", ...orders]);
  });

  /** Opening a card from a wish is how the reader checks what they are about to buy. */
  it("opens the card a wish is about", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByText("Lightning Bolt"));

    expect(useAppStore.getState().selectedCardId).toBe("c1");
  });

  /** An any-printing wish names no printing, so there is nothing to open — and a row that
   *  looked clickable and did nothing would be worse than one that does not. */
  it("leaves an any-printing wish unopenable rather than opening the wrong card", async () => {
    wishlistList.mockResolvedValue(page([ANY]));
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByText("Ancestral Recall"));

    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * A pinned wish is a printing, and can be carried off the list — spec §1's third source.
   *
   * The same rule as opening one, for the same reason: a wish with no `card_id` is for the
   * *card*, and there is no printing to carry. A drag that started from one would arrive
   * somewhere carrying an empty id, which addresses every row and no row (`dnd.ts`).
   */
  it("drags a pinned wish and leaves an any-printing wish alone", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    const { container } = wrap(<WishlistPage />);
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
   * **A press on the row's removal is a press on the removal.**
   *
   * The row is the drag handle, and Chromium starts a drag from the nearest draggable
   * *ancestor* of what was pressed — so without the mark, a press on the bin that travelled
   * five pixels would drag the wish and never deliver the click. `cardDraggable` reads where
   * the press landed, which is why this presses one place and drags from another.
   */
  it("does not drag a wish when the press landed on its removal", async () => {
    const { container } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    const row = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(row, {
      pressOn: screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
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
   * **Task 11's first export entry point outside the deck editor, the wishlist's own.** This
   * list pages at 100 too, so what is loaded in memory is a scroll position rather than a
   * decision — the sweep asks for the whole filtered set at 500 a page instead, which is what
   * the `limit: 500` assertion pins.
   *
   * Wishlist opens on the **plain** format (the store's default), which writes one line per
   * card and no header — unlike the collection's CSV, so this is 150 lines for 150 rows with
   * no header to add. No correction needed here; the brief's own correction is the collection
   * page's CSV case.
   */
  it("exports every wish the filter matches, not the page that happens to be loaded", async () => {
    // 150 wishes, a 100-row list page, a 500-row sweep page: one sweep call for the lot.
    const wishes150 = Array.from({ length: 150 }, (_, i) => ({
      ...BOLT,
      id: i + 1,
      cardId: `c${i + 1}`,
      artCardId: `c${i + 1}`,
      name: `Wish ${i + 1}`,
    }));
    wishlistList.mockImplementation(async ({ limit, offset }: WishlistQuery) =>
      page(wishes150.slice(offset, offset + limit), wishes150.length),
    );
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Wish 1");

    await user.click(await screen.findByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(wishlistList).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 })),
    );
    await user.click(await screen.findByRole("button", { name: /Show decklist/ }));
    expect(await screen.findByText(/150 lines/)).toBeInTheDocument();
  });
});

/**
 * The card menu, on the one list in this app whose rows may not name a card at all.
 *
 * The same rule that decides whether a row opens the card and whether it can be dragged
 * decides this: a wish with no `card_id` is for the *card*, and there is no printing for a
 * menu to copy a name from, link to, or add a copy of.
 */
describe("the card menu", () => {
  it("opens on a right-click of a pinned wish, without opening the card", async () => {
    wrap(<WishlistPage />);
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
  it("opens from the keyboard on a pinned wish, without opening the card", async () => {
    wrap(<WishlistPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** And the row's own keys still work: this row's `onKeyDown` answers both questions, and the
   *  menu's arm runs in front of the activation rather than instead of it. */
  it("still opens the card on Enter, which the menu's handler sits beside", async () => {
    wrap(<WishlistPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "Enter" });

    expect(useAppStore.getState().selectedCardId).toBe("c1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /** The keyboard is gated on the same `cardId` the pointer is: a wish for any printing names
   *  no card, from either input. */
  it("offers no keyboard menu on a wish for any printing", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);
    const any = await screen.findByRole("row", { name: /Ancestral Recall/ });

    // `fireEvent` is wrapped in `act`, so an opened menu would already be in the DOM here —
    // the same flush the pointer case needs `act` by hand for.
    fireEvent.keyDown(any, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("row", { name: /Lightning Bolt/ }), {
      key: "F10",
      shiftKey: true,
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  /**
   * A wish may prefer a finish, and a wish *for the foil* is not filled by the nonfoil — so
   * the copy this menu records is the one the wish was for, and the reader is not asked.
   */
  it("records the wish's preferred finish without asking", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
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
   * The negative half, and it is the reason this suite renders both rows: an absence proves
   * nothing unless the same gesture on the row beside it produces the menu.
   *
   * **Both presses are inside `act`, and that is what makes the absence mean anything.** A raw
   * `dispatchEvent` is not flushed synchronously, so a `queryByRole` on the next line finds no
   * menu whether or not one was opened — this test passed against a build that offered the
   * menu on every row until `act` was put round the press. The second half is then measured
   * exactly the same way, so the two halves differ in the row and in nothing else.
   */
  it("offers no menu on a wish for any printing, which names no card to ask about", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);
    const any = await screen.findByRole("row", { name: /Ancestral Recall/ });

    await act(async () => rightClick(any));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // The same press one row up, so the absence above is about the wish rather than about
    // the harness.
    await act(async () => rightClick(screen.getByRole("row", { name: /Lightning Bolt/ })));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

/**
 * The wall — the layout this view opens on.
 *
 * One tile per **wish**, never per card: the collection's wall merges two entries for one
 * printing into one piece of art, and here the opposite is true, because a foil wish and a
 * nonfoil wish are two wishes with two prices. What these hold is the part a tile cannot copy
 * from the table — which printing it draws, what it says about it, and the two writes that had
 * to move into a panel to fit.
 */
describe("the wall", () => {
  /** The default, held where the `beforeEach` above cannot reach it: the store's initial state. */
  it("is what the wishlist opens on", () => {
    expect(useAppStore.getInitialState().wishlistView).toBe("grid");
  });

  it("draws one tile per wish, with what is owned of it over the art", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
    // The fraction the table spells out, in the two glyphs a corner mark has room for — and
    // the sentence beside it, which is what a screen reader and a tooltip get.
    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 owned")).toBeInTheDocument();
  });

  /**
   * The one thing a picture must not settle. An any-printing wish is drawn as *a* printing —
   * the newest of its oracle card, which is the only way it can have art at all — so the caption
   * goes on saying what the wish is for rather than what the tile happens to be showing.
   */
  it("captions a wish for any printing as one, over the art it is drawn as", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    expect(await screen.findByAltText("Ancestral Recall")).toBeInTheDocument();
    expect(screen.getByText("Any printing")).toBeInTheDocument();
    // And a pinned wish's caption is its printing *and* its finish, which together are what
    // make two wishes for one card two wishes.
    expect(screen.getByText("LEA · 161 · Foil")).toBeInTheDocument();
  });

  /**
   * A wish outlives the printing it was made from, so the wall has to answer for one whose card
   * has left the database: the name, no picture, and nothing to press. Fetching art for it would
   * be a request that can only 404.
   */
  it("draws an orphaned wish as a frame with its name and no card to open", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([{ ...BOLT, artCardId: null }]));
    wrap(<WishlistPage />);

    // The no-art fallback prints the name and says which kind of nothing this is — "No card",
    // not "No image": there is no printing to have a picture of. No `<img>` at all.
    expect(await screen.findByText("No card")).toBeInTheDocument();
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();
    // `BoltNo` with no space: the accname algorithm puts no separator between two inline boxes,
    // which is the same quirk `ResetAll`'s own name works around.
    expect(screen.getByRole("button", { name: /Lightning BoltNo card/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /** What finishing the wish still costs, in the corner the search spends on its printings
   *  count — over the copies still *missing*, which is the header's own arithmetic. */
  it("marks a tile with the cost of the copies still missing", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    // Three still to find at $400.50 each, and not the four the wish asks for. Scoped to the
    // tile: a one-wish list prints the same amount in the header, and an unscoped query cannot
    // tell the sum from the term it was summed from.
    const tile = (await screen.findByAltText("Lightning Bolt")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    expect(within(tile).getByText("$1,201.50")).toBeInTheDocument();
  });

  /** Nothing left to buy is nothing to say: the corner collapses rather than quoting $0.00. */
  it("draws no cost on a wish the collection already covers", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 4 }]));
    wrap(<WishlistPage />);

    const tile = (await screen.findByAltText("Lightning Bolt")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    expect(within(tile).getByText("4/4")).toBeInTheDocument();
    expect(within(tile).queryByText(/^\$/)).not.toBeInTheDocument();
  });

  /**
   * The two writes the table does in place. A 170px caption holds one 24px control, so both
   * moved into a panel behind it — a wall the reader cannot maintain their list from would be
   * the wrong thing to open on.
   */
  it("edits the copies wanted from a tile", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await user.click(
      await screen.findByRole("button", { name: /Edit Lightning Bolt .* on your wishlist/ }),
    );
    await user.click(screen.getByRole("button", { name: /Increase Copies wanted of Lightning/i }));

    await waitFor(() => expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 5));
  });

  it("removes a wish from a tile", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await user.click(
      await screen.findByRole("button", { name: /Edit Lightning Bolt .* on your wishlist/ }),
    );
    await user.click(
      screen.getByRole("button", { name: /Remove Lightning Bolt .* from your wishlist/ }),
    );

    await waitFor(() => expect(wishlistRemove).toHaveBeenCalledWith(7));
  });

  /**
   * The same rule the table's rows follow, on the same wishes: a wish for any printing names no
   * cardboard to ask a question about, so it is offered no menu — and two drawings of one list
   * must not answer differently.
   */
  it("offers a menu on a pinned wish's tile and none on an any-printing one", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    const any = (await screen.findByAltText("Ancestral Recall")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    await act(async () => rightClick(any));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const bolt = screen.getByAltText("Lightning Bolt").closest("[data-grid-index]") as HTMLElement;
    await act(async () => rightClick(bolt));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  /** The toggle is the whole of what changes: one list, two drawings of it. */
  it("switches to the table and back", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await screen.findByAltText("Lightning Bolt");
    await user.click(screen.getByRole("button", { name: "Table view" }));
    expect(await screen.findByRole("row", { name: /Lightning Bolt/ })).toBeInTheDocument();
    expect(useAppStore.getState().wishlistView).toBe("table");

    await user.click(screen.getByRole("button", { name: "Card view" }));
    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
  });
});

/**
 * The list the printings modal's own arrow keys walk, published to the store by this page.
 *
 * It goes through the store because `AllPrintingsDialog` is mounted at `App` level, outside every
 * view, and the order is this page's — a query narrowed by its filter bar. What the modal *does*
 * with a walk belongs to `AllPrintingsDialog.test.tsx`; what this file owes is that a walk of the
 * right shape is published at all, and taken back when the page goes.
 */
describe("the walk it publishes for the printings modal", () => {
  const walk = () => useAppStore.getState().cardWalk;

  /**
   * **`artCardId`, not `cardId`** — the printing each tile is *drawn as*, which for a pinned wish
   * is the one it names and for an any-printing wish is the newest printing of its oracle card.
   * {@link ANY} is that second kind, and it is a stop rather than a hole: it is a tile the reader
   * can see, the modal lists its oracle card's printings, and the card pane behind the scrim
   * opens on the printing the wall was already showing. A walk built from `cardId` would drop it.
   */
  it("publishes the wishes in their drawn order, by the printing each is drawn as", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    await waitFor(() =>
      expect(walk().stops).toEqual([
        { cardId: "c1", oracleId: "o-bolt", name: "Lightning Bolt", deck: null },
        { cardId: "c-recall", oracleId: "o-bolt", name: "Ancestral Recall", deck: null },
      ]),
    );
  });

  /** An orphan has no oracle card, so there are no printings to list and nothing to step onto —
   *  the same rule the deck's own walk drops a row whose printing has left the corpus by. */
  it("steps over a wish whose card has left the corpus", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, oracleId: null }, ANY]));
    wrap(<WishlistPage />);

    await waitFor(() => expect(walk().stops.map((stop) => stop.cardId)).toEqual(["c-recall"]));
  });

  /** The noun the modal's chevrons read into their own names — `Next card in your wishlist`. */
  it("says which list it is", async () => {
    wrap(<WishlistPage />);

    await waitFor(() => expect(walk().label).toBe("your wishlist"));
  });

  /** And it goes when the page does: a walk left behind would step a modal opened somewhere else
   *  through a list nobody is looking at. */
  it("clears the walk when the page goes", async () => {
    const view = wrap(<WishlistPage />);
    await waitFor(() => expect(walk().stops).toHaveLength(1));

    view.unmount();

    expect(walk().stops).toEqual([]);
  });
});
