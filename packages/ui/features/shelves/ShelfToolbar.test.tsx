import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLD_PAUSED_REASON, ShelfToolbar } from "./ShelfToolbar";

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

  /** The words both pages pass, fenced as a literal so a rewording is a diff about them. */
  it("says why folding is paused in one sentence", () => {
    expect(FOLD_PAUSED_REASON).toBe("Collapsing is paused while filtering");
  });

  /**
   * **Collapse is suspended while a filter is on** (spec §3.4), so Expand all and Collapse all are
   * refused in the open: `aria-disabled` with the reason as their description, still in the tab
   * order — a `disabled` button leaves it, which would put the reason on a hover a keyboard reader
   * cannot perform — and a press, by pointer or by key, writes nothing. Add folder is not about
   * folding and is untouched.
   */
  it("pauses Expand all and Collapse all while a filter is on, and leaves Add folder alone", async () => {
    const user = userEvent.setup();
    render(
      <ShelfToolbar
        onAddFolder={onAddFolder}
        onExpandAll={onExpandAll}
        onCollapseAll={onCollapseAll}
        foldPaused={FOLD_PAUSED_REASON}
      />,
    );

    for (const name of ["Expand all", "Collapse all"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toHaveAttribute("disabled");
      expect(button).toHaveAccessibleDescription(FOLD_PAUSED_REASON);
      expect(button.classList.contains("opacity-60")).toBe(true);
      await user.click(button);
      button.focus();
      expect(button).toHaveFocus();
      await user.keyboard("{Enter}");
    }
    expect(onExpandAll).not.toHaveBeenCalled();
    expect(onCollapseAll).not.toHaveBeenCalled();

    const add = screen.getByRole("button", { name: "Add folder" });
    expect(add).not.toHaveAttribute("aria-disabled");
    await user.click(add);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });

  /** Absent is today's behaviour exactly: no mark, no description, and the presses write. */
  it("carries no pause without the prop", () => {
    render(<ShelfToolbar onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} />);
    for (const name of ["Expand all", "Collapse all"]) {
      const button = screen.getByRole("button", { name });
      expect(button).not.toHaveAttribute("aria-disabled");
      expect(button).not.toHaveAccessibleDescription();
    }
  });
});
