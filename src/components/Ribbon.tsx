import { CircleArrowUp, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ManaLine } from "@/components/ManaLine";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { Activity } from "@/lib/activity";
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
  /**
   * There is no room in this row for the words, because there is no rail beside it either —
   * the shell is below `PHONE_PX` and has drawn `BottomTabBar` instead.
   *
   * **Told rather than asked.** `useNarrowWindow` is the one viewport branch in this app and it
   * is `AppShell`'s, for the reason written at its site: the shell is the only component drawn
   * in exactly one box and that box is the window. This row is drawn in the shell's box *less
   * the rail*, so a second `matchMedia` here would be a second answer to a question already
   * asked — and would be asking it about the wrong box on every desk width. A prop keeps the
   * branch a single call, and it is what lets this component's suite drive both shapes without
   * stubbing a global.
   *
   * **The same word as `NavItem`'s and `NavNote`'s `narrow`, and it means the same thing:**
   * *this drawing has no room for its words*. What differs is which drawing — those two are
   * asked about a rail 68px wide, this one about a window with no rail at all.
   */
  narrow: boolean;
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
 * The floor a finger needs, read as the token rather than typed as `44` again — a number
 * written twice is a number that can drift, which is the whole reason `--target-min` exists.
 *
 * **Written only in the narrow shape, because that is the shape where these two buttons lose
 * their words.** `Refresh data` is 150.91 × 42 with its label and, without it, `border` 1+1 plus
 * `px-3.5`'s 14+14 plus a `size-5` glyph — 50 wide and 38 tall. 50 already clears the floor;
 * 38 does not, and shrinking a control past it is exactly what the floor is there to catch.
 * Nothing about the desk moves, because the style is simply not written there.
 *
 * **Not the `coarse:` variant**, which is the other half of this vocabulary and belongs to the
 * controls a *view* draws for a pointer it cannot see. The shell already knows which shape it is
 * in and does not have to ask about the pointer to answer this.
 */
const TOUCH_FLOOR = { minWidth: "var(--target-min)", minHeight: "var(--target-min)" } as const;

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
 * ---
 *
 * **What the row holds at 390px, and why the title is what goes.**
 *
 * Measured in headless Edge over the built stylesheet with the real faces, 2026-08-29, at the
 * full 390px **with no rail at all**: the `<h1>` is given **78px** of the **125.75** that
 * `Collection` needs, and the status line **89** of its **243.95**. `Refresh data` alone is
 * **150.91 × 42** — 43% of the window, and the single reason nothing else fits. **Cinzel never
 * goes below 18px** (the type direction's own floor; `TitleBar`'s 13px wordmark is paid for by
 * being a *wordmark* rather than interface text), so a 20px title cannot be shrunk to share the
 * row. It is painted whole or it is not painted.
 *
 * 9a measured that **no** arrangement of the four fits and deliberately left the choice to
 * whoever first saw the assembled stack. This is that choice, and it turns on two facts:
 *
 * - **The title's word is already on screen, permanently.** `BottomTabBar` draws the same six
 *   words across the foot of the window and marks the open one `text-accent` under its glyph
 *   with `aria-current="page"`. Painting `Collection` a second time costs 125.75 of a 350px
 *   content box — 36% of it — for a fact the chrome states anyway. On a desk the rail says it
 *   too and the question never arises, because the row has about 1032px to say it in.
 * - **The status line's sentence is on screen nowhere else.** Task 5 gave the data folder and
 *   the image-cache failures a home in Settings' `Data folder` section, but how many cards the
 *   database holds and how old the data is are said here and only here.
 *
 * So the title goes **`sr-only`, and never removed**: it is the document's only `<h1>`, a page
 * with no heading is a page with no name, and the word is still what every heading query and the
 * accessibility tree find. The status line then takes the room it gave up. The arithmetic, from
 * the class strings rather than from a browser: 390 less `px-5`'s 40 is 350, less the icon-only
 * Refresh's 50 and one `gap-4`, leaves **284** for a sentence that wants 243.95. It fits whole,
 * and it costs **nothing on the vertical** — which is the axis this layout is short of and the
 * one a second row would have spent.
 *
 * **What still truncates, and it is the right thing to truncate.** While the update button is up,
 * or for the few seconds `Already up to date` is, the status line is the flex item that gives:
 * it carries `min-w-0 truncate` and both its neighbours are `shrink-0`. A truncated live region
 * still announces its whole sentence and still carries it in the tooltip, so what is lost is a
 * glance rather than a fact — where dropping either of the other two would lose an announcement
 * outright.
 *
 * **Two sentences this row does *not* hold**, and they are recorded here because they are the
 * rest of the same problem: the sidebar's drop report and the refused-add alert both lived in
 * the rail, and the rail is gone below this width. `AppShell` draws them above the tab bar —
 * they are navigation's sentences and navigation moved to the foot of the window — rather than
 * here, where a permanently-present chrome row would have to grow to hold them.
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
  narrow,
  updateVersion = null,
  updateInstallable = false,
  onOpenUpdate,
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
  // two are a second door rather than a move: a pointer reader loses nothing, and a phone
  // reader has no hover at all, which is what the section was added *for*.
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

  /** One string for the update button, painted where there is room and its `aria-label` where
   *  there is not — so the two promises stay two and never become four. */
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
          status line was given an empty state, and narrow it has two. */}
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
            which moves it further from that floor rather than nearer it.

            **Narrow it is `sr-only`, which is the whole of this task's arrangement decision** —
            the argument, the two widths it rests on and why the alternative loses more are in
            the component's own comment above. `sr-only` rather than a conditional render for
            two reasons at once: the document keeps its only `<h1>`, and `.sr-only` is
            `position: absolute`, so the title leaves the flex row without leaving a `gap-4`
            behind it. The status line one element over has used exactly that mechanism for its
            empty state since it was written. */}
        <h1 className={narrow ? "sr-only" : "truncate font-heading text-xl leading-none"}>
          {title}
        </h1>

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
              // Narrow the word goes and the name stays. It is the *same* string either way,
              // built once above, so the two spellings of this button cannot drift into two
              // different promises — which is the one thing about this control that matters.
              aria-label={narrow ? updateLabel : undefined}
              style={narrow ? TOUCH_FLOOR : undefined}
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
              {!narrow && updateLabel}
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
              row so the gap between its neighbours does not grow by a phantom element.

              **It is the same element in both shapes, and that is the point of this task.**
              Narrow it is not moved, not re-mounted and not swapped for a copy elsewhere: a
              live region that only sometimes exists announces nothing, and a region that is
              unmounted and remounted at a width is a region that only sometimes exists. What
              changes at 390px is what stands *beside* it — the title stops being painted — so
              this line is simply given the room, whole. The 284 against 243.95 is in the
              component's comment above. */}
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
            // **The word goes and the name stays**, which is the difference between a control
            // that shed its label and one that lost it: `Refresh data` is still this button's
            // accessible name, still what a screen reader says and still what every query in
            // this app's suite finds. 150.91px of it was 43% of the window, and it is the
            // single measurement that made the rest of this row impossible.
            aria-label={narrow ? "Refresh data" : undefined}
            style={narrow ? TOUCH_FLOOR : undefined}
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
            {!narrow && "Refresh data"}
          </button>
        </div>
      </div>
      <ManaLine sync={activity} />
    </div>
  );
}
