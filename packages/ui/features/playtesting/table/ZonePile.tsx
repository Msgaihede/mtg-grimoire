import { useEffect, useRef, type JSX, type MouseEvent, type RefObject } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { GameCard, GamePlace, PlaytestAction, PlaytestSeat } from "@/lib/ipc";
import { GrimoireMark } from "@/components/GrimoireMark";
import { ManaText } from "@/components/ManaText";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CountTag } from "@/components/CountTag";
import { CardFace, pointerAt } from "./Inspect";
import { tableDraggable, useTableDropTarget, type TableDrag } from "./tableDrag";
import { ZONE_H, ZONE_W, type ZoneSize } from "./layout";
import { cardMenu, libraryMenu, rulesPlay } from "./menus";
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
 * **What they read is narrowed to the zones they draw** (`ZoneView`), so the board hands them the
 * reader's seat as it is. `size` is the card's box — the board's two tables share the window's
 * height — and absent, the artboard's 180 × 252 is drawn (the classes, no inline size).
 *
 * **`sandbox` is whether the sandbox's moves work now** (on, the reader playing or
 * declaring, nothing out). Off, the zones keep only what the rules do: the commander is cast (double-click, drag onto
 * the table, its menu's Cast), the graveyard and exile are opened to look through, read-only — and
 * the library is a pile with a count, not drawn from, not looked through and not dropped on, but
 * for a top card the rules let the reader see (`libraryTop`) and play from there.
 *
 * **A card the rules let the reader play where it lies wears {@link CASTABLE_RING}** — the
 * command zone's commander, the top of the library, the graveyard's or exile's top card — as
 * phase's own client rings a playable card, and as the hand does (`HandFan`).
 */

/**
 * The ring a card wears while the rules let the reader cast or play it, or activate one of its
 * abilities, from where it lies ({@link GameCard.castable}, {@link GameCard.canActivate}). A ring
 * (a box shadow), never an outline: an outline is the keyboard's focus and the table's marks
 * (attack, block, pick), and this is a state. Soft gold, so a hand of playable cards does not
 * shout.
 */
export const CASTABLE_RING = "ring-2 ring-accent/70";

/**
 * A card the reader may not look at: face down (CR 708) with its name kept from them — another
 * player's foretold or hideaway card in exile, a card exiled face down by an opponent's effect.
 * Drawn as a back, never pointed at for a preview of nothing. A face-down card the reader may
 * look at (their own, CR 708.5) carries its name and is drawn face up.
 */
export function isHidden(card: GameCard): boolean {
  return card.faceDown && card.name === "";
}

/**
 * A card back filling its box: the library's face, and a hidden card wherever one lies. `mark` is
 * the Grimoire mark's size ({@link markSize} of the box).
 */
export function CardBack({ mark, className }: { mark: number; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-back=""
      className={cn(
        "flex h-full w-full items-center justify-center rounded-lg border border-border bg-surface text-accent",
        className,
      )}
    >
      <GrimoireMark size={mark} className="text-accent" />
    </span>
  );
}

type Drop = (drag: TableDrag, to: GamePlace) => void;

/** What the zone columns read of a game: the reader's seat. */
export type ZoneView = Pick<
  PlaytestSeat,
  | "command"
  | "battlefield"
  | "graveyard"
  | "exile"
  | "library"
  | "libraryCards"
  | "libraryTop"
  | "libraryTopRevealed"
>;

/** The inline box for a zone card of `size`, or nothing for the artboard's own (its classes). */
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
        size?.compact && "text-[10px]",
      )}
    >
      <span>{label}</span>
    </div>
  );
}

/** A compact zone's count, drawn on its card where the artboard writes a label under it. */
function CardCount({ count, title }: { count: number; title: string }): JSX.Element {
  return (
    <CountTag
      count={count}
      title={title}
      className="pointer-events-none absolute right-1 bottom-1"
    />
  );
}

