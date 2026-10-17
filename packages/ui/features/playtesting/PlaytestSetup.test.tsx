import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckSupport } from "@/lib/ipc";

const playtestSupport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { playtestSupport },
}));

import { PlaytestSetup, type SetupDeck } from "./PlaytestSetup";

const DECKS: SetupDeck[] = [
  { id: 1, name: "Simic Tempo", formatName: "Modern", archived: false, theoryEnabled: true },
  { id: 2, name: "Boros Aggro", formatName: "Modern", archived: false, theoryEnabled: false },
  { id: 3, name: "Old Pauper", formatName: "Pauper", archived: true, theoryEnabled: false },
];

const WHOLE: DeckSupport = { cards: 31, unsupported: [] };
const PARTLY: DeckSupport = {
  cards: 24,
  unsupported: [
    {
      cardId: "moon",
      name: "Moonlit Bard",
      quantity: 3,
      commander: false,
      gaps: ["Trigger:Whenever the moon is full", "Effect:unrecognized_clause_head"],
    },
  ],
};

beforeEach(() => {
  // Simic Tempo is played in part, Boros Aggro whole.
  playtestSupport
    .mockReset()
    .mockImplementation((deckId: number) => Promise.resolve(deckId === 1 ? PARTLY : WHOLE));
});

function setup(decks = DECKS) {
  const onStart = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlaytestSetup decks={decks} onStart={onStart} />
    </QueryClientProvider>,
  );
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

  // The goldfish is no deck and plays no skill: only the reader's deck is asked for.
  it("plays the goldfish with the reader's deck alone, and asks for nothing else", async () => {
    const { onStart } = setup();
    const table = screen.getByRole("group", { name: "Table" });
    expect(
      within(table)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Goldfish", "1 opponent", "3 opponents"]);
    await userEvent.click(within(table).getByRole("button", { name: "Goldfish" }));
    expect(screen.queryByRole("button", { name: "Opponent’s deck" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Opponent’s skill" })).not.toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Pick your deck to start.")).toBeInTheDocument();
    await pickDeck("Your deck", "Simic Tempo");
    expect(start).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledWith({ deckId: 1, variant: "theory", opponents: [] });
  });

  // The picks outlive the page (`viewMemory`): the goldfish table among them, and the opponent
  // seats it hid come back as they were.
  it("remembers the goldfish table, and the seats it hid, for the next visit", async () => {
    setup();
    await pickDeck("Your deck", "Boros Aggro");
    await pickDeck("Opponent’s deck", "Simic Tempo");
    await userEvent.click(screen.getByRole("button", { name: "Goldfish" }));
    cleanup();
    const { onStart } = setup();
    expect(screen.getByRole("button", { name: "Goldfish" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenLastCalledWith({ deckId: 2, variant: "live", opponents: [] });
    await userEvent.click(screen.getByRole("button", { name: "1 opponent" }));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenLastCalledWith({
      deckId: 2,
      variant: "live",
      opponents: [{ deckId: 1, variant: "theory" }],
      difficulty: "medium",
    });
  });

  it("says under a seat what the rules engine plays of the deck, and names the cards it does not", async () => {
    setup();
    await pickDeck("Opponent’s deck", "Boros Aggro");
    expect(await screen.findByText("The rules engine plays all 31 cards.")).toBeInTheDocument();
    await pickDeck("Your deck", "Simic Tempo");
    expect(
      await screen.findByText(
        "The rules engine plays 23 of 24 cards in full; 1 card is played only in part.",
      ),
    ).toBeInTheDocument();
    // Simic Tempo is dealt from its plan first, so its plan is the list asked about.
    expect(playtestSupport).toHaveBeenCalledWith(1, "theory");
    await userEvent.click(screen.getByRole("button", { name: "Show the card" }));
    const list = screen.getByRole("list", { name: "Cards the rules engine plays only in part" });
    expect(within(list).getByText("Moonlit Bard")).toBeInTheDocument();
    expect(
      within(list).getByText(
        "Trigger: Whenever the moon is full · Effect: unrecognized clause head",
      ),
    ).toBeInTheDocument();
    // The other list is a question of its own.
    await userEvent.click(
      within(screen.getByRole("group", { name: "Your deck: list" })).getByRole("button", {
        name: "Actual",
      }),
    );
    expect(playtestSupport).toHaveBeenCalledWith(1, "live");
  });

  it("asks about the decks in the lists one at a time, a seat's deck before them", async () => {
    const answers: ((s: DeckSupport) => void)[] = [];
    playtestSupport.mockImplementation(
      () => new Promise<DeckSupport>((resolve) => answers.push(resolve)),
    );
    setup();
    await waitFor(() => expect(playtestSupport).toHaveBeenCalledTimes(1));
    expect(playtestSupport).toHaveBeenLastCalledWith(1, "theory");
    // A seat's question does not wait for the sweep.
    await pickDeck("Opponent’s deck", "Boros Aggro");
    await waitFor(() => expect(playtestSupport).toHaveBeenCalledTimes(2));
    expect(playtestSupport).toHaveBeenLastCalledWith(2, "live");
    answers[0](PARTLY);
    answers[1](WHOLE);
    expect(await screen.findByText("The rules engine plays all 31 cards.")).toBeInTheDocument();
    // Both decks answered: nothing else is asked, and nothing twice.
    expect(playtestSupport).toHaveBeenCalledTimes(2);
  });

  it("says so when the cards could not be checked", async () => {
    playtestSupport.mockRejectedValue("The rules engine could not start.");
    setup();
    await pickDeck("Your deck", "Boros Aggro");
    expect(
      await screen.findByText("The cards could not be checked against the rules engine."),
    ).toBeInTheDocument();
  });

  it("asks for a deck when there is none", () => {
    setup([]);
    expect(screen.getByText(/needs a deck to play/)).toBeInTheDocument();
  });
});
