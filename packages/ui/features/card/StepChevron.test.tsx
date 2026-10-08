import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { CardWalkStop } from "@/lib/store";
import { StepChevron } from "./StepChevron";

/** A plain stop — no deck row, which is what every surface but the deck publishes. */
const stub: CardWalkStop = {
  cardId: "card-1",
  oracleId: "oracle-1",
  name: "Lightning Bolt",
  deck: null,
};

/**
 * **The plan for this extraction asked for `expect(container).toBeEmptyDOMElement()` here, and
 * this component does not do that — deliberately, and it says so in its own doc.** A null stop
 * draws the chevron `disabled`, because "both chevrons are drawn whenever either is" is the
 * behaviour the control was written for: the pair is positioned against the panel's edges, so a
 * chevron that came and went would mean the *first* step of a walk is the moment a second control
 * appears under the reader's pointer, exactly where they are pointing.
 *
 * So this pins what the component really does rather than the contract that was assumed of it.
 * **Hiding the chevrons is the host's job and there is already a host doing it**:
 * `AllPrintingsDialog` passes `flanks: undefined` when the walk holds no place for the open card
 * (`at === -1`), which is a decision about the *pair* and the only place the pair exists. A
 * consumer that wants no chevrons omits them the same way; it must not get there by teaching one
 * chevron to vanish, which would take the greyed end of a walk with it.
 */
it("greys the chevron at the end of the walk rather than removing it", () => {
  render(<StepChevron direction="next" listLabel="Search results" stop={null} onStep={vi.fn()} />);

  expect(screen.getByRole("button", { name: "Next card in Search results" })).toBeDisabled();
});

it("names the list it walks, so the two chevrons are told apart", () => {
  render(
    <StepChevron direction="previous" listLabel="Search results" stop={stub} onStep={vi.fn()} />,
  );

  expect(screen.getByRole("button", { name: /previous.*search results/i })).toBeInTheDocument();
});

/**
 * The name carries the card the press *lands on*, and the press hands that same stop back — which
 * is the whole of what a consumer wires. A chevron that named one card and stepped to another
 * would be right on screen and wrong in the hand.
 */
it("steps to the stop it named", async () => {
  const onStep = vi.fn();
  render(
    <StepChevron direction="next" listLabel="your collection" stop={stub} onStep={onStep} />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Next card in your collection, Lightning Bolt" }),
  );
  expect(onStep).toHaveBeenCalledExactlyOnceWith(stub);
});
