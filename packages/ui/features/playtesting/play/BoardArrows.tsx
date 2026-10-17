import { useEffect, useId, useState, type JSX, type RefObject } from "react";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { arrowPath, measureAnchor, type ArrowPath, type ArrowSpec } from "./arrows";

/**
 * The board's arrows, over both tables: each attacker to the plate of the player it attacks,
 * each blocker to the attacker it blocks, and each spell or ability on the stack to what it
 * targets (issue #1071) — dotted, so a target is never read as an attack.
 *
 * **Measured from the DOM, after the cards are drawn** (`measureAnchor`): the tables lay their
 * cards out by the rules and size them to the box, so where a card is is only known once it is
 * there. Measured on every change of `arrows` (each view, each pick), again once the attack pose's
 * 150 ms slide has settled, and whenever the board is resized.
 *
 * `LAYER.raised` and pointer-free: above the tables' cards, below every menu and dialog, and never
 * between the pointer and a card.
 */
export function BoardArrows({
  root,
  arrows,
}: {
  root: RefObject<HTMLElement | null>;
  arrows: readonly ArrowSpec[];
}): JSX.Element | null {
  const [paths, setPaths] = useState<{ spec: ArrowSpec; path: ArrowPath }[]>([]);
  const id = useId();

  // A passive effect, not a layout one: the board's own `ref` is attached after its children's
  // layout effects run, so on the first commit a layout effect here finds no board to measure.
  useEffect(() => {
    const el = root.current;
    if (el === null) return;
    const measure = () => {
      const next: { spec: ArrowSpec; path: ArrowPath }[] = [];
      for (const spec of arrows) {
        const from = measureAnchor(el, spec.from);
        const to = measureAnchor(el, spec.to);
        if (from !== null && to !== null) next.push({ spec, path: arrowPath(from, to) });
      }
      setPaths((was) =>
        was.length === next.length && was.every((w, i) => w.path.d === next[i].path.d) ? was : next,
      );
    };
    measure();
    const frame = window.requestAnimationFrame(measure);
    const settled = window.setTimeout(measure, 220);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settled);
      observer.disconnect();
    };
  }, [root, arrows]);

  if (paths.length === 0) return null;
  const marker = (tone: ArrowSpec["tone"]) => `${id}-${tone}`.replace(/:/g, "");
  return (
    <svg
      aria-hidden="true"
      data-testid="board-arrows"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", LAYER.raised)}
    >
      <defs>
        {TONES.map((tone) => (
          <marker
            key={tone}
            id={marker(tone)}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className={TONE_FILL[tone]} />
          </marker>
        ))}
      </defs>
      {paths.map(({ spec, path }) => (
        <path
          key={spec.key}
          d={path.d}
          data-arrow={spec.key}
          fill="none"
          strokeWidth={TONE_WIDTH[spec.tone]}
          strokeLinecap="round"
          strokeDasharray={TONE_DASH[spec.tone]}
          markerEnd={`url(#${marker(spec.tone)})`}
          className={cn(TONE_STROKE[spec.tone], "opacity-90")}
        />
      ))}
    </svg>
  );
}

const TONES = ["you", "opponent", "block", "targetYou", "targetOpponent"] as const;

/** The reader's attacks in their gold, the opponent's in red, a block in the blockers' blue; a
 *  target in its spell's controller's colour, as the stack card's edge. */
const TONE_STROKE: Record<ArrowSpec["tone"], string> = {
  you: "stroke-accent",
  opponent: "stroke-mana-r",
  block: "stroke-mana-u",
  targetYou: "stroke-accent",
  targetOpponent: "stroke-mana-r",
};
const TONE_FILL: Record<ArrowSpec["tone"], string> = {
  you: "fill-accent",
  opponent: "fill-mana-r",
  block: "fill-mana-u",
  targetYou: "fill-accent",
  targetOpponent: "fill-mana-r",
};
/** An attack solid, a block dashed, a target dotted and thinner. */
const TONE_WIDTH: Record<ArrowSpec["tone"], number> = {
  you: 3.5,
  opponent: 3.5,
  block: 3,
  targetYou: 2.5,
  targetOpponent: 2.5,
};
const TONE_DASH: Record<ArrowSpec["tone"], string | undefined> = {
  you: undefined,
  opponent: undefined,
  block: "7 5",
  targetYou: "1 6",
  targetOpponent: "1 6",
};
