import { SquareArrowRightEnter, SquareArrowRightExit } from "lucide-react";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The two transfer buttons as one joined pair, at the phone's 44px — **the desktop's
 * `ImportExportPair`, drawn for a finger**: the same mirror glyphs, the same hairline, and names
 * that say what is being moved, because each sheet it opens carries a control called `Import` or
 * `Export` of its own.
 *
 * `words` draws `Import` / `Export` beside the glyphs where there is room — a page header; a bar
 * that is already full (the deck page's foot) draws the glyphs alone, and the names still carry
 * the whole meaning.
 */
export function TransferPair({
  importLabel,
  exportLabel,
  onImport,
  onExport,
  words = true,
  className,
}: {
  importLabel: string;
  exportLabel: string;
  onImport: () => void;
  onExport: () => void;
  words?: boolean;
  className?: string;
}) {
  const buttons = [
    { label: importLabel, word: "Import", Icon: SquareArrowRightEnter, onClick: onImport },
    { label: exportLabel, word: "Export", Icon: SquareArrowRightExit, onClick: onExport },
  ];
  return (
    <div
      role="group"
      aria-label="Import and export"
      className={cn("flex shrink-0 overflow-hidden rounded-md border border-border", className)}
    >
      {buttons.map(({ label, word, Icon, onClick }, at) => (
        <button
          key={word}
          type="button"
          onClick={onClick}
          aria-haspopup="dialog"
          aria-label={label}
          className={cn(
            "flex h-11 shrink-0 items-center justify-center gap-1.5 text-sm text-dim",
            words ? "px-3" : "w-11",
            "active:bg-surface",
            at === 1 && "border-l border-border",
            FOCUS_INSET,
          )}
        >
          <Icon aria-hidden className="size-5 shrink-0" />
          {words && word}
        </button>
      ))}
    </div>
  );
}