/** A filled zone lights its card's outline rather than an edge it no longer shows. */
const OVER_OUTLINE = "outline-2 outline-offset-3 outline-accent outline-dashed";

const ZONE_LABEL = "font-mono text-xs text-dim";

/** A card in a zone, carried off by a press: one id, from `from` — unless `off`. */
function useZoneDraggable(
  ref: RefObject<HTMLElement | null>,
  card: GameCard | null,
  from: GamePlace,
  off = false,
): void {
  const id = card?.id ?? null;
  const name = card?.name ?? "";
  useEffect(() => {
    const element = ref.current;
    if (!element || id === null || off) return;
    return tableDraggable({ element, payload: () => ({ ids: [id], from, name }) });
  }, [ref, id, name, from, off]);
}

export interface CommandZoneProps {
  view: ZoneView | null;
  sandbox: boolean;
  onAct: (action: PlaytestAction) => void;
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
  sandbox,
  onAct,
  onDrop,
  onPoint,
  onUnpoint,
  size,
}: CommandZoneProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const over = useTableDropTarget({ ref, place: "command", onDrop, sandbox, overlay: true });
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
              sandbox={sandbox}
              onAct={onAct}
              onPoint={onPoint}
              onUnpoint={onUnpoint}
            />
          ))}
        </div>
      )}
      {size?.compact ? (
        tax > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-dim">
            tax <ManaText source={`{${tax}}`} />
          </span>
        )
      ) : (
        <span className="flex items-center gap-1 text-xs text-dim">
          Command · tax <ManaText source={`{${tax}}`} />
        </span>
      )}
    </div>
  );
}

