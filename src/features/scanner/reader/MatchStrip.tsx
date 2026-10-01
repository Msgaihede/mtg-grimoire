import type { ScanMode, ScannerResolution, ScannerVerdict } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { matchStrip, type LastAdded, type StripTone } from "./readerText";

export interface MatchStripProps {
  verdict: ScannerVerdict | null;
  mode: ScanMode;
  lastAdded: LastAdded;
  /** `false` only once the status has answered that no bundle loaded — unknown is not absent. */
  hasBundle: boolean;
  /** The page's latch of the last resolve, cleared when a frame has no card in it. */
  lastResolution: ScannerResolution | null;
}

/**
 * The pill's box per tone. **Every tone draws a border**, the filled one in its own fill colour,
 * so the pill is one size in all five and the name beside it does not shift a pixel when a card
 * is matched.
 */
const PILL: Record<StripTone, string> = {
  idle: "border-border bg-bg text-dim",
  progress: "border-border bg-bg text-dim",
  done: "border-accent bg-accent text-accent-fg",
  attention: "border-accent text-accent",
  error: "border-destructive/60 text-destructive",
};

/** The sentence at the right of a named card: quiet once it is filed, gold while it waits on the reader. */
const SENTENCE: Record<StripTone, string> = {
  idle: "text-text",
  progress: "text-text",
  done: "text-dim",
  attention: "text-accent",
  error: "text-text",
};

/**
 * Above the camera, for every reader: where the scanner has got to with the card in front of it,
 * the card it is leaning towards or has settled on, and a bar for how close it is.
 *
 * **Pure** — everything it draws is one {@link matchStrip} value, so a story or a test can stand
 * up any state from the five props alone.
 *
 * **The row is the view's live region**, always mounted and named `Scanner status` as the one line
 * under the camera it replaces was, so a screen reader is watching it before the first card lands.
 * It holds one line of height whatever is in it, so the camera below never jumps as the row
 * changes from a sentence to a name or back. The bar sits outside the region on purpose: its value
 * moves on almost every frame, and a region that contained it would have something to say nine
 * times a second.
 */
export function MatchStrip({ verdict, mode, lastAdded, hasBundle, lastResolution }: MatchStripProps) {
  const strip = matchStrip(verdict, mode, lastAdded, hasBundle, lastResolution);
  // **The leader is drawn and not announced.** While the tracker is still weighing, its leader can
  // change from one frame to the next, and a live region re-reading a new card name on every flip
  // is noise over the one thing a reader needs to hear — hold steady. The name joins the
  // announcement when the card is matched, which is the moment it is news.
  const leaning = strip.tone === "progress";
  const hidden = leaning ? true : undefined;

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface px-4 pt-3 pb-3.5">
      {/* The `{" "}`s between the spans lay nothing out — whitespace between flex items is not
          rendered — and are what keeps the region's text from reading `MatchedOliphauntLTR 426`
          as one word. `aria-atomic` is what `role="status"` implies, spelled out: a changed pill
          reads with the sentence it belongs to rather than on its own. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Scanner status"
        className="flex min-h-7 items-center gap-2.5"
      >
        <span
          className={cn(
            "shrink-0 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium",
            PILL[strip.tone],
          )}
        >
          {strip.word}
        </span>{" "}
        {strip.name === null ? (
          // No card to name, so the sentence stands where the name would, at the size a sentence
          // on its own is read at. It may wrap — the long one is the no-hashes sentence, which is a
          // state that holds rather than one that flickers.
          <span className="min-w-0 text-[15px] text-text">{strip.sentence}</span>
        ) : (
          <>
            <span
              aria-hidden={hidden}
              className={cn(
                "min-w-0 truncate font-heading text-xl leading-tight",
                leaning ? "text-dim" : "text-text",
              )}
            >
              {strip.name}
            </span>{" "}
            {strip.printing !== null && (
              <>
                <span aria-hidden={hidden} className="shrink-0 font-mono text-[13px] text-dim">
                  {strip.printing}
                </span>{" "}
              </>
            )}
            {/* The name is what gives way at a narrow width, never the instruction. */}
            <span
              className={cn(
                "ml-auto shrink-0 whitespace-nowrap text-[13px]",
                SENTENCE[strip.tone],
              )}
            >
              {strip.sentence}
            </span>
          </>
        )}
      </div>

      <div
        role="progressbar"
        aria-label="Match progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(strip.fill * 100)}
        className="relative h-1.5 overflow-hidden rounded-full bg-bg"
      >
        <div
          className={cn(
            "h-full transition-[width] motion-reduce:transition-none",
            strip.committed ? "bg-accent" : "bg-dim",
          )}
          style={{ width: `${strip.fill * 100}%` }}
        />
        {/* The line the bar has to cross — drawn only while it is being crossed. Empty, there is
            nothing approaching it; full, it has been crossed, and a dim mark at 70% of a gold bar
            under the confidence rule would read as a bar that stopped short. */}
        {leaning && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-px bg-dim"
            style={strip.threshold === "end" ? { right: 0 } : { left: `${strip.threshold * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}
