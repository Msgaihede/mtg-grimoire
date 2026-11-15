import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaytestStep } from "@/lib/ipc";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { gameOver, openingHand } from "./fixtures";
import { holdGame, type PlaytestPicks } from "./heldGame";
import { PlaytestPage } from "./PlaytestPage";

const { playtestStart, playtestAct, playtestEnd } = vi.hoisted(() => ({
  playtestStart: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  playtestAct: vi.fn<(game: number, action: unknown) => Promise<PlaytestStep>>(),
  playtestEnd: vi.fn<(game: number) => Promise<void>>(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { playtestStart, playtestAct, playtestEnd },
}));

const PICKS: PlaytestPicks = {
  deckId: 7,
  variant: "live",
  opponents: [{ deckId: 9, variant: "live" }],
};

beforeEach(() => {
  playtestStart.mockReset().mockResolvedValue({ view: openingHand(), happened: [], frames: [] });
  playtestAct.mockReset();
  playtestEnd.mockReset().mockResolvedValue(undefined);
});

function page(onBack: () => void, held = holdGame(PICKS)) {
  return (
    <ContextMenuProvider>
      <PlaytestPage
        picks={PICKS}
        held={held}
        deckName="Simic Tempo"
        opponentNames={["Boros Aggro"]}
        onBack={onBack}
      />
    </ContextMenuProvider>
  );
}

/** The header's way back. Over a finished game the Game over panel draws a `Back to setup` of its
 *  own — the same press, under the same name — so the header's is the one outside that panel. */
const backButton = () => {
  const over = screen.queryByRole("region", { name: "Game over" });
  const header = screen
    .getAllByRole("button", { name: "Back to setup" })
    .filter((button) => over === null || !over.contains(button));
  expect(header).toHaveLength(1);
  return header[0];
};

// Issue #1322: a game is kept until the reader ends it, so the press that ends it asks first.
describe("PlaytestPage", () => {
  it("asks before the way back puts a game underway away, and Keep playing keeps it", async () => {
    const onBack = vi.fn();
    render(page(onBack));
    await screen.findByRole("region", { name: "Playtest" });
    await waitFor(() => expect(playtestStart).toHaveBeenCalled());
    await screen.findByRole("button", { name: /keep/i });
    await userEvent.click(backButton());
    const dialog = await screen.findByRole("dialog", { name: "End this game?" });
    expect(dialog).toHaveTextContent("To keep it, switch pages instead.");
    await userEvent.click(screen.getByRole("button", { name: "Keep playing" }));
    expect(onBack).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Escape is the way back too, and asks the same.
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await screen.findByRole("dialog", { name: "End this game?" });
    await userEvent.click(screen.getByRole("button", { name: "End game" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("leaves a game the engine has ended without asking", async () => {
    playtestStart.mockResolvedValue({ view: gameOver().view, happened: [], frames: [] });
    const onBack = vi.fn();
    render(page(onBack));
    await screen.findByRole("region", { name: "Game over" });
    await userEvent.click(backButton());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a kept game where it was left, without dealing again", async () => {
    const held = holdGame(PICKS);
    const first = render(page(vi.fn(), held));
    await screen.findByRole("button", { name: /keep/i });
    first.unmount();
    expect(playtestEnd).not.toHaveBeenCalled();
    render(page(vi.fn(), held));
    expect(await screen.findByRole("button", { name: /keep/i })).toBeInTheDocument();
    expect(playtestStart).toHaveBeenCalledTimes(1);
  });
});
