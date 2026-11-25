import type { JSX, MouseEvent } from "react";
import type { GameCard, PlaytestSeat } from "@/lib/ipc";
import { CountTag } from "@/components/CountTag";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { CardFace, pointerAt } from "../table/Inspect";
import type { ZoneSize } from "../table/layout";
import type { Pointed, ZoneLook } from "../table/types";
import { CASTABLE_RING, CardBack, isHidden, markSize } from "../table/ZonePile";

/**
 * The opponent's side of the zone columns and their hand — the reader's own turned 180°: library
 * and graveyard on the left, exile and the command zone on the right, the hand face down along
 * the top edge.
 *
 * **Looked at, never dragged.** Their cards are the rules' and the AI's to move, so nothing here
 * is a drag source or a drop target: a face-up card can be pointed at (the preview) and a face-up
 * zone opened to look through — a click or a right-click, as the reader's own. The sandbox reaches
 * their graveyard's and exile's cards through that look (`LibraryDialog`, the same places as the
 * reader's own, issue #1521) and their battlefield's through `Battlefield`'s menu. What the reader
 * may not see is not on the wire (`ipc/playtest.ts`): their hand and library are counts, drawn as
 * backs — but for the cards of them the reader may see, drawn face up and pointed at like any
 * other: the top of their library while it is revealed (`libraryTop`, Courser of Kruphix,
 * CR 401.5) and the cards of their hand revealed or known (`hand`, Telepathy, Thoughtseize). A
 * face-down card in their exile the reader may not look at (`isHidden`, CR 708) is a back too.
 *
 * **Compact, always**: each zone's count is a `CountTag` on its card rather than a line under it,
 * so a column is the card's width and no more.
 *
 * **Whose, by `owner`**: a duel's one opponent is "the opponent's", and at a four-player table
 * each piece names its player ("Opponent 2's library"). `owner` is the possessive as it reads
 * inside a sentence; a label that starts with it capitalises it.
 */

/** "the opponent's" → "The opponent's"; "Opponent 2's" stays as it is. */
function capital(owner: string): string {
  return owner.charAt(0).toUpperCase() + owner.slice(1);
}

/** A duel's owner, and every piece's when none is given. */
const THE_OPPONENTS = "the opponent's";

/** A zone's count on its card. */
function Count({ count, title }: { count: number; title: string }): JSX.Element {
  return (
    <CountTag
      count={count}
      title={title}
      className="pointer-events-none absolute right-1 bottom-1"
    />
  );
}

/** An empty zone: a dashed slot naming itself. */
function Empty({ label, size }: { label: string; size: ZoneSize }): JSX.Element {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border bg-bg/60 text-[10px] text-dim"
      style={{ width: size.width, height: size.height }}
    >
      <span>{label}</span>
    </div>
  );
}

/** A face-down card: the back every library and every hidden hand shows. */
function Back({ size, className }: { size: ZoneSize; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("block flex-none rounded-lg", className)}
      style={{ width: size.width, height: size.height }}
    >
      <CardBack mark={markSize(size)} />
    </span>
  );
}

/**
 * Their library: a back, its edges and its count — or, while its top card is revealed
 * (`libraryTop`), that card face up on it, pointed at for the preview like any other.
 */
