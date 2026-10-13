import { useEffect, useRef, type JSX, type MouseEvent, type RefObject } from "react";
import type { GameCard, GoldfishAction, GoldfishPlace, GoldfishView } from "@/lib/ipc";
import { GrimoireMark } from "@/components/GrimoireMark";
import { ManaText } from "@/components/ManaText";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace, pointerAt } from "./Inspect";
import { goldfishDraggable, useGoldfishDropTarget, type GoldfishDrag } from "./goldfishDrag";
import { ZONE_H, ZONE_W, type ZoneSize } from "./layout";
import { cardMenu, libraryMenu } from "./menus";
import type { Pointed, ZoneLook } from "./types";

/**
 * The four zones beside the table — command and exile on the left, graveyard and library on the
 * right — each one a 180 × 252 slot (the artboard's 104 × 146, grown) with its count under it.
 *
 * **Every zone is a drop target drawn over nothing but the board**, and `overlay` all the same:
 * the columns sit beside the table's box, and a card carried out of the table toward them is
 * still mostly over it, so without the priority the table would win the drop by shape.
 *
 * With no `view` (a game being dealt) each zone draws its empty slot and offers nothing.
 *
 * **What they read is narrowed to the zones they draw** (`ZoneView`), so the playtest board hands
 * them the reader's seat as it is. `size` is the card's box there — the playtest board's two
 * tables share the window's height — and absent, the goldfish's 180 × 252 is drawn exactly as it
 * always was (the classes, no inline size).
 */

type Drop = (drag: GoldfishDrag, to: GoldfishPlace) => void;

/** What the zone columns read of a game: a goldfish view, or one seat of a playtest's. */
export type ZoneView = Pick<
  GoldfishView,
  "command" | "battlefield" | "graveyard" | "exile" | "library" | "libraryCards"
>;

/** The inline box for a zone card of `size`, or nothing for the goldfish's own (its classes). */
function boxOf(size: ZoneSize | undefined): { width: number; height: number } | undefined {
  return size === undefined ? undefined : { width: size.width, height: size.height };
}

/** How far down each further commander is drawn, so the one under it still shows its name. */
const PARTNER_STEP = 42;

/** The empty zone: a dashed slot naming itself, its edge gold while a card is over it. */
function EmptySlot({
  label,
  over,
  size,
}: {
  label: string;
  over: boolean;
  size?: ZoneSize;
}): JSX.Element {
  return (
    <div
      style={boxOf(size)}
      className={cn(
        "flex h-[252px] w-[180px] items-center justify-center rounded-lg border border-dashed bg-bg/60 text-[11px] text-dim",
        "transition-[border-color] duration-150 motion-reduce:transition-none",
        over ? "border-accent" : "border-border",
      )}
    >
      <span>{label}</span>
    </div>
  );
}

/** A filled zone lights its card's outline rather than an edge it no longer shows. */
const OVER_OUTLINE = "outline-2 outline-offset-3 outline-accent outline-dashed";

const ZONE_LABEL = "font-mono text-xs text-dim";

/** A card in a zone, carried off by a press: one id, from `from`. */
function useZoneDraggable(
  ref: RefObject<HTMLElement | null>,
  card: GameCard | null,
  from: GoldfishPlace,
): void {
  const id = card?.id ?? null;
  const name = card?.name ?? "";
  useEffect(() => {
    const element = ref.current;
    if (!element || id === null) return;
    return goldfishDraggable({ element, payload: () => ({ ids: [id], from, name }) });
  }, [ref, id, name, from]);
}

export interface CommandZoneProps {
  view: ZoneView | null;
  onAct: (action: GoldfishAction) => void;
  onDrop: Drop;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  size?: ZoneSize;
}

/**
 * The command zone, with the tax the next cast will cost. **The tax is shown while the commander
 * is on the battlefield too** — it is the number the reader wants before it dies, not only once
 * it is back.
 */
