import type { JSX } from "react";
import type { CardCounter, GameCard } from "@/lib/ipc";
import { CardImage } from "@/components/CardImage";
import { cardImageUrl, type ImageVariant } from "@/lib/images";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import type { Pointed } from "./types";

/**
 * The card pointed at, large — the artboard's inspect box (`Goldfish · the table, turn 9`).
 *
 * **It opens over the half of the board the pointer is not on** (`Pointed.side`), so it never
 * covers the card it is showing, and it takes no pointer at all: it sits over table cards, and a
 * preview that caught the pointer would end the hover that opened it.
 *
 * `LAYER.raised`: above the table's cards and the hand, below every menu and dialog.
 */
export function Inspect({ pointed }: { pointed: Pointed }): JSX.Element {
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
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-[72px] flex w-[260px] flex-col gap-1.5 rounded-[14px] border border-border bg-surface p-2",
        pointed.side === "left" ? "left-[150px]" : "right-[150px]",
        LAYER.raised,
      )}
    >
      <div className="h-[340px] w-[244px]">
        <CardFace card={card} variant="display" className="p-3 text-sm" />
      </div>
      <span className="text-xs text-dim">{caption}</span>
    </div>
  );
}

/**
 * One card's face at whatever size its box is: the printing's picture, or — for a token the
 * engine has no printing for — a plain tile with its name and power/toughness, so it is still a
 * card-shaped thing on the table rather than a hole.
 *
 * `alt` defaults to empty because every caller but one wraps the face in a control that already
 * names the card; a second name inside it would be read twice.
 */
export function CardFace({
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

/** Which side of the board the preview opens on: the half the pointer is **not** in. */
export function sideOf(clientX: number): "left" | "right" {
  return clientX > window.innerWidth / 2 ? "left" : "right";
}
