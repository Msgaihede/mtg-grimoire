import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { CardCounter, GameCard } from "@/lib/ipc";
import { CardImage } from "@/components/CardImage";
import { cardImageUrl, type ImageVariant } from "@/lib/images";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { gapWords } from "../support";
import { effectLine } from "./effects";
import type { Pointed } from "./types";

/** How long the pointer rests on a card before its preview opens. */
export const INSPECT_DELAY = 500;
/** The preview's card width: where it starts, and how far the wheel takes it either way. */
export const INSPECT_WIDTH = 320;
export const INSPECT_MIN = 200;
export const INSPECT_MAX = 640;
/** Each notch of the wheel grows or shrinks the preview by this factor. */
const INSPECT_STEP = 1.1;
/** How far from the pointer the preview opens, and how close it may come to the board's edge. */
const OFFSET = 24;
const EDGE = 8;

/** One wheel notch's new preview width: up grows it, down shrinks it, within the bounds. */
export function wheelWidth(width: number, deltaY: number): number {
  const next = deltaY < 0 ? width * INSPECT_STEP : width / INSPECT_STEP;
  return Math.round(Math.min(INSPECT_MAX, Math.max(INSPECT_MIN, next)));
}

/**
 * Where the preview's corner goes for a pointer at (`x`, `y`) in a `box` of the board's size:
 * below and to the right of it, flipped to the left when it would run off the right edge, and
 * pushed up when it would run off the bottom — always inside the board.
 */
export function placePreview(
  { x, y }: { x: number; y: number },
  size: { width: number; height: number },
  box: { width: number; height: number },
): { left: number; top: number } {
  let left = x + OFFSET;
  if (left + size.width > box.width - EDGE) left = x - OFFSET - size.width;
  left = Math.max(EDGE, Math.min(left, box.width - EDGE - size.width));
  const top = Math.max(EDGE, Math.min(y + OFFSET, box.height - EDGE - size.height));
  return { left, top };
}

/**
 * The card pointed at, large — the artboard's inspect box (`Goldfish · the table, turn 9`).
 *
 * **It follows the pointer, and only once the pointer has rested** ({@link INSPECT_DELAY}): a
 * reader sweeping across the hand to reach a card does not get a preview flashing under every
 * card on the way. It closes the moment the pointer leaves the card, and every card — the next
 * one, or the same one again — has to be rested on anew.
 *
 * **The wheel resizes it while it is open** (`onResize`), and the size is the board's, so it is
 * kept for the next card. It takes no pointer at all: it sits beside the cursor, over table
 * cards, and a preview that caught the pointer would end the hover that opened it.
 *
 * `LAYER.raised`, and drawn after the hand: above the table's cards and a lifted card in hand,
 * below every menu and dialog.
 */
