import { useSyncExternalStore } from "react";
import { DESKTOP_FLOOR_PX } from "@/lib/viewports";

export type Face = "phone" | "desktop";

/**
 * The floor the desktop UI is designed and measured down to, and no further.
 *
 * At or above it the light app draws the desktop's own pages; below it, the phone face. Nothing
 * in the desktop app picks a face and nothing there may start — the question is the light
 * entry's, and this is the only place it is asked.
 */
const QUERY = `(min-width: ${DESKTOP_FLOOR_PX}px)`;

export function faceFor(width: number): Face {
  return width >= DESKTOP_FLOOR_PX ? "desktop" : "phone";
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const read = (): Face => (window.matchMedia(QUERY).matches ? "desktop" : "phone");

/** Which face the viewport's width asks for, kept current as the width changes. */
export function useFace(): Face {
  return useSyncExternalStore(subscribe, read, (): Face => "phone");
}
