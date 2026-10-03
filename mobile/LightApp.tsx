import { lazy, Suspense } from "react";
import { useStartup } from "@/boot/useStartup";
import { BootScreen } from "./BootScreen";
import { DownloadsPrompt } from "./DownloadsPrompt";
import { FaceBoundary } from "./FaceBoundary";
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
    </>
  );
}
