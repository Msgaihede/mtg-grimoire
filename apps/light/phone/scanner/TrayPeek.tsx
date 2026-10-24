import { useRef } from "react";
import { motion } from "motion/react";
import { ChevronUp } from "lucide-react";
import { CardImage } from "@grimoire/ui/components/CardImage";
import { CountTag } from "@grimoire/ui/components/CountTag";
import {
  needYouCount,
  needYouLabel,
  totalCopies,
} from "@grimoire/ui/features/scanner/reader/tray";
import { isKnownFinish } from "@grimoire/ui/features/scanner/reader/trayFinish";
import { useHeadLanded } from "@grimoire/ui/features/scanner/reader/useHeadLanded";
import { plural } from "@grimoire/ui/lib/counts";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { cardImageUrl } from "@grimoire/ui/lib/images";
import type { ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { DURATION, PRESS, seconds, TRANSITION } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * How many of the newest rows the strip draws. The peek is a glance at what just landed — about
 * five thumbnails fit across a 360px phone, and a swipe or two more is as far back as a glance
 * goes; the whole tray is the sheet's, a press away. Bounded so a long session's tray is not a
 * strip of hundreds of pictures under the camera.
 */
export const PEEK_ROWS = 20;

/** A thumbnail's box: 58 × 81, a card's 5:7 at the strip's height. */
const TILE = "relative h-[81px] w-[58px] shrink-0 overflow-hidden rounded-[4px]";

/**
 * The tray at the foot of the upright phone page (the scanner redesign, 2026-10-24): a line that
 * says how much is in it and how much is waiting on the reader, and a sideways strip of the newest
 * cards. **Pressing it opens the tray sheet** (`TraySheet`), where the whole list is.
 *
 * - **The line is the press** — `Scanned cards 6`, a gold `2 need you` chip while any card waits
 *   on a printing or a finish, and a chevron for the sheet it opens — named the whole of that.
 *   The opener is handed to the page, for the caret to come back to when the sheet shuts.
 * - **The strip is the newest rows, newest first** — the tray's own order, so the card that just
 *   landed is the first one, washed gold as the tray's row is (`flashKey`), and the strip slides
 *   back to it when a card lands. A row still waiting on a printing is a dashed **Pick** tile (it
 *   has no one picture to show); an unknown finish is its picture in a dashed gold outline with
 *   **Finish?** across its foot; more than one copy is a `CountTag`.
 *
 * **The strip is a picture of the tray, not a second way through it**: hidden from assistive tech
 * (the sheet is where the rows are read and worked, one question to a row), and a press anywhere
 * on it opens the sheet as the line does — a finger reaches for the card it is looking at.
 */
export function TrayPeek({
  rows,
  flashKey,
  onOpen,
  title = "Scanned cards",
}: {
  rows: readonly ScannerTrayRow[];
  /** The row just added or bumped, for the wash. */
  flashKey: string | null;
  /** The peek was pressed: the page opens the tray sheet. Handed the line's press, for the caret. */
  onOpen: (opener: HTMLElement) => void;
  /** What heads the tray — a destination's title where the tray files onto one, as `Tray`'s. */
  title?: string;
}) {
  const pressRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const copies = totalCopies(rows);
  const waiting = needYouCount(rows);
  const shown = rows.slice(0, PEEK_ROWS);

  // A card that lands is the strip's first tile: slide back to it if the reader swiped away.
  // jsdom has no `scrollTo` on an element, hence the optional call.
  useHeadLanded(rows, () => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    stripRef.current?.scrollTo?.({ left: 0, behavior: reduce ? "auto" : "smooth" });
  });

  const open = () => {
    if (pressRef.current !== null) onOpen(pressRef.current);
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-surface px-4 pb-3">
      <button
        ref={pressRef}
        type="button"
        aria-haspopup="dialog"
        // Named outright: the title, the count and the chip are three elements a gap apart,
        // which the name algorithm would fuse into `Scanned cards62 need you`.
        aria-label={[
          `${title}, ${plural(copies, "copy", "copies")}`,
          ...(waiting > 0 ? [needYouLabel(waiting)] : []),
        ].join(", ")}
        onClick={open}
        className={cn("flex min-h-11 w-full min-w-0 items-center gap-2 text-left", PRESS, FOCUS)}
      >
        {/* The display face at 18px, its floor in this app — the tray's own heading's size. */}
        <span className="truncate font-heading text-lg leading-none">{title}</span>
        <span className="font-mono text-sm tabular-nums text-dim">{copies}</span>
        {waiting > 0 && (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
            {needYouLabel(waiting)}
          </span>
        )}
        <ChevronUp aria-hidden className="ml-auto size-4 shrink-0 text-dim" />
      </button>

      {shown.length === 0 ? (
        // The strip's height, so the page above does not move when the first card lands.
        <p className="flex h-[81px] items-center text-sm text-dim">Cards you scan appear here.</p>
      ) : (
        <div
          ref={stripRef}
          aria-hidden="true"
          data-tray-peek-strip=""
          onClick={open}
          className="flex gap-1.5 overflow-x-auto overscroll-x-contain"
        >
          {shown.map((row) => (
            <PeekTile key={row.key} row={row} flash={row.key === flashKey} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One row as a thumbnail: its picture, or the question it is waiting on. */
function PeekTile({ row, flash }: { row: ScannerTrayRow; flash: boolean }) {
  const wash = flash && (
    // The tray row's wash, as a ring: it holds for one tier and fades over the next, keyed on
    // the row's stamp so a second copy flashes again. Opacity alone, so reduced motion has no
    // travel to take away.
    <motion.span
      key={row.addedAt}
      data-tray-flash=""
      className="pointer-events-none absolute inset-0 rounded-[4px] ring-2 ring-accent ring-inset"
      initial={{ opacity: 1 }}
      animate={{ opacity: 0, transition: { ...TRANSITION.slow, delay: seconds(DURATION.slow) } }}
    />
  );

  if (row.choices.length > 0) {
    return (
      <span
        data-tray-peek={row.key}
        className={cn(
          TILE,
          "flex items-center justify-center border border-dashed border-accent/70",
          "text-xs font-medium text-accent",
        )}
      >
        Pick
        {wash}
      </span>
    );
  }

  const unknown = !isKnownFinish(row.finish);
  return (
    <span
      data-tray-peek={row.key}
      className={cn(TILE, "bg-bg", unknown && "border-2 border-dashed border-accent")}
    >
      <CardImage
        src={cardImageUrl(row.cardId, 0, "thumb")}
        alt=""
        loading="lazy"
        className="size-full object-cover"
      />
      {row.quantity > 1 && (
        <CountTag
          count={row.quantity}
          title={plural(row.quantity, "copy", "copies")}
          className="absolute top-1 left-0"
        />
      )}
      {unknown && (
        <span className="absolute inset-x-0 bottom-0 bg-bg/85 py-0.5 text-center text-[0.625rem] font-medium text-accent">
          Finish?
        </span>
      )}
      {wash}
    </span>
  );
}
