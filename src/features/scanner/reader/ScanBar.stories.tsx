import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { Condition } from "@/lib/conditions";
import type { Finish } from "@/lib/finish";
import type { ScanFilters, ScanMode } from "@/lib/ipc";
import { ScanBar, type ScanBarProps } from "./ScanBar";

/**
 * The row with its values held, so a press in the workbench moves what it would move in the app.
 *
 * `ScanBar` is controlled end to end — the page owns the prefs — so a story drawn straight from
 * `args` would be a row whose Exact never lights and whose Clear clears nothing. The args seed the
 * state and still receive every call, so the Actions panel reads exactly what the page would be
 * handed.
 */
function Held(args: ScanBarProps) {
  const [mode, setMode] = useState<ScanMode>(args.mode);
  const [filters, setFilters] = useState<ScanFilters>(args.filters);
  const [finish, setFinish] = useState<Finish>(args.finish);
  const [condition, setCondition] = useState<Condition>(args.condition);
  const [developer, setDeveloper] = useState(args.developer);
  return (
    <ScanBar
      {...args}
      mode={mode}
      onMode={(m) => {
        setMode(m);
        args.onMode(m);
      }}
      filters={filters}
      onFilters={(f) => {
        setFilters(f);
        args.onFilters(f);
      }}
      finish={finish}
      onFinish={(f) => {
        setFinish(f);
        args.onFinish(f);
      }}
      condition={condition}
      onCondition={(c) => {
        setCondition(c);
        args.onCondition(c);
      }}
      developer={developer}
      onDeveloper={(on) => {
        setDeveloper(on);
        args.onDeveloper(on);
      }}
    />
  );
}

const meta = {
  title: "Scanner/Reader/Scan bar",
  component: ScanBar,
  tags: ["autodocs"],
  render: (args) => <Held {...args} />,
  args: {
    mode: "fast",
    onMode: fn(),
    filters: { sets: [], released_from: null, released_to: null },
    onFilters: fn(),
    filterError: null,
    filtersDisabled: null,
    finish: "nonfoil",
    onFinish: fn(),
    condition: "NONE",
    onCondition: fn(),
    developer: false,
    onDeveloper: fn(),
  },
  decorators: [
    // The Scanner view's content column at the app's narrow rung — `ScannerPage.stories.tsx`'s
    // 1032px — with room under the row for a popover to open into, since both are anchored to
    // their trigger and a canvas cut at the row's own height would clip them.
    (Story) => (
      <div className="min-h-[26rem] w-[1032px] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScanBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What a reader opens the view on: Fast, no narrowing, the tray's plain defaults, panels off. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Filters: Any set" })).toBeInTheDocument();
  },
};

/**
 * Exact, narrowed to two sets and a release window — the Filters trigger turns gold, which is the
 * one thing a reader has to be able to see without opening it: a filter left on from the last pile
 * is how the next pile fails to match.
 */
export const ExactWithFilters: Story = {
  args: {
    mode: "exact",
    filters: { sets: ["hob", "ltr"], released_from: "2023-06-23", released_to: "2024-12-31" },
    finish: "foil",
    condition: "NM",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Exact" })).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Filters: HOB, LTR · 2023-06-23 – 2024-12-31" }),
    ).toBeInTheDocument();
  },
};

/**
 * The session refused the last filter, drawn where the reader made it — inside the open popover,
 * so the sentence is beside the field it is about rather than somewhere under the camera.
 */
export const FilterRefused: Story = {
  args: {
    filters: { sets: ["hob"], released_from: null, released_to: null },
    filterError: "Filters need card names, and this scanner could not read corpus.db.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Filters: HOB" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Filters need card names, and this scanner could not read corpus.db.",
    );
  },
};

/**
 * Filters out of reach, with the reason as the trigger's tooltip — still in the tab order, still
 * reading what it would narrow to, and refusing the press rather than hiding.
 */
export const FiltersDisabled: Story = {
  args: { filtersDisabled: "Filters need card names, and none are loaded yet." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = canvas.getByRole("button", { name: "Filters: Any set" });
    await expect(filters).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(filters);
    await expect(canvas.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
  },
};
