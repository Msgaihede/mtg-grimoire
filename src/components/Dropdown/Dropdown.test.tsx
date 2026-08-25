import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dropdown } from "./Dropdown";
import type { DropdownOption } from "./types";

const FORMATS: DropdownOption[] = [
  { value: "commander", label: "Commander" },
  { value: "modern", label: "Modern" },
  { value: "pauper", label: "Pauper", disabled: true },
  { value: "standard", label: "Standard" },
];

function Harness({ initial = "modern" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Dropdown label="Format" value={value} onChange={setValue} options={FORMATS} />;
}

describe("Dropdown", () => {
  it("draws the picked option's label on the trigger", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");
  });

  it("draws the placeholder when the value matches no option", () => {
    // The native select's worst habit, and the reason FilterBar carries a seeded-key guard:
    // a <select> whose value matches nothing silently reports its FIRST row. This draws a
    // placeholder instead, so the control cannot claim a filter it is not applying.
    render(
      <Dropdown
        label="Format"
        value="alchemy"
        onChange={vi.fn()}
        options={FORMATS}
        placeholder="Pick a format"
      />,
    );
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Pick a format");
  });

  it("opens a listbox on click and closes it on a pick", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Commander" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
  });

  it("marks the picked row aria-selected and nothing else", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("option", { name: "Modern" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Commander" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("opens on ArrowDown from the closed trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // Clicked, not focused programmatically: starting a keyboard flow with el.focus() tests a
    // caret no reader can produce.
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("walks with the arrow keys and skips a disabled row", async () => {
    const user = userEvent.setup();
    render(<Harness initial="commander" />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    const listbox = screen.getByRole("listbox");
    // Opens on the picked row: Commander, index 0. The listbox is what holds the caret on a
    // dropdown with no search box, so it is what carries aria-activedescendant.
    expect(listbox).toHaveAttribute("aria-activedescendant", expect.stringContaining("option-0"));
    await user.keyboard("{ArrowDown}"); // Modern
    await user.keyboard("{ArrowDown}"); // skips Pauper (disabled) -> Standard
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Standard");
  });

  it("refuses a disabled row to the pointer as well as to Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <Dropdown label="Format" value="modern" onChange={onChange} options={FORMATS} />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.click(screen.getByRole("option", { name: "Pauper" }));
    expect(onChange).not.toHaveBeenCalled();
    // A list that refuses the click and takes the keystroke is a list with two rules.
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Enter's own guard needs a row that is actually active *and* disabled to exercise it —
    // opening never lands there and the arrow keys skip it, so nothing above reaches it. A
    // live options change does: Task 4's facet counts can disable the very row the keyboard
    // is already sitting on (Modern, picked and therefore active since it opened). The click
    // above never moved the cursor off it.
    const facetsChanged = FORMATS.map((o) =>
      o.value === "modern" ? { ...o, disabled: true } : o,
    );
    rerender(
      <Dropdown label="Format" value="modern" onChange={onChange} options={facetsChanged} />,
    );
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hands the caret back to the trigger on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Format" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    // An element that unmounts with focus on it drops the caret to <body>, and the next Tab
    // restarts from the top of the app.
    expect(trigger).toHaveFocus();
  });

  it("reports aria-expanded on the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Format" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("jumps to a row by type-ahead from the closed trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Escape}");
    await user.keyboard("s");
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining("option-3"), // Standard
    );
  });

  it("draws an option's icon and hint beside its label", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        label="Set"
        value="lea"
        onChange={vi.fn()}
        options={[
          {
            value: "lea",
            label: "Limited Edition Alpha",
            hint: "LEA",
            icon: <span data-testid="glyph" />,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Set" }));
    const option = screen.getByRole("option", { name: /Limited Edition Alpha/ });
    // The name is the row's own content — label and hint both, and no aria-label replacing them.
    expect(option).toHaveTextContent("LEA");
    expect(within(option).getByTestId("glyph")).toBeInTheDocument();
  });

  it("calls onReachEnd when ArrowDown cannot move past the last enabled row", async () => {
    const user = userEvent.setup();
    const onReachEnd = vi.fn();
    render(
      <Dropdown
        label="Format"
        value="standard"
        onChange={vi.fn()}
        options={FORMATS}
        onReachEnd={onReachEnd}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    // Opens already on Standard — the last enabled row — so this ArrowDown has nowhere to go.
    await user.keyboard("{ArrowDown}");
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it("calls onReachEnd when End is pressed a second time at the last row", async () => {
    const user = userEvent.setup();
    const onReachEnd = vi.fn();
    render(
      <Dropdown
        label="Format"
        value="commander"
        onChange={vi.fn()}
        options={FORMATS}
        onReachEnd={onReachEnd}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{End}"); // Standard — the last enabled row
    expect(onReachEnd).not.toHaveBeenCalled();
    await user.keyboard("{End}"); // already there
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });
});

describe("Dropdown search", () => {
  it("has no search box unless asked for one", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("filters by label substring, case-insensitively, when uncontrolled", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Format" value="modern" onChange={vi.fn()} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "an");
    // Commander and Standard; Modern and Pauper are gone.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Commander",
      "Standard",
    ]);
  });

  it("filters nothing when the caller controls the query", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(
      <Dropdown
        label="Format"
        value="modern"
        onChange={vi.fn()}
        options={FORMATS}
        searchable
        query="zzz"
        onQueryChange={onQueryChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    // A controlled caller has already filtered; the shell must not filter a second time or the
    // set picker's rank ordering would be silently re-cut by a substring test.
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.type(screen.getByRole("combobox"), "x");
    expect(onQueryChange).toHaveBeenCalledWith("zzzx");
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        label="Format"
        value="modern"
        onChange={vi.fn()}
        options={FORMATS}
        searchable
        emptyLine="No formats match that."
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No formats match that.")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("keeps the caret in the search box while the pointer picks", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Format" value="" onChange={vi.fn()} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    const box = screen.getByRole("combobox");
    expect(box).toHaveFocus();
    await user.click(screen.getByRole("option", { name: "Pauper" })); // disabled: no close
    expect(box).toHaveFocus();
  });

  it("calls onReachEnd when ArrowDown is pressed on the last row", async () => {
    const user = userEvent.setup();
    const onReachEnd = vi.fn();
    render(
      <Dropdown
        label="Format"
        value="standard"
        onChange={vi.fn()}
        options={FORMATS}
        onReachEnd={onReachEnd}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{ArrowDown}");
    expect(onReachEnd).toHaveBeenCalled();
  });

  it("draws a footer below the list", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        label="Format"
        value="modern"
        onChange={vi.fn()}
        options={FORMATS}
        footer={<p>Showing 4 of 40.</p>}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByText("Showing 4 of 40.")).toBeInTheDocument();
  });
});
