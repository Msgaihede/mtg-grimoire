import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { CardDetail, TheoryDiffRow } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";

const deckTheoryDiff = vi.hoisted(() => vi.fn());
const deckTheoryMissingToWishlist = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
const cardDetail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckTheoryDiff, deckTheoryMissingToWishlist, wishlistAdd, cardDetail },
}));

import { diffTotals, TheoryDiffDialog } from "./TheoryDiffDialog";

/**
 * A row as `deck_theory_diff` answers one: one **printing**, already grouped and already
 * subtracted, naming the printing the theory row named.
 *
 * The three cards below are deliberately different shapes — priced, unpriced, and one the
 * collection has loose copies of — because every claim in this file is about one of those three.
 */
function row(over: Partial<TheoryDiffRow> = {}): TheoryDiffRow {
  return {
    cardId: "bolt-lea",
    name: "Lightning Bolt",
    categoryName: "Removal",
    quantity: 2,
    unitPrice: 400,
    setCode: "lea",
    collectorNumber: "161",
    ownedSpare: 0,
    ...over,
  };
}

/** Three copies wanted, one loose in the box — the row every `ownedSpare` claim here is about. */
const SOL_RING = row({
  cardId: "ring-c21",
  name: "Sol Ring",
  categoryName: "Ramp",
  quantity: 3,
  unitPrice: 1.5,
  setCode: "c21",
  collectorNumber: "263",
  ownedSpare: 1,
});

/** No `usd` for this printing, so the cost figure has to say the total is short of it. */
const UNPRICED = row({
  cardId: "angel-lea",
  name: "Serra Angel",
  categoryName: "Creatures",
  quantity: 1,
  unitPrice: null,
  setCode: "lea",
  collectorNumber: "175",
});

const DETAIL: CardDetail = {
  id: "bolt-lea",
  oracleId: "oracle-bolt",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  illustrationId: null,
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: null,
  // Unpriced everywhere, and irrelevant here: this dialog reads the detail for its `oracleId`
  // alone — the wish it makes is any-printing.
  finishPrices: { nonfoil: null, foil: null, etched: null },
  finishes: null,
  imageStatus: null,
  faces: [],
};

let client: QueryClient;
function wrap(ui: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const props = { deckId: 4, open: true, onDismiss: vi.fn(), onClose: vi.fn() };

beforeEach(() => {
  deckTheoryDiff.mockReset().mockResolvedValue([row(), SOL_RING, UNPRICED]);
  deckTheoryMissingToWishlist.mockReset().mockResolvedValue(3);
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 2, removed: false });
  cardDetail.mockReset().mockImplementation((id: string) => Promise.resolve({ ...DETAIL, id }));
  props.onDismiss = vi.fn();
  props.onClose = vi.fn();
});

/** The one row every press below is aimed at. */
const rowFor = async (name: string) => (await screen.findByText(name)).closest("li") as HTMLElement;

