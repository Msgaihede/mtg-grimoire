import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Hourglass, PanelBottom, PanelRight, WandSparkles } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { scaled } from "@/lib/cardZoom";
import { FOCUS } from "@/lib/focus";
import { dndDraggable, useDndDropTarget } from "@/lib/dndTarget";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DraftCard, DraftView } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { InlineError, LABEL, PANEL, PrimaryButton, QUIET_BUTTON } from "../setup/parts";
import { carriedPick, pickDragData, readPickDrag, type PickDrag } from "./pickDrag";
import { sortPack, type PackSort } from "./pool";
import { PoolColumns } from "./PoolColumns";
import { PoolTray } from "./PoolTray";
import { RoundStrip, SeatsStrip } from "./TableStrip";
import { useDraftTrayLayout, type DraftTrayLayout } from "./trayLayout";
import { WinstonTable } from "./WinstonTable";

/**
 * The pack's tile width at 100%, px.
 *
 * The size itself is `cardZoom.draft` (issue #1433): ctrl+wheel over the draft steps the same
 * ladder every other card wall is sized on, and the size outlives the session as the other walls'
 * does. The gesture is the only control — the pick screen's Card size slider went with issue #1470.
 */
export const PACK_TILE_WIDTH = 190;

const SORTS: { value: PackSort; label: string }[] = [
  { value: "rarity", label: "Rarity" },
  { value: "dealt", label: "As dealt" },
];

/** The pack's order for the window's life (`lib/viewMemory.ts`) — rarity until the reader says
 *  otherwise (issue #1432). */
