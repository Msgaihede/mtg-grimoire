import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckFolder, DeckRow, DeckSupport } from "@/lib/ipc";

const playtestSupport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { playtestSupport },
}));

import { PlaytestSetup } from "./PlaytestSetup";

function deck(over: Partial<DeckRow> & Pick<DeckRow, "id" | "name">): DeckRow {
  return {
    gameKey: "any",
    formatKey: "modern",
    formatName: "Modern",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 60,
    updatedAt: 0,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    managedWishlist: "off",
    managedWishlistTokens: false,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    tokensOpen: false,
    tokenMode: "managed",
    tokenRailIndex: -1,
    statsOpen: true,
    curveCreatures: false,
    todosOpen: false,
    syncUid: null,
    defaultCategoryId: 0,
    bracket: 0,
    tags: [],
    ...over,
  };
}

const DECKS: DeckRow[] = [
  deck({ id: 1, name: "Simic Tempo", theoryEnabled: true }),
  deck({ id: 2, name: "Boros Aggro" }),
  deck({ id: 3, name: "Old Pauper", formatKey: "pauper", formatName: "Pauper", archived: true }),
  deck({
    id: 4,
    name: "Kenrith Pod",
    formatKey: "commander",
    formatName: "Commander",
    folderId: 20,
  }),
];

const FOLDERS: DeckFolder[] = [
  { id: 10, parentId: null, name: "Commander", sortOrder: 0 },
  { id: 20, parentId: 10, name: "Casual pod", sortOrder: 0 },
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
const PARTLY_SENTENCE =
  "The rules engine plays 23 of 24 cards in full; 1 card is played only in part.";

beforeEach(() => {
  // Simic Tempo is played in part, every other deck whole.
  playtestSupport
    .mockReset()
    .mockImplementation((deckId: number) => Promise.resolve(deckId === 1 ? PARTLY : WHOLE));
});

function setup(decks = DECKS, folders = FOLDERS) {
  const onStart = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlaytestSetup decks={decks} folders={folders} onStart={onStart} />
    </QueryClientProvider>,
  );
  return { onStart };
}

