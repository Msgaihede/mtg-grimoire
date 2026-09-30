import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { ScannerTracked, ScannerVerdict } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { MatchStrip } from "./MatchStrip";
import type { LastAdded } from "./readerText";

/** The tray's newest row after the Fast fixture's decision landed on it. */
const saruman: LastAdded = {
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  bumpedTo: null,
  replaced: false,
};

/** The confidence rule's tracker still gathering, a little short of its 70% line. */
const gathering: ScannerVerdict = {
  ...VERDICTS.confidence,
  decision: null,
  tracked: { ...(VERDICTS.confidence.tracked as ScannerTracked), committed: false, confidence: 0.55 },
};

/** The strip's region, by the name the view's status line has always had. */
function status(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole("status", { name: "Scanner status" });
}

const meta = {
  title: "Scanner/Reader/Match strip",
  component: MatchStrip,
  tags: ["autodocs"],
  args: {
    verdict: VERDICTS.voting,
    mode: "fast",
    lastAdded: null,
    hasBundle: true,
    lastResolution: null,
  },
  decorators: [
    // The camera's column at the app's narrow rung: `ScanBar.stories.tsx`'s 1032px content column
    // less the tray's `w-80` and the 16px gap between them — the width the name has to give way in.
    (Story) => (
      <div className="w-[696px] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MatchStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No card in frame: the sentence stands where a name would, and the bar is empty. */
export const Looking: Story = {
  args: { verdict: null },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Looking Point the camera at a card");
  },
};

/**
 * Fast, with the evidence building: the leader drawn dim beside a dim bar, and the line at the
 * bar's end. The name is drawn and not announced — it can change on the next frame.
 */
export const Matching: Story = {
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Matching Plains 2XM 373 Hold steady");
    await expect(within(canvasElement).getByText("Plains")).toHaveAttribute("aria-hidden", "true");
  },
};

/** Exact, the card locked and its name and number being read. */
export const Reading: Story = {
  args: { mode: "exact" },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Reading Plains 2XM 373 Hold steady — reading…");
  },
};

/** The confidence rule commits at a proportion, so its line sits at 70% rather than at the end. */
export const ConfidenceRule: Story = {
  args: { verdict: gathering },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("progressbar", { name: "Match progress" });
    await expect(bar).toHaveAttribute("aria-valuenow", "55");
  },
};

/** Decided and filed: the pill and the bar gold, and the card named as the tray filed it. */
export const Matched: Story = {
  args: { verdict: VERDICTS.decided, lastAdded: saruman },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent(
      "Matched Storm of Saruman LTR 72 Added · swap in the next card",
    );
  },
};

/** The same card again, folded into the newest row as a second copy. */
export const AddedAgain: Story = {
  args: { verdict: VERDICTS.decided, lastAdded: { ...saruman, bumpedTo: 2 } },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Added again — ×2");
  },
};

/** Exact re-read the newest card and pinned another printing of it — an update, not an add. */
export const PrintingUpdated: Story = {
  args: {
    verdict: VERDICTS.exactResolved,
    mode: "exact",
    lastAdded: { name: "Black Lotus", setCode: "lea", collectorNumber: "232", bumpedTo: null, replaced: true },
    lastResolution: VERDICTS.exactResolved.resolution,
  },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Matched Black Lotus LEA 232 Printing updated");
  },
};

/** Decided on a card, not a printing: the tray row is waiting on the reader. */
export const PickAPrinting: Story = {
  args: {
    verdict: VERDICTS.exactAmbiguous,
    mode: "exact",
    lastAdded: { name: "Lightning Bolt", setCode: "2x2", collectorNumber: "117", bumpedTo: null, replaced: false },
    lastResolution: VERDICTS.exactAmbiguous.resolution,
  },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent(
      "3 printings Lightning Bolt Pick a printing in the tray",
    );
  },
};

/** An Exact resolve found nothing inside the gate. */
export const NoMatch: Story = {
  args: {
    verdict: VERDICTS.exactNotFound,
    mode: "exact",
    lastResolution: VERDICTS.exactNotFound.resolution,
  },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent(
      "No match Try better lighting or clear the filters.",
    );
  },
};

/**
 * No reference bundle: cards are detected and nothing can be named. The longest sentence the
 * strip says, and the one state it is allowed to wrap in — it holds rather than flickers.
 */
export const CantIdentify: Story = {
  args: { verdict: VERDICTS.decided, hasBundle: false },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Can't identify Card hashes aren't loaded");
  },
};
