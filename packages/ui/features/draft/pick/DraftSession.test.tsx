import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, DraftView, WinstonView } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";
import { boxed, pointerDrag } from "@/test-drag";

const ipcMock = vi.hoisted(() => ({
  draftPick: vi.fn(),
  draftAutoPick: vi.fn(),
  draftWinston: vi.fn(),
  draftView: vi.fn(),
  draftEnd: vi.fn(),
  draftDeckCreate: vi.fn(),
  lobbyPick: vi.fn(),
  lobbyWinston: vi.fn(),
  lobbyLeave: vi.fn(),
  onDraftView: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: ipcMock,
}));
const openDraftDeck = vi.hoisted(() => vi.fn());
vi.mock("@/features/draft/navigation", () => ({ openDraftDeck }));

import type { DraftRole } from "../build/BuildPanel";
import { DraftSession } from "./DraftSession";

function card(name: string, over: Partial<DraftCard> = {}): DraftCard {
  return {
    instanceId: `${name}#0.0.0`,
    cardId: `id-${name}`,
    name,
    setCode: "tst",
    collectorNumber: "1",
    rarity: "common",
    colors: ["R"],
    cmc: 1,
    typeLine: "Instant",
    ...over,
  };
}

function view(over: Partial<DraftView> = {}): DraftView {
  return {
    mode: "quick",
    status: "drafting",
    label: "Test Set",
    seat: 0,
    packNumber: 0,
    packCount: 3,
    pickNumber: 0,
    packSize: 14,
    passLeft: true,
    pack: [card("Shock"), card("Opt", { colors: ["U"] })],
    waiting: false,
    pool: [],
    seats: Array.from({ length: 8 }, (_, i) => ({
      name: i === 0 ? "You" : `Bot ${i}`,
      bot: i > 0,
      connected: true,
      picked: false,
      poolCount: 0,
    })),
    packSets: ["TST", "TST", "TST"],
    minDeckSize: 40,
    podFormat: "booster",
    picksPerStep: 1,
    commanders: 0,
    stack: null,
    ...over,
  };
}

/** A Winston table on the reader's turn, looking at pile 1 (two cards). */
function stack(over: Partial<WinstonView> = {}): WinstonView {
  return {
    mainCount: 30,
    piles: [
      { count: 2, cards: [card("Shock"), card("Opt")], active: true },
      { count: 1, cards: [], active: false },
      { count: 3, cards: [], active: false },
    ],
    turnSeat: 0,
    yourTurn: true,
    activePile: 0,
    ...over,
  };
}

function winston(over: Partial<DraftView> = {}): DraftView {
  return view({
    mode: "winston",
    pack: [],
    stack: stack(),
    seats: [
      { name: "You", bot: false, connected: true, picked: false, poolCount: 0 },
      { name: "Bot 1", bot: true, connected: true, picked: false, poolCount: 0 },
    ],
    ...over,
  });
}

/** The `draft:view` push, as the suite fires it. */
let push: (v: DraftView) => void = () => {};

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.draftView.mockResolvedValue(null);
  ipcMock.onDraftView.mockImplementation((cb: (v: DraftView) => void) => {
    push = cb;
    return () => {};
  });
  openDraftDeck.mockReset();
});

function setup(initial: DraftView, role: DraftRole = "solo", draft: number | null = 42) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftSession draft={draft} role={role} initial={initial} onBack={vi.fn()} />
    </QueryClientProvider>,
  );
}

const pack = () => screen.getByRole("list", { name: "Pack" });

/** The box a card from the pack is let go over to pick it — the pool's drop target. */
const poolTarget = () => screen.getByRole("region", { name: "Your pool" }).parentElement!;

/**
 * A card carried from the pack onto the pool, as a real pointer gesture. Both ends are boxed
 * clear of each other: jsdom lays nothing out, and dnd-kit hit-tests by coordinate.
 */
async function dragToPool(name: string): Promise<void> {
  const tile = within(pack()).getByRole("button", { name });
  boxed(tile, 0, 100);
  boxed(poolTarget(), 300, 200);
  await act(() => pointerDrag(tile, poolTarget()));
}

