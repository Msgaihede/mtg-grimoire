/**
 * The card the Scanner just filed, laid over the foot of the camera for a couple of seconds each
 * time the tray takes one — so a reader feeding cards under the camera can see what landed without
 * looking away from the mat to the tray.
 *
 * **It renders into the camera box**, which the page makes `relative` and the size of the picture:
 * one `absolute inset-0` layer holding a flash round the box's edge and the card itself, pinned to
 * the bottom. DOM order puts it over the detector's overlay; it needs no `LAYER` rung.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { CircleHelp, RefreshCw } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { plural, verb } from "@/lib/counts";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import type { ScannerTrayChoice, ScannerTrayRow } from "@/lib/ipc";
import { DURATION, EASE, TRANSITION, landed, seconds } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** What kind of landing it was — which is what the card's label line says. */
export type LandedKind = "added" | "again" | "updated" | "pick";

export interface LandedCard {
  /** Changes on every landing — a new row, a bump of the same row, a re-read — and replays the toast. */
  stamp: string;
  kind: LandedKind;
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  finish: Finish;
  /** The row's quantity after the landing — the `×N` an `again` landing shows. */
  quantity: number;
  /** The candidates a `pick` landing is waiting on, best first. */
  choices: readonly ScannerTrayChoice[];
}

/**
 * How long the card stays up after a landing before {@link AddedToast} asks to be put away.
 *
 * Long enough to read a name and a printing at a glance, short enough that the card has gone
 * before a reader working at a steady pace has the next one under the camera. A card that lands
 * sooner simply replaces it and restarts the clock.
 */
export const LANDED_HOLD_MS = 2200;

/**
 * Pure: what the tray's head row says about the landing that just happened.
 *
 * `row` is `addDecision`'s `rows[0]` and the two flags are its own. **A question outranks a fact**:
 * a row still waiting on a pick is `pick` whether it arrived new or as a re-read, because what the
 * reader has to do next is answer it. After that a re-read is `updated`, a second copy is `again`
 * and anything else is `added`.
 *
 * The stamp is the row's key and its `addedAt`, and `addDecision` refreshes `addedAt` on a bump
 * and on a re-read as well as stamping a new row — so every landing, the same row's included,
 * replays the toast.
 */
export function landedFrom(row: ScannerTrayRow, bumped: boolean, replaced: boolean): LandedCard {
  const kind: LandedKind =
    row.choices.length > 0 ? "pick" : replaced ? "updated" : bumped ? "again" : "added";
  return {
    stamp: `${row.key}:${row.addedAt}`,
    kind,
    cardId: row.cardId,
    name: row.name,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    finish: row.finish,
    quantity: row.quantity,
    choices: row.choices,
  };
}

/**
 * The flash round the camera's edge: held for one tier and faded over the next — the tray row's
 * own wash (`TrayPanel`), so the two marks one landing makes go out together.
 */
const EDGE_FADE: Transition = { ...TRANSITION.slow, delay: seconds(DURATION.slow) };

/**
 * The badge's circle pops in a beat after the card starts to rise, overshooting a little before it
 * settles — `times` places the overshoot, it adds no time.
 */
const BADGE_POP: Transition = {
  duration: seconds(DURATION.slow),
  delay: seconds(DURATION.fast),
  ease: EASE.enter,
  times: [0, 0.6, 1],
};

/** The tick draws once there is a circle to draw it on. */
const TICK_DRAW: Transition = {
  duration: seconds(DURATION.slow),
  delay: seconds(DURATION.base),
  ease: EASE.enter,
};

/** The label line's box; each kind adds its own colour. */
const LABEL = "flex items-center gap-1.5 text-[13px] font-medium";

export interface AddedToastProps {
  /** The landing to show, or `null` to put the card away. */
  card: LandedCard | null;
  /** Called {@link LANDED_HOLD_MS} after each landing; the page answers by passing `null`. */
  onDone: () => void;
}

/**
 * **The whole overlay is `aria-hidden`.** The Match strip above the camera is the view's live
 * region and already says what landed; a second live region announcing the same card would have a
 * screen reader read every scan twice. Nothing in here is pressable either — the tray is where a
 * landing is acted on, which is why the layer is `pointer-events-none` throughout.
 *
 * While `card` is set the card is on screen; `onDone` is called {@link LANDED_HOLD_MS} after each
 * landing, and the page answers it by passing `null`, which is what lets the card leave through
 * its exit animation.
 */
