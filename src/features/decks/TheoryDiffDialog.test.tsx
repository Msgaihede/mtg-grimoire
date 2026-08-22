import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { TheoryDiffRow } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";

const deckTheoryDiff = vi.hoisted(() => vi.fn());
const deckTheoryMissingToWishlist = vi.hoisted(() => vi.fn());
/**
 * **Kept in the fake `ipc` so that a call to either fails the suite rather than the render.**
 * The row button used to read `card_detail` for an oracle id and then write `wishlist_add`
 * itself; since 2026-08-22 it goes through the one bulk command with a single key, and these two
 * are here only so that "nobody calls them any more" is something a test can assert.
 */
const wishlistAdd = vi.hoisted(() => vi.fn());
const cardDetail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckTheoryDiff, deckTheoryMissingToWishlist, wishlistAdd, cardDetail },
}));

import { diffTotals, TheoryDiffDialog } from "./TheoryDiffDialog";

/**
 * A row as `deck_theory_diff` answers one: one **exact card** — a printing in a finish — already
 * grouped and already subtracted, naming the printing the theory row named.
 *
 * The three cards below are deliberately different shapes — priced, unpriced, and one the
 * collection has loose copies of — because every claim in this file is about one of those three.
 * `finish: null` is the regular copy, which is what a row is unless a test says otherwise, and
 * `heldAsOtherPrinting: 0` is the ordinary card the deck simply has not got: the two rows that
 * are *not* that are spelled out below, because they are what the filter is for.
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
    finish: null,
    ownedSpare: 0,
    heldAsOtherPrinting: 0,
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

/**
 * **The row that is in both views**: two copies wanted, one of them already on the table as a
 * different art. One copy to find and one already played, which is why `Missing` and
 * `Different printing` cannot be a partition.
 */
const PARTIAL = row({
  cardId: "ring-sld",
  name: "Sol Ring",
  categoryName: "Ramp",
  quantity: 2,
  unitPrice: 2,
  setCode: "sld",
  collectorNumber: "913",
  heldAsOtherPrinting: 1,
});

/** Wanted once and wholly covered by another printing — nothing to buy, an upgrade to make. */
const SUBSTITUTED = row({
  cardId: "jace-wwk",
  name: "Jace, the Mind Sculptor",
  categoryName: "Card advantage",
  quantity: 1,
  unitPrice: 50,
  setCode: "wwk",
  collectorNumber: "31",
  heldAsOtherPrinting: 1,
});

/** One of each reading: pure missing, both, pure substitution. Every filter claim below is
 *  about these three, and `2 + 2 > 3` is the overlap the band's note exists to explain. */
const MIXED = [row(), PARTIAL, SUBSTITUTED];

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
  wishlistAdd.mockReset();
  cardDetail.mockReset();
  props.onDismiss = vi.fn();
  props.onClose = vi.fn();
});

/** The one row every press below is aimed at. */
const rowFor = async (name: string) => (await screen.findByText(name)).closest("li") as HTMLElement;

/**
 * The rung of the segmented control, addressed the way a reader picks one — **by the name the
 * control computes, which is its own `aria-label`**.
 *
 * The visible label and its count are two elements separated by a `gap`, which is CSS and not a
 * text node, so a name built from them reads `Different printing2` — one word ending in a digit.
 * jsdom cannot referee that, and the matchers here hedged with `\s*` until driving the shipped
 * window on 2026-08-22 settled it; the fix was to spell the name out on the control. Spelling it
 * here too means this helper *fails* if that label is ever dropped, rather than falling back to a
 * concatenation nobody can read aloud.
 */
const rung = (label: string, count: number) =>
  screen.getByRole("radio", { name: `${label}, ${count} ${count === 1 ? "card" : "cards"}` });

/** The band's select-all, whose readout **is** its accessible name. */
const selectAll = () => screen.getByRole("checkbox", { name: /selected$/ });

/** The names of the cards the list is currently drawing, in order. `text-sm` is the row's one
 *  body-sized span — everything else on the line is data type or a note. */
const shownNames = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector("span.text-sm")!.textContent);

