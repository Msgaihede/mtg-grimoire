import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptySeat, gameCard } from "../table/fixtures";
import { PlateFrame, cursesOn, standingMarks } from "./PlateFrame";

describe("standingMarks", () => {
  it("is nothing for a player who has none of it", () => {
    expect(standingMarks(emptySeat("you"))).toEqual([]);
  });

  it("names every counter and designation a player has, in the plate's order", () => {
    const marks = standingMarks(
      emptySeat("you", {
        energy: 3,
        experience: 1,
        rad: 2,
        tickets: 1,
        speed: 2,
        ring: 2,
        monarch: true,
        initiative: true,
        cityBlessing: true,
        dungeon: {
          name: "Lost Mine of Phandelver",
          room: "Goblin Lair",
          roomText: "Create a 1/1 red Goblin creature token.",
        },
      }),
    );
    expect(marks.map((m) => [m.key, m.text, m.label])).toEqual([
      ["energy", "3", "3 energy"],
      ["experience", "1", "1 experience"],
      ["rad", "2", "2 rad"],
      ["tickets", "1", "1 ticket"],
      ["speed", "Speed 2", "Speed 2"],
      ["ring", "Ring ×2", "Tempted by the Ring 2 times"],
      ["monarch", "Monarch", "The monarch"],
      ["initiative", "Initiative", "Has the initiative"],
      ["cityBlessing", "City's blessing", "Has the city's blessing"],
      ["dungeon", "Goblin Lair", "In Lost Mine of Phandelver, Goblin Lair"],
    ]);
    expect(marks[marks.length - 1].title).toBe(
      "Lost Mine of Phandelver: Goblin Lair — Create a 1/1 red Goblin creature token.",
    );
  });

  it("draws a speed of 0 once the player has one, and a Ring tempting once as once", () => {
    const marks = standingMarks(emptySeat("you", { speed: 0, ring: 1 }));
    expect(marks.map((m) => m.label)).toEqual(["Speed 0", "Tempted by the Ring once"]);
  });
});

describe("cursesOn", () => {
  it("finds what is attached to a player on whichever battlefield it lies", () => {
    const curse = gameCard("Curse of Opulence", { lane: "other" });
    const view = {
      you: emptySeat("you", { enchantedBy: [curse.id] }),
      opponents: [emptySeat("opponent", { battlefield: [gameCard("Forest"), curse] })],
    };
    expect(cursesOn(view.you, view)).toEqual([curse]);
    expect(cursesOn(view.opponents[0], view)).toEqual([]);
  });

  it("leaves out an id no battlefield holds", () => {
    const view = { you: emptySeat("you", { enchantedBy: [9999] }), opponents: [] };
    expect(cursesOn(view.you, view)).toEqual([]);
  });
});

describe("PlateFrame", () => {
  it("draws the player's standing beside poison, the monarch in gold", () => {
    render(
      <PlateFrame
        seat="you"
        active={false}
        poison={2}
        standing={emptySeat("you", {
          energy: 4,
          monarch: true,
          dungeon: { name: "Tomb of Annihilation", room: "Oubliette", roomText: "Discard a card." },
        })}
      >
        <span>plate</span>
      </PlateFrame>,
    );
    expect(screen.getByLabelText("2 poison")).toBeInTheDocument();
    expect(screen.getByLabelText("4 energy")).toHaveTextContent("4");
    expect(screen.getByLabelText("The monarch")).toHaveClass("text-accent");
    expect(screen.getByLabelText("In Tomb of Annihilation, Oubliette")).toHaveAttribute(
      "title",
      "Tomb of Annihilation: Oubliette — Discard a card.",
    );
  });

  it("draws no marks for a player with nothing to show", () => {
    const { container } = render(
      <PlateFrame seat="opponent" active={false} poison={0} standing={emptySeat("opponent")}>
        <span>plate</span>
      </PlateFrame>,
    );
    expect(container.querySelector("[data-standing]")).toBeNull();
    expect(container.querySelector("[data-curse]")).toBeNull();
  });

  it("shows a revealed companion, and puts the reader's into the hand when the rules offer it", () => {
    const companion = { name: "Lurrus of the Dream-Den", cardId: "lurrus", toHand: false };
    const onCompanion = vi.fn();
    const { rerender } = render(
      <PlateFrame
        seat="you"
        active={false}
        poison={0}
        companion={companion}
        onCompanion={onCompanion}
      >
        <span>plate</span>
      </PlateFrame>,
    );
    expect(screen.getByLabelText("Companion: Lurrus of the Dream-Den")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <PlateFrame
        seat="you"
        active={false}
        poison={0}
        companion={{ ...companion, toHand: true }}
        onCompanion={onCompanion}
      >
        <span>plate</span>
      </PlateFrame>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Put Lurrus of the Dream-Den, your companion, into your hand for {3}",
      }),
    );
    expect(onCompanion).toHaveBeenCalledOnce();
  });

  it("chips each Curse on the player by name, and points at its card", () => {
    const curse = gameCard("Curse of Opulence", { lane: "other" });
    const onPointCard = vi.fn();
    const onUnpoint = vi.fn();
    render(
      <PlateFrame
        seat="opponent"
        active={false}
        poison={0}
        compact
        curses={[curse]}
        onPointCard={onPointCard}
        onUnpoint={onUnpoint}
      >
        <span>plate</span>
      </PlateFrame>,
    );
    const chip = screen.getByLabelText("Attached: Curse of Opulence");
    expect(chip).toHaveTextContent("Curse of Opulence");
    fireEvent.mouseEnter(chip);
    expect(onPointCard).toHaveBeenCalledWith(curse, expect.anything());
    fireEvent.mouseLeave(chip);
    expect(onUnpoint).toHaveBeenCalled();
  });
});
