import { Download } from "lucide-react";
import { PANEL_BUTTON } from "@/features/settings/controls";
import { cn } from "@/lib/utils";
import type { ScannerAssetsProgress, ScannerStatus } from "./types";
import { useScannerAssets } from "./useScannerAssets";
import { bundleSentence, modelsSentence } from "./verdictText";

export interface ScannerAssetsProps {
  /**
   * `scanner_status`' answer, or `null` before it has one — for the sentences an offer does not
   * replace: a file that is there and did not load on a host with nothing to fetch, and card
   * names that did not load beside a bundle that did.
   */
  status: ScannerStatus | null;
  /**
   * A fetch has ended and the engine has let its session go for the files that arrived, so the
   * next one is new. The page's two debts: push the filters to it again, and drop what the last
   * session said. Called once per fetch, only while this is mounted.
   */
  onLoaded?: () => void;
  className?: string;
  /**
   * `data-*` attributes for the root element — for a face that has to find the offer, or measure
   * it. On the root and so **on nothing when nothing is drawn**: a wrapper that carried them
   * would be an element in the page whether or not there was anything to say.
   */
  marks?: Record<`data-${string}`, string>;
}

/** `19 MB` — decimal megabytes, rounded up: these are what a reader on a metered link is told,
 *  so they err upward, as the launch downloads' own sizes do. */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1_000_000))} MB`;
}

/** Whether the status says the file a row names is loaded and in use. */
function inUse(status: ScannerStatus | null, key: string): boolean {
  if (status === null) return false;
  if (key === "bundle") return status.bundle.loaded;
  if (key === "detectionModel") return status.detection_model.loaded;
  if (key === "recognitionModel") return status.recognition_model.loaded;
  return false;
}

/**
 * The offer's one sentence: **a need, or an update that can wait.**
 *
 * A host can owe a file the scanner is already running on — a newer bundle of card hashes
 * than the one it holds, which a host that fetches from a release sees after every release
 * that rebuilt it. Said as a need (*"The scanner needs its card data"*) that is false: the
 * scanner is scanning, and the reader is being told to download six megabytes to go on doing
 * it. So when everything owed is something the status says is loaded, the sentence is about
 * newer data and nothing in it says *needs*. Read from the two answers a host already gives —
 * what is owed, and what loaded — on every host alike.
 */
export function offerSentence(
  status: ScannerStatus | null,
  owed: readonly { key: string }[],
  bytes: number,
): string {
  const update = owed.length > 0 && owed.every((file) => inUse(status, file.key));
  return update
    ? `Newer card data is available — about ${megabytes(bytes)}.`
    : `The scanner needs its card data — about ${megabytes(bytes)}.`;
}

/** The sentence beside the bar while a fetch runs. */
function progressLine(progress: ScannerAssetsProgress | null, loading: boolean): string {
  if (loading || progress?.phase === "done") return "Loading the scanner's files…";
  if (progress === null) return "Starting the download…";
  if (progress.phase === "checking") return "Checking what arrived…";
  if (progress.total <= 0) return "Downloading…";
  // Whole megabytes: a line that reflows twice a second is motion without information. The
  // total is rounded up as the offer's is, so the count is rounded down until the last byte and
  // then *is* the total — a download that ended at "18 of 19 MB" would read as one megabyte lost.
  const whole = Math.max(1, Math.ceil(progress.total / 1_000_000));
  const so = progress.done >= progress.total ? whole : Math.floor(progress.done / 1_000_000);
  return `Downloading — ${so} of ${whole} MB`;
}

/**
 * Under the camera: the scanner's files, where this install does not have them.
 *
 * **Drawn from what the host answers, and from nothing else.** `scanner_assets` says which files
 * are owed and what they cost; with rows, this is the offer — one sentence with the measured
 * size, what each file is, and a Download button. With none it is whatever `scanner_status` still
 * has to say, as before; and a host that refuses the command, or whose binary carries the files,
 * draws no offer at all. Nothing here knows whether it is on a phone or a desktop.
 *
 * **The offer replaces the instruction to place a file.** A reader with a button is not told to
 * put `card-hashes.bin` at a path and restart — on a phone nobody can reach the path — so the
 * two sentences that say so are dropped for the files the host offers. Nothing is fetched until
 * the press: the size is the point of asking.
 *
 * **One box for the three states of a fetch**, so the camera above never moves as it runs: the
 * offer, the bar with how far it has got, and the failure with the engine's sentence and a
 * Retry — which fetches only what is still owed. When it ends the box goes, the status is
 * re-read, and the page is told the engine's session is a new one ({@link ScannerAssetsProps}).
 */
export function ScannerAssets({ status, onLoaded, className, marks }: ScannerAssetsProps) {
  const assets = useScannerAssets(onLoaded);
  const busy = assets.fetching || assets.loading;
  const offered = (key: string) => assets.owed.some((file) => file.key === key);
  // While a fetch runs or the status is being re-read, the status on screen predates the files:
  // none of its sentences about a missing one is drawn.
  const notes = [
    bundleSentence(status, busy || offered("bundle")),
    modelsSentence(status, busy || offered("detectionModel") || offered("recognitionModel")),
  ].filter((sentence): sentence is string => sentence !== null);
  const offer = assets.owed.length > 0 || busy;
  if (!offer && notes.length === 0) return null;

  const progress = assets.progress;
  const fraction =
    assets.loading || progress === null || progress.total <= 0
      ? null
      : Math.min(100, Math.round((progress.done / progress.total) * 100));

  return (
    <div {...marks} className={cn("space-y-2", className)}>
      {offer && (
        <section
          aria-label="Scanner files"
          className="space-y-2.5 rounded-lg border border-border bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {busy ? (
              // No size and no list while it runs: the line under the bar has the numbers, and
              // once the answer is in there is nothing left owed to list.
              <p className="min-w-0 flex-1 text-sm text-text">Getting the scanner's card data.</p>
            ) : (
              <div className="min-w-0 flex-1 basis-56 space-y-1">
                <p className="text-sm text-text">
                  {offerSentence(status, assets.owed, assets.bytes)}
                </p>
                <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-dim">
                  {assets.owed.map((file) => (
                    <li key={file.key}>
                      {file.label}, about {megabytes(file.bytes)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!busy && (
              <button
                type="button"
                onClick={assets.fetch}
                className={cn(
                  PANEL_BUTTON,
                  "border-accent/60 text-accent hover:bg-accent/10",
                )}
              >
                <Download className="size-4" aria-hidden="true" />
                {assets.error === null ? "Download" : "Retry"}
              </button>
            )}
          </div>
          {busy && (
            <div className="space-y-1.5">
              <div
                role="progressbar"
                aria-label="Downloading the scanner's files"
                aria-valuemin={0}
                aria-valuemax={100}
                // Omitted rather than zeroed when there is no fraction: a zero is a claim that
                // nothing has arrived.
                {...(fraction === null ? {} : { "aria-valuenow": fraction })}
                className="h-1 overflow-hidden rounded-full bg-bg"
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none",
                    fraction === null && "animate-pulse motion-reduce:animate-none",
                  )}
                  style={{ width: fraction === null ? "100%" : `${fraction}%` }}
                />
              </div>
              <p role="status" className="font-mono text-xs tabular-nums text-dim">
                {progressLine(progress, assets.loading)}
              </p>
            </div>
          )}
          {!busy && assets.error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {assets.error}
            </p>
          )}
        </section>
      )}
      {notes.length > 0 && (
        <div className="space-y-1 text-xs text-dim">
          {notes.map((note) => (
            // A path is one unbreakable word, and the column may be a phone's width.
            <p key={note} className="break-words">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
