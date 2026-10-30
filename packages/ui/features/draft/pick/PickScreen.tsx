import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Hourglass, WandSparkles } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { FOCUS } from "@/lib/focus";
import { dndDraggable, useDndDropTarget } from "@/lib/dndTarget";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DraftCard, DraftView } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { InlineError, LABEL, PrimaryButton, QUIET_BUTTON } from "../setup/parts";
import { carriedPick, pickDragData, readPickDrag, type PickDrag } from "./pickDrag";
import { PoolColumns } from "./PoolColumns";
import { RoundStrip, SeatsStrip } from "./TableStrip";
import { WinstonTable } from "./WinstonTable";

/** The pack's tile width, px: the slider's ends and where it starts. */
export const PACK_SCALE = { min: 130, max: 300, start: 190 } as const;

/** The slider's place for the window's life (`lib/viewMemory.ts`): a reader who sized the pack
 *  for their screen should find it so on the next pick and the next draft. */
const scaleMemory = viewMemory<number>("draft.packScale");

/** Cards one pick takes from `pack`: the view's `picksPerStep` (two in a Commander draft), or what
 *  is left when the pack holds fewer. */
export function picksNeeded(view: DraftView): number {
  const step = Math.max(1, view.picksPerStep);
  return Math.max(1, Math.min(step, view.pack.length));
}

/**
 * One pick: the round strip and the table, the pack as a wall of cards, and the pool below — or,
 * in a Winston draft (`view.stack`), the shared stack and its three piles in place of the pack.
 *
 * **A card is picked by dragging it onto the pool** (issue #1434, which replaced the second click
 * on a chosen card — a double-click no longer picks). A click chooses, and the Pick button picks
 * the chosen card. The keyboard walks the pack with the arrows and picks with Enter (said in the
 * hint under the pack; no global chord is taken). While the table catches up the pack is replaced
 * by a sentence saying so.
 *
 * **A pick of two** (a Commander draft, `picksPerStep: 2`) chooses two cards, each click toggling
 * one, and picks them together — with the Pick button, Enter once both are chosen, or by dragging
 * one onto the pool while the other is chosen (`pickDrag.ts`' `carriedPick`).
 */
