import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GrimoireMark } from "./GrimoireMark";

/**
 * Every stroked path on one mark, keyed by the path it draws.
 *
 * Keyed by `d`, because that is what makes the two variants comparable at all: the small one is
 * a *rendering* of the master rather than a second drawing, so a path it keeps carries the same
 * coordinates and only its width moves. **Nothing here restates a number the component states.**
 * A test asserting `2.38` would have to be edited every time `SMALL_STROKE` is tuned — which is
 * the opposite of a guard, since the edit that breaks the drawing is the same edit that repairs
 * the test.
 *
 * `path[d]` rather than every stroked element: the full variant's page-block `<rect>` has a
 * stroke and no `d`, and it is one of the things the floor drops, so it has no counterpart to be
 * compared against.
 */
function strokedPaths(root: ParentNode): Map<string, number> {
  const widths = new Map<string, number>();
  for (const path of root.querySelectorAll("path[d][stroke-width]")) {
    widths.set(path.getAttribute("d")!, Number(path.getAttribute("stroke-width")));
  }
  return widths;
}

/** The paths painted from a `<defs>` entry rather than drawn — on this mark, the spell diamond. */
function gradientFilled(root: ParentNode): Element[] {
  return [...root.querySelectorAll("path")].filter((path) =>
    path.getAttribute("fill")?.startsWith("url("),
  );
}

