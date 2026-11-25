import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { gameCard } from "../table/fixtures";
import { parityMarks } from "./fixtures";
import { OpponentArea } from "./OpponentArea";

function setup() {
  const t = parityMarks();
  const seat = { ...t.view.opponents[0], player: "opponent2" as const };
  const hex = gameCard("Curse of Shallow Graves", { lane: "other", isToken: false });
  const onActivate = vi.fn();
  const onPointCard = vi.fn();
  render(
    <ContextMenuProvider>
      <OpponentArea
        seat={{ ...seat, enchantedBy: [hex.id] }}
        deckName="Boros"
        opponents={3}
        lethal={null}
        active={false}
        won={false}
        sandbox={false}
        steppers={false}
        aimable={false}
        onAim={vi.fn()}
        onLife={vi.fn()}
        onAct={vi.fn()}
        onDrop={vi.fn()}
        onPoint={vi.fn()}
        onUnpoint={vi.fn()}
        onLook={vi.fn()}
        onActivate={onActivate}
        curses={[hex]}
        onPointCard={onPointCard}
      />
    </ContextMenuProvider>,
  );
  return { t, hex, onActivate, onPointCard };
}

describe("OpponentArea", () => {
  it("draws the player's standing and the Curses on them by their plate", () => {
    const { hex, onPointCard } = setup();
    expect(screen.getByLabelText("The monarch")).toBeInTheDocument();
    expect(screen.getByLabelText("3 energy")).toBeInTheDocument();
    expect(screen.getByLabelText("In Lost Mine of Phandelver, Goblin Lair")).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByLabelText("Attached: Curse of Shallow Graves"));
    expect(onPointCard).toHaveBeenCalledWith(hex, expect.anything());
  });

  it("activates a permanent of theirs the rules let the reader activate", () => {
    const { t, onActivate } = setup();
    const table = screen.getByRole("region", { name: "Opponent 2's battlefield" });
    fireEvent.click(within(table).getByRole("button", { name: "Volrath's Dungeon" }));
    expect(onActivate).toHaveBeenCalledWith(t.shared.id);
  });

  it("draws their face-down creature as a card back, and their marks on the rest", () => {
    setup();
    const table = screen.getByRole("region", { name: "Opponent 2's battlefield" });
    expect(
      within(table)
        .getByRole("button", { name: "Face-down card" })
        .querySelector("[data-face-down]"),
    ).not.toBeNull();
    expect(
      within(table).getByRole("button", {
        name: /^Ragavan, Nimble Pilferer, 1 damage marked, goaded/,
      }),
    ).toBeInTheDocument();
  });
});
