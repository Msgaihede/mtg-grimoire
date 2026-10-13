import { useEffect, useRef, useState, type JSX, type RefObject } from "react";
import { useReducedMotion } from "motion/react";
import type { PlaytestHappened, PlaytestView } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { DURATION, EASE, cssEase } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { centre, measureAnchor } from "./arrows";
import { popsFor, type Pop } from "./pops";

/** How long a number stays up while it rises and fades. */
export const POP_MS = DURATION.slow * 4;

/** A pop placed: what it says, and where its centre is on the board. */
interface Placed extends Pop {
  /** Unique across steps, so two steps' pops never share a key. */
  id: string;
  x: number;
  y: number;
}

/**
 * The numbers that pop when damage lands and life moves: "−3" over a creature hit, "−2" or "+4"
 * by a plate (`pops.ts` decides which). `landing.ts`' way of moving, for its reasons — the Web
 * Animations API, so nothing writes a stylesheet (the CSP), and nothing at all under reduced
 * motion.
 *
 * **One set per step** (`happened`'s identity): a new list is a new step, or a new beat of a
 * replay, and it is measured against the board as that view has just drawn it.
 */
export function DamagePops({
  root,
  view,
  happened,
}: {
  root: RefObject<HTMLElement | null>;
  view: PlaytestView | null;
  happened: readonly PlaytestHappened[];
}): JSX.Element | null {
  const reduced = useReducedMotion() ?? false;
  const [live, setLive] = useState<Placed[]>([]);
  const step = useRef(0);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });

  useEffect(() => {
    const el = root.current;
    const now = viewRef.current;
    if (reduced || el === null || now === null || happened.length === 0) return;
    const n = ++step.current;
    const placed = popsFor(happened, now).flatMap((pop): Placed[] => {
      const box = measureAnchor(el, pop.anchor);
      if (box === null) return [];
      const c = centre(box);
      return [{ ...pop, id: `${n}-${pop.key}`, x: c.x, y: c.y }];
    });
    if (placed.length > 0) setLive((was) => [...was, ...placed]);
  }, [root, happened, reduced]);

  if (live.length === 0) return null;
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0", LAYER.raised)}>
      {live.map((pop) => (
        <PopNumber
          key={pop.id}
          pop={pop}
          onDone={() => setLive((was) => was.filter((p) => p.id !== pop.id))}
        />
      ))}
    </div>
  );
}

const TONE: Record<Pop["tone"], string> = {
  damage: "text-mana-r",
  loss: "text-mana-r",
  gain: "text-mana-g",
};

/** Up and away: grown in, risen 34 px, faded. `transform` carries the centring too. */
const RISE: Keyframe[] = [
  { transform: "translate(-50%, -50%) scale(0.6)", opacity: 0 },
  { transform: "translate(-50%, -70%) scale(1.15)", opacity: 1, offset: 0.2 },
  { transform: "translate(-50%, -90%) scale(1)", opacity: 1, offset: 0.65 },
  { transform: "translate(-50%, calc(-50% - 34px)) scale(1)", opacity: 0 },
];

function PopNumber({ pop, onDone }: { pop: Placed; onDone: () => void }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const el = ref.current;
    // jsdom has no Web Animations; the number still goes once its time is up.
    if (el === null || typeof el.animate !== "function") {
      const t = window.setTimeout(() => done.current(), POP_MS);
      return () => window.clearTimeout(t);
    }
    const animation = el.animate(RISE, {
      duration: POP_MS,
      easing: cssEase(EASE.enter),
      fill: "forwards",
    });
    animation.onfinish = () => done.current();
    return () => animation.cancel();
  }, []);
  return (
    <span
      ref={ref}
      data-pop={pop.tone}
      className={cn(
        "absolute font-mono text-[26px] font-bold tabular-nums",
        "[text-shadow:0_2px_6px_rgb(0_0_0/0.8)]",
        TONE[pop.tone],
      )}
      style={{ left: pop.x, top: pop.y, transform: "translate(-50%, -50%)" }}
    >
      {pop.text}
    </span>
  );
}
