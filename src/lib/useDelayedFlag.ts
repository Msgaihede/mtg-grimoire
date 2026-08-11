import { useEffect, useState } from "react";

/**
 * `true` once `active` has been true for `ms` without interruption; `false` the instant it
 * stops.
 *
 * Deliberately asymmetric. Appearing is the half that needs a threshold — the ribbon's
 * activity line must not flash a sentence during a sub-second phase — and disappearing must
 * not, because a line that lingered after the work stopped would be the interface saying
 * something untrue about the present moment.
 *
 * Turning off is done by **adjusting state during render**, React's documented alternative
 * to an effect for state derived from a prop, rather than by a `setState` in an effect body.
 * Two reasons and they agree: an effect would clear the flag one commit *after* the work
 * stopped — a frame of the interface claiming something it no longer knows — and
 * `react-hooks/set-state-in-effect` rejects the synchronous call outright.
 */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  const [wasActive, setWasActive] = useState(active);

  if (wasActive !== active) {
    setWasActive(active);
    // Only ever *down* from here. Turning on is the timer's job below, because that is the
    // half that has to wait.
    if (!active) setOn(false);
  }

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return on;
}
