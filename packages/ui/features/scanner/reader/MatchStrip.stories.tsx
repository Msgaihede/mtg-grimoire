import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { VERDICTS } from "../fixtures";
import { MatchStrip } from "./MatchStrip";
import type { LastAdded } from "./readerText";

/** The tray's newest row after the decided fixture's decision landed on it. */
const saruman: LastAdded = {
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  bumpedTo: null,
  replaced: false,
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
    lastAdded: null,
    onReset: fn(),
    // A live camera, which is every state but `NoPictureToSend`'s: the page hands the strip this
    // press only while there is a picture to send.
    onSend: fn(),
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
 * The evidence building: the leader drawn dim beside a dim bar, and the line at the bar's end. The name is drawn and not announced — it can change on the next frame.
 */
export const Matching: Story = {
  play: async ({ args, canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent("Matching Plains 2XM 373 Hold steady");
    const bar = within(canvasElement).getByRole("progressbar", { name: "Match progress" });
    await expect(bar).toHaveAttribute("aria-valuenow", "63");
    await expect(within(canvasElement).getByText("Plains")).toHaveAttribute("aria-hidden", "true");
    // Reset evidence sits at the bar's end, outside the live region, for every reader.
    const reset = within(canvasElement).getByRole("button", { name: "Reset evidence" });
    await expect(status(canvasElement)).not.toContainElement(reset);
    await userEvent.click(reset);
    await expect(args.onReset).toHaveBeenCalledOnce();
    // Send scan… stands beside it wherever the page hands the strip the press, and hands up the
    // press it was given — the page keeps that for the caret.
    const send = within(canvasElement).getByRole("button", { name: "Send scan…" });
    await expect(status(canvasElement)).not.toContainElement(send);
    await userEvent.click(send);
    await expect(args.onSend).toHaveBeenCalledWith(send);
  },
};

/**
 * Nothing the scanner has been shown — the camera refused or not open yet, or recognition
 * stopped — so the page hands the strip no press and *Send scan…* is not drawn: a scan is the
 * last couple of seconds of frames, and there are none. Reset stays: the evidence it throws away
 * is the scanner's, and that is there whatever the camera is doing.
 */
export const NoPictureToSend: Story = {
  args: { verdict: null, onSend: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Send scan…" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
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

/**
 * A filter changed with the card still on the mat, and the scanner pinned another printing of
 * it — a second opinion on the newest row: an update, not an add.
 */
export const PrintingUpdated: Story = {
  args: {
    verdict: VERDICTS.resolved,
    lastAdded: {
      name: "Black Lotus",
      setCode: "lea",
      collectorNumber: "232",
      bumpedTo: null,
      replaced: true,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent(
      "Matched Black Lotus LEA 232 Printing updated",
    );
  },
};

/**
 * The picture stands for three printings: decided on a card, not a printing, and the tray row is
 * waiting on the reader. Asked off the decision itself, on every frame it stands.
 */
export const PickAPrinting: Story = {
  args: {
    verdict: VERDICTS.ambiguous,
    lastAdded: {
      name: "Lightning Bolt",
      setCode: "2x2",
      collectorNumber: "117",
      bumpedTo: null,
      replaced: false,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent(
      "3 printings Lightning Bolt Pick a printing in the tray",
    );
  },
};

/**
 * No recogniser loaded: nothing can be named. The longest sentence the strip says, and the one
 * state it is allowed to wrap in — it holds rather than flickers.
 */
export const CantIdentify: Story = {
  args: { verdict: { ...VERDICTS.noCard, matcher: false } },
  play: async ({ canvasElement }) => {
    await expect(status(canvasElement)).toHaveTextContent(
      "Can't identify The card recognizer isn't loaded",
    );
  },
};
