import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { makeFit, spanPx } from "./fit";
import { WidgetCard } from "./WidgetCard";
import { WidgetMessage } from "./WidgetParts";

/**
 * A card three cells wide and three tall at the grid's target cell — the footprint the design
 * draws its value widgets at, and the widest one that still carries no chip (tier 1).
 *
 * Not exported: CSF indexes every non-default export as a story.
 */
const CELL = 104;
const W = 3;
const H = 3;
const WIDTH = spanPx(W, CELL);
const HEIGHT = spanPx(H, CELL);

const meta = {
  title: "Home/WidgetCard",
  component: WidgetCard,
  tags: ["autodocs"],
  args: {
    widget: { id: "collectionValue", kind: "collectionValue", x: 0, y: 0, w: W, h: H, config: null },
    fit: makeFit({ w: W, h: H, widthPx: WIDTH, heightPx: HEIGHT, density: "comfortable" }),
    editing: false,
    onDragStart: fn(),
    onResizeStart: fn(),
    onNudge: fn(),
    onGrow: fn(),
    canGrow: () => true,
    onConfig: fn(),
    onRemove: fn(),
    children: <WidgetMessage>The body goes here — a widget draws only this.</WidgetMessage>,
  },
  decorators: [
    // The card fills its grid area, so the story gives it one — and room below and to the left for
    // the two popovers, which open past the card's own edge by design.
    (Story, { args }) => (
      <div className="p-2 pl-72" style={{ minHeight: args.fit.heightPx + 360 }}>
        <div style={{ width: args.fit.widthPx, height: args.fit.heightPx }}>
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The chrome every home-page widget is drawn in. **A widget draws only its body**; the " +
          "title, the chip, the settings popover, the question before a remove, the grip and the " +
          "resize corner are identical for every kind and live here.\n\n" +
          "While Customize is on the whole card is the drag handle and the body is `inert`, so a " +
          "press anywhere picks the card up; the title field, the tray and the corner carry " +
          "`data-no-drag` and stay controls. **The card does not clip** — its popovers open past " +
          "its edge — and the body scroller is the one box that does.",
      },
    },
  },
} satisfies Meta<typeof WidgetCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At rest: a title and a body, nothing for rearranging the page. */
export const Resting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Collection value" }));
    await expect(card.queryByRole("button", { name: "Move Collection value" })).toBeNull();
  },
};

/** Customize on: the grip, the title as a field, the tray and the resize corner. */
export const Customizing: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Collection value" }));
    await expect(card.getByRole("button", { name: "Move Collection value" })).toBeInTheDocument();
    await expect(card.getByRole("textbox", { name: "Name for Collection value" })).toHaveValue(
      "Collection value",
    );
    await expect(card.getByRole("group", { name: "Customize Collection value" })).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Resize Collection value" })).toBeInTheDocument();
  },
};

/** A wide card renamed by the reader: the chip names the current split beside the title. */
export const WideAndRenamed: Story = {
  args: {
    widget: {
      id: "collectionValue",
      kind: "collectionValue",
      x: 0,
      y: 0,
      w: 4,
      h: 2,
      config: { title: "The binder", dimension: "set" },
    },
    fit: makeFit({
      w: 4,
      h: 2,
      widthPx: spanPx(4, CELL),
      heightPx: spanPx(2, CELL),
      density: "comfortable",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "The binder" }));
    await expect(card.getByText("Set")).toBeInTheDocument();
  },
};

/** The settings popover, opened: size, the kind's picks, density and its switch. */
export const SettingsOpen: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Settings for Collection value" }));
    const panel = within(
      await canvas.findByRole("dialog", { name: "Collection value settings" }),
    );
    await expect(panel.getByRole("group", { name: "Size" })).toBeInTheDocument();
    await expect(panel.getByRole("group", { name: "Split by" })).toBeInTheDocument();
    await expect(panel.getByRole("checkbox", { name: "Show totals" })).toBeChecked();
  },
};

/** The question a remove asks first. Keep closes it and takes nothing off the page. */
export const RemoveQuestion: Story = {
  args: { editing: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Remove Collection value" }));
    const question = await canvas.findByRole("dialog", { name: "Remove Collection value?" });
    await expect(question).toHaveTextContent("Take Collection value off the page?");

    await userEvent.click(within(question).getByRole("button", { name: "Keep" }));
    await waitFor(() =>
      expect(canvas.queryByRole("dialog", { name: "Remove Collection value?" })).toBeNull(),
    );
    await expect(args.onRemove).not.toHaveBeenCalled();
  },
};
