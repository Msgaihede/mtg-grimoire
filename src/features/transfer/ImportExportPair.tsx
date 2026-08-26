import { SquareArrowRightEnter, SquareArrowRightExit } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The two transfer buttons, drawn as one joined pair — cards into this list, this list out to a
 * file.
 *
 * **The deck editor's header is where this shape was argued and this is that shape, shared.** A
 * pair rather than two loose buttons, because they are one idea read in two directions, and
 * joining them says so in the width of one control and a hairline. The glyphs are lucide's own
 * mirror pair, so the direction is the picture rather than a word the reader has to find.
 *
 * **The visible word is shorter than the accessible name, deliberately and legally.** `Import` and
 * `Export` are each contained in the name beside them, which is what WCAG 2.5.3 asks for, and the
 * names say *what* is being moved — `Import cards` rather than a bare `Import`, because the dialog
 * each one opens carries a control called `Import`, and two buttons with one name on screen at
 * once is a pair a screen reader can only tell apart by position.
 *
 * ## Why the words collapse, and why the buttons never do
 *
 * `compact` drops both words and leaves two 36px glyphs with the name on a tooltip. That is the
 * deck header's rule — *the word gives way as the column narrows, never the control* — and it is
 * the caller's to apply, because only the caller knows what it is competing with for the line.
 *
 * ## Why the deck editor still has its own copy
 *
 * Its two buttons are `aria-expanded` over a layer state and open through `openLayer`, which hands
 * focus back to the trigger when the dialog closes; both of those are facts about that page's
 * layer stack rather than about a transfer. What is shared here is the shape, which is what a
 * reader recognises across three pages — not the plumbing, which is different on each.
 */
export function ImportExportPair({
  onImport,
  onExport,
  importLabel,
  exportLabel,
  compact = false,
  className,
}: {
  onImport: () => void;
  onExport: () => void;
  /** The accessible name and tooltip for the left button. Names *what is being moved*, so it is
   *  never a bare `Import` — see the component's own note. */
  importLabel: string;
  exportLabel: string;
  /** Glyphs only, with the name on a tooltip. The caller decides, because only it knows what the
   *  row is competing with. */
  compact?: boolean;
  className?: string;
}) {
  const tip = useTooltip();
  const buttons = [
    { label: importLabel, word: "Import", Icon: SquareArrowRightEnter, onClick: onImport },
    { label: exportLabel, word: "Export", Icon: SquareArrowRightExit, onClick: onExport },
  ];
  return (
    <div
      role="group"
      aria-label="Import and export"
      className={cn(
        "flex shrink-0 overflow-hidden rounded-md border border-border bg-surface",
        className,
      )}
    >
      {buttons.map(({ label, word, Icon, onClick }, at) => (
        <button
          key={label}
          type="button"
          onClick={onClick}
          aria-haspopup="dialog"
          aria-label={label}
          // Bound exactly when the word is not there to be read — a tooltip repeating a word
          // already on the button is a second copy of it under the pointer. `describes: false`,
          // because it is identical to the `aria-label` above.
          {...(compact ? tip(label, { describes: false }) : {})}
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap",
            "text-xs text-dim",
            // The hairline between them, and it is the second button's own border rather than a
            // divider element: a `<div>` between two flex children would be a third child for the
            // group's `aria-label` to have to be about.
            at === 1 && "border-l border-border",
            compact ? "w-9 px-0" : "gap-1.5 px-2.5",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {!compact && word}
        </button>
      ))}
    </div>
  );
}
