import type { JSX } from "react";
import { useIsPresent } from "motion/react";
import { Dialog } from "@/components/Dialog";
import { ScannerPage } from "@/features/scanner/ScannerPage";
import { ScanOnto, useTradeDestination } from "@/features/scanner/tradeScan";
import type { TrayDestination } from "@/features/scanner/useTrayDestination";
import type { Trade, TradeSide } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

/**
 * **Scan cards** — the Scanner, opened over a trade, filing onto one of its two sides.
 *
 * **It is the Scanner view itself**, handed somewhere else to put its tray
 * (`ScannerPage`'s `destination`): the same camera, the same modes and filters, the same review
 * tray with its two questions, and the same refusals. What is the trade's is the *Scan onto*
 * switch above it, the words on the press — `Add 4 to their side` — the marketplace the rows are
 * priced at, and the running total where the collection's folder would be.
 *
 * **The scanner is mounted only while this is open**, and that is more than tidiness: a mounted
 * Scanner holds the app's one scanner lease and an open camera. `Dialog` mounts its children only
 * while open, and the body lets the scanner go on the render that *starts* the close rather than
 * at the end of the fade ({@link Body}).
 *
 * **The tray is the Scanner view's own.** There is one, stored, and every Scanner surface reads
 * it — so cards scanned on the Scanner view and never filed are in this list when it opens, and
 * Add would send them to the trade with the rest. The tray says so in a line under its heading
 * for as long as any of them is there; *Clear all…*, or the `×` on a row, is the way out.
 *
 * **Add closes this when it leaves nothing to decide**, and stays open over what it left: a card
 * still waiting on a finish, or one scanned while the write was out.
 *
 * **It will not close under a write.** The press is short, and a dialog dismissed mid-write would
 * take a refusal's sentence away with it.
 *
 * **The caret comes back here when the printings wall closes.** A row's *More printings…* opens
 * the app's all-printings dialog over this one, and that dialog hands the caret to nobody on its
 * way out — on the Scanner view that costs nothing, but under a modal a caret on `<body>` is a
 * Tab that restarts behind the scrim. `Dialog`'s `stackedOver` is the shell's own answer to it.
 *
 * `onClose` is every way out — Escape, the ✕, the scrim and a finished Add. The host owns the
 * caret, as it owns `open`.
 */
export function TradeScanDialog({
  open,
  trade,
  side,
  onSide,
  onClose,
}: {
  open: boolean;
  trade: Trade;
  /** Which side the list is headed for. The host's, so it can open on the side whose button was
   *  pressed. */
  side: TradeSide;
  onSide: (side: TradeSide) => void;
  onClose: () => void;
}): JSX.Element {
  const { destination, adding } = useTradeDestination({ trade, side, onDone: onClose });
  const printingsOpen = useAppStore((s) => s.printingsRequest !== null);
  const close = () => {
    if (!adding) onClose();
  };
  return (
    <Dialog
      open={open}
      title="Scan cards"
      subtitle="Hold each card up to the camera. It lands in the list, priced, ready to add to the trade."
      closeLabel="Close the scanner"
      stackedOver={printingsOpen}
      // The canvas's 1120 × 700. A height and not content: the camera takes what the bar and the
      // strip leave, and has no height of its own to give the panel.
      size="h-[43.75rem] w-[70rem]"
      onDismiss={close}
      onClose={close}
    >
      <Body side={side} onSide={onSide} destination={destination} />
    </Dialog>
  );
}

/**
 * The switch, and the scanner under it.
 *
 * **The scanner goes on the render that starts the close.** The panel outlives `open` by the
 * length of its fade, and a Scanner left mounted for it keeps the camera open and the frames
 * going — a card could land in the tray after the reader had already said they were done. The
 * box it stood in stays, so the panel fades at the size it had.
 *
 * The Scanner view is a `@container`, which is the containing block for anything `fixed` inside
 * it; its own two dialogs are its siblings rather than its children, and so land in the plain box
 * here.
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <ScanOnto side={side} onSide={onSide} />
      <div className="min-h-0 flex-1">{present && <ScannerPage destination={destination} />}</div>
    </div>
  );
}
