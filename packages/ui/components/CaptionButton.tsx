import type { ReactNode } from "react";
import type { Minus } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";

/**
 * A caption button: 46px wide, full-height, square, flush to the window's edge.
 *
 * **The one control family in this app that is not a rounded 8px chip with a press-scale**,
 * and every departure is deliberate. A radius would put a gap of window between the button and
 * the corner it must occupy, so a click landing on the last pixel of the screen — the whole
 * point of a corner button, and Fitts's law's oldest example — would miss. `PRESS`'s
 * `active:scale-[0.97]` is left off for the neighbouring reason: a target that shrinks away
 * from the pointer at the moment of the press reads as a misclick, and at the screen's edge
 * the reader has nowhere to correct to.
 *
 * The focus ring is `ring-inset` for the same geometry: an outset ring on an element flush
 * with the window's top-right corner is drawn outside the window and simply is not there.
 *
 * **Its own file since the page header was folded into the caption row** (2026-10-11): Refresh
 * and the device-sync marker sit in the same run of squares as the keyboard map, and a rounded
 * chip in a row of square full-height buttons reads as foreign — so they wear this too.
 */
export function CaptionButton({
  label,
  Icon,
  onSelect,
  id,
  danger = false,
  forceHover = false,
  expanded,
  disabled = false,
  busy = false,
  tooltip,
  tone,
  live = false,
  iconClassName,
  children,
}: {
  label: string;
  Icon: typeof Minus;
  onSelect?: () => void;
  id?: string;
  /** Close. The only red control in the chrome, and it fills rather than tints. */
  danger?: boolean;
  /** Draw the hover state regardless of the pointer — see `TitleBar`'s snap overlay. */
  forceHover?: boolean;
  /**
   * Whether what this button opens is open — `aria-expanded`, and the same wash `forceHover`
   * draws.
   *
   * **The open state reuses that branch rather than adding a third styling path**, and the two
   * really are one thing: "this button is lit for a reason that is not the pointer". Left
   * `undefined` by default, not `false`, because `aria-expanded="false"` on Minimize would
   * announce a button that opens something and never does.
   */
  expanded?: boolean;
  /** Refresh while a sync runs: refused, and said so with `aria-busy` as well. */
  disabled?: boolean;
  busy?: boolean;
  /**
   * The hover's sentence, when it says more than the name. Left out, the hover is the label and
   * binds with `describes: false` — `label` is already the whole `aria-label`, so a wired
   * `aria-describedby` would have a screen reader hear "Minimize, Minimize".
   */
  tooltip?: string;
  /** `"destructive"` tints the glyph red at rest — the offline sync marker's one colour. */
  tone?: "destructive";
  /** `aria-live="polite"`, for a button whose state is news (the sync marker). */
  live?: boolean;
  iconClassName?: string;
  /** Screen-reader text inside the button — a live region needs text to announce. */
  children?: ReactNode;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      id={id}
      onClick={onSelect}
      aria-label={label}
      aria-expanded={expanded}
      aria-busy={busy || undefined}
      aria-live={live ? "polite" : undefined}
      disabled={disabled}
      // This is the one anchor family in the app pinned to the window's top edge, so its tooltip
      // is the one `placeTooltip` always has to flip downward rather than open above the window.
      {...(tooltip === undefined ? tip(label, { describes: false }) : tip(tooltip))}
      className={cn(
        "relative inline-flex h-full w-[46px] shrink-0 items-center justify-center",
        tone === "destructive" ? "text-destructive" : "text-dim",
        "transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        danger
          ? "hover:bg-destructive hover:text-white"
          : tone === "destructive"
            ? "hover:bg-destructive/10"
            : "hover:bg-accent/10 hover:text-accent",
        // The same two declarations the `hover:` variants carry, applied by state instead of
        // by the pointer. Tailwind cannot express "hover, or this flag", so the flag restates
        // them — and they are restated rather than extracted because a shared constant would
        // put the danger/normal branch in two places. Two flags reach it now and there is still
        // one branch: the snap overlay's hover, and a panel this button has open.
        (forceHover || expanded === true) &&
          (danger ? "bg-destructive text-white" : "bg-accent/10 text-accent"),
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-dim",
      )}
    >
      <Icon className={cn("size-4", iconClassName)} aria-hidden="true" />
      {children}
    </button>
  );
}
