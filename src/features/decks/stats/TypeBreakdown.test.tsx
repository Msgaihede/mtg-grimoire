import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MODAL_DFC } from "../deckBuckets";
import { card } from "../validation/fixtures";
import { CREATURE_ROW_LIMIT, TypeBreakdown } from "./TypeBreakdown";

const land = (name: string, typeLine: string, quantity = 1) =>
  card({ name, typeLine, quantity, manaCost: null, cmc: 0, colors: null });

const izzet = [
  land("Island", "Basic Land — Island", 8),
  land("Mountain", "Basic Land — Mountain", 6),
  land("Steam Vents", "Land — Island Mountain", 4),
  land("Spirebluff Canal", "Land", 4),
  card({ name: "Snapcaster", typeLine: "Creature — Human Wizard", quantity: 4 }),
  card({ name: "Goblin", typeLine: "Creature — Goblin", quantity: 2 }),
];

const listItems = (name: string) =>
  within(screen.getByRole("list", { name })).getAllByRole("listitem");

describe("TypeBreakdown", () => {
  /** The legend is the accessible story: every slice, with its count and its share, in words. */
  it("lists every land slice with its count and share", () => {
    render(<TypeBreakdown cards={izzet} />);

    expect(listItems("Land types").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Island: 8 lands, 36%"),
      expect.stringContaining("Mountain: 6 lands, 27%"),
      expect.stringContaining("Island Mountain: 4 lands, 18%"),
      expect.stringContaining("No basic land type: 4 lands, 18%"),
    ]);
    expect(screen.getByRole("heading", { name: "Land 22" })).toBeInTheDocument();
  });

  it("ranks creature types and counts a two-type creature under both", () => {
    render(<TypeBreakdown cards={izzet} />);

    expect(listItems("Creature types").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Human: 4 creatures"),
      expect.stringContaining("Wizard: 4 creatures"),
      expect.stringContaining("Goblin: 2 creatures"),
    ]);
    expect(screen.getByRole("heading", { name: "Creature 6" })).toBeInTheDocument();
    expect(screen.getByText("A creature with two types counts under both.")).toBeInTheDocument();
  });

  /**
   * A dual's slice is striped through an SVG pattern, and the pattern id is per instance — two
   * pies on one page sharing `#…-UR` would each fill from whichever `<pattern>` came first.
   */
  it("stripes a multi-type slice with a pattern of its fills, unique per pie", () => {
    const { container } = render(
      <>
        <TypeBreakdown cards={izzet} />
        <TypeBreakdown cards={izzet} />
      </>,
    );

    const patterns = [...container.querySelectorAll("pattern")];
    expect(patterns).toHaveLength(2);
    expect(new Set(patterns.map((p) => p.id)).size).toBe(2);
    expect([...patterns[0].querySelectorAll("rect")].map((r) => r.getAttribute("fill"))).toEqual([
      "var(--color-mana-u)",
      "var(--color-mana-r)",
    ]);
    const fills = [...container.querySelectorAll("svg path")].map((p) => p.getAttribute("fill"));
    expect(fills).toContain(`url(#${patterns[0].id})`);
    expect(fills).toContain("var(--color-mana-c)");
  });

  it("caps the creature rows and says how many more types there are", () => {
    const types = Array.from({ length: CREATURE_ROW_LIMIT + 2 }, (_, i) =>
      card({ name: `C${i}`, typeLine: `Creature — Type${String(i).padStart(2, "0")}` }),
    );
    render(<TypeBreakdown cards={types} />);

    expect(listItems("Creature types")).toHaveLength(CREATURE_ROW_LIMIT);
    expect(screen.getByText("And 2 more types.")).toBeInTheDocument();
  });

  it("says each panel is empty rather than drawing nothing", () => {
    render(<TypeBreakdown cards={[card({ name: "Bolt", typeLine: "Instant" })]} />);

    expect(screen.getByText("No creatures in this list.")).toBeInTheDocument();
    expect(screen.getByText("No lands in this list.")).toBeInTheDocument();
  });

  /** A modal DFC's land back is not in the pie — `deckStats` keeps it out of `lands` — and is
   *  said beside it, the ledger's `+2 MDFC`. */
  it("counts modal DFC lands beside the pie, not in it", () => {
    render(
      <TypeBreakdown
        cards={[
          land("Forest", "Basic Land — Forest", 10),
          card({ name: "Turntimber", typeLine: "Sorcery // Land", layout: MODAL_DFC, quantity: 2 }),
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Land 10" })).toBeInTheDocument();
    expect(
      screen.getByText("Plus 2 modal double-faced cards with a land back, counted as spells."),
    ).toBeInTheDocument();
  });
});
