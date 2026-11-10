import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  parsePrice,
  PRICE_ANCHORS,
  PRICE_POSITIONS,
  PriceRange,
  positionOfPrice,
  priceAtPosition,
  roundPrice,
  stepPrice,
} from "./PriceRange";

/**
 * The scale is the part of this control that can be wrong without looking wrong.
 *
 * A handle in the wrong place reads as a design choice; a handle whose position and whose number
 * disagree is a filter that lies about itself, and neither jsdom nor a screenshot can see it.
 */
describe("the price scale", () => {
  it("runs the anchors, each on its own equal share of the track", () => {
    const share = PRICE_POSITIONS / (PRICE_ANCHORS.length - 1);
    PRICE_ANCHORS.forEach((price, i) => {
      expect(priceAtPosition(i * share)).toBe(price);
      expect(positionOfPrice(price)).toBe(i * share);
    });
  });

  /**
   * The whole reason the ladder is not a line. A linear 0–1000 track would put every price a
   * reader actually filters by inside its first two percent; this spends 40% of the width below
   * five pounds, which is where the corpus is.
   */
  it("gives the cheap end most of the track", () => {
    expect(priceAtPosition(PRICE_POSITIONS * 0.4)).toBeLessThanOrEqual(5);
    expect(positionOfPrice(1)).toBe(PRICE_POSITIONS / 5);
  });

  /** A drag must never go backwards, which is a claim about every step and not about the ends. */
  it("never moves backwards as the handle moves forwards", () => {
    let previous = -1;
    for (let pos = 0; pos <= PRICE_POSITIONS; pos += 1) {
      const price = priceAtPosition(pos);
      expect(price).toBeGreaterThanOrEqual(previous);
      previous = price;
    }
  });

  /**
   * Every value a drag can produce is a number a shop would print — 2 decimal places under a
   * pound, quarters under ten, whole pounds under a hundred, fives above it.
   */
  it("rounds to a price a shop would print", () => {
    expect(roundPrice(0.37)).toBe(0.35);
    expect(roundPrice(3.4)).toBe(3.5);
    expect(roundPrice(42.4)).toBe(42);
    expect(roundPrice(317)).toBe(315);
    // Across its own first boundary, which is where a non-monotonic rounding would show.
    expect(roundPrice(0.975)).toBe(1);
  });

  /**
   * **An arrow key steps by price, not by position** (issue #1573). A native step is one of a
   * thousand positions, which rounds back to the price it started at almost everywhere on the
   * ladder; the next *distinct* price is what a press has to reach.
   */
  it("steps to the next distinct price either way, and reports the end of the ladder", () => {
    expect(stepPrice(0, 1)).toBe(0.05);
    expect(stepPrice(0.05, -1)).toBe(0);
    expect(stepPrice(1, 1)).toBe(1.25);
    expect(stepPrice(1000, -1)).toBe(995);
    expect(stepPrice(995, 1)).toBe(1000);
    // A typed number between two of the ladder's prices steps to its neighbours on the ladder.
    expect(stepPrice(7.31, 1)).toBe(7.5);
    expect(stepPrice(7.31, -1)).toBe(7.25);
    expect(stepPrice(1000, 1)).toBeUndefined();
    expect(stepPrice(2000, 1)).toBeUndefined();
    expect(stepPrice(0, -1)).toBeUndefined();
  });

  /** A number past the top anchor has nowhere further to go; the box beside it keeps the truth. */
  it("clamps a position to the track at both ends", () => {
    expect(positionOfPrice(-5)).toBe(0);
    expect(positionOfPrice(50_000)).toBe(PRICE_POSITIONS);
    expect(priceAtPosition(-1)).toBe(PRICE_ANCHORS[0]);
    expect(priceAtPosition(PRICE_POSITIONS + 1)).toBe(PRICE_ANCHORS[PRICE_ANCHORS.length - 1]);
  });

  /**
   * **A blank box is an open end and not a zero**, which is the distinction the whole control
   * rests on: `0` is a real and very narrow filter — it drops every printing the marketplace does
   * not price — and it must not be what an untouched field means.
   */
  it("reads a blank or half-typed box as an open end", () => {
    expect(parsePrice("")).toBeUndefined();
    expect(parsePrice("   ")).toBeUndefined();
    expect(parsePrice("abc")).toBeUndefined();
    expect(parsePrice("-2")).toBeUndefined();
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice("1.50")).toBe(1.5);
    // A comma decimal, because a keyboard laid out for one is what a European reader has.
    expect(parsePrice("1,5")).toBe(1.5);
  });
});

