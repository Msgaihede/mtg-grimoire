import { CircleArrowUp, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ManaLine } from "@/components/ManaLine";
import type { Activity } from "@/lib/activity";
import { TRANSITION } from "@/lib/motion";
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
  /**
   * The long job the app is running, or `null` when it is idle. Drives the mana line, and —
   * once {@link RibbonProps.activityVisible} — the status line too.
   */
  activity: Activity | null;
  /**
   * Whether the job has been running long enough to be worth a sentence.
   *
   * A separate flag rather than a second, delayed copy of the job: two props carrying the
   * same thing at two different times are two props that can disagree. `AppShell` owns the
   * threshold (`ACTIVITY_DELAY_MS`), because the 2px line must react instantly while a
   * sentence nobody can finish reading is worse than no sentence at all.
   */
  activityVisible: boolean;
  /** A newer version of the app exists — `"0.3.0"`. `null` when there is nothing to say. */
  updateVersion?: string | null;
  /**
   * Whether this install can actually install it, which decides what the button *promises*.
   * An MSI install and every Linux build can only be pointed at the release page, and a
   * button reading "Update to 0.3.0" on one of those is the interface making a promise it
   * cannot keep.
   */
  updateInstallable?: boolean;
  /** Opens Settings, where the release notes and the actual update controls are. */
  onOpenUpdate?: () => void;
}

/**
 * The global ribbon: one 56px row that owns every action which is not about the view
 * below it.
 *
 * Refresh and the sync status used to live in a per-view header, which made them look
 * like properties of whatever was on screen. They are properties of the *app*, so they
 * belong in one place that never changes — and the mana line beneath is what marks that
 * place as the app's edge rather than the content's.
 *
 * **56px rather than the 48px the direction was drawn at** (2026-08-14), with every piece of
 * type and every icon in it one step up the same ladder: the title and the mark 18 → 20px, the
 * two buttons 14 → 16px, the status line 12 → 14px, the icons 16 → 20px. The row was legible
 * and small, and the app it fronts is full-window card art — chrome that reads as a footnote
 * beside its own content is chrome the reader has to aim at. **The one thing that did not
 * scale is the mana line**: a 2px rule is the signature, and a signature that grows with its
 * frame is a border. The sidebar's width did not move either, for a reason that is nothing to
 * do with this row — see `AppShell`.
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
  activity,
  activityVisible,
  updateVersion = null,
  updateInstallable = false,
  onOpenUpdate,
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

  // The job takes the row while it is running; the corpus summary is a static fact about a
  // database and comes straight back when it stops.
  const showActivity = activityVisible && activity !== null;
  const said = showActivity ? activity.label : statusLine;

  return (
    <div className="shrink-0">
      <div className="flex h-14 items-center gap-4 bg-surface px-5">
        {/* The mark, not the product name: the window title bar already says that in full,
            and 56px of vertical space is not where a five-word name earns its keep. Dim
            rather than gold — gold means "you can act on this, or this is where you are",
            and a wordmark is neither. Quiet, it reads as the first step of app › view. */}
        <span aria-hidden="true" className="font-heading text-xl leading-none text-dim">
          MTG
        </span>
        <span aria-hidden="true" className="h-5 w-px bg-border" />
        {/* Cinzel's only job in the chrome, and never below 18px — the direction is
            explicit that the display face is for titles, not for interface text. 20px now,
            which moves it further from that floor rather than nearer it. */}
        <h1 className="truncate font-heading text-xl leading-none">{title}</h1>

        <div className="ml-auto flex min-w-0 items-center gap-4">
          {/* Before the status line and Refresh, because it is the rarer and more
              consequential thing on this row — and gold rather than the border grey every
              other control wears, which is the app's existing word for "you can act on
              this" rather than a new colour invented for one button. The boldness budget
              is spent on the mana line two pixels below; this borrows a token it already
              has. */}
          {updateVersion && (
            <button
              type="button"
              onClick={onOpenUpdate}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-md border border-accent/60 px-3.5 py-2",
                "text-base text-accent hover:bg-accent/10",
                // One arbitrary property list rather than a colour utility beside a transform
                // one: those two compile to the same CSS longhand, so tailwind-merge keeps
                // whichever it saw last and the press feedback snaps with nothing to show.
                "transition-[color,background-color,border-color,opacity,transform,scale]",
                "duration-[var(--duration-fast)] ease-standard active:scale-[0.97]",
                "motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              )}
            >
              <CircleArrowUp className="size-5" aria-hidden="true" />
              {/* Two labels, because they are two different promises. This install can
                  replace itself; an MSI or Linux build can only be shown where to
                  download — and a control says exactly what happens when it is used. */}
              {updateInstallable ? `Update to ${updateVersion}` : `${updateVersion} available`}
            </button>
          )}
          {/* A fade, and deliberately **not** `statusLine`: this line is a flex item in a
              horizontal row, so growing its height from zero would animate the one dimension
              nothing here is laid out along, while the row's own width still jumped. Opacity
              is the whole of what a sentence arriving in a row can honestly animate. */}
          <AnimatePresence initial={false}>
            {upToDate && !busy && !hasError && (
              <motion.p
                role="status"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={TRANSITION.fast}
                className="shrink-0 text-sm text-dim"
              >
                Already up to date
              </motion.p>
            )}
          </AnimatePresence>
          {/* One line, mounted for the life of the ribbon, saying either what the app is
              doing or what is in the database.

              **Mounted even when empty**, because it is a live region and a live region that
              first appears with its sentence already inside it announces nothing — the same
              lesson as the sidebar's drop report. Empty, `sr-only` takes it out of the flex
              row so the gap between its neighbours does not grow by a phantom element. */}
          <p
            role="status"
            className={said ? "min-w-0 truncate text-sm text-dim" : "sr-only"}
            title={tooltip}
          >
            {said}
            {/* Hidden from the announcement, not from the eye: the label changes about four
                times in a sync while the number changes fifty-eight times during the ingest
                alone, and the mana line's `aria-valuenow` is where a fraction belongs. Geist
                Mono because the direction's third type role is data, and a count that reflows
                its own width every 200 ms is exactly what it is for. */}
            {showActivity && activity.detail && (
              <span aria-hidden="true" className="font-mono tabular-nums">
                {" · "}
                {activity.detail}
              </span>
            )}
          </p>
          {/* No spinner on the icon while `busy`: the mana line two pixels below is the
              app's one sync animation, and the direction's motion budget spends itself
              there. The button says it another way — disabled, and `aria-busy`. */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            aria-busy={busy || undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3.5 py-2 text-base",
              "hover:bg-bg",
              "transition-[color,background-color,border-color,opacity,transform,scale]",
              "duration-[var(--duration-fast)] ease-standard active:scale-[0.97]",
              "motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              // Held at full size while a sync is running: the button is already `disabled` and
              // `aria-busy`, and a press that dips and does nothing would be a third answer
              // that disagrees with both.
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
              "disabled:active:scale-100",
            )}
          >
            <RefreshCw className="size-5" aria-hidden="true" />
            Refresh data
          </button>
        </div>
      </div>
      <ManaLine sync={activity} />
    </div>
  );
}
