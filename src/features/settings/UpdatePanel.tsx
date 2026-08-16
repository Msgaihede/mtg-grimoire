import { CircleArrowUp, CircleCheck, Download, ExternalLink, RefreshCw } from "lucide-react";
import { formatBytes, formatChecked, type Update } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

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
 * other panel on this page; the only gold on it is the primary button and the focus ring,
 * which is what gold already means everywhere else in this window.
 */
export function UpdatePanel({ update }: { update: Update }) {
  const { status, progress, busy, action, error } = update;
  const release = status?.available ?? null;

  return (
    <SettingsSection id="updates" title="Updates">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text">
            MTG Grimoire{" "}
            {/* A version is data, and data is Geist Mono — the direction's third type
                role, alongside collector numbers and prices. */}
            <span className="font-mono tabular-nums">{status?.currentVersion ?? "…"}</span>
          </p>
          <p className="text-xs text-dim">{formatChecked(status?.lastCheckAt ?? null)}</p>
        </div>
        <button
          type="button"
          onClick={update.check}
          disabled={busy}
          aria-busy={busy || undefined}
          className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Check now
        </button>
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
            // Plain text in a scroller, not markdown: this app has no renderer for it, and
            // a half-rendered release note reads worse than an unrendered one. Capped
            // because a release body has no length limit and this panel does.
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg p-3 font-sans text-xs leading-relaxed text-dim">
              {release.notes}
            </pre>
          )}

          {progress && <Bar done={progress.done} total={progress.total} />}

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryAction update={update} />
            {action !== "unavailable" && (
              <button
                type="button"
                onClick={update.openReleasePage}
                className={cn(BUTTON, "border-border text-dim hover:bg-bg hover:text-text")}
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                View on GitHub
              </button>
            )}
          </div>

          {action === "install" && (
            <p className="text-xs text-dim">
              The app will close and reopen. Nothing in your collection is touched.
            </p>
          )}
          {action === "unavailable" && (
            <p className="text-xs text-dim">
              This copy was installed in a way the app can&rsquo;t update on its own. Download{" "}
              {release.version} from the release page and install it over this one — your
              collection stays where it is.
            </p>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-2 border-t border-border pt-4 text-sm text-dim">
          {status?.lastCheckAt ? (
            <>
              <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
              You&rsquo;re on the latest version.
            </>
          ) : (
            "Checking for updates…"
          )}
        </p>
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
 */
function PrimaryAction({ update }: { update: Update }) {
  const { status, action, busy } = update;
  const gold =
    "border-accent/60 text-accent hover:bg-accent/10 disabled:hover:bg-transparent";

  if (action === "unavailable") {
    return (
      <button
        type="button"
        onClick={update.openReleasePage}
        className={cn(BUTTON, gold)}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        Open the release page
      </button>
    );
  }
  if (action === "install") {
    return (
      <button
        type="button"
        onClick={update.install}
        disabled={busy}
        aria-busy={busy || undefined}
        className={cn(BUTTON, gold)}
      >
        <CircleArrowUp className="size-4" aria-hidden="true" />
        Restart to finish
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={update.download}
      disabled={busy}
      aria-busy={busy || undefined}
      className={cn(BUTTON, gold)}
    >
      <Download className="size-4" aria-hidden="true" />
      {busy
        ? "Downloading…"
        : `Download ${status?.asset ? formatBytes(status.asset.size) : "the update"}`}
    </button>
  );
}
