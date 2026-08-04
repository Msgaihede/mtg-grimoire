import type { SyncProgressEvent } from "@/lib/ipc";
import { PHASE_LABEL } from "@/lib/useSyncProgress";
import { cn } from "@/lib/utils";

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
      // The track sits on the first-run overlay's `bg-bg`, so it has to be the *surface*
      // colour to be visible at all.
      className={cn("h-1 overflow-hidden rounded-full bg-surface", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none",
          // A full-width bar with nothing moving would read as "finished"; the pulse is
          // what says the length is unknown. Under reduced motion the label below it is
          // left to say so instead.
          value === null && "animate-pulse motion-reduce:animate-none",
        )}
        style={{ width: value === null ? "100%" : `${value}%` }}
      />
    </div>
  );
}

export interface SyncProgressProps {
  /**
   * The latest `sync:progress` event, or `null` if none has arrived.
   *
   * Passed in rather than subscribed to here: `AppShell` already listens for the ribbon's
   * mana line, and a second `useSyncProgress()` would be a second `listen` registration
   * on the same event for the life of the app.
   */
  progress: SyncProgressEvent | null;
  /** From `sync_status`. `0` means an empty database; `null` means "could not read". */
  cardCount: number | null;
  /** The banner's message — this session's rejection, else the persisted `lastError`. */
  error: string | null;
  /** A sync is in flight, or a forced one has been asked for and has not answered yet. */
  busy: boolean;
  /** Start a forced sync. The same action the ribbon's Refresh button runs. */
  onRetry: () => void;
}

/**
 * The first run, and nothing else.
 *
 * `cardCount === 0` — and only `0` — means an empty database, so the app has nothing to
 * show and the first sync gets the whole screen. `null` means the poll could not read
 * the count, which is the normal state *during* every sync; treating it as empty would
 * black out a working 116 k-card app once a day.
 *
 * Every other sync is reported by the ribbon's mana line, which is why there is no
 * second, slimmer bar here any more.
 */
export function SyncProgress({ progress, cardCount, error, busy, onRetry }: SyncProgressProps) {
  if (cardCount === 0 && progress?.phase !== "done") {
    return <FirstRun progress={progress} error={error} busy={busy} onRetry={onRetry} />;
  }
  return null;
}

/**
 * First launch: 77 MB to download and ~117 k rows to import, with nothing usable behind
 * it. Taking the screen is honest about that — the alternative is an empty app that looks
 * broken.
 *
 * Because it covers the ribbon, the ribbon's Refresh button is unreachable underneath,
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
function FirstRun({ progress, error, busy, onRetry }: Omit<SyncProgressProps, "cardCount">) {
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
            {/* Geist Mono: the direction's third type role is data, and a byte count that
                reflows its own width every 200 ms is exactly what it is for. */}
            {progress && <span className="font-mono tabular-nums">{detail(progress)}</span>}
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
        className={cn(
          "inline-flex items-center rounded-md border border-border px-4 py-2 text-sm",
          "transition-colors duration-150 hover:bg-surface",
          // The only control on screen while a first run is stuck, so its focus ring is
          // the one that matters most — same gold as the ribbon's.
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        )}
      >
        Retry download
      </button>
    </div>
  );
}