export function OpponentLibrary({
  seat,
  size,
  owner = THE_OPPONENTS,
  onPoint,
  onUnpoint,
}: {
  seat: PlaytestSeat | null;
  size: ZoneSize;
  owner?: string;
  onPoint?: (pointed: Pointed) => void;
  onUnpoint?: () => void;
}): JSX.Element {
  const count = seat?.library ?? 0;
  const top = seat?.libraryTop ?? null;
  const seen = seat?.libraryTopRevealed === false ? "which only you see" : "revealed";
  const n = `${count} ${count === 1 ? "card" : "cards"}`;
  return (
    <div
      role="img"
      aria-label={`${capital(owner)} library, ${n}${top === null ? "" : `; ${top.name} on top, ${seen}`}`}
      className="relative"
      data-point={top?.id}
      onMouseEnter={(e) => {
        if (top === null) return;
        onPoint?.({
          card: top,
          ids: [top.id],
          place: "libraryTop",
          line: `${top.name} · on top of ${owner} library`,
          at: pointerAt(e),
        });
      }}
      onMouseLeave={() => onUnpoint?.()}
    >
      {top === null ? (
        <Back size={size} className={LIBRARY_EDGES} />
      ) : (
        <span
          className={cn("block rounded-lg", LIBRARY_EDGES)}
          style={{ width: size.width, height: size.height }}
        >
          <CardFace card={top} />
        </span>
      )}
      <Count count={count} title={`${n} in their library`} />
    </div>
  );
}

/** The edges of the cards under a library's top one, two of them, the way a deck sits. */
const LIBRARY_EDGES =
  "shadow-[2px_2px_0_var(--color-bg),3px_3px_0_var(--color-border),5px_5px_0_var(--color-bg),6px_6px_0_var(--color-border)]";

/**
 * Their graveyard or exile, face up, its last card on top; a click or a right-click opens it to
 * look through — with the sandbox's moves working, to move its cards too (the board's
 * `LibraryDialog`).
 */
