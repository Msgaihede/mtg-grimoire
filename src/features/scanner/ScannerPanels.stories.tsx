import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { useAppStore, type ScannerPanelId } from "@/lib/store";
import { STATUS, VERDICTS } from "./fixtures";
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import { ScannerPanels, type ScannerPanelsProps } from "./ScannerPanels";

/**
 * The column, with the named panels open and the rest folded.
 *
 * **The folds are written during render, and both halves of that are load-bearing.** They live
 * in `useAppStore` — the one global the fake cannot make per-story — so a story has to set them
 * itself; and the preview's `FakeWorld` decorator restores the whole store from a snapshot
 * inside its own `useMemo`, which runs before any child renders. A `beforeEach` or a loader
 * would therefore be undone by the decorator on the way in, and an effect would draw the folded
 * column for a frame and then jump. `useState`'s initializer is the one place that is after the
 * reset and before the paint — the lever `CardZoomIndicator.stories.tsx` reaches for, for its
 * own version of this reason.
 */
function Column({ open, ...props }: ScannerPanelsProps & { open: readonly ScannerPanelId[] }) {
  useState(() => {
    useAppStore.setState({
      scannerFolds: {
        controls: open.includes("controls"),
        pipeline: open.includes("pipeline"),
        budget: open.includes("budget"),
        rectified: open.includes("rectified"),
        readouts: open.includes("readouts"),
      },
    });
  });

  return <ScannerPanels {...props} />;
}

/** A story's `render`, naming the panels it wants open. No arguments is every panel folded. */
function column(...open: ScannerPanelId[]) {
  return (args: ScannerPanelsProps) => <Column open={open} {...args} />;
}

const meta = {
  title: "Scanner/Panels",
  component: ScannerPanels,
  tags: ["autodocs"],
  render: column(),
  args: {
    status: STATUS.present,
    verdict: VERDICTS.voting,
    roundTripMs: 180,
    rate: 5.6,
    options: DEFAULT_SCANNER_OPTIONS,
    sendPx: DEFAULT_SEND_PX,
    onOptions: fn(),
    onSendPx: fn(),
    onReset: fn(),
    onCapture: fn(async () => "live-1.jpg"),
  },
  decorators: [
    // The column's own width in the shipped window — the panels sit beside the video, and this
    // is the box every figure row, slider row and standings row has to survive.
    (Story) => (
      <div className="w-80 p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    // Every story here writes `useAppStore` during render, and the store is the one global
    // that cannot be made per-story. Without this, the docs page would mount all of them at
    // once and every heading would show the last writer's folds.
    docs: { story: { inline: false, height: "720px" } },
  },
} satisfies Meta<typeof ScannerPanels>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Evidence accumulating under the vote rule, with a second candidate still arguing.
 *
 * Five votes of the eight it wants and a lead of ×4 over Honored Hierarch — so the bar is part
 * full and grey rather than gold, and the pill says `voting` rather than `decided`. This is
 * what most frames look like: the answer is probably right and the scanner has not said so yet.
 */
export const Voting: Story = {
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("voting")).toBeInTheDocument();
    await expect(within(match).getByText("Plains — 2XM 373")).toBeInTheDocument();
  },
};

/**
 * The bar full, the pill gold, and nothing left arguing with it.
 *
 * `lead` reads `unopposed` rather than a multiple: the runner-up did not merely lose, it never
 * scored. A committed verdict freezes the tracker, which is why the frame count stops at eight.
 */
export const Decided: Story = {
  args: { verdict: VERDICTS.decided },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("decided")).toBeInTheDocument();
    await expect(within(match).getByText("unopposed")).toBeInTheDocument();
  },
};

/**
 * The other commit rule, and the two words that go with it.
 *
 * Under `confidence` the bar is a decayed two-way share rather than a tally, so it commits at a
 * *proportion* — the hairline moves to 70% — and the pill reads `confirmed`/`gathering` where
 * the vote rule reads `decided`/`voting`. The same evidence, with a different question asked of
 * it.
 */
