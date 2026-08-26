import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pickOption } from "@/test-dropdown";
import { Dropdown, MultiDropdown } from "./Dropdown";
import type { DropdownOption } from "./types";

const FORMATS: DropdownOption[] = [
  { value: "commander", label: "Commander" },
  { value: "modern", label: "Modern" },
  { value: "pauper", label: "Pauper", disabled: true },
  { value: "standard", label: "Standard" },
];

// Overlapping first letters, distinct second ones — "s" alone is ambiguous between the first
// two, and only "st" picks out Standard, which is the whole point of buffering.
const TYPE_AHEAD_OPTIONS: DropdownOption[] = [
  { value: "sol", label: "Sol" },
  { value: "standard", label: "Standard" },
  { value: "timer", label: "Timer" },
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

  it("is driveable through the test helper", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await pickOption(user, "Format", "Commander");
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
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

  it("arrows and commits within the query-narrowed list, not the full one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Dropdown label="Format" value="modern" onChange={onChange} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "an");
    // Narrowed to Commander, Standard (see the substring test above) — a fresh query also reset
    // the cursor to row 0, Commander.
    await user.keyboard("{ArrowDown}"); // Commander -> Standard, the narrowed list's row 1
    await user.keyboard("{Enter}");
    // The full list's row 1 is Modern; only reading the *narrowed* list lands on Standard.
    expect(onChange).toHaveBeenCalledWith("standard");
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

  it("resets the uncontrolled query on a fresh opening", async () => {
    // Carried over from Task 4: openAt clears localQuery in the same batch as the active-index
    // reset, but nothing pinned it until now. A reader who typed a filter, closed without
    // picking, and reopened must not be shown a pre-filtered panel.
    const user = userEvent.setup();
    render(
      <Dropdown label="Format" value="modern" onChange={vi.fn()} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "an");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});

describe("Dropdown type-ahead", () => {
  it("buffers consecutive keystrokes into one type-ahead word", async () => {
    const user = userEvent.setup();
    render(<Dropdown label="Format" value="" onChange={vi.fn()} options={TYPE_AHEAD_OPTIONS} />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Escape}");
    // "s" alone opens on Sol (row 0) — the first keystroke both opens the panel and starts the
    // buffer, moving focus off the button before the second keystroke arrives. Only a buffer
    // that survives that handoff reaches Standard (row 1) on "st".
    await user.keyboard("st");
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining("option-1"),
    );
  });

  it(
    "resets the type-ahead buffer once it has sat idle past the timeout",
    async () => {
      const user = userEvent.setup();
      render(<Dropdown label="Format" value="" onChange={vi.fn()} options={TYPE_AHEAD_OPTIONS} />);
      await user.click(screen.getByRole("button", { name: "Format" }));
      await user.keyboard("{Escape}");
      await user.keyboard("s");
      // Real time, not fake: userEvent awaits real timers internally, and this repo has already
      // been bitten by the two not mixing (a naive vi.useFakeTimers() hangs the whole file, not
      // just this test). A genuine wait comfortably past the 600ms buffer is simpler and safe
      // for the one test that needs it.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await user.keyboard("t");
      // A fresh "t", not a continued "st" — Timer (row 2), not Standard (row 1).
      expect(screen.getByRole("listbox")).toHaveAttribute(
        "aria-activedescendant",
        expect.stringContaining("option-2"),
      );
    },
    10000,
  );

  it("opens a searchable dropdown into its search box on a printable key", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Format" value="modern" onChange={vi.fn()} options={FORMATS} searchable />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Escape}");
    await user.keyboard("s");
    // Same gesture, same place: the character lands in the search box rather than jumping a row.
    const box = screen.getByRole("combobox");
    expect(box).toHaveFocus();
    expect(box).toHaveValue("s");
    // Filtered by "s", substring, case-insensitive: only Standard has one.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Standard"]);
  });
});

