import { useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Hourglass, WandSparkles } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { FOCUS } from "@/lib/focus";
import type { DraftCard, DraftView } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { InlineError, LABEL, PrimaryButton, QUIET_BUTTON } from "../setup/parts";
import { PoolColumns } from "./PoolColumns";
import { RoundStrip, SeatsStrip } from "./TableStrip";

/** The pack's tile width, px: the slider's ends and where it starts. */
export const PACK_SCALE = { min: 130, max: 300, start: 190 } as const;

/** The slider's place for the window's life (`lib/viewMemory.ts`): a reader who sized the pack
 *  for their screen should find it so on the next pick and the next draft. */
const scaleMemory = viewMemory<number>("draft.packScale");

/**
 * One pick: the round strip and the table, the pack as a wall of cards, and the pool below.
 *
 * **A click chooses, a second click on the chosen card picks it** — so a double-click picks, and
 * so does the Pick button. The keyboard walks the pack with the arrows and picks with Enter
 * (said in the hint under the pack; no global chord is taken). While the table catches up the
 * pack is replaced by a sentence saying so.
 */
export function PickScreen({
  view,
  busy,
  error,
  onPick,
  onAutoPick,
}: {
  view: DraftView;
  busy: boolean;
  error: string | null;
  onPick: (card: DraftCard) => void;
  /** The bots' choice for the reader — absent where the host's app makes the picks (a guest). */
  onAutoPick?: () => void;
}): JSX.Element {
  const [scale, setScaleState] = useState(() => scaleMemory.recall() ?? PACK_SCALE.start);
  const setScale = (value: number) => {
    scaleMemory.keep(value);
    setScaleState(value);
  };
  const scaleId = useId();
  const waiting = view.waiting || view.pack.length === 0;
  const picked = view.seats.filter((s) => s.picked).length;

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
            scale={scale}
            busy={busy}
            onPick={onPick}
          />
        )}
        <InlineError message={error} />
      </section>

      <PoolColumns pool={view.pool} />
    </div>
  );
}

/** The pack's cards as a wall, one of them chosen, and the Pick button and the hint under it. */
function PackWall({
  pack,
  scale,
  busy,
  onPick,
}: {
  pack: readonly DraftCard[];
  scale: number;
  busy: boolean;
  onPick: (card: DraftCard) => void;
}): JSX.Element {
  const [chosen, setChosen] = useState<number | null>(null);
  const wall = useRef<HTMLUListElement>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const card = chosen === null ? undefined : pack[chosen];

  const confirm = (index: number) => {
    if (busy) return;
    const target = pack[index];
    if (target !== undefined) onPick(target);
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
      const from = chosen ?? (step > 0 ? -1 : pack.length);
      const next = Math.min(pack.length - 1, Math.max(0, from + step));
      setChosen(next);
      tiles.current[next]?.focus();
      return;
    }
    if (event.key === "Enter" && chosen !== null) {
      // Enter picks the chosen card — never the button's own click, which would choose the
      // focused one instead when the two differ.
      event.preventDefault();
      confirm(chosen);
    }
  };

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
          const selected = index === chosen;
          return (
            <li key={c.instanceId}>
              <button
                ref={(el) => {
                  tiles.current[index] = el;
                }}
                type="button"
                aria-pressed={selected}
                aria-label={c.name}
                onClick={() => (selected ? confirm(index) : setChosen(index))}
                className={cn("group block w-full rounded-lg", PRESS, FOCUS)}
              >
                <CardArt cardId={c.cardId} name={c.name} selected={selected} hoverZoom />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <PrimaryButton
          ready={card !== undefined}
          busy={busy}
          onPress={() => {
            if (chosen !== null) confirm(chosen);
          }}
        >
          {card === undefined ? "Pick" : `Pick ${card.name}`}
        </PrimaryButton>
        <p className="m-0 text-xs text-dim">
          Click a card to choose it and again to pick it · ← → ↑ ↓ move · Enter picks
        </p>
      </div>
    </div>
  );
}
