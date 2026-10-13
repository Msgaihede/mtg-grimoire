import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { ScannerAssetsOwed, ScannerTrayRow, Trade, TradeSide } from "@/lib/ipc";

/**
 * The commands a Scanner view asks as it mounts, each answered — `ScannerPage.test.tsx`'s table,
 * with the trade's one write beside it. `tradeAddLines` is mocked here rather than answered by
 * the fake: this file is about what the dialog *sends*.
 */
vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  const { DEFAULT_SCANNER_PREFS: prefs, STATUS: status } = await import(
    "@/features/scanner/fixtures"
  );
  return {
    ...real,
    ipc: {
      ...real.ipc,
      scannerStatus: vi.fn(async () => status.missing),
      scannerAssets: vi.fn(
        (): Promise<ScannerAssetsOwed> =>
          Promise.reject(new Error("There is no command named scanner_assets on this host.")),
      ),
      onScannerAssets: vi.fn(() => () => {}),
      scannerElsewhere: vi.fn(async () => false),
      scannerHold: vi.fn(async () => {}),
      // Parked: a frame that never answers, so a camera that opens sends one and waits.
      scannerFrame: vi.fn(() => new Promise(() => {})),
      scannerReset: vi.fn(async () => {}),
      scannerPrefs: vi.fn(async () => prefs),
      setScannerPrefs: vi.fn(async () => {}),
      scannerSetFilters: vi.fn(async () => {}),
      scannerTray: vi.fn(async (): Promise<ScannerTrayRow[]> => []),
      setScannerTray: vi.fn(async () => {}),
      scannerTrayCommit: vi.fn(),
      collectionFolderList: vi.fn(async () => []),
      deckLastFormat: vi.fn(async () => null),
      formatSpecs: vi.fn(async () => []),
      deckFolderList: vi.fn(async () => []),
      getMarketplace: vi.fn(async () => "tcgplayer"),
      marketplaceFeedStatus: vi.fn(async () => []),
      printingPrices: vi.fn(async () => []),
      // The Scanner view reads the membership for its Send scan press, which is never drawn over
      // a trade. Answered so the read stays off the real core; a supporter's, so a press that
      // did appear here would not be hidden by this answer.
      syncSupporterStatus: vi.fn(async () => ({
        entitled: true,
        status: "active",
        since: 1_756_000_000,
        groupBound: true,
      })),
      tradeAddLines: vi.fn(async () => {}),
    },
  };
});
// The window is on screen: `useWindowParked`'s own suite owns the minimize.
vi.mock("@/features/scanner/useWindowParked", () => ({
  useWindowParked: () => ({ paused: false, released: false }),
}));

import {
  DEFAULT_SCANNER_PREFS,
  NEEDS_A_FINISH_ROW,
  TRAY_ROWS,
} from "@/features/scanner/fixtures";
import { ipc } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";
import { TradeScanDialog } from "./TradeScanDialog";

/** The fixture tray's three rows that are not waiting on a pick — five copies. */
const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);
const [SAGA, TOMB, LOTUS] = RESOLVED;

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
 * The dialog as its host holds it: `open` and `side` are the host's state, and `onClose` and
 * `onSide` write them. The two spies see every call on the way.
 */
function Host({
  trade,
  startSide,
  startOpen,
  onClose,
  onSide,
}: {
  trade: Trade;
  startSide: TradeSide;
  startOpen: boolean;
  onClose: () => void;
  onSide: (side: TradeSide) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [side, setSide] = useState(startSide);
  return (
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
  );
}

function mount({
  tray = [],
  trade = TRADE,
  side = "theirs",
  open = true,
}: { tray?: ScannerTrayRow[]; trade?: Trade; side?: TradeSide; open?: boolean } = {}) {
  vi.mocked(ipc.scannerTray).mockResolvedValue(tray);
  const onClose = vi.fn();
  const onSide = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Host trade={trade} startSide={side} startOpen={open} onClose={onClose} onSide={onSide} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onClose, onSide };
}

