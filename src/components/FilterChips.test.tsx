import { render, screen, within } from "@testing-library/react";
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
  /**
   * The bordered chips only. `ManaChip` is deliberately outside this: it is a 36px circle
   * carrying a printed symbol on its own fill, and its focus outline stands 5px off rather
   * than 2 so that a chip which is both focused and pressed shows the outline clear of the
   * ring. One exemption, for a reason, rather than a rule with no exceptions and no chips.
   */
  it("gives the bordered chips one height and one focus outline", () => {
    render(
      <>
        <ToggleChip label="Owned" pressed={false} onClick={vi.fn()} />
        {/* X wired, so the sweep below covers the tenth chip too: it is drawn by the same
            component as its neighbours and has to stay indistinguishable from them. */}
        <ManaValueChips selected={[]} onToggle={vi.fn()} xSelected={false} onToggleX={vi.fn()} />
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

/**
 * X, which is not a mana value and rides the mana-value group anyway.
 *
 * It is the last chip of that group because it answers the question the group asks — "what
 * does this cost" — and `cmc` counts `{X}` as zero, so the two axes overlap rather than
 * compete: `{X}{B}{B}{B}` is a 3 *and* an X, and both chips find it.
 */
describe("the X chip", () => {
  const chips = (over: Partial<Parameters<typeof ManaValueChips>[0]> = {}) => (
    <ManaValueChips
      selected={[]}
      onToggle={vi.fn()}
      xSelected={false}
      onToggleX={vi.fn()}
      {...over}
    />
  );

  /**
   * The letter is drawn and the sentence is spoken. A chip reading `X` next to one reading
   * `8+` is a puzzle to anyone who cannot see the group heading — and the visible text is
   * inside the spoken name (WCAG 2.5.3), so the chip is still addressable by what is on it.
   */
  it("draws one letter and says the whole thing", async () => {
    const onToggleX = vi.fn();
    render(chips({ onToggleX }));

    const chip = screen.getByRole("button", { name: "Cards with X in their mana cost" });
    expect(chip).toHaveTextContent("X");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);

    expect(onToggleX).toHaveBeenCalled();
  });

  /** Last, and inside the group — a stray control beside it would read as a different
   *  question, which is exactly what it is not. */
  it("rides at the end of the mana-value group", () => {
    render(chips());

    const group = screen.getByRole("group", { name: "Mana value" });
    const names = within(group)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));

    expect(names).toHaveLength(10);
    expect(names[8]).toBe("Mana value 8 or more");
    expect(names[9]).toBe("Cards with X in their mana cost");
  });

  /**
   * Both axes at once, which is the whole point of the chip being additive: a reader who
   * wants "three-drops, and anything with an X" presses both and the row says so.
   */
  it("is on independently of the numerals", () => {
    render(chips({ selected: [3], xSelected: true }));

    expect(screen.getByRole("button", { name: "Mana value 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Cards with X in their mana cost" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * `aria-disabled` and never the attribute — a `disabled` button leaves the tab order, and
   * the filter row greys as the reader types. The caller's sentence replaces the plain label
   * outright rather than joining it, so a greyed chip explains itself in the one voice the
   * rest of the row uses.
   */
  it("greys without leaving the tab order, and says why", async () => {
    const onToggleX = vi.fn();
    render(
      chips({
        onToggleX,
        xDisabled: true,
        xTitle: (label) => `${label} — nothing in this search`,
      }),
    );

    const chip = screen.getByRole("button", {
      name: "Cards with X in their mana cost — nothing in this search",
    });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).not.toBeDisabled();

    await userEvent.click(chip);

    expect(onToggleX).not.toHaveBeenCalled();
  });

  /** No toggle, no chip. A chip that reports nothing is worse than a filter the row does not
   *  offer, so the two cannot come apart — which is what lets the numeric row be drawn alone. */
  it("is absent when nothing is listening for it", () => {
    render(<ManaValueChips selected={[]} onToggle={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /Cards with X/ })).not.toBeInTheDocument();
  });
});

describe("ResetAll", () => {
  /**
   * It holds its place with nothing to clear, because the alternative moves the row: both
   * filter bars put a `flex-1` search box left of the chips, so a button that appeared on the
   * first press would take its width out of that box and slide every chip to its right left,
   * under the finger that just pressed one.
   */
  it("holds its place, greyed, when there is nothing to reset", () => {
    const { rerender } = render(<ResetAll count={0} onReset={vi.fn()} />);
    const reset = screen.getByRole("button", { name: /^Reset all/ });
    expect(reset).toHaveAttribute("aria-disabled", "true");

    rerender(<ResetAll count={2} onReset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Reset all/ })).not.toHaveAttribute("aria-disabled");
  });

  /** `aria-disabled`, never the attribute — the button is still focusable, and still ignores
   *  the press. */
  it("stays reachable and does nothing when it is greyed", async () => {
    const onReset = vi.fn();
    render(<ResetAll count={0} onReset={onReset} />);

    const reset = screen.getByRole("button", { name: /^Reset all/ });
    reset.focus();
    expect(reset).toHaveFocus();

    await userEvent.click(reset);

    expect(onReset).not.toHaveBeenCalled();
  });

  it("counts kinds of filter, not values, and clears them", async () => {
    const onReset = vi.fn();
    render(<ResetAll count={3} onReset={onReset} />);

    await userEvent.click(screen.getByRole("button", { name: /reset all/i }));

    expect(onReset).toHaveBeenCalled();
  });

  /**
   * The badge is drawn and not spoken: left in the accessible name it arrives with no
   * separator before it — `"Reset all6"`, measured 2026-08-09 — which drawn-always would be
   * `"Reset all0"` on every quiet row in the app. The count is said in words instead, after
   * the visible label (WCAG 2.5.3).
   */
  it("says the count in words and draws it as a badge", () => {
    const { rerender } = render(<ResetAll count={0} onReset={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Reset all — 0 filters active");
    expect(screen.getByRole("button")).toHaveTextContent("0");

    rerender(<ResetAll count={1} onReset={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Reset all — 1 filter active");

    rerender(<ResetAll count={2} onReset={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Reset all — 2 filters active");
    expect(screen.getByRole("button")).toHaveTextContent("2");
  });
});
