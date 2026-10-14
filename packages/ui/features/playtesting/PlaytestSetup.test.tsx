import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlaytestSetup, type SetupDeck } from "./PlaytestSetup";

const DECKS: SetupDeck[] = [
  { id: 1, name: "Simic Tempo", formatName: "Modern", archived: false, theoryEnabled: true },
  { id: 2, name: "Boros Aggro", formatName: "Modern", archived: false, theoryEnabled: false },
  { id: 3, name: "Old Pauper", formatName: "Pauper", archived: true, theoryEnabled: false },
];

function setup(decks = DECKS) {
  const onStart = vi.fn();
  render(<PlaytestSetup decks={decks} onStart={onStart} />);
  return { onStart };
}

async function pickDeck(seat: string, name: string) {
  await userEvent.click(screen.getByRole("button", { name: seat }));
  // The row's name carries its format after the deck's.
  await userEvent.click(screen.getByRole("option", { name: new RegExp(`^${name}`) }));
}

describe("PlaytestSetup", () => {
  it("starts nothing until both decks are picked", async () => {
    const { onStart } = setup();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
    await pickDeck("Your deck", "Simic Tempo");
    expect(start).toHaveAttribute("aria-disabled", "true");
  });

  it("leaves archived decks out", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Your deck" }));
    expect(screen.queryByRole("option", { name: /Old Pauper/ })).not.toBeInTheDocument();
  });

  it("hands over the decks, their lists and the opponent's skill", async () => {
    const { onStart } = setup();
    await pickDeck("Your deck", "Simic Tempo");
    // A deck that keeps a plan offers its two lists, Theory picked first.
    const list = screen.getByRole("group", { name: "Your deck: list" });
    expect(within(list).getByRole("button", { name: "Theory" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(list).getByRole("button", { name: "Actual" }));
    await pickDeck("Opponent’s deck", "Boros Aggro");
    expect(screen.queryByRole("group", { name: "Opponent’s deck: list" })).not.toBeInTheDocument();
    const skill = screen.getByRole("group", { name: "Opponent’s skill" });
    expect(within(skill).getByRole("button", { name: "Medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(skill).getByRole("button", { name: "Very hard" }));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledWith({
      deckId: 1,
      variant: "live",
      opponents: [{ deckId: 2, variant: "live" }],
      difficulty: "veryHard",
    });
  });

  it("allows a mirror match", async () => {
    const { onStart } = setup();
    await pickDeck("Your deck", "Boros Aggro");
    await pickDeck("Opponent’s deck", "Boros Aggro");
    expect(screen.getByText("A mirror match.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ deckId: 2, opponents: [{ deckId: 2, variant: "live" }] }),
    );
  });

  it("seats three opponents at a four-player table, and starts only once each has a deck", async () => {
    const { onStart } = setup();
    const table = screen.getByRole("group", { name: "Table" });
    expect(within(table).getByRole("button", { name: "1 opponent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(table).getByRole("button", { name: "3 opponents" }));
    await pickDeck("Your deck", "Simic Tempo");
    await pickDeck("Opponent 1’s deck", "Boros Aggro");
    await pickDeck("Opponent 2’s deck", "Boros Aggro");
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Pick all four decks to start.")).toBeInTheDocument();
    await pickDeck("Opponent 3’s deck", "Simic Tempo");
    // Opponent 3's deck keeps a plan: Theory is its first list.
    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledWith({
      deckId: 1,
      variant: "theory",
      opponents: [
        { deckId: 2, variant: "live" },
        { deckId: 2, variant: "live" },
        { deckId: 1, variant: "theory" },
      ],
      difficulty: "medium",
    });
    // Back to a duel: one opponent, the first seat's pick.
    await userEvent.click(within(table).getByRole("button", { name: "1 opponent" }));
    expect(screen.queryByRole("button", { name: "Opponent 2’s deck" })).not.toBeInTheDocument();
    await userEvent.click(start);
    expect(onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ opponents: [{ deckId: 2, variant: "live" }] }),
    );
  });

  it("asks for a deck when there is none", () => {
    setup([]);
    expect(screen.getByText(/needs a deck to play/)).toBeInTheDocument();
  });
});
