import { useEffect, useState } from "react";

/**
 * `true` once `active` has been true for `ms` without interruption; `false` the instant it
 * stops.
 *
 * Deliberately asymmetric. Appearing is the half that needs a threshold — the ribbon's
 * activity line must not flash a sentence during a sub-second phase — and disappearing must
 * not, because a line that lingered after the work stopped would be the interface saying
 * something untrue about the present moment.
 */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      // A `setState` to the value it already holds is a bail-out in React, not a render.
      setOn(false);
      return;
    }
    const timer = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return on;
}
