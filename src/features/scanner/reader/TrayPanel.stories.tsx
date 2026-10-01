import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ScannerTrayLayout, ScannerTrayRow } from "@/lib/ipc";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS, VERDICTS } from "../fixtures";
import { rowFromDecision } from "./tray";
import { TrayPanel, type TrayPanelProps } from "./TrayPanel";

/**
 * The tray with its rows, folder and layout held, so a press in the workbench does what it does in
 * the app.
 *
 * `TrayPanel` owns no copy of its rows — every write goes back through `onRows` — so a story drawn
 * straight from `args` would be a stepper that never moves and a pick that never settles; the
 * layout toggle is the same, a press the page stores. The args seed the state and still receive
 * every call, so the Actions panel shows what the page is handed.
 */
function Held(args: TrayPanelProps) {
  const [rows, setRows] = useState<ScannerTrayRow[]>(() => [...args.rows]);
  const [folderId, setFolderId] = useState<number | null>(args.folderId);
  const [layout, setLayout] = useState<ScannerTrayLayout>(args.layout);
  return (
    <TrayPanel
      {...args}
      rows={rows}
      // An updater, as the page applies it: to the rows as they are, not as this render drew them.
      onRows={(update) => {
        setRows(update);
        args.onRows(update);
      }}
      folderId={folderId}
      onFolder={(id) => {
        setFolderId(id);
        args.onFolder(id);
      }}
      layout={layout}
      onLayout={(next) => {
        setLayout(next);
        args.onLayout(next);
      }}
    />
  );
}

/**
 * How wide the tray is drawn, by the page's own two answers: the fixed column below 88rem, and
 * roughly the third of the view it takes from there on a wide window.
 */
const COLUMN_WIDTH = "25rem";
const THIRD_WIDTH = "36rem";

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
    // The stories written before the grid are about the list, and keep drawing it; the grid's own
    // stories below say `grid`, which is what the page opens on.
    layout: "list",
    onLayout: fn(),
  },
  parameters: { trayWidth: COLUMN_WIDTH },
  decorators: [
    // The column beside the camera — `ScannerPage`'s 25rem below 88rem, or a story's own
    // `trayWidth` — at a height short enough that a real tray scrolls, because the footer staying
    // in view while the rows scroll is the half of this layout a story at its natural height would
    // never show. A width rather than a class, so a story can name any width without a Tailwind
    // class having to exist for it.
    (Story, { parameters }) => (
      <div className="flex h-[36rem] flex-col p-2" style={{ width: parameters.trayWidth as string }}>
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

/**
 * A card whose finish the scanner could not read, at the head of a resolved tray: its finish reads
 * `Unknown` on a gold border, and Add files the other five copies and says it is leaving this one —
 * the row stays behind, marked, until the reader picks.
 */
export const NeedsFinish: Story = {
  args: {
    rows: [NEEDS_A_FINISH_ROW, ...TRAY_ROWS.filter((row) => row.choices.length === 0)],
    flashKey: NEEDS_A_FINISH_ROW.key,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Finish of Lightning Bolt — STA 105" })).toHaveTextContent(
      "Unknown",
    );
    await expect(
      canvas.getByRole("button", { name: "Add 5 to collection · 1 needs a finish" }),
    ).not.toHaveAttribute("aria-disabled");
  },
};

/** Every card still waiting on a finish: nothing Add could file, so it refuses and says why. */
export const AllNeedFinish: Story = {
  args: { rows: [NEEDS_A_FINISH_ROW, { ...NEEDS_A_FINISH_ROW, key: "second", addedAt: 1 }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Add 0 to collection · 2 need a finish" }),
    ).toHaveAttribute("aria-disabled", "true");
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

/**
 * The grid, as the page opens on it, a third of a wide window across — `TRAY_ROWS` as tiles: the
 * waiting Lightning Bolt two columns wide with its candidates to press, the playset in progress
 * wearing its count, the foil wearing its chip, and the first card scanned. The second row is
 * flashed as a bump would leave it.
 */
export const Grid: Story = {
  args: { layout: "grid", flashKey: TRAY_ROWS[1]?.key ?? null },
  parameters: { trayWidth: THIRD_WIDTH },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "More printings of Urza's Saga — MH2 259" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("group", { name: "Printings of Lightning Bolt" })).toBeInTheDocument();
  },
};

/**
 * The same tray in the 25rem column the page draws below 88rem: two columns, a tile too narrow for
 * its finish and its stepper side by side, so the pair wraps under the name.
 */
export const GridInColumn: Story = {
  args: { layout: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Pick a printing")).toBeInTheDocument();
    await expect(
      canvas.getByRole("spinbutton", { name: "Quantity of Ancient Tomb — TMP 315" }),
    ).toBeInTheDocument();
  },
};

/** An empty grid: the sentence saying where cards will land, the toggle, and an add that refuses. */
export const GridEmpty: Story = {
  args: { layout: "grid", rows: [] },
  parameters: { trayWidth: THIRD_WIDTH },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Cards you scan appear here.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Add 0 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * The toggle pressed: the page is asked for the list, and the same rows are drawn as lines — the
 * card's *More printings…* press keeping the name it had on the tile.
 */
export const SwitchToList: Story = {
  args: { layout: "grid" },
  parameters: { trayWidth: THIRD_WIDTH },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "List" }));
    await expect(args.onLayout).toHaveBeenCalledWith("list");
    await expect(canvas.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "More printings of Urza's Saga — MH2 259" }),
    ).toBeInTheDocument();
  },
};
