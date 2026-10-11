import { RotateCcw, Send } from "lucide-react";
import { useTooltip } from "@grimoire/ui/components/tooltip/useTooltip";
import { MatchBar, STRIP_PILL, STRIP_SENTENCE } from "@grimoire/ui/features/scanner/reader/MatchStrip";
import { matchStrip, type LastAdded } from "@grimoire/ui/features/scanner/reader/readerText";
import { SEND_SCAN } from "@grimoire/ui/features/scanner/submit/submitText";
import { FOCUS } from "@grimoire/ui/lib/focus";
import type { ScanMode, ScannerResolution, ScannerVerdict } from "@grimoire/ui/lib/ipc";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * Where the scanner has got to with the card in front of it — the desktop's Match strip, laid out
 * for a column about 330px wide.
 *
 * **The same sentences, never a second set**: every word here is one `matchStrip` value
 * (`readerText.ts`), the pill's and the sentence's colours are the desktop strip's own maps, and
 * the bar is its `MatchBar`. What is the phone's is the arrangement. The desktop draws the pill,
 * the name, the printing and the instruction on **one** row and lets the name give way; at 330px
 * that row is the pill and the instruction with no room left for a name at all (`Added · swap in
 * the next card` is 190px by itself). So the instruction takes a line of its own under the card:
 *
 * - line one — the pill, then the card and its printing, the name truncating;
 * - line two — what to do next, wrapping if it must;
 * - the bar, with *Reset evidence* and *Send scan…* at its end, each 44px under a thumb.
 *
 * **Two lines of height whatever is in them**, so the tray under the strip does not jump as the
 * row changes from a sentence to a name and back — the desktop strip's rule, for the thing below
 * it here rather than the camera.
 *
 * **The row is the page's live region**, named `Scanner status` as on the desktop, and for its
 * reasons the leaning name is drawn and not announced, and the bar and the buttons sit outside it.
 *
 * **_Send scan…_ is a glyph here and words on the desktop**, and the width is why. At 360px the
 * strip is 308px inside its padding; *Reset evidence* takes about 122 of them, and the same
 * press spelled out would take another hundred — leaving the bar under 70px, which is a bar that
 * says nothing. A 44px square leaves it about 125. (Reckoned from the classes, not measured on a
 * phone.) The name is the desktop's own, word for word, as the press's accessible name and as
 * what a pointer is shown.
 */
export function MatchLine({
  verdict,
  mode,
  lastAdded,
  hasBundle,
  lastResolution,
  onReset,
  onSend,
}: {
  verdict: ScannerVerdict | null;
  mode: ScanMode;
  lastAdded: LastAdded;
  /** `false` only once the status has answered that no bundle loaded — unknown is not absent. */
  hasBundle: boolean;
  lastResolution: ScannerResolution | null;
  onReset: () => void;
  /**
   * *Send scan…* — the desktop strip's press and its rule: handed the press for the caret, and
   * **absent where the page does not offer it, which draws no button**. The page's three
   * conditions (its `sendable`): there can be a run to send — a live camera and recognition
   * running; the page is the Scanner tab itself, not mounted over a trade; and the device is a
   * supporter's. Of the third nothing is said, here or on the page — no greyed press, no hint:
   * this line is handed a press or it is not, and knows nothing of why.
   */
  onSend?: (opener: HTMLElement) => void;
}) {
  const tip = useTooltip();
  const strip = matchStrip(verdict, mode, lastAdded, hasBundle, lastResolution);
  const leaning = strip.tone === "progress";
  const hidden = leaning ? true : undefined;

  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-lg border border-border bg-surface pt-2.5 pr-1.5 pb-1 pl-3">
      {/* The `{" "}`s lay nothing out and keep the region's text from reading as one word — the
          desktop strip's arrangement, and `aria-atomic` for its reason. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Scanner status"
        className="flex min-h-12 flex-col gap-1 pr-1.5"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium",
              STRIP_PILL[strip.tone],
            )}
          >
            {strip.word}
          </span>{" "}
          {strip.name !== null && (
            <>
              <span
                aria-hidden={hidden}
                className={cn(
                  "min-w-0 truncate font-heading text-lg leading-tight",
                  leaning ? "text-dim" : "text-text",
                )}
              >
                {strip.name}
              </span>{" "}
            </>
          )}
          {strip.printing !== null && (
            <>
              <span aria-hidden={hidden} className="shrink-0 font-mono text-xs text-dim">
                {strip.printing}
              </span>{" "}
            </>
          )}
        </span>
        <span className={cn("text-sm leading-snug", STRIP_SENTENCE[strip.tone])}>
          {strip.sentence}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <MatchBar strip={strip} />
        <button
          type="button"
          onClick={onReset}
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs text-dim",
            PRESS,
            FOCUS,
          )}
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Reset evidence
        </button>
        {onSend !== undefined && (
          <button
            type="button"
            aria-label={SEND_SCAN}
            aria-haspopup="dialog"
            // `describes: false`: the words are the `aria-label` above. The app's own tooltip and
            // not a `title`, which this app draws nowhere; a finger never sees either, and the
            // dialog the press opens is headed with what it does.
            {...tip(SEND_SCAN, { describes: false })}
            onClick={(e) => onSend(e.currentTarget)}
            className={cn(
              "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-dim",
              PRESS,
              FOCUS,
            )}
          >
            <Send aria-hidden className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
