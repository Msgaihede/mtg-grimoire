import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_WORD } from "./ConfirmDialog";
import { DangerZonePanel } from "./DangerZonePanel";
import type { DangerZone } from "./useDataReset";

/** Mocked rather than driven through the real hook's `QueryClient`, per this task's own
 *  instruction — a sibling is still wiring the Storybook fake's support for this setting, and
 *  every other test in this file renders with no provider at all. */
const deckDriven = { value: false };
vi.mock("@/lib/useDeckDrivenCollection", async (original) => ({
  ...(await original<typeof import("@/lib/useDeckDrivenCollection")>()),
  useDeckDrivenCollection: () => ({
    deckDriven: deckDriven.value,
    setDeckDriven: vi.fn(),
    error: null,
  }),
}));

const action = (over: Partial<DangerZone["collection"]> = {}) => ({
  run: vi.fn(),
  pending: false,
  ...over,
});

function danger(over: Partial<DangerZone> = {}): DangerZone {
  return {
    collection: action(),
    wishlist: action(),
    decks: action(),
    status: null,
    ...over,
  };
}

const panel = () => screen.getByRole("region", { name: "Clear data" });
const dialog = () => screen.getByRole("dialog");

/** Open one row's question and type the word, which is every test's first two steps. */
async function arm(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(within(panel()).getByRole("button", { name: label }));
  await user.type(screen.getByRole("textbox"), CONFIRM_WORD);
}

describe("DangerZonePanel", () => {
  beforeEach(() => {
    deckDriven.value = false;
  });

  it("offers the three clears, each saying what it takes", () => {
    render(<DangerZonePanel danger={danger()} />);

    const rows = within(panel()).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Every card you own");
    expect(rows[1]).toHaveTextContent("Every card you are looking for");
    expect(rows[2]).toHaveTextContent("Every deck and folder");
  });

  /**
   * A button press asks the question and does **not** run the clear. The assertion that
   * `run` was not called is the one worth having: it is the difference between a confirmation
   * and a label.
   */
  it("asks before it clears", async () => {
    const user = userEvent.setup();
    const state = danger();
    render(<DangerZonePanel danger={state} />);

    await user.click(within(panel()).getByRole("button", { name: "Clear collection" }));

    expect(dialog()).toHaveTextContent("This cannot be undone.");
    expect(state.collection.run).not.toHaveBeenCalled();
  });

  /**
   * The consequence a reader did not ask for has to be in the dialog rather than only in the
   * schema: emptying the collection unmarks every card in every deck.
   */
  it("warns that clearing the collection un-owns the cards in every deck", async () => {
    const user = userEvent.setup();
    render(<DangerZonePanel danger={danger()} />);

    await user.click(within(panel()).getByRole("button", { name: "Clear collection" }));

    expect(dialog()).toHaveTextContent("Your decks are kept");
    expect(dialog()).toHaveTextContent("stops being marked as owned");
  });

  /** The other one a reader guesses wrong: the folders go with the decks, not without them. */
  it("warns that clearing the decks takes the folders too", async () => {
    const user = userEvent.setup();
    render(<DangerZonePanel danger={danger()} />);

    await user.click(within(panel()).getByRole("button", { name: "Clear decks" }));

    expect(dialog()).toHaveTextContent("every deck and every folder");
    expect(dialog()).toHaveTextContent("Your collection and wishlist are kept");
  });

  it("runs the clear the reader confirmed, and only that one", async () => {
    const user = userEvent.setup();
    const state = danger();
    render(<DangerZonePanel danger={state} />);

    await arm(user, "Clear wishlist");
    await user.click(within(dialog()).getByRole("button", { name: "Clear wishlist" }));

    expect(state.wishlist.run).toHaveBeenCalledOnce();
    expect(state.collection.run).not.toHaveBeenCalled();
    expect(state.decks.run).not.toHaveBeenCalled();
  });

  /**
   * The half-typed word must not survive a cancel and turn up armed on the next question — the
   * shell's "closed is nothing mounted" is what makes that structural, and this is the test
   * that would catch it being replaced with a hidden panel.
   */
  it("throws the typed word away between questions", async () => {
    const user = userEvent.setup();
    const state = danger();
    render(<DangerZonePanel danger={state} />);

    await arm(user, "Clear collection");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await user.click(within(panel()).getByRole("button", { name: "Clear decks" }));

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(within(dialog()).getByRole("button", { name: "Clear decks" })).toBeDisabled();
    expect(state.collection.run).not.toHaveBeenCalled();
  });

  it("says what the last clear did, plainly rather than in the destructive red", () => {
    render(
      <DangerZonePanel
        danger={danger({ status: { tone: "plain", text: "Cleared 12 collection entries." } })}
      />,
    );

    const line = within(panel()).getByRole("alert");
    expect(line).toHaveTextContent("Cleared 12 collection entries.");
    expect(line).toHaveClass("text-text");
  });

  it("draws a refusal in the destructive red", () => {
    render(
      <DangerZonePanel
        danger={danger({ status: { tone: "problem", text: "The card database is busy." } })}
      />,
    );

    expect(within(panel()).getByRole("alert")).toHaveClass("text-destructive");
  });

  /** A clear in flight takes its own row's button out of reach and leaves its siblings alone. */
  it("goes inert on the row that is working", () => {
    render(<DangerZonePanel danger={danger({ decks: action({ pending: true }) })} />);

    expect(within(panel()).getByRole("button", { name: "Clear decks" })).toBeDisabled();
    expect(within(panel()).getByRole("button", { name: "Clear collection" })).toBeEnabled();
  });

  /**
   * The collection row's own sentence gains one clause while the collection is deck-driven —
   * said where the button already is, with no dialog to open. The button stays enabled: the
   * backend deliberately allows this one write while the setting is on, since clearing the
   * hidden hand-built rows is a legitimate thing to want.
   */
  it("says the collection it clears is currently hidden, and keeps the button enabled", () => {
    deckDriven.value = true;
    render(<DangerZonePanel danger={danger()} />);

    expect(screen.getByText(/currently hidden/i)).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Clear collection" })).toBeEnabled();
  });
});
