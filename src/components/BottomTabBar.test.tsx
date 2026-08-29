import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomTabBar } from "@/components/BottomTabBar";
import { NAV } from "@/components/nav";

const noDrops = { dragging: false, decks: null, wishlist: null };

describe("the bottom tab bar", () => {
  it("draws every destination", () => {
    render(<BottomTabBar activeView="search" onSelect={() => {}} {...noDrops} />);
    for (const entry of NAV) {
      expect(
        screen.getByRole("button", { name: new RegExp(entry.label, "i") }),
      ).toBeInTheDocument();
    }
  });

  /**
   * The rail says which entry is the open view with `aria-current`, and a second drawing of
   * navigation that said it a different way would be two answers to one question.
   */
  it("marks the open view the way the rail does", () => {
    render(<BottomTabBar activeView="decks" onSelect={() => {}} {...noDrops} />);
    const decks = screen.getByRole("button", { name: /decks/i });
    expect(decks).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /search/i })).not.toHaveAttribute("aria-current");
  });

  it("reports the press", async () => {
    const onSelect = vi.fn();
    render(<BottomTabBar activeView="search" onSelect={onSelect} {...noDrops} />);
    await userEvent.click(screen.getByRole("button", { name: /wishlist/i }));
    expect(onSelect).toHaveBeenCalledWith("wishlist");
  });

  /**
   * The token shipped in PR #274 published and deliberately unapplied, for this. An inline
   * style rather than an arbitrary-value class: a mistyped arbitrary value emits **nothing**,
   * silently, with `tsc` and this suite both green.
   */
  it("sits inside the safe area", () => {
    const { container } = render(
      <BottomTabBar activeView="search" onSelect={() => {}} {...noDrops} />,
    );
    const bar = container.querySelector("nav");
    expect(bar).toHaveStyle({ paddingBottom: "var(--safe-b)" });
  });
});
