import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";

const search = (over: Record<string, unknown> = {}) =>
  ({
    text: "",
    setText: vi.fn(),
    format: "",
    setFormat: vi.fn(),
    colors: [] as string[],
    toggleColor: vi.fn(),
    sets: [] as string[],
    toggleSet: vi.fn(),
    manaValues: [] as number[],
    toggleManaValue: vi.fn(),
    activeCount: 0,
    resetAll: vi.fn(),
    ...over,
  }) as unknown as Parameters<typeof FilterBar>[0]["search"];

vi.mock("./SetCombobox", () => ({
  SetCombobox: () => <div data-testid="set-combobox" />,
}));

describe("FilterBar", () => {
  /**
   * The direction is explicit: real symbols, not letters in circles. The glyph comes from
   * the bundled `mana-font`, so the class is the assertion — a letter `W` rendered as text
   * would pass a text query and be exactly the generic thing this replaced.
   */
  it("draws the colour filter with real mana symbols", () => {
    render(<FilterBar search={search()} />);

    const white = screen.getByRole("button", { name: "White" });
    expect(white.querySelector(".ms.ms-w")).not.toBeNull();
    expect(white).toHaveAttribute("aria-pressed", "false");
    // Colourless is a chip like the others, not an afterthought.
    expect(
      screen.getByRole("button", { name: "Colorless" }).querySelector(".ms.ms-c"),
    ).not.toBeNull();
  });

  it("shows which colours are on", () => {
    render(<FilterBar search={search({ colors: ["U"] })} />);

    expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles a colour", async () => {
    const toggleColor = vi.fn();
    render(<FilterBar search={search({ toggleColor })} />);

    await userEvent.click(screen.getByRole("button", { name: "Green" }));

    expect(toggleColor).toHaveBeenCalledWith("G");
  });

  it("offers mana values 0 through 8 or more", async () => {
    const toggleManaValue = vi.fn();
    render(<FilterBar search={search({ toggleManaValue })} />);

    expect(screen.getByRole("button", { name: "Mana value 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mana value 8 or more" })).toHaveTextContent("8+");

    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));

    expect(toggleManaValue).toHaveBeenCalledWith(3);
  });

  /** Nothing to reset, nothing to say — an always-visible Reset is a control that is
   *  disabled most of the time, which reads as broken. */
  it("hides Reset all until something is filtered", () => {
    render(<FilterBar search={search()} />);

    expect(screen.queryByRole("button", { name: /reset all/i })).not.toBeInTheDocument();
  });

  it("counts what Reset all would clear, and clears it", async () => {
    const resetAll = vi.fn();
    render(<FilterBar search={search({ activeCount: 3, colors: ["W"], resetAll })} />);

    const reset = screen.getByRole("button", { name: /reset all/i });
    expect(reset).toHaveTextContent("3");

    await userEvent.click(reset);

    expect(resetAll).toHaveBeenCalled();
  });
});
