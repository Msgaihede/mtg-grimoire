import { CircleArrowUp, LoaderCircle, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { CaptionButton } from "@/components/CaptionButton";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { Activity } from "@/lib/activity";
import type { LiveState } from "@/lib/ipc";
import { PRESS, TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ChromeStatusProps {
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
  /** An error banner is showing below; the row stays out of its way. */
  hasError: boolean;
  onRefresh: () => void;
  /**
   * The long job the app is running, or `null` when it is idle. Once
   * {@link ChromeStatusProps.activityVisible} it takes the status line; the mana line under the
   * header is `AppShell`'s and reads the same job.
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
  /**
   * The relay socket's state, or `null` for no marker at all.
   */
  deviceSync?: LiveState | null;
  /** Opens Settings at the Sync panel. */
  onOpenSync?: () => void;
  /** Whether the sentences carry `data-tauri-drag-region` — false where no window verbs are. */
  drag?: boolean;
}

/**
 * The one sentence a hover gets, per socket state — never `"off"` or `null`, which the row does
 * not draw at all.
 *
 * **`live` says the least, on purpose.** A socket that is doing its job is not news: the whole
 * reason this marker exists is `offline`, where a reader believes their edits are going
 * somewhere and they are not. Saying more about `live` than "it is" would spend the same weight
 * on the state that never needed defending.
 */
const DEVICE_SYNC_TOOLTIP: Record<Exclude<LiveState, "off">, string> = {
  connecting: "Reconnecting to your other devices…",
  live: "Synced with your other devices.",
  offline: "Sync disconnected. Changes will sync when the connection is back.",
};

/**
 * The accessible name of the marker, per socket state.
 *
 * **A map rather than `"Sync " + deviceSync`, which is what this was.** That produced
 * "Sync connecting" and "Sync live" — the state's wire spelling with a word bolted on front,
 * read out as-is by a screen reader. The `LiveState` values are an enum shared with Rust and
 * are not English; the label a person hears has to be written as English somewhere, and beside
 * {@link DEVICE_SYNC_TOOLTIP} is where the other sentence about each state already lives.
 */
const DEVICE_SYNC_LABEL: Record<Exclude<LiveState, "off">, string> = {
  connecting: "Sync is reconnecting",
  live: "Sync is live",
  offline: "Sync is offline",
};

/**
 * The app's status, drawn in the window header's right-hand run: from left to right the update
 * button (when there is one), the status line — card count and data date, or the running job —
 * the device-sync marker and Refresh, which sits against the keyboard map's button.
 *
 * **It replaced the 56px ribbon and its page heading on 2026-10-11.** That row existed to give
 * Refresh and the sync status a place that never changed with the view; the window header is
 * such a place already, on every page and over every modal, so the row was 56px of chrome
 * restating a fact the rail beside it already shows (which page is lit). The heading survives
 * as an `sr-only` `<h1>` in `AppShell`'s `main`, for the screen reader that navigates by it.
 *
 * **Refresh and the marker are caption squares now**, the keyboard map's family, rather than
 * the rounded chips they were: a rounded chip in a run of full-height squares reads as foreign.
 * Refresh lost its words with its room, and its name is its `aria-label` and its hover.
 *
 * **Of the run, the status line is the one that gives when the row runs short.** It carries
 * `min-w-0 truncate` and every neighbour is `shrink-0`. A truncated live region still announces
 * its whole sentence and still carries it in the tooltip, so what is lost is a glance rather
 * than a fact — where squeezing a neighbour would clip a control or a sentence outright.
 *
 * **Every non-control in it carries `data-tauri-drag-region`**, because the attribute does not
 * inherit and this run sits in the caption: a sentence the reader cannot grab the window by is
 * a hole in the grab area (`TitleBar`). `drag` is false where no caption verbs are drawn.
 */
export function ChromeStatus({
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
  deviceSync = null,
  onOpenSync,
  drag = true,
}: ChromeStatusProps) {
  const tip = useTooltip();
  // Two sentences about one folder, in the tooltip that already names it. Not a banner:
  // every affected image still *displays* — the bytes were in hand when the write failed
  // — so nothing is broken on screen and interrupting the reader would overstate it. What
  // is wrong is invisible without this: the cache never fills, and every revisit
  // re-downloads.
  //
  // **It has graduated to a visible number**, and this line used to promise that it would:
  // Settings' `Data folder` section states both facts in type — the folder that is live and
  // how many images could not be written to it — since 2026-08-29. This stays anyway, and the
  // two are a second door rather than a move: a pointer reader loses nothing, and a touch
  // reader has no hover at all, which is what the section was added *for*.
  const tooltip =
    [
      dataDir,
      imageStoreFailures > 0 &&
        `${imageStoreFailures} card image${imageStoreFailures === 1 ? "" : "s"} couldn't be saved to the cache — the data folder may be read-only or full.`,
    ]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n") || undefined;

  // The job takes the row while it is running; the corpus summary is a static fact about a
  // database and comes straight back when it stops.
  const showActivity = activityVisible && activity !== null;
  const said = showActivity ? activity.label : statusLine;

  /** The update button's words — which of its two promises this install can keep. */
  const updateLabel = updateInstallable
    ? `Update to ${updateVersion}`
    : `${updateVersion} available`;

  const dragRegion = drag ? { "data-tauri-drag-region": true } : {};

  return (
    // **`relative`, and it is load-bearing rather than tidy.** Tailwind's `.sr-only` is
    // `position: absolute`, and one with no positioned ancestor resolves against the *initial*
    // containing block, is laid out at its static position and is clipped by nothing — which
    // stretches the **document** (`packages/ui/CLAUDE.md`). The status line is one whenever it
    // is empty.
    <div {...dragRegion} className="relative flex h-full min-w-0 items-center">
      <div {...dragRegion} className="flex min-w-0 items-center gap-3 pr-2">
        {/* First, because it is the rarer and more consequential thing on this row — and gold
            rather than the grey every other control wears, which is the app's existing word for
            "you can act on this" rather than a new colour invented for one button. */}
        {updateVersion && (
          <button
            type="button"
            onClick={onOpenUpdate}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-accent/60 px-2",
              "text-xs text-accent hover:bg-accent/10",
              PRESS,
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <CircleArrowUp className="size-3.5" aria-hidden="true" />
            {/* Two labels, because they are two different promises. This install can replace
                itself; an MSI or Linux build can only be shown where to download — and a
                control says exactly what happens when it is used. */}
            {updateLabel}
          </button>
        )}
        {/* A fade, and deliberately **not** `statusLine`: this line is a flex item in a
            horizontal row, so growing its height from zero would animate the one dimension
            nothing here is laid out along. Opacity is the whole of what a sentence arriving in
            a row can honestly animate. */}
        <AnimatePresence initial={false}>
          {upToDate && !busy && !hasError && (
            <motion.p
              {...dragRegion}
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={TRANSITION.fast}
              className="shrink-0 select-none text-xs text-dim"
            >
              Already up to date
            </motion.p>
          )}
        </AnimatePresence>
        {/* One line, mounted for the life of the header, saying either what the app is doing
            or what is in the database.

            **Mounted even when empty**, because it is a live region and a live region that
            first appears with its sentence already inside it announces nothing — the same
            lesson as the sidebar's drop report. Empty, `sr-only` takes it out of the flex row
            so the gap between its neighbours does not grow by a phantom element. */}
        <p
          {...dragRegion}
          role="status"
          className={said ? "min-w-0 select-none truncate text-xs text-dim" : "sr-only"}
          {...tip(tooltip)}
        >
          {said}
          {/* Hidden from the announcement, not from the eye: the label changes about four
              times in a sync while the number changes fifty-eight times during the ingest
              alone, and the mana line's `aria-valuenow` is where a fraction belongs. Geist Mono
              because the direction's third type role is data, and a count that reflows its own
              width every 200 ms is exactly what it is for. */}
          {showActivity && activity.detail && (
            <span aria-hidden="true" className="font-mono tabular-nums">
              {" · "}
              {activity.detail}
            </span>
          )}
        </p>
      </div>
      {/* A marker rather than a verb — this only ever announces something the reader could not
          otherwise see, which is why `live` and `connecting` are drawn as dim as the row allows
          and only `offline` reaches for the destructive colour. **No `role="status"`,
          deliberately**: the status line beside it is the one live region here, and a reader
          does not need to be told a working socket exists. The word is in a hover only, and the
          accessible name carries the state on its own (`aria-label`).

          **`aria-live="polite"` all the same**: `role="status"` implies it but the implication
          does not run backwards, so this is still invisible to `getByRole("status")` while a
          screen-reader user still hears the live→offline flip — the one event this marker
          exists to surface. The `sr-only` sentence is what the region announces: a live region
          announces the *text* inside it, and an `aria-hidden` icon is none. */}
      {deviceSync !== null && deviceSync !== "off" && (
        <CaptionButton
          label={DEVICE_SYNC_LABEL[deviceSync]}
          tooltip={DEVICE_SYNC_TOOLTIP[deviceSync]}
          live
          tone={deviceSync === "offline" ? "destructive" : undefined}
          onSelect={onOpenSync}
          Icon={
            deviceSync === "offline" ? WifiOff : deviceSync === "connecting" ? LoaderCircle : Wifi
          }
          iconClassName={
            deviceSync === "connecting" ? "animate-spin motion-reduce:animate-none" : undefined
          }
        >
          <span className="sr-only">{DEVICE_SYNC_TOOLTIP[deviceSync]}</span>
        </CaptionButton>
      )}
      {/* No spinner on the icon while `busy`: the mana line under the header is the app's one
          sync animation, and the direction's motion budget spends itself there. The button says
          it another way — disabled, and `aria-busy`. */}
      <CaptionButton
        label="Refresh data"
        Icon={RefreshCw}
        onSelect={onRefresh}
        disabled={busy}
        busy={busy}
      />
    </div>
  );
}
