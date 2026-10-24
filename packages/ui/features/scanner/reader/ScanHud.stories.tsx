import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { VERDICTS } from "../fixtures";
import { matchStrip, type LastAdded } from "./readerText";
import { ScanHud, type ScanHudProps } from "./ScanHud";

/** The tray's newest row after the decided fixture's decision landed on it. */
const saruman: LastAdded = {
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  bumpedTo: null,
  replaced: false,
};

/**
 * The HUD inside a black camera-sized box, as the page lays it over the picture: the desktop's
 * camera column (40rem) for the labelled presses, a phone's upright picture for the icons.
 */
function InCamera(args: ScanHudProps) {
  return (
    <div
      className={
        args.variant === "labelled"
          ? "relative h-[28rem] w-[40rem] max-w-full overflow-hidden rounded-lg bg-black"
          : "relative h-[15rem] w-[21rem] max-w-full overflow-hidden rounded-lg bg-black"
      }
    >
      <ScanHud {...args} />
    </div>
  );
}

function bar(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole("progressbar", { name: "Match progress" });
}

const meta = {
  title: "Scanner/Reader/ScanHud",
  component: ScanHud,
  tags: ["autodocs"],
  render: (args) => <InCamera {...args} />,
  args: {
    strip: matchStrip(VERDICTS.voting, null),
    live: true,
    variant: "labelled",
    onReset: fn(),
    // A live camera on a supporter's device, on the Scanner view itself: the page hands the HUD
    // this press only then.
    onSend: fn(),
    note: null,
  },
} satisfies Meta<typeof ScanHud>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The desktop's picture while the evidence builds: the bar dim and part-way along the top edge,
 * and the two presses top-right with their words. The strip's words are announced, not drawn.
 */
export const Labelled: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(bar(canvasElement)).toHaveAttribute("aria-valuenow", "63");
    await expect(canvas.getByRole("status", { name: "Scanner status" })).toHaveTextContent(
      "Matching Plains 2XM 373 Hold steady",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Reset evidence" }));
    await expect(args.onReset).toHaveBeenCalledOnce();
    const send = canvas.getByRole("button", { name: "Send scan…" });
    await userEvent.click(send);
    await expect(args.onSend).toHaveBeenCalledWith(send);
  },
};

/** The phone's picture: the same two presses as 44px round glyphs, named by their words. */
export const Icon: Story = {
  args: { variant: "icon" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Reset evidence" })).toHaveAttribute(
      "aria-label",
      "Reset evidence",
    );
    await expect(canvas.getByRole("button", { name: "Send scan…" })).toHaveAttribute(
      "aria-label",
      "Send scan…",
    );
  },
};

/** Decided and filed: the bar full and gold. The Added popup is what names the card. */
export const Committed: Story = {
  args: { strip: matchStrip(VERDICTS.decided, saruman) },
  play: async ({ canvasElement }) => {
    await expect(bar(canvasElement)).toHaveAttribute("aria-valuenow", "100");
    await expect(bar(canvasElement).firstElementChild).toHaveClass("bg-accent");
  },
};

/**
 * No recogniser loaded: the strip's error, in the chip at the top-left under the bar — the one
 * sentence the HUD draws rather than only announces.
 */
export const Error: Story = {
  args: { strip: matchStrip({ ...VERDICTS.noCard, matcher: false }, null) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "The card recognizer isn't loaded, so cards can't be identified.",
    );
  },
};