describe("DraftSession", () => {
  it("draws the round, the pick and the pass", () => {
    setup(view({ packNumber: 1, pickNumber: 3 }));
    expect(screen.getByRole("heading", { name: "Pack 2 · Pick 4" })).toBeInTheDocument();
    expect(screen.getByText("4/14")).toBeInTheDocument();
    expect(screen.getByText("Passing left")).toBeInTheDocument();
    const rounds = within(screen.getByRole("list", { name: "Rounds" })).getAllByRole("listitem");
    expect(rounds.map((r) => r.textContent)).toEqual(["P1TST", "P2TST", "P3TST"]);
    expect(rounds[1]).toHaveAttribute("aria-current", "step");
  });

  it("picks a card dragged onto the pool, through draft_pick", async () => {
    const next = view({ pickNumber: 1, pack: [card("Opt")], pool: [card("Shock")] });
    ipcMock.draftPick.mockResolvedValue(next);
    setup(view());
    await dragToPool("Shock");
    expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
    expect(await screen.findByRole("heading", { name: "Pack 1 · Pick 2" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Mana value 1: 1 card" })).toBeInTheDocument();
  });

  it("chooses with a click and picks with the Pick button, never with a double-click", async () => {
    ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
    setup(view());
    const shock = within(pack()).getByRole("button", { name: "Shock" });
    await userEvent.dblClick(shock);
    expect(shock).toHaveAttribute("aria-pressed", "true");
    expect(ipcMock.draftPick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Pick Shock" }));
    expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
  });

  it("takes no drop while a pick is on its way", async () => {
    ipcMock.draftPick.mockReturnValue(new Promise(() => {}));
    setup(view());
    await dragToPool("Shock");
    expect(ipcMock.draftPick).toHaveBeenCalledOnce();
    await dragToPool("Opt");
    expect(ipcMock.draftPick).toHaveBeenCalledOnce();
  });

  it("walks the pack with the arrows and picks with Enter", async () => {
    ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
    setup(view());
    within(pack()).getByRole("button", { name: "Shock" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(pack()).getByRole("button", { name: "Shock" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Opt#0.0.0"]);
  });

  it("asks the bots for a pick, and says the host's refusal", async () => {
    ipcMock.draftAutoPick.mockRejectedValue("That draft is over.");
    setup(view());
    await userEvent.click(screen.getByRole("button", { name: "Pick for me" }));
    expect(ipcMock.draftAutoPick).toHaveBeenCalledWith(42);
    expect(await screen.findByRole("alert")).toHaveTextContent("That draft is over.");
  });

  it("waits for the table, then takes the pushed view of its own seat only", async () => {
    setup(view({ waiting: true, pack: [] }));
    expect(screen.getByText("Waiting for the table…")).toBeInTheDocument();
    act(() => push(view({ seat: 3, pickNumber: 1 })));
    expect(screen.getByText("Waiting for the table…")).toBeInTheDocument();
    act(() => push(view({ pickNumber: 1 })));
    expect(screen.getByRole("heading", { name: "Pack 1 · Pick 2" })).toBeInTheDocument();
  });

  it("sends a guest's pick to the host and waits for its push", async () => {
    ipcMock.lobbyPick.mockResolvedValue(undefined);
    setup(view({ mode: "pod" }), "guest", null);
    expect(screen.queryByRole("button", { name: "Pick for me" })).not.toBeInTheDocument();
    await dragToPool("Opt");
    expect(ipcMock.lobbyPick).toHaveBeenCalledExactlyOnceWith(["Opt#0.0.0"]);
    expect(await screen.findByText("Waiting for the table…")).toBeInTheDocument();
  });

  it("builds the pool into a deck, puts the draft away and opens the editor", async () => {
    const pool = [
      card("Shock"),
      card("Mountain", { typeLine: "Basic Land — Mountain", cmc: 0, colors: [] }),
    ];
    ipcMock.draftDeckCreate.mockResolvedValue({ id: 9, name: "Test Set Draft" });
    ipcMock.draftEnd.mockResolvedValue(undefined);
    setup(view({ status: "deckbuilding", pack: [], pool }));
    expect(screen.getByRole("textbox", { name: "Deck name" })).toHaveValue("Test Set Draft");
    await userEvent.click(screen.getByRole("button", { name: "Build deck" }));
    await waitFor(() => expect(openDraftDeck).toHaveBeenCalledWith(9));
    expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith(
      "Test Set Draft",
      ["id-Shock", "id-Mountain"],
      false,
    );
    expect(ipcMock.draftEnd).toHaveBeenCalledWith(42);
    expect(ipcMock.draftDeckCreate.mock.invocationCallOrder[0]).toBeLessThan(
      openDraftDeck.mock.invocationCallOrder[0],
    );
    expect(useNotifications.getState().notices[0]).toMatchObject({
      tone: "success",
      title: "Built “Test Set Draft” from a 2-card pool",
    });
  });

  it("builds a Commander draft's pool into a deck with a Commander pile", async () => {
    ipcMock.draftDeckCreate.mockResolvedValue({ id: 4, name: "Test Set Draft" });
    ipcMock.draftEnd.mockResolvedValue(undefined);
    setup(
      view({
        mode: "commander",
        status: "deckbuilding",
        pack: [],
        pool: [card("Shock")],
        minDeckSize: 60,
        picksPerStep: 2,
        commanders: 1,
      }),
    );
    expect(
      screen.getByText(/A Commander deck needs 60 cards and a commander in its Commander pile\./),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Build deck" }));
    await waitFor(() => expect(openDraftDeck).toHaveBeenCalledWith(4));
    expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith("Test Set Draft", ["id-Shock"], true);
  });

  it("leaves the lobby, not the draft, once a guest has built", async () => {
    ipcMock.draftDeckCreate.mockResolvedValue({ id: 3, name: "Pod Draft" });
    ipcMock.lobbyLeave.mockResolvedValue(undefined);
    setup(
      view({ mode: "pod", status: "deckbuilding", pack: [], pool: [card("Shock")] }),
      "guest",
      null,
    );
    await userEvent.click(screen.getByRole("button", { name: "Build deck" }));
    await waitFor(() => expect(openDraftDeck).toHaveBeenCalledWith(3));
    expect(ipcMock.lobbyLeave).toHaveBeenCalledOnce();
    expect(ipcMock.draftEnd).not.toHaveBeenCalled();
  });

  describe("a pick of two", () => {
    const three = () =>
      view({
        mode: "commander",
        picksPerStep: 2,
        pack: [card("Shock"), card("Opt"), card("Duress")],
      });

    it("chooses two cards and sends both ids in one pick", async () => {
      ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
      setup(three());
      expect(screen.getByText("Choose 2")).toBeInTheDocument();
      const pick = screen.getByRole("button", { name: "Pick 2" });
      expect(pick).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(within(pack()).getByRole("button", { name: "Shock" }));
      // A second click on a chosen card takes it back out rather than picking it.
      await userEvent.click(within(pack()).getByRole("button", { name: "Shock" }));
      expect(screen.getByText("0 of 2 chosen")).toBeInTheDocument();
      await userEvent.click(within(pack()).getByRole("button", { name: "Shock" }));
      await userEvent.click(within(pack()).getByRole("button", { name: "Duress" }));
      expect(screen.getByText("2 of 2 chosen")).toBeInTheDocument();
      expect(ipcMock.draftPick).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Pick Shock and Duress" }));
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, [
        "Shock#0.0.0",
        "Duress#0.0.0",
      ]);
    });

    it("picks with Enter once two are chosen", async () => {
      ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
      setup(three());
      within(pack()).getByRole("button", { name: "Shock" }).focus();
      // Enter on a tile before two are chosen is the tile's own press: it chooses it.
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{ArrowRight}{Enter}");
      expect(screen.getByText("2 of 2 chosen")).toBeInTheDocument();
      expect(ipcMock.draftPick).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0", "Opt#0.0.0"]);
    });

    it("picks the chosen card with the one dragged onto the pool", async () => {
      ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
      setup(three());
      // Dragged alone, a card is not a whole pick: the pool refuses it.
      await dragToPool("Duress");
      expect(ipcMock.draftPick).not.toHaveBeenCalled();
      await userEvent.click(within(pack()).getByRole("button", { name: "Shock" }));
      await dragToPool("Duress");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, [
        "Shock#0.0.0",
        "Duress#0.0.0",
      ]);
    });

    it("sends a guest's two cards to the host", async () => {
      ipcMock.lobbyPick.mockResolvedValue(undefined);
      setup({ ...three(), mode: "pod", podFormat: "commander" }, "guest", null);
      await userEvent.click(within(pack()).getByRole("button", { name: "Opt" }));
      await userEvent.click(within(pack()).getByRole("button", { name: "Duress" }));
      await userEvent.click(screen.getByRole("button", { name: "Pick Opt and Duress" }));
      expect(ipcMock.lobbyPick).toHaveBeenCalledExactlyOnceWith(["Opt#0.0.0", "Duress#0.0.0"]);
    });
  });

  describe("a Winston table", () => {
    it("draws the stack, the piles and the active pile face up", () => {
      setup(winston());
      const table = screen.getByRole("list", { name: "Stack and piles" });
      expect(within(table).getByRole("img", { name: "The stack, 30 cards" })).toBeInTheDocument();
      expect(
        within(table).getByRole("img", { name: "Pile 1, 2 cards, being looked at" }),
      ).toBeInTheDocument();
      expect(within(table).getByRole("img", { name: "Pile 3, 3 cards" })).toBeInTheDocument();
      const pile = screen.getByRole("list", { name: "Pile 1" });
      expect(within(pile).getAllByRole("listitem")).toHaveLength(2);
      expect(screen.queryByRole("list", { name: "Pack" })).not.toBeInTheDocument();
    });

    it("takes and declines a pile through draft_winston", async () => {
      ipcMock.draftWinston.mockResolvedValueOnce(
        winston({ stack: stack({ activePile: 1 }), pickNumber: 0 }),
      );
      ipcMock.draftWinston.mockResolvedValueOnce(winston({ pickNumber: 1 }));
      setup(winston());
      await userEvent.click(screen.getByRole("button", { name: "Decline" }));
      expect(ipcMock.draftWinston).toHaveBeenLastCalledWith(42, 0, false);
      await userEvent.click(await screen.findByRole("button", { name: "Take pile" }));
      expect(ipcMock.draftWinston).toHaveBeenLastCalledWith(42, 1, true);
    });

    it("keeps Pick for me on the reader's turn", async () => {
      ipcMock.draftAutoPick.mockResolvedValue(winston({ pickNumber: 1 }));
      setup(winston());
      await userEvent.click(screen.getByRole("button", { name: "Pick for me" }));
      expect(ipcMock.draftAutoPick).toHaveBeenCalledWith(42);
    });

    it("says the bot is deciding on its turn", () => {
      setup(
        winston({
          stack: stack({
            yourTurn: false,
            turnSeat: 1,
            piles: stack().piles.map((p) => ({ ...p, cards: [] })),
          }),
        }),
      );
      expect(screen.getByText("Bot 1 is deciding…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Take pile" })).not.toBeInTheDocument();
    });

    it("sends a guest's decision with lobby_winston, and holds it until the host's push", async () => {
      ipcMock.lobbyWinston.mockResolvedValue(undefined);
      const seats = [
        { name: "Ada", bot: false, connected: true, picked: false, poolCount: 0 },
        { name: "Bea", bot: false, connected: true, picked: false, poolCount: 0 },
      ];
      setup(winston({ mode: "pod", podFormat: "winston", seats }), "guest", null);
      await userEvent.click(screen.getByRole("button", { name: "Take pile" }));
      expect(ipcMock.lobbyWinston).toHaveBeenCalledExactlyOnceWith(0, true);
      expect(ipcMock.draftWinston).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Take pile" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      act(() =>
        push(
          winston({
            mode: "pod",
            podFormat: "winston",
            seats,
            pickNumber: 1,
            stack: stack({ yourTurn: false, turnSeat: 1, activePile: 0 }),
          }),
        ),
      );
      expect(screen.getByText("Waiting for Bea")).toBeInTheDocument();
    });
  });
});
