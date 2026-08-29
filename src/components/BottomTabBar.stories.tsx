import { useState, type ComponentProps, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { BottomTabBar } from "./BottomTabBar";
import type { SidebarDrop } from "./useSidebarDrops";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";

/**
 * The phone frame, at the width every number in this file was measured at.
 *
 * Declared here rather than shared, and the numbers rather than the box are what is shared. A
 * Tailwind class cannot be built by interpolation — it would emit no rule at all — so the width
 * is an inline style, which is how this repo already spells a computed length. `shrink-0` because
 * the docs canvas is a flex container: without it a narrow canvas shrinks the frame and the story
 * becomes a picture of a width nobody asked for.
 *
 * `justify-end` is this file's own addition to 9a's decorator: the bar is drawn alone here, and a
 * bar about the thumb zone floated at the top of the frame would be a picture of the wrong place.
 */
const phone = (Story: () => ReactElement) => (
  <div
    className="flex shrink-0 flex-col justify-end overflow-hidden bg-bg text-text"
    style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX }}
  >
    <div className="m-5 flex flex-1 items-end justify-center rounded-lg border border-dashed border-border p-3 text-xs text-dim">
      main — the wall the bar leaves
    </div>
    <Story />
  </div>
);

/** A drop that would take the card being carried. `onDrop` is a story's, so nothing is written. */
const takes: SidebarDrop = {
  eligible: true,
  inertReason: null,
  report: null,
  onDrop: () => {},
};

/** …and the Decks entry with no deck open, which is the only refusal either entry has. */
const refuses: SidebarDrop = {
  eligible: false,
  inertReason: "Open a deck to drop cards into it",
  report: null,
  onDrop: () => {},
};

/**
 * The bar is a controlled component — it reports a press and navigates nothing — so a story has
 * to own the view it draws as open, or every tab would report and none would light up.
 *
 * `onSelect` still reaches the arg, so the Actions panel shows what the component *reports*,
 * which is the half a call site has to get right. `QuantityStepper.stories.tsx`'s arrangement, for
 * its reason.
 */
function Stateful({ activeView: initial, onSelect, ...rest }: ComponentProps<typeof BottomTabBar>) {
  const [activeView, setActiveView] = useState(initial);
  return (
    <BottomTabBar
      {...rest}
      activeView={activeView}
      onSelect={(view) => {
        setActiveView(view);
        onSelect(view);
      }}
    />
  );
}

const meta = {
  title: "Mobile/Bottom tab bar",
  component: BottomTabBar,
  tags: ["autodocs"],
  decorators: [phone],
  // Keyed on the seed for `QuantityStepper.stories.tsx`'s reason: Storybook re-renders a story
  // when an arg changes rather than remounting it, and `useState`'s initial value is read once —
  // so without this, changing `activeView` in Controls would move nothing.
  render: (args) => <Stateful key={args.activeView} {...args} />,
  args: {
    activeView: "search",
    onSelect: fn(),
    dragging: false,
    decks: takes,
    wishlist: takes,
  },
  parameters: {
    docs: {
      description: {
        component:
          "The six destinations across the foot of a phone window: 65px each at 390, in a row " +
          "53px tall, inside `--safe-b`. Two of the six take a dropped card, and all six " +
          "register a drop target — a droppable that refuses costs a registry entry and nothing " +
          "else, and registering them all is what keeps the target set from changing shape " +
          "mid-drag.",
      },
    },
  },
} satisfies Meta<typeof BottomTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing in the air: six words under six glyphs, and gold on the one that is open.
 *
 * **The play presses a tab**, which is the whole of what this component does — and the assertion
 * is `aria-current`, because that is the answer the rail gives to the same question and two
 * drawings of navigation must not answer it two ways.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Search" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await userEvent.click(canvas.getByRole("button", { name: "Decks" }));

    await expect(args.onSelect).toHaveBeenCalledWith("decks");
    await expect(canvas.getByRole("button", { name: "Decks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.getByRole("button", { name: "Search" })).not.toHaveAttribute(
      "aria-current",
    );
  },
};

/**
 * `Collection` is the longest of the six words, and this is the frame that shows what a 65px tab
 * does to it — 54.98px at `text-xs`, with ten to spare.
 */
export const CollectionOpen: Story = {
  args: { activeView: "collection" },
};

/**
 * A card is in the air and a deck is open: the two entries that would take it wear the shipped
 * `DROP_RING`, on a 65px tab rather than the rail's 183px row.
 *
 * Nothing on this page drags anything, so this is a control rather than a demonstration — the
 * ring is drawn from the `dragging` prop. Whether a 65px ring reads as an invitation is a
 * question for hardware, and the plan says so.
 */
export const CardInTheAir: Story = {
  args: { dragging: true },
};

/**
 * The same drag with no deck open. Decks refuses, so it draws no ring — and its refusal is a
 * *description* rather than a tooltip: Chromium freezes `:hover` at a drag's origin for the whole
 * drag, so the sentence is read out of the accessibility tree and never seen. On a phone there is
 * no hover at all.
 */
export const NoDeckOpen: Story = {
  args: { dragging: true, decks: refuses },
};
