import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM, ZOOM_SECTIONS } from "@/lib/cardZoom";
import type { DraftCard, DraftView, WinstonView } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";
import { pickOption } from "@/test-dropdown";
import { boxed, pointerDrag } from "@/test-drag";
import { parseStored, STORAGE_KEY as TRAY_LAYOUT_KEY, useDraftTrayLayout } from "./trayLayout";

const ipcMock = vi.hoisted(() => ({
  draftPick: vi.fn(),
  draftAutoPick: vi.fn(),
  draftWinston: vi.fn(),
  draftView: vi.fn(),
  draftEnd: vi.fn(),
  draftDeckCreate: vi.fn(),
  oracleTagsForPrintings: vi.fn(),
  lobbyPick: vi.fn(),
  lobbyWinston: vi.fn(),
  lobbyLeave: vi.fn(),
  lobbyRejoin: vi.fn(),
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
import { keepSideboard, recallSideboard } from "./split";

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
  ipcMock.oracleTagsForPrintings.mockResolvedValue([]);
  ipcMock.lobbyRejoin.mockResolvedValue(null);
  ipcMock.onDraftView.mockImplementation((cb: (v: DraftView) => void) => {
    push = cb;
    return () => {};
  });
  openDraftDeck.mockReset();
  useAppStore.setState(useAppStore.getInitialState());
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

/** The box a card from the pack is let go over to pick it into `zone` — that zone's drop target. */
const zoneTarget = (zone: "Deck" | "Sideboard") =>
  screen.getByRole("region", { name: zone }).parentElement!;

/**
 * A card carried from the pack onto the deck (or the sideboard), as a real pointer gesture. The
 * ends are boxed clear of each other: jsdom lays nothing out, and dnd-kit hit-tests by coordinate.
 */
async function dragToPool(name: string, zone: "Deck" | "Sideboard" = "Deck"): Promise<void> {
  const tile = within(pack()).getByRole("button", { name });
  boxed(tile, 0, 100);
  boxed(zoneTarget("Deck"), 300, 200);
  boxed(zoneTarget("Sideboard"), 600, 200);
  await act(() => pointerDrag(tile, zoneTarget(zone)));
}

const zone = (name: "Deck" | "Sideboard") => screen.getByRole("region", { name });

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

  it("draws an empty pool a card tall, its columns under the hint (issue #1473)", () => {
    setup(view());
    const pool = screen.getByRole("region", { name: "Deck" });
    // Every column is drawn before the first pick, so the first card moves nothing.
    expect(within(pool).getByRole("list", { name: "Mana value 0: 0 cards" })).toBeInTheDocument();
    expect(within(pool).getByRole("list", { name: "Lands: 0 cards" })).toBeInTheDocument();
    const hint = within(pool).getByText("The cards you pick land here, by mana value.");
    expect(hint).toHaveStyle({ gridRow: "2" });
    // jsdom lays nothing out: the row's height is held by one column's card, 5:7, in that row.
    const holder = hint.parentElement!.querySelector('[aria-hidden="true"].aspect-\\[5\\/7\\]');
    expect(holder).toHaveStyle({ gridRow: "2" });
  });

  it("chooses with a click and picks with the Pick button", async () => {
    ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
    setup(view());
    const shock = within(pack()).getByRole("button", { name: "Shock" });
    await userEvent.click(shock);
    expect(shock).toHaveAttribute("aria-pressed", "true");
    expect(ipcMock.draftPick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Pick Shock" }));
    expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
  });

  it("picks a double-clicked card, through draft_pick (issue #1469)", async () => {
    ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
    setup(view());
    await userEvent.dblClick(within(pack()).getByRole("button", { name: "Opt" }));
    expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Opt#0.0.0"]);
  });

  it("never picks with a later click on the chosen card — only a double-click does", async () => {
    setup(view());
    const shock = within(pack()).getByRole("button", { name: "Shock" });
    // Two separate clicks, not one double-click: the second only chooses the card again.
    await userEvent.click(shock);
    await userEvent.click(shock);
    expect(shock).toHaveAttribute("aria-pressed", "true");
    expect(ipcMock.draftPick).not.toHaveBeenCalled();
  });

  it("picks once on a triple-click", async () => {
    ipcMock.draftPick.mockReturnValue(new Promise(() => {}));
    setup(view());
    await userEvent.tripleClick(within(pack()).getByRole("button", { name: "Shock" }));
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

  describe("the pack's order", () => {
    const dealt = () =>
      view({
        pack: [
          card("Shock"),
          card("Opt", { rarity: "uncommon" }),
          card("Duress", { rarity: "mythic" }),
          card("Ponder", { rarity: "rare" }),
          card("Spark", { rarity: "special" }),
          card("Bolt"),
        ],
      });
    const names = () =>
      within(pack())
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"));

    it("lays the pack out by rarity by default, a rarity's cards as dealt (issue #1432)", () => {
      setup(dealt());
      expect(names()).toEqual(["Duress", "Ponder", "Opt", "Shock", "Bolt", "Spark"]);
    });

    it("lays it out as dealt on request, and keeps the choice through a new sort", async () => {
      const user = userEvent.setup();
      setup(dealt());
      await user.click(within(pack()).getByRole("button", { name: "Opt" }));
      await pickOption(user, "Sort", "As dealt");
      expect(names()).toEqual(["Shock", "Opt", "Duress", "Ponder", "Spark", "Bolt"]);
      expect(within(pack()).getByRole("button", { name: "Opt" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Pick Opt" })).toBeInTheDocument();
    });

    it("picks the card dragged, wherever the sort has put it", async () => {
      ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
      setup(dealt());
      await dragToPool("Ponder");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Ponder#0.0.0"]);
    });
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

  it("asks the host again for a guest's view on arrival, and takes the one it pushes", async () => {
    // Issue #1468: the guest was elsewhere, or reloaded, and the view kept is still waiting on a
    // pack the host has since passed.
    setup(view({ mode: "pod", waiting: true }), "guest", null);
    expect(screen.getByText("Waiting for the table…")).toBeInTheDocument();
    await waitFor(() => expect(ipcMock.lobbyRejoin).toHaveBeenCalledOnce());
    expect(ipcMock.draftView).not.toHaveBeenCalled();
    act(() => push(view({ mode: "pod", pickNumber: 1 })));
    expect(screen.getByRole("heading", { name: "Pack 1 · Pick 2" })).toBeInTheDocument();
  });

  it("asks nothing of the lobby for a draft this app runs", async () => {
    setup(view(), "host", 42);
    await waitFor(() => expect(ipcMock.draftView).toHaveBeenCalledWith(42));
    expect(ipcMock.lobbyRejoin).not.toHaveBeenCalled();
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
    // Every card was picked into the deck: each filed by the add path's rule, none in the Pool.
    expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith(
      "Test Set Draft",
      [],
      [
        { cardId: "id-Shock", pile: "Instant" },
        { cardId: "id-Mountain", pile: "Land" },
      ],
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
    expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith(
      "Test Set Draft",
      [],
      [{ cardId: "id-Shock", pile: "Instant" }],
      true,
    );
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

  /** Issue #1471: a pick goes to the deck or the sideboard — Arena's two lists. */
  describe("the deck and the sideboard", () => {
    const shockPicked = (over: Partial<DraftView> = {}) =>
      view({ pickNumber: 1, pack: [card("Opt")], pool: [card("Shock")], ...over });

    it("picks a card dropped on the sideboard into the sideboard", async () => {
      ipcMock.draftPick.mockResolvedValue(shockPicked());
      setup(view());
      await dragToPool("Shock", "Sideboard");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
      expect(
        await within(zone("Sideboard")).findByRole("button", { name: "Move Shock to the deck" }),
      ).toBeInTheDocument();
      expect(within(zone("Deck")).queryByRole("button")).not.toBeInTheDocument();
      expect(recallSideboard()).toEqual(["Shock#0.0.0"]);
    });

    it("picks into the deck by default, and into the sideboard with To sideboard", async () => {
      ipcMock.draftPick.mockResolvedValueOnce(shockPicked());
      setup(view());
      await userEvent.click(within(pack()).getByRole("button", { name: "Shock" }));
      await userEvent.click(screen.getByRole("button", { name: "Pick Shock into the sideboard" }));
      expect(ipcMock.draftPick).toHaveBeenLastCalledWith(42, ["Shock#0.0.0"]);
      expect(
        await within(zone("Sideboard")).findByRole("button", { name: "Move Shock to the deck" }),
      ).toBeInTheDocument();

      ipcMock.draftPick.mockResolvedValueOnce(
        view({ pickNumber: 2, pack: [], waiting: true, pool: [card("Shock"), card("Opt")] }),
      );
      within(pack()).getByRole("button", { name: "Opt" }).focus();
      await userEvent.keyboard("{ArrowRight}{Enter}");
      expect(ipcMock.draftPick).toHaveBeenLastCalledWith(42, ["Opt#0.0.0"]);
      expect(
        await within(zone("Deck")).findByRole("button", { name: "Move Opt to the sideboard" }),
      ).toBeInTheDocument();
    });

    it("picks into the sideboard with Shift+Enter", async () => {
      ipcMock.draftPick.mockResolvedValue(shockPicked());
      setup(view());
      within(pack()).getByRole("button", { name: "Shock" }).focus();
      await userEvent.keyboard("{ArrowRight}{Shift>}{Enter}{/Shift}");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
      expect(recallSideboard()).toEqual(["Shock#0.0.0"]);
    });

    it("keeps nothing on the sideboard for a refused pick", async () => {
      ipcMock.draftPick.mockRejectedValue("That card is not in your pack.");
      setup(view());
      await dragToPool("Shock", "Sideboard");
      expect(await screen.findByRole("alert")).toHaveTextContent("That card is not in your pack.");
      expect(recallSideboard()).toEqual([]);
    });

    it("moves a picked card between the deck and the sideboard with a click", async () => {
      setup(view({ pool: [card("Shock")] }));
      await userEvent.click(
        within(zone("Deck")).getByRole("button", { name: "Move Shock to the sideboard" }),
      );
      expect(recallSideboard()).toEqual(["Shock#0.0.0"]);
      await userEvent.click(
        within(zone("Sideboard")).getByRole("button", { name: "Move Shock to the deck" }),
      );
      expect(recallSideboard()).toEqual([]);
      expect(
        within(zone("Deck")).getByRole("button", { name: "Move Shock to the sideboard" }),
      ).toBeInTheDocument();
    });

    it("comes back to the split it was left in, and starts over with a new draft", () => {
      keepSideboard(["Shock#0.0.0"]);
      setup(view({ pool: [card("Shock"), card("Opt")] }));
      expect(
        within(zone("Sideboard")).getByRole("button", { name: "Move Shock to the deck" }),
      ).toBeInTheDocument();
    });

    it("forgets the last draft's split when a draft opens with an empty pool", () => {
      keepSideboard(["Shock#0.0.0"]);
      setup(view());
      expect(recallSideboard()).toEqual([]);
    });

    it("builds the deck's cards into piles by what they do, and the sideboard's into Pool", async () => {
      keepSideboard(["Opt#0.0.0"]);
      ipcMock.oracleTagsForPrintings.mockResolvedValue([
        { cardId: "id-Shock", slugs: ["removal", "burn"] },
      ]);
      ipcMock.draftDeckCreate.mockResolvedValue({ id: 9, name: "Test Set Draft" });
      ipcMock.draftEnd.mockResolvedValue(undefined);
      setup(
        view({
          status: "deckbuilding",
          pack: [],
          pool: [card("Shock"), card("Opt"), card("Ogre", { typeLine: "Creature — Ogre", cmc: 3 })],
        }),
      );
      expect(
        screen.getByText(/the 2 in your deck filed by what they do, the 1/),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Build deck" }));
      await waitFor(() => expect(openDraftDeck).toHaveBeenCalledWith(9));
      expect(ipcMock.oracleTagsForPrintings).toHaveBeenCalledExactlyOnceWith([
        "id-Shock",
        "id-Ogre",
      ]);
      expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith(
        "Test Set Draft",
        ["id-Opt"],
        [
          { cardId: "id-Shock", pile: "Removal" },
          { cardId: "id-Ogre", pile: "Creature" },
        ],
        false,
      );
      expect(recallSideboard()).toEqual([]);
    });

    it("files by type line when the tags cannot be read", async () => {
      ipcMock.oracleTagsForPrintings.mockRejectedValue("database is busy");
      ipcMock.draftDeckCreate.mockResolvedValue({ id: 9, name: "Test Set Draft" });
      ipcMock.draftEnd.mockResolvedValue(undefined);
      setup(view({ status: "deckbuilding", pack: [], pool: [card("Shock")] }));
      await userEvent.click(screen.getByRole("button", { name: "Build deck" }));
      await waitFor(() => expect(openDraftDeck).toHaveBeenCalledWith(9));
      expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith(
        "Test Set Draft",
        [],
        [{ cardId: "id-Shock", pile: "Instant" }],
        false,
      );
    });
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

    it("picks the chosen card with the one double-clicked", async () => {
      ipcMock.draftPick.mockResolvedValue(view({ pickNumber: 1 }));
      setup(three());
      const duress = within(pack()).getByRole("button", { name: "Duress" });
      // Double-clicked alone, a card is not a whole pick: it stays chosen.
      await userEvent.dblClick(duress);
      expect(duress).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("1 of 2 chosen")).toBeInTheDocument();
      expect(ipcMock.draftPick).not.toHaveBeenCalled();
      await userEvent.dblClick(within(pack()).getByRole("button", { name: "Shock" }));
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, [
        "Duress#0.0.0",
        "Shock#0.0.0",
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
  /**
   * Ctrl+wheel steps the draft's cards (issue #1433): the pack, a Winston pile and the pool all
   * read `cardZoom.draft`, and the gesture is caught on the session's scroll box, so a wheel over
   * any of them — or the gaps between — steps that section and no other.
   */
  describe("the zoom", () => {
    const scroller = () => screen.getByRole("list", { name: "Pack" }).closest(".overflow-y-auto")!;
    const tileWidth = (list: HTMLElement) => list.style.gridTemplateColumns;

    it("steps only the draft's section on a ctrl+wheel, and sizes the pack and the pool by it", () => {
      setup(view({ pool: [card("Bolt")] }));
      expect(tileWidth(pack())).toBe("repeat(auto-fill, minmax(190px, 1fr))");
      const pool = () =>
        screen.getByRole("list", { name: "Mana value 1: 1 card" }).parentElement as HTMLElement;
      expect(tileWidth(pool())).toBe("repeat(8, minmax(0, 190px))");

      fireEvent.wheel(scroller(), { deltaY: -100, ctrlKey: true });

      const { cardZoom, zoomSection } = useAppStore.getState();
      expect(cardZoom.draft).toBe(1.1);
      for (const section of ZOOM_SECTIONS.filter((s) => s !== "draft")) {
        expect(cardZoom[section]).toBe(DEFAULT_ZOOM);
      }
      expect(zoomSection).toBe("draft");
      expect(tileWidth(pack())).toBe("repeat(auto-fill, minmax(209px, 1fr))");
      expect(tileWidth(pool())).toBe("repeat(8, minmax(0, 209px))");
    });

    it("leaves a wheel without ctrl to the scroll", () => {
      setup(view());
      fireEvent.wheel(scroller(), { deltaY: -100 });
      expect(useAppStore.getState().cardZoom.draft).toBe(DEFAULT_ZOOM);
    });

    it("draws no Card size slider — the gesture is the pick screen's only zoom (issue #1470)", () => {
      setup(view());
      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
      expect(screen.queryByText("Card size")).not.toBeInTheDocument();

      fireEvent.wheel(scroller(), { deltaY: 100, ctrlKey: true });
      expect(useAppStore.getState().cardZoom.draft).toBe(0.9);
      expect(tileWidth(pack())).toBe("repeat(auto-fill, minmax(171px, 1fr))");
    });

    it("sizes a Winston pile turned face up by the same zoom", () => {
      useAppStore.setState((s) => ({ cardZoom: { ...s.cardZoom, draft: 0.5 } }));
      setup(winston());
      expect(tileWidth(screen.getByRole("list", { name: "Pile 1" }))).toBe(
        "repeat(auto-fill, minmax(75px, 1fr))",
      );
    });
  });

  describe("the pool's layout (issue #1474)", () => {
    const layoutButton = (name: "Pool below the pack" | "Pool beside the pack") =>
      within(screen.getByRole("group", { name: "Pool layout" })).getByRole("button", { name });
    const drafted = () =>
      view({
        pool: [
          card("Shock"),
          card("Opt", { colors: ["U"] }),
          card("Shock", { instanceId: "Shock#0.1.0" }),
          card("Mountain", { typeLine: "Basic Land — Mountain", cmc: 0, colors: [] }),
          card("Fireball", { cmc: 1 }),
        ],
      });

    it("draws the pool below the pack by default", () => {
      setup(drafted());
      expect(layoutButton("Pool below the pack")).toHaveAttribute("aria-pressed", "true");
      expect(layoutButton("Pool beside the pack")).toHaveAttribute("aria-pressed", "false");
      const pool = screen.getByRole("region", { name: "Deck" });
      // The curve: every mana value's column is drawn, empty or not, one card art a pick.
      expect(within(pool).getByRole("list", { name: "Mana value 3: 0 cards" })).toBeInTheDocument();
      expect(within(pool).getAllByRole("img")).toHaveLength(5);
    });

    it("lists the pool by name in a side tray on request, and keeps the choice", async () => {
      const user = userEvent.setup();
      setup(drafted());
      await user.click(layoutButton("Pool beside the pack"));
      expect(layoutButton("Pool beside the pack")).toHaveAttribute("aria-pressed", "true");
      expect(window.localStorage.getItem(TRAY_LAYOUT_KEY)).toBe("side");

      const pool = screen.getByRole("region", { name: "Deck" });
      expect(within(pool).queryAllByRole("img")).toHaveLength(0);
      // Only the columns holding cards, a name once with its count, by name within a column.
      const lists = within(pool)
        .getAllByRole("list")
        .filter((l) => l.getAttribute("aria-label") !== "Colours in deck");
      expect(lists.map((l) => l.getAttribute("aria-label"))).toEqual([
        "Mana value 1: 4 cards",
        "Lands: 1 card",
      ]);
      expect(
        within(lists[0]!)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["1×Fireball", "1×Opt", "2×Shock"]);
      expect(within(pool).getByText("5 cards")).toBeInTheDocument();
      // The pack is still there to pick from.
      expect(within(pack()).getAllByRole("button")).toHaveLength(2);

      await user.click(layoutButton("Pool below the pack"));
      expect(window.localStorage.getItem(TRAY_LAYOUT_KEY)).toBe("bottom");
      expect(screen.getAllByRole("img").length).toBeGreaterThan(5);
    });

    it("opens on the tray where the device last left it", () => {
      window.localStorage.setItem(TRAY_LAYOUT_KEY, "side");
      // The store reads the device once, as the module loads: a stored choice is what it holds.
      useDraftTrayLayout.setState({
        layout: parseStored(window.localStorage.getItem(TRAY_LAYOUT_KEY)),
      });
      setup(drafted());
      expect(layoutButton("Pool beside the pack")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("list", { name: "Lands: 1 card" })).toBeInTheDocument();
    });

    it("picks a card dragged onto the side tray", async () => {
      useDraftTrayLayout.getState().keep("side");
      ipcMock.draftPick.mockResolvedValue(
        view({ pickNumber: 1, pack: [card("Opt")], pool: [card("Shock")] }),
      );
      setup(view());
      expect(screen.getByText("The cards you pick land here, by mana value.")).toBeInTheDocument();
      await dragToPool("Shock");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
      expect(await screen.findByRole("list", { name: "Mana value 1: 1 card" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Deck" }).closest("aside")).not.toBeNull();
    });

    it("picks into the sideboard tray, and moves a row's copy with a click (#1471)", async () => {
      useDraftTrayLayout.getState().keep("side");
      ipcMock.draftPick.mockResolvedValue(
        view({
          pickNumber: 1,
          pack: [card("Opt")],
          pool: [card("Bolt"), card("Shock")],
        }),
      );
      setup(view({ pool: [card("Bolt")] }));
      await dragToPool("Shock", "Sideboard");
      expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
      const row = await within(zone("Sideboard")).findByRole("button", {
        name: "Move Shock to the deck",
      });
      expect(zone("Sideboard").closest("aside")).not.toBeNull();
      await userEvent.click(row);
      expect(recallSideboard()).toEqual([]);
      expect(
        within(zone("Deck")).getByRole("button", { name: "Move Shock to the sideboard" }),
      ).toBeInTheDocument();
    });

    it("keeps a Winston table's pool underneath, with no toggle", () => {
      useDraftTrayLayout.getState().keep("side");
      setup(winston({ pool: [card("Shock")] }));
      expect(screen.queryByRole("group", { name: "Pool layout" })).not.toBeInTheDocument();
      expect(
        within(zone("Deck")).getByRole("list", { name: "Mana value 3: 0 cards" }),
      ).toBeInTheDocument();
    });
  });
});
