import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { TRAY_ROWS } from "../fixtures";
import { AddedToast, landedFrom, type AddedToastProps } from "./AddedToast";

/**
 * The overlay inside a camera-sized black box, as the page draws it — so where the card sits and
 * how far the edge flash reaches read as they do over the camera — with a press under it that lands
 * the same card again, because the whole point of the thing is an entrance.
 *
 * **The card stays up after its hold.** `onDone` reaches the Actions panel and nothing else: the
 * page answers it by putting the card away, and a workbench story that emptied itself after two
 * seconds would be a story with nothing to inspect.
 */
function Held(args: AddedToastProps) {
  const [landings, setLandings] = useState(0);
  // A fresh stamp per press is exactly what a real landing is, so the replay runs the component's
  // own path — the flash, the entrance and a restarted hold.
  const card = args.card === null ? null : { ...args.card, stamp: `${args.card.stamp}#${landings}` };
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="relative h-[28rem] w-[46rem] max-w-full overflow-hidden rounded-lg bg-black">
        <AddedToast card={card} onDone={args.onDone} />
      </div>
      <button
        type="button"
        onClick={() => setLandings((n) => n + 1)}
        className={cn("h-8 rounded-md border border-border px-3 text-sm", PRESS, FOCUS)}
      >
        Land again
      </button>
    </div>
  );
}

// Each kind built the way the page builds it — a tray row through `landedFrom` — out of the tray
// fixture's rows, whose printings the Storybook corpus holds, so the pictures are real ones.
const [waiting, playset, foil, lotus] = TRAY_ROWS;

const meta = {
  title: "Scanner/Reader/Card added",
  component: AddedToast,
  tags: ["autodocs"],
  render: (args) => <Held {...args} />,
  args: {
    card: landedFrom(lotus, false, false),
    onDone: fn(),
  },
} satisfies Meta<typeof AddedToast>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A card that became a new row in the tray: the tick drawn onto the badge, and its printing. */
export const Added: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Added to scanned cards")).toBeInTheDocument();
    await expect(canvas.getByText("Black Lotus")).toBeInTheDocument();
    await expect(canvas.getByText("LEA · 232 · Nonfoil")).toBeInTheDocument();
  },
};

/** The same printing again, counted onto the newest row: the row's new quantity beside the words. */
export const AddedAgain: Story = {
  args: { card: landedFrom(playset, true, false) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Added again")).toBeInTheDocument();
    await expect(canvas.getByText("×3")).toBeInTheDocument();
    await expect(canvas.getByText("Urza's Saga")).toBeInTheDocument();
  },
};

/** Exact re-read the card Fast had just filed and pinned its printing: the row changed, not the count. */
export const PrintingUpdated: Story = {
  args: { card: landedFrom(foil, false, true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Printing updated")).toBeInTheDocument();
    await expect(canvas.getByText("TMP · 315 · Foil")).toBeInTheDocument();
  },
};

/**
 * Filed, but still waiting on the reader: the first two candidates fanned, the accent at the edge
 * and on the card, and a line saying where the question is answered.
 */
export const PickAPrinting: Story = {
  args: { card: landedFrom(waiting, false, false) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Pick a printing")).toBeInTheDocument();
    await expect(canvas.getByText("3 printings match — pick in the tray")).toBeInTheDocument();
  },
};
