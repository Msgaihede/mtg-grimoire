import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { card } from "../validation/fixtures";
import { DEFAULT_ODDS, OpeningHandOdds } from "./OpeningHandOdds";

/** A 100-card Commander deck: one commander, 99 in the library — 30 of them creatures. */
const EDH = [
  card({
    name: "Kenrith, the Returned King",
    categoryKind: "commander",
    typeLine: "Legendary Creature — Human Noble",
  }),
  card({ name: "Llanowar Elves", typeLine: "Creature — Elf Druid", quantity: 30 }),
  card({ name: "Forest", typeLine: "Basic Land — Forest", quantity: 69 }),
];

const odds = (by: "cardName" | "types") =>
  render(<OpeningHandOdds cards={EDH} by={by} odds={DEFAULT_ODDS} onOddsChange={vi.fn()} />);

/** The `Qty` cell of the row a bucket's label heads. */
const qty = (label: string) =>
  screen.getByRole("rowheader", { name: label }).closest("tr")?.querySelectorAll("td")[0]
    ?.textContent;

describe("OpeningHandOdds' library (issue #1163)", () => {
  it("draws out of the 99 cards in the library, not the 100 the format counts", () => {
    odds("types");

    expect(screen.getByRole("table")).toHaveAccessibleName(/out of 99 cards\.$/);
  });

  it("lists no row for the commander under a Card name cut", () => {
    odds("cardName");

    expect(screen.queryByRole("rowheader", { name: "Kenrith, the Returned King" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: "Llanowar Elves" })).toBeInTheDocument();
  });

  it("does not count the commander toward the Creature row", () => {
    odds("types");

    expect(qty("Creature")).toBe("30");
  });
});
