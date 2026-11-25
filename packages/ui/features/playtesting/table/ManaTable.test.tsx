import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("draws the pool as steppers with the sandbox on, and sends what a press adds or takes", () => {
    const onPool = vi.fn();
    const { rerender } = render(
      <ManaTableView mana={manaTable([0, 0, 0, 1], [0, 0, 0, 0, 2])} onPool={onPool} />,
    );
    expect(screen.getByRole("row", { name: /^Pool/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Increase White mana in your pool" }));
    expect(onPool).toHaveBeenLastCalledWith("white", 1);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Green mana in your pool" }));
    expect(onPool).toHaveBeenLastCalledWith("green", -1);
    const red = screen.getByRole("spinbutton", { name: "Red mana in your pool" });
    fireEvent.change(red, { target: { value: "3" } });
    fireEvent.keyDown(red, { key: "Enter" });
    fireEvent.blur(red);
    expect(onPool).toHaveBeenLastCalledWith("red", 3);

    // With its moves not working now, the steppers are there but cannot be pressed.
    onPool.mockClear();
    rerender(<ManaTableView mana={manaTable([], [])} onPool={onPool} poolDisabled />);
    const add = screen.getByRole("button", { name: "Increase Blue mana in your pool" });
    expect(add.closest("fieldset")?.disabled).toBe(true);
  });
});
