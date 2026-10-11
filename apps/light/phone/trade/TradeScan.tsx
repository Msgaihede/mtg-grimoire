import { useIsPresent } from "motion/react";
import { Dialog } from "@grimoire/ui/components/Dialog";
import { ScanOnto, useTradeDestination } from "@grimoire/ui/features/scanner/tradeScan";
import type { TrayDestination } from "@grimoire/ui/features/scanner/useTrayDestination";
import type { Trade, TradeSide } from "@grimoire/ui/lib/ipc";
import { ScannerPage } from "../pages/ScannerPage";

/**
 * **Scan cards** — the phone's Scanner page, opened over a trade as a full-height sheet, filing
 * onto one of the trade's two sides.
 *
 * **It is the Scanner page itself**, handed somewhere else to put its tray (`ScannerPage`'s
 * `destination`): the camera, the mode, `Options`, the status line, the tray's rows and its two
 * questions, the footer that stays put. What is the trade's is the *Scan onto* switch under the
 * heading, the words on the press — `Add 4 to their side` — the marketplace the rows are priced
 * at, and the running total where the collection's folder would be. The desktop's
 * `TradeScanDialog` is the same arrangement over the desktop's view, and both take their words,
 * their lines and their write from `features/scanner/tradeScan.tsx`.
 *
 * **The scanner is mounted only while this is open** — a mounted Scanner page holds the app's one
 * scanner lease and an open camera — and it is let go on the render that *starts* the close
 * rather than at the end of the fade ({@link Body}). The Scanner tab is not mounted meanwhile:
 * the trade is the page under this sheet.
 *
 * **The tray is the Scanner tab's own.** There is one, stored, and every Scanner surface reads
 * it — so cards scanned on the Scanner tab and never filed are in this list when it opens, and
 * Add would send them to the trade with the rest. A line above the tray says so for as long as
 * any of them is there; *Clear all…* under `⋯`, or the `×` on a row, is the way out.
 *
 * **Add closes this when it leaves nothing to decide**, and stays open over what it left — with
 * the page's receipt line saying what went.
 *
 * `onClose` is every way out: Escape, the ✕, the scrim and a finished Add. It is refused while a
 * write is out, so a refusal's sentence is not dismissed with the sheet.
 */
export function TradeScan({
  open,
  trade,
  side,
  onSide,
  onClose,
}: {
  open: boolean;
  trade: Trade;
  /** Which side the list is headed for. The host's, so it can open on the column whose press
   *  opened it. */
  side: TradeSide;
  onSide: (side: TradeSide) => void;
  onClose: () => void;
}) {
  const { destination, adding } = useTradeDestination({ trade, side, onDone: onClose });
  const close = () => {
    if (!adding) onClose();
  };
  return (
    <Dialog
      open={open}
      title="Scan cards"
      closeLabel="Close the scanner"
      // `AddCards`' shape, wider: the whole window below 640px, with the top inset taken because
      // the shell's header is underneath. Above it the panel takes what the scrim leaves — the
      // page's two columns stand side by side from a 720px *viewport*, and a 40rem panel there
      // would leave the camera 288px beside the tray's 22rem.
      size="h-full w-[56rem] pt-[env(safe-area-inset-top)] sm:pt-0"
      onDismiss={close}
      onClose={close}
    >
      <Body side={side} onSide={onSide} destination={destination} />
    </Dialog>
  );
}

/**
 * The switch, and the page under it.
 *
 * **The page goes on the render that starts the close**: the panel outlives `open` by the length
 * of its fade, and a Scanner left mounted for it keeps the camera open and the frames going, so
 * a card could land in the tray after the reader had said they were done. The box stays, so the
 * panel fades at the size it had.
 *
 * The bottom inset is taken here because the page's footer is the last thing on the glass: under
 * the Scanner tab the tab bar takes it, and this sheet covers the tab bar.
 */
function Body({
  side,
  onSide,
  destination,
}: {
  side: TradeSide;
  onSide: (side: TradeSide) => void;
  destination: TrayDestination;
}) {
  const present = useIsPresent();
  return (
    <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
      <div className="shrink-0 border-b border-border px-4 py-2">
        <ScanOnto side={side} onSide={onSide} />
      </div>
      {present ? <ScannerPage destination={destination} /> : <div className="min-h-0 flex-1" />}
    </div>
  );
}
