import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { NAV } from "@/components/nav";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { LightView } from "@/lib/edition";
import { queryClient } from "@/lib/query";
import type { Place } from "../routes";
import { usePlace } from "./router";
import { Shell } from "./Shell";

/** The word for a destination — the desktop rail's, so the two apps cannot name one differently. */
const titleOf = (view: LightView): string => NAV.find((n) => n.id === view)?.label ?? "";

/** The page for a place. Task 7 fills each arm. */
function Pages({ place }: { place: Place }) {
  return <p className="p-4 text-sm text-dim">{titleOf(place.view)} arrives in the next task.</p>;
}

/**
 * The phone face, less its providers — what a test renders inside a fake world's own.
 */
export function PhoneFace() {
  const place = usePlace();
  return (
    <Shell title={titleOf(place.view)}>
      <Pages place={place} />
    </Shell>
  );
}

/**
 * The phone face: the light app below 1024px.
 *
 * Its providers are the desktop's own, in the desktop's order and for `App.tsx`'s reasons —
 * `MotionConfig` outermost because `motion` ships `reducedMotion: "never"`, and the one shared
 * `queryClient`, so data read by one face is still in the cache when a resize draws the other.
 */
export default function PhoneApp() {
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <PhoneFace />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