export function Inspect({
  pointed,
  width,
  onResize,
}: {
  pointed: Pointed | null;
  width: number;
  onResize: (next: (width: number) => number) => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  // **One hover, one rest.** `at` is minted when the pointer comes onto a card and kept through
  // every view after it, so it names the hover: the preview is open only for the hover that has
  // rested, and a hover that ended can never be the one a later card is shown for.
  const enteredAt = pointed?.at ?? null;
  const [rested, setRested] = useState<Pointed["at"] | null>(null);
  useEffect(() => {
    if (enteredAt === null) return;
    const timer = window.setTimeout(() => setRested(enteredAt), INSPECT_DELAY);
    return () => window.clearTimeout(timer);
  }, [enteredAt]);

  const visible = pointed !== null && rested === enteredAt;

  // The pointer as the card first saw it, then as it moves — followed from the moment it comes
  // onto the card, so the preview opens where the pointer is. It is placed straight from the
  // event rather than through a render, so it keeps up with the cursor.
  useLayoutEffect(() => {
    if (enteredAt === null) return;
    if (!visible) pointer.current = enteredAt;
    const place = () => {
      const el = ref.current;
      if (el === null) return;
      const parent = el.offsetParent;
      if (!(parent instanceof HTMLElement)) return;
      const box = parent.getBoundingClientRect();
      const at = placePreview(
        { x: pointer.current.x - box.left, y: pointer.current.y - box.top },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: box.width, height: box.height },
      );
      el.style.transform = `translate(${at.left}px, ${at.top}px)`;
    };
    place();
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      place();
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [enteredAt, visible, width, pointed?.card.id]);

  // The wheel resizes the open preview, and only the preview: the table under it does not scroll.
  useEffect(() => {
    if (!visible) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || e.ctrlKey) return;
      e.preventDefault();
      onResize((w) => wheelWidth(w, e.deltaY));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [visible, onResize]);

  if (!visible) return null;
  const { card } = pointed;
  const caption = [
    pointed.line,
    card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null,
    ...card.counters.map(counterLabel),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="card-inspect"
      className={cn(
        "pointer-events-none absolute top-0 left-0 flex flex-col gap-1.5 rounded-[14px] border border-border bg-surface p-2 shadow-lg",
        LAYER.raised,
      )}
      style={{ width: width + 16 }}
    >
      <div style={{ width, height: Math.round(width * 1.4) }}>
        <CardFace card={card} variant="display" className="p-3 text-sm" />
      </div>
      <span className="text-xs text-dim">{caption}</span>
      {card.effects.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-text" data-testid="card-effects">
          {card.effects.map((effect, i) => (
            <li key={i}>{effectLine(effect, card.name)}</li>
          ))}
        </ul>
      )}
      {card.gaps.length > 0 && (
        <span className="text-xs text-accent">
          {PARTLY} — {card.gaps.map(gapWords).join(" · ")}
        </span>
      )}
    </div>
  );
}

/** What a card the engine plays only in part is called under its preview. */
const PARTLY = "Played only in part by the rules engine";

/**
 * One card's face at whatever size its box is: the printing's picture, or — for a token the
 * engine has no printing for — a plain tile with its name and power/toughness, so it is still a
 * card-shaped thing on the table rather than a hole.
 *
 * **A card the engine plays only in part wears a gold border** (`gaps`, issue #1093), wherever
 * it is drawn — the hand, the battlefield, a pile, the preview — so the reader knows before
 * playing it that the board may need setting right by hand. Gold is the setup screen's caution
 * for the same verdict; the border sits inside the card, clear of the table's outline marks
 * (attack, block, pick), which sit outside it.
 *
 * `alt` defaults to empty because every caller but one wraps the face in a control that already
 * names the card; a second name inside it would be read twice.
 */
export function CardFace(props: {
  card: GameCard;
  variant?: ImageVariant;
  alt?: string;
  className?: string;
}): JSX.Element {
  if (props.card.gaps.length === 0) return <Face {...props} />;
  return (
    <span className="relative block h-full w-full" data-partly="">
      <Face {...props} />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-md border-2 border-accent"
      />
    </span>
  );
}

function Face({
  card,
  variant = "grid",
  alt = "",
  className,
}: {
  card: GameCard;
  variant?: ImageVariant;
  alt?: string;
  className?: string;
}): JSX.Element {
  if (card.cardId === null) {
    const pt =
      card.power !== null && card.toughness !== null ? `${card.power}/${card.toughness}` : null;
    return (
      <span
        className={cn(
          "flex h-full w-full flex-col justify-between overflow-hidden rounded-md border border-border bg-surface p-1 text-left text-[10px] leading-tight text-text",
          className,
        )}
      >
        <span className="line-clamp-3 font-semibold break-words">{card.name}</span>
        {pt !== null && <span className="self-end font-mono text-dim">{pt}</span>}
      </span>
    );
  }
  return (
    <CardImage
      src={cardImageUrl(card.cardId, 0, variant)}
      alt={alt}
      className={cn("block h-full w-full rounded-md", className)}
    />
  );
}

/**
 * A counter as the table writes it: `+2/+2` for the counters that change power and toughness
 * (the artboard's badge), `3 loyalty` for every other kind.
 */
export function counterLabel({ kind, count }: CardCounter): string {
  if (kind === "+1/+1") return `+${count}/+${count}`;
  if (kind === "-1/-1") return `-${count}/-${count}`;
  return `${count} ${kind}`;
}

/** Where a pointer event happened, for {@link Pointed.at}. */
export function pointerAt(e: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: e.clientX, y: e.clientY };
}
