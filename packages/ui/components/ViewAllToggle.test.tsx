import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ViewAllToggle } from "./ViewAllToggle";

describe("ViewAllToggle", () => {
  /** A toggle named by its words and what they are all of (WCAG 2.5.3), pressed or not. */
  it("is a toggle named for what it shows, and says whether it is on", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ViewAllToggle pressed={false} onToggle={onToggle} name="View all cards" />,
    );

    const button = screen.getByRole("button", { name: "View all cards" });
    expect(button).toHaveTextContent("View all");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button.classList.contains("border-accent")).toBe(false);

    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ViewAllToggle pressed onToggle={onToggle} name="View all cards" />);
    expect(button).toHaveAttribute("aria-pressed", "true");
    // The accent edge is the pressed mark, as the filter row's chips wear it.
    expect(button.classList.contains("border-accent")).toBe(true);
  });

  /** The ref is where a page hands the caret when Escape leaves the flat wall. */
  it("hands its button to a ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<ViewAllToggle pressed={false} onToggle={() => {}} name="View all wishes" ref={ref} />);
    expect(ref.current).toBe(screen.getByRole("button", { name: "View all wishes" }));
  });
});
