import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PickCopies, type CopyChoice } from "./PickCopies";

/**
 * The picker a drop opens when the tile the reader let go of stands for more than one
 * `collection_entries` row.
 *
 * **What is being tested is the _question_, not the write.** This component holds no mutation and
 * no query: what it can get wrong is which copies it offers, which it starts ticked, what it says
 * about the ones it cannot move, and what it hands back — so every assertion below is about one
 * of those four and none of them needs a backend.
 *
 * The one thing no test here can see is the clip: `FOCUS` is an outline painted outside the
 * border box and the list is a scroller, so a row flush against its content edge loses that side
 * of its focus mark. jsdom has no layout engine, so the padding that buys room for it is asserted
 * nowhere and stays a live claim.
 */

/** `collection_folders.rs`'s own sentence, copied rather than imported — this side of the wire
 *  never sees the Rust constant, and a test that recomputed the string would pass against a
 *  component that had invented its own. */
const IN_A_DECK = "Those copies are in a deck. Cut the card from the deck to get them back.";

function copy(over: Partial<CopyChoice> & { entryId: number }): CopyChoice {
  return {
    finish: "Nonfoil",
    condition: "NM",
    lang: "en",
    quantity: 1,
    folderName: null,
    blocked: null,
    ...over,
  };
}

/** The three-row spread this file leans on: one loose copy, a foil pair in a binder, and a
 *  Japanese played copy beside it — four copies over three rows, which is what makes the
 *  button's arithmetic checkable. */
const THREE: CopyChoice[] = [
  copy({ entryId: 1 }),
  copy({ entryId: 2, finish: "Foil", folderName: "Trade binder", quantity: 2 }),
  copy({ entryId: 3, condition: "LP", lang: "ja", folderName: "Trade binder" }),
];

function draw(over: Partial<Parameters<typeof PickCopies>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <PickCopies
      cardName="Lightning Bolt"
      destination="Trade binder"
      copies={THREE}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel };
}

/** The confirm button, addressed by its accessible name's stable half rather than by its count —
 *  the count is what most of these tests are about, so matching on it would make the query the
 *  assertion. */
const confirm = () => screen.getByRole("button", { name: /^Move .* to / });

