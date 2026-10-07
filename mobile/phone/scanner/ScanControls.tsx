import { Play, SlidersHorizontal, Square } from "lucide-react";
import { SCAN_MODES } from "@/features/scanner/reader/readerText";
import { FOCUS } from "@/lib/focus";
import type { ScanMode } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The bar's box for a press: the touch floor, a hairline, the page's own type. */
const CONTROL = cn(
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border",
  "px-3 text-sm text-text",
  PRESS,
  FOCUS,
);

/**
 * The reader's controls over the camera, in one row a thumb can work: whether the scanner is
 * reading, which of its two modes it reads in, and the way into everything else.
 *
 * **The desktop's bar in the phone's idiom** (`ScanBar`): its four popovers are anchored panels
 * 256–300px wide and its hints are tooltips, neither of which a finger at 360px has. So the row
 * keeps the two things a reader changes mid-pile — *Stop* and *Fast | Exact* — and one `Options`
 * press opens a sheet for the rest (`OptionsSheet`), where each mode's hint is a sentence under
 * its name rather than a hover.
 *
 * **Start and Stop are the desktop's own**, to the word (issue #774): Stop pauses recognition and
 * keeps the picture and the tray; Start resumes on the same stream.
 *
 * **Fast | Exact is a pair of toggles**, `role="group"` with `aria-pressed` each — the desktop
 * switch's grammar and its reason. It takes the row's spare width, so each half is well over the
 * 44px floor at 360.
 */
export function ScanControls({
  scanning,
  onScanning,
  mode,
  onMode,
  onOptions,
}: {
  scanning: boolean;
  onScanning: (scanning: boolean) => void;
  mode: ScanMode;
  onMode: (mode: ScanMode) => void;
  /** Open the options sheet. Handed the press, for the caret to come back to. */
  onOptions: (opener: HTMLElement) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => onScanning(!scanning)} className={CONTROL}>
        {scanning ? (
          <Square aria-hidden className="size-3.5" />
        ) : (
          <Play aria-hidden className="size-3.5" />
        )}
        {scanning ? "Stop scanning" : "Start scanning"}
      </button>

      {/* Two boxes sharing an edge rather than two chips inside a padded frame: a frame's pad and
          hairline come out of the halves' height, and each half is a 44px target of its own. */}
      <div role="group" aria-label="Scan mode" className="flex min-w-0 flex-1">
        {SCAN_MODES.map(({ id, label }, i) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => {
              // A press on the mode already on writes nothing: the choice is a stored pref.
              if (mode !== id) onMode(id);
            }}
            className={cn(
              "h-11 min-w-11 flex-1 border px-2 text-sm",
              i === 0 ? "rounded-l-md" : "-ml-px rounded-r-md",
              PRESS,
              mode === id
                ? "relative border-accent bg-accent font-medium text-accent-fg"
                : "border-border text-dim",
              FOCUS,
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-label="Scanner options"
        aria-haspopup="dialog"
        onClick={(e) => onOptions(e.currentTarget)}
        className={cn(CONTROL, "w-11 px-0")}
      >
        <SlidersHorizontal aria-hidden className="size-4" />
      </button>
    </div>
  );
}
