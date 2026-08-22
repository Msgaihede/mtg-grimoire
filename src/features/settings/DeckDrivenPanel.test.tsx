import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { useDeckDrivenCollection } from "@/lib/useDeckDrivenCollection";
import { DeckDrivenPanel } from "./DeckDrivenPanel";

type DeckDriven = ReturnType<typeof useDeckDrivenCollection>;

function state(over: Partial<DeckDriven> = {}): DeckDriven {
  return { deckDriven: false, setDeckDriven: vi.fn(), error: null, ...over };
}

const panel = () => screen.getByRole("region", { name: "Deck driven collection" });

describe("DeckDrivenPanel", () => {
  /**
   * This panel is the only place the setting is discoverable, so the region's *name* is part of
   * the contract exactly as `HiddenTagsPanel`'s is — it is what a reader who has heard the
   * collection can be driven by their decks scans the page for.
   */
  it("is a named region a reader can find the setting in", () => {
    render(<DeckDrivenPanel deckDriven={state()} />);

    expect(panel()).toBeInTheDocument();
  });

  /**
   * A `role="switch"` whose name ends in the word printed on it. **`aria-labelledby` of two ids
   * rather than an `aria-label`**, which is `TheorySwitch`'s pattern and the app's only other
   * real switch: a label would replace the visible "Disabled" with a string that does not
   * contain it, and a name that omits the visible text is the WCAG 2.5.3 failure this shape
   * exists to avoid. So the assertion is deliberately on the *composed* name and not on the
   * heading alone.
   */
  it("is a switch that says which state it is in", () => {
    render(<DeckDrivenPanel deckDriven={state()} />);

    const sw = screen.getByRole("switch", { name: /deck driven collection.*disabled/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent("Disabled");
  });

  /** The same pairing from the other side — the word on the control moves with the state. */
  it("says so when it is on", () => {
    render(<DeckDrivenPanel deckDriven={state({ deckDriven: true })} />);

    const sw = screen.getByRole("switch", { name: /deck driven collection.*enabled/i });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).toHaveTextContent("Enabled");
  });

  /** A press asks for the other state. The panel holds nothing of its own — the hook owns the
   *  optimistic write, the rollback and the sentence, and this control only asks. */
  it("asks for the other state when pressed", async () => {
    const user = userEvent.setup();
    const s = state();
    render(<DeckDrivenPanel deckDriven={s} />);

    await user.click(screen.getByRole("switch"));

    expect(s.setDeckDriven).toHaveBeenCalledExactlyOnceWith(true);
  });

  /** And back, which is the half that has to work for the switch to be as safe as the copy
   *  says it is: a reader who tries this must be able to put it back with one press. */
  it("asks to be turned off again", async () => {
    const user = userEvent.setup();
    const s = state({ deckDriven: true });
    render(<DeckDrivenPanel deckDriven={s} />);

    await user.click(screen.getByRole("switch"));

    expect(s.setDeckDriven).toHaveBeenCalledExactlyOnceWith(false);
  });

  /**
   * The copy is the feature's whole explanation and it has three jobs, none of them decorative:
   * what the collection *becomes*, what it leaves out and why, and that nothing is deleted. The
   * third is the one that makes the switch safe to press — a reader who suspects this might
   * throw their collection away never finds out that it does not.
   */
  it("explains what the setting does before it is touched", () => {
    render(<DeckDrivenPanel deckDriven={state()} />);

    expect(screen.getByText(/sum of the cards in your decks/i)).toBeInTheDocument();
    expect(panel()).toHaveTextContent(/sideboards/i);
    expect(panel()).toHaveTextContent(/Theory/);
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
  });

  /** Said while the switch is off, not only once it is on. The explanation is what a reader
   *  reads *to decide*, so it cannot be the reward for having already decided. */
  it("says the same three things whichever way the switch is set", () => {
    const { rerender } = render(<DeckDrivenPanel deckDriven={state()} />);
    const off = panel().textContent;

    rerender(<DeckDrivenPanel deckDriven={state({ deckDriven: true })} />);

    expect(panel().textContent).toBe(off?.replace("Disabled", "Enabled"));
  });

  /**
   * The refusal. `useDeckDrivenCollection` rolls its optimistic write back — unlike the rail's
   * twin — so a refused press leaves the switch reading exactly as it did, and this sentence is
   * the only thing between that and a press that appeared to do nothing.
   */
  it("says so when the write is refused", () => {
    render(<DeckDrivenPanel deckDriven={state({ error: "The database is busy." })} />);

    expect(within(panel()).getByRole("alert")).toHaveTextContent("The database is busy.");
  });

  /** Nothing to say is nothing drawn — `PanelAlert` renders no element at all for a `null`. */
  it("is quiet when there is nothing to report", () => {
    render(<DeckDrivenPanel deckDriven={state()} />);

    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
  });
});
