import type { ReactNode, RefObject } from "react";
import { Overlay } from "@grimoire/ui/features/scanner/Overlay";
import type { CameraState } from "@grimoire/ui/features/scanner/useCamera";
import type { ScannerVerdict } from "@grimoire/ui/lib/ipc";

/**
 * The camera's picture, **filling whatever the page leaves it** (the scanner redesign,
 * 2026-10-24): a `flex-1 min-h-0` box in a column that is the page's height, so upright it is
 * everything between the controls and the tray's peek, and on its side the left column's height
 * between the controls and Start/Stop. The page no longer scrolls, which is what makes a
 * zero-basis grow safe here — under a scrolling parent it collapsed to nothing (`card-scanner.md`
 * §9), which is why this box was shaped by the stream's aspect until then.
 *
 * **The picture is cropped to the box, never letterboxed**: the video and the overlay's canvas
 * both carry `object-cover`, about the same centre, which is the one thing the two elements have
 * to agree on for the quad to sit on the card. The engine sees the whole frame either way.
 *
 * **Two things it says itself**, where the picture would be, each as an alert:
 *
 * - the camera's own refusal;
 * - `unavailable` — a host with no scanner session at all (`useScannerPrefs`' `unavailable`: a
 *   web page until the light app's web step), in the engine's sentence: no camera was asked for
 *   there, so nothing else will ever fill this box.
 *
 * **Everything else laid over the picture is the caller's** (`children`), and the box is
 * `relative` and the picture's size for it: the HUD (`ScanHud` — the progress bar, the corner
 * presses and the chip the scanner's errors are said on), the picture's notes (`StoppedVeil`,
 * `HoldPrompt`, `HeldChip`), point and shoot's hold (`HoldSurface`), the confetti and the Added
 * popup. Laid in after the video and the overlay, so DOM order puts every one of them over both.
 */
export function CameraBox({
  videoRef,
  camera,
  verdict,
  unavailable = null,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  camera: CameraState;
  /** This frame's verdict, for the quad — `null` while recognition is stopped. */
  verdict: ScannerVerdict | null;
  /** The host has no scanner session, in the engine's sentence — or `null`. */
  unavailable?: string | null;
  children?: ReactNode;
}) {
  return (
    <div
      data-camera-box=""
      className="relative min-h-0 w-full flex-1 overflow-hidden rounded-lg bg-black"
    >
      <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
      <Overlay videoRef={videoRef} verdict={verdict} />
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
      {children}
    </div>
  );
}