const sortMemory = viewMemory<PackSort>("draft.packSort");

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
 * **A card is picked three ways**: by dragging it onto the pool (issue #1434), by double-clicking
 * it (issue #1469), or by choosing it with a click and pressing Pick. A double-click is two clicks
 * within the system's double-click delay — never a second, later click on the chosen card, which
 * #1434 removed because it picked cards the reader only meant to look at again. The keyboard walks
 * the pack with the arrows and picks with Enter (said in the hint under the pack; no global chord
 * is taken). While the table catches up the pack is replaced by a sentence saying so.
 *
 * **A pick of two** (a Commander draft, `picksPerStep: 2`) chooses two cards, each click toggling
 * one, and picks them together — with the Pick button, Enter once both are chosen, or by dragging
 * or double-clicking one while the other is chosen (`pickDrag.ts`' `carriedPick`).
 *
 * **The pack is laid out by rarity, mythic first** (issue #1432), a rarity's cards in the order they
 * were dealt; the Sort menu offers the dealt order instead, kept for the window's life.
 *
 * **The pool is under the pack, or in a tray beside it** (issue #1474, `trayLayout.ts`): the curve
 * of stacked cards (`PoolColumns`, the default) or a compact list of names (`PoolTray`) — MTG
 * Arena's two drafting views — switched by the Pool toggle in the pack's heading row and kept per
 * device. Beside the pack, the pack and the tray scroll apart, so the tray (the drop target) stays
 * in reach however far down a zoomed-in pack the reader is; `DraftSession` hands the screen its
 * whole height for it. A Winston table keeps its pool underneath — it has no pack heading to carry
 * the toggle, and its piles are the width of the room.
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
  const zoom = useAppStore((s) => s.cardZoom.draft);
  const headingId = useId();
  const layout = useDraftTrayLayout((s) => s.layout);
  const [sort, setSortState] = useState<PackSort>(() => sortMemory.recall() ?? "rarity");
  const setSort = (value: PackSort) => {
    sortMemory.keep(value);
    setSortState(value);
  };
  const waiting = view.waiting || view.pack.length === 0;
  const picked = view.seats.filter((s) => s.picked).length;
  const need = picksNeeded(view);
  // Held across renders: the wall registers its drag sources again whenever its pack changes.
  const sorted = useMemo(() => sortPack(view.pack, sort), [view.pack, sort]);

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

  const strips = (
    <div className="flex flex-col gap-3">
      <RoundStrip view={view} />
      <SeatsStrip view={view} />
    </div>
  );

  const packSection = (
    <section aria-labelledby={`${headingId}-pack`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h3
          id={`${headingId}-pack`}
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
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <TrayToggle layout={layout} />
          <span id={`${headingId}-sort-label`} className={LABEL}>
            Sort
          </span>
          <Dropdown
            id={`${headingId}-sort`}
            labelledBy={`${headingId}-sort-label`}
            size="sm"
            value={sort}
            onChange={(v) => setSort(v as PackSort)}
            options={SORTS}
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
          pack={sorted}
          need={need}
          width={scaled(PACK_TILE_WIDTH, zoom)}
          busy={busy}
          onPick={onPick}
        />
      )}
      <InlineError message={error} />
    </section>
  );

  if (layout === "side") {
    return (
      <div className="flex min-h-0 flex-1 gap-5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto pb-8 pr-1">
          {strips}
          {packSection}
        </div>
        {/* The tray is where a card from the pack is dropped to pick it. */}
        <aside
          ref={poolRef}
          className={cn(
            PANEL,
            "mb-3 flex min-h-0 w-72 shrink-0 flex-col p-3",
            armed && DROP_RING,
            over && DROP_OVER,
          )}
        >
          <PoolTray pool={view.pool} />
        </aside>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {strips}
      {packSection}

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

/** The two layouts in the order the toggle draws them, and the words for each. */
const TRAY_LAYOUTS = [
  { id: "bottom", label: "Pool below the pack", Icon: PanelBottom },
  { id: "side", label: "Pool beside the pack", Icon: PanelRight },
] as const satisfies readonly { id: DraftTrayLayout; label: string; Icon: typeof PanelBottom }[];

/**
 * Where the pool is drawn — under the pack or in a tray beside it (issue #1474). Two icon squares
 * in one bordered group, the pressed one filled the way `Segmented`'s are: two glyphs of a window
 * with its panel at the bottom or the side say which is which at a glance on a row that is already
 * full of words, and the tooltip and the name say it in words.
 */
function TrayToggle({ layout }: { layout: DraftTrayLayout }): JSX.Element {
  const tip = useTooltip();
  const keep = useDraftTrayLayout((s) => s.keep);
  return (
    <div
      role="group"
      aria-label="Pool layout"
      className="flex overflow-hidden rounded-md border border-border"
    >
      {TRAY_LAYOUTS.map(({ id, label, Icon }) => {
        const pressed = layout === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={pressed}
            aria-label={label}
            // `describes: false`: identical to the `aria-label` above.
            {...tip(label, { describes: false })}
            onClick={() => keep(id)}
            className={cn(
              "inline-flex size-9 items-center justify-center",
              "transition-colors duration-150 motion-reduce:transition-none",
              pressed ? "bg-accent text-accent-fg" : "text-dim hover:text-text",
              FOCUS,
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
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
 * A double-click's second click (`detail` 2 — the system's delay decides) does not toggle: it picks
 * what a drag of that card would (`carriedPick`), or, short of a whole pick, leaves the card chosen.
 * A third click in a row does nothing, so a triple-click never picks twice.
 *
 * Every tile is a drag source carrying the pick it would make (`carriedPick`); the pool,
 * `PickScreen`'s, is where it is let go.
 */
function PackWall({
  pack,
  need,
  width,
  busy,
  onPick,
}: {
  pack: readonly DraftCard[];
  need: number;
  /** A tile's least width, px — the draft's zoom applied to {@link PACK_TILE_WIDTH}. */
  width: number;
  busy: boolean;
  onPick: (cards: DraftCard[]) => void;
}): JSX.Element {
  /** The chosen cards' `instanceId`s, oldest first — not their places, so a new sort keeps the
   *  choice. */
  const [chosen, setChosen] = useState<string[]>([]);
  /** Where the arrows are, for a pick of more than one — the choice does not follow them. */
  const caret = useRef<number | null>(null);
  const wall = useRef<HTMLUListElement>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const cardsOf = (ids: readonly string[]) =>
    ids.flatMap((id) => pack.find((c) => c.instanceId === id) ?? []);
  const cards = cardsOf(chosen);
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
              data: () => {
                const id = pack[index]?.instanceId;
                return pickDragData({
                  ids: id === undefined ? [] : carriedPick(chosenNow.current, id, need),
                });
              },
            }),
          ],
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [pack, need]);

  const confirm = (ids: readonly string[]) => {
    if (busy || ids.length !== need) return;
    const picked = cardsOf(ids);
    if (picked.length === need) onPick(picked);
  };

  const press = (index: number, clicks: number) => {
    const id = pack[index]?.instanceId;
    if (id === undefined) return;
    // A double-click's second click picks. A keyboard's press carries no count (0) and a single
    // click 1, so only the mouse's quick pair reaches here — never a later click on a chosen card.
    if (clicks >= 2) {
      if (clicks > 2) return;
      const ids = carriedPick(chosen, id, need);
      setChosen(ids);
      confirm(ids);
      return;
    }
    if (need === 1) {
      setChosen([id]);
      return;
    }
    setChosen((cur) =>
      cur.includes(id) ? cur.filter((i) => i !== id) : [...cur, id].slice(-need),
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
      const held = need === 1 ? pack.findIndex((c) => c.instanceId === chosen[0]) : -1;
      const at = need === 1 ? (held === -1 ? null : held) : caret.current;
      const from = at ?? (step > 0 ? -1 : pack.length);
      const next = Math.min(pack.length - 1, Math.max(0, from + step));
      const nextId = pack[next]?.instanceId;
      if (need === 1 && nextId !== undefined) setChosen([nextId]);
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
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${width}px, 1fr))` }}
      >
        {pack.map((c, index) => {
          const selected = chosen.includes(c.instanceId);
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
                onClick={(event: MouseEvent<HTMLButtonElement>) => press(index, event.detail)}
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
            ? "Double-click or drag a card onto your pool to pick it · Click to choose · ← → ↑ ↓ move · Enter picks"
            : `Click ${need} cards to choose them, then double-click or drag the last onto your pool · ← → ↑ ↓ move · Enter picks once ${need} are chosen`}
        </p>
      </div>
    </div>
  );
}
