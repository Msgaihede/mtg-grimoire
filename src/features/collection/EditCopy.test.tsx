import { useState, type ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { Currency } from "@/lib/marketplace";
import { pickOption } from "@/test-dropdown";

/**
 * The one command this dialog makes, and the whole subject of the file: **what is in the patch**.
 *
 * `collection_update` has had no caller in `src/` since it was written, so every assertion here is
 * about a wire shape nothing else in the app has ever produced. The real module is kept for the
 * types — `EntryPatch` is what the arguments are compared against — and only `ipc` is replaced,
 * which is how every other suite here mocks it.
 */
const collectionUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { collectionUpdate },
}));

import { EditCopy, editPatch, readPrice, type EditCopyTarget } from "./EditCopy";

/**
 * The seed's most-detailed row, cut to what this dialog reads: a played Black Lotus in a binder
 * with the whole acquisition story on it.
 *
 * A grade that is **not** the first option and a price that is **already recorded** are both
 * load-bearing. A fixture opening on the top of the scale could not tell "seeded from the row"
 * from "the picker's default", and one with no price could not reach the sentence about what
 * emptying the box will not do.
 */
const COPY: EditCopyTarget = {
  entryId: 42,
  cardName: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  finish: "nonfoil",
  condition: "HP",
  purchasePrice: 450,
  purchaseCurrency: "USD",
  folderName: "Trade binder",
};

/** The same copy with nothing paid for it recorded — the other half of every currency rule. */
const UNPRICED: EditCopyTarget = { ...COPY, purchasePrice: null, purchaseCurrency: null };

const PRICE_FIELD = "Purchase price in USD";

/**
 * The dialog under a host that owns its open state, which is what {@link EditCopy}'s
 * `target === null` contract asks for — and what lets a case assert that a successful save closes
 * the surface rather than merely that it wrote.
 */
function Harness({
  target,
  currency = "usd",
}: {
  target: EditCopyTarget;
  currency?: Currency;
}): ReactElement {
  const [open, setOpen] = useState<EditCopyTarget | null>(target);
  return (
    <EditCopy
      target={open}
      currency={currency}
      onDismiss={() => setOpen(null)}
      onClose={() => setOpen(null)}
    />
  );
}

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}

const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  // The ordinary answer: the row was edited and kept its id. A fold — where the answer names a
  // row the caller never passed in — is `update_entry`'s business and is not observable here,
  // because this dialog reads nothing out of the answer but the fact that it resolved.
  collectionUpdate.mockReset().mockResolvedValue({ id: 42, quantity: 1, removed: false });
});

describe("readPrice", () => {
  /**
   * **The third arm, which is the only thing this adds to `AddToCollection`'s parser.** That one
   * answers `number | undefined` because the add popup has no stored price to leave alone; here
   * blank and unreadable are opposite instructions, and folding them together is how Save comes to
   * write nothing over a box the reader typed in.
   */
  it("tells a blank box from one it cannot read", () => {
    expect(readPrice("")).toEqual({ kind: "blank" });
    expect(readPrice("   ")).toEqual({ kind: "blank" });
    expect(readPrice("nope")).toEqual({ kind: "unreadable" });
    // A box holding only punctuation is *something the reader typed*, so it is unreadable rather
    // than blank — the arm that says "stop" rather than the arm that says "leave it".
    expect(readPrice("$")).toEqual({ kind: "unreadable" });
    // A negative is not a price. The column has no CHECK, so this fence is the only one there is.
    expect(readPrice("-3")).toEqual({ kind: "unreadable" });
    // A German `1.234,56` is refused rather than guessed at: stripping the dots would record a
    // fifth of a cent, and a number silently wrong is worse than a field that took nothing.
    expect(readPrice("1.234,56")).toEqual({ kind: "unreadable" });
  });

  /** The arithmetic is `AddToCollection.parsePurchasePrice`'s, verbatim, and these are the cases
   *  that say so — if the two ever disagree, one of them is broken. */
  it("reads what the app itself would have written", () => {
    // A lone comma is a decimal point.
    expect(readPrice("12,50")).toEqual({ kind: "number", value: 12.5 });
    expect(readPrice(" 12.50 ")).toEqual({ kind: "number", value: 12.5 });
    // The currency symbol is stripped, so the hint a reader was shown can be retyped verbatim.
    expect(readPrice("$2.50")).toEqual({ kind: "number", value: 2.5 });
    // A comma *before* a dot is grouping — which is how `en-US` and `en-IE` both write money.
    expect(readPrice("$1,234.56")).toEqual({ kind: "number", value: 1234.56 });
    // Zero is a real price — a prize, a gift, a card out of somebody's spare box.
    expect(readPrice("0")).toEqual({ kind: "number", value: 0 });
  });
});

