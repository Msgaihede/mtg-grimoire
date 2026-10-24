import { ListFilter, SlidersHorizontal } from "lucide-react";
import { CONTINUOUS, POINT_AND_SHOOT } from "@grimoire/ui/features/scanner/reader/readerText";
import { FOCUS, FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/** A 44px square press holding a glyph, named by its `aria-label`: *Filters* and *Options*. */
const ICON_PRESS = cn(
  "inline-flex min-h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border text-text",
  PRESS,
  FOCUS,
);

/** The two ways to run the scanner, in the segmented group's order — the stored pref for each. */
const WAYS = [
  { pointAndShoot: false, label: CONTINUOUS },
  { pointAndShoot: true, label: POINT_AND_SHOOT },
] as const;

/**
 * The row over the picture, a thumb's size (the scanner redesign, 2026-10-24): how the scanner
 * runs, and the two ways into everything else.
 *
 * - **Continuous | Point & shoot** — a segmented group of two 44px presses, the one in force
 *   `aria-pressed`: the desktop dock's switch, moved out of the options sheet onto the page.
 *   Pressing the one already in force does nothing; either way the page lands stopped, as the
 *   desktop's does.
 * - **Filters** opens the options sheet on its filters page; **Scanner options** opens it on its
 *   first. Each is a 44px glyph named by its `aria-label` — a finger has no hover, so neither
 *   leans on a tooltip, and the sheet each opens is headed with what it holds.
 *
 * **Start and Stop are not here**: the gold press under the picture is the page's
 * (`ScannerPage`), and under point and shoot there is none — the picture itself is held
 * (`HoldSurface`).
 *
 * **The row never wraps** — a second line is taken from the picture, whose height is what a phone
 * has least of, upright or on its side. On its side the row is the left column's, which the page
 * keeps 20.5rem wide (`ScannerPage`'s grid) — 304px inside its `px-3` — so there the words step
 * down to 13px in `px-2`: the pair gets 200px, each half 98px, and *Point & shoot* in its pressed
 * weight is 81px. Upright the row has a phone's whole width.
 */
export function ScanControls({
  pointAndShoot,
  onPointAndShoot,
  onFilters,
  onOptions,
}: {
  /** The stored point-and-shoot pref: which of the group's two is pressed. */
  pointAndShoot: boolean;
  /** The reader chose the other way to run the scanner. */
  onPointAndShoot: (on: boolean) => void;
  /** Open the options sheet on its filters page. Handed the press, for the caret to come back to. */
  onFilters: (opener: HTMLElement) => void;
  /** Open the options sheet. Handed the press, for the caret to come back to. */
  onOptions: (opener: HTMLElement) => void;
}) {
  return (
    // Stretched, so the two glyphs stand as tall as the pill and its hairline.
    <div className="flex shrink-0 items-stretch gap-2">
      {/* One bordered pill, split in two edge to edge: each half is the 44px floor itself, and
          the desktop dock's group in name and colour (`ScanDock`'s *How scanning runs*). */}
      <div
        role="group"
        aria-label="How scanning runs"
        className="flex min-w-0 flex-1 overflow-hidden rounded-md border border-border"
      >
        {WAYS.map((way) => {
          const on = way.pointAndShoot === pointAndShoot;
          return (
            <button
              key={way.label}
              type="button"
              aria-pressed={on}
              onClick={() => {
                if (!on) onPointAndShoot(way.pointAndShoot);
              }}
              className={cn(
                "h-11 min-w-0 flex-1 truncate px-2 text-sm landscape:text-[13px]",
                on ? "bg-accent font-medium text-accent-fg" : "text-dim",
                PRESS,
                // Inside the pill, which clips: an outline standing off the edge would not show.
                FOCUS_INSET,
              )}
            >
              {way.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-label="Filters"
        aria-haspopup="dialog"
        onClick={(e) => onFilters(e.currentTarget)}
        className={ICON_PRESS}
      >
        <ListFilter aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Scanner options"
        aria-haspopup="dialog"
        onClick={(e) => onOptions(e.currentTarget)}
        className={ICON_PRESS}
      >
        <SlidersHorizontal aria-hidden className="size-4" />
      </button>
    </div>
  );
}
