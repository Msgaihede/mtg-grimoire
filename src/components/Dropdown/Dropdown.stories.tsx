import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { setGlyphClass } from "@/lib/keyrune";
import { cn } from "@/lib/utils";
import { Dropdown, MultiDropdown } from "./Dropdown";
import type { DropdownOption } from "./types";

/**
 * `<Dropdown>` and `<MultiDropdown>` are controlled, so a story has to own the state they
 * control — rendered against a fixed `value`/`selected`, a row would report its click and then
 * visibly not move, a story of a control that does not work. The wrapper still calls the arg
 * callback too, so the Actions panel shows what each control reports — the same shape
 * `FilterChips.stories.tsx`'s `StatefulToggle` settled on, for the same reason.
 */
function StatefulDropdown({ value: seed, onChange, ...rest }: ComponentProps<typeof Dropdown>) {
  const [value, setValue] = useState(seed);
  return (
    <Dropdown
      {...rest}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

/** `<MultiDropdown>`'s own stateful wrapper — `triggerLabel` is computed here from the state the
 *  wrapper owns, never threaded through as an arg, so it can never drift from what is picked. */
function StatefulMultiDropdown({
  selected: seed,
  onToggle,
  ...rest
}: ComponentProps<typeof MultiDropdown>) {
  const [selected, setSelected] = useState<readonly string[]>(seed);
  const label =
    selected.length === 0
      ? "Any format"
      : `${selected.length} format${selected.length === 1 ? "" : "s"}`;
  return (
    <MultiDropdown
      {...rest}
      selected={selected}
      triggerLabel={label}
      onToggle={(v) => {
        setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));
        onToggle(v);
      }}
    />
  );
}

const FORMAT_OPTIONS: DropdownOption[] = [
  { value: "standard", label: "Standard" },
  { value: "pioneer", label: "Pioneer" },
  { value: "modern", label: "Modern" },
  { value: "legacy", label: "Legacy" },
  { value: "commander", label: "Commander" },
];

/** Two formats greyed, as a deck's format switcher would grey the ones nothing in it is legal
 *  for — same fixture as {@link FORMAT_OPTIONS}, two rows disabled with the reason `useTooltip`
 *  carries. */
const FORMAT_OPTIONS_WITH_GAPS: DropdownOption[] = FORMAT_OPTIONS.map((o) =>
  o.value === "modern" || o.value === "legacy"
    ? { ...o, disabled: true, title: "No cards in this deck are legal here" }
    : o,
);

const SET_OPTIONS: DropdownOption[] = [
  { value: "khm", label: "Kaldheim", code: "KHM" },
  { value: "neo", label: "Kamigawa: Neon Dynasty", code: "NEO" },
  { value: "snc", label: "Streets of New Capenna", code: "SNC" },
].map(({ code, ...o }) => ({
  ...o,
  hint: code,
  // keyrune covers 441 of ~1 050 sets and falls back to a generic glyph for the rest — see
  // `setGlyphClass`'s own doc comment. The set picker (Task 8) draws this exact row.
  icon: <i className={cn(setGlyphClass(o.value), "w-4 shrink-0 text-center")} aria-hidden="true" />,
}));

/** A required callback whose call a story has nothing to say about — module-level so a render
 *  does not mint a fresh spy on every re-render. Stories that assert a call use their own. */
const noop = fn();

const meta = {
  title: "Primitives/Dropdown",
  // Every native `<select>` in the app is being replaced with this shell, in one of two shapes:
  // `Dropdown` commits a single value and closes; `MultiDropdown` toggles a value and stays
  // open. Both share one disclosure button, one listbox, an optional search box and the same
  // keyboard — see `Dropdown.tsx`'s own doc comments for the ARIA and focus contract.
  component: Dropdown,
  subcomponents: { MultiDropdown },
  tags: ["autodocs"],
  render: (args) => <StatefulDropdown key={args.value} {...args} />,
  args: { label: "Format", value: "modern", onChange: fn(), options: FORMAT_OPTIONS },
  parameters: {
    docs: {
      description: {
        component:
          "The disclosure-button shell every native `<select>` in the app is being replaced " +
          "with. `Dropdown` holds one value and closes on a pick; `MultiDropdown` holds several " +
          "and stays open across them — see the `Multi` story. Whichever element is focused " +
          "while the panel is open carries `aria-activedescendant`: the listbox itself without " +
          "`searchable`, the search box with it.",
      },
    },
  },
} satisfies Meta<typeof Dropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed, `md`, on its picked row. */
export const Default: Story = {};

/** A click opens the listbox on the picked row — Modern, already active. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Format" }));
    await expect(canvas.getByRole("listbox")).toBeInTheDocument();
  },
};

/** The two densities side by side: `md` at 36px (`FilterChips`' own height) and `sm` at 32px,
 *  the card pane's. */
export const Small: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-4">
      <StatefulDropdown label="Format" value="modern" onChange={noop} options={FORMAT_OPTIONS} />
      <StatefulDropdown
        label="Format"
        value="modern"
        onChange={noop}
        options={FORMAT_OPTIONS}
        size="sm"
      />
    </div>
  ),
};

/** Typing narrows the list to a case-insensitive substring of the label — "an" is Commander and
 *  Standard; Pioneer, Modern and Legacy drop out. */
export const Searchable: Story = {
  args: { searchable: true, searchLabel: "Search formats" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Format" }));
    await userEvent.type(canvas.getByRole("combobox"), "an");
    await expect(canvas.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Standard",
      "Commander",
    ]);
  },
};

/** Greyed rows refuse the pointer as well as Enter: a click on one reports nothing — no
 *  `onChange` — and the panel stays open so the reader can try a row that works. */
export const WithDisabledRows: Story = {
  args: { options: FORMAT_OPTIONS_WITH_GAPS, onChange: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Format" }));
    const row = canvas.getByRole("option", { name: "Modern" });
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(row);
    await expect(args.onChange).not.toHaveBeenCalled();
    await expect(canvas.getByRole("listbox")).toBeInTheDocument();
  },
};

/** `<MultiDropdown>`: several picks in a row, and the panel never closes on any of them — the
 *  whole reason the control exists. */
export const Multi: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <StatefulMultiDropdown
      label="Format"
      selected={["modern"]}
      onToggle={noop}
      options={FORMAT_OPTIONS}
      triggerLabel="1 format"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Format" }));
    await userEvent.click(canvas.getByRole("option", { name: "Standard" }));
    await userEvent.click(canvas.getByRole("option", { name: "Commander" }));
    await expect(canvas.getByRole("listbox")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Format" })).toHaveTextContent("3 formats");
  },
};

/** Icon and hint beside the label — the set picker's own row shape (Task 8): a keyrune glyph and
 *  the set's code ride beside the name rather than replacing it, exactly as `DropdownOption`'s
 *  own doc comment describes. */
export const RichRows: Story = {
  args: { label: "Set", value: "khm", options: SET_OPTIONS, onChange: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set" }));
    const option = canvas.getByRole("option", { name: /Kamigawa: Neon Dynasty/ });
    await expect(option).toHaveTextContent("NEO");
  },
};

/** `fill` stretches the trigger to its container and pushes the chevron to the far edge — the
 *  shape a dropdown takes as one cell of a filter row's grid, narrowed here to make the edge
 *  visible. */
export const Fill: Story = {
  args: { fill: true },
  render: (args) => (
    <div className="w-48 rounded-md border border-dashed border-border p-2">
      <StatefulDropdown key={args.value} {...args} />
    </div>
  ),
};
