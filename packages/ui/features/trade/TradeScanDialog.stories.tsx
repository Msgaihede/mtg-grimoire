import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@/features/scanner/fixtures";
import { ipc } from "@/lib/ipc";
import type { ScannerTrayRow, Trade, TradeSide } from "@/lib/ipc";
import { TradeScanDialog } from "./TradeScanDialog";

/** The fixture tray's three rows that are not waiting on a pick — five copies. */
const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);

/**
 * The `trades` seed's open trade — `Trade 5`, TCGplayer, both sides at 100% — as far as this
 * dialog reads one: its id, its marketplace and its two percentages. The lines are the Trade
 * page's to draw; pressing Add in the workbench writes to the seeded trade of this id.
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
 * The dialog as the Trade page holds it, over a world whose tray was written first and whose
 * camera refuses — `Scanner/Page`'s arrangement, for its two reasons.
 *
 * **The tray is written through the command, not seeded**: it is an `app_meta` value the fake
 * keeps per world and no seed carries, and the fake's handlers run synchronously inside `invoke`,
 * so the rows are stored before the scanner's first query asks for them. **The camera is refused
 * in the browser's own way** (`NotAllowedError`) from the same `useState` initializer, so the stub
 * is in place before `useCamera`'s effect fires, and put back on unmount: neither jsdom nor a
 * sandboxed workbench grants a camera, and without the stub each refuses in a way of its own.
 *
 * `open` and `side` are this host's state, as they are the page's: *Scan onto* really switches,
 * a finished Add really closes, and the button underneath opens it again.
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
        className="m-4 rounded-md border border-border px-3 py-2 text-sm"
      >
        Scan cards
      </button>
      <TradeScanDialog
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

const meta = {
  title: "Trade/Scan dialog",
  component: TradeScanDialog,
  tags: ["autodocs"],
  args: { open: true, trade: TRADE, side: "theirs", onSide: fn(), onClose: fn() },
  render: (args) => (
    <Host trade={args.trade} side={args.side} tray={RESOLVED} onSide={args.onSide} onClose={args.onClose} />
  ),
  parameters: {
    fake: { seed: "trades" },
    // A dialog covers the window it is in, and the scanner under it reads the app store: each
    // docs story gets a frame of its own.
    docs: {
      story: { inline: false, height: "760px" },
      description: {
        component:
          "The Scanner view opened over a trade, filing onto one of its two sides. The camera, " +
          "the modes and filters and the review tray are the scanner's own; the trade's are the " +
          "Scan onto switch, the words on the press, the marketplace the rows are priced at and " +
          "the running total. The tray is the scanner's one stored tray, so cards already in it " +
          "are in this list, and it says so.",
      },
    },
  },
} satisfies Meta<typeof TradeScanDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Open on their side, over a tray that already held five cards — the state a reader who scanned
 * a pile on the Scanner view and came here meets.
 *
 * The heading and the press name the side, the line under the heading says the cards were there
 * before this opened and where Add would send them, and *Clear all…* is on the same panel. Where
 * the Scanner view draws its folder there is the running total, at the trade's marketplace.
 * Nothing of the collection's is drawn: no folder, no *Create deck…*.
 */
export const TheirSide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan cards" });
    const tray = await within(dialog).findByRole("region", { name: "Scanned for their side" });
    await expect(await within(tray).findByText("Urza's Saga")).toBeInTheDocument();
    await expect(
      within(tray).getByRole("button", { name: "Add 5 to their side" }),
    ).not.toHaveAttribute("aria-disabled");
    await expect(within(tray).getByRole("note")).toHaveTextContent(
      /^5 cards were already in the scanner's tray\./,
    );
    await expect(within(tray).getByText("Scanned so far")).toBeInTheDocument();
    await expect(within(dialog).queryByRole("button", { name: /^Folder:/ })).toBeNull();
    await expect(within(dialog).queryByRole("button", { name: "Create deck…" })).toBeNull();
  },
};

/** Opened from the reader's own column: the same list, headed for *You give*. */
export const YourSide: Story = {
  args: { side: "mine" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan cards" });
    await expect(
      within(within(dialog).getByRole("group", { name: "Scan onto" })).getByRole("button", {
        name: "You give",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      await within(dialog).findByRole("button", { name: "Add 5 to your side" }),
    ).toBeInTheDocument();
  },
};

/**
 * *Scan onto*, pressed across with cards already in the list: they are not on a side until Add,
 * so the whole list follows the switch — the heading, the press and the host's own state.
 */
export const SwitchingSides: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan cards" });
    await within(dialog).findByRole("button", { name: "Add 5 to their side" });
    await userEvent.click(within(dialog).getByRole("button", { name: "You give" }));
    await expect(args.onSide).toHaveBeenCalledWith("mine");
    await expect(
      await within(dialog).findByRole("region", { name: "Scanned for your side" }),
    ).toBeInTheDocument();
    await expect(
      within(dialog).getByRole("button", { name: "Add 5 to your side" }),
    ).toBeInTheDocument();
  },
};

/**
 * One card whose finish the scanner could not read. A trade line is a printing *in a finish*, so
 * that card cannot go: the press says how many it will leave, the row's finish is gold, and the
 * header's walk lands on it.
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
    const dialog = await canvas.findByRole("dialog", { name: "Scan cards" });
    await expect(
      await within(dialog).findByRole("button", {
        name: "Add 5 to their side · 1 needs a finish",
      }),
    ).toBeInTheDocument();
  },
};

/**
 * Nothing scanned yet, which is how the dialog opens for a reader whose tray was empty: no line
 * about earlier cards, and Add out of reach until one lands.
 */
export const NothingScanned: Story = {
  render: (args) => (
    <Host trade={args.trade} side={args.side} tray={[]} onSide={args.onSide} onClose={args.onClose} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan cards" });
    await expect(
      await within(dialog).findByText("Cards you scan appear here."),
    ).toBeInTheDocument();
    await expect(within(dialog).queryByRole("note")).toBeNull();
    await expect(within(dialog).getByRole("button", { name: "Add 0 to their side" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};
