import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { WishlistQuery, WishRow } from "@/lib/ipc";
import { PRICES_AS_OF } from "@/lib/prices";

const wishlistList = vi.hoisted(() => vi.fn());
const wishlistSetQuantity = vi.hoisted(() => vi.fn());
const wishlistRemove = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { wishlistList, wishlistSetQuantity, wishlistRemove },
}));

import { WishlistPage } from "./WishlistPage";
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
  quantity: 4,
  preferredFinish: "foil",
  unitPriceUsd: 400.5,
  ownedQuantity: 1,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/** A wish for the *card*, which is what a shopping list usually means. */
const ANY: WishRow = {
  ...BOLT,
  id: 8,
  cardId: null,
  setCode: null,
  collectorNumber: null,
  lang: null,
  rarity: null,
  name: "Ancestral Recall",
  manaCost: "{U}",
  preferredFinish: null,
  quantity: 1,
  ownedQuantity: 0,
  unitPriceUsd: 12,
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
 * The header's money figure, scoped — a two-row wishlist prints the same dollar amount in the
 * total and in the row it came from, and an unscoped query cannot tell the sum from a term.
 */
const total = async () => (await screen.findByText("Still to buy")).closest("div") as HTMLElement;

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
  wishlistList.mockReset().mockResolvedValue(page([BOLT]));
  wishlistSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 5, removed: false });
  wishlistRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
  useAppStore.setState({ selectedCardId: null });
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
   * act on. Spec §5: it says how old the prices are.
   */
  it("adds up what is still to buy, and says how old the prices are", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    // Three of the four Bolts at $400.50, plus the Recall.
    expect(await within(await total()).findByText("$1,213.50")).toBeInTheDocument();
    expect(await total()).toHaveAttribute("title", PRICES_AS_OF);
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
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPriceUsd: null }, ANY]));
    wrap(<WishlistPage />);

    const figure = await total();
    // The note is its own node beside the figure, so the sum reads off the pair.
    expect(await within(figure).findByText("1 unpriced")).toBeInTheDocument();
    expect(figure).toHaveTextContent("$12.00");
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
    await userEvent.selectOptions(screen.getByLabelText(/sort/i), "price");

    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBe("bolt");
      expect(q.sort).toBe("price");
      expect(q.limit).toBe(100);
    });
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
});