export function CommandZone({
  view,
  onAct,
  onDrop,
  onPoint,
  onUnpoint,
  size,
}: CommandZoneProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const over = useGoldfishDropTarget({ ref, place: "command", onDrop, overlay: true });
  const commanders = view?.command ?? [];
  const tax = commanders[0]?.tax ?? view?.battlefield.find((c) => c.isCommander)?.tax ?? 0;

  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      {commanders.length === 0 ? (
        <EmptySlot label="Command" over={over} size={size} />
      ) : (
        <div
          className={cn("relative w-[180px] rounded-lg", over && OVER_OUTLINE)}
          style={{
            ...(size === undefined ? {} : { width: size.width }),
            height: (size?.height ?? ZONE_H) + (commanders.length - 1) * PARTNER_STEP,
          }}
        >
          {commanders.map((card, i) => (
            <CommanderCard
              key={card.id}
              card={card}
              top={i * PARTNER_STEP}
              size={size}
              onAct={onAct}
              onPoint={onPoint}
              onUnpoint={onUnpoint}
            />
          ))}
        </div>
      )}
      <span className="flex items-center gap-1 text-xs text-dim">
        Command · tax <ManaText source={`{${tax}}`} />
      </span>
    </div>
  );
}

function CommanderCard({
  card,
  top,
  size,
  onAct,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  top: number;
  size?: ZoneSize;
  onAct: (action: GoldfishAction) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const { menu, menuKey } = useContextMenu();
  useZoneDraggable(ref, card, "command");
  const cast = () => onAct({ type: "play", id: card.id });
  const build = () => cardMenu({ card, ids: [card.id], place: "command", onAct });
  const openMenu = menu(build);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${card.name} in the command zone. Double-click or drag to cast`}
      onDoubleClick={cast}
      // Enter or Space on the focused card casts it too — the keyboard has no double-click.
      onClick={(e) => {
        if (e.detail === 0) cast();
      }}
      onContextMenu={(e) => {
        onUnpoint();
        openMenu(e);
      }}
      onKeyDown={menuKey(build)}
      onMouseEnter={(e) =>
        onPoint({
          card,
          ids: [card.id],
          place: "command",
          line: `${card.name} · in the command zone`,
          at: pointerAt(e),
        })
      }
      onMouseLeave={onUnpoint}
      data-point={card.id}
      data-land={card.id}
      className={cn("absolute left-0 h-[252px] w-[180px] cursor-grab rounded-md p-0", FOCUS)}
      style={{ top, ...boxOf(size) }}
    >
      <CardFace card={card} />
    </button>
  );
}

export interface PileZoneProps {
  view: ZoneView | null;
  onDrop: Drop;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  onLook: (look: ZoneLook) => void;
  size?: ZoneSize;
}

/** Exile, face up, its last card on top. */
export function ExileZone(props: PileZoneProps): JSX.Element {
  return <FaceUpZone {...props} zone="exile" title="Exile" where="exile" />;
}

/** The graveyard, face up, its last card on top; it hangs from the board's right edge. */
export function GraveyardZone(props: PileZoneProps): JSX.Element {
  return (
    <FaceUpZone
      {...props}
      zone="graveyard"
      title="Graveyard"
      where="the graveyard"
      className="items-end"
    />
  );
}

/**
 * A face-up zone: its top card, which can be carried off, and every card in it a right-click
 * away (`ZoneLook`'s browse). A plain click browses too, so the zone has a keyboard way in.
 */
function FaceUpZone({
  view,
  onDrop,
  onPoint,
  onUnpoint,
  onLook,
  zone,
  title,
  where,
  className,
  size,
}: PileZoneProps & {
  zone: "graveyard" | "exile";
  title: string;
  /** "the graveyard", "exile" — the zone as a sentence names it. */
  where: string;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const over = useGoldfishDropTarget({ ref, place: zone, onDrop, overlay: true });
  const cards = view?.[zone] ?? [];
  const top = cards.length > 0 ? cards[cards.length - 1] : null;
  useZoneDraggable(cardRef, top, zone);
  const browse = (e?: MouseEvent) => {
    e?.preventDefault();
    onUnpoint();
    onLook({ zone, mode: "browse", count: "all" });
  };

  return (
    <div ref={ref} className={cn("flex flex-col gap-1.5", className)}>
      {top === null ? (
        <EmptySlot label={title} over={over} size={size} />
      ) : (
        <button
          ref={cardRef}
          type="button"
          aria-label={`${title}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}; ${top.name} on top. Click to look through it`}
          onClick={() => browse()}
          onContextMenu={browse}
          onMouseEnter={(e) =>
            onPoint({
              card: top,
              ids: [top.id],
              place: zone,
              line: `Top of ${where} · ${cards.length} ${cards.length === 1 ? "card" : "cards"}`,
              at: pointerAt(e),
            })
          }
          onMouseLeave={onUnpoint}
          data-point={top.id}
          data-land={top.id}
          style={boxOf(size)}
          className={cn(
            "relative h-[252px] w-[180px] cursor-grab rounded-lg p-0",
            FOCUS,
            over && OVER_OUTLINE,
          )}
        >
          <CardFace card={top} />
        </button>
      )}
      <span className={ZONE_LABEL}>
        {title} · {cards.length}
      </span>
    </div>
  );
}

export interface LibraryZoneProps {
  view: ZoneView | null;
  onAct: (action: GoldfishAction) => void;
  onDrop: Drop;
  onLook: (look: ZoneLook) => void;
  size?: ZoneSize;
}

/**
 * The library, face down: a click draws, a right-click opens everything else it can do
 * (`libraryMenu`), and a card let go over it goes on top.
 */
export function LibraryZone({ view, onAct, onDrop, onLook, size }: LibraryZoneProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const over = useGoldfishDropTarget({ ref, place: "libraryTop", onDrop, overlay: true });
  const { menu, menuKey } = useContextMenu();
  const count = view?.library ?? 0;
  const build = () => (view === null ? [] : libraryMenu({ view, onAct, onLook }));

  return (
    <div ref={ref} className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        disabled={view === null}
        data-land={libraryEnds(view)}
        aria-label={`Library, ${count} ${count === 1 ? "card" : "cards"}. Click to draw; right-click for more`}
        onClick={() => onAct({ type: "draw", count: 1 })}
        onContextMenu={menu(build)}
        onKeyDown={menuKey(build)}
        style={boxOf(size)}
        className={cn(
          "flex h-[252px] w-[180px] cursor-pointer items-center justify-center rounded-lg border bg-surface text-accent disabled:cursor-default",
          // The edges of the cards under the top one, two of them, the way a deck sits.
          "shadow-[2px_2px_0_var(--color-bg),3px_3px_0_var(--color-border),5px_5px_0_var(--color-bg),6px_6px_0_var(--color-border)]",
          over ? "border-accent" : "border-border",
          PRESS,
          FOCUS,
        )}
      >
        <GrimoireMark size={markSize(size)} className="text-accent" />
      </button>
      <span className={ZONE_LABEL}>Library · {count}</span>
    </div>
  );
}

/**
 * The library's cards a landing can show on (`useLanding`): its top and its bottom, the two ends
 * a card is put on.
 */
function libraryEnds(view: ZoneView | null): string | undefined {
  const cards = view?.libraryCards ?? [];
  if (cards.length === 0) return undefined;
  return `${cards[0].id} ${cards[cards.length - 1].id}`;
}

/** The library back's mark: the goldfish's 72 px on its 180 px card, in proportion on another. */
export function markSize(size: ZoneSize | undefined): number {
  return Math.round((72 * (size?.width ?? ZONE_W)) / ZONE_W);
}
