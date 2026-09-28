import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeRadios } from "./ModeRadios";

const MODES = [
  { key: "add", label: "Add these wishes", hint: "Quantities add to what you already want." },
  { key: "set", label: "Set these quantities", hint: "The file's number replaces yours." },
] as const;

describe("ModeRadios", () => {
  /** The computed name, on the element, with the whole phrase — the fence `src/CLAUDE.md` asks
   *  for, since a label and a hint asserted separately both pass over `…quantitiesThe file's…`. */
  it("names each radio by its label alone and describes it with the hint", () => {
    render(<ModeRadios modes={MODES} value="add" onChange={vi.fn()} label="Mode" />);

    const set = screen.getByRole("radio", { name: "Set these quantities" });
    expect(set).toHaveAccessibleName("Set these quantities");
    expect(set).toHaveAccessibleDescription("The file's number replaces yours.");
  });

  /** The hint is still inside the `<label>`, so pressing the sentence picks the mode. */
  it("picks a mode from a press on its hint", async () => {
    const onChange = vi.fn();
    render(<ModeRadios modes={MODES} value="add" onChange={onChange} label="Mode" />);

    await userEvent.setup().click(screen.getByText("The file's number replaces yours."));

    expect(onChange).toHaveBeenCalledWith("set");
  });
});
