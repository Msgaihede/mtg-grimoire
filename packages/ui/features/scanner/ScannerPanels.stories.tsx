import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { useAppStore, type ScannerPanelId } from "@/lib/store";
import { STATUS, VERDICTS } from "./fixtures";
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
    useAppStore.setState({ scannerFolds: { budget: open.includes("budget") } });
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
    // A real `performance.now()` delta rather than a round number — the figure this row prints
    // came off the clock and the panel is what rounds it. A `180` here cannot tell a `.toFixed(1)`
    // from a bare interpolation, which is how `288.39999999999998 ms` reached the shipped window.
    // **The digits have to be in the double, not just in the literal**: `288.39999999999998`
    // parses to the same double as `288.4` and `String()`s back as `"288.4"`, so it would prove
    // nothing here. This one round-trips long.
    roundTripMs: 288.4000000000001,
    rate: 5.6,
    onCapture: fn(async () => "live-1.jpg"),
  },
  decorators: [
    // The column's own width in the shipped window — the panels sit beside the video, and this
    // is the box every figure row and standings row has to survive.
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
 * Evidence accumulating, with a second candidate still in the standings.
 *
 * The leader's votes at five eighths of the bar. This is what most frames look like: the answer
 * is probably right and the scanner has not said so yet. The card's name and the bar are the
 * Match strip's above the camera (`Scanner/Reader/Match strip`); this panel is the numbers under
 * them.
 */
export const Voting: Story = {
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("1.3/2 · 3f")).toBeInTheDocument();
    await expect(within(match).getAllByRole("listitem")).toHaveLength(2);
  },
};

/** Decided: the bar full, one standing, and the distance the picture matched at. */
export const Decided: Story = {
  args: { verdict: VERDICTS.decided },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("2.0/2 · 2f")).toBeInTheDocument();
    await expect(within(match).getByText("0.043 (11/256)")).toBeInTheDocument();
  },
};

/**
 * A card in the frame the recogniser could not place.
 *
 * `match: null` with `ok: true` — the detector found a card and no picture in the gallery came
 * close enough. Every match-derived row is an em dash and the standings are empty, which is a
 * different picture from a frame with no card in it.
 */
export const NoMatch: Story = {
  args: { verdict: VERDICTS.noMatch },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("this frame: no match")).toBeInTheDocument();
  },
};

/** No card in the frame — the commonest frame by far: a hand over the lens, an empty desk. */
export const NoCard: Story = {
  args: { verdict: VERDICTS.noCard },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(within(match).getByText("this frame: no card")).toBeInTheDocument();
  },
};

/**
 * The scanner panicked, and the frame carries the sentence instead of an answer.
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
 * The recogniser's files are there and did not load, so nothing can be named at all.
 *
 * The sentence stands **at the top of the panel**, above the figures it explains, in the load's
 * own words.
 */
export const RecognizerDidNotLoad: Story = {
  args: { status: STATUS.corrupt, verdict: VERDICTS.noCard },
  play: async ({ canvasElement }) => {
    const match = within(canvasElement).getByRole("region", { name: "Match" });
    await expect(
      within(match).getByText("The card recognizer did not load: gallery: bad magic."),
    ).toBeInTheDocument();
  },
};

/**
 * Where a frame's time went, open: the JPEG's decode, the recogniser's read, and what is left of
 * the round trip for everything this side paid for.
 */
export const BudgetOpen: Story = {
  args: { verdict: VERDICTS.decided },
  render: column("budget"),
  play: async ({ canvasElement }) => {
    const budget = within(canvasElement).getByRole("region", { name: "Frame budget" });
    await expect(within(budget).getByText("18.4 ms")).toBeInTheDocument();
    await expect(within(budget).getByText("288.4 ms")).toBeInTheDocument();
  },
};
