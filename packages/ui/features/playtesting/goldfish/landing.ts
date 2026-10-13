import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useReducedMotion } from "motion/react";
import type { GoldfishView } from "@/lib/ipc";
import { DURATION, EASE, cssEase } from "@/lib/motion";

/**
 * Where a card landed, shown: the card that has just arrived in a zone pops and glows once, so
 * the reader sees where a drop went — the table lays cards out by the rules, not where they were
 * let go, so the landing is otherwise easy to miss.
 *
 * **A card has arrived when its id is new** (CR 400.7: an object that changes zone is a new
 * one), so nothing else is needed to tell a landing from a tap: a tapped card keeps its id. The
 * element a card is drawn by says which ids it shows in `data-land` (space-separated, a pile's
 * every card), and the board looks them up once the view has drawn.
 */

/** More new cards than this in one step is a new deal or a mulligan's seven, not a landing. */
export const LANDING_MAX = 8;

/** Every id the reader can see a card land as: every zone but the library's middle. */
export function idsOf(view: GoldfishView): Set<number> {
  const ids = new Set<number>();
  for (const zone of [view.hand, view.battlefield, view.graveyard, view.exile, view.command]) {
    for (const c of zone) ids.add(c.id);
  }
  for (const c of view.libraryCards) ids.add(c.id);
  return ids;
}

/** The ids that are in `now` and were not in `was`, or none when the step is not a landing. */
export function freshIds(was: ReadonlySet<number> | null, now: ReadonlySet<number>): number[] {
  if (was === null) return [];
  const fresh = [...now].filter((id) => !was.has(id));
  return fresh.length > LANDING_MAX ? [] : fresh;
}

/** `scale` rather than `transform`, so a tapped card's rotation is left alone. */
const POP: Keyframe[] = [
  {
    scale: "1.1",
    filter: "drop-shadow(0 0 14px color-mix(in oklch, var(--color-accent) 70%, transparent))",
  },
  { scale: "1", filter: "drop-shadow(0 0 0 transparent)" },
];

/** Play the landing on every card in `root` that is new in `view`. */
export function useLanding(root: RefObject<HTMLElement | null>, view: GoldfishView | null): void {
  const ids = useMemo(
    () => (view === null || view.stage !== "playing" ? null : idsOf(view)),
    [view],
  );
  useLandingOf(root, ids);
}

/**
 * {@link useLanding} over the ids a board can see, however it gathers them — the playtest
 * board's are both seats'. `null` while there is no table to land on (a deal, an opening hand):
 * the next set of ids after it is a deal, not a landing.
 */
export function useLandingOf(
  root: RefObject<HTMLElement | null>,
  ids: ReadonlySet<number> | null,
): void {
  const reduced = useReducedMotion() ?? false;
  const seen = useRef<ReadonlySet<number> | null>(null);
  useEffect(() => {
    if (ids === null) {
      seen.current = null;
      return;
    }
    const now = ids;
    const fresh = freshIds(seen.current, now);
    seen.current = now;
    const el = root.current;
    if (reduced || el === null) return;
    for (const id of fresh) {
      const card = el.querySelector(`[data-land~="${id}"]`);
      // jsdom has no Web Animations; neither does a reader's browser need one to play.
      if (card === null || typeof card.animate !== "function") continue;
      card.animate(POP, { duration: DURATION.slow * 2, easing: cssEase(EASE.enter) });
    }
  }, [root, ids, reduced]);
}
