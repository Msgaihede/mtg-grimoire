import { lazy, Suspense } from "react";
import { useStartup } from "@/boot/useStartup";
import { BootScreen } from "./BootScreen";
import { DownloadsPrompt } from "./DownloadsPrompt";
import { FaceBoundary } from "./FaceBoundary";
import { StorageNotice } from "./StorageNotice";
import { useFace } from "./useFace";

// **Each face is its own chunk.** A phone never downloads the desktop's deck editor and a laptop
// never downloads the phone's sheets — which is also why neither is imported statically here.
const DesktopFace = lazy(() => import("./DesktopFace"));
const PhoneApp = lazy(() => import("./phone/PhoneApp"));

/**
 * The light app: a gate, and one of two faces.
 *
 * **The face is chosen by the viewport's width and by nothing else** — at 1024px and above, the
 * desktop UI itself; below it, the phone face. Both are whole apps with their own providers; what
 * they share is the URL, which is how a resize that crosses the floor lands on the same
 * destination in the other one.
 *
 * `gate` is false only in fake mode, where there is no startup to wait for.
 *
 * **The gate can close again, once.** A host whose engine stops under an open app says so on the
 * startup status (`useStartup`), and the boot screen is then drawn *in place of* the faces, with
 * the host's sentence and its way out — the whole subtree goes, the face's boundary and both
 * things mounted beside it included, so nothing left on screen is asking an engine that is not
 * there. Whatever a face had begun to draw of its own failing reads is replaced in that render.
 */
export function LightApp({ gate }: { gate: boolean }) {
  const status = useStartup(gate);
  const face = useFace();

  if (status.state !== "ready") return <BootScreen status={status} />;

  return (
    <>
      {/* Keyed by the face: a face that failed must not take the other one down with it. */}
      <FaceBoundary key={face}>
        <Suspense fallback={<BootScreen status={{ state: "loading" }} />}>
          {face === "desktop" ? <DesktopFace /> : <PhoneApp />}
        </Suspense>
      </FaceBoundary>
      {/* Above both faces and outside the boundary, so a crossing neither re-asks nor drops it. */}
      <DownloadsPrompt />
      {/* The same arrangement: asked of the host once, and drawn only if it answers. **Last in
          the document on purpose** — it shares a rung with the desktop face's first-run screen,
          and equal rungs paint in document order (`StorageNoticeCard`). */}
      <StorageNotice />
    </>
  );
}
