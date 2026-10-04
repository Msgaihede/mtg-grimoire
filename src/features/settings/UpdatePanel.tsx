import { CircleArrowUp, CircleCheck, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useId } from "react";
import { GrimoireMark } from "@/components/GrimoireMark";
import type { ReleaseHistory } from "@/lib/useReleaseHistory";
import { formatBytes, formatChecked, type Update } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";
import { PANEL_BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import { ReleaseNotes } from "./ReleaseNotes";
import { VersionHistory } from "./VersionHistory";

/**
 * The download bar.
 *
 * Deliberately the same idiom as `SyncProgress`'s — an `h-1` `bg-surface` track with a gold
 * fill — rather than a second progress language for a second kind of download. A reader who
 * has watched a sync should not have to learn this one.
 */
function Bar({ done, total }: { done: number; total: number }) {
  const value = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-label="Downloading the update"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted rather than zeroed when the total is unknown: `aria-valuenow="0"` is a
        // claim that no progress has been made.
        {...(value === null ? {} : { "aria-valuenow": value })}
        className="h-1 overflow-hidden rounded-full bg-surface"
      >
        <div
          className={cn(
            "h-full rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none",
            value === null && "animate-pulse motion-reduce:animate-none",
          )}
          style={{ width: value === null ? "100%" : `${value}%` }}
        />
      </div>
      <p className="font-mono text-xs tabular-nums text-dim">
        {formatBytes(done)} of {formatBytes(total)}
      </p>
    </div>
  );
}

/**
 * Everything about the app's own version, in the one place a reader goes looking for it.
 *
 * The panel is deliberately quiet. The direction spends the boldness budget on the mana
 * line, so the box is {@link SettingsSection}'s — `bg-surface` and border grey, like every
 * other panel on this page.
 *
 * **Three things on it are gold, and the third is gold for a different reason than the other
 * two.** The primary button and the focus ring are gold because that is what gold means
 * everywhere else in this window: something to press, or the thing the caret is on. The
 * {@link GrimoireMark} beside the version is not an affordance at all — it is the app's own
 * artwork in the app's own accent, which is the colour the logo package draws it in
 * (`logos/README.md`: gold `#D1A84B`, `--color-accent`). It is allowed to break the rule
 * because nothing about it invites a press: it sits outside every control, against a name set
 * in plain `text-text`, in a panel with no other picture on it. A *fourth* gold thing here
 * would be worth arguing about; this one is the exception the mark earns by being what the
 * window is called.
 */
