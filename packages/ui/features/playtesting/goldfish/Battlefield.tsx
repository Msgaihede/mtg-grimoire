import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { GameCard, GoldfishAction, GoldfishPlace } from "@/lib/ipc";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { CardFace, counterLabel, sideOf } from "./Inspect";
import { goldfishDraggable, useGoldfishDropTarget, type GoldfishDrag } from "./goldfishDrag";
import {
  ASPECT,
  GAP,
  PILE,
  layoutTable,
  pileHeight,
  pileWidth,
  underOf,
  type Pile,
} from "./layout";
import { cardMenu } from "./menus";
import type { Pointed } from "./types";

/** The section's own padding, 16 px top and bottom and 20 either side (`py-4 px-5`). */
const PAD_X = 20;
const PAD_Y = 16;
/**
 * What the lanes' chrome takes out of the table's height before `layoutTable` halves it: the
 * 10 px between the two lanes, and the back lane's 12 px of padding and 1 px rule — counted
 * for both halves, since the layout gives each lane the same share and the back one is the
 * tighter.
 */
const LANE_CHROME = GAP + 2 * (12 + 1);

/** The artboard's drop glow, for the table and the hand: a 1 px inner ring of the accent. */
export const DROP_GLOW =
  "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]";

export interface BattlefieldProps {
  cards: GameCard[];
  onAct: (action: GoldfishAction) => void;
  onDrop: (drag: GoldfishDrag, to: GoldfishPlace) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  className?: string;
}

/**
 * The table: the artboard `Goldfish · the table, turn 9`'s two lanes, laid out by the rules
 * rather than by where a card was let go (`layout.ts`).
 *
 * **It measures itself** because the layout is a function of the box: a lane is always one row,
 * and its cards shrink until every pile fits across. The scrollbar is a fallback for a window too
 * short for even the floor size, not a way the table is meant to be read.
 */
