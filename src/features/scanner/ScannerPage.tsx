import { useRef, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import { useNarrowWindow } from "@/lib/useNarrowWindow";
import { isWebTarget } from "@/pwa/target";
import { Overlay } from "./Overlay";
import { ScannerPanels } from "./ScannerPanels";
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import type { ScannerOptions } from "./types";
import { useCamera } from "./useCamera";
import { useScanLoop } from "./useScanLoop";
import { headline, WEB_SENTENCE } from "./verdictText";

/**
 * The Scanner view: the camera on the left, the tracker's verdict and the developer panels on
 * the right — the debug page, in the app's chrome.
 *
 * **Dispatched above the hooks.** On the web target there is no detector, so the whole view is
 * one sentence and nothing below this line runs: no camera is asked for, no command is called,
 * and no `useQuery` is conditional — `BackupPanel`'s shape, for `BackupPanel`'s reason.
 *
 * **The camera and the panels are two halves on purpose.** `useCamera` and `useScanLoop` own
 * the stream and the pump; `ScannerPanels` is pure and takes the latest verdict as a prop, so
 * it is tested from fixtures and storied without a camera, and a change to a panel never
 * touches the loop.
 *
 * **A reader of `useNarrowWindow`, not a second viewport branch.** A phone holds the camera above
 * the verdict rather than beside it, and what that asks is whether the app is in its phone shape —
 * an answer the shell has already decided. `viewports.ts` demands a reason at the site of any
 * branch on width; the reason here is that there is no new branch, and the hook's own doc names
 * this view.
 */
export function ScannerPage(): JSX.Element {
  return isWebTarget() ? <WebSentence /> : <LiveScanner />;
}

function WebSentence() {
  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="sr-only">Scanner</h2>
      <p className="text-dim">{WEB_SENTENCE}</p>
    </section>
  );
}

function LiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camera = useCamera(videoRef);
  const [options, setOptions] = useState<ScannerOptions>(DEFAULT_SCANNER_OPTIONS);
  const [sendPx, setSendPx] = useState(DEFAULT_SEND_PX);
  // `staleTime: Infinity` and no button to invalidate it: `scanner_status` loads the bundle and
  // the models on its first call and answers out of what it loaded thereafter, so asking again
  // in the same session cannot report a file that has since appeared. A `Reload assets` press
  // would redraw the same three sentences and read as a repair that had happened; restarting
  // the app is the honest instruction, and it is what the sentences already name a path for.
  const status = useQuery({
    queryKey: ["scanner", "status"],
    queryFn: ipc.scannerStatus,
    staleTime: Infinity,
  });
  const loop = useScanLoop({ videoRef, live: camera.kind === "live", options, sendPx });
  const narrow = useNarrowWindow();

  /**
   * A refusal to reset has somewhere to go, which `void ipc.scannerReset()` did not give it.
   *
   * The command can fail — a poisoned mutex, a scanner thread that did not come back — and a
   * discarded rejection is a press that visibly did nothing and said nothing. It goes in the
   * strip under the video, behind the detector's own sentence: the same failure that stops a
   * reset stops every frame, and the frame's line names it better. Cleared on the next press
   * rather than on a timer, so a reader who tries again sees the second answer, not the first.
   */
  const [resetError, setResetError] = useState<string | null>(null);

  const onReset = () => {
    setResetError(null);
    // The two halves of Reset: the crate drops the tracker's evidence, and the page drops the
    // reads it is holding on top of it. Local first — it cannot fail and must not wait.
    loop.clearReads();
    ipc.scannerReset().catch((e: unknown) => setResetError(ipcError(e)));
  };

  /**
   * This frame into the dataset, under the name a person read off the cardboard.
   *
   * `Infinity` is the long edge, so the file is the sensor's own resolution rather than the
   * downscale the pump sends — the point of a capture is to keep a frame the detector got
   * wrong at the size a later re-run would want it. The four figures beside `expected` are
   * what the tracker had to say at the moment of the press, each stringified here because
   * `ScannerSidecar` is a note for a person and an absent figure there is `""`.
   */
  const onCapture = async (expected: string) => {
    const bytes = await loop.grab(Infinity, 0.92);
    if (bytes === null) throw new Error("no video yet");
    const tracked = loop.verdict?.tracked ?? null;
    const lead = tracked?.standings[0];
    const saved = await ipc.scannerCapture(bytes, {
      expected,
      reported: lead?.label?.name ?? "",
      confidence: tracked ? tracked.confidence.toFixed(3) : "",
      votes: lead ? lead.evidence.toFixed(2) : "",
      distance: loop.verdict?.match?.candidates[0]?.distance.toString() ?? "",
    });
    return saved.saved;
  };

  return (
    <section className="flex h-full flex-col gap-3">
      {/* Not shown: the ribbon already says `Scanner`, and every pixel of this view's height is
          the camera's. It is here to name the view for assistive tech, as the other views' do. */}
      <h2 className="sr-only">Scanner</h2>

      <div
        className={
          narrow
            ? "flex min-h-0 flex-1 flex-col gap-4 overflow-auto"
            : "flex min-h-0 flex-1 gap-4"
        }
      >
        {/* **The two arms size the video box by opposite mechanisms, and the narrow one has to.**
            Wide, the row is the height and the box takes what the `w-80` column leaves. Narrow,
            the row is a *scrolling column*: a zero-basis `flex-1` under a scrolling parent yields
            all of its free space to a `shrink-0` sibling, so one opened developer panel whose
            intrinsic height reached the container's would collapse the camera to ~0px. So on a
            phone the box is `w-full shrink-0` at the camera's own aspect ratio — the picture's
            real shape, at full width — and the panels follow it down the page. */}
        <div
          className={
            narrow
              ? "relative w-full shrink-0 overflow-hidden rounded-lg bg-black"
              : "relative min-w-0 flex-1 overflow-hidden rounded-lg bg-black"
          }
          style={
            narrow
              ? {
                  // 4:3 until the stream reports its own size: a starting or refused camera has
                  // no shape to honour, and an unset ratio here is the collapse again.
                  aspectRatio:
                    camera.kind === "live" ? `${camera.width} / ${camera.height}` : "4 / 3",
                }
              : undefined
          }
        >
          <video ref={videoRef} muted playsInline className="h-full w-full object-contain" />
          <Overlay videoRef={videoRef} verdict={loop.verdict} />
          <div className="absolute left-3 top-3 rounded-full bg-bg/85 px-3 py-1 text-sm">
            {headline(loop.verdict)}
          </div>
          {camera.kind === "error" && (
            <p
              role="alert"
              className="absolute inset-0 flex items-center justify-center p-6 text-center text-dim"
            >
              {camera.message}
            </p>
          )}
          {/* The detector's own sentence, in a strip that is *emptied* rather than removed: a
              frame that fails is the ordinary case at nine answers a second, and a box that
              grew and shrank under the video with each one would be the loudest thing on the
              screen. Two lines of room, held whether or not there is anything to put in it. */}
          <p className="absolute bottom-2 left-3 min-h-[2.5em] text-xs text-dim" aria-live="polite">
            {loop.verdict?.ok === false
              ? (loop.verdict.error ?? "")
              : (loop.error ?? resetError ?? "")}
          </p>
        </div>

        {/* Narrow: the panels follow the camera down the page and the whole column scrolls as
            one, which is why the scroller above is on the row rather than here. Wide: a fixed
            column that scrolls by itself, so opening a developer panel never moves the video. */}
        <div className={narrow ? "shrink-0" : "w-80 shrink-0 overflow-auto"}>
          <ScannerPanels
            status={status.data ?? null}
            verdict={loop.verdict}
            lastOcr={loop.lastOcr}
            lastCollector={loop.lastCollector}
            roundTripMs={loop.roundTripMs}
            rate={loop.rate}
            options={options}
            sendPx={sendPx}
            onOptions={setOptions}
            onSendPx={setSendPx}
            onReset={onReset}
            onCapture={onCapture}
          />
        </div>
      </div>
    </section>
  );
}
