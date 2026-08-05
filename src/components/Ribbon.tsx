import { RefreshCw } from "lucide-react";
import { ManaLine } from "@/components/ManaLine";
import type { ManaLineSync } from "@/lib/mana";
import { cn } from "@/lib/utils";

export interface RibbonProps {
  /** The active view's name. The one string in the chrome set in Cinzel. */
  title: string;
  /** Already formatted by `statusLine`, or `null` before the first poll answers. */
  statusLine: string | null;
  /** Tooltip on the status line: which data folder is live (spec §3). */
  dataDir: string | undefined;
  /**
   * Card images this run fetched and could not cache. Appended to the same tooltip when
   * non-zero, because it is a statement about that data folder and nothing else.
   */
  imageStoreFailures?: number;
  /** A sync is running — this window's Refresh, or the one spawned at startup. */
  busy: boolean;
  /** The last Refresh came back with nothing new. */
  upToDate: boolean;
  /** An error banner is showing below; the ribbon stays out of its way. */
  hasError: boolean;
  onRefresh: () => void;
  /** Drives the mana line. `null` when nothing is running. */
  sync: ManaLineSync | null;
}

/**
 * The global ribbon: one 48px row that owns every action which is not about the view
 * below it.
 *
 * Refresh and the sync status used to live in a per-view header, which made them look
 * like properties of whatever was on screen. They are properties of the *app*, so they
 * belong in one place that never changes — and the mana line beneath is what marks that
 * place as the app's edge rather than the content's.
 */
export function Ribbon({
  title,
  statusLine,
  dataDir,
  imageStoreFailures = 0,
  busy,
  upToDate,
  hasError,
  onRefresh,
  sync,
}: RibbonProps) {
  // Two sentences about one folder, in the tooltip that already names it. Not a banner:
  // every affected image still *displays* — the bytes were in hand when the write failed
  // — so nothing is broken on screen and interrupting the reader would overstate it. What
  // is wrong is invisible without this: the cache never fills, and every revisit
  // re-downloads. A settings screen (Plan 6) is where this graduates to a visible number.
  const tooltip =
    [
      dataDir,
      imageStoreFailures > 0 &&
        `${imageStoreFailures} card image${imageStoreFailures === 1 ? "" : "s"} could not be saved to the cache — the data folder may be read-only or full.`,
    ]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n") || undefined;

  return (
    <div className="shrink-0">
      <div className="flex h-12 items-center gap-3 bg-surface px-4">
        {/* The mark, not the product name: the window title bar already says that in full,
            and 48px of vertical space is not where a five-word name earns its keep. Dim
            rather than gold — gold means "you can act on this, or this is where you are",
            and a wordmark is neither. Quiet, it reads as the first step of app › view. */}
        <span aria-hidden="true" className="font-heading text-lg leading-none text-dim">
          MTG
        </span>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        {/* Cinzel's only job in the chrome, and never below 18px — the direction is
            explicit that the display face is for titles, not for interface text. */}
        <h1 className="truncate font-heading text-lg leading-none">{title}</h1>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {upToDate && !busy && !hasError && (
            <p role="status" className="shrink-0 text-xs text-dim">
              Already up to date
            </p>
          )}
          {statusLine && (
            <p className="truncate text-xs text-dim" title={tooltip}>
              {statusLine}
            </p>
          )}
          {/* No spinner on the icon while `busy`: the mana line two pixels below is the
              app's one sync animation, and the direction's motion budget spends itself
              there. The button says it another way — disabled, and `aria-busy`. */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            aria-busy={busy || undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
              "transition-colors duration-150 hover:bg-bg motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
            )}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh data
          </button>
        </div>
      </div>
      <ManaLine sync={sync} />
    </div>
  );
}