export function Battlefield({
  cards,
  onAct,
  onDrop,
  onPoint,
  onUnpoint,
  className,
}: BattlefieldProps): JSX.Element {
  const dropRef = useRef<HTMLElement | null>(null);
  const over = useGoldfishDropTarget({ ref: dropRef, place: "battlefield", onDrop });
  const [box, setBox] = useState({ width: 0, height: 0 });

  // A callback ref, so the first measurement lands in the commit rather than one paint later
  // (`PriceChart`'s `useMeasuredWidth`, for its reasons). React 19 runs the returned cleanup.
  const measure = useCallback((el: HTMLElement | null) => {
    dropRef.current = el;
    if (el === null) return undefined;
    const read = () => {
      const width = Math.max(0, el.clientWidth - 2 * PAD_X);
      const height = Math.max(0, el.clientHeight - 2 * PAD_Y);
      setBox((was) => (was.width === width && was.height === height ? was : { width, height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      observer.disconnect();
      dropRef.current = null;
    };
  }, []);

  const layout = useMemo(
    () =>
      layoutTable(cards, {
        width: box.width,
        height: Math.max(0, box.height - LANE_CHROME),
      }),
    [cards, box],
  );
  const { creatures, lands, others, creatureWidth, backWidth } = layout;
  const both = lands.length > 0 && others.length > 0;
  const pile = (p: Pile, w: number) => (
    <PileView key={p.key} pile={p} w={w} onAct={onAct} onPoint={onPoint} onUnpoint={onUnpoint} />
  );

  return (
    <section
      ref={measure}
      aria-label="Battlefield"
      className={cn(
        "flex flex-col justify-center gap-2.5 overflow-y-auto rounded-[28px] px-5 py-4",
        over && DROP_GLOW,
        className,
      )}
    >
      {cards.length === 0 ? (
        <p className="pointer-events-none m-auto text-xs text-dim">Drag a card here to play it</p>
      ) : (
        <>
          <section
            aria-label="Creatures"
            className="flex min-h-0 flex-[1_1_0] items-center justify-center"
          >
            <div className={ROW}>{creatures.map((p) => pile(p, creatureWidth))}</div>
          </section>
          {/* Lands from the left and every other permanent from the right, one card size for
              the whole row, and the dashed divider wherever the two meet. */}
          <section
            aria-label="Lands and other permanents"
            className="flex min-h-0 flex-[1_1_0] items-end gap-3.5 border-t border-dashed border-border/60 pt-3"
          >
            {lands.length > 0 && (
              <div aria-label="Lands" className={ROW}>
                {lands.map((p) => pile(p, backWidth))}
              </div>
            )}
            {others.length > 0 && (
              <div
                aria-label="Artifacts, enchantments and other permanents"
                className={cn(
                  ROW,
                  "ml-auto",
                  both && "self-stretch border-l border-dashed border-border/60 pl-3.5",
                )}
              >
                {others.map((p) => pile(p, backWidth))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

/** One row of piles, bottom-aligned so a tapped card lies on the same line as an untapped one. */
const ROW = "flex flex-none flex-nowrap items-end gap-2.5";

/** "Forest" → "Forests", and "Plains" stays "Plains". Simple on purpose: the label is a hint. */
function plural(name: string): string {
  return name.endsWith("s") ? name : `${name}s`;
}

function PileView({
  pile,
  w,
  onAct,
  onPoint,
  onUnpoint,
}: {
  pile: Pile;
  w: number;
  onAct: (action: GoldfishAction) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { menu, menuKey } = useContextMenu();
  const { card, ids, tapped } = pile;
  const count = ids.length;
  const under = underOf(pile);
  const h = Math.round(w * ASPECT);
  // A card turned on its centre spills 0.2 of its width past its left edge; this puts it back
  // inside the pile's box, which `pileWidth` sized for the card as it lies.
  const turn = Math.round(w * 0.2);
  const word = count > 1 ? `${count} ${plural(card.name)}` : card.name;
  const counters = card.counters.map(counterLabel).join(" · ");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return goldfishDraggable({
      element,
      payload: () => ({ ids, from: "battlefield", name: card.name }),
    });
  }, [ids, card.name]);

  /** Where one card of the pile is drawn: `x` right and `y` down of the box's corner. */
  const at = (x: number, y: number) => ({
    top: y,
    left: x + (tapped ? turn : 0),
    width: w,
    height: h,
    transform: tapped ? "rotate(90deg)" : undefined,
  });
  // The ×N marker straddles the bottom edge of the card as it lies, centred under it.
  const markX = Math.round(w * (tapped ? 0.7 : 0.5));
  const markY = under * PILE + (tapped ? turn + w : h);

  const build = () => cardMenu({ card, ids, place: "battlefield", onAct });
  const openMenu = menu(build);

  return (
    <div
      ref={ref}
      className="relative flex-none cursor-grab"
      style={{ width: pileWidth(pile, w), height: pileHeight(pile, w) }}
    >
      {/* The cards underneath, a few pixels up and to the right, the way cardboard sits. */}
      {Array.from({ length: under }, (_, i) => under - i).map((k) => (
        <div
          key={k}
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={at(k * PILE, (under - k) * PILE)}
        >
          <CardFace card={card} />
        </div>
      ))}
      <button
        type="button"
        aria-label={[
          word,
          tapped ? "tapped" : null,
          card.isToken ? "token" : null,
          counters === "" ? null : counters,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        // Click taps the top card; Shift taps the pile — the artboard's help.
        onClick={(e) => onAct({ type: "tap", ids: e.shiftKey ? ids : [ids[0]], tapped: !tapped })}
        onContextMenu={(e) => {
          onUnpoint();
          openMenu(e);
        }}
        onKeyDown={menuKey(build)}
        onMouseEnter={(e) =>
          onPoint({
            card,
            ids,
            place: "battlefield",
            line: count > 1 ? `${word} on the battlefield` : card.name,
            side: sideOf(e.clientX),
          })
        }
        onMouseLeave={onUnpoint}
        className={cn(
          "absolute cursor-pointer rounded-md p-0",
          "transition-[left,transform] duration-150 ease-out motion-reduce:transition-none",
          FOCUS,
        )}
        style={at(0, under * PILE)}
      >
        <CardFace card={card} />
        {counters !== "" && (
          <span className="absolute top-1 left-1 rounded border border-border bg-bg px-[5px] font-mono text-[11px] text-text">
            {counters}
          </span>
        )}
      </button>
      {count > 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-bg px-2 font-mono text-xs/5 font-semibold whitespace-nowrap text-text tabular-nums"
          style={{ left: markX, top: markY }}
        >
          ×{count}
        </span>
      )}
    </div>
  );
}
