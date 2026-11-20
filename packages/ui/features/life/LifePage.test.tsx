import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The board and its save are their own suites'; this one is about the desktop face's page.
vi.mock("@/features/life/game/savedGame", () => ({
  peekSavedGame: () => null,
  clearSavedGame: () => {},
}));
vi.mock("@/features/life/board/LifeBoard", () => ({
  LifeBoard: ({ onLeave }: { onLeave: () => void }) => (
    <div role="application" aria-label="Life board">
      <button type="button" onClick={onLeave}>
        Leave the board
      </button>
    </div>
  ),
}));

import { BELOW_CAPTION } from "@/components/TitleBar";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { EditionContext, LIGHT_EDITION } from "@/lib/edition";
import { LAYER } from "@/lib/layers";
import { LifePage } from "./LifePage";

const renderPage = () =>
  render(
    <EditionContext.Provider value={LIGHT_EDITION}>
      <TooltipProvider>
        <LifePage />
      </TooltipProvider>
    </EditionContext.Provider>,
  );

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("the Life view on the light app's desktop face", () => {
  it("draws the setup under the page title", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Life" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start game" })).toBeInTheDocument();
  });

  it("covers the window below the caption with the board, and comes back to the setup", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Start game" }));

    const frame = screen.getByTestId("life-board-frame");
    // Below the title band: the light edition has no caption buttons, but the band is drawn.
    expect(frame).toHaveClass("fixed", "inset-x-0", "bottom-0", BELOW_CAPTION, LAYER.stage);
    expect(frame).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Leave the board" }));
    expect(screen.queryByRole("application", { name: "Life board" })).toBeNull();
    // The press that started the game is back, and has the caret.
    expect(screen.getByRole("button", { name: "Start game" })).toHaveFocus();
  });
});
