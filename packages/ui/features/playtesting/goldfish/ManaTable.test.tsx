import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { manaTable } from "./fixtures";
import { ManaTableView } from "./ManaTable";

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);

describe("ManaTableView", () => {
  it("draws a column per type, WUBRG then colorless, with what the open sources make", () => {
    render(<ManaTableView mana={manaTable([1, 1, 0, 0, 2, 2])} />);
    const table = screen.getByRole("table", { name: "Mana" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["White", "Blue", "Black", "Red", "Green", "Colorless"]);
    expect(cells(screen.getByRole("row", { name: /^Open/ }))).toEqual([
      "1",
      "1",
      "0",
      "0",
      "2",
      "2",
    ]);
  });

  it("adds the pool's row only while mana is floating", () => {
    const { rerender } = render(<ManaTableView mana={manaTable([0, 0, 0, 1])} />);
    expect(screen.queryByRole("row", { name: /^Pool/ })).toBeNull();
    rerender(<ManaTableView mana={manaTable([0, 0, 0, 1], [0, 0, 0, 3])} label="Your mana" />);
    expect(screen.getByRole("table", { name: "Your mana" })).toBeTruthy();
    expect(cells(screen.getByRole("row", { name: /^Pool/ }))).toEqual([
      "0",
      "0",
      "0",
      "3",
      "0",
      "0",
    ]);
  });
});