describe("the theory difference dialog", () => {
  /**
   * A closed dialog is not a hidden dialog. It renders nothing *and* asks nothing — the diff is
   * a full pass over both of a deck's lists plus an allocation roll-up per line, and a button
   * nobody has pressed should not pay for it.
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
   * The same rule one axis over, and the one the filter made reachable: a row the live list is
   * already playing as another printing still counts its **full** quantity here, because the
   * full quantity is what a press writes. What the deck already covers is said in words on the
   * row and is never a second number a button would disagree with.
   */
  it("never subtracts what is played as another printing either", () => {
    const totals = diffTotals([PARTIAL, SUBSTITUTED]);

    expect(totals.copies).toBe(3);
    expect(totals.cost).toBe(54);
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

  /**
   * The second sentence of the same kind, and it has to be on screen rather than on a hover:
   * `Missing 2` beside `Different printing 2` over a three-row list is arithmetic a reader
   * cannot check, and the reason is that a row can be in both.
   */
  it("says beside the filter that a card can be in both views", async () => {
    deckTheoryDiff.mockResolvedValue(MIXED);
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText(/A card can be in both views/);
    expect(screen.getByText(/a different finish counts as a different printing/)).toBeVisible();
  });

  /** The two lists agreeing is an answer, and an answer is a sentence. */
  it("answers an empty difference in words rather than with a blank panel", async () => {
    deckTheoryDiff.mockResolvedValue([]);
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText(/The two lists agree/);
    expect(screen.getByRole("button", { name: "Send 0 selected to wishlist" })).toBeDisabled();
    // Three rungs reading zero and a checkbox that can never move are furniture, not controls.
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  // --- the selection ------------------------------------------------------------------------

  /**
   * **Every row arrives ticked, and the button counts what a press would carry.** The reader's
   * gesture on this surface is exclusion — they open a shopping list, not an empty basket — so
   * the default is the whole difference and unticking is what they do to it.
   */
  it("sends only the rows left ticked, and counts them on the button", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText("Lightning Bolt");
    expect(screen.getByRole("button", { name: "Send 3 selected to wishlist" })).toBeEnabled();

    await user.click(screen.getByRole("checkbox", { name: "Select 2 more Lightning Bolt" }));

    const send = screen.getByRole("button", { name: "Send 2 selected to wishlist" });
    await user.click(send);

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    // The keys the backend takes are `rowKey`'s own spelling, and the unticked row is not among
    // them — an include list, so a row the reader took out is simply absent.
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|", "angel-lea|"]);
  });

  /**
   * The band's one control over the whole shown list, in its ordinary shape: checked when every
   * shown row is ticked, `indeterminate` when some are, and its readout **is** its name — so a
   * reader who cannot see the band still hears what the press would be scoped to.
   */
  it("ticks and unticks every shown row from the band", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    expect(selectAll()).toBeChecked();
    expect(screen.getByText(/3 of 3 selected/)).toBeInTheDocument();

    await user.click(selectAll());
    expect(screen.getByText(/0 of 3 selected/)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select 2 more Lightning Bolt" }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Send 0 selected to wishlist" })).toBeDisabled();

    await user.click(selectAll());
    expect(screen.getByText(/3 of 3 selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send 3 selected to wishlist" })).toBeEnabled();

    // Some but not all is the third state, and it is the one only the DOM property carries.
    await user.click(screen.getByRole("checkbox", { name: "Select 3 more Sol Ring" }));
    expect(selectAll()).not.toBeChecked();
    expect((selectAll() as HTMLInputElement).indeterminate).toBe(true);
  });

  /**
   * **A row that arrives while the dialog is open arrives ticked**, like every other row — the
   * state is a record of what the reader unticked rather than of what they left, so a row the
   * set has never heard of is selected by construction. The query sits under `["decks"]`, which
   * every deck write in the app invalidates, so this is an ordinary refetch rather than an edge
   * case.
   */
  it("selects a row that arrives under the open dialog, and keeps what was unticked", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockReset().mockResolvedValue([row()]);
    wrap(<TheoryDiffDialog {...props} />);

    await screen.findByText("Lightning Bolt");
    await user.click(screen.getByRole("checkbox", { name: "Select 2 more Lightning Bolt" }));
    expect(screen.getByRole("button", { name: "Send 0 selected to wishlist" })).toBeDisabled();

    deckTheoryDiff.mockResolvedValue([row(), SOL_RING]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["decks"] });
    });

    await screen.findByText("Sol Ring");
    await user.click(await screen.findByRole("button", { name: "Send 1 selected to wishlist" }));

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|"]);
  });

  // --- the two views ------------------------------------------------------------------------

  /**
   * The three rungs and what each draws. A row is `Missing` while there is a copy left to find
   * and `Different printing` while there is a copy already on the table — so `PARTIAL`, which is
   * both, is drawn under both, and the rungs' counts add to more than the list. That is the
   * overlap the band's note is for, not an off-by-one.
   */
  it("filters to what is missing and to what is already played as another printing", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(MIXED);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    expect(rung("All", 3)).toHaveAttribute("aria-checked", "true");
    expect(shownNames()).toEqual(["Lightning Bolt", "Sol Ring", "Jace, the Mind Sculptor"]);

    await user.click(rung("Missing", 2));
    expect(rung("Missing", 2)).toHaveAttribute("aria-checked", "true");
    expect(shownNames()).toEqual(["Lightning Bolt", "Sol Ring"]);

    await user.click(rung("Different printing", 2));
    expect(shownNames()).toEqual(["Sol Ring", "Jace, the Mind Sculptor"]);

    await user.click(rung("All", 3));
    expect(shownNames()).toHaveLength(3);
  });

  /**
   * **A row shows its full quantity in every view**, and the qualification is a sentence rather
   * than a smaller number: the number on screen is what a press writes. Two shapes and no more —
   * a partly-covered row spells the split out, a wholly covered one says so plainly, and an
   * ordinary row that is simply not there says nothing at all.
   */
  it("notes on the row what the live list already plays, without touching the count", async () => {
    deckTheoryDiff.mockResolvedValue(MIXED);
    wrap(<TheoryDiffDialog {...props} />);

    const partial = await rowFor("Sol Ring");
    expect(partial).toHaveTextContent("2×");
    expect(within(partial).getByText("1 of 2 already played as another printing")).toBeVisible();

    const whole = await rowFor("Jace, the Mind Sculptor");
    expect(whole).toHaveTextContent("1×");
    expect(within(whole).getByText("Already played as another printing")).toBeVisible();

    expect(
      within(await rowFor("Lightning Bolt")).queryByText(/already played/),
    ).not.toBeInTheDocument();
  });

  /**
   * The strip sums the rows on screen, so a filtered view's caption can be checked against the
   * list under it. `Missing` here is 2 + 2 copies at $400 and $2; `Different printing` is
   * 2 + 1 copies at $2 and $50.
   */
  it("captions the filtered list rather than the whole difference", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(MIXED);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    const copies = () => screen.getByText("Copies to find").closest("div")!;
    const cost = () => screen.getByText("Cost to build (USD)").closest("div")!;
    expect(copies()).toHaveTextContent("5");
    expect(copies()).toHaveTextContent("3 cards");

    await user.click(rung("Missing", 2));
    expect(copies()).toHaveTextContent("4");
    expect(copies()).toHaveTextContent("2 cards");
    expect(cost()).toHaveTextContent("$804.00");

    await user.click(rung("Different printing", 2));
    expect(copies()).toHaveTextContent("3");
    expect(cost()).toHaveTextContent("$54.00");
  });

  /**
   * **Selected ∧ visible.** A selection survives a change of view — a reader who unticked a row
   * in `All` has not changed their mind by pressing a rung — but a press only ever carries what
   * is on screen, because sending a row the reader is not looking at is the dialog acting on its
   * own. The label says where the rest are rather than quietly dropping them.
   */
  it("sends only the ticked rows the current view is drawing", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(MIXED);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    // Bolt and the partial row stay ticked; the wholly substituted one comes out.
    await user.click(
      screen.getByRole("checkbox", { name: "Select 1 more Jace, the Mind Sculptor" }),
    );
    await user.click(rung("Different printing", 2));

    // Two ticked in all, one of them drawn here — and the button says both numbers.
    const send = screen.getByRole("button", { name: "Send 1 of 2 selected to wishlist" });
    await user.click(send);

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    // Bolt is still ticked and is not in the payload: this view is not drawing it.
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-sld|"]);
  });

  /**
   * A filter with nothing in it is a different answer from two lists that agree, and it needs a
   * different sentence: rows exist and this reading of them is empty. One sentence for both
   * would be wrong on whichever case it was not written for.
   */
  it("tells an empty filter apart from a plan that is already built", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue([SUBSTITUTED]);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Jace, the Mind Sculptor");

    await user.click(rung("Missing", 0));

    expect(screen.getByText(/Nothing here is missing/)).toBeVisible();
    expect(screen.queryByText(/The two lists agree/)).not.toBeInTheDocument();
  });

  // --- the writes ---------------------------------------------------------------------------

  /**
   * **The regression this component was written around, restated for the shape it has now.** A
   * row's press and the footer's press are one command with a different number of keys, so they
   * cannot write two different shapes of wish — which they could while the row button read
   * `card_detail` for an oracle id and wrote its own any-printing `wishlist_add`. Both of those
   * calls are gone, and their absence is what this asserts: the backend pins the wish to the
   * printing the plan names and skips an orphan itself.
   */
  it("routes a row's press through the same command, with that row's key", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);

    const sol = await rowFor("Sol Ring");
    await user.click(within(sol).getByRole("button", { name: /Wishlist 3 more Sol Ring/ }));

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|"]);
    // The round trip and the hand-written wish are the backend's now.
    expect(cardDetail).not.toHaveBeenCalled();
    expect(wishlistAdd).not.toHaveBeenCalled();

    // The verb keeps its name through the flow, and the press cannot be repeated into a second
    // announcement of the same write.
    const done = await within(sol).findByRole("button", { name: /Wishlist 3 more Sol Ring/ });
    expect(done).toHaveTextContent("Wishlisted");
    expect(done).toBeDisabled();
  });

  /**
   * A row's press is about that row and is deliberately not the selection: unticking a card is
   * how a reader takes it out of the *bulk* press, and the button beside it still sends it.
   */
  it("lets a row's own button send a row the reader has unticked", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("checkbox", { name: "Select 2 more Lightning Bolt" }));
    await user.click(screen.getByRole("button", { name: "Wishlist 2 more Lightning Bolt" }));

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["bolt-lea|"]);
  });

  /**
   * The bulk press is one backend call and one sentence back — and it takes the wishlist and the
   * search with it, because `CardSummary.wishlisted` is an `EXISTS` against `c.oracle_id`: one
   * press turns the heart on for every printing of every card sent, whatever printing each wish
   * was pinned to. It does **not** take `["decks"]`: nothing about the deck moved.
   */
  it("sends the whole difference in one call and reports what it touched", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(await screen.findByRole("button", { name: "Send 3 selected to wishlist" }));

    await screen.findByText("Sent. 3 wishes updated.");
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, [
      "bolt-lea|",
      "ring-c21|",
      "angel-lea|",
    ]);
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

    await user.click(await screen.findByRole("button", { name: "Send 3 selected to wishlist" }));

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
   * **Two objects of one printing are two lines, and everything that addresses a line has to
   * carry the finish.** A plan calling for the foil Bolt as well as the plain one gets a row
   * each, sharing a `cardId` and a name — so `cardId` alone as a React key is two children
   * under one key, `cardId` alone in the sent/pending tests lights the wrong row, and `cardId`
   * alone as a selection key ticks both. All of those are `rowKey`'s job, and it is also the
   * string the backend takes, which is why there is exactly one of it.
   *
   * The finish is drawn as well as keyed on: without a mark the two lines read as the list
   * having listed one card twice, which is the same "correct list that looks broken" the
   * footer's one-direction sentence exists to prevent.
   */
  it("tells a foil line from the regular one, and marks only the one pressed", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue([
      row({ quantity: 2 }),
      row({ quantity: 1, finish: "foil", unitPrice: 900 }),
    ]);
    wrap(<TheoryDiffDialog {...props} />);

    const lines = await screen.findAllByRole("listitem");
    expect(lines).toHaveLength(2);
    // The mark is the only thing on screen telling them apart, and the plain copy is unmarked
    // — the app's rule everywhere else, and why a mark on every row would say nothing.
    expect(within(lines[0]).queryByRole("img", { name: "Foil" })).not.toBeInTheDocument();
    expect(within(lines[1]).getByRole("img", { name: "Foil" })).toBeInTheDocument();
    // Each is quoted at its own object's rate, which is what makes folding them wrong.
    expect(lines[0]).toHaveTextContent("$400.00");
    expect(lines[1]).toHaveTextContent("$900.00");

    // Two checkboxes and two buttons a screen reader can tell apart, and one press moves one row.
    await user.click(
      screen.getByRole("checkbox", { name: "Select 1 more Foil Lightning Bolt" }),
    );
    expect(screen.getByRole("checkbox", { name: "Select 2 more Lightning Bolt" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Send 1 selected to wishlist" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Wishlist 1 more Foil Lightning Bolt" }));

    await waitFor(() =>
      expect(within(lines[1]).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
        "Wishlisted",
      ),
    );
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["bolt-lea|foil"]);
    expect(within(lines[0]).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
      "Wishlist",
    );
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
    expect(screen.getByRole("button", { name: "Send 3 selected to wishlist" })).toHaveFocus();

    // And forwards off it comes back round to the first, which is the header's ✕.
    await user.tab();
    expect(screen.getByRole("button", { name: "Close the difference list" })).toHaveFocus();
  });
});
