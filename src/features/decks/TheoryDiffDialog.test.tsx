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

/**
 * The two wishlist folders every destination case below picks between.
 *
 * The ids are this suite's own and are deliberately unlike every other number on this screen —
 * not the deck's `4`, not a row's quantity, not a price — because what is being checked is that
 * **the id the reader picked is the id that reaches the backend**, and an id that could be
 * confused with another argument would let a wrong one read as right.
 */
const FOLDER_NAMES = vi.hoisted<Record<number, string>>(() => ({ 7: "Ordered", 9: "Someday" }));

/**
 * **The shared destination control, stubbed — the boundary rather than a shortcut.**
 *
 * `WishDestination` belongs to `src/features/wishlist/` and is storied and tested there. What
 * *this* file owns is the wiring: that one destination governs the whole dialog, that both
 * writes carry it, that the sentences name it, and that changing it clears the `sent` marks.
 * Driving the real `Dropdown` here would hang every one of those assertions off that control's
 * rows, its panel and its `New folder…` field, so a change to any of them would fail this file
 * for a reason that is not its own.
 *
 * **What keeps the stub honest is the type.** `vi.mock`'s factory is checked against the real
 * module, so a prop passed under the wrong name, an `onChange` typed with the wrong argument or
 * a renamed export is a red build rather than a green test over a control that is not there.
 *
 * It honours the contract it stands in for, in the three places this file can tell:
 * - the trigger's accessible name **is** the `label` prop, so an assertion on that name is an
 *   assertion about what this dialog asked for;
 * - `useWishDestinationName` answers `null` at the root **and for an id that names no folder**,
 *   which is the fallback the live region and the row buttons are written against;
 * - a row press calls `onChange` **unconditionally**, including for the destination already
 *   picked. That is the real `Dropdown`'s own behaviour — `activate` calls `onActivate(v)`
 *   without comparing it to the picked value — and it is why re-picking is a gesture this
 *   dialog has to have an answer for.
 */
vi.mock("@/features/wishlist/WishDestination", () => ({
  WishDestination: ({
    folderId,
    onChange,
    label,
    disabled,
  }: {
    folderId: number | null;
    onChange: (folderId: number | null) => void;
    label: string;
    disabled?: boolean;
  }) => (
    <div>
      {/* The trigger, named by whatever the host asked for and drawing the destination the way
          the real one does — the picked row's own word. */}
      <button type="button" aria-label={label} disabled={disabled}>
        {folderId === null ? "Wishlist" : (FOLDER_NAMES[folderId] ?? "?")}
      </button>
      {/* One press per row of the panel the real control opens. Named `Choose …` rather than
          `Send to …` so that a query for the trigger cannot match one of these. */}
      {[null, ...Object.keys(FOLDER_NAMES).map(Number)].map((id) => (
        <button key={String(id)} type="button" disabled={disabled} onClick={() => onChange(id)}>
          {`Choose ${id === null ? "Wishlist" : FOLDER_NAMES[id]}`}
        </button>
      ))}
    </div>
  ),
  useWishDestinationName: (folderId: number | null) =>
    folderId === null ? null : (FOLDER_NAMES[folderId] ?? null),
}));

import { diffTotals, TheoryDiffDialog, wishesSentNote } from "./TheoryDiffDialog";

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
    // A card row unless a case says otherwise — the token rows are spelled out below.
    isToken: false,
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

/**
 * **A token the plan counts more of than the deck** (managed tokens spec §3.7): three Treasures of
 * one printing, filed under `Tokens & Emblems` as `deck_theory_diff` files every token row.
 */
const TREASURE = row({
  cardId: "treasure-thob",
  name: "Treasure",
  categoryName: "Tokens & Emblems",
  quantity: 3,
  unitPrice: 0.25,
  setCode: "thob",
  collectorNumber: "13",
  isToken: true,
});

/**
 * A token row that **would** be in both card readings — a copy left to find and one the deck
 * already plays as another printing — which is exactly what makes it the case that proves
 * `Missing` and `Different printing` leave token rows out by the flag rather than by the numbers.
 * Unpriced, so the Tokens view's caption has a hole to count.
 */