describe("GrimoireMark", () => {
  /**
   * The component's one branch, and the reason it is worth a test at all: the variant is picked
   * from a **rendered size** rather than from a flag a caller passes, so nothing at a call site
   * says which drawing it is going to get. A floor that moved — or an `<=` where a `<` belongs —
   * puts the fine artwork into a 20px title bar, where the logo package says it fills in.
   *
   * Asserted on structure rather than on a class name: `<circle>` and `<linearGradient>` are
   * elements only the full variant emits (the casting circle, its inner ring, the clasp's two
   * rivets, and the diamond's gradient), so a variant switch that regressed cannot pass this by
   * keeping a class and changing what it draws.
   *
   * `linearGradient` is matched case-sensitively here and that is correct rather than fragile: a
   * type selector is lowercased only against HTML elements, and this one is in the SVG namespace
   * — `lineargradient` finds nothing.
   */
  it("draws the full mark at the detail floor and the simplified one a pixel under it", () => {
    const { container: under } = render(<GrimoireMark size={23} />);
    const { container: at } = render(<GrimoireMark size={24} />);

    expect(under.querySelectorAll("circle")).toHaveLength(0);
    expect(under.querySelectorAll("linearGradient")).toHaveLength(0);
    expect(at.querySelectorAll("circle").length).toBeGreaterThan(0);
    expect(at.querySelectorAll("linearGradient")).toHaveLength(1);

    // Strictly fewer paths, never other ones — the small variant subtracts and adds nothing.
    expect(strokedPaths(under).size).toBeLessThan(strokedPaths(at).size);
  });

  /**
   * **The whole reason `useId` is in the file**, and the one failure here that is invisible
   * rather than ugly. A constant gradient id is legal-looking markup: two marks on one screen
   * both carry `<defs>`, both resolve, and the second one paints from the *first* one's — which
   * looks identical until the day the two are drawn at different sizes or different colours, and
   * then one diamond is lit by the other mark's ramp.
   *
   * Two sizes rather than two of the same, because that is the case that would show it on screen.
   *
   * The ids are compared as strings and never built into a selector: how `useId` spells a value
   * is React's business and has changed between minor versions (`«r0»`, `_r_0_`), and an id
   * selector would have to escape whatever it picks next.
   */
  it("gives every mark on a screen a gradient of its own", () => {
    const { container } = render(
      <>
        <GrimoireMark size={64} />
        <GrimoireMark size={128} />
      </>,
    );

    const marks = [...container.querySelectorAll("svg")];
    expect(marks).toHaveLength(2);

    const ids = marks.map((mark) => mark.querySelector("linearGradient")?.getAttribute("id"));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);

    // And each diamond paints from the `<defs>` inside its own `<svg>`, not from a sibling's.
    marks.forEach((mark, i) => {
      const diamond = gradientFilled(mark);
      expect(diamond).toHaveLength(1);
      expect(diamond[0]).toHaveAttribute("fill", `url(#${ids[i]})`);
    });
  });

  /**
   * The small variant sidesteps the collision above rather than solving it: at 20px the diamond
   * is about four pixels across, which is no room for three stops, so it fills flat and ships no
   * `<defs>` at all. There is then nothing for a duplicate id to be a duplicate *of*.
   *
   * `currentColor` and not a hex, so the caller's `text-*` still reaches the one filled shape on
   * the mark — the flat fill is a simplification of the gradient, not an opt-out of the colour
   * contract.
   */
  it("ships no gradient to collide below the floor", () => {
    const { container } = render(<GrimoireMark size={20} />);

    expect(container.querySelector("defs")).toBeNull();
    expect(gradientFilled(container)).toHaveLength(0);
    // `fill-opacity` is the small variant's own attribute and the diamond is its only bearer.
    expect(container.querySelector("path[fill-opacity]")).toHaveAttribute("fill", "currentColor");
  });

  /**
   * Hidden by default, which **inverts `GameChangerMark`'s rule on purpose**. That glyph states a
   * fact about a card written nowhere else on the tile, so it has to name itself; this one is the
   * app's name, and every surface that draws it sets that name in type two millimetres away — the
   * caption's wordmark, the first run's heading. A mark that named itself there would put the
   * product name into the accessibility tree twice in a row.
   */
  it("stays out of the accessibility tree by default", () => {
    const { container } = render(<GrimoireMark size={64} />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  /** The exception the default exists for: a surface drawing the mark *instead of* the words. */
  it("takes a name when a surface draws it instead of the words", () => {
    const { container } = render(<GrimoireMark size={64} label="MTG Grimoire" />);

    expect(screen.getByRole("img", { name: "MTG Grimoire" })).toBeInTheDocument();
    // Named *and* hidden would be a name nothing can reach — the two branches are exclusive.
    expect(container.querySelector("svg")).not.toHaveAttribute("aria-hidden");
  });

  /**
   * `size` moves the box and nothing else. The artwork stays on the 64 unit grid the logo package
   * draws it on, which is what lets the same file answer a 20px caption and a 1024px render — and
   * a `viewBox` that tracked the size instead would make the package's centring transform a
   * different crop at every call site.
   *
   * Both sides of the floor are in the list: the variant is a change of *drawing*, never a change
   * of frame.
   */
  it("sets the box from `size` and leaves the artwork on its own grid", () => {
    for (const size of [20, 23, 24, 64, 128]) {
      const { container } = render(<GrimoireMark size={size} />);
      const svg = container.querySelector("svg");

      expect(svg).toHaveAttribute("width", String(size));
      expect(svg).toHaveAttribute("height", String(size));
      expect(svg).toHaveAttribute("viewBox", "0 0 64 64");
    }
  });

  /**
   * Dropping the fine groups is only half of what the floor does. The outline that survives is
   * still drawn at `size / 64` units per pixel — half a pixel at 20px — and a mark whose heaviest
   * stroke is half a pixel reads as a smudge rather than as a book, so every kept stroke is
   * thickened together.
   *
   * Asserted as a **relationship**, per path, with no number written down on either side. That
   * buys two claims at once: each stroke got heavier, and the small variant draws *only* paths
   * the full one draws — which is the "rendering of the master, not a second drawing" contract,
   * and the thing that would break first if somebody tuned the small variant by editing its
   * coordinates instead of its one multiplier.
   */
  it("draws every stroke it keeps heavier than the full mark draws it", () => {
    const small = strokedPaths(render(<GrimoireMark size={20} />).container);
    const full = strokedPaths(render(<GrimoireMark size={64} />).container);

    expect(small.size).toBeGreaterThan(0);
    for (const [d, width] of small) {
      const master = full.get(d);
      expect(master).toBeDefined();
      expect(width).toBeGreaterThan(master!);
    }
  });

  /**
   * `shrink-0` is the component's, the rest is the caller's — `GameChangerMark`'s split.
   *
   * The class is load-bearing and the failure it prevents is invisible to jsdom: every surface
   * that draws this puts it first in a flex row beside type that is allowed to truncate, so
   * without it the *mark* is what gives way and the name wins the row. Sweeping for the class is
   * all a layout-free renderer can do about that, which is why it is worth one line here.
   */
  it("keeps its own `shrink-0` and takes the caller's colour", () => {
    const { container } = render(<GrimoireMark size={20} className="text-accent" />);

    expect(container.querySelector("svg")).toHaveClass("shrink-0", "text-accent");
  });
});