describe("PickCopies", () => {
  it("names the card and the destination in one sentence, and the group takes its name from it", () => {
    draw();

    // Labelled *by* the heading rather than with a second copy of the words, so the box a screen
    // reader announces on entry and the line a reader sees cannot come to disagree.
    expect(screen.getByRole("group")).toHaveAccessibleName("Move Lightning Bolt to Trade binder");
  });

  it("draws a copy as finish, condition, folder and count, and says the language only when it is not English", () => {
    draw();

    const rows = screen.getAllByRole("checkbox");
    // The folder is on every row because it is the only thing telling two otherwise identical
    // copies apart; the language is on the third alone.
    expect(rows[0]).toHaveAccessibleName("Nonfoil, NM, Collection, 1 copy");
    expect(rows[1]).toHaveAccessibleName("Foil, NM, Trade binder, 2 copies");
    expect(rows[2]).toHaveAccessibleName("Nonfoil, LP, JA, Trade binder, 1 copy");

    // And the same facts drawn, joined with the app's middot rather than with commas.
    expect(screen.getByText("Nonfoil · NM · Collection · 1 copy")).toBeInTheDocument();
    expect(screen.getByText("Nonfoil · LP · JA · Trade binder · 1 copy")).toBeInTheDocument();
  });

  it("tells two copies apart that differ only by where they are filed", () => {
    draw({
      copies: [copy({ entryId: 4 }), copy({ entryId: 5, folderName: "Trade binder" })],
    });

    // Identical printing, finish, condition, language and quantity: without `folderName` these
    // two rows would be one sentence written twice, and a picker whose rows read the same is a
    // picker no answer can be given to.
    expect(
      screen.getByRole("checkbox", { name: "Nonfoil, NM, Collection, 1 copy" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Nonfoil, NM, Trade binder, 1 copy" }),
    ).toBeInTheDocument();
  });

  it("starts every copy it can move ticked, and hands back their ids in the order they are drawn", async () => {
    const user = userEvent.setup();
    const { onConfirm } = draw();

    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();

    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("counts copies rather than rows on the button", async () => {
    const user = userEvent.setup();
    draw();

    // Three rows holding four copies: a button reading "Move 3 copies" would be counting the
    // wrong thing at the moment of the press.
    expect(confirm()).toHaveTextContent("Move 4 copies");

    await user.click(screen.getByRole("checkbox", { name: "Foil, NM, Trade binder, 2 copies" }));
    expect(confirm()).toHaveTextContent("Move 2 copies");
  });

  it("writes 'copy' in the singular", async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole("checkbox", { name: "Foil, NM, Trade binder, 2 copies" }));
    await user.click(screen.getByRole("checkbox", { name: "Nonfoil, NM, Collection, 1 copy" }));
    expect(confirm()).toHaveTextContent("Move 1 copy");
  });

  it("sends only the copies still ticked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = draw();

    await user.click(screen.getByRole("checkbox", { name: "Nonfoil, NM, Collection, 1 copy" }));
    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith([2, 3]);
  });

  it("puts a copy back after it has been unticked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = draw();
    const first = screen.getByRole("checkbox", { name: "Nonfoil, NM, Collection, 1 copy" });

    await user.click(first);
    expect(first).not.toBeChecked();
    await user.click(first);
    expect(first).toBeChecked();

    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("greys the confirm and writes nothing once every copy is unticked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = draw();

    for (const box of screen.getAllByRole("checkbox")) await user.click(box);

    expect(confirm()).toHaveAttribute("aria-disabled", "true");
    expect(confirm()).toHaveTextContent("Move 0 copies");
    // `aria-disabled` keeps the control in the tab order, so the press still arrives — the guard
    // is what makes the paint true rather than decorative.
    await user.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not grey the confirm while anything is ticked", () => {
    draw();
    expect(confirm()).not.toHaveAttribute("aria-disabled", "true");
  });

  /* -------------------------------------------------------------- a copy in a deck ------- */

  it("draws a blocked copy unticked, out of reach, and carrying its reason in its own name", () => {
    draw({
      copies: [
        copy({ entryId: 1 }),
        copy({ entryId: 9, folderName: "Burn", quantity: 2, blocked: IN_A_DECK }),
        copy({ entryId: 3, folderName: "Trade binder" }),
      ],
    });

    // The name carries the reason, because a greyed row whose name is only its label reads to a
    // screen reader — and to a query — as a row that is simply missing.
    const stuck = screen.getByRole("checkbox", {
      name: `Nonfoil, NM, Burn, 2 copies. ${IN_A_DECK}`,
    });
    expect(stuck).not.toBeChecked();
    expect(stuck).toBeDisabled();

    // And it is drawn beside the row too, for the reader who is looking rather than listening.
    expect(screen.getByText(IN_A_DECK)).toBeInTheDocument();
  });

  it("cannot be made to tick a blocked copy, and never sends its id", async () => {
    const user = userEvent.setup();
    const { onConfirm } = draw({
      copies: [copy({ entryId: 1 }), copy({ entryId: 9, blocked: IN_A_DECK })],
    });

    const stuck = screen.getByRole("checkbox", {
      name: `Nonfoil, NM, Collection, 1 copy. ${IN_A_DECK}`,
    });
    await user.click(stuck);
    expect(stuck).not.toBeChecked();

    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it("counts only the copies it can move", () => {
    draw({
      copies: [
        copy({ entryId: 1, quantity: 3 }),
        copy({ entryId: 9, quantity: 5, blocked: IN_A_DECK }),
      ],
    });

    expect(confirm()).toHaveTextContent("Move 3 copies");
  });

  it("offers no ticks at all when every copy is stuck, and says so", () => {
    draw({
      copies: [
        copy({ entryId: 9, folderName: "Burn", blocked: IN_A_DECK }),
        copy({ entryId: 10, folderName: "Storm", blocked: IN_A_DECK }),
      ],
    });

    // A column of ticks nobody can move is furniture that reads as a broken picker, so there is
    // no column — and no affirmative to press either.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    expect(screen.getByText("None of these copies can be moved.")).toBeInTheDocument();

    // The rows stay: which copies are out of reach, and why, is the whole of what this branch has
    // to say. The reason is read plainly here, because no accessible name is carrying it.
    expect(screen.getByText("Nonfoil · NM · Burn · 1 copy")).toBeInTheDocument();
    expect(screen.getByText("Nonfoil · NM · Storm · 1 copy")).toBeInTheDocument();
    expect(screen.getAllByText(IN_A_DECK)).toHaveLength(2);
  });

  it("still offers the way out when every copy is stuck", async () => {
    const user = userEvent.setup();
    const { onCancel } = draw({ copies: [copy({ entryId: 9, blocked: IN_A_DECK })] });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /* ------------------------------------------------------------------- the way out ------- */

  it("cancels on a press, and writes nothing", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = draw();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("puts the caret in the question rather than on either answer", () => {
    draw();

    // On the box, not on a button in it: the reader has not decided yet, and a stray Enter must
    // not decide for them. `focus()` on a node with no `tabIndex` is a silent no-op, so this is
    // also the assertion that the attribute is there.
    expect(screen.getByRole("group")).toHaveFocus();
  });

  it("leaves Escape to whatever opened it", async () => {
    const { onCancel } = draw();

    // The app's Escape ladder is a handshake between *registered* layers, one press per rung —
    // so a listener in here would be an unregistered rung closing a surface it did not open.
    // A synthetic event cannot prove an ordering, but it can prove an absence, which is all this
    // asks: nothing consumed the press and nothing acted on it.
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(press);

    expect(press.defaultPrevented).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
