import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SET } from "@/features/draft/booster/fixture";
import type { DraftSetup, DraftView, ImportResolveLine, SetSummary } from "@/lib/ipc";

const listSets = vi.hoisted(() => vi.fn());
const packsBoosterSet = vi.hoisted(() => vi.fn());
const draftStart = vi.hoisted(() => vi.fn());
const importResolve = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { listSets, packsBoosterSet, draftStart, importResolve },
}));

import { SetupScreen, type SetupMode } from "./SetupScreen";

const TEST_SET: SetSummary = {
  code: "tst",
  name: "Test Set",
  setType: "expansion",
  releasedAt: "2026-01-01",
  cardCount: 12,
};

const CMR: SetSummary = {
  code: "cmr",
  name: "Commander Legends",
  setType: "draft_innovation",
  releasedAt: "2020-11-20",
  cardCount: 361,
};

const VIEW = { status: "drafting" } as DraftView;

beforeEach(() => {
  listSets.mockReset().mockResolvedValue([TEST_SET]);
  packsBoosterSet.mockReset().mockResolvedValue(SET);
  draftStart.mockReset().mockResolvedValue(VIEW);
  importResolve.mockReset();
});

function setup(mode: SetupMode) {
  const onStarted = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SetupScreen mode={mode} onMode={vi.fn()} onBack={vi.fn()} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  return { onStarted };
}

const start = () => screen.getByRole("button", { name: /Start draft/ });

