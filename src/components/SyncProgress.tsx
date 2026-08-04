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
 * Never a complete account of a sync: Tauri drops events nobody is listening for, and
 * the startup sync emits its first ones before this component exists. Everything that
 * has to survive that is in `sync_status` instead.
 */
function useSyncProgress(): SyncProgressEvent | null {
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    void ipc.onSyncProgress(setProgress).then((unlisten) => {
      // `listen` resolves a tick later than the unmount can happen, so the handle has to
      // be dropped here too — otherwise it outlives the component for the app's lifetime.
      if (cancelled) unlisten();
      else stop = unlisten;
    });
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

function Bar({ value, className }: { value: number | null; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // Omitted, not zeroed, when the total is unknown: `aria-valuenow="0"` would be a
      // claim that no progress has been made.
      {...(value === null ? {} : { "aria-valuenow": value })}
      className={cn("h-1 overflow-hidden rounded-full bg-bg", className)}
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

/**
 * Sync feedback, in the two shapes it needs.
 *
 * `cardCount === 0` — and only `0` — means an empty database, so the app has nothing to
 * show and the first sync gets the whole screen. `null` means the poll could not read
 * the count, which is the normal state *during* every sync; treating it as empty would
 * black out a working 116 k-card app once a day.
 */
export function SyncProgress({ cardCount }: { cardCount: number | null }) {
  const progress = useSyncProgress();

  if (cardCount === 0 && progress?.phase !== "done") return <FirstRun progress={progress} />;

  // Failures belong to the header's banner, which is fed by the *persisted* `lastError`
  // and so survives a reload; repeating them here would print the same sentence twice.
  if (!progress || progress.phase === "done" || progress.phase === "error") return null;

  const pct = percent(progress);
  const numbers = detail(progress);
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-2 text-xs text-muted">
      <span>{PHASE_LABEL[progress.phase]}</span>
      <Bar value={pct} className="min-w-24 flex-1" />
      {numbers && <span className="tabular-nums">{numbers}</span>}
    </div>
  );
}

/**
 * First launch: 77 MB to download and ~117 k rows to import, with nothing usable behind
 * it. A modal is honest about that — the alternative is an empty app that looks broken.
 */
function FirstRun({ progress }: { progress: SyncProgressEvent | null }) {
  const failed = progress?.phase === "error";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-bg px-8 text-center"
    >
      <div className="max-w-md space-y-2">
        <h1 id="first-run-title" className="font-heading text-2xl text-text">
          Setting up your card database
        </h1>
        <p className="text-sm text-muted">
          Downloading every Magic card from Scryfall. This happens once and takes a few minutes —
          after that the app works offline.
        </p>
      </div>

      <div className="w-full max-w-md space-y-2">
        {!failed && <Bar value={progress ? percent(progress) : null} className="h-1.5" />}
        <div className="flex justify-between text-xs text-muted">
          <span>{progress ? PHASE_LABEL[progress.phase] : "Starting…"}</span>
          {progress && <span className="tabular-nums">{detail(progress)}</span>}
        </div>
      </div>

      {failed && (
        <p role="alert" className="max-w-md text-sm text-destructive">
          {progress?.message ?? "The card data could not be downloaded."} Use Refresh to try again.
        </p>
      )}
    </div>
  );
}