describe("editPatch", () => {
  /** The rule the Save button greys on, checked without a DOM: nothing touched is an empty
   *  object, and an empty object is not a write. */
  it("sends nothing when nothing changed", () => {
    expect(editPatch(COPY, COPY.condition, { kind: "number", value: 450 }, "usd")).toEqual({});
    expect(editPatch(COPY, COPY.condition, { kind: "blank" }, "usd")).toEqual({});
  });

  /** A grade this build cannot name is only ever the seed of an unrecognised stored word, and
   *  handing it back would ask the backend to accept a value its own CHECK refuses. */
  it("never sends a grade it cannot name", () => {
    const odd = { ...COPY, condition: "PRISTINE" };
    expect(editPatch(odd, "PRISTINE", { kind: "blank" }, "usd")).toEqual({});
  });

  /** The one thing a stored purchase price may never do: move with the marketplace setting. */
  it("leaves a recorded currency alone and fills in a missing one", () => {
    expect(editPatch(COPY, COPY.condition, { kind: "number", value: 7 }, "eur")).toEqual({
      purchasePrice: 7,
    });
    expect(editPatch(UNPRICED, COPY.condition, { kind: "number", value: 7 }, "eur")).toEqual({
      purchasePrice: 7,
      purchaseCurrency: "EUR",
    });
  });
});

