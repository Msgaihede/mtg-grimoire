import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EntryInput, WishInput } from "@/lib/ipc";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";

const collectionAdd = vi.fn();
const wishlistAdd = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionAdd: (entry: EntryInput) => collectionAdd(entry),
    wishlistAdd: (wish: WishInput) => wishlistAdd(wish),
  },
}));
import { AddToCollectionButton, type AddTarget } from "./AddToCollection";

const BOLT: AddTarget = {
  cardId: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  oracleId: "o1",
  finishes: ["nonfoil", "foil"],
};

/** What a write answers with. Nothing on screen reads it, but a mutation has to resolve. */
const written = { id: 7, quantity: 1, removed: false };

/**
 * The rung the card detail pane sits on, mounted *first* exactly as the app mounts it: the
 * pane has been listening for Escape since before the popup inside it existed, which is the
 * whole reason the popup has to consume the press in the capture phase.
 */
function Pane({ onDismiss }: { onDismiss: () => void }) {
  useDismissOnEscape({ layer: "outer", onDismiss });
  return null;
}

function wrap(target: AddTarget, paneClose?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      {paneClose && <Pane onDismiss={paneClose} />}
      <AddToCollectionButton target={target} />
    </QueryClientProvider>,
  );
  return { client };
}

/** Open the popup the way a reader does — from the button, which is where Escape owes the
 *  caret back. */
async function open(target: AddTarget = BOLT, paneClose?: () => void) {
  const { client } = wrap(target, paneClose);
  const trigger = screen.getByRole("button", { name: new RegExp(`^Add ${target.name}`) });
  await userEvent.click(trigger);
  await screen.findByRole("dialog", { name: `Add ${target.name}` });
  return { client, trigger };
}

/**
 * A real Escape, and whether anything consumed it.
 *
 * `userEvent.keyboard` cannot answer the second half: the contract between the two layers
 * is `defaultPrevented` on the event object, which only a dispatch this test owns can read.
 */
function pressEscape(): boolean {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => void document.body.dispatchEvent(e));
  return e.defaultPrevented;
}

const quantity = () => screen.getByRole("spinbutton", { name: "Quantity of Lightning Bolt" });

beforeEach(() => {
  collectionAdd.mockReset().mockResolvedValue(written);
  wishlistAdd.mockReset().mockResolvedValue(written);
});