function CommanderCard({
  card,
  top,
  size,
  sandbox,
  onAct,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  top: number;
  size?: ZoneSize;
  sandbox: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const { menu, menuKey } = useContextMenu();
  useZoneDraggable(ref, card, "command");
  // The rules' way with it first: its cast when the rules offer one, else an ability that works
  // from the command zone (commander ninjutsu, CR 702.49d). With neither it is still a `play` —
  // the sandbox's unpaid cast, or the engine's refusal saying why not.
  const cast = () => onAct(rulesPlay(card) ?? { type: "play", id: card.id });
  const build = () => cardMenu({ card, ids: [card.id], place: "command", sandbox, onAct });
  const openMenu = menu(build);
  const word = !card.castable && card.canActivate ? "activate" : "cast";

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${card.name} in the command zone${card.gaps.length > 0 ? ", played only in part" : ""}. Double-click${word === "cast" ? " or drag" : ""} to ${word}`}
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
      className={cn(
        "absolute left-0 h-[252px] w-[180px] cursor-grab rounded-md p-0",
        FOCUS,
        (card.castable || card.canActivate) && CASTABLE_RING,
      )}
      style={{ top, ...boxOf(size) }}
    >
      <CardFace card={card} />
    </button>
  );
}

export interface PileZoneProps {
  view: ZoneView | null;
  sandbox: boolean;
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
 * A face-up zone: its top card, which can be carried off with the sandbox's moves working, and
 * every card in it a right-click away (`ZoneLook`'s browse) — public, so open whatever the
 * sandbox says. A plain click browses too, so the zone has a keyboard way in.
 *
 * **A hidden card is a back** ({@link isHidden}): exile holds face-down cards the reader may not
 * look at, counted with the rest but never named or previewed. A top card the rules let the
 * reader play from here wears {@link CASTABLE_RING}; its Cast is in the look (`LibraryDialog`).
 */
function FaceUpZone({
  view,
  sandbox,
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
  const over = useTableDropTarget({ ref, place: zone, onDrop, sandbox, overlay: true });
  const cards = view?.[zone] ?? [];
  const top = cards.length > 0 ? cards[cards.length - 1] : null;
  const hidden = top !== null && isHidden(top);
  useZoneDraggable(cardRef, top, zone, !sandbox);
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
          aria-label={`${title}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}; ${hidden ? "a face-down card" : top.name} on top. Click to look through it`}
          onClick={() => browse()}
          onContextMenu={browse}
          onMouseEnter={(e) => {
            if (hidden) return;
            onPoint({
              card: top,
              ids: [top.id],
              place: zone,
              line: `Top of ${where} · ${cards.length} ${cards.length === 1 ? "card" : "cards"}`,
              at: pointerAt(e),
            });
          }}
          onMouseLeave={onUnpoint}
          data-point={hidden ? undefined : top.id}
          data-land={top.id}
          style={boxOf(size)}
          className={cn(
            "relative h-[252px] w-[180px] rounded-lg p-0",
            sandbox ? "cursor-grab" : "cursor-pointer",
            FOCUS,
            over && OVER_OUTLINE,
            !hidden && (top.castable || top.canActivate) && CASTABLE_RING,
          )}
        >
          {hidden ? <CardBack mark={markSize(size)} /> : <CardFace card={top} />}
          {size?.compact && (
            <CardCount
              count={cards.length}
              title={`${cards.length} ${cards.length === 1 ? "card" : "cards"} in ${where}`}
            />
          )}
        </button>
      )}
      {!size?.compact && (
        <span className={ZONE_LABEL}>
          {title} · {cards.length}
        </span>
      )}
    </div>
  );
}

export interface LibraryZoneProps {
  view: ZoneView | null;
  sandbox: boolean;
  onAct: (action: PlaytestAction) => void;
  onDrop: Drop;
  onLook: (look: ZoneLook) => void;
  /** The pointer has come onto the top card the reader may see (`libraryTop`). */
  onPoint?: (pointed: Pointed) => void;
  onUnpoint?: () => void;
  size?: ZoneSize;
}

/**
 * The library, face down: a click draws, a right-click opens everything else it can do
 * (`libraryMenu`), and a card let go over it goes on top. Its top card is drawn face up while the
 * reader may see it (`libraryTop`), and pointed at for the preview.
 *
 * **Every one of those is a sandbox move**, so with `sandbox` off it is a pile and a count and
 * nothing more: a disabled button, so it still says what it is, with no draw, no menu and no drop.
 * The rules draw for the reader.
 *
 * **But a top card the reader may see is drawn face up on it** (`libraryTop`, CR 401.5) —
 * revealed to every player (Courser of Kruphix) or the reader's own to look at any time (Future
 * Sight, Bolas's Citadel) — with a chip saying which, and it can be pointed at for the preview,
 * sandbox or not. **One the rules let the reader play from there is the rules' play, sandbox or
 * not** ({@link CASTABLE_RING}): a double-click (Enter on the focused pile) casts it, or plays
 * it, or — when only an ability works from there (plot, CR 702.170) — activates it, and the menu
 * heads with the same rows. While it can, a single click draws nothing, since a double-click is
 * two clicks first; the sandbox's Draw a card is still the menu's.
 */
export function LibraryZone({
  view,
  sandbox,
  onAct,
  onDrop,
  onLook,
  onPoint,
  onUnpoint,
  size,
}: LibraryZoneProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const over = useTableDropTarget({ ref, place: "libraryTop", onDrop, sandbox, overlay: true });
  const { menu, menuKey } = useContextMenu();
  const count = view?.library ?? 0;
  const cards = `${count} ${count === 1 ? "card" : "cards"}`;
  const top = view?.libraryTop ?? null;
  const revealed = view?.libraryTopRevealed ?? false;
  const play = top === null ? null : rulesPlay(top);
  const build = () => (view === null ? [] : libraryMenu({ view, sandbox, onAct, onLook }));
  const openMenu = menu(build);
  const verb =
    play === null ? null : play.type === "activate" ? "activate" : top?.isLand ? "play" : "cast";
  const label = [
    `Library, ${cards}`,
    top === null ? "" : `; ${top.name} on top, ${revealed ? "revealed" : "which only you see"}`,
    verb === null ? "" : `. Double-click to ${verb} it`,
    !sandbox
      ? ""
      : verb === null
        ? ". Click to draw; right-click for more"
        : "; right-click for more",
  ].join("");

  return (
    <div ref={ref} className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        // Enabled for the sandbox's moves, and for a top card to point at or play by the rules.
        disabled={view === null || (!sandbox && top === null)}
        data-land={libraryEnds(view)}
        data-point={top?.id}
        aria-label={label}
        onClick={(e) => {
          // A keyboard's press carries no `detail`: Enter plays the top card, as a double-click.
          if (play !== null) {
            if (e.detail === 0) onAct(play);
            return;
          }
          if (sandbox) onAct({ type: "draw", count: 1 });
        }}
        onDoubleClick={() => {
          if (play !== null) onAct(play);
        }}
        onContextMenu={(e) => {
          onUnpoint?.();
          openMenu(e);
        }}
        onKeyDown={menuKey(build)}
        onMouseEnter={(e) => {
          if (top === null) return;
          onPoint?.({
            card: top,
            ids: [top.id],
            place: "libraryTop",
            line: `${top.name} · on top of your library${revealed ? ", revealed" : ""}`,
            at: pointerAt(e),
          });
        }}
        onMouseLeave={() => onUnpoint?.()}
        style={boxOf(size)}
        className={cn(
          "relative flex h-[252px] w-[180px] items-center justify-center rounded-lg border bg-surface p-0 text-accent disabled:cursor-default",
          sandbox || play !== null ? "cursor-pointer" : "cursor-default",
          // The edges of the cards under the top one, two of them, the way a deck sits.
          "shadow-[2px_2px_0_var(--color-bg),3px_3px_0_var(--color-border),5px_5px_0_var(--color-bg),6px_6px_0_var(--color-border)]",
          over ? "border-accent" : "border-border",
          PRESS,
          FOCUS,
          play !== null && CASTABLE_RING,
        )}
      >
        {top === null ? (
          <GrimoireMark size={markSize(size)} className="text-accent" />
        ) : (
          <>
            <span className="absolute inset-0">
              <CardFace card={top} />
            </span>
            <TopChip revealed={revealed} compact={size?.compact ?? false} />
          </>
        )}
        {size?.compact && (
          <CardCount
            count={count}
            title={`${count} ${count === 1 ? "card" : "cards"} in the library`}
          />
        )}
      </button>
      {!size?.compact && <span className={ZONE_LABEL}>Library · {count}</span>}
    </div>
  );
}

/**
 * Who sees the library's top card, on it: every player (`revealed`, an eye) or the reader alone
 * (a closed eye — they look at it, nobody else does). Decorative: the pile's name says it.
 */
function TopChip({ revealed, compact }: { revealed: boolean; compact: boolean }): JSX.Element {
  const Icon = revealed ? Eye : EyeOff;
  return (
    <span
      aria-hidden="true"
      data-testid="library-top-chip"
      className={cn(
        "pointer-events-none absolute top-1 left-1 inline-flex items-center gap-1 rounded border border-border bg-bg/90 px-[5px] text-[10px]/4 text-text",
        compact && "px-[3px]",
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {!compact && (revealed ? "Revealed" : "You look at it")}
    </span>
  );
}

/**
 * The library's cards a landing can show on (`useLandingOf`): its top and its bottom, the two ends
 * a card is put on.
 */
function libraryEnds(view: ZoneView | null): string | undefined {
  const cards = view?.libraryCards ?? [];
  if (cards.length === 0) return undefined;
  return `${cards[0].id} ${cards[cards.length - 1].id}`;
}

/** The library back's mark: the artboard's 72 px on its 180 px card, in proportion on another. */
export function markSize(size: ZoneSize | undefined): number {
  return Math.round((72 * (size?.width ?? ZONE_W)) / ZONE_W);
}