export function UpdatePanel({
  update,
  history,
  windows = 1,
}: {
  update: Update;
  /** Every release the last check saw — see {@link VersionHistory}. */
  history: ReleaseHistory;
  /**
   * How many windows the restart will close. A restart is the process, and every window is in
   * it, so past one the Restart button says so — see {@link PrimaryAction}.
   */
  windows?: number;
}) {
  const { status, progress, busy, action, error } = update;
  const release = status?.available ?? null;
  /**
   * Nothing on this panel presses until the backend has said which kind of install this is.
   * The release block's buttons need no gate of their own: `release` is read off `status`, so
   * there is no release to act on before this is true.
   */
  const canCheck = status !== null;

  return (
    <SettingsSection id="updates" title="Updates">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The app's mark, beside the version it is the mark for. This panel is the nearest
            thing the app has to an About screen — the name, the build and the last check are
            already answers to one question, and the mark is the fourth.

            **36px is the height of the block it stands beside, not a size off a scale.** The
            two lines to its right are `text-sm` over `text-xs`: 20px and 16px of line box, 36
            together. So the mark's box is exactly the pair's height and it lines up with them
            without a nudge, where a larger one would have to be centred against a block it
            overhangs — which is a logo pulling the eye off the line that actually answers the
            reader. It is also half again over the 24px `GrimoireMark` needs before it will
            draw the full artwork, so this is the casting circle, the runes and the clasp
            rivets rather than the simplified mark anything in a 34px chrome row can hold. A
            settings page is where the detail is affordable, and that is the whole of why the
            number here is not the number the chrome uses.

            **Hidden from assistive technology, which is the prop's default and is deliberate
            here rather than skipped.** The `<p>` beside it sets `MTG Grimoire` in type, in the
            same sentence as the version — so naming the mark would read the product name out
            twice in a row to the one reader who cannot see that the two are the same thing.
            `label` is for a surface that draws the mark *instead of* the words; this one draws
            both, and that is the test to apply if the sentence beside it ever changes. */}
        <div className="flex min-w-0 items-center gap-3">
          <GrimoireMark size={36} className="text-accent" />
          {/* `min-w-0` on both boxes, because a `min-w-0` that stops one level short of the
              text is the same as not having it: this wrapper is now the flex item the row
              wraps, and a flex item cannot shrink below its own min-content unless it is told
              it may. The mark carries its own `shrink-0`, so what gives way is the type. */}
          <div className="min-w-0">
            <p className="text-sm text-text">
              MTG Grimoire{" "}
              {/* A version is data, and data is Geist Mono — the direction's third type
                  role, alongside collector numbers and prices. */}
              <span className="font-mono tabular-nums">{status?.currentVersion ?? "…"}</span>
            </p>
            <p className="text-xs text-dim">{formatChecked(status?.lastCheckAt ?? null)}</p>
          </div>
        </div>
        {canCheck && (
          <button
            type="button"
            onClick={update.check}
            disabled={busy}
            aria-busy={busy || undefined}
            className={cn(PANEL_BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Check now
          </button>
        )}
      </div>

      {release ? (
        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <p className="text-sm text-text">
              <span className="font-mono tabular-nums text-accent">{release.version}</span> is
              available
              {release.publishedAt && (
                <span className="text-dim"> · released {release.publishedAt.slice(0, 10)}</span>
              )}
            </p>
          </div>

          {release.notes && (
            // Drawn rather than dumped, since 2026-08-17 — `ReleaseNotes` says what changed
            // and why the old `<pre>`'s argument no longer holds. Still capped and still a
            // scroller: a release body has no length limit and this panel does.
            <div className="max-h-48 overflow-auto rounded-md bg-bg p-3">
              <ReleaseNotes notes={release.notes} />
            </div>
          )}

          {progress && <Bar done={progress.done} total={progress.total} />}

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryAction update={update} windows={windows} />
            {action !== "unavailable" && (
              <button
                type="button"
                onClick={update.openReleasePage}
                className={cn(PANEL_BUTTON, "border-border text-dim hover:bg-bg hover:text-text")}
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                View on GitHub
              </button>
            )}
          </div>

          {action === "install" && (
            <p className="text-xs text-dim">
              The app will restart. Your data isn&rsquo;t affected.
            </p>
          )}
          {action === "unavailable" && (
            <p className="text-xs text-dim">
              This install can&rsquo;t update itself. Download {release.version} from the
              release page and install it over this one. Your data stays put.
            </p>
          )}
        </div>
      ) : status?.lastCheckAt ? (
        <p className="flex items-center gap-2 border-t border-border pt-4 text-sm text-dim">
          <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
          You&rsquo;re on the latest version.
        </p>
      ) : (
        // `desktop.rs` spawns a check at startup, so every install is doing exactly this while
        // the panel renders — and so is the first frame, where `status` is still `null`.
        <p className="flex items-center gap-2 border-t border-border pt-4 text-sm text-dim">
          Checking for updates…
        </p>
      )}

      {/* The list is written by `update_check` and by nothing else, so before the first check
          `VersionHistory` says that itself rather than drawing an empty accordion. */}
      {canCheck && (
        <VersionHistory history={history} currentVersion={status?.currentVersion} />
      )}

      {/* A refusal from GitHub or from the swap itself, in the app's red. */}
      <PanelAlert tone="problem">{error}</PanelAlert>
    </SettingsSection>
  );
}

/**
 * The one button whose label is the state machine.
 *
 * Same verb through the whole flow: "Download 6.4 MB" produces a bar, and only once the
 * bytes are on disk and verified does the button become "Restart to finish". Nothing
 * restarts the app until that second, deliberate press.
 *
 * **Past one window, that press says it closes all of them** — and says it as the button's own
 * description, so a reader who tabs to it hears the cost with the name rather than having to
 * find a sentence elsewhere on the page. Worth saying because only one window comes back after
 * the restart; a hint and not a dialog, because the press is already the second, deliberate one.
 */
function PrimaryAction({ update, windows }: { update: Update; windows: number }) {
  const { status, action, busy } = update;
  const hintId = useId();
  const gold =
    "border-accent/60 text-accent hover:bg-accent/10 disabled:hover:bg-transparent";

  if (action === "unavailable") {
    return (
      <button
        type="button"
        onClick={update.openReleasePage}
        className={cn(PANEL_BUTTON, gold)}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        Open the release page
      </button>
    );
  }
  if (action === "install") {
    return (
      <>
        <button
          type="button"
          onClick={update.install}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={windows > 1 ? hintId : undefined}
          className={cn(PANEL_BUTTON, gold)}
        >
          <CircleArrowUp className="size-4" aria-hidden="true" />
          Restart to finish
        </button>
        {/* **A line of its own under the buttons, by `order-last basis-full`**, which is this
            repo's way of breaking a wrapping row. This component draws into the parent's
            `flex-wrap` row beside View on GitHub, so a wrapper holding the button over the hint
            would either centre that neighbour against two lines or, since the sentence is wider
            than the button, push it right by the difference. The hint still follows the button
            in the DOM, which is the order a screen reader walks. */}
        {windows > 1 && (
          <p id={hintId} className="order-last basis-full text-sm text-dim">
            Restarting closes all {windows} windows.
          </p>
        )}
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={update.download}
      disabled={busy}
      aria-busy={busy || undefined}
      className={cn(PANEL_BUTTON, gold)}
    >
      <Download className="size-4" aria-hidden="true" />
      {busy
        ? "Downloading…"
        : `Download ${status?.asset ? formatBytes(status.asset.size) : "the update"}`}
    </button>
  );
}
