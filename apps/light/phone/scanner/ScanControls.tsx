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

/**
 * What the pair asks for on a phone on its side before the glyphs beside it wrap: 212px, so each
 * half is 105px — 89px for its words inside `px-2` and the hairline, which *Point & shoot* in its
 * pressed weight (87px) fits.
 */
const PAIR_FLOOR = "landscape:flex-[1_1_13.25rem]";

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
 * **Both words are whole on a phone on its side.** There the row is the left column's, which the
 * page keeps 22rem wide down to a 36.5rem page (`ScannerPage`'s grid) — 320px inside its padding,
 * so the pair gets 216px and each half 91px for its words, where *Point & shoot* in its pressed
 * weight is 87px (Geist, 14px, measured): whole from a 667 × 375 phone beside the rail up. On a
 * page narrower still, beside the rail (640 × 360), the pair asks for {@link PAIR_FLOOR} and the
 * two glyphs wrap under it rather than cut a word short — 52px of picture, measured 172 → 120.
 * **Never below 600px wide**, where the tab bar is a bar and the page's height is already short:
 * a wrap there left 28px of picture (568 × 320), so the row keeps one line. Upright the row never
 * wraps either: the picture's height is what an upright phone has least of.
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
    // Stretched, so the two glyphs stand as tall as the pill and its hairline. On its side beside
    // the rail the row may wrap, the glyphs going under the pair at its right-hand end.
    <div
      className={cn(
        "flex shrink-0 items-stretch gap-2",
        "landscape:min-[600px]:flex-wrap landscape:min-[600px]:justify-end",
      )}
    >
      {/* One bordered pill, split in two edge to edge: each half is the 44px floor itself, and
          the desktop dock's group in name and colour (`ScanDock`'s *How scanning runs*). */}
      <div
        role="group"
        aria-label="How scanning runs"
        className={cn(
          "flex min-w-0 flex-1 overflow-hidden rounded-md border border-border",
          PAIR_FLOOR,
        )}
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
                "h-11 min-w-0 flex-1 truncate px-2 text-sm",
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
