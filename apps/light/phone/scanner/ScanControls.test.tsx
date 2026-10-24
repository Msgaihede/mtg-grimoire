import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScanControls } from "./ScanControls";

function controls(over: Partial<Parameters<typeof ScanControls>[0]> = {}) {
  const props = {
    pointAndShoot: false,
    onPointAndShoot: vi.fn(),
    onFilters: vi.fn(),
    onOptions: vi.fn(),
    ...over,
  };
  render(<ScanControls {...props} />);
  return props;
}

describe("the controls over the picture", () => {
  it("draws how scanning runs as two pressed-or-not halves of one group, at the touch floor", () => {
    controls();
    const group = screen.getByRole("group", { name: "How scanning runs" });
    const halves = within(group).getAllByRole("button");
    expect(halves.map((half) => half.textContent)).toEqual(["Continuous", "Point & shoot"]);
    expect(halves[0]).toHaveAttribute("aria-pressed", "true");
    expect(halves[1]).toHaveAttribute("aria-pressed", "false");
    for (const half of halves) expect(half).toHaveClass("h-11");
  });

  it("switches to point and shoot, and back, and does nothing for the half already pressed", async () => {
    const props = controls();
    const group = screen.getByRole("group", { name: "How scanning runs" });
    await userEvent.click(within(group).getByRole("button", { name: "Continuous" }));
    expect(props.onPointAndShoot).not.toHaveBeenCalled();
    await userEvent.click(within(group).getByRole("button", { name: "Point & shoot" }));
    expect(props.onPointAndShoot).toHaveBeenCalledWith(true);
  });

  it("presses Point & shoot when that is the stored way", async () => {
    const props = controls({ pointAndShoot: true });
    expect(screen.getByRole("button", { name: "Point & shoot" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continuous" }));
    expect(props.onPointAndShoot).toHaveBeenCalledWith(false);
  });

  /**
   * **Both words whole on a phone on its side** (measured: *Point & shoot* is 87px in its pressed
   * weight). The pair asks for 13.25rem there — 89px of words a half — and beside the rail the
   * two glyphs wrap under it rather than cut a word; never upright, and never below 600px wide,
   * where the height is what the page has least of.
   */
  it("keeps the pair's words whole on its side, the glyphs wrapping under it beside the rail", () => {
    controls();
    const group = screen.getByRole("group", { name: "How scanning runs" });
    expect(group).toHaveClass("flex-1", "landscape:flex-[1_1_13.25rem]");
    const row = group.parentElement as HTMLElement;
    expect(row).toHaveClass("landscape:min-[600px]:flex-wrap", "landscape:min-[600px]:justify-end");
    expect(row).not.toHaveClass("flex-wrap", "landscape:flex-wrap");
  });

  /** Start and Stop are the page's gold press under the picture, and point and shoot is a hold. */
  it("draws no Start, Stop or Scan of its own", () => {
    controls();
    expect(screen.queryByRole("button", { name: /^(Start|Stop|Scan)$/ })).toBeNull();
    // One scanner, so no mode to pick either.
    for (const name of ["Fast", "Exact", "Neural"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("opens the filters and the options as two 44px glyphs, each handing its press over", async () => {
    const props = controls();
    const filters = screen.getByRole("button", { name: "Filters" });
    const options = screen.getByRole("button", { name: "Scanner options" });
    for (const press of [filters, options]) {
      expect(press).toHaveAttribute("aria-haspopup", "dialog");
      expect(press).toHaveClass("w-11", "min-h-11");
    }
    await userEvent.click(filters);
    expect(props.onFilters).toHaveBeenCalledWith(filters);
    expect(props.onOptions).not.toHaveBeenCalled();
    await userEvent.click(options);
    expect(props.onOptions).toHaveBeenCalledWith(options);
  });
});