describe("SetupScreen", () => {
  it("deals a quick draft's three packs to all eight seats and starts it", async () => {
    const { onStarted } = setup("quick");
    const wall = await screen.findByRole("list", { name: "Sets" });
    expect(start()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    // One pick and the rest filled with it — three of one set is a set's own draft.
    await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
    expect(screen.getByText("3 packs chosen — all 3")).toBeInTheDocument();
    await userEvent.click(start());

    await waitFor(() => expect(draftStart).toHaveBeenCalledOnce());
    // The set's boosters are read once, however many packs it opens.
    expect(packsBoosterSet).toHaveBeenCalledExactlyOnceWith("tst", false);
    const [setupArg, draft] = draftStart.mock.calls[0] as [DraftSetup, number];
    expect(setupArg).toMatchObject({
      mode: "quick",
      difficulty: "medium",
      label: "Test Set",
      packSets: ["TST", "TST", "TST"],
      minDeckSize: 40,
      podFormat: "booster",
    });
    expect(setupArg.seats).toHaveLength(8);
    expect(setupArg.seats[0]).toEqual({ name: "You", bot: false, peer: null });
    expect(setupArg.seats.slice(1).every((s) => s.bot)).toBe(true);
    expect(setupArg.packs).toHaveLength(8);
    expect(setupArg.packs.every((seat) => seat.length === 3)).toBe(true);
    expect(setupArg.packs[0][0]).toHaveLength(7);
    expect(typeof draft).toBe("number");
    expect(onStarted).toHaveBeenCalledWith(draft, VIEW);
  });

  it("deals a sealed pool's six boosters to the reader's seat alone", async () => {
    setup("sealed");
    const wall = await screen.findByRole("list", { name: "Sets" });
    await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
    await userEvent.click(screen.getByRole("button", { name: /Open sealed pool/ }));
    await waitFor(() => expect(draftStart).toHaveBeenCalledOnce());
    const setupArg = draftStart.mock.calls[0][0] as DraftSetup;
    expect(setupArg.mode).toBe("sealed");
    expect(setupArg.seats).toEqual([{ name: "You", bot: false, peer: null }]);
    expect(setupArg.packs).toHaveLength(1);
    expect(setupArg.packs[0]).toHaveLength(6);
    expect(setupArg.packSets).toEqual(["TST", "TST", "TST", "TST", "TST", "TST"]);
  });

  it("sends the bots' skill the reader picked", async () => {
    setup("quick");
    const wall = await screen.findByRole("list", { name: "Sets" });
    await userEvent.click(screen.getByRole("button", { name: "Very hard" }));
    for (let i = 0; i < 3; i += 1) {
      await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    }
    await userEvent.click(start());
    await waitFor(() => expect(draftStart).toHaveBeenCalledOnce());
    expect((draftStart.mock.calls[0][0] as DraftSetup).difficulty).toBe("veryHard");
  });

  it("says a set's refusal where the reader is looking", async () => {
    packsBoosterSet.mockRejectedValue("MTGJSON could not be reached.");
    setup("quick");
    const wall = await screen.findByRole("list", { name: "Sets" });
    await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
    await userEvent.click(start());
    expect(await screen.findByRole("alert")).toHaveTextContent("MTGJSON could not be reached.");
    expect(draftStart).not.toHaveBeenCalled();
  });

  it("names the cube's cards nothing matched, and starts nothing", async () => {
    importResolve.mockImplementation((lines: ImportResolveLine[]) =>
      Promise.resolve(
        lines.map((line, index) => ({
          index,
          matched: line.name === "Lightning Bolt" ? { cardId: "bolt" } : null,
          hintMissed: false,
        })),
      ),
    );
    setup("cube");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Cube list" }),
      "1 Lightning Bolt{enter}1 Not A Card",
    );
    await userEvent.click(start());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not A Card");
    expect(importResolve).toHaveBeenCalledOnce();
    expect(within(alert).getByRole("button", { name: "Draft without them" })).toBeInTheDocument();
    expect(draftStart).not.toHaveBeenCalled();
  });

  it("deals a Commander draft to you and three bots, for a 60-card deck", async () => {
    listSets.mockResolvedValue([TEST_SET, CMR]);
    setup("commander");
    const wall = await screen.findByRole("list", { name: "Sets" });
    // Commander Legends is what the format is made for: first on the wall, and marked.
    const tiles = within(wall).getAllByRole("button");
    expect(tiles[0]).toHaveTextContent("Commander Legends");
    expect(tiles[0]).toHaveTextContent("Suggested");
    expect(tiles[1]).not.toHaveTextContent("Suggested");
    expect(
      within(screen.getByRole("group", { name: "Seats" })).getByRole("button", { name: "4" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
    await userEvent.click(start());
    await waitFor(() => expect(draftStart).toHaveBeenCalledOnce());
    const setupArg = draftStart.mock.calls[0][0] as DraftSetup;
    expect(setupArg).toMatchObject({ mode: "commander", minDeckSize: 60, podFormat: "booster" });
    expect(setupArg.seats.map((s) => s.name)).toEqual(["You", "Bot 1", "Bot 2", "Bot 3"]);
    expect(setupArg.packs).toHaveLength(4);
    expect(setupArg.packs.every((seat) => seat.length === 3)).toBe(true);
  });

  it("seats a Commander draft at the count the reader picks", async () => {
    setup("commander");
    const wall = await screen.findByRole("list", { name: "Sets" });
    const seats = screen.getByRole("group", { name: "Seats" });
    expect(
      within(seats)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["3", "4", "5", "6", "7", "8"]);
    await userEvent.click(within(seats).getByRole("button", { name: "6" }));
    await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
    await userEvent.click(start());
    await waitFor(() => expect(draftStart).toHaveBeenCalledOnce());
    expect((draftStart.mock.calls[0][0] as DraftSetup).seats).toHaveLength(6);
  });

  it("deals a Winston draft's three boosters each to you and one bot", async () => {
    setup("winston");
    const wall = await screen.findByRole("list", { name: "Sets" });
    expect(screen.queryByRole("group", { name: "Seats" })).not.toBeInTheDocument();
    await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
    await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
    await userEvent.click(start());
    await waitFor(() => expect(draftStart).toHaveBeenCalledOnce());
    const setupArg = draftStart.mock.calls[0][0] as DraftSetup;
    expect(setupArg).toMatchObject({ mode: "winston", minDeckSize: 40, podFormat: "booster" });
    expect(setupArg.seats).toEqual([
      { name: "You", bot: false, peer: null },
      { name: "Bot 1", bot: true, peer: null },
    ]);
    expect(setupArg.packs).toHaveLength(2);
    expect(setupArg.packs.every((seat) => seat.length === 3)).toBe(true);
  });
});