describe("AddToCollectionButton", () => {
  /**
   * The quick half of quick-add: the commonest card in any collection is one unmarked,
   * unfoiled copy, and recording it must cost one press after the popup is open.
   */
  it("adds one nonfoil near-mint copy without being told anything else", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));

    // Exactly these four fields: everything else on `EntryInput` has a serde default, and
    // sending a guess at a purchase price or a grading would be the popup inventing
    // provenance the reader never claimed.
    expect(collectionAdd).toHaveBeenCalledWith({
      cardId: "c1",
      finish: "nonfoil",
      condition: "NM",
      quantity: 1,
    });
  });

  /**
   * The backend takes any finish for any card — this row of chips is the only thing
   * standing between the collection and an etched copy of a card that was never etched.
   */
  it("offers only the finishes the printing exists in", async () => {
    await open();

    const chips = within(screen.getByRole("group", { name: "Finish" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Nonfoil", "Foil"]);
    expect(screen.queryByRole("button", { name: "Etched" })).not.toBeInTheDocument();
  });

  /**
   * `cards.finishes` is nullable, and a printing whose column is empty is one whose finishes
   * are unknown rather than one that is nonfoil. Nonfoil is the honest default anyway — it
   * is what an unqualified copy of a card is.
   */
  it("falls back to nonfoil when the surface does not know the finishes", async () => {
    await open({ ...BOLT, finishes: [] });

    const chips = within(screen.getByRole("group", { name: "Finish" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Nonfoil"]);

    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));

    expect(collectionAdd).toHaveBeenCalledWith(expect.objectContaining({ finish: "nonfoil" }));
  });

  it("records the finish and condition that were picked", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Foil" }));
    await userEvent.selectOptions(screen.getByLabelText("Condition"), "MP");
    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));

    expect(collectionAdd).toHaveBeenCalledWith({
      cardId: "c1",
      finish: "foil",
      condition: "MP",
      quantity: 2,
    });
  });

  /**
   * The Escape handshake, with both rungs really mounted. Without the capture phase a
   * single press closes this popup *and* the card pane it is standing in, and two focus
   * hand-backs race for the caret.
   */
  it("is the inner layer: Escape closes it and leaves the card pane open", async () => {
    const paneClose = vi.fn();
    await open(BOLT, paneClose);

    expect(pressEscape()).toBe(true);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(paneClose).not.toHaveBeenCalled();
  });

  it("hands the caret back to the button that opened it, before the popup goes", async () => {
    const { trigger } = await open();

    // Focus moves in on the way up, so the popup's own controls are the next thing Tab
    // reaches — and so the hand-back below is a hand-back rather than a no-op.
    expect(screen.getByRole("dialog")).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  /**
   * A wish is usually for the card, not for the cardboard: "any printing" is keyed on the
   * oracle card and carries its own name, because a shopping list outlives the printing it
   * was made from.
   */
  it("wishes for this printing, or for any printing of the card", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));
    // A wish has no condition: you cannot ask for a card you do not have to be played.
    expect(screen.queryByLabelText("Condition")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));

    expect(wishlistAdd).toHaveBeenLastCalledWith({
      cardId: "c1",
      quantity: 1,
      preferredFinish: "nonfoil",
    });

    await userEvent.click(screen.getByRole("button", { name: "Any printing" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));

    const wish = wishlistAdd.mock.calls[1][0] as WishInput;
    expect(wish).toMatchObject({ oracleId: "o1", name: "Lightning Bolt" });
    // Naming the printing is what would pin the wish to it — an "any printing" wish that
    // carried a `cardId` would be filled by that printing and no other.
    expect(wish.cardId).toBeUndefined();
  });

  /** With no oracle id there is nothing an "any printing" wish could be keyed on, and a
   *  choice that cannot be kept is not offered. No live row is in this state (the
   *  reversible-card explanation this test used to carry is false), so this fence exists
   *  only here — which is exactly why it needs a test. */
  it("cannot wish for any printing of a card that has no oracle id", async () => {
    await open({ ...BOLT, oracleId: null });

    await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

    expect(screen.getByRole("button", { name: "Any printing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "This printing" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says a failed add failed, and keeps what was filled in", async () => {
    collectionAdd.mockRejectedValue("Database is busy — try again in a moment.");
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Foil" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/database is busy/i);
    // Still open, and still holding the answers: a popup that closed on failure would make
    // the reader pick the finish, the condition and the count again to find out whether the
    // second attempt worked.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Foil" })).toHaveAttribute("aria-pressed", "true");
    expect(quantity()).toHaveValue(2);
  });

  /**
   * Recording three conditions of the same card is one interaction, not three — so the
   * popup reports and stays. The report is a live region that was already mounted, because
   * a region that appears together with its text announces nothing.
   */
  it("reports what it added, and stays open for the next copy", async () => {
    const { client } = await open();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 2 × Lightning Bolt to your collection.",
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to collection" })).toBeEnabled();

    // Everything that counts cards: the two lists and the search results, whose owned badge
    // is now one copy out of date.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    // Refetched, not merely marked. It used to carry `refetchType: "none"` because the only
    // thing this write changed on a result row was a field no view drew; Task 12's badges
    // draw it, and a wall of art that goes on saying "×2" after a third copy was added from
    // it is wrong on screen rather than stale in the cache.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
  });

  /**
   * Two identical copies of one card is the commonest second add there is — and a live
   * region only announces what *changed*, so re-setting the same sentence is silence. React
   * bails out of the render besides, on the same string.
   */
  it("announces the second identical copy as its own report", async () => {
    await open();
    const add = screen.getByRole("button", { name: "Add to collection" });

    await userEvent.click(add);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added 1 × Lightning Bolt to your collection.",
      ),
    );
    const first = screen.getByRole("status").firstElementChild;
    expect(first).not.toBeNull();

    await userEvent.click(add);

    // The same words, in a node that replaced the one before it: what a screen reader hears
    // as a second report rather than as nothing at all.
    await waitFor(() => expect(screen.getByRole("status").firstElementChild).not.toBe(first));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Added 1 × Lightning Bolt to your collection.",
    );
    expect(collectionAdd).toHaveBeenCalledTimes(2);
  });

  /** The trigger names its destination, and the popup is where the destination is chosen —
   *  so a trigger that still says "to collection" over an open wishlist form is wrong about
   *  what pressing it again would do. */
  it("says where the open popup is adding to", async () => {
    const { trigger } = await open();

    expect(trigger).toHaveAccessibleName("Add Lightning Bolt (LEA 161) to collection");

    await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

    expect(trigger).toHaveAccessibleName("Add Lightning Bolt (LEA 161) to wishlist");
  });

  /** The popup is 256px of controls hanging over a list. Tabbing out of it must not leave
   *  it there, and a reader who has moved on is not owed the caret back. */
  it("closes when the caret leaves it, without chasing the reader", async () => {
    render(<button type="button">Somewhere else</button>);
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Somewhere else" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Somewhere else" })).toHaveFocus();
  });
});