export function AddedToast({ card, onDone }: AddedToastProps) {
  // Latched rather than a dependency, so a caller passing a fresh arrow each render does not
  // restart the hold on every render — only a new landing does.
  const done = useRef(onDone);
  useLayoutEffect(() => {
    done.current = onDone;
  });

  const stamp = card?.stamp ?? null;
  useEffect(() => {
    if (stamp === null) return;
    const timer = setTimeout(() => done.current(), LANDED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [stamp]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {card !== null && (
        // Keyed on the stamp, so each landing flashes once. Opacity only: there is no travel for
        // reduced motion to take away.
        <motion.div
          key={card.stamp}
          data-landed-flash=""
          className={cn(
            "absolute inset-0 rounded-lg ring-3 ring-inset",
            card.kind === "pick" ? "ring-accent" : "ring-ok",
          )}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0, transition: EDGE_FADE }}
        />
      )}
      {/* A one-cell grid rather than a centred flex row: a card that lands while the last one is
          still up enters as the old one exits, and in a flex row the two would sit side by side
          for the length of the crossover. In one cell they stack, sharing a bottom edge. */}
      <div className="absolute inset-x-0 bottom-5 grid grid-cols-[minmax(0,1fr)] items-end justify-items-center px-4">
        <AnimatePresence>
          {card !== null && (
            <motion.div
              key={card.stamp}
              {...landed}
              data-landed={card.kind}
              className={cn(
                "col-start-1 row-start-1 flex max-w-full items-center gap-3.5 rounded-lg border bg-surface/95 py-2.5 pr-5 pl-2.5",
                // The design canvas's own shadow: over a live camera picture Tailwind's stock
                // extra-large one, at a tenth of black, lifts the card off nothing.
                "shadow-[0_16px_40px_rgb(0_0_0/0.5)]",
                card.kind === "pick" ? "border-accent/50" : "border-border",
              )}
            >
              <Preview card={card} />
              <div className="flex min-w-0 flex-col gap-[5px]">
                <Label card={card} />
                <span className="max-w-80 truncate font-heading text-[22px] leading-tight">{card.name}</span>
                {card.kind === "pick" ? (
                  <span className="truncate text-xs text-dim">{pickLine(card.choices.length)}</span>
                ) : (
                  <span className="truncate font-mono text-xs text-dim">{printingLine(card)}</span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** `LTR · 426 · Nonfoil` — whichever of the set and the number the row has, then the finish. */
function printingLine(card: LandedCard): string {
  return [card.setCode.toUpperCase(), card.collectorNumber, FINISH_LABEL[card.finish]]
    .filter((part) => part !== "")
    .join(" · ");
}

/** A row waiting on a pick has no printing to name, so the line says where the question is. */
function pickLine(n: number): string {
  return `${plural(n, "printing")} ${verb(n, "matches", "match")} — pick in the tray`;
}

/** What kind of landing it was, in the colour that kind means: `ok` for a card filed, the accent
 *  for one the reader should look at again. */
function Label({ card }: { card: LandedCard }) {
  switch (card.kind) {
    case "added":
      return (
        <span className={cn(LABEL, "text-ok")}>
          <AddedBadge />
          Added to scanned cards
        </span>
      );
    case "again":
      return (
        <span className={cn(LABEL, "text-ok")}>
          <AddedBadge />
          Added again
          <span className="rounded border border-border bg-bg px-1.5 font-mono text-xs text-text">
            ×{card.quantity}
          </span>
        </span>
      );
    case "updated":
      return (
        <span className={cn(LABEL, "text-accent")}>
          <RefreshCw className="size-4.5 shrink-0" />
          Printing updated
        </span>
      );
    case "pick":
      return (
        <span className={cn(LABEL, "text-accent")}>
          <CircleHelp className="size-4.5 shrink-0" />
          Pick a printing
        </span>
      );
  }
}

/**
 * A filled `ok` circle with a dark tick: the circle pops from a third of its size, then the tick is
 * drawn onto it.
 *
 * **The tick needs its own reduced-motion opt-out.** `pathLength` is not a positional key, so
 * `MotionConfig reducedMotion="user"` would still draw it stroke by stroke; under the reader's
 * setting it starts whole. The circle's pop is a `scale`, which that config already reduces to its
 * fade.
 */
function AddedBadge() {
  const reduced = useReducedMotion();
  return (
    <motion.span
      className="inline-flex shrink-0"
      initial={{ scale: 0.3, opacity: 0 }}
      animate={{ scale: [0.3, 1.15, 1], opacity: [0, 1, 1], transition: BADGE_POP }}
    >
      <svg viewBox="0 0 20 20" className="size-5">
        <circle cx="10" cy="10" r="10" className="fill-ok" />
        <motion.path
          d="M5.8 10.4l2.7 2.7 5.7-6"
          fill="none"
          className="stroke-bg"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          // The opacity rides with the draw because a round cap draws a dot at zero length.
          initial={reduced ? false : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1, transition: TICK_DRAW }}
        />
      </svg>
    </motion.span>
  );
}

/**
 * The card's picture, left of the words: one 5:7 slot, or — for a row still waiting on a pick —
 * its first two candidates fanned, so the card reads as *one of these* rather than as a settled
 * printing.
 */
function Preview({ card }: { card: LandedCard }) {
  if (card.kind === "pick" && card.choices.length >= 2) {
    const [first, second] = card.choices;
    return (
      <span className="relative h-[106px] w-[84px] shrink-0">
        <Slot cardId={first.cardId} className="absolute top-1 left-0 w-[68px] -rotate-6" />
        <Slot
          cardId={second.cardId}
          className="absolute top-1 right-0 w-[68px] rotate-5 shadow-[-4px_0_10px_rgb(0_0_0/0.5)]"
        />
      </span>
    );
  }
  return <Slot cardId={card.cardId} className="w-[76px] shrink-0" />;
}

/**
 * One card picture. **The whole card, never the `art` crop** — the tray's reason (`TrayPanel`):
 * the printed frame carries the artist's credit, and nothing else on the Scanner names one.
 * `object-contain`, so no edge of the card is cropped at the slot's. `grid` rather than `thumb`: a
 * 76px slot is 152 device pixels on a display at 200%, which `thumb`'s 146 falls short of.
 */
function Slot({ cardId, className }: { cardId: string; className: string }) {
  return (
    <span
      className={cn("block overflow-hidden rounded-[5px] bg-bg", className)}
      style={{ aspectRatio: CARD_ASPECT }}
    >
      <CardImage
        src={cardImageUrl(cardId, 0, "grid")}
        alt=""
        draggable={false}
        className="size-full object-contain"
      />
    </span>
  );
}
