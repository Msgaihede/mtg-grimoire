import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc, type SyncPhase, type SyncProgressEvent } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<SyncPhase, string> = {
  checking: "Checking for card data updates",
  downloading: "Downloading card data",
  ingesting: "Importing cards",
  sets: "Updating set list",
  done: "Card data is up to date",
  error: "Sync failed",
};

/**
 * The latest `sync:progress` event, or `null` if none has arrived.
 *
 * Never a complete account of a sync: Tauri drops events nobody is listening for, the
 * startup sync emits its first ones before this component exists, and a run inside the
 * 24 h check window emits none at all. Everything that has to survive that is in
 * `sync_status` instead — which is why `SyncProgress` takes an `error` prop rather than
 * trusting these events to tell it when something went wrong.
 */
function useSyncProgress(): SyncProgressEvent | null {
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    ipc
      .onSyncProgress(setProgress)
      .then((unlisten) => {
        // `listen` resolves a tick later than the unmount can happen, so the handle has
        // to be dropped here too — otherwise it outlives the component for the app's
        // lifetime.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // Registering the listener fails outside a Tauri window (a plain `vite dev`, say).
      // Losing the fast path for progress is not worth taking the app down for: the
      // status poll still answers, and it is the reliable half of the pair.
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return progress;
}

/** `null` for a phase with no meaningful denominator (`checking`, `sets`, a failure). */
function percent(e: SyncProgressEvent): number | null {
  if (e.total <= 0) return null;
  return Math.min(100, Math.round((e.done / e.total) * 100));
}

/** The numbers under the bar, in the unit the phase is actually counting. */
function detail(e: SyncProgressEvent): string | null {
  const mb = (n: number) => (n / 1_000_000).toFixed(0);
  if (e.phase === "downloading" && e.total > 0) return `${mb(e.done)} / ${mb(e.total)} MB`;
  if (e.phase === "ingesting") return `${e.done.toLocaleString("en-US")} cards`;
  return null;
}

function Bar({
  value,
  label,
  className,
}: {
  value: number | null;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      // Without a name the bar is announced as an anonymous percentage; the phase is the
      // only thing that says what is being measured.
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      // Omitted, not zeroed, when the total is unknown: `aria-valuenow="0"` would be a
      // claim that no progress has been made.
      {...(value === null ? {} : { "aria-valuenow": value })}
      // The track sits on `bg-bg` in the slim variant and on a `bg-bg` overlay in the
      // first-run one, so it has to be the *surface* colour to be visible at all.
      className={cn("h-1 overflow-hidden rounded-full bg-surface", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width]",
          value === null && "animate-pulse",
        )}
        style={{ width: value === null ? "100%" : `${value}%` }}
      />
    </div>
  );
}

export interface SyncProgressProps {
  /** From `sync_status`. `0` means an empty database; `null` means "could not read". */
  cardCount: number | null;
  /** The banner's message — this session's rejection, else the persisted `lastError`. */
  error: string | null;
  /** A sync is in flight, or a forced one has been asked for and has not answered yet. */
  busy: boolean;
  /** Start a forced sync. The same action the header's Refresh button runs. */
  onRetry: () => void;
}

/**
 * Sync feedback, in the two shapes it needs.
 *
 * `cardCount === 0` — and only `0` — means an empty database, so the app has nothing to
 * show and the first sync gets the whole screen. `null` means the poll could not read
 * the count, which is the normal state *during* every sync; treating it as empty would
 * black out a working 116 k-card app once a day.
 */
export function SyncProgress({ cardCount, error, busy, onRetry }: SyncProgressProps) {
  const progress = useSyncProgress();

  if (cardCount === 0 && progress?.phase !== "done") {
    return <FirstRun progress={progress} error={error} busy={busy} onRetry={onRetry} />;
  }

  // Failures belong to the header's banner, which is fed by the *persisted* `lastError`
  // and so survives a reload; repeating them here would print the same sentence twice.
  if (!progress || progress.phase === "done" || progress.phase === "error") return null;

  const numbers = detail(progress);
  const label = PHASE_LABEL[progress.phase];
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-2 text-xs text-muted">
      <span>{label}</span>
      <Bar value={percent(progress)} label={label} className="min-w-24 flex-1" />
      {numbers && <span className="tabular-nums">{numbers}</span>}
    </div>
  );
}

/**
 * First launch: 77 MB to download and ~117 k rows to import, with nothing usable behind
 * it. Taking the screen is honest about that — the alternative is an empty app that looks
 * broken.
 *
 * Because it covers the header, the header's Refresh button is unreachable underneath,
 * so this carries its own. Every way a first run can stall ends here: a failure that
 * arrived as an event, one that only ever reached `lastError` (the startup sync fails
 * before the webview is listening, and Tauri drops the event), and a run throttled by the
 * 24 h check window, which says nothing at all. `busy` is the one thing that separates
 * "working on it" from "stopped", so it — not the presence of an event — decides.
 *
 * Not `aria-modal`: the app behind is not inert, and claiming otherwise would hide it
 * from assistive technology while it is still perfectly reachable by keyboard. The
 * message is plain text for the same reason — `AppShell`'s banner is the one `role=alert`
 * and it announces the same string.
 */
function FirstRun({
  progress,
  error,
  busy,
  onRetry,
}: { progress: SyncProgressEvent | null } & Omit<SyncProgressProps, "cardCount">) {
  // An `error` event outranks `busy`: the status poll is up to a second behind it, and a
  // failure must not sit hidden behind a progress bar for that second.
  const failed = progress?.phase === "error";
  const running = busy && !failed;
  const message = failed ? (progress?.message ?? error) : error;

  return (
    <div
      role="dialog"
      aria-labelledby="first-run-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-bg px-8 text-center"
    >
      <div className="max-w-md space-y-2">
        <h2 id="first-run-title" className="font-heading text-2xl text-text">
          Setting up your card database
        </h2>
        <p className="text-sm text-muted">
          Downloading every Magic card from Scryfall. This happens once and takes a few minutes —
          after that the app works offline.
        </p>
      </div>

      {running ? (
        <div className="w-full max-w-md space-y-2">
          <Bar
            value={progress ? percent(progress) : null}
            label={progress ? PHASE_LABEL[progress.phase] : "Starting"}
            className="h-1.5"
          />
          <div className="flex justify-between text-xs text-muted">
            <span>{progress ? PHASE_LABEL[progress.phase] : "Starting…"}</span>
            {progress && <span className="tabular-nums">{detail(progress)}</span>}
          </div>
        </div>
      ) : (
        <p className="max-w-md text-sm text-destructive">
          {message ?? "No download is running, and there is no card data yet."}
        </p>
      )}

      <button
        type="button"
        onClick={onRetry}
        disabled={running}
        className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Retry download
      </button>
    </div>
  );
}
