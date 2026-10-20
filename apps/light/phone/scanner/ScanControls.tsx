import { Play, SlidersHorizontal, Square } from "lucide-react";
import { SCAN_MODES } from "@grimoire/ui/features/scanner/reader/readerText";
import { FOCUS } from "@grimoire/ui/lib/focus";
import type { ScanMode } from "@grimoire/ui/lib/ipc";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/** The bar's box for a press: the touch floor, a hairline, the page's own type. */
const CONTROL = cn(
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border",
  "px-3 text-sm text-text",
  PRESS,
  FOCUS,
);

/**
 * Where a segment's box meets its neighbours: the outer corners rounded, every edge after the
 * first drawn over the one before it (`-ml-px`), so the row reads as one control of N boxes sharing
 * their hairlines — first, middle and last, for any number of modes.
 */
function segmentEdge(i: number, count: number): string {
  if (count === 1) return "rounded-md";
  if (i === 0) return "rounded-l-md";
  return i === count - 1 ? "-ml-px rounded-r-md" : "-ml-px";
}

/**
 * The reader's controls over the camera, a thumb's size: whether the scanner is reading, which of
 * its modes it reads in, and the way into everything else.
 *
 * **The desktop's bar in the phone's idiom** (`ScanBar`): its four popovers are anchored panels
 * 256–300px wide and its hints are tooltips, neither of which a finger at 360px has. So the bar
 * keeps the two things a reader changes mid-pile — *Stop* and *Fast | Exact | Neural* — and one
 * `Options` press opens a sheet for the rest (`OptionsSheet`), where each mode's hint is a sentence
 * under its name rather than a hover.
 *
 * **Start and Stop are the desktop's own**, to the word (issue #774): Stop pauses recognition and
 * keeps the picture and the tray; Start resumes on the same stream.
 *
 * **The modes are a row of toggles**, `role="group"` with `aria-pressed` each — the desktop
 * switch's grammar and its reason.
 *
 * **One line where the three modes fit beside Stop, two where they do not** (2026-10-20, when
 * Neural made the switch three-way). Measured in Geist at 14px: *Start scanning* is a 139px box,
 * the three segments need 161px at their own widths (*Neural*, the widest, 61px), the Options press
 * 44px, and two 8px gaps — 368px of row, against the 328px a 360px phone leaves inside the page's
 * padding (and 256px in the two-column arrangement from 720px). Two segments fitted at 360; three
 * do not. So the switch and the Options press travel as one unit that **wraps as a whole** onto a
 * line of its own under Stop, where the switch takes the line's width less the press — never the
 * press alone on a second line, and nothing in a different order from the one it is read in. It is
 * flex wrapping and nothing else, so the bar asks no viewport and no container: the unit's basis
 * (13.75rem, the 213px it needs plus slack for a font's rounding) is the whole of the rule. A 412px
 * phone keeps one line.
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
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => onScanning(!scanning)} className={CONTROL}>
        {scanning ? (
          <Square aria-hidden className="size-3.5" />
        ) : (
          <Play aria-hidden className="size-3.5" />
        )}
        {scanning ? "Stop scanning" : "Start scanning"}
      </button>

      {/* The switch and the Options press as one unit that wraps whole — see the comment above
          for the arithmetic behind the basis. `grow` and not `flex-1`, whose shorthand would set
          the basis back to zero wherever the stylesheet puts it after this one. */}
      <div data-scan-modes-row className="flex min-w-0 grow basis-[13.75rem] items-center gap-2">
        {/* Boxes sharing an edge rather than chips inside a padded frame: a frame's pad and
            hairline come out of the boxes' height, and each box is a 44px target of its own.
            `min-w-fit` keeps a label inside its box (each is wider than the 44px floor with its
            pad — *Fast*, the narrowest, is 47px), and `flex-1` shares out what is left. */}
        <div role="group" aria-label="Scan mode" className="flex flex-1">
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
                "h-11 min-w-fit flex-1 border px-2 text-sm",
                segmentEdge(i, SCAN_MODES.length),
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
    </div>
  );
}