export function OpponentPile({
  seat,
  zone,
  size,
  onPoint,
  onUnpoint,
  onLook,
  owner = THE_OPPONENTS,
  className,
}: {
  seat: PlaytestSeat | null;
  zone: "graveyard" | "exile";
  size: ZoneSize;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  onLook: (look: ZoneLook) => void;
  owner?: string;
  className?: string;
}): JSX.Element {
  const cards = seat?.[zone] ?? [];
  const top = cards.length > 0 ? cards[cards.length - 1] : null;
  const hidden = top !== null && isHidden(top);
  const title = zone === "graveyard" ? "Graveyard" : "Exile";
  const where = zone === "graveyard" ? "their graveyard" : "their exile";
  const n = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  const browse = (e: MouseEvent) => {
    e.preventDefault();
    onUnpoint();
    onLook({ zone, mode: "browse", count: "all" });
  };
  return (
    <div className={cn("flex flex-col", className)}>
      {top === null ? (
        <Empty label={title} size={size} />
      ) : (
        <button
          type="button"
          aria-label={`${capital(owner)} ${title.toLowerCase()}, ${n}; ${hidden ? "a face-down card" : top.name} on top. Click to look through it`}
          onClick={browse}
          onContextMenu={browse}
          onMouseEnter={(e) => {
            if (hidden) return;
            onPoint({
              card: top,
              ids: [top.id],
              place: zone,
              line: `Top of ${where} · ${n}`,
              at: pointerAt(e),
            });
          }}
          onMouseLeave={onUnpoint}
          data-point={hidden ? undefined : top.id}
          data-land={top.id}
          className={cn(
            "relative cursor-pointer rounded-lg p-0",
            FOCUS,
            !hidden && (top.castable || top.canActivate) && CASTABLE_RING,
          )}
          style={{ width: size.width, height: size.height }}
        >
          {hidden ? <CardBack mark={markSize(size)} /> : <CardFace card={top} />}
          <Count count={cards.length} title={`${n} in ${where}`} />
        </button>
      )}
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
  owner = THE_OPPONENTS,
  className,
}: {
  seat: PlaytestSeat | null;
  size: ZoneSize;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  owner?: string;
  className?: string;
}): JSX.Element {
  const commanders = seat?.command ?? [];
  return (
    <div className={cn("flex flex-col", className)}>
      {commanders.length === 0 ? (
        <Empty label="Command" size={size} />
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
              owner={owner}
              onPoint={onPoint}
              onUnpoint={onUnpoint}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CommanderBack({
  card,
  top,
  size,
  owner,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  top: number;
  size: ZoneSize;
  owner: string;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
}): JSX.Element {
  return (
    <span
      role="img"
      aria-label={`${card.name}, ${owner} commander`}
      onMouseEnter={(e) =>
        onPoint({
          card,
          ids: [card.id],
          place: "command",
          line: `${card.name} · ${owner} commander`,
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
const HAND_BACK: ZoneSize = { width: 40, height: 56 };
/** How much of each back shows below the board's top edge. */
export const HAND_BACK_PEEK = 28;
/** The step between two backs: side by side up to seven, then closer. */
function backStep(count: number): number {
  const side = HAND_BACK.width + 5;
  return count <= 7 ? side : Math.max(12, Math.floor((6 * side) / (count - 1)));
}

/** The width the opponent's hand takes along the top edge. */
export function opponentHandWidth(count: number): number {
  return count === 0 ? 0 : HAND_BACK.width + (count - 1) * backStep(count);
}

/**
 * The opponent's hand: as many cards as they hold, hanging from the board's top edge the way the
 * reader's own hand rises from its foot, and the count beside them.
 *
 * **The cards of it the reader may see are face up** (`cards`, the seat's `hand`: revealed by
 * Telepathy, or known since a Thoughtseize looked at them), first, each pointed at for the
 * preview; the rest of `count` are backs. Their names are in the hand's own name too, since a
 * hanging card shows only its foot.
 *
 * **`size` makes it one zone among the others**: a single back of that size with the count on
 * it, the way their library is drawn — a four-player table's opponent area has no edge of its
 * own to hang a hand from. The known cards are named on it, not drawn.
 */
export function OpponentHand({
  count,
  cards = NO_CARDS,
  owner = THE_OPPONENTS,
  size,
  onPoint,
  onUnpoint,
}: {
  /** All the cards in their hand, the known ones among them. */
  count: number;
  /** The cards of their hand the reader may see (`PlaytestSeat.hand`). */
  cards?: readonly GameCard[];
  owner?: string;
  size?: ZoneSize;
  onPoint?: (pointed: Pointed) => void;
  onUnpoint?: () => void;
}): JSX.Element {
  const known = cards.slice(0, count);
  const label = [
    `${capital(owner)} hand, ${count} ${count === 1 ? "card" : "cards"}`,
    known.length === 0 ? "" : `; known: ${known.map((c) => c.name).join(", ")}`,
  ].join("");
  if (size !== undefined) {
    return (
      <div role="img" aria-label={label} className="relative">
        <Back size={size} />
        <Count count={count} title={`${count} ${count === 1 ? "card" : "cards"} in their hand`} />
      </div>
    );
  }
  const step = backStep(count);
  return (
    <div role="img" aria-label={label} className="flex items-start gap-2">
      <div
        className="relative overflow-hidden"
        style={{ width: opponentHandWidth(count), height: HAND_BACK_PEEK }}
      >
        {/* Hung from the top edge: only the bottom of each card shows. The known ones first. */}
        {known.map((card, i) => (
          <span
            key={card.id}
            data-point={card.id}
            onMouseEnter={(e) =>
              onPoint?.({
                card,
                ids: [card.id],
                place: "hand",
                line: `${card.name} · in ${owner} hand`,
                at: pointerAt(e),
              })
            }
            onMouseLeave={() => onUnpoint?.()}
            className="absolute rounded-md"
            style={{
              left: i * step,
              top: HAND_BACK_PEEK - HAND_BACK.height,
              width: HAND_BACK.width,
              height: HAND_BACK.height,
            }}
          >
            <CardFace card={card} />
          </span>
        ))}
        {Array.from({ length: count - known.length }, (_, i) => (
          <span
            key={`back-${i}`}
            className="absolute"
            style={{ left: (known.length + i) * step, top: HAND_BACK_PEEK - HAND_BACK.height }}
          >
            <Back size={HAND_BACK} />
          </span>
        ))}
      </div>
      <span className="pt-1.5 font-mono text-xs text-dim">Hand · {count}</span>
    </div>
  );
}

const NO_CARDS: readonly GameCard[] = [];
