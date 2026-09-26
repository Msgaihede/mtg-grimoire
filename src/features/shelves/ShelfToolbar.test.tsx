import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfToolbar } from "./ShelfToolbar";

const onAddFolder = vi.fn();
const onExpandAll = vi.fn();
const onCollapseAll = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
});

describe("ShelfToolbar", () => {
  it("offers Add folder, Expand all and Collapse all, in that order, and each does its own thing", async () => {
    const user = userEvent.setup();
    render(
      <ShelfToolbar onAddFolder={onAddFolder} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} />,
    );

    const group = screen.getByRole("group", { name: "Shelves" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Add folder", "Expand all", "Collapse all"]);
    expect(buttons[0]).toHaveAccessibleName("Add folder");

    await user.click(buttons[0]);
    await user.click(buttons[1]);
    await user.click(buttons[2]);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });

  /** `canMakeFolder` false at this level — inside a deck group, Recently removed or a managed folder. */
  it("draws no Add folder where the level cannot hold one", () => {
    render(<ShelfToolbar onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} />);
    expect(screen.queryByRole("button", { name: "Add folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeInTheDocument();
  });
});