describe("MultiDropdown", () => {
  function MultiHarness() {
    const [picked, setPicked] = useState<string[]>(["modern"]);
    return (
      <MultiDropdown
        label="Format"
        triggerLabel={picked.length === 0 ? "Any format" : `${picked.length} formats`}
        selected={picked}
        onToggle={(v) =>
          setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))
        }
        options={FORMATS}
      />
    );
  }

  it("says a count on the trigger, not a value", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    const trigger = screen.getByRole("button", { name: "Format" });
    expect(trigger).toHaveTextContent("1 formats");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Commander" }));
    expect(trigger).toHaveTextContent("2 formats");
  });

  it("stays open across several picks", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.click(screen.getByRole("option", { name: "Commander" }));
    // The whole purpose of a multi-select is picking several in a row.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Standard" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("marks the listbox multiselectable and every picked row selected", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getByRole("option", { name: "Modern" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("toggles the active row on Enter without closing", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
  });

  // The Space decision (see the reasoning at its site, `onListKeyDown`'s default case in
  // Dropdown.tsx): Space toggles the active row on a non-searchable multi-select — the same
  // outcome as Enter, on the same row, and for the same reason a native multi-select does it.
  it("toggles the active row on Space without closing", async () => {
    const user = userEvent.setup();
    render(<MultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.keyboard(" ");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
  });

  function SearchableMultiHarness() {
    const [picked, setPicked] = useState<string[]>([]);
    return (
      <MultiDropdown
        label="Format"
        triggerLabel={picked.length === 0 ? "Any format" : `${picked.length} formats`}
        selected={picked}
        onToggle={(v) =>
          setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))
        }
        options={FORMATS}
        searchable
      />
    );
  }

  // The other half of the Space decision: a searchable multi-select's search box has to be able
  // to hold a literal space — several set names do — so the toggle above must not reach it.
  it("types a literal space into a searchable multi-select's search box rather than toggling", async () => {
    const user = userEvent.setup();
    render(<SearchableMultiHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "a b");
    expect(screen.getByRole("combobox")).toHaveValue("a b");
    // Nothing toggled: the trigger still says nothing is picked.
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
  });

  function ReopenHarness() {
    const [picked, setPicked] = useState<string[]>(["standard"]);
    return (
      <MultiDropdown
        label="Format"
        triggerLabel={picked.length === 0 ? "Any format" : `${picked.length} formats`}
        selected={picked}
        onToggle={(v) =>
          setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))
        }
        options={FORMATS}
        searchable
      />
    );
  }

  // Regression: `computeOpeningIndex` used to be handed `drawn` — the *current*,
  // query-narrowed list — but `openAt` clears an uncontrolled query in the very same batch as
  // the index it is given, so the index was computed against a list about to be replaced.
  // Repro: selected = ["standard"]; FORMATS is [Commander, Modern, Pauper, Standard], so
  // Standard is row 3 of the full list. Typing "an" narrows the drawn list to
  // [Commander, Standard], where Standard sits at row 1 — a different list, a different index
  // for the same option. Reopening must still land on Standard (row 3 of the reset full list),
  // not row 1 of it (Modern).
  it("reopens on the picked row, not the stale row a leftover search query would have named", async () => {
    const user = userEvent.setup();
    render(<ReopenHarness />);
    await user.click(screen.getByRole("button", { name: "Format" }));
    await user.type(screen.getByRole("combobox"), "an");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining("option-3"), // Standard, in the reset full FORMATS list
    );
  });

  const FORMATS_ROW0_DISABLED: DropdownOption[] = [
    { value: "vintage", label: "Vintage", disabled: true },
    { value: "legacy", label: "Legacy" },
    { value: "modern", label: "Modern" },
  ];

  // Regression: `multiOpeningIndex`'s no-selection fallback used to return row 0 unconditionally
  // — safe only because a *found* selected row is never disabled, a guarantee the fallback does
  // not inherit. Nothing selected surviving into the list is the set picker's normal state once
  // a query has narrowed past every ticked row, and row 0 can be disabled — landing there is the
  // silent first-press failure `openingIndex`'s own doc warns about, now for Enter and Space
  // both.
  it("reroutes the no-selection fallback away from a disabled row 0", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <MultiDropdown
        label="Format"
        triggerLabel="Any format"
        selected={[]}
        onToggle={onToggle}
        options={FORMATS_ROW0_DISABLED}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Format" }));
    // Opens on Legacy (row 1, the first enabled), not Vintage (row 0, disabled).
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining("option-1"),
    );
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith("legacy");
  });
});