describe("EditCopy", () => {
  it("opens on the copy's own grade and the price it holds", async () => {
    wrap(<Harness target={COPY} />);

    // Which copy — the card, then the three facts that tell it from its siblings.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("LEA 161 · Nonfoil · Trade binder")).toBeInTheDocument();
    // The grade the row holds, not the top of the scale.
    expect(screen.getByRole("button", { name: "Condition" })).toHaveTextContent("Heavily played");
    expect(screen.getByRole("textbox", { name: PRICE_FIELD })).toHaveValue("450");
  });

  /** Nothing touched is nothing to write — and the button says so before the press rather than
   *  after it, which is what stops a no-op reaching the wire as an `updated_at` bump. */
  it("greys Save until something changes, and writes nothing if it is pressed anyway", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    expect(save()).toHaveAttribute("aria-disabled", "true");
    await user.click(save());
    expect(collectionUpdate).not.toHaveBeenCalled();
  });

  it("sends only the grade when only the grade changed", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    await pickOption(user, "Condition", "Near mint");
    await user.click(save());

    // **Only** the grade: the price is in the box, unchanged, and a patch carrying it would be a
    // write over a column the reader never touched.
    await waitFor(() => expect(collectionUpdate).toHaveBeenCalledWith(42, { condition: "NM" }));
  });

  it("sends only the price when only the price changed", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    const box = screen.getByRole("textbox", { name: PRICE_FIELD });
    await user.clear(box);
    await user.type(box, "12.50");
    await user.click(save());

    // No currency either — the row already carries one, and sending it back would be a write
    // that changes nothing while looking like a decision.
    await waitFor(() => expect(collectionUpdate).toHaveBeenCalledWith(42, { purchasePrice: 12.5 }));
  });

  it("records the marketplace's currency for a copy that has none", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={UNPRICED} currency="eur" />);

    await user.type(screen.getByRole("textbox", { name: "Purchase price in EUR" }), "9");
    await user.click(save());

    await waitFor(() =>
      expect(collectionUpdate).toHaveBeenCalledWith(42, {
        purchasePrice: 9,
        purchaseCurrency: "EUR",
      }),
    );
  });

  /**
   * **The un-clearable price, which is the one thing this dialog must not pretend about.**
   *
   * `EntryPatch` is `coalesce(?n, column)` throughout, so an absent field means "leave it" and
   * there is no value that means "make it null". Emptying the box therefore writes nothing — and
   * the reader is told so on the line under the field rather than finding out from the table
   * afterwards.
   */
  it("says what emptying the price box will not do, and does not do it", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    await user.clear(screen.getByRole("textbox", { name: PRICE_FIELD }));

    expect(
      screen.getByText(/Emptying this box leaves \$450\.00 recorded\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/A price can be corrected here, never removed\./)).toBeInTheDocument();
    // And with nothing else changed there is nothing to save at all.
    expect(save()).toHaveAttribute("aria-disabled", "true");
  });

  /** The empty box is not a veto on the rest of the form: the grade still saves, and the price
   *  column is simply left out. */
  it("still saves the grade over an emptied price box", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    await user.clear(screen.getByRole("textbox", { name: PRICE_FIELD }));
    await pickOption(user, "Condition", "Lightly played");
    await user.click(save());

    await waitFor(() => expect(collectionUpdate).toHaveBeenCalledWith(42, { condition: "LP" }));
  });

  /** A row with no price has nothing to clear, so the sentence is not drawn — a pre-emptive
   *  warning about a state that cannot arise is noise. */
  it("draws no clearing note for a copy that has no price", () => {
    wrap(<Harness target={UNPRICED} />);
    expect(screen.queryByText(/never removed/)).toBeNull();
  });

  /**
   * The other half of the same rule: something the box cannot read is refused **at the button**,
   * with the trouble named, rather than dropped from the patch and saved as though it were blank.
   */
  it("refuses a price it cannot read, and names the trouble", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    const box = screen.getByRole("textbox", { name: PRICE_FIELD });
    await user.clear(box);
    await user.type(box, "about four fifty");

    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("That is not a price — try 12.50.")).toBeInTheDocument();
    expect(save()).toHaveAttribute("aria-disabled", "true");

    // Even with a grade change beside it, which is the case a patch-level guard alone would miss:
    // there *is* something to write, and writing it would silently throw the typed price away.
    await pickOption(user, "Condition", "Near mint");
    expect(save()).toHaveAttribute("aria-disabled", "true");
    await user.click(save());
    expect(collectionUpdate).not.toHaveBeenCalled();
  });

  /** Enter in the price field is the write, which is what a two-field form owes a keyboard. */
  it("saves on Enter in the price field", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    const box = screen.getByRole("textbox", { name: PRICE_FIELD });
    await user.clear(box);
    await user.type(box, "3{Enter}");

    await waitFor(() => expect(collectionUpdate).toHaveBeenCalledWith(42, { purchasePrice: 3 }));
  });

  /**
   * **`["collection"]` whole, and nothing else.**
   *
   * The whole key because an edit can fold this row onto another one, so the list cannot be
   * repaired from the patch and has to be re-read. Nothing else because nothing else draws either
   * field: `["cards", "search"]` and `["wishlist"]` are counts of copies, `["decks"]` is what a
   * deck's group physically holds, and no copy moved.
   */
  it("invalidates the collection on success and touches no other list", async () => {
    const user = userEvent.setup();
    const { client } = wrap(<Harness target={COPY} />);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await pickOption(user, "Condition", "Near mint");
    await user.click(save());

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([["collection"]]);
  });

  /** A successful save closes the surface — the reader asked one question and it is answered. */
  it("closes on a successful save", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    await pickOption(user, "Condition", "Near mint");
    await user.click(save());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  /**
   * A refusal keeps the dialog open with both answers still in it: a refused edit is one the
   * reader can try again, and `GONE` — the row deleted in another window — is the sentence they
   * need to read before the surface goes away.
   */
  it("stays open and reports a refusal", async () => {
    const user = userEvent.setup();
    collectionUpdate.mockRejectedValue(new Error("That entry is gone."));
    wrap(<Harness target={COPY} />);

    await pickOption(user, "Condition", "Near mint");
    await user.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save this copy — That entry is gone.",
    );
    expect(screen.getByRole("button", { name: "Condition" })).toHaveTextContent("Near mint");
  });

  /**
   * A stored grade this build cannot name draws **itself**, not the first row of the picker.
   *
   * `Dropdown` falls back to its `placeholder` when the value matches no option, and with nothing
   * passed that fallback is an em dash — but the trap this guards is the one a controlled picker
   * sets when a *host* forgets: a trigger reading the first option would claim the copy is
   * ungraded when it is stored as something else, and a Save that then writes nothing because the
   * value has not changed. The column's CHECK means no such row exists; the fence is around the
   * type, which is `string`.
   */
  it("draws a stored grade it cannot name rather than the head of the scale", () => {
    wrap(<Harness target={{ ...COPY, condition: "PRISTINE" }} />);
    expect(screen.getByRole("button", { name: "Condition" })).toHaveTextContent("PRISTINE");
  });

  it("closes on Cancel without writing", async () => {
    const user = userEvent.setup();
    wrap(<Harness target={COPY} />);

    await pickOption(user, "Condition", "Near mint");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(collectionUpdate).not.toHaveBeenCalled();
  });
});