const dialog = () => screen.findByRole("dialog", { name: "Scan cards" });
const add = (name: string) => screen.findByRole("button", { name });

/** Install `props` on `target`, and hand back the function that puts what was there back. */
function shim(target: object, props: Record<string, PropertyDescriptor>): () => void {
  const saved = Object.keys(props).map(
    (key) => [key, Object.getOwnPropertyDescriptor(target, key)] as const,
  );
  Object.entries(props).forEach(([key, descriptor]) =>
    Object.defineProperty(target, key, { configurable: true, ...descriptor }),
  );
  return () =>
    saved.forEach(([key, descriptor]) => {
      if (descriptor === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, descriptor);
    });
}

/** `Overlay` asks for a 2D context on every animation frame, which jsdom answers with a
 *  "Not implemented" line; the scanner's own suite hands it this for the same reason. */
const context2d = () => ({
  clearRect: () => {},
  drawImage: () => {},
  save: () => {},
  restore: () => {},
  setLineDash: () => {},
  beginPath: () => {},
  closePath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  arc: () => {},
  stroke: () => {},
  fill: () => {},
  lineWidth: 0,
  strokeStyle: "",
  fillStyle: "",
});

const COMMANDS = [
  ipc.scannerElsewhere,
  ipc.scannerHold,
  ipc.scannerPrefs,
  ipc.scannerTray,
  ipc.setScannerTray,
  ipc.scannerTrayCommit,
  ipc.collectionFolderList,
  ipc.printingPrices,
  ipc.tradeAddLines,
];

