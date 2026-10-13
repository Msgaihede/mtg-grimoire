import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DiscardDialog } from "./DiscardDialog";
import { discardView } from "./fixtures";

function draw(over = 2) {
  const view = discardView(over);
  const onAct = vi.fn();
  const onClose = vi.fn();
  render(<DiscardDialog view={view} onAct={onAct} onClose={onClose} />);
  const hand = () => within(screen.getByRole("group", { name: "Your hand" }));
  return { view, onAct, onClose, hand };
}

describe("DiscardDialog", () => {
  it("offers the whole hand and says how many cards have to go", () => {
    const { view, hand } = draw(2);
    expect(screen.getByRole("dialog", { name: "Discard to hand size" })).toBeInTheDocument();
    expect(hand().getAllByRole("button")).toHaveLength(view.hand.length);
    expect(
      screen.getByText("9 cards in hand · pick 2 cards to discard before the turn ends"),
    ).toBeInTheDocument();
  });

  it("holds the discard until exactly the owed cards are picked, then sends their ids", async () => {
    const { view, hand, onAct } = draw(2);
    const discard = screen.getByRole("button", { name: "Discard 2 and end the turn" });
    // The first and the third: never simply the newest cards of the hand.
    const [first, , third] = view.hand;

    expect(discard).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(discard);
    expect(onAct).not.toHaveBeenCalled();

    await userEvent.click(hand().getByRole("button", { name: first.name }));
    expect(discard).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("1 of 2 picked")).toBeInTheDocument();

    await userEvent.click(hand().getByRole("button", { name: third.name }));
    expect(discard).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(discard);
    expect(onAct).toHaveBeenCalledExactlyOnceWith({ type: "discard", ids: [first.id, third.id] });
  });

  it("un-picks a card clicked again, and a pick past the count drops the oldest", async () => {
    const { view, hand } = draw(1);
    const [first, second] = view.hand;

    await userEvent.click(hand().getByRole("button", { name: first.name }));
    const picked = hand().getByRole("button", { name: `${first.name}, to be discarded` });
    expect(picked).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(hand().getByRole("button", { name: second.name }));
    expect(hand().getByRole("button", { name: first.name })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(hand().getByRole("button", { name: `${second.name}, to be discarded` }));
    expect(screen.getByText("0 of 1 picked")).toBeInTheDocument();
  });

  it("closes to look at the board without discarding anything", async () => {
    const { onAct, onClose } = draw(2);
    await userEvent.click(screen.getByRole("button", { name: "Close and look at the board" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAct).not.toHaveBeenCalled();
  });
});