describe("the theory difference dialog", () => {
  /**
   * A closed dialog is not a hidden dialog. It renders nothing *and* asks nothing — the diff is
   * a full pass over both of a deck's lists plus an allocation roll-up per oracle card, and a
   * button nobody has pressed should not pay for it.
   */
  it("draws nothing and reads nothing while it is closed", () => {
    const { container } = wrap(<TheoryDiffDialog {...props} open={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(deckTheoryDiff).not.toHaveBeenCalled();
  });

  /** One line per row the backend answered, in its order, with the four facts the line is for. */
  it("lists a line per card with its quantity, pile, printing and price", async () => {
    wrap(<TheoryDiffDialog {...props} />);

    const bolt = await rowFor("Lightning Bolt");
    expect(bolt).toHaveTextContent("2×");
    expect(bolt).toHaveTextContent("Removal");
    expect(bolt).toHaveTextContent("LEA · 161");
    expect(bolt).toHaveTextContent("$400.00");
    // The unpriced printing gets an em dash and never `$0.00`, which is a price nobody quoted.
    expect(await rowFor("Serra Angel")).toHaveTextContent("—");
    expect(deckTheoryDiff).toHaveBeenCalledWith(4, "tcgplayer");
  });

  /**
   * The art is a `CardImage`, which keys the `<img>` on its own URL — the whole of why a slot
   * handed a new card paints nothing rather than the previous card's picture. Asserted as the
   * `art` crop's URL, because the row is a line of text and a full card face at row height is a
   * speck.
   */
  it("draws the art crop through CardImage, as decoration", async () => {
    wrap(<TheoryDiffDialog {...props} />);

    const image = within(await rowFor("Sol Ring")).getByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", cardImageUrl("ring-c21", 0, "art"));
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("draggable", "false");
  });

  /**
   * The three figures, and the one that is easiest to get wrong.
   *
   * `Copies to find` is copies (2 + 3 + 1), not rows. `Cost to build` is
   * 2 × $400 + 3 × $1.50 = $804.50 and says that one copy went unpriced, because a total that
   * silently omits a card is a number that lies by rounding down. `Already owned` is the plain
   * sum of `ownedSpare` — **not** netted against what the plan needs.
   */
  it("captions the list with copies, cost and the spare copies already owned", async () => {
    wrap(<TheoryDiffDialog {...props} />);
    // The labels render while the read is in flight — with an em dash rather than a zero, which
    // is `Figure`'s own rule — so the figures are read after a row has arrived, never before.
    await screen.findByText("Lightning Bolt");

    const copies = screen.getByText("Copies to find").closest("div")!;
    expect(copies).toHaveTextContent("6");
    expect(copies).toHaveTextContent("3 cards");

    const cost = screen.getByText("Cost to build (USD)").closest("div")!;
    expect(cost).toHaveTextContent("$804.50");
    expect(cost).toHaveTextContent("1 unpriced");

    const owned = screen.getByText("Already owned").closest("div")!;
    expect(owned).toHaveTextContent("1");
  });

  /** `diffTotals` is the arithmetic on its own, so the rule can be stated without a render. */
  it("never subtracts the spare copies from what the plan needs", () => {
    // Three wanted, three loose in the box. The plan still needs three: `quantity` has already
    // had the live list taken out of it and `ownedSpare` has not, so netting them counts the
    // live list twice.
    const totals = diffTotals([row({ quantity: 3, ownedSpare: 3, unitPrice: 2 })]);

    expect(totals.copies).toBe(3);
    expect(totals.cost).toBe(6);
    expect(totals.spare).toBe(3);
  });

  /**
   * The shopping list's total is quoted in the marketplace the reader picked, and it is a
   * *different sum* rather than the same sum with a different symbol — nothing in this app
   * converts. The rows arrive priced, so a second marketplace is a second set of rows.
   *
   * The second half is the hole where it costs a reader money: a card the selected marketplace
   * does not list is left out of the sum and **counted** in `unpriced`, never charged at
   * anything. A "cost to build" that quietly borrowed another marketplace's figure would be the
   * most expensive lie this dialog could tell — and there is no longer a field on the row it
   * could borrow from.
   */
  it("sums what the rows cost and counts what it could not price", () => {
    const priced = [
      row({ cardId: "a", quantity: 2, unitPrice: 10 }),
      row({ cardId: "b", quantity: 1, unitPrice: 50 }),
    ];
    const whole = diffTotals(priced);
    expect(whole.cost).toBe(70);
    expect(whole.unpriced).toBe(0);

    // The same two cards, read at a marketplace that lists only the first.
    const gappy = [
      row({ cardId: "a", quantity: 2, unitPrice: 8 }),
      row({ cardId: "b", quantity: 1, unitPrice: null }),
    ];
    const partial = diffTotals(gappy);
    expect(partial.cost).toBe(16);
    expect(partial.unpriced).toBe(1);
  });

  /**
   * The line this dialog exists to say. A difference list that shows one direction and does not
   * say so reads as a bug — the reader counts the cards they cut, does not find them, and
   * concludes the list is broken.
   */
  it("says in the footer that the other direction is deliberately not listed", async () => {
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText(/Cards in Live but not in Theory are cuts you have already made/);
    // Spec §5: this surface is nothing but prices, so the as-of sentence is drawn rather than
    // hung on a hover.
    expect(screen.getByText(pricesAsOf(MARKETPLACES.tcgplayer))).toBeInTheDocument();
  });

  /** The two lists agreeing is an answer, and an answer is a sentence. */
  it("answers an empty difference in words rather than with a blank panel", async () => {
    deckTheoryDiff.mockResolvedValue([]);
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText(/The two lists agree/);
    expect(screen.getByRole("button", { name: "Send all 0 to wishlist" })).toBeDisabled();
  });

  /**
   * **The regression this component was written around.** A row's press must write the same
   * shape the footer's does — an *any-printing* wish of the row's own quantity — or a reader who
   * pressed three row buttons ends up with a different wishlist from one who pressed the footer
   * once, because the wishlist grain is `(oracle_id, card_id, preferred_finish)` and a pinned
   * wish is a different row.
   *
   * Three copies wanted with one spare in the box wishes **three**, not two: `ownedSpare` is a
   * display field and never a term in an arithmetic.
   */
  it("wishes a row's own quantity, any printing, with the spare copies not netted out", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);

    const sol = await rowFor("Sol Ring");
    await user.click(within(sol).getByRole("button", { name: /Wishlist 3 more Sol Ring/ }));

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(1));
    // `card_detail` takes a marketplace like every priced read; this call wants only the
    // oracle id off the answer, so it passes the surface's own rather than inventing one.
    expect(cardDetail).toHaveBeenCalledWith("ring-c21", "tcgplayer");
    expect(wishlistAdd).toHaveBeenCalledWith({
      oracleId: "oracle-bolt",
      name: "Sol Ring",
      quantity: 3,
    });
    // The verb keeps its name through the flow, and the press cannot be repeated into a second
    // announcement of the same write.
    const done = await within(sol).findByRole("button", { name: /Wishlist 3 more Sol Ring/ });
    expect(done).toHaveTextContent("Wishlisted");
    expect(done).toBeDisabled();
  });

  /**
   * The bulk press is one backend call and one sentence back — and it takes the wishlist and the
   * search with it, because both writes here make any-printing wishes and `CardSummary.wishlisted`
   * is an `EXISTS` against `c.oracle_id`: one press turns the heart on for every printing of every
   * card sent. It does **not** take `["decks"]`: nothing about the deck moved.
   */
  it("sends the whole difference in one call and reports what it touched", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(await screen.findByRole("button", { name: "Send all 3 to wishlist" }));

    await screen.findByText("Sent. 3 wishes updated.");
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4);
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys).toContain('["wishlist"]');
    expect(keys).toContain('["cards","search"]');
    expect(keys).not.toContain('["decks"]');
  });

  /** A refusal is the backend's own sentence, in the dialog, not a silent no-op. */
  it("reports a refused write in words", async () => {
    const user = userEvent.setup();
    deckTheoryMissingToWishlist.mockRejectedValue("the database is busy; try again");
    wrap(<TheoryDiffDialog {...props} />);

    await user.click(await screen.findByRole("button", { name: "Send all 3 to wishlist" }));

    await screen.findByText("the database is busy; try again");
  });

  /** The read's own refusal, in the same voice — and the rows it could not fetch are not faked. */
  it("reports a refused read in words", async () => {
    deckTheoryDiff.mockRejectedValue("the theory list could not be read");
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText("the theory list could not be read");
    expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument();
  });

  /**
   * An orphan has no oracle id, so it cannot be made into an any-printing wish — which is
   * exactly the row the backend's own loop skips. Said out loud here rather than silently, because
   * a button that reports success and wrote nothing is worse than one that says why.
   */
  it("refuses a row whose printing has left the card database, in words", async () => {
    const user = userEvent.setup();
    cardDetail.mockResolvedValue(null);
    wrap(<TheoryDiffDialog {...props} />);

    const bolt = await rowFor("Lightning Bolt");
    await user.click(within(bolt).getByRole("button", { name: /Wishlist 2 more/ }));

    await screen.findByText(/Lightning Bolt has left the card database/);
    expect(wishlistAdd).not.toHaveBeenCalled();
  });

  /**
   * The Escape handshake: this is an `"inner"` rung, so it listens in the **capture** phase and
   * `preventDefault()`s the press — which is what stops the card pane behind the view from
   * closing on the same key. `onDismiss`, never `onClose`: Escape is the reader asking to be put
   * back where they were.
   */
  it("closes on Escape as an inner layer, handing focus back", async () => {
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    window.dispatchEvent(press);

    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(press.defaultPrevented).toBe(true);
  });

  /**
   * A click on the scrim is the reader already being somewhere else, so it closes and moves
   * nothing. On the panel it is nothing at all — the same press that selects a card name must not
   * take the dialog down.
   */
  it("closes on a press outside the panel and not on one inside it", async () => {
    wrap(<TheoryDiffDialog {...props} />);
    const panel = await screen.findByRole("dialog");

    fireEvent.mouseDown(panel);
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(panel.parentElement!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  /**
   * A modal takes the caret, and takes it to the panel rather than to a control: the reader has
   * not decided anything yet, and a stray Enter should not send nine cards to the wishlist for
   * them. Tab then cycles inside — without the trap, a few presses walk out into an editor the
   * reader cannot see.
   */
  it("moves the caret into the panel and keeps Tab inside it", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    const panel = await screen.findByRole("dialog");

    expect(panel).toHaveFocus();

    // Backwards off the panel lands on the last control in the dialog, which is the bulk button.
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Send all 3 to wishlist" })).toHaveFocus();

    // And forwards off it comes back round to the first, which is the header's ✕.
    await user.tab();
    expect(screen.getByRole("button", { name: "Close the difference list" })).toHaveFocus();
  });
});