export const ConfidenceRule: Story = {
  args: { verdict: VERDICTS.confidence },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("confirmed")).toBeInTheDocument();
    await expect(within(match).getByText("80% over 12f")).toBeInTheDocument();
  },
};

/**
 * A card the detector is happy with that the reference bundle cannot name.
 *
 * `match: null` with `ok: true` — the quad is good and the rectification is good, and no
 * descriptor in 117,630 came close enough. Every match-derived row is an em dash and the
 * standings are empty, which is a different picture from a frame with no card in it.
 */
export const NoMatch: Story = {
  args: { verdict: VERDICTS.noMatch },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("this frame: no match")).toBeInTheDocument();
  },
};

/**
 * No quadrilateral in the frame looked like a card.
 *
 * The commonest failure by far — a hand over a corner, a card off the edge, the table's own
 * rectangle winning. Nothing downstream of the detector ran, so there is no rectification, no
 * hash and no timings; the Rectified panel is open here to show that it says so rather than
 * drawing an empty box or a zero.
 */
export const NoCard: Story = {
  args: { verdict: VERDICTS.noCard },
  render: column("rectified"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("this frame: no card")).toBeInTheDocument();
    await expect(canvas.getByText("no rectification")).toBeInTheDocument();
  },
};

/**
 * The detector threw, and the frame carries the sentence instead of an answer.
 *
 * It draws exactly as {@link NoCard} does, which is the point rather than a shortcut: a panic
 * is a bug to be read in the log, and a panel that decorated it would invite a reader to treat
 * it as a scanning condition they could improve by moving the card.
 */
export const Panicked: Story = {
  args: { verdict: VERDICTS.panicked },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("this frame: no card")).toBeInTheDocument();
  },
};

/**
 * `card-hashes.bin` is not on disk, so nothing can be named at all.
 *
 * The sentence stands **where the card's name would**, and it carries the path it looked at —
 * the one thing a reader needs in order to fix it. Everything else about the panel still draws:
 * the detector works fine without a bundle, it simply has nothing to compare against.
 */
export const BundleMissing: Story = {
  args: { status: STATUS.missing, verdict: VERDICTS.noCard },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/No reference bundle\. Put/)).toBeInTheDocument();
  },
};

/**
 * The two `.rten` files are absent, so both OCR tiers stand down.
 *
 * The bundle is there and the appearance match carries the frame alone — a supported state
 * rather than a broken one, and the readouts say so once at the top instead of leaving a reader
 * to infer it from a column of em dashes.
 */
export const ModelsMissing: Story = {
  args: { status: STATUS.noModels },
  render: column("readouts"),
  play: async ({ canvasElement }) => {
    const readouts = within(canvasElement).getByRole("region", { name: "Readouts" });
    await expect(within(readouts).getByText(/No OCR models\. Put/)).toBeInTheDocument();
  },
};

/**
 * Every knob the detector takes, open.
 *
 * Three segments and eight sliders in a 320px column — the row template is `76px / 1fr / 46px`,
 * which is the narrowest the name, the track and the figure all fit in. `send px` is last and
 * is not one of the seven: it is the size a frame is downscaled to *before* it is sent, so the
 * detector never sees it and it has no `FrameOptions` field to live in.
 */
export const ControlsOpen: Story = {
  render: column("controls"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("slider", { name: "decide at" })).toBeInTheDocument();
    await expect(canvas.getByRole("slider", { name: "send px" })).toBeInTheDocument();
  },
};

/**
 * The four developer panels a frame that reached matching can fill, all open at once.
 *
 * Not how a reader would use them — the whole point of the folds is that this column is one
 * heading per question — but it is the only view that shows the panels *stacked*, which is
 * where a figure row too wide for 320px turns up.
 */
export const EverythingOpen: Story = {
  args: { verdict: VERDICTS.decided },
  render: column("controls", "budget", "rectified", "readouts"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("region", { name: "Frame budget" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Rectified" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Readouts" })).toBeInTheDocument();
  },
};