/** A deck's tile on the wall — named for its deck, where a seat is named for the seat. */
const tile = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const seat = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}:`) });
const start = () => screen.getByRole("button", { name: "Start game" });
/** The line over the wall that names the seat a pick goes to. */
const pickingFor = () => screen.getByText(/^Picking for/).textContent;

async function seatDeck(title: string, name: string) {
  await userEvent.click(seat(title));
  await userEvent.click(tile(name));
}

describe("PlaytestSetup", () => {
  it("starts nothing until every seat has a deck", async () => {
    const { onStart } = setup();
    expect(start()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(start());
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText("Pick your deck to start.")).toBeInTheDocument();
    await userEvent.click(tile("Simic Tempo"));
    expect(start()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Pick a deck for Opponent to start.")).toBeInTheDocument();
  });

  it("leaves archived decks off the wall", () => {
    setup();
    expect(screen.queryByRole("button", { name: /^Old Pauper/ })).not.toBeInTheDocument();
  });

  // A pick fills the seat being picked for, and the next empty seat is up.
  it("seats decks round the table, and says whose seat is being picked for", async () => {
    setup();
    expect(seat("You")).toHaveAttribute("aria-pressed", "true");
    expect(pickingFor()).toBe("Picking for you");
    await userEvent.click(tile("Simic Tempo"));
    expect(seat("You")).toHaveAccessibleName("You: Simic Tempo");
    expect(seat("Opponent")).toHaveAttribute("aria-pressed", "true");
    expect(pickingFor()).toBe("Picking for Opponent");
    await userEvent.click(tile("Boros Aggro"));
    expect(seat("Opponent")).toHaveAccessibleName("Opponent: Boros Aggro");
    // Pressing a seated seat makes it the one picked for again, and a pick swaps its deck.
    await userEvent.click(seat("You"));
    expect(seat("You")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(tile("Boros Aggro"));
    expect(seat("You")).toHaveAccessibleName("You: Boros Aggro");
  });

  it("empties a seat with its ✕, and picks for it next", async () => {
    setup();
    await userEvent.click(tile("Simic Tempo"));
    await userEvent.click(tile("Boros Aggro"));
    await userEvent.click(screen.getByRole("button", { name: "Empty the seat: You" }));
    expect(seat("You")).toHaveAccessibleName("You: pick a deck");
    expect(seat("You")).toHaveAttribute("aria-pressed", "true");
    expect(start()).toHaveAttribute("aria-disabled", "true");
  });

  it("hands over the decks, their lists and the AI's skill", async () => {
    const { onStart } = setup();
    await userEvent.click(tile("Simic Tempo"));
    // A deck that keeps a plan seats with its two lists, Theory picked first.
    const list = screen.getByRole("group", { name: "You: list" });
    expect(within(list).getByRole("button", { name: "Theory" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(list).getByRole("button", { name: "Actual" }));
    await userEvent.click(tile("Boros Aggro"));
    expect(screen.queryByRole("group", { name: "Opponent: list" })).not.toBeInTheDocument();
    const skill = screen.getByRole("group", { name: "AI skill" });
    expect(within(skill).getByRole("button", { name: "Medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(skill).getByRole("button", { name: "Very hard" }));
    await userEvent.click(start());
    expect(onStart).toHaveBeenCalledWith({
      deckId: 1,
      variant: "live",
      opponents: [{ deckId: 2, variant: "live" }],
      difficulty: "veryHard",
    });
  });

  it("allows a mirror match", async () => {
    const { onStart } = setup();
    await userEvent.click(tile("Boros Aggro"));
    await userEvent.click(tile("Boros Aggro"));
    expect(screen.getByText("A mirror match.")).toBeInTheDocument();
    await userEvent.click(start());
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ deckId: 2, opponents: [{ deckId: 2, variant: "live" }] }),
    );
  });

  it("seats three opponents at a four-player table, and starts only once each has a deck", async () => {
    const { onStart } = setup();
    const modes = screen.getByRole("group", { name: "Gamemode" });
    expect(within(modes).getByRole("button", { name: /^Duel/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(modes).getByRole("button", { name: /^Four-player/ }));
    await userEvent.click(tile("Simic Tempo"));
    await userEvent.click(tile("Boros Aggro"));
    await userEvent.click(tile("Boros Aggro"));
    expect(start()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Pick a deck for Opponent 3 to start.")).toBeInTheDocument();
    await userEvent.click(tile("Simic Tempo"));
    // Opponent 3's deck keeps a plan: Theory is its first list.
    await userEvent.click(start());
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
    await userEvent.click(within(modes).getByRole("button", { name: /^Duel/ }));
    expect(screen.queryByRole("button", { name: /^Opponent 2:/ })).not.toBeInTheDocument();
    await userEvent.click(start());
    expect(onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ opponents: [{ deckId: 2, variant: "live" }] }),
    );
  });

  // The goldfish is no deck and plays no skill: only the reader's deck is asked for.
  it("plays the goldfish with the reader's deck alone, and asks for nothing else", async () => {
    const { onStart } = setup();
    const modes = screen.getByRole("group", { name: "Gamemode" });
    expect(within(modes).getAllByRole("button")).toHaveLength(3);
    await userEvent.click(within(modes).getByRole("button", { name: /^Goldfish/ }));
    expect(screen.queryByRole("button", { name: /^Opponent:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "AI skill" })).not.toBeInTheDocument();
    expect(start()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Pick your deck to start.")).toBeInTheDocument();
    await userEvent.click(tile("Simic Tempo"));
    expect(start()).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(start());
    expect(onStart).toHaveBeenCalledWith({ deckId: 1, variant: "theory", opponents: [] });
  });

  // The picks outlive the page (`viewMemory`): the goldfish among them, and the opponent seats it
  // hid come back as they were.
  it("remembers the goldfish, and the seats it hid, for the next visit", async () => {
    setup();
    await userEvent.click(tile("Boros Aggro"));
    await userEvent.click(tile("Simic Tempo"));
    await userEvent.click(screen.getByRole("button", { name: /^Goldfish/ }));
    cleanup();
    const { onStart } = setup();
    expect(screen.getByRole("button", { name: /^Goldfish/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(start());
    expect(onStart).toHaveBeenLastCalledWith({ deckId: 2, variant: "live", opponents: [] });
    await userEvent.click(screen.getByRole("button", { name: /^Duel/ }));
    await userEvent.click(start());
    expect(onStart).toHaveBeenLastCalledWith({
      deckId: 2,
      variant: "live",
      opponents: [{ deckId: 1, variant: "theory" }],
      difficulty: "medium",
    });
  });

  it("walks the deck folders as the Decks page draws them, and seats a deck from inside one", async () => {
    setup();
    const wall = screen.getByRole("list", { name: "Your decks" });
    // The top level: the one root folder, then the decks filed nowhere.
    expect(
      within(wall).getByRole("button", { name: "Commander folder, 1 deck" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Kenrith Pod/ })).not.toBeInTheDocument();
    await userEvent.click(within(wall).getByRole("button", { name: "Commander folder, 1 deck" }));
    expect(screen.getByRole("heading", { name: "Commander" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Casual pod folder, 1 deck" }));
    // The path back up, and the way out on the wall itself.
    const path = screen.getByRole("navigation", { name: "Folder path" });
    expect(
      within(path)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All decks", "Commander"]);
    await userEvent.click(tile("Kenrith Pod"));
    expect(seat("You")).toHaveAccessibleName("You: Kenrith Pod");
    await userEvent.click(within(path).getByRole("button", { name: "All decks" }));
    expect(tile("Boros Aggro")).toBeInTheDocument();
  });

  it("finds a deck by name wherever it is filed", async () => {
    setup();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Filter decks by name" }),
      "kenrith",
    );
    expect(screen.getByRole("heading", { name: "Every deck" })).toBeInTheDocument();
    expect(tile("Kenrith Pod")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Boros Aggro/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /folder,/ })).not.toBeInTheDocument();
  });

  it("marks under a seat what the rules engine plays of the deck, and names the cards it does not", async () => {
    setup();
    await seatDeck("Opponent", "Boros Aggro");
    expect(
      await screen.findByRole("img", { name: "The rules engine plays all 31 cards." }),
    ).toBeInTheDocument();
    await seatDeck("You", "Simic Tempo");
    // Simic Tempo is dealt from its plan first, so its plan is the list asked about.
    expect(playtestSupport).toHaveBeenCalledWith(1, "theory");
    const partly = await screen.findByRole("button", { name: PARTLY_SENTENCE });
    expect(partly).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(partly);
    const list = screen.getByRole("list", { name: "Cards the rules engine plays only in part" });
    expect(within(list).getByText("Moonlit Bard")).toBeInTheDocument();
    expect(
      within(list).getByText(
        "Trigger: Whenever the moon is full · Effect: unrecognized clause head",
      ),
    ).toBeInTheDocument();
    // The other list is a question of its own.
    await userEvent.click(
      within(screen.getByRole("group", { name: "You: list" })).getByRole("button", {
        name: "Actual",
      }),
    );
    expect(playtestSupport).toHaveBeenCalledWith(1, "live");
  });

  it("marks a deck the engine plays only in part on its tile", async () => {
    setup();
    const simic = tile("Simic Tempo").closest("li")!;
    expect(await within(simic).findByRole("img", { name: PARTLY_SENTENCE })).toBeInTheDocument();
  });

  it("asks about the decks on the wall one at a time, a seat's deck before them", async () => {
    const answers: ((s: DeckSupport) => void)[] = [];
    playtestSupport.mockImplementation(
      () => new Promise<DeckSupport>((resolve) => answers.push(resolve)),
    );
    setup([DECKS[0], DECKS[1]], []);
    await waitFor(() => expect(playtestSupport).toHaveBeenCalledTimes(1));
    expect(playtestSupport).toHaveBeenLastCalledWith(1, "theory");
    // A seat's question does not wait for the sweep.
    await seatDeck("Opponent", "Boros Aggro");
    await waitFor(() => expect(playtestSupport).toHaveBeenCalledTimes(2));
    expect(playtestSupport).toHaveBeenLastCalledWith(2, "live");
    answers[0](PARTLY);
    answers[1](WHOLE);
    expect(
      await screen.findByRole("img", { name: "The rules engine plays all 31 cards." }),
    ).toBeInTheDocument();
    // Both decks answered: nothing else is asked, and nothing twice.
    expect(playtestSupport).toHaveBeenCalledTimes(2);
  });

  it("says so when the cards could not be checked", async () => {
    playtestSupport.mockRejectedValue("The rules engine could not start.");
    setup();
    await userEvent.click(tile("Boros Aggro"));
    expect(
      await screen.findByRole("img", {
        name: "The cards could not be checked against the rules engine.",
      }),
    ).toBeInTheDocument();
  });

  it("asks for a deck when there is none", () => {
    setup([]);
    expect(screen.getByText(/needs a deck to play/)).toBeInTheDocument();
  });
});
