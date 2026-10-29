import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, DraftView } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";

const ipcMock = vi.hoisted(() => ({
  draftPick: vi.fn(),
  draftAutoPick: vi.fn(),
  draftView: vi.fn(),
  draftEnd: vi.fn(),
  draftDeckCreate: vi.fn(),
  lobbyPick: vi.fn(),
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
    ...over,
  };
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

  it("chooses with a click and picks with a second, through draft_pick", async () => {
    const next = view({ pickNumber: 1, pack: [card("Opt")], pool: [card("Shock")] });
    ipcMock.draftPick.mockResolvedValue(next);
    setup(view());
    const shock = within(pack()).getByRole("button", { name: "Shock" });
    await userEvent.click(shock);
    expect(shock).toHaveAttribute("aria-pressed", "true");
    expect(ipcMock.draftPick).not.toHaveBeenCalled();
    await userEvent.click(shock);
    expect(ipcMock.draftPick).toHaveBeenCalledExactlyOnceWith(42, ["Shock#0.0.0"]);
    expect(await screen.findByRole("heading", { name: "Pack 1 · Pick 2" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Mana value 1: 1 card" })).toBeInTheDocument();
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
    await userEvent.dblClick(within(pack()).getByRole("button", { name: "Opt" }));
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
    expect(ipcMock.draftDeckCreate).toHaveBeenCalledWith("Test Set Draft", [
      "id-Shock",
      "id-Mountain",
    ]);
    expect(ipcMock.draftEnd).toHaveBeenCalledWith(42);
    expect(ipcMock.draftDeckCreate.mock.invocationCallOrder[0]).toBeLessThan(
      openDraftDeck.mock.invocationCallOrder[0],
    );
    expect(useNotifications.getState().notices[0]).toMatchObject({
      tone: "success",
      title: "Built “Test Set Draft” from a 2-card pool",
    });
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
});
