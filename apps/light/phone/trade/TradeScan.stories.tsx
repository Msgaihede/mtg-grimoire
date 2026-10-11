import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@grimoire/ui/features/scanner/fixtures";
import { ipc } from "@grimoire/ui/lib/ipc";
import type { ScannerTrayRow, Trade, TradeSide } from "@grimoire/ui/lib/ipc";
import { TradeScan } from "./TradeScan";

/** The fixture tray's three rows that are not waiting on a pick — five copies. */
const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);

/**
 * The `trades` seed's open trade — `Trade 5`, TCGplayer, both sides at 100% — as far as this
 * sheet reads one: its id, its marketplace and its two percentages. Pressing Add in the workbench
 * writes to the seeded trade of this id.
 */
const TRADE: Trade = {
  id: 5,
  name: "Trade 5",
  marketplace: "tcgplayer",
  rateMine: 100,
  rateTheirs: 100,
  status: "open",
  finishedBefore: false,
  outcome: null,
  createdAt: 1_760_000_000,
  closedAt: null,
  lines: [],
};

/**
 * The sheet as the trade's page holds it, over a world whose tray was written first and whose
 * camera refuses — `Phone/Scanner`'s arrangement, for its two reasons: the tray is an `app_meta`
 * value no seed carries, written through the command before the page's first query asks; and the
 * camera is refused in the browser's own way from the same `useState` initializer, and put back
 * on unmount, so the sentence over the picture is the same wherever the story runs.
 *
 * `open` and `side` are this host's state, as they are the page's: *Scan onto* really switches, a
 * finished Add really closes, and the button underneath opens it again.
 */
function Host({
  trade,
  side: startSide,
  tray,
  onSide,
  onClose,
}: {
  trade: Trade;
  side: TradeSide;
  tray: ScannerTrayRow[];
  onSide: (side: TradeSide) => void;
  onClose: () => void;
}) {
  const restore = useState(() => {
    void ipc.setScannerTray(tray);
    const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("x", "NotAllowedError")) },
    });
    return () => {
      if (saved === undefined) Reflect.deleteProperty(navigator, "mediaDevices");
      else Object.defineProperty(navigator, "mediaDevices", saved);
    };
  })[0];
  useEffect(() => restore, [restore]);
  const [open, setOpen] = useState(true);
  const [side, setSide] = useState(startSide);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="m-4 min-h-11 rounded-md border border-border px-3 text-sm"
      >
        Scan cards
      </button>
      <TradeScan
        open={open}
        trade={trade}
        side={side}
        onSide={(next) => {
          onSide(next);
          setSide(next);
        }}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

/**
 * The phone's trade scanner: the Scanner page as a full-height sheet over a trade.
 *
 * **As wide as the canvas, not boxed at 360**, for `Phone/Scanner`'s reason: the page inside lays
 * itself out by the *viewport's* width — one column below 720px, the camera beside the tray from
 * there — so a 360px box in a wide canvas would draw the wide arrangement squeezed. Narrow the
 * canvas with the workbench's viewport tool to see it as a phone held upright draws it.
 */
const meta = {
  title: "Phone/Trade scan",
  component: TradeScan,
  tags: ["autodocs"],
  args: { open: true, trade: TRADE, side: "theirs", onSide: fn(), onClose: fn() },
  render: (args) => (
    <Host trade={args.trade} side={args.side} tray={RESOLVED} onSide={args.onSide} onClose={args.onClose} />
  ),
  decorators: [
    (Story) => (
      <div className="flex h-[40rem] w-full flex-col overflow-hidden bg-bg text-text">
        <Story />
      </div>
    ),
  ],
  parameters: {
    fake: { seed: "trades" },
    docs: {
      // A sheet covers the window it is in: each docs story gets a frame of its own.
      story: { inline: false, height: "660px" },
      description: {
        component:
          "The phone's Scanner page opened over a trade as a full-height sheet, filing onto one " +
          "of the trade's two sides. The camera, the mode, Options and the review tray are the " +
          "scanner's own; the trade's are the Scan onto switch, the words on the press, the " +
          "marketplace the rows are priced at and the running total. The tray is the scanner's " +
          "one stored tray, so cards already in it are in this list, and a line says so.",
      },
    },
  },
} satisfies Meta<typeof TradeScan>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Open on their side, over a tray that already held five cards — what a reader who scanned a
 * pile on the Scanner tab and came here meets.
 *
 * The heading and the press name the side, the line above the tray says the cards were there
 * before this opened, and where the Scanner tab's footer has its folder there is the running
 * total. Nothing of the collection's is drawn.
 */
export const TheirSide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sheet = await canvas.findByRole("dialog", { name: "Scan cards" });
    await expect(
      await within(sheet).findByRole("heading", { name: "Scanned for their side, 5 copies" }),
    ).toBeInTheDocument();
    await expect(
      within(sheet).getByRole("button", { name: "Add 5 to their side" }),
    ).not.toHaveAttribute("aria-disabled");
    await expect(within(sheet).getByRole("note")).toHaveTextContent(
      /^5 cards were already in the scanner's tray\./,
    );
    await expect(within(sheet).getByText("Scanned so far")).toBeInTheDocument();
    await expect(within(sheet).queryByRole("button", { name: /^Folder:/ })).toBeNull();
  },
};

/**
 * *Scan onto*, pressed across with cards already in the list: they are not on a side until Add,
 * so the whole list follows the switch.
 */
export const SwitchingSides: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const sheet = await canvas.findByRole("dialog", { name: "Scan cards" });
    await within(sheet).findByRole("button", { name: "Add 5 to their side" });
    await userEvent.click(within(sheet).getByRole("button", { name: "You give" }));
    await expect(args.onSide).toHaveBeenCalledWith("mine");
    await expect(
      await within(sheet).findByRole("button", { name: "Add 5 to your side" }),
    ).toBeInTheDocument();
    await expect(
      within(sheet).getByRole("heading", { name: "Scanned for your side, 5 copies" }),
    ).toBeInTheDocument();
  },
};

/**
 * One card whose finish the scanner could not read. A trade line is a printing *in a finish*, so
 * that card stays behind: the press says how many it leaves, and the row's finish is a gold press
 * reading `Unknown`.
 */
export const NeedsAFinish: Story = {
  render: (args) => (
    <Host
      trade={args.trade}
      side={args.side}
      tray={[NEEDS_A_FINISH_ROW, ...RESOLVED]}
      onSide={args.onSide}
      onClose={args.onClose}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sheet = await canvas.findByRole("dialog", { name: "Scan cards" });
    await expect(
      await within(sheet).findByRole("button", {
        name: "Add 5 to their side · 1 needs a finish",
      }),
    ).toBeInTheDocument();
    await expect(
      within(sheet).getByRole("button", { name: "Finish of Lightning Bolt — STA 105: Unknown" }),
    ).toBeInTheDocument();
  },
};

/**
 * Nothing scanned yet: no line about earlier cards, and Add out of reach **with its reason in
 * words under it** — the desktop says that reason in a tooltip, which a finger never opens.
 */
export const NothingScanned: Story = {
  render: (args) => (
    <Host trade={args.trade} side={args.side} tray={[]} onSide={args.onSide} onClose={args.onClose} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sheet = await canvas.findByRole("dialog", { name: "Scan cards" });
    await expect(await within(sheet).findByText("Cards you scan appear here.")).toBeInTheDocument();
    await expect(within(sheet).queryByRole("note")).toBeNull();
    await expect(within(sheet).getByRole("button", { name: "Add 0 to their side" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(within(sheet).getByText("Nothing scanned yet")).toBeInTheDocument();
  },
};
