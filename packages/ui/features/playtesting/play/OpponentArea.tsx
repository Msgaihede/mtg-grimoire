import type { JSX } from "react";
import type { GamePlace, PlaytestAction, PlaytestSeat } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { Battlefield, type CardMark, type TablePick } from "../table/Battlefield";
import type { TableDrag } from "../table/tableDrag";
import type { Across, ZoneSize } from "../table/layout";
import { LifePlate } from "../table/LifePlate";
import type { Pointed, ZoneLook } from "../table/types";
import { OpponentCommand, OpponentHand, OpponentLibrary, OpponentPile } from "./OpponentZones";
import { PlateFrame } from "./PlateFrame";
import { playerName, playerPossessive } from "./players";

/**
 * The zone tiles of a four-player table's opponent: two thirds of the duel's 60 × 84, so their
 * hand, library, graveyard, exile and command zone stand in a two-wide grid beside the
 * battlefield, three rows in the area's height.
 */
export const AREA_ZONE: ZoneSize = { width: 40, height: 56, compact: true };

/**
 * One opponent's side at a four-player table (issue #994) — the duel's opponent half, shrunk to a
 * third of the width, so three stand side by side above the middle line in turn order.
 *
 * **The duel's pieces, each with a smaller size**: the compact `LifePlate` in a `PlateFrame` (the
 * turn's gold glow, poison), their zones from `OpponentZones` at {@link AREA_ZONE} — the hand a
 * face-down tile with its count among them, since an area has no edge of its own to hang a hand
 * from — and the `Battlefield` flipped, read-only and dense, the creature lane nearest the middle
 * line as on a duel's table. `data-plate` and `data-table` carry the player's own name, so the
 * arrows and the pops find each opponent apart.
 *
 * **Looked at, and handled only through the sandbox**, as a duel's opponent is: the cards point
 * for the preview, the graveyard and exile open read-only, and a click picks only when the rules
 * ask for one (`pick`). With the sandbox's moves working (`sandbox`) a permanent has the
 * sandbox's card menu — tap, counters, a token copy, a move to its owner's zones — and with the
 * sandbox on (`steppers`) the plate has a life stepper; nothing of theirs is ever dragged.
 * **A player who is out** (`seat.out`) stays drawn, dimmed, with "Out" across their table: the
 * others play on, and what they left behind is still worth a look.
 */
export function OpponentArea({
  seat,
  deckName,
  opponents,
  active,
  won,
  sandbox,
  steppers,
  marks,
  pick,
  across,
  aimable,
  onAim,
  onLife,
  onAct,
  onDrop,
  onPoint,
  onUnpoint,
  onLook,
  className,
}: {
  seat: PlaytestSeat;
  deckName: string;
  /** How many opponents the game has, for the names. */
  opponents: number;
  /** It is this player's turn. */
  active: boolean;
  /** This player won the game. */
  won: boolean;
  /** The sandbox's moves work now (on, the reader's main phase, nothing out): the battlefield's
   *  card menus, and a life stepper that can be pressed. */
  sandbox: boolean;
  /** The sandbox is on: the plate has a life stepper at all (greyed while `sandbox` is not). */
  steppers: boolean;
  marks?: ReadonlyMap<number, CardMark>;
  pick?: TablePick;
  /** The attachments that cross between this table and the others (`Battlefield`'s). */
  across?: Across;
  /** The reader's attacker waiting to be aimed can attack this player: the plate is a target. */
  aimable: boolean;
  onAim: () => void;
  onLife: (life: number) => void;
  onAct: (action: PlaytestAction) => void;
  onDrop: (drag: TableDrag, to: GamePlace) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  onLook: (look: ZoneLook) => void;
  className?: string;
}): JSX.Element {
  const name = playerName(seat.player, opponents);
  const owner = playerPossessive(seat.player, opponents, "mid");
  return (
    <section
      aria-label={`${name} · ${deckName}`}
      data-out={seat.out || undefined}
      className={cn("relative flex min-w-0 flex-col gap-1.5", className)}
    >
      <div className="flex h-[38px] min-w-0 flex-none items-center">
        <PlateFrame
          seat={seat.player}
          active={active}
          poison={seat.poison}
          compact
          className="max-w-full min-w-0"
        >
          <LifePlate
            seat="opponent"
            title={`${name} · ${deckName}`}
            label={`${name}'s life`}
            life={seat.life}
            highlight={won}
            readOnly={!steppers}
            disabled={!sandbox || seat.out}
            onChange={onLife}
            compact
            className="min-w-0"
          />
          {aimable && (
            <button
              type="button"
              onClick={onAim}
              className={cn(
                "absolute inset-0 rounded-full bg-transparent outline-2 outline-offset-2 outline-accent outline-dashed",
                FOCUS,
              )}
            >
              <span className="sr-only">Attack {name}</span>
            </button>
          )}
        </PlateFrame>
      </div>

      <div className={cn("flex min-h-0 flex-1 gap-2", seat.out && "opacity-40")}>
        <div className="grid flex-none grid-cols-2 content-center gap-1">
          <OpponentHand count={seat.handCount} owner={owner} size={AREA_ZONE} />
          <OpponentLibrary seat={seat} size={AREA_ZONE} owner={owner} />
          <OpponentPile
            seat={seat}
            zone="graveyard"
            size={AREA_ZONE}
            owner={owner}
            onPoint={onPoint}
            onUnpoint={onUnpoint}
            onLook={onLook}
          />
          <OpponentPile
            seat={seat}
            zone="exile"
            size={AREA_ZONE}
            owner={owner}
            onPoint={onPoint}
            onUnpoint={onUnpoint}
            onLook={onLook}
          />
          <OpponentCommand
            seat={seat}
            size={AREA_ZONE}
            owner={owner}
            onPoint={onPoint}
            onUnpoint={onUnpoint}
          />
        </div>
        <div
          data-table={seat.player}
          className="relative min-w-0 flex-1 rounded-[18px] border border-dashed border-border/50"
        >
          <Battlefield
            label={`${playerPossessive(seat.player, opponents)} battlefield`}
            cards={seat.battlefield}
            sandbox={sandbox && !seat.out}
            onAct={onAct}
            onDrop={onDrop}
            onPoint={onPoint}
            onUnpoint={onUnpoint}
            flipped
            readOnly
            dense
            marks={marks}
            pick={pick}
            across={across}
            className="h-full w-full"
          />
        </div>
      </div>

      {seat.out && (
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
            "rounded-full border border-border bg-surface px-4 py-1 text-[13px] font-semibold tracking-[0.08em] text-dim uppercase",
            LAYER.raised,
          )}
        >
          Out
        </span>
      )}
    </section>
  );
}
