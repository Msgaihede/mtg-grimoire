import type { JSX } from "react";
import { ImportExportPair } from "@/features/transfer/ImportExportPair";
import type { Trade, TradeSide } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { cardCount, isOpen, linesOf, rateOf } from "./trade";
import { TradeAddRow } from "./TradeAddRow";
import { FIGURE } from "./tradeControls";
import { TradeLineCard } from "./TradeLineCard";
import { TradeRate } from "./TradeRate";
import { rateLabel, sideHeading, sideWords } from "./tradeWords";

/**
 * One side of a trade: what is on it, at what percentage, and — while the trade is open — the row
 * that puts more on.
 *
 * Three bands in a column. The heading names the side and carries its card count and its
 * percentage; the add row is the field, the scope and the camera; and the list takes whatever
 * height is left and scrolls on its own, so a long side never pushes the balance off the window.
 *
 * **The panel does not clip.** The design rounds it with a hidden overflow, and here that would
 * cut both popups this panel opens — the percentage's and the add field's — at the panel's own
 * bottom edge the moment the window is short enough for either to reach it. Nothing inside draws
 * a background that needs the clip: the bands are separated by borders, and the list rounds its
 * own bottom corners for the one thing that could square them off, its scrollbar.
 *
 * **Closed, the same panel with two bands**: no add row, and the percentage is a dim label rather
 * than a button — a control that opens a slider nobody may move would be a lie about the trade.
 *
 * **Each side has its own transfer pair** (issue #903), the joined Import and Export every list
 * in the app carries, at the end of the heading: a side is a list of its own, and the reader
 * pasting what the other trader sent is filling one side, never both. Closed, the pair is Export
 * alone — a finished or archived trade is still a list somebody may want in a file, and nothing
 * may be put on it. The dialogs are the view's, for the scanner's reason: a `fixed` modal belongs
 * at its host's top level, and this panel is a grid cell.
 */
export function TradeSidePanel({
  trade,
  side,
  onScan,
  onImport,
  onExport,
}: {
  trade: Trade;
  side: TradeSide;
  onScan: (side: TradeSide, opener: HTMLElement) => void;
  /** Open the import dialog onto this side. Only asked while the trade is open. */
  onImport: (side: TradeSide, opener: HTMLElement) => void;
  onExport: (side: TradeSide, opener: HTMLElement) => void;
}): JSX.Element {
  const lines = linesOf(trade.lines, side);
  const copies = lines.reduce((sum, line) => sum + line.quantity, 0);
  const editable = isOpen(trade.status);
  const heading = sideHeading(side, trade.status);

  return (
    <section
      aria-label={heading}
      className="relative flex min-h-0 min-w-0 flex-col rounded-[10px] border border-border bg-surface"
    >
      <div className="relative flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <h4 className="min-w-0 flex-1 font-heading text-lg leading-snug font-semibold">
          {heading}
        </h4>
        <span className="text-[0.8125rem] text-dim">{cardCount(copies)}</span>
        {editable ? (
          <TradeRate trade={trade} side={side} />
        ) : (
          <span className={cn(FIGURE, "text-[0.8125rem] text-dim")}>
            {rateLabel(rateOf(trade, side))}
          </span>
        )}
        <ImportExportPair
          onImport={editable ? (opener) => onImport(side, opener) : undefined}
          onExport={(opener) => onExport(side, opener)}
          importLabel={`Import cards to ${sideWords(side)}`}
          exportLabel={`Export ${sideWords(side)}`}
          compact
        />
      </div>

      {editable && <TradeAddRow trade={trade} side={side} onScan={(opener) => onScan(side, opener)} />}

      {lines.length > 0 ? (
        <ul className="min-h-0 flex-1 overflow-y-auto rounded-b-[10px] pt-2">
          {lines.map((line) => (
            <TradeLineCard key={line.id} trade={trade} line={line} />
          ))}
        </ul>
      ) : (
        <p className="px-6 py-8 text-center text-sm leading-normal text-dim">
          {editable
            ? side === "mine"
              ? "Nothing on this side yet. Search for a card, pick one from your collection, or scan it."
              : "Nothing on this side yet. Search for a card or scan it."
            : "Nothing was on this side."}
        </p>
      )}
    </section>
  );
}