export function PickScreen({
  view,
  busy,
  error,
  onPick,
  onAutoPick,
  onWinston,
  winstonSent = false,
}: {
  view: DraftView;
  busy: boolean;
  error: string | null;
  /** The cards picked — one, or `picksPerStep` of them. */
  onPick: (cards: DraftCard[]) => void;
  /** The bots' choice for the reader — absent where the host's app makes the picks (a guest). */
  onAutoPick?: () => void;
  /** A Winston turn: take the pile, or decline it. */
  onWinston?: (pile: number, take: boolean) => void;
  /** This turn's decision is sent and its answer not in yet (a guest's, until the host's push). */
  winstonSent?: boolean;
}): JSX.Element {
  const [scale, setScaleState] = useState(() => scaleMemory.recall() ?? PACK_SCALE.start);
  const setScale = (value: number) => {
    scaleMemory.keep(value);
    setScaleState(value);
  };
  const scaleId = useId();
  const waiting = view.waiting || view.pack.length === 0;
  const picked = view.seats.filter((s) => s.picked).length;
  const need = picksNeeded(view);

  /** The pack's cards a drag carries, or fewer when one has left the pack since it was lifted. */
  const carried = (drag: PickDrag): DraftCard[] =>
    drag.ids.flatMap((id) => view.pack.find((c) => c.instanceId === id) ?? []);
  const poolRef = useRef<HTMLDivElement>(null);
  const { armed, over } = useDndDropTarget({
    ref: poolRef,
    read: readPickDrag,
    canDrop: (drag) =>
      !busy && !waiting && drag.ids.length === need && carried(drag).length === need,
    onDrop: (drag) => onPick(carried(drag)),
    // A pick cannot be taken back, so it is the pointer's decision — never the carried card's
    // corner overlapping the pool while the pointer is still over the pack.
    pointerOnly: true,
  });

  if (view.stack !== null) {
    return (
      <div className="flex flex-col gap-6">
        <SeatsStrip view={view} />
        <WinstonTable
          view={view}
          stack={view.stack}
          busy={busy || winstonSent}
          error={error}
          onDecide={(pile, take) => onWinston?.(pile, take)}
          onAutoPick={onAutoPick}
        />
        <PoolColumns pool={view.pool} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <RoundStrip view={view} />
        <SeatsStrip view={view} />
      </div>

      <section aria-labelledby={`${scaleId}-pack`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h3
            id={`${scaleId}-pack`}
            className="m-0 font-heading text-lg font-semibold leading-none"
          >
            Pack {view.packNumber + 1} · Pick {view.pickNumber + 1}
          </h3>
          {!waiting && (
            <span className="font-mono text-sm tabular-nums text-dim">{view.pack.length} left</span>
          )}
          {!waiting && need > 1 && (
            <span className="rounded-full border border-accent/50 bg-accent/10 px-2.5 text-xs leading-6 text-accent">
              Choose {need}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <label htmlFor={scaleId} className={LABEL}>
              Card size
            </label>
            <input
              id={scaleId}
              type="range"
              min={PACK_SCALE.min}
              max={PACK_SCALE.max}
              step={10}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              className="w-32 accent-accent"
            />
            {onAutoPick !== undefined && (
              <button
                type="button"
                aria-disabled={waiting || busy}
                onClick={() => {
                  if (!waiting && !busy) onAutoPick();
                }}
                className={QUIET_BUTTON}
              >
                <WandSparkles className="size-4" aria-hidden="true" />
                Pick for me
              </button>
            )}
          </div>
        </div>

        {waiting ? (
          <div
            role="status"
            className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center"
          >
            <Hourglass className="size-6 text-accent" aria-hidden="true" />
            <p className="m-0 text-sm">Waiting for the table…</p>
            <p className="m-0 font-mono text-xs tabular-nums text-dim">
              {picked} of {view.seats.length} have picked
            </p>
          </div>
        ) : (
          <PackWall
            // A new pack is a new wall: the choice made in the last one does not carry over.
            key={`${view.packNumber}.${view.pickNumber}`}
            pack={view.pack}
            need={need}
            scale={scale}
            busy={busy}
            onPick={onPick}
          />
        )}
        <InlineError message={error} />
      </section>

      {/* The pool is where a card from the pack is dropped to pick it. */}
      <div
        ref={poolRef}
        className={cn("-m-1.5 rounded-xl p-1.5", armed && DROP_RING, over && DROP_OVER)}
      >
        <PoolColumns pool={view.pool} />
      </div>
    </div>
  );
}

/**
 * The pack's cards as a wall, the chosen ones ringed, and the Pick button and the hint under it.
 *
 * With `need` 1 a click chooses. With more, a click toggles a card in or out of the choice — a
 * click past `need` lets the oldest choice go — the arrows only move the caret, and Enter picks
 * once `need` are chosen (before then it is the focused tile's own press, which toggles it).
 *
 * Every tile is a drag source carrying the pick it would make (`carriedPick`); the pool,
 * `PickScreen`'s, is where it is let go.
 */
function PackWall({
  pack,
  need,
  scale,
  busy,
  onPick,
}: {
  pack: readonly DraftCard[];
  need: number;
  scale: number;
  busy: boolean;
  onPick: (cards: DraftCard[]) => void;
}): JSX.Element {
  /** The chosen cards' places in the pack, oldest first. */
  const [chosen, setChosen] = useState<number[]>([]);
  /** Where the arrows are, for a pick of more than one — the choice does not follow them. */
  const caret = useRef<number | null>(null);
  const wall = useRef<HTMLUListElement>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const cards = chosen.flatMap((i) => (pack[i] === undefined ? [] : [pack[i]]));
  const full = cards.length === need;
  /** The choice as the drag source reads it — at the drag's start, not the tile's registration. */
  const chosenNow = useRef(chosen);
  useEffect(() => {
    chosenNow.current = chosen;
  });

  useEffect(() => {
    const stops = tiles.current.slice(0, pack.length).flatMap((element, index) =>
      element === null
        ? []
        : [
            dndDraggable({
              element,
              data: () =>
                pickDragData({
                  ids: carriedPick(chosenNow.current, index, need).flatMap((i) =>
                    pack[i] === undefined ? [] : [pack[i].instanceId],
                  ),
                }),
            }),
          ],
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [pack, need]);

  const confirm = (indices: readonly number[]) => {
    if (busy || indices.length !== need) return;
    const picked = indices.flatMap((i) => (pack[i] === undefined ? [] : [pack[i]]));
    if (picked.length === need) onPick(picked);
  };

  const press = (index: number) => {
    if (need === 1) {
      setChosen([index]);
      return;
    }
    setChosen((cur) =>
      cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index].slice(-need),
    );
  };

  /** How many tiles a row holds now — the grid's own answer, so ↑ and ↓ move a whole row. */
  const perRow = (): number => {
    const el = wall.current;
    if (el === null) return 1;
    const columns = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
    return Math.max(1, columns);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? perRow()
            : event.key === "ArrowUp"
              ? -perRow()
              : 0;
    if (step !== 0) {
      event.preventDefault();
      const at = need === 1 ? (chosen[0] ?? null) : caret.current;
      const from = at ?? (step > 0 ? -1 : pack.length);
      const next = Math.min(pack.length - 1, Math.max(0, from + step));
      if (need === 1) setChosen([next]);
      caret.current = next;
      tiles.current[next]?.focus();
      return;
    }
    if (event.key === "Enter" && (need === 1 ? chosen.length === 1 : full)) {
      // Enter picks the chosen card(s) — never the button's own click, which would choose the
      // focused one instead when the two differ.
      event.preventDefault();
      confirm(chosen);
    }
  };

  const label =
    need === 1
      ? cards[0] === undefined
        ? "Pick"
        : `Pick ${cards[0].name}`
      : full
        ? `Pick ${cards.map((c) => c.name).join(" and ")}`
        : `Pick ${need}`;

  return (
    <div className="flex flex-col gap-3">
      <ul
        ref={wall}
        aria-label="Pack"
        onKeyDown={onKeyDown}
        className="m-0 grid list-none gap-3 p-0"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${scale}px, 1fr))` }}
      >
        {pack.map((c, index) => {
          const selected = chosen.includes(index);
          return (
            <li key={c.instanceId}>
              <button
                ref={(el) => {
                  tiles.current[index] = el;
                }}
                type="button"
                aria-pressed={selected}
                aria-label={c.name}
                onFocus={() => {
                  caret.current = index;
                }}
                onClick={() => press(index)}
                className={cn("group block w-full rounded-lg", PRESS, FOCUS)}
              >
                <CardArt cardId={c.cardId} name={c.name} selected={selected} hoverZoom />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <PrimaryButton ready={full} busy={busy} onPress={() => confirm(chosen)}>
          {label}
        </PrimaryButton>
        {need > 1 && (
          <span role="status" className="font-mono text-xs tabular-nums text-dim">
            {cards.length} of {need} chosen
          </span>
        )}
        <p className="m-0 text-xs text-dim">
          {need === 1
            ? "Drag a card onto your pool to pick it · Click to choose · ← → ↑ ↓ move · Enter picks"
            : `Click ${need} cards to choose them, or drag the last onto your pool · ← → ↑ ↓ move · Enter picks once ${need} are chosen`}
        </p>
      </div>
    </div>
  );
}
