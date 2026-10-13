import type { JSX } from "react";
import type { GameCard, PlaytestSeat } from "@/lib/ipc";
import { GrimoireMark } from "@/components/GrimoireMark";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { CardFace, pointerAt } from "../goldfish/Inspect";
import type { ZoneSize } from "../goldfish/layout";
import type { Pointed, ZoneLook } from "../goldfish/types";
import { markSize } from "../goldfish/ZonePile";

/**
 * The opponent's side of the zone columns and their hand — the reader's own turned 180°: library
 * and graveyard on the left, exile and the command zone on the right, the hand face down along
 * the top edge.
 *
 * **Looked at, never handled.** Their cards are the rules' and the AI's to move, so nothing here
 * is a drag source or a drop target and nothing has a menu: a face-up card can be pointed at (the
 * preview) and a face-up zone opened to look through, and that is all. What the reader may not
 * see is not on the wire (`ipc/playtest.ts`): their hand and library are counts, drawn as backs.
 */

const LABEL = "font-mono text-xs text-dim";

/** A face-down card: the back every library and every hidden hand shows. */
function Back({ size, className }: { size: ZoneSize; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex flex-none items-center justify-center rounded-lg border border-border bg-surface text-accent",
        className,
      )}
      style={{ width: size.width, height: size.height }}
    >
      <GrimoireMark size={markSize(size)} className="text-accent" />
    </span>
  );
}

/** Their library: a back, its edges and its count. */
export function OpponentLibrary({
  seat,
  size,
}: {
  seat: PlaytestSeat | null;
  size: ZoneSize;
}): JSX.Element {
  const count = seat?.library ?? 0;
  return (
    <div
      role="img"
      aria-label={`The opponent's library, ${count} ${count === 1 ? "card" : "cards"}`}
      className="flex flex-col gap-1.5"
    >
      <Back
        size={size}
        className="shadow-[2px_2px_0_var(--color-bg),3px_3px_0_var(--color-border),5px_5px_0_var(--color-bg),6px_6px_0_var(--color-border)]"
      />
      <span className={LABEL}>Library · {count}</span>
    </div>
  );
}

/** Their graveyard or exile, face up, its last card on top; a click opens it to look through. */
export function OpponentPile({
  seat,
  zone,
  size,
  onPoint,
  onUnpoint,
  onLook,
  className,
}: {
  seat: PlaytestSeat | null;
  zone: "graveyard" | "exile";
  size: ZoneSize;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  onLook: (look: ZoneLook) => void;
  className?: string;
}): JSX.Element {
  const cards = seat?.[zone] ?? [];
  const top = cards.length > 0 ? cards[cards.length - 1] : null;
  const title = zone === "graveyard" ? "Graveyard" : "Exile";
  const where = zone === "graveyard" ? "their graveyard" : "their exile";
  const n = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {top === null ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-border bg-bg/60 text-[11px] text-dim"
          style={{ width: size.width, height: size.height }}
        >
          <span>{title}</span>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`The opponent's ${title.toLowerCase()}, ${n}; ${top.name} on top. Click to look through it`}
          onClick={() => {
            onUnpoint();
            onLook({ zone, mode: "browse", count: "all" });
          }}
          onContextMenu={(e) => e.preventDefault()}
          onMouseEnter={(e) =>
            onPoint({
              card: top,
              ids: [top.id],
              place: zone,
              line: `Top of ${where} · ${n}`,
              at: pointerAt(e),
            })
          }
          onMouseLeave={onUnpoint}
          data-point={top.id}
          data-land={top.id}
          className={cn("relative cursor-pointer rounded-lg p-0", FOCUS)}
          style={{ width: size.width, height: size.height }}
        >
          <CardFace card={top} />
        </button>
      )}
      <span className={LABEL}>
        {title} · {cards.length}
      </span>
    </div>
  );
}

/** How far down each further commander is drawn, so the one under it still shows its name. */
const PARTNER_STEP = 22;

/** Their commanders while they are in the command zone. */
export function OpponentCommand({
  seat,
  size,
  onPoint,
  onUnpoint,
  className,
}: {
  seat: PlaytestSeat | null;
  size: ZoneSize;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element {
  const commanders = seat?.command ?? [];
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {commanders.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-border bg-bg/60 text-[11px] text-dim"
          style={{ width: size.width, height: size.height }}
        >
          <span>Command</span>
        </div>
      ) : (
        <div
          className="relative"
          style={{
            width: size.width,
            height: size.height + (commanders.length - 1) * PARTNER_STEP,
          }}
        >
          {commanders.map((card, i) => (
            <CommanderBack
              key={card.id}
              card={card}
              top={i * PARTNER_STEP}
              size={size}
              onPoint={onPoint}
              onUnpoint={onUnpoint}
            />
          ))}
        </div>
      )}
      <span className={LABEL}>Command</span>
    </div>
  );
}

function CommanderBack({
  card,
  top,
  size,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  top: number;
  size: ZoneSize;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
}): JSX.Element {
  return (
    <span
      role="img"
      aria-label={`${card.name}, the opponent's commander`}
      onMouseEnter={(e) =>
        onPoint({
          card,
          ids: [card.id],
          place: "command",
          line: `${card.name} · the opponent's commander`,
          at: pointerAt(e),
        })
      }
      onMouseLeave={onUnpoint}
      data-point={card.id}
      data-land={card.id}
      className="absolute left-0 rounded-md"
      style={{ top, width: size.width, height: size.height }}
    >
      <CardFace card={card} />
    </span>
  );
}

/** A face-down card of the hand: narrower than a zone's, since only its bottom shows. */
const HAND_BACK: ZoneSize = { width: 56, height: 78 };
/** How much of each back shows below the board's top edge. */
export const HAND_BACK_PEEK = 40;
/** The step between two backs: side by side up to seven, then closer. */
function backStep(count: number): number {
  return count <= 7 ? HAND_BACK.width + 6 : Math.max(14, Math.floor((7 * 62 - 56) / (count - 1)));
}

/** The width the opponent's hand takes along the top edge. */
export function opponentHandWidth(count: number): number {
  return count === 0 ? 0 : HAND_BACK.width + (count - 1) * backStep(count);
}

/**
 * The opponent's hand: as many backs as they hold, hanging from the board's top edge the way the
 * reader's own hand rises from its foot, and the count beside them.
 */
export function OpponentHand({ count }: { count: number }): JSX.Element {
  const step = backStep(count);
  return (
    <div
      role="img"
      aria-label={`The opponent's hand, ${count} ${count === 1 ? "card" : "cards"}`}
      className="flex items-start gap-2"
    >
      <div
        className="relative overflow-hidden"
        style={{ width: opponentHandWidth(count), height: HAND_BACK_PEEK }}
      >
        {/* Hung from the top edge: only the bottom of each card shows. */}
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className="absolute"
            style={{ left: i * step, top: HAND_BACK_PEEK - HAND_BACK.height }}
          >
            <Back size={HAND_BACK} />
          </span>
        ))}
      </div>
      <span className="pt-2 font-mono text-xs text-dim">Hand · {count}</span>
    </div>
  );
}