describe("PriceRange", () => {
  /**
   * The control **with its state above it**, which is the only honest way to drive it.
   *
   * `PriceRange` is controlled: every handler calls up and waits to be handed the new bounds
   * back. Rendered against fixed props it therefore looks broken in a way it never is on screen
   * — a typed character is re-seeded away on the next render, and a handler that writes the value
   * it was already given produces no `change` event at all. Both of those cost this file three
   * failures before the harness existed, and neither was a defect.
   */
  function Harness({
    min: initialMin,
    max: initialMax,
    currency = "usd",
    onChange,
  }: {
    min?: number;
    max?: number;
    currency?: "usd" | "eur";
    onChange: (min: number | undefined, max: number | undefined) => void;
  }) {
    const [band, setBand] = useState<[number | undefined, number | undefined]>([
      initialMin,
      initialMax,
    ]);
    return (
      <PriceRange
        min={band[0]}
        max={band[1]}
        currency={currency}
        onChange={(low, high) => {
          setBand([low, high]);
          onChange(low, high);
        }}
      />
    );
  }

  const range = (over: Partial<Parameters<typeof Harness>[0]> = {}) => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} {...over} />);
    return onChange;
  };

  const low = () => screen.getByRole("slider", { name: "Lowest price, slider" });
  const high = () => screen.getByRole("slider", { name: "Highest price, slider" });
  /**
   * Move a handle.
   *
   * **A `change` event and not a keypress**, because jsdom implements neither: a range input
   * there has no keyboard behaviour and no pointer geometry, so `userEvent` moves nothing and
   * the handler under test never runs. The event is what a real drag and a real arrow key both
   * produce, which is the boundary this component actually owns.
   */
  const drag = (handle: HTMLElement, pos: number) =>
    fireEvent.change(handle, { target: { value: String(pos) } });

  /** The last band the control asked for. `.at(-1)` is past this project's TS lib target. */
  const lastBand = (fn: ReturnType<typeof vi.fn>): (number | undefined)[] =>
    fn.mock.calls[fn.mock.calls.length - 1];

  /**
   * Both handles start at the ends of their own travel, and an end **is** the open state rather
   * than a clamp — otherwise a reader who touched a handle could never get back to an unfiltered
   * band, which is a control they cannot undo.
   */
  it("opens with both ends open, and says so rather than reading a number", () => {
    range();

    expect(low()).toHaveValue("0");
    expect(low()).toHaveAttribute("aria-valuetext", "No minimum");
    expect(high()).toHaveValue(String(PRICE_POSITIONS));
    expect(high()).toHaveAttribute("aria-valuetext", "No maximum");
  });

  /**
   * **The filled span is gold only when the band is a filter**, which a screenshot is the only
   * thing that would have caught: with both ends open the span covers the whole track, so an
   * unconditional accent draws a full-width gold bar across a tray nobody has touched — and gold
   * means *this is on* everywhere else on this row. Found in the shipped window on 2026-08-24;
   * every number about this control was already right.
   *
   * The class rather than the colour, because jsdom loads no stylesheet and computes every
   * `background-color` as `rgba(0, 0, 0, 0)` — the same reason the row's other paint rules are
   * swept as classes.
   */
  it("paints the band gold only once an end is bound", () => {
    const fill = () =>
      document
        .querySelector('input[type="range"]')!
        .parentElement!.querySelectorAll('[aria-hidden="true"]')[1];

    range();
    expect(fill().className).toContain("bg-border");
    expect(fill().className).not.toContain("bg-accent");

    range({ min: 5 });
    const bound = document
      .querySelectorAll('input[type="range"]')[2]
      .parentElement!.querySelectorAll('[aria-hidden="true"]')[1];
    expect(bound.className).toContain("bg-accent");

    // …and a *ceiling* alone is a filter too, which is the arm a `min`-only test would miss.
    range({ max: 5 });
    const capped = document
      .querySelectorAll('input[type="range"]')[4]
      .parentElement!.querySelectorAll('[aria-hidden="true"]')[1];
    expect(capped.className).toContain("bg-accent");
  });

  /**
   * The number, spoken. A screen reader reading "480" off a thousand-position track would be
   * hearing the mechanism instead of the filter, so the position is the value and the price is
   * the `aria-valuetext`.
   */
  it("speaks the price rather than the position", () => {
    range({ min: 2, max: 40 });

    expect(low()).toHaveAttribute("aria-valuetext", "$2.00");
    expect(high()).toHaveAttribute("aria-valuetext", "$40.00");
    // The marketplace's own money, never a bare dollar — the caller hands the currency in.
    range({ min: 2, currency: "eur" });
    expect(screen.getAllByRole("slider", { name: "Lowest price, slider" })[1]).toHaveAttribute(
      "aria-valuetext",
      "€2.00",
    );
  });

  it("turns a handle into a rounded price, and the far end into no bound at all", () => {
    const onChange = range();

    drag(low(), 337);
    const [min] = lastBand(onChange);
    expect(min).toBe(priceAtPosition(337));
    expect(roundPrice(min as number)).toBe(min);

    // **The far end is open, not clamped.** A maximum handle at the top of its travel means "no
    // ceiling" rather than "at most a thousand pounds", which is the only way back to an
    // unfiltered band once a handle has been touched.
    drag(high(), PRICE_POSITIONS);
    expect(lastBand(onChange)[1]).toBeUndefined();
    drag(low(), 0);
    expect(lastBand(onChange)[0]).toBeUndefined();
  });

  /**
   * Pushed rather than blocked, which is what every dual slider in a shop does. Refusing the drag
   * instead leaves the handle stuck under the pointer with no way to say why.
   */
  it("carries the other end along when one is dragged past it", () => {
    const onChange = range({ min: 1, max: 2 });

    drag(low(), positionOfPrice(20));
    const [min, max] = lastBand(onChange);
    expect(min).toBe(20);
    expect(max).toBe(20);

    // …and the same in the other direction, which is a separate arm rather than a symmetry to
    // assume: the maximum's handler pushes the *minimum*.
    const other = range({ min: 10, max: 20 });
    drag(screen.getAllByRole("slider", { name: "Highest price, slider" })[1], positionOfPrice(2));
    expect(lastBand(other)).toEqual([2, 2]);
  });

  /**
   * **One notch per press, from either end** (issue #1573). A native arrow step moved the handle
   * one position, which rounded back to the price it was already at: the floor never left `0` —
   * and worse, turned on a `≥ 0` filter that hides every unpriced printing — and the ceiling
   * stuck four positions in.
   *
   * A keydown is what drives this, because the handler steps by price and suppresses the native
   * step; jsdom has no native step to suppress, which is exactly why `fireEvent.keyDown`'s return
   * value is checked — `false` is the `preventDefault` a real WebView depends on.
   */
  it("moves a handle one price per arrow key, and never moves it in place", () => {
    const onChange = range();

    const mins: (number | undefined)[] = [];
    for (let i = 0; i < 20; i += 1) {
      expect(fireEvent.keyDown(low(), { key: i % 2 === 0 ? "ArrowRight" : "ArrowUp" })).toBe(false);
      mins.push(lastBand(onChange)[0]);
    }
    // The first press lands on a real price and not on the zero floor.
    expect(mins[0]).toBe(0.05);
    mins.forEach((price, i) => {
      expect(price).toBe(roundPrice(price as number));
      if (i > 0) expect(price).toBeGreaterThan(mins[i - 1] as number);
    });
    expect(Number((low() as HTMLInputElement).value)).toBeGreaterThan(0);

    // Back down to the left edge, which is the open floor and not a `0` filter.
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(low(), { key: "ArrowLeft" });
    expect(lastBand(onChange)[0]).toBeUndefined();
    expect(low()).toHaveValue("0");
    // …and a further press at the edge asks for nothing at all.
    const calls = onChange.mock.calls.length;
    fireEvent.keyDown(low(), { key: "ArrowDown" });
    expect(onChange.mock.calls.length).toBe(calls);
  });

  it("walks the ceiling down from open and back up to open", () => {
    const onChange = range();

    const positions: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      fireEvent.keyDown(high(), { key: "ArrowLeft" });
      positions.push(Number((high() as HTMLInputElement).value));
    }
    expect(lastBand(onChange)[1]).toBe(1000 - 12 * 5);
    positions.forEach((pos, i) => {
      expect(pos).toBeLessThan(i === 0 ? PRICE_POSITIONS : positions[i - 1]);
    });

    for (let i = 0; i < 12; i += 1) fireEvent.keyDown(high(), { key: "ArrowRight" });
    expect(lastBand(onChange)[1]).toBeUndefined();
    expect(high()).toHaveValue(String(PRICE_POSITIONS));
  });

  /**
   * A typed ceiling past the top anchor shares the far-right position with "no ceiling", so a
   * step *down* from it lands on the top anchor as a real bound — the handle cannot tell the two
   * apart, and the direction of the press is what does.
   */
  it("steps a typed ceiling past the ladder down onto it, and up to open", () => {
    const onChange = range({ max: 2000 });

    fireEvent.keyDown(high(), { key: "ArrowLeft" });
    expect(lastBand(onChange)[1]).toBe(1000);
    fireEvent.keyDown(high(), { key: "ArrowLeft" });
    expect(lastBand(onChange)[1]).toBe(995);

    const raised = range({ max: 2000 });
    fireEvent.keyDown(screen.getAllByRole("slider", { name: "Highest price, slider" })[1], {
      key: "ArrowRight",
    });
    expect(lastBand(raised)[1]).toBeUndefined();
  });

  /** The push a drag does, from the keyboard too — one rule for both, not two that drift. */
  it("carries the other end along when a key steps one past it", () => {
    const onChange = range({ min: 2, max: 2 });

    fireEvent.keyDown(low(), { key: "ArrowRight" });
    expect(lastBand(onChange)).toEqual([2.25, 2.25]);

    fireEvent.keyDown(high(), { key: "ArrowLeft" });
    fireEvent.keyDown(high(), { key: "ArrowLeft" });
    expect(lastBand(onChange)).toEqual([1.75, 1.75]);
  });

  /** Only the arrows are taken over: a chord is somebody else's shortcut, and Home is native. */
  it("leaves other keys and chords to the browser", () => {
    const onChange = range();

    expect(fireEvent.keyDown(low(), { key: "ArrowRight", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(low(), { key: "Home" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * A drag a hair off the left edge rounds to `0`, and a floor of `0` is the filter that drops
   * every unpriced printing — not what a reader nudging the handle asked for.
   */
  it("reads a floor that rounds to nothing as no floor", () => {
    const onChange = range();

    drag(low(), 3);
    expect(priceAtPosition(3)).toBe(0);
    expect(lastBand(onChange)[0]).toBeUndefined();
  });

  /**
   * **The boxes are the filter and the handles are a way of reaching it**, so a typed number is
   * taken as it stands rather than snapped to whatever the ladder could express.
   */
  it("takes a typed number exactly, and a cleared box as an open end", async () => {
    const onChange = range({ min: 2 });

    const box = screen.getByLabelText("Lowest price");
    await userEvent.clear(box);
    expect(onChange).toHaveBeenLastCalledWith(undefined, undefined);

    await userEvent.type(box, "7.31");
    expect(onChange).toHaveBeenLastCalledWith(7.31, undefined);
  });

  /**
   * A trailing zero has to survive being typed. The draft is authoritative for its own value, so
   * `1.50` and `1.5` are one filter and the box is only re-seeded when a bound moves from
   * *outside* it — a handle dragged, or Reset all pressed.
   */
  it("keeps a half-typed number in the box while the filter reads it", async () => {
    const onChange = range();

    const box = screen.getByLabelText("Lowest price");
    // The parent applies what it is told — the *number* — and re-renders; the trailing zero has
    // to survive that, or a reader typing `1.50` watches the `0` vanish under their fingers.
    await userEvent.type(box, "1.50");
    expect(onChange).toHaveBeenLastCalledWith(1.5, undefined);
    expect(box).toHaveValue("1.50");

    // A bound moved from *outside* the box does re-seed it, which is the other half of the same
    // rule: dragging the handle to $20 has to put `20` in the box.
    drag(screen.getByRole("slider", { name: "Lowest price, slider" }), positionOfPrice(20));
    expect(box).toHaveValue("20");
  });
});
