import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeRadios } from "./ModeRadios";

const MODES = [
  { key: "add", label: "Add to wishlist quantities", hint: "Quantities add to what you already want." },
  { key: "set", label: "Set these quantities", hint: "Replaces your quantities with the file's." },
] as const;

describe("ModeRadios", () => {
  /** The computed name, on the element, with the whole phrase — the fence `packages/ui/CLAUDE.md` asks
   *  for, since a label and a hint asserted separately both pass over `…quantitiesThe file's…`. */
  it("names each radio by its label alone and describes it with the hint", () => {
    render(<ModeRadios modes={MODES} value="add" onChange={vi.fn()} label="Mode" />);

    const set = screen.getByRole("radio", { name: "Set these quantities" });
    expect(set).toHaveAccessibleName("Set these quantities");
    expect(set).toHaveAccessibleDescription("Replaces your quantities with the file's.");
  });

  /** The hint is still inside the `<label>`, so pressing the sentence picks the mode. */
  it("picks a mode from a press on its hint", async () => {
    const onChange = vi.fn();
    render(<ModeRadios modes={MODES} value="add" onChange={onChange} label="Mode" />);

    await userEvent.setup().click(screen.getByText("Replaces your quantities with the file's."));

    expect(onChange).toHaveBeenCalledWith("set");
  });
});
