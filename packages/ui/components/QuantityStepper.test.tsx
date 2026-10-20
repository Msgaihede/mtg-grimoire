import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuantityStepper } from "./QuantityStepper";

/**
 * The stepper is controlled, so a test has to own the state it controls — a fixed `value`
 * prop would make every assertion about the *call*, and never about what the reader is
 * looking at afterwards.
 */
function Harness({
  initial = 1,
  min,
  max,
  onChange,
}: {
  initial?: number;
  min?: number;
  max?: number;
  onChange?: (n: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <QuantityStepper
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      min={min}
      max={max}
      label="Quantity of Lightning Bolt"
    />
  );
}

const box = () => screen.getByRole("spinbutton", { name: "Quantity of Lightning Bolt" });

describe("QuantityStepper", () => {
  /**
   * Both buttons are named after the thing being counted, not after the control: a screen
   * reader in a list of forty printings otherwise hears "Increase" forty times with no way
   * to tell which card it belongs to.
   */
  it("steps up and down, and names both buttons after what is being counted", async () => {
    render(<Harness />);

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt" }),
    );
    expect(box()).toHaveValue(2);

    await userEvent.click(
      screen.getByRole("button", { name: "Decrease Quantity of Lightning Bolt" }),
    );
    expect(box()).toHaveValue(1);
  });

  /**
   * Typing `12` is one action and pressing `+` eleven times is eleven — and a collection is
   * full of twelves. The trap is the empty box in between: clamping every keystroke to
   * `min` makes it impossible to replace "1" with "12".
   */
  it("takes a typed quantity, including the empty box on the way to it", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await userEvent.clear(box());
    await userEvent.type(box(), "12{Enter}");

    expect(box()).toHaveValue(12);
    expect(onChange.mock.calls).toEqual([[12]]);
  });

  /**
   * Issue #1110. Every caller's `onChange` is a write, and on several a lower number is more
   * than a number — a cut in the deck editor, a delete at `0` in the collection, a tradelist
   * clamp that later digits never restore. So nothing a reader is half-way through typing may
   * reach it: not the "1" on the way to "12", and not the "0" left by deleting the "1" of "10".
   */
  it("reports a typed number once, on Enter, and none of the numbers on the way to it", async () => {
    const onChange = vi.fn();
    render(<Harness initial={8} onChange={onChange} />);

    await userEvent.clear(box());
    await userEvent.type(box(), "12");
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveValue(12);

    await userEvent.keyboard("{Enter}");
    expect(onChange.mock.calls).toEqual([[12]]);
  });

  it("reports nothing for the zero a deleted leading digit leaves behind", async () => {
    const onChange = vi.fn();
    render(<Harness initial={10} onChange={onChange} />);

    // "10" → "0" → "50": the box passes through zero, which in the collection is a delete.
    await userEvent.type(box(), "{Home}{Delete}");
    expect(box()).toHaveValue(0);
    await userEvent.type(box(), "{Home}5");
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(onChange.mock.calls).toEqual([[50]]);
  });

  it("commits on leaving the box", async () => {
    const onChange = vi.fn();
    render(<Harness initial={4} onChange={onChange} />);

    await userEvent.clear(box());
    await userEvent.type(box(), "7");
    await userEvent.tab();

    expect(onChange.mock.calls).toEqual([[7]]);
    expect(box()).toHaveValue(7);
  });

  it("throws the draft away on Escape", async () => {
    const onChange = vi.fn();
    render(<Harness initial={4} onChange={onChange} />);

    await userEvent.clear(box());
    await userEvent.type(box(), "1{Escape}");
    expect(box()).toHaveValue(4);

    await userEvent.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty box, a minus sign, or the number it already holds", async () => {
    const onChange = vi.fn();
    render(<Harness initial={3} onChange={onChange} />);

    await userEvent.clear(box());
    await userEvent.tab();
    expect(box()).toHaveValue(3);

    // Below the floor is a slip, not a request for the floor: at a floor of 0 it would be a
    // delete.
    await userEvent.clear(box());
    await userEvent.type(box(), "-2{Enter}");
    expect(box()).toHaveValue(3);

    await userEvent.clear(box());
    await userEvent.type(box(), "3{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * No caller is optimistic, so `value` is still the old count while the write is out. The box
   * keeps the committed number rather than flashing the old one, and a `+` pressed in that
   * window — the press whose mousedown is the blur that commits — counts from what was typed.
   */
  it("holds a committed number until the value catches up, and steps from it", async () => {
    const onChange = vi.fn();
    render(<QuantityStepper value={8} onChange={onChange} label="Quantity of Lightning Bolt" />);

    await userEvent.clear(box());
    await userEvent.type(box(), "12{Enter}");
    expect(box()).toHaveValue(12);

    await userEvent.click(screen.getByRole("button", { name: /^Increase/ }));
    expect(onChange.mock.calls).toEqual([[12], [13]]);
  });

  it("commits a draft before a press that takes the focus from it, and steps from the draft", async () => {
    const onChange = vi.fn();
    render(<QuantityStepper value={8} onChange={onChange} label="Quantity of Lightning Bolt" />);

    await userEvent.clear(box());
    await userEvent.type(box(), "12");
    await userEvent.click(screen.getByRole("button", { name: /^Decrease/ }));

    expect(onChange.mock.calls).toEqual([[12], [11]]);
  });

  it("stops at the floor and the ceiling, from the buttons and from the keyboard", async () => {
    const onChange = vi.fn();
    render(<Harness initial={1} min={1} max={3} onChange={onChange} />);

    // Nothing below one copy: an add of zero copies is a row conjured out of a card the
    // user never said they had.
    expect(screen.getByRole("button", { name: /^Decrease/ })).toBeDisabled();

    await userEvent.clear(box());
    await userEvent.type(box(), "99");
    expect(box()).toHaveValue(3);

    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue(3);
    expect(screen.getByRole("button", { name: /^Increase/ })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalledWith(99);
  });

  /** A quantity is data, and the direction sets data in the mono face, figures aligned. */
  it("sets the number in the data face", () => {
    render(<Harness />);

    expect(box()).toHaveClass("font-mono");
    expect(box()).toHaveClass("tabular-nums");
  });
});
