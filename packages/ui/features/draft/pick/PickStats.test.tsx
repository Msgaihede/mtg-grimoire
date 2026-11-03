import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DraftCard } from "@/lib/ipc";
import { PickStats } from "./PickStats";

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
    manaCost: "{R}",
    ...over,
  };
}

const curveBars = () =>
  within(screen.getByRole("region", { name: "Mana curve" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("PickStats", () => {
  it("leaves the 0 column out of the curve unless the deck holds a 0-cost spell", () => {
    const { rerender } = render(<PickStats cards={[card("Bolt"), card("Ogre", { cmc: 3 })]} />);
    expect(curveBars()).toHaveLength(8);
    expect(screen.queryByText("1 card at mana value 0", { exact: false })).not.toBeInTheDocument();

    rerender(<PickStats cards={[card("Bolt"), card("Ornithopter", { cmc: 0, colors: [] })]} />);
    expect(curveBars()).toHaveLength(9);
  });

  it("splits the curve into creatures and noncreatures until the reader joins them", async () => {
    render(
      <PickStats cards={[card("Bolt"), card("Ogre", { cmc: 3, typeLine: "Creature — Ogre" })]} />,
    );
    const curve = screen.getByRole("region", { name: "Mana curve" });
    expect(within(curve).getByText("Noncreatures")).toBeInTheDocument();
    await userEvent.click(within(curve).getByRole("button", { pressed: true }));
    expect(within(curve).queryByText("Noncreatures")).not.toBeInTheDocument();
  });

  it("says the deck's types and colors, and counts the deck's cards", () => {
    render(
      <PickStats
        cards={[
          card("Bolt"),
          card("Charm", { cmc: 2, colors: ["R", "W"] }),
          card("Mountain", { typeLine: "Basic Land — Mountain", cmc: 0, colors: [] }),
        ]}
      />,
    );
    expect(screen.getByText("3 cards")).toBeInTheDocument();
    const types = screen.getByRole("region", { name: "Card distribution" });
    expect(
      within(types).getByText("2 cards of type Instant", { exact: false }),
    ).toBeInTheDocument();
    expect(within(types).getByText("1 card of type Land", { exact: false })).toBeInTheDocument();
    const colors = within(screen.getByRole("list", { name: "Cards by color" })).getAllByRole(
      "listitem",
    );
    expect(colors.map((li) => li.querySelector(".sr-only")?.textContent)).toEqual([
      "Red: 1 card, 50%",
      "White–red: 1 card, 50%",
    ]);
  });
});
