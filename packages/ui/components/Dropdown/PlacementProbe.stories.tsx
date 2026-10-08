import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dropdown } from "./Dropdown";
import type { DropdownOption } from "./types";

/**
 * A probe, not a catalogue entry.
 *
 * `Dropdown.stories.tsx` is where the panel's *appearance* lives; where it *lands* is a layout
 * fact, and jsdom implements no layout — every rectangle it measures is zero, so the whole of
 * `usePopupPlacement` is exercised by the suite without being tested. These three stories put a
 * dropdown in the three containers the placement has to survive, so a browser can answer what the
 * suite cannot. Each one is driven by hand over CDP and the numbers are written into
 * `docs/reference/frontend-design.md`; nothing here has a `play`, because a play would be a second
 * jsdom reading of the same zeros.
 */

const SETS: DropdownOption[] = Array.from({ length: 8 }, (_, i) => ({
  value: `s${i}`,
  label: `Set number ${i + 1}`,
}));

/** Controlled, so a pick moves the trigger — the same reason `Dropdown.stories.tsx` wraps it. */
function Probe() {
  const [value, setValue] = useState("s0");
  return <Dropdown label="Set" value={value} onChange={setValue} options={SETS} />;
}

const meta = {
  // Titles in this repo are one of Primitives / Chrome / Cards / a feature area — never
  // "Components".
  title: "Primitives/Dropdown/PlacementProbe",
  component: Probe,
} satisfies Meta<typeof Probe>;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The import previews' shape: a control inside an `overflow-y-auto` scroller.
 *
 * A native `<select>`'s list escaped this; an absolutely-positioned panel would be clipped by it.
 * The reading that matters is `panel.bottom` **greater** than the scroller's own bottom.
 */
export const InAScroller: Story = {
  render: () => (
    <div className="h-40 overflow-y-auto border border-border p-3">
      {Array.from({ length: 20 }, (_, i) => (
        <p key={i} className="text-sm text-dim">
          Filler line {i + 1}
        </p>
      ))}
      <Probe />
      {Array.from({ length: 20 }, (_, i) => (
        <p key={i} className="text-sm text-dim">
          Filler line {i + 21}
        </p>
      ))}
    </div>
  ),
};

/**
 * Exactly what a settled `Dialog` panel is: motion leaves the `scale` longhand on the element at
 * rest, and `scale: 1` is **not** `none`, so this box is a containing block for a `fixed`
 * descendant. Eight of this app's dropdowns live inside one.
 *
 * The margin is what makes the reading falsifiable — an uncorrected `fixed` panel would sit at the
 * viewport origin the arithmetic named, which is the box's own offset away from the trigger.
 */
export const InATransformedBox: Story = {
  render: () => (
    <div style={{ scale: 1 }} className="ml-24 mt-24 border border-border p-6">
      <Probe />
    </div>
  ),
};

/** No room below — the flip. `fullscreen` so `h-screen` is the viewport and not the viewport plus
 *  the preview's own padding, which would put the trigger under the fold. */
export const AtTheBottom: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="flex h-screen items-end p-3">
      <Probe />
    </div>
  ),
};
