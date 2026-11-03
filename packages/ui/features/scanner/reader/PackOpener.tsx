/**
 * The pack opener (issue #1504): the Scanner's camera as the whole window, for a reader sharing
 * that window with friends while they open packs — so what the window shows is the picture, the
 * card that just landed and whether the scanner is running, and as little else as it can be.
 *
 * The page (`ScannerPage`) lays its own camera column out as the stage and its tray as a drawer;
 * what is here is what only the pack opener draws: the recording light in the picture's corner,
 * the bar's own presses, the drawer's pull tab, the way in from the page's header, and the idle
 * clock that takes the controls off the picture while nobody is using them.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, PackageOpen } from "lucide-react";
import { FILTER_CONTROL, filterChipState } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/** The mode's name: the header's press, the stage's region. */
export const PACK_OPENER = "Pack opener";
/** The bar's way out — Escape is the other. */
export const EXIT_PACK_OPENER = "Exit pack opener";
/** The drawer's pull tab, which names what it holds. */
export const SCANNED_CARDS = "Scanned cards";

/** The light's words, one per state — what a screen reader is told and the light's caption. */
export const PACK_SCANNING = "Scanning";
export const PACK_STOPPED = "Stopped";
export const PACK_READY = "Ready to scan";

/**
 * How long the pointer and the keys can rest before the bar and the drawer's tab leave the
 * picture. Long enough that a reader reaching for the next pack does not lose the bar under their
 * hand; short enough that friends watching see the cards rather than the controls.
 */
export const PACK_IDLE_MS = 3000;

/**
 * Whether the pack opener's controls have been left alone for {@link PACK_IDLE_MS} — `idle` — and
 * the call that says they have not (`wake`), for every pointer move and key press over the stage.
 *
 * **`false` whenever `on` is**: outside the pack opener nothing hides, and a stage opened again
 * opens with its controls showing rather than with the last visit's idle state. The clock starts
 * with the stage, so a reader who opens it and steps back still has the bar fade.
 *
 * What keeps the bar up while it is in use — the pointer over it, keyboard focus in it, a panel of
 * it open — is the bar's own CSS (`PACK_FADES`), not this clock: a panel left open must not fade
 * with its trigger under it.
 */
export function usePackIdle(
  on: boolean,
  ms: number = PACK_IDLE_MS,
): {
  idle: boolean;
  wake: () => void;
} {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A stage that closed idle opens awake — React's adjusting-state-on-a-prop-change, in render.
  const [was, setWas] = useState(on);
  if (was !== on) {
    setWas(on);
    setIdle(false);
  }

  const wake = useCallback(() => {
    setIdle(false);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), ms);
  }, [ms]);

  useEffect(() => {
    if (!on) return;
    timer.current = setTimeout(() => setIdle(true), ms);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [on, ms]);

  return { idle: on && idle, wake };
}

/**
 * The fade the bar and the pull tab share: gone while idle, **and back the moment they are in
 * use** whatever the clock says — under the pointer, holding keyboard focus (`:focus-visible`, so
 * a button that merely kept focus after a click does not pin the bar up for good), or with a panel
 * of theirs open (`aria-expanded`). Opacity only, so reduced motion takes the tween away and
 * nothing moves.
 */
export function packFades(idle: boolean): string {
  return cn(
    "transition-opacity duration-300 motion-reduce:transition-none",
    idle &&
      "opacity-0 hover:opacity-100 has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100",
  );
}

/**
 * The recording light in the picture's corner: green while the scanner is reading, red while it is
 * not — the one thing friends watching cannot otherwise tell from the picture. **Never fades**:
 * it is what the shared window is for, not a control.
 *
 * A `role="status"`, as the stopped veil and the shot-ready pill it stands in for are: it is where
 * the pack opener says what the scanner is doing.
 */
export function PackIndicator({
  reading,
  pointAndShoot,
}: {
  reading: boolean;
  pointAndShoot: boolean;
}) {
  const words = reading ? PACK_SCANNING : pointAndShoot ? PACK_READY : PACK_STOPPED;
  return (
    <p role="status" data-pack-light={reading ? "on" : "off"} className="shrink-0">
      <span className="inline-flex items-center gap-2 rounded-full bg-bg/80 px-3 py-1.5 text-[13px] font-medium text-text">
        <span
          aria-hidden="true"
          className={cn(
            "size-2.5 rounded-full",
            reading ? "animate-pulse bg-ok motion-reduce:animate-none" : "bg-destructive",
          )}
        />
        {words}
      </span>
    </p>
  );
}

/**
 * One of the bar's own presses — *Reset evidence*, *Send scan…*, the way out: a 44px square, the
 * primary's height, its words its name and its tooltip, so the bar stays a row of glyphs.
 */
export function PackPress({
  words,
  glyph,
  onClick,
  opensDialog = false,
}: {
  words: string;
  glyph: ReactNode;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  opensDialog?: boolean;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      aria-label={words}
      aria-haspopup={opensDialog ? "dialog" : undefined}
      {...tip(words, { describes: false })}
      onClick={onClick}
      className={cn(
        FILTER_CONTROL,
        "inline-flex size-11 shrink-0 items-center justify-center",
        filterChipState(false),
        FOCUS,
      )}
    >
      {glyph}
    </button>
  );
}

/**
 * The drawer's pull tab, standing off its left edge — so with the drawer shut it is the one thing
 * at the window's right edge, and with it open it rides out on the drawer's edge. **A disclosure**
 * (`aria-expanded`, `aria-controls`), with the tray's count of copies on it, so a reader sees the
 * pile grow without opening it.
 */
export function PackDrawerTab({
  open,
  onToggle,
  copies,
  controls,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  /** Copies in the tray. */
  copies: number;
  /** The drawer's id. */
  controls: string;
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={SCANNED_CARDS}
      {...tip(open ? "Hide scanned cards" : "Show scanned cards", { describes: false })}
      onClick={onToggle}
      className={cn(
        "absolute top-1/2 right-full flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-surface/90 px-1.5 py-3 text-text shadow-lg hover:text-accent",
        FOCUS,
        className,
      )}
    >
      {open ? (
        <ChevronRight className="size-4" aria-hidden="true" />
      ) : (
        <ChevronLeft className="size-4" aria-hidden="true" />
      )}
      <span className="font-mono text-xs tabular-nums">{copies}</span>
    </button>
  );
}

/** The way in, in the page's header beside *History*. */
export function PackOpenerButton({ onOpen }: { onOpen: (opener: HTMLElement) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      className={cn(
        FILTER_CONTROL,
        "inline-flex items-center gap-1.5 px-2.5",
        "border-border text-dim hover:border-accent hover:text-accent",
        FOCUS,
      )}
    >
      <PackageOpen className="size-3.5 shrink-0" aria-hidden="true" />
      {PACK_OPENER}
    </button>
  );
}
