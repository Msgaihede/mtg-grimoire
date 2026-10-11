import type { ReactNode, RefObject } from "react";
import { Overlay } from "@grimoire/ui/features/scanner/Overlay";
import type { CameraState } from "@grimoire/ui/features/scanner/useCamera";
import type { ScannerVerdict } from "@grimoire/ui/lib/ipc";

/** What the box is shaped like before a stream has said its own shape. */
const DEFAULT_ASPECT = 4 / 3;

/**
 * The camera's picture, in a box **shaped by the stream and capped by the screen**.
 *
 * The desktop's video box is a `flex-1` child of a column that is the view's height. This page is a
 * scrolling column instead, and a zero-basis `flex-1` under a scrolling parent yields all its free
 * space to its siblings — the camera collapses to nothing (`card-scanner.md` §9, the trap the
 * desktop's own retired narrow arm recorded). So the box is the column's width at the stream's own
 * aspect ratio, 4:3 until a stream reports one.
 *
 * **And capped**, because a phone held upright can answer a portrait stream — 9:16 at 328px wide
 * would be 583px tall, which pushes the status line and the tray off the screen. Past the
 * cap the picture is cropped rather than letterboxed: the video and the overlay's canvas both
 * carry the same object fit, about the same centre, which is the one thing the two elements have
 * to agree on for the quad to sit on the card. The engine sees the whole frame either way.
 *
 * **Three things it says itself**, each where the reader is looking:
 *
 * - `note` — a sentence top-left on a chip of the page's ground (dim type straight on a live
 *   picture is not readable on a white card): recognition stopped, a busy database, a frame the
 *   host turned away. **Its live region is always mounted and only its words come and go**: a
 *   region that first appears with its sentence already inside announces nothing.
 * - the camera's own refusal, as an alert where the picture would be;
 * - `unavailable` — a host with no scanner session at all (`useScannerPrefs`' `unavailable`: a
 *   web page until the light app's web step). The engine's sentence, as an alert where the picture
 *   would be: no camera was asked for there, so nothing else will ever fill this box.
 *
 * What else is laid over the picture is the caller's (`children`): the card that just landed.
 */
export function CameraBox({
  videoRef,
  camera,
  verdict,
  note = null,
  unavailable = null,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  camera: CameraState;
  /** This frame's verdict, for the quad — `null` while recognition is stopped. */
  verdict: ScannerVerdict | null;
  /** What the picture has to say, or `null`. */
  note?: string | null;
  /** The host has no scanner session, in the engine's sentence — or `null`. */
  unavailable?: string | null;
  children?: ReactNode;
}) {
  const aspect =
    camera.kind === "live" && camera.width > 0 && camera.height > 0
      ? camera.width / camera.height
      : DEFAULT_ASPECT;
  return (
    <div
      data-camera-box=""
      className="relative max-h-[38dvh] w-full shrink-0 overflow-hidden rounded-lg bg-black min-[720px]:max-h-[60dvh]"
      style={{ aspectRatio: aspect }}
    >
      <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
      <Overlay videoRef={videoRef} verdict={verdict} />
      {children}
      <p role="status" className="absolute top-2 left-2 max-w-[calc(100%-1rem)]">
        {note !== null && (
          <span className="block rounded bg-bg/85 px-2 py-1 text-xs leading-snug text-text">
            {note}
          </span>
        )}
      </p>
      {camera.kind === "error" && (
        <p
          role="alert"
          className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-dim"
        >
          {camera.message}
        </p>
      )}
      {unavailable !== null && (
        <p
          role="alert"
          className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-dim"
        >
          {unavailable}
        </p>
      )}
    </div>
  );
}
