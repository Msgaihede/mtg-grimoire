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
    render(<Harness />);

    await userEvent.clear(box());
    await userEvent.type(box(), "12");

    expect(box()).toHaveValue(12);
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