const CONSTRUCT = row({
  cardId: "construct-tbro",
  name: "Construct",
  categoryName: "Tokens & Emblems",
  quantity: 2,
  unitPrice: null,
  setCode: "tbro",
  collectorNumber: "20",
  heldAsOtherPrinting: 1,
  isToken: true,
});

/** The card rows' three readings and two token rows — every claim about the Tokens view. */
const WITH_TOKENS = [...MIXED, TREASURE, CONSTRUCT];

let client: QueryClient;
function wrap(ui: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const props = { deckId: 4, open: true, onDismiss: vi.fn(), onClose: vi.fn(), onSent: vi.fn() };

beforeEach(() => {
  deckTheoryDiff.mockReset().mockResolvedValue([row(), SOL_RING, UNPRICED]);
  deckTheoryMissingToWishlist.mockReset().mockResolvedValue(3);
  wishlistAdd.mockReset();
  cardDetail.mockReset();
  props.onDismiss = vi.fn();
  props.onClose = vi.fn();
  props.onSent = vi.fn();
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
 *
 * **The `Tokens` rung counts tokens** and every other rung counts cards — `All`'s mixed count
 * keeps the card noun on purpose (see `TheoryDiffDialog.tsx`'s `countNoun`), so the helper spells
 * the noun from the label exactly as the control does.
 */
const rung = (label: string, count: number) => {
  const noun = label === "Tokens" ? "token" : "card";
  return screen.getByRole("radio", { name: `${label}, ${count} ${noun}${count === 1 ? "" : "s"}` });
};

/** The band's select-all, whose readout **is** its accessible name. */
const selectAll = () => screen.getByRole("checkbox", { name: /selected$/ });

/** The names of the cards the list is currently drawing, in order. `text-sm` is the row's one
 *  body-sized span — everything else on the line is data type or a note. */
const shownNames = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector("span.text-sm")!.textContent);

/**
 * The footer's destination control, addressed by the sentence this dialog gives it.
 *
 * `^Send to ` reaches the trigger and nothing else on the screen: the bulk button is
 * `Send 3 selected to wishlist` and the stub's rows are `Choose …`.
 */
const destinationTrigger = () => screen.getByRole("button", { name: /^Send to / });

/** One row of the panel that control opens — the stub's stand-in for a `Dropdown` row press. */
const choose = (where: string) => screen.getByRole("button", { name: `Choose ${where}` });

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

  /** The local cache holds the crop already, so a row carrying a URL is still drawn from the
   *  protocol rather than refetching it over the network. */
  it("keeps drawing the protocol crop when a row carries a URL of its own", async () => {
    deckTheoryDiff.mockResolvedValue([
      { ...SOL_RING, imageUris: { art: "https://cards.scryfall.io/art/x.webp?1" } },
    ]);

    wrap(<TheoryDiffDialog {...props} />);

    const image = within(await rowFor("Sol Ring")).getByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", cardImageUrl("ring-c21", 0, "art"));
    expect(image.getAttribute("src")).not.toContain("scryfall.io");
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

    await screen.findByText(/Cards in Actual but not in Theory are cuts you have already made/);
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
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|", "angel-lea|"], null);
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
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|"], null);
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
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-sld|"], null);
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

    expect(
      screen.getByText(
        "No card is missing. Every card the plan asks for is already on the table as another printing.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/The two lists agree/)).not.toBeInTheDocument();
  });

  /**
   * **The card readings' sentences are about cards**, because token rows are never in them: with
   * the card side fully built and three Treasures short, `Missing` and `Different printing` are
   * empty while the difference is not — and "every copy the plan asks for is already on the
   * table" would be false of the three Treasures it is standing beside. A difference of token
   * rows only says that instead: the cards agree, and what is left is tokens.
   */
  it("says the cards agree when the difference is tokens only", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue([TREASURE]);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Treasure");

    const TOKENS_ONLY =
      "Every card the plan asks for is already in the deck. What is left is tokens.";
    for (const [label, gone] of [
      ["Missing", /Nothing here is missing|No card is missing/],
      ["Different printing", /No substitutions|No card substitutions/],
    ] as const) {
      await user.click(rung(label, 0));
      expect(screen.getByText(TOKENS_ONLY)).toBeVisible();
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
      expect(screen.queryByText(/Every copy the plan asks for/)).not.toBeInTheDocument();
    }
  });

  /** And with card rows beside the tokens, the card sentences are scoped to cards, so the token
   *  rows still short are not contradicted by the sentence under an empty card reading. */
  it("scopes the card readings' sentences to cards when tokens are short too", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue([SUBSTITUTED, TREASURE]);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Treasure");

    await user.click(rung("Missing", 0));
    expect(screen.getByText(/^No card is missing\. Every card the plan asks for/)).toBeVisible();

    deckTheoryDiff.mockResolvedValue([row(), TREASURE]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["decks"] });
    });
    await screen.findByText("Lightning Bolt");
    await user.click(rung("Different printing", 0));
    expect(
      screen.getByText(
        "No card substitutions. Every card the plan asks for is one the deck has not got in any printing.",
      ),
    ).toBeVisible();
  });

  // --- the Tokens view (managed tokens spec §3.7) ------------------------------------------

  /**
   * **Four rungs, and the fourth is a different kind of reading.** `Tokens` is the token rows
   * alone and `All` is every row, tokens included — while `Missing` and `Different printing` are
   * questions about *cards* and draw no token row, even `CONSTRUCT`, whose numbers would put it
   * under both of them if it were one.
   */
  it("offers a Tokens view, and keeps tokens out of Missing and Different printing", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(WITH_TOKENS);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    // The ladder's order, which is deliberate: the widest reading, the two card readings, and
    // then the token one.
    expect(
      within(screen.getByRole("radiogroup")).getAllByRole("radio").map((r) => r.textContent),
    ).toEqual(["All5", "Missing2", "Different printing2", "Tokens2"]);

    expect(shownNames()).toEqual([
      "Lightning Bolt",
      "Sol Ring",
      "Jace, the Mind Sculptor",
      "Treasure",
      "Construct",
    ]);

    await user.click(rung("Tokens", 2));
    expect(rung("Tokens", 2)).toHaveAttribute("aria-checked", "true");
    expect(shownNames()).toEqual(["Treasure", "Construct"]);

    await user.click(rung("Missing", 2));
    expect(shownNames()).toEqual(["Lightning Bolt", "Sol Ring"]);

    await user.click(rung("Different printing", 2));
    expect(shownNames()).toEqual(["Sol Ring", "Jace, the Mind Sculptor"]);
  });

  /** The strip follows the rung here too: three Treasures at $0.25 and two unpriced Constructs. */
  it("captions the Tokens view with the token rows alone", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(WITH_TOKENS);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(rung("Tokens", 2));

    const copies = screen.getByText("Copies to find").closest("div")!;
    expect(copies).toHaveTextContent("5");
    // Counted as tokens under the Tokens rung — the rung's own noun, and nowhere else.
    expect(copies).toHaveTextContent("2 tokens");
    expect(copies).not.toHaveTextContent("cards");
    const cost = screen.getByText("Cost to build (USD)").closest("div")!;
    expect(cost).toHaveTextContent("$0.75");
    expect(cost).toHaveTextContent("2 unpriced");

    // `All` counts the same rows beside the cards and keeps the card noun, deliberately.
    await user.click(rung("All", 5));
    expect(screen.getByText("Copies to find").closest("div")!).toHaveTextContent("5 cards");
  });

  /**
   * **Review focus 4: a plan that counts no tokens.** Every untouched token reads 0 since the
   * default moved (spec §3.1), so this is the ordinary deck — and its `All` is exactly the card
   * rows, while `Tokens` says in words that there is nothing there rather than drawing a blank
   * panel or borrowing the sentence about two lists agreeing, which they do not.
   */
  it("says so in words when the plan counts no tokens, and All is the card rows", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(MIXED);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    expect(rung("All", 3)).toHaveAttribute("aria-checked", "true");
    expect(shownNames()).toEqual(["Lightning Bolt", "Sol Ring", "Jace, the Mind Sculptor"]);

    await user.click(rung("Tokens", 0));

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("The plan counts no tokens the deck is short of.")).toBeVisible();
    expect(screen.queryByText(/The two lists agree/)).not.toBeInTheDocument();
  });

  /**
   * A token row's press is the card row's press: the same command, with the row's own key — the
   * printing and the finish — so the backend files one wish pinned to that printing.
   */
  it("sends a token row's key from its own Wishlist button", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(WITH_TOKENS);
    wrap(<TheoryDiffDialog {...props} />);

    const treasure = await rowFor("Treasure");
    await user.click(
      within(treasure).getByRole("button", { name: "Wishlist 3 more Treasure (THOB #13)" }),
    );

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["treasure-thob|"], null);
  });

  /**
   * **A token row names its printing**, because tokens share names in a way cards do not: two
   * different Wurms, or two Treasure printings at one count and one finish, are two lines that a
   * name, a count and a finish cannot tell apart — two identical `Wishlist 1 more Treasure`
   * controls. The set and collector number are what separate them — the facts the row's own
   * printing column shows as `THOB · 13`, spelled in the name as `(THOB #13)`.
   */
  it("tells two token rows of one name and finish apart by their printing", async () => {
    deckTheoryDiff.mockResolvedValue([
      row({ ...TREASURE, quantity: 1 }),
      row({
        ...TREASURE,
        cardId: "treasure-tafr",
        quantity: 1,
        setCode: "tafr",
        collectorNumber: "22",
      }),
    ]);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findAllByText("Treasure");

    expect(
      screen.getByRole("button", { name: "Wishlist 1 more Treasure (THOB #13)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Wishlist 1 more Treasure (TAFR #22)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select 1 more Treasure (THOB #13)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select 1 more Treasure (TAFR #22)" }),
    ).toBeInTheDocument();
  });

  /** A card row's name is what it always was. The printing is added where one name covering many
   *  lines is the ordinary case — a deck's Treasures — and not to every row of a shopping list. */
  it("keeps a card row's name free of its printing", async () => {
    wrap(<TheoryDiffDialog {...props} />);

    expect(
      await screen.findByRole("button", { name: "Wishlist 2 more Lightning Bolt" }),
    ).toBeInTheDocument();
  });

  /** The footer's press from the Tokens view carries the token rows and nothing else —
   *  selected ∧ visible, the rule every rung already follows. */
  it("sends only the token rows from the Tokens view's footer", async () => {
    const user = userEvent.setup();
    deckTheoryDiff.mockResolvedValue(WITH_TOKENS);
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(rung("Tokens", 2));
    await user.click(screen.getByRole("button", { name: "Send 2 of 5 selected to wishlist" }));

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(
      4,
      ["treasure-thob|", "construct-tbro|"],
      null,
    );
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
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|"], null);
    // The round trip and the hand-written wish are the backend's now.
    expect(cardDetail).not.toHaveBeenCalled();
    expect(wishlistAdd).not.toHaveBeenCalled();

    // The verb keeps its name through the flow, and the press cannot be repeated into a second
    // announcement of the same write.
    const done = await within(sol).findByRole("button", { name: /Wishlist 3 more Sol Ring/ });
    expect(done).toHaveTextContent("Wishlisted");
    expect(done).toBeDisabled();

    // **And the dialog stays open** (issue #553). Only the footer's press closes it: a reader
    // pressing row buttons is working down a list, and each one answers on its own button.
    expect(props.onDismiss).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSent).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["bolt-lea|"], null);
  });

  /**
   * The bulk press is one backend call — and it takes the wishlist and the search with it,
   * because `CardSummary.wishlisted` is an `EXISTS` against `c.oracle_id`: one press turns the
   * heart on for every printing of every card sent, whatever printing each wish was pinned to.
   * It does **not** take `["decks"]`: nothing about the deck moved.
   *
   * **And a success closes the dialog** (issue #553): what it touched goes to the host through
   * `onSent` first, then `onDismiss` — the door that hands the caret back, because the button the
   * reader pressed disabled itself for the write and left the caret on `<body>`. Never `onClose`,
   * which is the scrim's and moves nothing.
   */
  it("sends the whole difference in one call, reports what it touched and closes", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(await screen.findByRole("button", { name: "Send 3 selected to wishlist" }));

    await waitFor(() => expect(props.onDismiss).toHaveBeenCalledTimes(1));
    // No destination named, because nobody chose one — see the destination block below.
    expect(props.onSent).toHaveBeenCalledTimes(1);
    expect(props.onSent).toHaveBeenCalledWith({ wishes: 3, destination: null });
    // Told before it is closed, so a host can put its sentence up in the same commit that takes
    // the dialog down.
    expect(props.onSent.mock.invocationCallOrder[0]).toBeLessThan(
      props.onDismiss.mock.invocationCallOrder[0],
    );
    expect(props.onClose).not.toHaveBeenCalled();
    // Nothing is said in the footer on the way out — the sentence is the host's now.
    expect(screen.queryByText(/wishes updated/)).not.toBeInTheDocument();
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(
      4,
      ["bolt-lea|", "ring-c21|", "angel-lea|"],
      null,
    );
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys).toContain('["wishlist"]');
    expect(keys).toContain('["cards","search"]');
    expect(keys).not.toContain('["decks"]');
  });

  /**
   * A refusal is the backend's own sentence, in the dialog, not a silent no-op — **and the dialog
   * stays open to say it** (issue #553). Only a success closes it; a closed dialog could not tell
   * the reader why nothing happened, and the press is there to be tried again.
   */
  it("reports a refused write in words, and stays open", async () => {
    const user = userEvent.setup();
    deckTheoryMissingToWishlist.mockRejectedValue("the database is busy; try again");
    wrap(<TheoryDiffDialog {...props} />);

    await user.click(await screen.findByRole("button", { name: "Send 3 selected to wishlist" }));

    expect(await screen.findByRole("status")).toHaveTextContent("the database is busy; try again");
    expect(props.onDismiss).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send 3 selected to wishlist" })).toBeEnabled();
  });

  /**
   * The sentence the host says for the footer's press, now that the dialog is gone by the time
   * anyone could read it. It names **where from** as well as where to, because out on the editor
   * a bare "Sent." is about nothing on screen; the folder clause is `filedIn`'s, so the root adds
   * nothing. Zero is not "already wished for" — the fold never skips a wish that is already there
   * — so it says the two things a zero can actually mean.
   */
  it("words the footer's answer for the host, at the root, in a folder and at zero", () => {
    expect(wishesSentNote({ wishes: 3, destination: null })).toBe(
      "Sent from the plan to your wishlist — 3 wishes updated.",
    );
    expect(wishesSentNote({ wishes: 1, destination: "Ordered" })).toBe(
      "Sent from the plan to your wishlist — 1 wish updated in Ordered.",
    );
    const zero = wishesSentNote({ wishes: 0, destination: "Ordered" });
    expect(zero).toBe(
      "Nothing sent from the plan — those cards are no longer missing, or have left the card " +
        "database.",
    );
    // Nothing was filed, so no drawer is named as having received it.
    expect(zero).not.toMatch(/Ordered/);
    expect(zero).not.toMatch(/already/i);
  });

  /**
   * **Zero is a success, so it closes too** — the user's rule is that the write succeeding is
   * what closes, not the write finding something to do. What the reader is told is the host's
   * sentence for zero, which says why.
   */
  it("closes on a press that touched nothing, and says so to the host", async () => {
    const user = userEvent.setup();
    deckTheoryMissingToWishlist.mockResolvedValue(0);
    wrap(<TheoryDiffDialog {...props} />);

    await user.click(await screen.findByRole("button", { name: "Send 3 selected to wishlist" }));

    await waitFor(() => expect(props.onDismiss).toHaveBeenCalledTimes(1));
    expect(props.onSent).toHaveBeenCalledWith({ wishes: 0, destination: null });
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
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["bolt-lea|foil"], null);
    expect(within(lines[0]).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
      "Wishlist",
    );
  });

  // --- the destination ------------------------------------------------------------------------

  /**
   * **Where the wishes go, which this dialog had no way of saying until 2026-09-09** (issue
   * #437). Every press wrote to the wishlist root, so a reader with a cabinet full of folders
   * got a shopping list that ignored all of them.
   *
   * The block below is about the *wiring* rather than about the control: one destination for the
   * whole dialog, carried by **both** writes, said in every sentence that describes a press, and
   * clearing the one piece of state a change of folder actually invalidates. The control itself
   * is stubbed — see the mock at the head of this file for why, and for what the stub promises.
   */
  it("leaves the wishlist root as the default, and says nothing about it", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    // Born at the root, because `Dialog` mounts nothing while it is closed — so this is the
    // state of a component made fresh on this open rather than a reset somebody wrote.
    expect(destinationTrigger()).toHaveAccessibleName(
      "Send to Wishlist — choose which wishlist folder these wishes are filed in",
    );
    // And no clause anywhere: a row button is exactly the control it was before the feature.
    expect(screen.getByRole("button", { name: "Wishlist 3 more Sol Ring" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send 3 selected to wishlist" }));

    // The host is handed no name for the root, so its sentence adds no clause either.
    await waitFor(() =>
      expect(props.onSent).toHaveBeenCalledWith({ wishes: 3, destination: null }),
    );
    // `null` on the wire and never an absent argument: the root is a destination the backend is
    // told about, which is what makes "the reader chose nothing" and "the reader chose the
    // root" the same write rather than two.
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(
      4,
      ["bolt-lea|", "ring-c21|", "angel-lea|"],
      null,
    );
  });

  /**
   * The footer's press carries the folder, and the answer it hands the host says which one.
   *
   * The id asserted here is the stub's own `Ordered` (7) — a number unlike every other argument
   * on this call, so a folder id crossed with a deck id or a quantity could not read as right.
   */
  it("files the footer's press into the folder the reader chose, and names it", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(choose("Ordered"));

    expect(destinationTrigger()).toHaveAccessibleName(
      "Send to Ordered — choose which wishlist folder these wishes are filed in",
    );

    await user.click(screen.getByRole("button", { name: "Send 3 selected to wishlist" }));

    // The folder's **name**, the same lookup the trigger and the row buttons read — so the host's
    // sentence and the control the reader picked it with cannot disagree about where.
    await waitFor(() =>
      expect(props.onSent).toHaveBeenCalledWith({ wishes: 3, destination: "Ordered" }),
    );
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(
      4,
      ["bolt-lea|", "ring-c21|", "angel-lea|"],
      7,
    );
  });

  /**
   * A row's own button is the other write, and it files where the footer says.
   *
   * **The name is asserted as the computed whole**, never as two halves that happen to both be
   * present: a `gap` between two elements is CSS and not a text node, which is how
   * `Different printing2` and `Missing2` were shipped past tests that matched each part. This
   * name is spelled on the control, so what the assertion proves is that the destination reached
   * the spelling.
   */
  it("files a row's own press into the same folder, and names it on the button", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(choose("Someday"));

    const send = screen.getByRole("button", { name: "Wishlist 3 more Sol Ring in Someday" });
    expect(send).toHaveAccessibleName("Wishlist 3 more Sol Ring in Someday");
    // Ticking a row is not filing it, so the checkbox beside it says nothing about where.
    expect(screen.getByRole("checkbox", { name: "Select 3 more Sol Ring" })).toBeInTheDocument();

    await user.click(send);

    await waitFor(() => expect(deckTheoryMissingToWishlist).toHaveBeenCalledTimes(1));
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(4, ["ring-c21|"], 9);
  });

  /**
   * **The `sent` marks are the state a change of destination invalidates**, and this is the case
   * that says why.
   *
   * A wish's grain carries `coalesce(folder_id, 0)`, so the same row sent to the root and then
   * to `Ordered` is a genuinely new wish rather than a fold into the one already there. A button
   * still reading `Wishlisted` after the folder moved would be claiming a press that has not
   * happened, on the one list the reader is now filing into.
   */
  it("puts the sent marks back when the destination moves", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    const sol = await rowFor("Sol Ring");

    await user.click(within(sol).getByRole("button", { name: "Wishlist 3 more Sol Ring" }));
    await waitFor(() =>
      expect(within(sol).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
        "Wishlisted",
      ),
    );

    await user.click(choose("Ordered"));

    const again = within(sol).getByRole("button", { name: "Wishlist 3 more Sol Ring in Ordered" });
    // `not.toHaveTextContent("Wishlisted")` rather than `toHaveTextContent("Wishlist")`, which
    // is a **substring** match and is satisfied by the very word this is checking for the
    // absence of — a green assertion over the defect. The enabled check is the same claim from
    // the other side, since `disabled` is `sent || pending`.
    expect(again).not.toHaveTextContent("Wishlisted");
    expect(again).toHaveTextContent("Wishlist");
    expect(again).toBeEnabled();
  });

  /**
   * The other half of that rule: a press on the row the control is **already** on has chosen
   * nothing, so it takes nothing away.
   *
   * This is a real gesture rather than a defensive branch — the real `Dropdown`'s `activate`
   * calls `onActivate(v)` without comparing it to the picked value, so a reader who opens the
   * panel and presses the row already ticked lands here.
   */
  it("keeps the marks when the reader re-picks the destination it is already on", async () => {
    const user = userEvent.setup();
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(choose("Ordered"));
    const sol = await rowFor("Sol Ring");
    await user.click(
      within(sol).getByRole("button", { name: "Wishlist 3 more Sol Ring in Ordered" }),
    );
    await waitFor(() =>
      expect(within(sol).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
        "Wishlisted",
      ),
    );

    await user.click(choose("Ordered"));

    expect(within(sol).getByRole("button", { name: /Wishlist/ })).toHaveTextContent("Wishlisted");
  });

  /**
   * The standing answer goes with the marks, for the same reason and one sentence over — and
   * since issue #553 the only answer that can be left standing is a refusal, because a success
   * closes the dialog. `That folder is not there any more.` is a fact about the folder the reader
   * has just moved off, so it must not outlive the move.
   */
  it("takes a standing refusal down with the destination", async () => {
    const user = userEvent.setup();
    deckTheoryMissingToWishlist.mockRejectedValueOnce("That folder is not there any more.");
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(choose("Ordered"));
    await user.click(screen.getByRole("button", { name: "Send 3 selected to wishlist" }));
    await screen.findByText("That folder is not there any more.");

    await user.click(choose("Someday"));

    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  /**
   * A folder that has gone while the dialog was open is the backend's refusal, in the backend's
   * words, in the place every other answer this dialog gives is drawn.
   *
   * The check is up front in Rust rather than per row, so what a reader gets is one sentence and
   * no wishes rather than a partial write they would have to reason about.
   */
  it("reports a refused folder in words", async () => {
    const user = userEvent.setup();
    deckTheoryMissingToWishlist.mockRejectedValue("That folder is not there any more.");
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(choose("Ordered"));
    await user.click(screen.getByRole("button", { name: "Send 3 selected to wishlist" }));

    await screen.findByText("That folder is not there any more.");
    expect(deckTheoryMissingToWishlist).toHaveBeenCalledWith(
      4,
      ["bolt-lea|", "ring-c21|", "angel-lea|"],
      7,
    );
  });

  /**
   * Not while a press is in flight. Changing the destination clears what the answer on its way
   * back is about, so a write that landed after the control had moved would be announced under a
   * folder it did not write to.
   */
  it("cannot be moved while a press is in flight", async () => {
    const user = userEvent.setup();
    // Never answers, so the mutation stays pending for the rest of the test.
    deckTheoryMissingToWishlist.mockReturnValue(new Promise(() => {}));
    wrap(<TheoryDiffDialog {...props} />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "Send 3 selected to wishlist" }));

    await waitFor(() => expect(destinationTrigger()).toBeDisabled());
    expect(choose("Ordered")).toBeDisabled();
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
