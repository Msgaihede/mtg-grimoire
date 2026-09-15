import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { ScannerTrayRow } from "@/lib/ipc";
import { TRAY_ROWS, VERDICTS } from "../fixtures";
import { rowFromDecision } from "./tray";
import { TrayPanel, type TrayPanelProps } from "./TrayPanel";

/**
 * The tray with its rows and folder held, so a press in the workbench does what it does in the app.
 *
 * `TrayPanel` owns no copy of its rows — every write goes back through `onRows` — so a story drawn
 * straight from `args` would be a stepper that never moves and a pick that never settles. The args
 * seed the state and still receive every call, so the Actions panel shows what the page is handed.
 */
function Held(args: TrayPanelProps) {
  const [rows, setRows] = useState<readonly ScannerTrayRow[]>(args.rows);
  const [folderId, setFolderId] = useState<number | null>(args.folderId);
  return (
    <TrayPanel
      {...args}
      rows={rows}
      onRows={(next) => {
        setRows(next);
        args.onRows(next);
      }}
      folderId={folderId}
      onFolder={(id) => {
        setFolderId(id);
        args.onFolder(id);
      }}
    />
  );
}

/**
 * A row waiting on a pick, built the way the page builds one — out of the Exact fixture's
 * ambiguous decision, through the reducer — rather than written out, so the story cannot draw a
 * waiting row the scanner could never produce.
 */
const waiting = rowFromDecision(VERDICTS.exactAmbiguous.decision!, { finish: "nonfoil" }, 1_757_900_000_000, "waiting");

const meta = {
  title: "Scanner/Reader/Tray",
  component: TrayPanel,
  tags: ["autodocs"],
  render: (args) => <Held {...args} />,
  args: {
    rows: TRAY_ROWS,
    onRows: fn(),
    folderId: null,
    onFolder: fn(),
    onCommit: fn(),
    committing: false,
    commitError: null,
    onMorePrintings: fn(),
    flashKey: null,
  },
  decorators: [
    // The column beside the camera on a wide window — `ScannerPage`'s `w-80` — at a height short
    // enough that a real tray scrolls, because the footer staying in view while the rows scroll
    // is the half of this layout a story at its natural height would never show.
    (Story) => (
      <div className="flex h-[36rem] w-80 flex-col p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TrayPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing scanned yet: the sentence saying where cards will land, and an add that refuses. */
export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Cards you scan appear here.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add 0 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * A tray mid-pile, as `TRAY_ROWS` has it — a card still waiting on a pick at the head, a playset
 * in progress, a foil and the first card scanned — with the second row flashed as a bump would
 * leave it.
 */
export const Rows: Story = {
  args: { flashKey: TRAY_ROWS[1]?.key ?? null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("region", { name: "Scanned cards" })).toBeInTheDocument();
  },
};

/**
 * One card the scanner could not pin to a printing, just landed at the head of the tray — its
 * candidates laid out to press, and the add refusing until it is answered.
 *
 * Over `TRAY_ROWS`' *resolved* rows only: that fixture already carries a waiting Lightning Bolt,
 * and this row is the same decision, so keeping both would put one question on screen twice.
 */
export const NeedsPick: Story = {
  args: { rows: [waiting, ...TRAY_ROWS.filter((row) => row.choices.length === 0)], flashKey: "waiting" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Pick a printing")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^Add \d+ to collection$/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/** The commit under way: the add holds its name, spins, and refuses a second press. */
export const Committing: Story = {
  args: { committing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /^Add \d+ to collection$/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  },
};

/**
 * The commit refused. One transaction, so nothing was filed and every row is still here — the
 * sentence sits above the footer it came from, and the rows it is about stay pressable.
 */
export const CommitRefused: Story = {
  args: { commitError: "Could not add to your collection — the database is busy. Try again in a moment." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Could not add to your collection — the database is busy. Try again in a moment.",
    );
  },
};
