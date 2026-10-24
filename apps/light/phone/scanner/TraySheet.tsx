import { useRef, type ReactNode } from "react";
import { ArrowDown, Ellipsis, Plus } from "lucide-react";
import { Dialog } from "@grimoire/ui/components/Dialog";
import { ADD_CARD_LABEL } from "@grimoire/ui/features/scanner/reader/AddCardDialog";
import {
  needsDecision,
  NEXT_DECISION_LABEL,
  totalCopies,
} from "@grimoire/ui/features/scanner/reader/tray";
import { trayWorth } from "@grimoire/ui/features/scanner/reader/trayPrice";
import { useTrayPrices } from "@grimoire/ui/features/scanner/reader/useTrayPrices";
import { plural, verb } from "@grimoire/ui/lib/counts";
import { FOCUS } from "@grimoire/ui/lib/focus";
import type { ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import type { MarketplaceId } from "@grimoire/ui/lib/marketplace";
import { PRESS } from "@grimoire/ui/lib/motion";
import { formatPrice } from "@grimoire/ui/lib/prices";
import { cn } from "@grimoire/ui/lib/utils";
import { HEADER_PRESS, Tray, type TrayWalk } from "./Tray";

/** `2 cards need you`, `1 card needs you` — the walk's line in the tray sheet. */
export function cardsNeedYou(n: number): string {
  return `${plural(n, "card")} ${verb(n, "needs", "need")} you`;
}

/**
 * The whole tray on the upright phone page, as a sheet over it (the scanner redesign,
 * 2026-10-24) — opened from the tray's peek (`TrayPeek`), top to bottom:
 *
 * 1. **The header**: the title and the copy count; under it, what the tray is worth at its
 *    marketplace (`Worth $161.77`, the priced rows' unit price × quantity) and how many copies
 *    that figure leaves out (`2 unpriced`), with *Add card…* and the `⋯` beside them, and the ✕.
 *    The `⋯` is the page's: it opens `TrayActionsSheet` over this one.
 * 2. **The tray's bar** — the folder and Add — **handed in as {@link bar}**, the page's own
 *    `TrayBar`: one bar with one folder sheet and one commit, wherever it is drawn.
 * 3. **`N cards need you`** and a gold *Next* that walks the questions (`Tray`'s own walk, through
 *    {@link TrayWalk}), while any card waits on a printing or a finish.
 * 4. **The list** — `Tray` in scan order, each question on its own row — and only the list
 *    scrolls: the header, the bar and the walk stay put over it.
 *
 * **`Dialog`, not `ActionSheet`**, for that last rule: an action sheet's body is one scroller,
 * which would take the bar and the walk away with the rows. The panel is the action sheet's — at
 * the foot of the glass below 640px, centred above it — and it is the page's other sheets in every
 * way that matters: the scrim, the trap, Escape, the header's drag down and **one Back step**
 * (`sheetHistory.ts`). A row's finish and printings sheets open over this one, and Back or Escape
 * closes the one on top.
 */
export function TraySheet({
  open,
  onClose,
  onDismiss,
  title = "Scanned cards",
  rows,
  onRows,
  flashKey,
  marketplace,
  onAddCard,
  onActions,
  bar,
}: {
  open: boolean;
  /** A press on the scrim, or the header dragged down: close, the caret left where it is. */
  onClose: () => void;
  /** Escape, the ✕ and Back: close, and hand the caret back to the peek that opened it. */
  onDismiss: () => void;
  /** What heads the tray — a destination's title where the tray files onto one, as `Tray`'s. */
  title?: string;
  rows: readonly ScannerTrayRow[];
  /** An edit, as a function of the rows — never the rows this render drew (`Tray`'s rule). */
  onRows: (update: (rows: ScannerTrayRow[]) => ScannerTrayRow[]) => void;
  /** The row just added or bumped, for the wash. */
  flashKey: string | null;
  /** Whose prices the rows and the worth are quoted at. Absent is the reader's own marketplace. */
  marketplace?: MarketplaceId;
  /** *Add card…* — the page opens the search over this sheet. Handed the press, for the caret. */
  onAddCard: (opener: HTMLElement) => void;
  /** The `⋯` — the page opens the tray's actions. Handed the press, for the caret. */
  onActions: (opener: HTMLElement) => void;
  /** The page's `TrayBar`, drawn under the header. */
  bar: ReactNode;
}) {
  const copies = totalCopies(rows);
  return (
    <Dialog
      open={open}
      title={
        <span className="flex items-baseline gap-2">
          <span className="truncate">{title}</span>
          <span aria-hidden="true" className="font-mono text-sm tabular-nums text-dim">
            {copies}
          </span>
        </span>
      }
      // Spelled, as the tray's own heading is, and **not left to the heading**: with the count
      // hidden from it, the heading names this sheet `Scanned cards` — which is also the name of
      // the tray's actions sheet that opens over it, and two dialogs of one name are two a reader
      // cannot tell apart.
      ariaLabel={`${title}, ${plural(copies, "copy", "copies")}`}
      closeLabel="Close scanned cards"
      size="w-full self-end rounded-t-xl border-t border-border max-h-[85dvh] sm:max-h-full sm:w-[26rem] sm:self-center"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <SheetBody
        title={title}
        rows={rows}
        onRows={onRows}
        flashKey={flashKey}
        marketplace={marketplace}
        onAddCard={onAddCard}
        onActions={onActions}
        bar={bar}
      />
    </Dialog>
  );
}

/**
 * Everything under the sheet's heading — mounted only while the sheet is open (`Dialog`'s rule),
 * so the prices are not read for a sheet nobody opened.
 */
function SheetBody({
  title,
  rows,
  onRows,
  flashKey,
  marketplace,
  onAddCard,
  onActions,
  bar,
}: {
  title: string;
  rows: readonly ScannerTrayRow[];
  onRows: (update: (rows: ScannerTrayRow[]) => ScannerTrayRow[]) => void;
  flashKey: string | null;
  marketplace: MarketplaceId | undefined;
  onAddCard: (opener: HTMLElement) => void;
  onActions: (opener: HTMLElement) => void;
  bar: ReactNode;
}) {
  const walk = useRef<TrayWalk>(null);
  // The same read as the rows' own prices (`Tray` asks it too), so the figure and the rows agree.
  const { priceOf, currency } = useTrayPrices(rows, marketplace);
  const worth = trayWorth(rows, priceOf);
  const waiting = rows.filter(needsDecision).length;

  return (
    <>
      {/* The header's second line: the dialog's own band holds the title and the ✕ alone. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs text-dim">
          {worth.priced > 0 && (
            <>
              Worth{" "}
              <span className="font-mono text-text tabular-nums">
                {formatPrice(worth.total, currency)}
              </span>
            </>
          )}
          {worth.priced > 0 && worth.unpriced > 0 && " · "}
          {worth.unpriced > 0 && `${worth.unpriced} unpriced`}
        </p>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={(e) => onAddCard(e.currentTarget)}
          className={cn(HEADER_PRESS, "px-3 text-xs text-text")}
        >
          <Plus aria-hidden className="size-3.5" />
          {ADD_CARD_LABEL}
        </button>
        <button
          type="button"
          aria-label="Tray actions"
          aria-haspopup="dialog"
          onClick={(e) => onActions(e.currentTarget)}
          className={cn(HEADER_PRESS, "w-11 text-dim")}
        >
          <Ellipsis aria-hidden className="size-5" />
        </button>
      </div>

      {bar}

      {/* Hidden rather than greyed when nothing is waiting: a control that can do nothing is one
          a reader keeps trying. Gold, because it walks the questions gold already marks. */}
      {waiting > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5">
          <p className="min-w-0 flex-1 text-sm text-accent">{cardsNeedYou(waiting)}</p>
          <button
            type="button"
            // The issue's words for the walk, which the one drawn begins.
            aria-label={NEXT_DECISION_LABEL}
            onClick={() => walk.current?.next()}
            className={cn(
              "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-accent/60 px-3",
              "text-xs text-accent",
              PRESS,
              FOCUS,
            )}
          >
            <ArrowDown aria-hidden className="size-3.5" />
            Next
          </button>
        </div>
      )}

      {/* The one scroller. `relative` because a row's `sr-only` words are positioned, and
          `packages/ui/CLAUDE.md` asks the box carrying the overflow to hold them. */}
      <div
        data-tray-sheet-list=""
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
      >
        <Tray
          ref={walk}
          header={false}
          rows={rows}
          onRows={onRows}
          flashKey={flashKey}
          title={title}
          marketplace={marketplace}
        />
      </div>
      {/* The home indicator's inset, on the panel's last line rather than on every row. */}
      <div aria-hidden className="h-[env(safe-area-inset-bottom)] shrink-0" />
    </>
  );
}
