import { CircleArrowUp, LoaderCircle, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ManaLine } from "@/components/ManaLine";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { Activity } from "@/lib/activity";
import type { LiveState } from "@/lib/ipc";
import { PRESS, TRANSITION } from "@/lib/motion";
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
  /**
   * The relay socket's state, or `null` for no marker at all.
   */
  deviceSync?: LiveState | null;
  /** Opens Settings at the Sync panel. */
  onOpenSync?: () => void;
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
 *
 * **Of the right-hand group, the status line is the one that gives when the row runs short.** It
 * carries `min-w-0 truncate` and every neighbour is `shrink-0`. A truncated live region still
 * announces its whole sentence and still carries it in the tooltip, so what is lost is a glance
 * rather than a fact — where squeezing a neighbour would clip a control or a sentence outright.
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
  deviceSync = null,
  onOpenSync,
}: RibbonProps) {
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

  return (
    <div className="shrink-0">
      {/* **`relative`, and it is load-bearing rather than tidy.** Tailwind's `.sr-only` is
          `position: absolute`, and one with no positioned ancestor resolves against the
          *initial* containing block, is laid out at its static position and is clipped by
          nothing — which stretches the **document** (`src/CLAUDE.md`; the deck editor's 1704px
          phantom scrollbar is what that cost). This row has had one such element ever since the
          status line was given an empty state. */}
      <div className="relative flex h-14 items-center gap-4 bg-surface px-5">
        {/* **The dim `MTG` mark and its divider stood here until 2026-08-20, and what removed
            them was the thing that justified them.** The comment on that mark read: "not the
            product name: the window title bar already says that in full" — an argument resting
            on Windows' caption, which `decorations: false` deleted. `TitleBar` says
            `MTG GRIMOIRE` one row up now, in the same face and the same dim grey, so an
            abbreviation of it 34px below was the name twice and app › app › view. The rung it
            used to supply is supplied by the row above it. */}
        {/* Cinzel's only job in this row, and never below 18px — the direction is
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
                PRESS,
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              )}
            >
              <CircleArrowUp className="size-5" aria-hidden="true" />
              {/* Two labels, because they are two different promises. This install can
                  replace itself; an MSI or Linux build can only be shown where to
                  download — and a control says exactly what happens when it is used. */}
              {updateLabel}
            </button>
          )}
          {/* A small marker rather than a control that competes with Refresh — the row's other
              two buttons announce something the reader can *do*; this only ever announces
              something the reader could not otherwise see, which is why `live` and
              `connecting` are drawn as dim as the row allows and only `offline` reaches for the
              destructive colour. **No `role="status"`, deliberately**: the row's own status
              line two elements over is the one live region here, and a reader does not need to
              be told a working socket exists. The word is in a hover only, through
              `useTooltip()` and never a native `title`, and the accessible name carries the
              state on its own (`aria-label`) so a screen reader still gets it without one.

              **`aria-live="polite"` all the same, and it does not conflict with the rule above.**
              `role="status"` implies `aria-live="polite"`, but the implication does not run
              backwards — this element still carries no `role`, so it is still invisible to
              `getByRole("status")`, and a sighted reader still gets the live→offline flip for
              free (the icon turning red in peripheral vision). Without this a screen-reader
              user got nothing from that transition unless they happened to be tabbed to the
              marker at the moment it happened, for the one event this whole feature exists to
              surface.

              ⚠️ **The `sr-only` span is what makes that paragraph true, and it was missing.**
              A live region announces the *text* inside it when that text changes; this button's
              only child was an `aria-hidden` icon, so the region had no text at all and a
              changed `aria-label` is not reliably announced as a live update. The region was
              live and permanently silent — the argument above describing a flip nothing said.
              The sentence is {@link DEVICE_SYNC_TOOLTIP}'s, so the hover and the announcement
              cannot drift, and it is invisible for the reason every other `sr-only` in this app
              is: the icon is the sighted reader's copy of it. */}
          {deviceSync !== null && deviceSync !== "off" && (
            <button
              type="button"
              onClick={onOpenSync}
              aria-label={DEVICE_SYNC_LABEL[deviceSync]}
              aria-live="polite"
              {...tip(DEVICE_SYNC_TOOLTIP[deviceSync])}
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md p-1.5",
                PRESS,
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                deviceSync === "offline"
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-dim hover:bg-bg",
              )}
            >
              {deviceSync === "offline" ? (
                <WifiOff className="size-4" aria-hidden="true" />
              ) : deviceSync === "connecting" ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Wifi className="size-4" aria-hidden="true" />
              )}
              {/* The live region's text. Without it the region has nothing to announce — see
                  the paragraph above. */}
              <span className="sr-only">{DEVICE_SYNC_TOOLTIP[deviceSync]}</span>
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
            {...tip(tooltip)}
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
              PRESS,
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
