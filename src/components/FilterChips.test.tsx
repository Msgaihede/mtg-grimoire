import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FILTER_CONTROL, FILTER_FOCUS, ManaValueChips, ResetAll, ToggleChip } from "./FilterChips";

describe("ToggleChip", () => {
  it("says what it is and whether it is on", async () => {
    const onClick = vi.fn();
    render(<ToggleChip label="Owned" pressed={false} onClick={onClick} />);

    const chip = screen.getByRole("button", { name: "Owned" });
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);

    expect(onClick).toHaveBeenCalled();
  });

  it("shows its on state without relying on colour alone", () => {
    render(<ToggleChip label="Foil" pressed onClick={vi.fn()} />);

    // The border moves to gold *and* `aria-pressed` says so — the gold alone would be a
    // state only a sighted reader with a good monitor can read.
    const chip = screen.getByRole("button", { name: "Foil" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveClass("border-accent");
  });
});

/**
 * The reason these live in one module rather than in `FilterBar`: the collection view gets
 * *the same filter row*, not a lookalike. Every control in it is 36px tall and takes the
 * same gold focus outline, and the two shared strings are what makes that true by
 * construction instead of by three people copying a class list.
 */
describe("the shared filter row", () => {
  it("gives every control one height and one focus outline", () => {
    render(
      <>
        <ToggleChip label="Owned" pressed={false} onClick={vi.fn()} />
        <ManaValueChips selected={[]} onToggle={vi.fn()} />
        <ResetAll count={1} onReset={vi.fn()} />
      </>,
    );

    // `h-9` or `size-9`: the square chips set both dimensions at once, and `cn`'s
    // tailwind-merge drops the `h-9` that `FILTER_CONTROL` contributed as the redundant
    // half of that pair. Both are 36px, which is the thing that has to be true.
    expect(FILTER_CONTROL).toContain("h-9");
    const outline = FILTER_FOCUS.split(" ");
    for (const control of screen.getAllByRole("button")) {
      expect(control.className, control.textContent ?? "").toMatch(/\b(h-9|size-9)\b/);
      expect(control, control.textContent ?? "").toHaveClass(...outline);
    }
  });
});

describe("ResetAll", () => {
  /** A control that spends most of its life disabled teaches the reader to stop looking
   *  at it, so it is absent rather than dimmed. */
  it("keeps out of the way until there is something to reset", () => {
    const { rerender } = render(<ResetAll count={0} onReset={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<ResetAll count={2} onReset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /reset all/i })).toHaveTextContent("2");
  });

  it("counts kinds of filter, not values, and clears them", async () => {
    const onReset = vi.fn();
    render(<ResetAll count={3} onReset={onReset} />);

    await userEvent.click(screen.getByRole("button", { name: /reset all/i }));

    expect(onReset).toHaveBeenCalled();
  });
});
