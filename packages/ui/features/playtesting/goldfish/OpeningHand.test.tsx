import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GoldfishView, MulliganView } from "@/lib/ipc";
import { gameCard, openingHandView } from "./fixtures";
import { OpeningHand } from "./OpeningHand";

/** The fixture's hand with the mulligan state a test names. */
function viewWith(mulligan: Partial<MulliganView> = {}): GoldfishView {
  const view = openingHandView();
  return { ...view, mulligan: { ...view.mulligan!, ...mulligan } };
}

function draw(view: GoldfishView) {
  const onAct = vi.fn();
  const utils = render(<OpeningHand view={view} onAct={onAct} />);
  const hand = () => within(screen.getByRole("group", { name: "Opening hand" }));
  return { ...utils, onAct, hand };
}

describe("OpeningHand", () => {
  it("picks a card for the bottom, and a pick past the count drops the oldest", async () => {
    const view = viewWith({ mulligans: 2, bottom: 1, freeFirst: true });
    const { hand } = draw(view);
    const [first, second] = view.hand;

    await userEvent.click(hand().getByRole("button", { name: first.name }));
    expect(
      hand().getByRole("button", { name: `${first.name}, going to the bottom` }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("To the bottom")).toBeInTheDocument();

    await userEvent.click(hand().getByRole("button", { name: second.name }));
    expect(hand().getByRole("button", { name: first.name })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      hand().getByRole("button", { name: `${second.name}, going to the bottom` }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("To the bottom")).toHaveLength(1);
  });

  it("holds Keep until exactly the owed cards are picked, then sends their ids", async () => {
    const view = viewWith({ mulligans: 2, bottom: 1, freeFirst: true });
    const { hand, onAct } = draw(view);
    const keep = screen.getByRole("button", { name: "Put 1 on the bottom and keep 6" });

    expect(keep).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(keep);
    expect(onAct).not.toHaveBeenCalled();

    const sphinx = view.hand[5];
    await userEvent.click(hand().getByRole("button", { name: sphinx.name }));
    expect(keep).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(keep);
    expect(onAct).toHaveBeenCalledWith({ type: "keep", bottom: [sphinx.id] });
  });

  it("keeps seven with nothing to pick when no card is owed", async () => {
    const view = viewWith({ mulligans: 0, bottom: 0, freeFirst: true });
    const { hand, onAct } = draw(view);
    expect(screen.getByText("Keep these seven, or mulligan")).toBeInTheDocument();

    await userEvent.click(hand().getByRole("button", { name: view.hand[0].name }));
    expect(hand().getByRole("button", { name: view.hand[0].name })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Keep 7" }));
    expect(onAct).toHaveBeenCalledWith({ type: "keep", bottom: [] });
  });

  it("says how many cards the next mulligan keeps, with and without the free first one", async () => {
    const cases: [Partial<MulliganView>, string][] = [
      [{ mulligans: 0, bottom: 0, freeFirst: true }, "Mulligan to 7"],
      [{ mulligans: 1, bottom: 0, freeFirst: true }, "Mulligan to 6"],
      [{ mulligans: 2, bottom: 1, freeFirst: true }, "Mulligan to 5"],
      [{ mulligans: 0, bottom: 0, freeFirst: false }, "Mulligan to 6"],
      [{ mulligans: 1, bottom: 1, freeFirst: false }, "Mulligan to 5"],
    ];
    for (const [mulligan, label] of cases) {
      const { onAct, unmount } = draw(viewWith(mulligan));
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(onAct).toHaveBeenCalledWith({ type: "mulligan" });
      unmount();
    }
  });

  it("says whether the first mulligan is free", () => {
    const { unmount } = draw(viewWith({ mulligans: 0, bottom: 0, freeFirst: true }));
    expect(screen.getByText("Your first mulligan is free.")).toBeInTheDocument();
    unmount();

    draw(viewWith({ mulligans: 2, bottom: 1, freeFirst: true }));
    expect(screen.getByText("Your first mulligan was free.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Free first mulligan, Commander's multiplayer rule" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("puts down the picks when a mulligan deals a new hand", async () => {
    const view = viewWith({ mulligans: 2, bottom: 1, freeFirst: true });
    const { hand, rerender, onAct } = draw(view);
    await userEvent.click(hand().getByRole("button", { name: view.hand[0].name }));

    // The same names, new ids — the engine's answer to a mulligan that happened to redraw them.
    const redrawn: GoldfishView = {
      ...view,
      mulligan: { mulligans: 3, bottom: 2, freeFirst: true },
      hand: view.hand.map((c) => gameCard(c.name)),
    };
    rerender(<OpeningHand view={redrawn} onAct={onAct} />);
    expect(hand().queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Put 2 on the bottom and keep 5" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("counts the lands kept out of the cards kept", async () => {
    const view = viewWith({ mulligans: 2, bottom: 1, freeFirst: true });
    const { hand } = draw(view);
    const lands = view.hand.filter((c) => c.isLand).length;
    expect(screen.getByText("Lands kept").nextElementSibling).toHaveTextContent(`${lands}of 7`);

    const land = view.hand.find((c) => c.isLand)!;
    await userEvent.click(hand().getByRole("button", { name: land.name }));
    expect(screen.getByText("Lands kept").nextElementSibling).toHaveTextContent(`${lands - 1}of 6`);
    expect(screen.getByText("In the library").nextElementSibling).toHaveTextContent(
      `${view.libraryLands} landsof ${view.library}`,
    );
  });
});
