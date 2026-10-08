import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deckStats } from "../DeckStats";
import { card } from "../validation/fixtures";
import { CreatureSplitBar } from "./CreatureSplitBar";

const creature = (quantity: number) =>
  card({ name: `Bear ${quantity}`, typeLine: "Creature — Bear", cmc: 2, quantity });
const spell = (quantity: number) =>
  card({ name: `Bolt ${quantity}`, typeLine: "Instant", cmc: 1, quantity });

const split = (...cards: ReturnType<typeof card>[]) =>
  render(<CreatureSplitBar stats={deckStats(cards)} />);

describe("CreatureSplitBar", () => {
  /** The drawing is hidden and the whole reading is one sentence — the band's standing rule. */
  it("says the split as one sentence and hides the drawing", () => {
    const { container } = split(creature(6), spell(4));

    expect(
      screen.getByText("Creatures vs noncreatures: 6 creatures (60%) and 4 noncreatures (40%)."),
    ).toBeInTheDocument();
    for (const part of container.querySelectorAll("[data-split-part]")) {
      expect(part.closest("[aria-hidden=true]")).not.toBeNull();
    }
    expect(container.querySelector("[data-split-beside]")).toBeNull();
  });

  /** Under the share threshold a part's words go under the bar at its own end, and only that
   *  part's — the wide part keeps its words on its fill. */
  it("moves a narrow part's words beside the bar", () => {
    const { container } = split(creature(1), spell(9));

    const beside = container.querySelector("[data-split-beside]");
    expect(beside).toHaveAttribute("data-split-beside", "creature");
    expect(beside).toHaveTextContent("1creature10%");
    expect(container.querySelector('[data-split-part="creature"]')).toBeEmptyDOMElement();
    expect(container.querySelector('[data-split-part="noncreature"]')).toHaveTextContent(
      "9noncreatures90%",
    );
  });

  /** A part of nothing draws no segment; the sentence still says the zero. */
  it("draws one part for a deck with no creatures", () => {
    const { container } = split(spell(3));

    expect(container.querySelectorAll("[data-split-part]")).toHaveLength(1);
    expect(screen.getByText(/0 noncreatures|0 creatures/)).toHaveTextContent(
      "0 creatures (0%) and 3 noncreatures (100%).",
    );
  });

  it("draws nothing for a deck with no nonland spells", () => {
    const { container } = split(
      card({ name: "Forest", typeLine: "Basic Land — Forest", cmc: 0, manaCost: null }),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
