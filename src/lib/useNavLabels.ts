import { useEffect, useState } from "react";

/**
 * Whether the sidebar is wide enough to paint a word — `false` while the rail is collapsed, and
 * **for the length of the width tween while it is opening back up**.
 *
 * The rail's width is a CSS transition and its labels are a React commit, so without this the
 * two run at once and both directions are wrong. Reported 2026-08-22, and each half is its own
 * bug:
 *
 * * **Expanding**, `collapsed` flips in one commit and six labels re-enter the flow at their
 *   full width while the rail is still 68px and growing. `<nav>` has no `overflow-hidden` — it
 *   cannot have one, the collapsed rail's floating notes hang off it at `left-full` — so the
 *   words are painted *over the view beside them* until the rail catches up. Sampled per frame
 *   in the shipped window 2026-08-22, with this hold backed out live: `Decks` sat with its right
 *   edge at **102** against a rail 68 wide, **34px** outside it, and stayed outside for the
 *   first ~55ms of the tween. Every one of the seven words does it — `Tags` by 22px, `Collapse`
 *   by 52, `Collection` by **62**.
 * * **Collapsing**, the same instant flip is the half that is right: the words leave in the
 *   commit that starts the rail shrinking, so nothing is ever painted wider than the rail
 *   holding it.
 *
 * So: **asymmetric, and the asymmetry is the whole of it.** Going narrow needs no delay and must
 * not have one. Coming back wide waits out the tween, and the caller then fades the words in
 * over `DURATION.instant` — the rail's travel has already said they are coming, and the
 * fade is only the hard edge taken off text switching on.
 *
 * `delayMs` rather than a duration read from `lib/motion`, because the value the caller owes is
 * *the tween it is waiting for*, and under `prefers-reduced-motion` that tween does not happen —
 * `motion-reduce:transition-none` snaps the rail to its new width, and a rail that snapped wide
 * and then sat wordless for 180ms would be this bug again with the sign flipped. The caller
 * passes 0 there, which lands the words on the next task rather than the next frame; nothing on
 * screen has moved in between, so there is nothing for that task to be visible against.
 *
 * Turning off is done by **adjusting state during render**, React's documented alternative to an
 * effect for state derived from a prop — `useDelayedFlag` is the same shape for the same
 * two reasons: an effect would clear the flag one commit *after* the press, which is one painted
 * frame of exactly the overflow this exists to prevent, and `react-hooks/set-state-in-effect`
 * rejects the synchronous call outright.
 *
 * **The initial value is the state itself, not `false`.** A shell that opens expanded has to
 * open with its words, and a hook that started every mount narrow would fade all six labels in
 * 180ms after launch — a delay whose whole justification is a tween that never ran.
 */
export function useNavLabels(collapsed: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(!collapsed);
  const [wasCollapsed, setWasCollapsed] = useState(collapsed);

  if (wasCollapsed !== collapsed) {
    setWasCollapsed(collapsed);
    // Only ever *down* from here, in the same commit as the press. Coming back up is the
    // timer's job below, because that is the half that has to wait for the rail.
    if (collapsed) setShown(false);
  }

  useEffect(() => {
    if (collapsed) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [collapsed, delayMs]);

  return shown;
}