let restore: (() => void)[] = [];
beforeEach(() => {
  restore = [
    shim(HTMLCanvasElement.prototype, {
      getContext: { value: context2d },
      toBlob: { value: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array([1])])) },
    }),
  ];
});
afterEach(() => {
  restore.forEach((undo) => undo());
  COMMANDS.forEach((command) => vi.mocked(command).mockReset());
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("TradeScanDialog", () => {
  it("mounts no scanner, and asks for nothing, while it is closed", async () => {
    mount({ open: false, tray: RESOLVED });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ipc.scannerElsewhere).not.toHaveBeenCalled();
    expect(ipc.scannerHold).not.toHaveBeenCalled();
    expect(ipc.scannerTray).not.toHaveBeenCalled();
  });

  it("adds the scanned cards to the side it is on, each line marked as a scan, and closes", async () => {
    const { onClose } = mount({ tray: RESOLVED, side: "theirs" });
    const panel = await dialog();
    expect(
      await within(panel).findByRole("region", { name: "Scanned for their side" }),
    ).toBeInTheDocument();
    await userEvent.click(await add("Add 5 to their side"));

    await waitFor(() => expect(ipc.tradeAddLines).toHaveBeenCalledTimes(1));
    expect(ipc.tradeAddLines).toHaveBeenCalledWith(5, "theirs", [
      { cardId: SAGA.cardId, finish: "nonfoil", quantity: 3, source: "scan" },
      { cardId: TOMB.cardId, finish: "foil", quantity: 1, source: "scan" },
      { cardId: LOTUS.cardId, finish: "nonfoil", quantity: 1, source: "scan" },
    ]);
    // Nothing went to the collection: the tray's own commit is the Scanner view's.
    expect(ipc.scannerTrayCommit).not.toHaveBeenCalled();
    // One toast for the press, outliving the dialog that closes on it.
    await waitFor(() => expect(useNotifications.getState().notices).toHaveLength(1));
    expect(useNotifications.getState().notices[0]?.title).toBe("Added 5 cards to their side");
    // Nothing is left to decide, so the dialog closes — and the emptied tray is stored on the
    // way out, by the tray's unmount flush.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ipc.setScannerTray).toHaveBeenLastCalledWith([]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends the cards to your side when that is the side it opened on", async () => {
    mount({ tray: [LOTUS], side: "mine" });
    await userEvent.click(await add("Add 1 to your side"));
    await waitFor(() => expect(ipc.tradeAddLines).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.tradeAddLines).mock.calls[0].slice(0, 2)).toEqual([5, "mine"]);
  });

  it("switches the side with Scan onto, and the cards in the list go to the side it is then on", async () => {
    const { onSide } = mount({ tray: [LOTUS], side: "mine" });
    const panel = await dialog();
    const onto = within(panel).getByRole("group", { name: "Scan onto" });
    const mine = within(onto).getByRole("button", { name: "You give" });
    const theirs = within(onto).getByRole("button", { name: "They give" });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(theirs).toHaveAttribute("aria-pressed", "false");
    await add("Add 1 to your side");

    // A press on the side it is already on is not a change.
    await userEvent.click(mine);
    expect(onSide).not.toHaveBeenCalled();

    await userEvent.click(theirs);
    expect(onSide).toHaveBeenCalledTimes(1);
    expect(onSide).toHaveBeenCalledWith("theirs");
    expect(theirs).toHaveAttribute("aria-pressed", "true");
    expect(
      await within(panel).findByRole("region", { name: "Scanned for their side" }),
    ).toBeInTheDocument();
    await userEvent.click(await add("Add 1 to their side"));
    await waitFor(() => expect(ipc.tradeAddLines).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.tradeAddLines).mock.calls[0].slice(0, 2)).toEqual([5, "theirs"]);
  });

  it("leaves a card that still needs a finish in the tray, says so on the press, and stays open over it", async () => {
    const { onClose } = mount({ tray: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    await userEvent.click(await add("Add 5 to their side · 1 needs a finish"));
    await waitFor(() => expect(ipc.tradeAddLines).toHaveBeenCalledTimes(1));
    // Three lines: the row of unknown finish is not one of them.
    expect(vi.mocked(ipc.tradeAddLines).mock.calls[0][2]).toHaveLength(3);
    const tray = await screen.findByRole("region", { name: "Scanned for their side" });
    await waitFor(() => expect(within(tray).getAllByRole("listitem")).toHaveLength(1));
    expect(within(tray).getByRole("listitem")).toHaveTextContent("Lightning Bolt");
    expect(
      screen.getByRole("button", { name: "Add 0 to their side · 1 needs a finish" }),
    ).toHaveAttribute("aria-disabled", "true");
    // Exactly the rows that went are the rows that left, and that is what is stored.
    await waitFor(
      () => expect(ipc.setScannerTray).toHaveBeenLastCalledWith([NEEDS_A_FINISH_ROW]),
      { timeout: 3000 },
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Scan cards" })).toBeInTheDocument();
  });

  it("keeps every card in the tray when the trade refuses them, and says the refusal", async () => {
    vi.mocked(ipc.tradeAddLines).mockRejectedValue(
      "This trade is finished. Reopen it to change it.",
    );
    const { onClose } = mount({ tray: RESOLVED });
    await userEvent.click(await add("Add 5 to their side"));
    // In the tray, where a refused Add is said — the video box has an alert of its own here,
    // for the camera jsdom does not have.
    const tray = screen.getByRole("region", { name: "Scanned for their side" });
    expect(await within(tray).findByRole("alert")).toHaveTextContent(
      "This trade is finished. Reopen it to change it.",
    );
    expect(within(tray).getAllByRole("listitem")).toHaveLength(3);
    // Still there to press again, and nothing was written over the stored tray.
    expect(screen.getByRole("button", { name: "Add 5 to their side" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ipc.setScannerTray).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("will not close while the write is out", async () => {
    let answer: () => void = () => {};
    vi.mocked(ipc.tradeAddLines).mockImplementation(
      () => new Promise<void>((resolve) => (answer = resolve)),
    );
    const { onClose } = mount({ tray: [LOTUS] });
    await userEvent.click(await add("Add 1 to their side"));
    await waitFor(() => expect(ipc.tradeAddLines).toHaveBeenCalledTimes(1));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close the scanner" }));
    expect(onClose).not.toHaveBeenCalled();
    answer();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("says so when the tray already held cards as it opened", async () => {
    mount({ tray: RESOLVED });
    const tray = await screen.findByRole("region", { name: "Scanned for their side" });
    expect(await within(tray).findByRole("note")).toHaveTextContent(
      "5 cards were already in the scanner's tray. They are in this list and go onto their side with the rest.",
    );
    // The reader's way out is on the page with it.
    expect(within(tray).getByRole("button", { name: "Clear all…" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("says nothing of the kind over a tray that opened empty", async () => {
    mount({ tray: [] });
    const empty = await screen.findByRole("region", { name: "Scanned for their side" });
    expect(await within(empty).findByText("Cards you scan appear here.")).toBeInTheDocument();
    expect(within(empty).queryByRole("note")).toBeNull();
  });

  it("words the clear question for the side, not the collection", async () => {
    mount({ tray: RESOLVED, side: "mine" });
    const tray = await screen.findByRole("region", { name: "Scanned for your side" });
    await userEvent.click(await within(tray).findByRole("button", { name: "Clear all…" }));
    expect(await screen.findByRole("dialog", { name: "Clear the tray" })).toHaveTextContent(
      "5 scanned copies will leave the tray without being added to your side.",
    );
  });

  it("draws nothing that belongs to the collection or to the Scanner view alone", async () => {
    // The Developer switch stored on, as a reader who uses the panels leaves it.
    vi.mocked(ipc.scannerPrefs).mockResolvedValue({ ...DEFAULT_SCANNER_PREFS, developer: true });
    mount({ tray: RESOLVED });
    const panel = await dialog();
    await within(panel).findByText("Urza's Saga");
    expect(within(panel).queryByRole("button", { name: /^Folder:/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Create deck…" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /to collection/ })).toBeNull();
    expect(within(panel).queryByRole("switch", { name: "Developer" })).toBeNull();
    expect(within(panel).queryByRole("region", { name: "Match" })).toBeNull();
    // The scanner's own controls are all still there.
    expect(within(panel).getByRole("group", { name: "Scan mode" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Stop scanning" })).toBeInTheDocument();
    // And the stored switch was not written by merely opening here.
    expect(ipc.setScannerPrefs).not.toHaveBeenCalled();
  });

  it("prices the list at the trade's own marketplace and percentage", async () => {
    vi.mocked(ipc.printingPrices).mockResolvedValue([
      { cardId: SAGA.cardId, finishPrices: { nonfoil: 10, foil: 40, etched: null } },
      { cardId: TOMB.cardId, finishPrices: { nonfoil: 1, foil: 20, etched: null } },
      { cardId: LOTUS.cardId, finishPrices: { nonfoil: null, foil: null, etched: null } },
    ]);
    mount({ tray: RESOLVED, trade: { ...TRADE, marketplace: "cardmarket", rateTheirs: 80 } });
    const tray = await screen.findByRole("region", { name: "Scanned for their side" });
    const total = (await within(tray).findByText("Scanned so far")).parentElement;
    // 3 × 10 + 1 × 20 = 50 at the market's price, 40 at their side's 80%; the Lotus has no
    // price, adds nothing, and is counted.
    await waitFor(() => expect(total).toHaveTextContent(/40[.,]00/));
    expect(total).toHaveTextContent(/50[.,]00.* at 100%/);
    expect(total).toHaveTextContent("1 without a price");
    expect(total).toHaveTextContent("€");
    const asked = vi.mocked(ipc.printingPrices).mock.calls;
    expect(asked.length).toBeGreaterThan(0);
    asked.forEach(([, marketplace]) => expect(marketplace).toBe("cardmarket"));
  });

  it("lets the camera go on the press that closes it", async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
      },
    });
    restore.push(
      shim(HTMLVideoElement.prototype, {
        videoWidth: { get: () => 1280 },
        videoHeight: { get: () => 720 },
        readyState: { get: () => 4 },
        play: { value: () => Promise.resolve() },
      }),
    );
    const { onClose } = mount({ tray: [] });
    await dialog();
    // The camera is open and its first frame is out.
    await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
    expect(stop).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Scanned for their side" })).toBeNull();
  });
});
