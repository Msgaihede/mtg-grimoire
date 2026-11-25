import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import type { GameCard, GamePlace, PlaytestAction, PlaytestEmblem } from "@/lib/ipc";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { EFFECT_CHIPS, cardStates, effectChip, effectLine, type CardState } from "./effects";
import { CardFace, StatsChip, changedStats, counterLabel, pointerAt, shownName } from "./Inspect";
import {
  tableDraggable,
  useAimTarget,
  useTableDropTarget,
  type DropAim,
  type TableAim,
  type TableDrag,
} from "./tableDrag";
import {
  ASPECT,
  BACK_MAX,
  GAP,
  MARK,
  PILE,
  attachedPeek,
  layoutTable,
  pileHeight,
  pileWidth,
  tallestWidth,
  underOf,
  type Across,
  type Pile,
  type PileApart,
} from "./layout";
import { cardMenu } from "./menus";
import type { ControlSeat, Pointed } from "./types";

/** The section's own padding, 16 px top and bottom and 20 either side (`py-4 px-5`). */
const PAD_X = 20;
const PAD_Y = 16;
/** A `dense` table's: 12 either side and 8 top and bottom (`py-2 px-3`). */
const DENSE_X = 12;
const DENSE_Y = 8;
/**
 * What the lanes' chrome takes out of the table's height before `layoutTable` halves it: the
 * 10 px between the two lanes, and the back lane's 12 px of padding and 1 px rule — counted
 * for both halves, since the layout gives each lane the same share and the back one is the
 * tighter.
 */
const LANE_CHROME = GAP + 2 * (12 + 1);

/**
 * The width a card on a table `height` px tall is drawn at while its row has room — the lane's
 * height is what bounds it, as `layoutTable` measures it from this section's box — no wider than
 * a land is ever drawn ({@link BACK_MAX}). The board sizes its zone columns' cards by it, so a
 * graveyard reads at the size of the cards beside it.
 */
export function tableCardWidth(height: number, dense = false): number {
  const box = height - 2 * (dense ? DENSE_Y : PAD_Y) - LANE_CHROME;
  return Math.min(BACK_MAX, tallestWidth(Math.max(0, box) / 2));
}

/** The artboard's drop glow, for the table and the hand: a 1 px inner ring of the accent. */
export const DROP_GLOW =
  "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]";

/**
 * What a card on the table is marked as, drawn as a ring and maybe a badge — the playtest board's
 * combat: an attacker (pushed a little toward the other side, the way a creature is turned to
 * attack), a blocker and the attacker it blocks (one number on both), a blocker picked and
 * waiting for its attacker.
 */
export interface CardMark {
  tone: "attack" | "block" | "chosen";
  /** Drawn in a round badge at the card's corner: the block's number. */
  badge?: string;
  /** What the card's name is followed by for a screen reader: "attacking", "blocking 1". */
  word: string;
}

/** The cards a click picks rather than taps — an attacker to declare, a target to choose. */
export interface TablePick {
  ids: ReadonlySet<number>;
  onPick: (id: number) => void;
}

export interface BattlefieldProps {
  cards: GameCard[];
  /**
   * The sandbox's moves work now (on, the reader playing or declaring, nothing out): a click taps, a
   * pile is carried off to anywhere, and the menu has every hand move. Off, a card is only clicked when
   * the rules ask for it (`pick`) or to tap it for mana, dragged only onto what the rules take
   * (`carry`, `aim`), and its menu is the rules' rows alone — and the table still takes a card
   * played onto it from the hand or the command zone. Either way a click on a card the rules let
   * tap for mana ({@link GameCard.canTapForMana}) taps it for mana (`tapForMana`) rather than only
   * turning it.
   */
  sandbox: boolean;
  onAct: (action: PlaytestAction) => void;
  onDrop: (drag: TableDrag, to: GamePlace) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  className?: string;
  /**
   * The far side of the table — the playtest board's opponent: the lanes turned 180°, creatures
   * nearest the middle line and the back row toward the top edge, lands on the right. The cards
   * themselves stay upright, so they read.
   */
  flipped?: boolean;
  /**
   * Cards that are not the reader's to carry or tap by a click: no drag, no click-tap, no drop —
   * an opponent's table, or the reader's own while a turn is played back. **The menu stays the
   * sandbox's**: an opponent's permanent can be tapped, countered, copied or moved through it
   * while the sandbox is on, and has none while it is off.
   */
  readOnly?: boolean;
  /** The region's name. Default "Battlefield". */
  label?: string;
  marks?: ReadonlyMap<number, CardMark>;
  pick?: TablePick;
  /**
   * Heads a permanent's menu with "Activate ability" (`cardMenu`'s `onActivate`), and is what a
   * click on a permanent the rules let the reader activate ({@link GameCard.canActivate}) does
   * when the click has nothing else to do (no pick, no mana, no sandbox tap). On a `readOnly`
   * table — an opponent's — it reaches only the permanents whose `canActivate` is set: an "any
   * player may activate" ability the rules offer the reader now.
   */
  onActivate?: (id: number) => void;
  /**
   * Who this table's permanents can be put under the control of by hand (`cardMenu`'s
   * `control`, issue #1713): every player still in the game but the one whose table it is. Only
   * the table's own cards are offered it — an attachment drawn here from another table is not.
   */
  control?: readonly ControlSeat[];
  /**
   * Less padding round the lanes (`py-2 px-3`), so the cards take the room — the playtest board,
   * whose two tables share the window's height.
   */
  dense?: boolean;
  /**
   * The attachments that cross tables (`acrossTables`): another player's Aura on one of this
   * table's creatures is drawn under it here, and this table's Aura on another's creature leaves
   * these lanes. Without it, each table draws only its own cards' attachments.
   */
  across?: Across;
  /**
   * The seat's emblems (issue #1333), at the back row's far end past the artifacts and Equipment
   * — the near side's right, the far side's left — one card each at the row's size. Not cards: no
   * drag, no tap, no menu; pointing at one previews it through `onPointEmblem`.
   */
  emblems?: readonly PlaytestEmblem[];
  /** Point at an emblem: its picture and words in the preview. Without it an emblem says its
   *  words only to a screen reader and in its own tile. */
  onPointEmblem?: (pointed: Pointed) => void;
  /**
   * The reader's cards the rules let them pick up now, with the sandbox's moves off or not
   * (`play/aim.ts`' `canCarry`): an attacker or a blocker to carry onto what it attacks or
   * blocks, a permanent to carry onto its ability's target. Never on a `readOnly` table.
   */
  carry?: (card: GameCard) => boolean;
  /**
   * Where on this table a carried card may be let go for the rules (issue #1335): each card, lit
   * while one it takes is over it, and the felt, when it is a target of its own — an opponent's,
   * attacked. Without it no card here takes a drop, and the table only its zone's.
   */
  aim?: TableAim;
}

/**
 * A table: the artboard `Goldfish · the table, turn 9`'s two lanes, laid out by the rules rather
 * than by where a card was let go (`layout.ts`).
 *
 * **It measures itself** because the layout is a function of the box: a lane is always one row,
 * and its cards shrink until every pile fits across. The scrollbar is a fallback for a window too
 * short for even the floor size, not a way the table is meant to be read.
 *
 * **The board draws every side with it**: the reader's with `marks` and `pick` (combat and the
 * engine's questions) and `onActivate`, each opponent's `flipped` and `readOnly` too. A card that
 * is marked or can be picked is a pile of its own (`layoutTable`'s `apart`), so a click on it
 * picks that creature and not its untouched twin.
 */
export function Battlefield({
  cards,
  sandbox,
  onAct,
  onDrop,
  onPoint,
  onUnpoint,
  className,
  flipped = false,
  readOnly = false,
  label = "Battlefield",
  marks,
  pick,
  onActivate,
  control,
  dense = false,
  across,
  emblems = NO_EMBLEMS,
  onPointEmblem,
  carry,
  aim,
}: BattlefieldProps): JSX.Element {
  const dropRef = useRef<HTMLElement | null>(null);
  const over = useTableDropTarget({
    ref: dropRef,
    place: "battlefield",
    onDrop,
    sandbox,
    pointerOnly: true,
    refuse: readOnly,
  });
  const overFelt = useAimTarget({ ref: dropRef, aim: aim?.table });
  const [box, setBox] = useState({ width: 0, height: 0 });

  // A callback ref, so the first measurement lands in the commit rather than one paint later
  // (`PriceChart`'s `useMeasuredWidth`, for its reasons). React 19 runs the returned cleanup.
  const padX = dense ? DENSE_X : PAD_X;
  const padY = dense ? DENSE_Y : PAD_Y;
  const measure = useCallback(
    (el: HTMLElement | null) => {
      dropRef.current = el;
      if (el === null) return undefined;
      const read = () => {
        const width = Math.max(0, el.clientWidth - 2 * padX);
        const height = Math.max(0, el.clientHeight - 2 * padY);
        setBox((was) => (was.width === width && was.height === height ? was : { width, height }));
      };
      read();
      const observer = new ResizeObserver(read);
      observer.observe(el);
      return () => {
        observer.disconnect();
        dropRef.current = null;
      };
    },
    [padX, padY],
  );

  const apart = useMemo<PileApart | undefined>(
    () =>
      marks === undefined && pick === undefined
        ? undefined
        : (c) => (marks?.has(c.id) || pick?.ids.has(c.id) ? `#${c.id}` : ""),
    [marks, pick],
  );
  const layout = useMemo(
    () =>
      layoutTable(
        cards,
        {
          width: box.width,
          height: Math.max(0, box.height - LANE_CHROME),
        },
        apart,
        across,
        emblems.length,
      ),
    [cards, box, apart, across, emblems.length],
  );
  const { creatures, lands, others, creatureWidth, backWidth } = layout;
  const both = lands.length > 0 && others.length > 0;
  const permanents = lands.length > 0 || others.length > 0;
  const own = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const row = cn(ROW, flipped && "items-start");
  const pile = (p: Pile, w: number) => (
    <PileView
      key={p.key}
      pile={p}
      w={w}
      sandbox={sandbox}
      onAct={onAct}
      onPoint={onPoint}
      onUnpoint={onUnpoint}
      readOnly={readOnly}
      flipped={flipped}
      mark={marks?.get(p.ids[0])}
      onPick={pick?.ids.has(p.ids[0]) ? pick.onPick : undefined}
      onActivate={onActivate}
      control={control}
      own={own}
      marks={marks}
      pick={pick}
      carry={carry}
      aim={aim}
    />
  );
  const creatureLane = (
    <section
      aria-label="Creatures"
      className="flex min-h-0 flex-[1_1_0] items-center justify-center"
    >
      <div className={row}>{creatures.map((p) => pile(p, creatureWidth))}</div>
    </section>
  );
  // Lands from the left and every other permanent from the right, then the emblems — the other
  // way round on the far side — one card size for the whole row, and a dashed divider wherever
  // two meet.
  const landRow = lands.length > 0 && (
    <div aria-label="Lands" className={cn(row, flipped && "ml-auto", flipped && both && DIVIDER)}>
      {lands.map((p) => pile(p, backWidth))}
    </div>
  );
  const otherRow = others.length > 0 && (
    <div
      aria-label="Artifacts, enchantments and other permanents"
      className={cn(row, !flipped && "ml-auto", !flipped && both && DIVIDER)}
    >
      {others.map((p) => pile(p, backWidth))}
    </div>
  );
  // Past the other permanents, at the row's far end: on the near side the right, after the
  // artifacts and Equipment, with the divider on its left; on the far side the left.
  const emblemRow = emblems.length > 0 && (
    <div
      aria-label="Emblems"
      className={cn(
        row,
        !flipped && others.length === 0 && "ml-auto",
        permanents && (flipped ? DIVIDER_AFTER : DIVIDER),
      )}
    >
      {emblems.map((e) => (
        <EmblemView
          key={e.id}
          emblem={e}
          w={backWidth}
          onPoint={onPointEmblem}
          onUnpoint={onUnpoint}
        />
      ))}
    </div>
  );
  const backLane = (
    <section
      aria-label="Lands and other permanents"
      className={cn(
        "flex min-h-0 flex-[1_1_0] items-end gap-3.5 border-t border-dashed border-border/60 pt-3",
        flipped && "items-start border-t-0 border-b pt-0 pb-3",
      )}
    >
      {flipped ? emblemRow : landRow}
      {otherRow}
      {flipped ? landRow : emblemRow}
    </section>
  );

  return (
    <section
      ref={measure}
      aria-label={label}
      className={cn(
        "flex flex-col justify-center gap-2.5 overflow-y-auto rounded-[28px] px-5 py-4",
        dense && "px-3 py-2",
        (over || overFelt) && DROP_GLOW,
        className,
      )}
    >
      {cards.length === 0 && emblems.length === 0 ? (
        <p className="pointer-events-none m-auto text-xs text-dim">
          {readOnly ? "Nothing on the battlefield" : "Drag a card here to play it"}
        </p>
      ) : flipped ? (
        <>
          {backLane}
          {creatureLane}
        </>
      ) : (
        <>
          {creatureLane}
          {backLane}
        </>
      )}
    </section>
  );
}

/** One row of piles, bottom-aligned so a tapped card lies on the same line as an untapped one
 *  (top-aligned on the far side, whose edge is the top). */
const ROW = "flex flex-none flex-nowrap items-end gap-2.5";
/** The back row's divider, on whichever of its two halves comes second. */
const DIVIDER = "self-stretch border-l border-dashed border-border/60 pl-3.5";
/** The same divider on the right of a row that comes first: the far side's emblems. */
const DIVIDER_AFTER = "self-stretch border-r border-dashed border-border/60 pr-3.5";

const NO_EMBLEMS: readonly PlaytestEmblem[] = [];

/** How far an attacker is pushed toward the other side of the table. */
const FORWARD = 14;

/** A mark's ring, on the card as it lies. */
const MARK_RING: Record<CardMark["tone"], string> = {
  // Lifted off the table as well as pushed forward (`FORWARD`): the shadow is what says "this one
  // is in the air" at a glance, where a ring alone reads as one more mark.
  attack:
    "outline-2 outline-offset-2 outline-solid outline-mana-r scale-[1.04] shadow-[0_12px_22px_rgb(0_0_0/0.5)]",
  block: "outline-2 outline-offset-2 outline-solid outline-accent",
  chosen: "outline-3 outline-offset-2 outline-solid outline-accent",
};
/** A card a click would pick, and that nothing has marked yet. */
const PICKABLE_RING = "outline-2 outline-offset-2 outline-dashed outline-accent";

/** "Forest" → "Forests", and "Plains" stays "Plains". Simple on purpose: the label is a hint. */
function plural(name: string): string {
  return name.endsWith("s") ? name : `${name}s`;
}

function PileView({
  pile,
  w,
  sandbox,
  onAct,
  onPoint,
  onUnpoint,
  readOnly,
  flipped,
  mark,
  onPick,
  onActivate,
  control,
  own,
  marks,
  pick,
  carry,
  aim,
}: {
  pile: Pile;
  w: number;
  sandbox: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  readOnly: boolean;
  flipped: boolean;
  mark: CardMark | undefined;
  /** Present when a click picks this card rather than tapping it. */
  onPick: ((id: number) => void) | undefined;
  onActivate: ((id: number) => void) | undefined;
  control: readonly ControlSeat[] | undefined;
  /** This table's own cards: an attachment that is not one is another table's guest. */
  own: ReadonlySet<number>;
  marks: ReadonlyMap<number, CardMark> | undefined;
  pick: TablePick | undefined;
  carry: ((card: GameCard) => boolean) | undefined;
  aim: TableAim | undefined;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLButtonElement>(null);
  const { menu, menuKey } = useContextMenu();
  /** The attachment the pointer is on, drawn over the card it is tucked under (issue #1331). */
  const [lifted, setLifted] = useState<number | null>(null);
  const { card, ids, tapped } = pile;
  const hosts = pile.attached.length > 0;
  const count = ids.length;
  const under = underOf(pile);
  const h = Math.round(w * ASPECT);
  const peek = attachedPeek(w);
  /** How far the pile is pushed down to make room for its attachments' edges above it. */
  const lift = pile.attached.length * peek;
  // A card turned on its centre spills 0.2 of its width past its left edge; this puts it back
  // inside the pile's box, which `pileWidth` sized for the card as it lies.
  const turn = Math.round(w * 0.2);
  const name = shownName(card);
  const word = count > 1 ? `${count} ${plural(name)}` : name;
  const counters = card.counters.map(counterLabel).join(" · ");
  const effects = card.effects.map((e) => effectLine(e, card.name)).join("; ");
  const stats = changedStats(card);
  const states = cardStates(card);
  /** Carried off and tapped by a click: the reader's own card, with the sandbox's moves working. */
  const handled = sandbox && !readOnly;
  /** Tapped for mana by a click, by the rules: sandbox or not. */
  const makesMana = !readOnly && card.canTapForMana && !tapped;
  /** Picked up at all: the sandbox's carry, or the rules' (`carry`) — an attack, a target. */
  const carried = !readOnly && (handled || (carry?.(card) ?? false));
  /** The reader's way to activate this card: their own table's, or an opponent's permanent the
   *  rules let them activate ({@link GameCard.canActivate}) — never during a replay, whose
   *  frames offer nothing. */
  const activate = readOnly && !card.canActivate ? undefined : onActivate;
  /** Activated by a click, by the rules — the click has nothing else to do. */
  const activates = activate !== undefined && card.canActivate && !handled && !makesMana;
  const aimed = useAimTarget({ ref: top, aim: aim?.card(ids[0]), overlay: true });

  useEffect(() => {
    const element = ref.current;
    if (!element || !carried) return;
    // With attachments the card itself is the handle, so a press on an attachment's edge carries
    // the attachment (its own draggable) rather than the card it is attached to.
    return tableDraggable({
      element,
      handle: hosts ? (top.current ?? undefined) : undefined,
      payload: () => ({ ids, from: "battlefield", name: card.name }),
    });
  }, [ids, card.name, carried, hosts]);

  /** Where one card of the pile is drawn: `x` right and `y` down of the box's corner. */
  const at = (x: number, y: number) => ({
    top: y,
    left: x + (tapped ? turn : 0),
    width: w,
    height: h,
    transform: tapped ? "rotate(90deg)" : undefined,
  });
  // The ×N marker straddles the bottom edge of the card as it lies, centred under it — large
  // enough to read across the table (issue #1001).
  const markX = Math.round(w * (tapped ? 0.7 : 0.5));
  const markY = lift + under * PILE + (tapped ? turn + w : h);

  // Activate ability is the reader's own permanents' (never during a replay) and an opponent's the
  // rules let them activate; the sandbox's rows are any card's the table shows.
  const build = () =>
    cardMenu({
      card,
      ids,
      place: "battlefield",
      sandbox,
      onAct,
      onActivate: activate,
      control,
    });
  const openMenu = menu(build);
  const picks = onPick !== undefined;

  return (
    <div
      ref={ref}
      data-land={ids.join(" ")}
      data-phased-out={card.phasedOut || undefined}
      // `isolate`: a lifted attachment comes over its own card and competes with nothing else on
      // the board — the inspect preview, the hand and the arrows stay above it. A phased-out
      // permanent is treated as though it does not exist (CR 702.26): it is drawn faded.
      className={cn(
        "relative isolate flex-none",
        carried ? "cursor-grab" : "cursor-default",
        card.phasedOut && "opacity-40",
      )}
      style={{
        width: pileWidth(pile, w),
        height: pileHeight(pile, w),
        ...(mark?.tone === "attack" ? { translate: `0 ${flipped ? FORWARD : -FORWARD}px` } : {}),
      }}
    >
      {/* The attachments, farthest first, each a name bar higher — tucked under the card the way
          an Aura or Equipment sits at a real table (issue #1073). The one pointed at comes up
          over the cards in front of it, whole, until the pointer leaves it (issue #1331). */}
      {pile.attached
        .map((a, i) => ({ a, i }))
        .reverse()
        .map(({ a, i }) => (
          <AttachedView
            key={a.id}
            card={a}
            host={card}
            style={at(0, lift - (i + 1) * peek)}
            handled={handled && own.has(a.id)}
            carried={!readOnly && own.has(a.id) && (handled || (carry?.(a) ?? false))}
            aim={aim?.card(a.id)}
            sandbox={sandbox}
            onAct={onAct}
            onPoint={onPoint}
            onUnpoint={onUnpoint}
            mark={marks?.get(a.id)}
            onPick={pick?.ids.has(a.id) ? pick.onPick : undefined}
            onActivate={(readOnly || !own.has(a.id)) && !a.canActivate ? undefined : onActivate}
            control={own.has(a.id) ? control : undefined}
            lifted={lifted === a.id}
            onLift={setLifted}
          />
        ))}
      {/* The cards underneath, a few pixels up and to the right, the way cardboard sits. */}
      {Array.from({ length: under }, (_, i) => under - i).map((k) => (
        <div
          key={k}
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={at(k * PILE, lift + (under - k) * PILE)}
        >
          <CardFace card={card} />
        </div>
      ))}
      <button
        ref={top}
        type="button"
        aria-label={[
          word,
          tapped ? "tapped" : null,
          card.isToken ? "token" : null,
          card.gaps.length > 0 ? "played only in part" : null,
          ...states.map((state) => state.line),
          counters === "" ? null : counters,
          effects === "" ? null : effects,
          stats === null ? null : `${stats.power}/${stats.toughness}`,
          pile.attached.length > 0 ? `with ${pile.attached.map(shownName).join(", ")}` : null,
          mark?.word ?? null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        aria-pressed={picks ? mark !== undefined : undefined}
        // A card the rules let tap for mana is tapped for it — the top card, sandbox or not, its
        // mana into the pool (issue #1326). Otherwise click taps the top card and Shift the pile —
        // the artboard's help, and the sandbox's: with it off a click taps nothing. A card that
        // can be picked is picked instead, and an opponent's card is tapped only through its
        // menu, so a click meant as a look never turns it. A click with none of those to do on a
        // card the rules let the reader activate activates it — an opponent's too.
        onClick={(e) => {
          if (onPick !== undefined) onPick(ids[0]);
          else if (makesMana) onAct({ type: "tapForMana", id: ids[0] });
          else if (handled)
            onAct({ type: "tap", ids: e.shiftKey ? ids : [ids[0]], tapped: !tapped });
          else if (activates) activate?.(ids[0]);
        }}
        onContextMenu={(e) => {
          // An empty menu opens nothing, and neither does the browser's own over the table.
          e.preventDefault();
          if (build().length === 0) return;
          onUnpoint();
          openMenu(e);
        }}
        onKeyDown={menuKey(build)}
        onMouseEnter={(e) =>
          onPoint({
            card,
            ids,
            place: "battlefield",
            line: count > 1 ? `${word} on the battlefield` : name,
            at: pointerAt(e),
          })
        }
        onMouseLeave={onUnpoint}
        data-point={card.id}
        data-activatable={card.canActivate && activate !== undefined ? "" : undefined}
        className={cn(
          "absolute cursor-pointer rounded-md p-0",
          "transition-[left,transform] duration-150 ease-out motion-reduce:transition-none",
          FOCUS,
          !carried && !picks && !makesMana && !activates && "cursor-default",
          aimed
            ? MARK_RING.chosen
            : mark !== undefined
              ? MARK_RING[mark.tone]
              : picks && PICKABLE_RING,
        )}
        style={at(0, lift + under * PILE)}
      >
        <CardFace card={card} />
        {mark?.badge !== undefined && (
          <span
            aria-hidden="true"
            className="absolute -top-2 -right-2 inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1 font-mono text-[11px]/5 font-semibold text-accent-fg tabular-nums"
          >
            {mark.badge}
          </span>
        )}
        {(counters !== "" || card.effects.length > 0 || states.length > 0) && (
          <CardChips counters={counters} effects={card.effects.map(effectChip)} states={states} />
        )}
        <StatsChip card={card} />
      </button>
      {count > 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-bg px-2.5 font-mono text-sm/6 font-semibold whitespace-nowrap text-text tabular-nums shadow-[0_2px_6px_rgb(0_0_0/0.35)]"
          style={{ left: markX, top: markY }}
        >
          ×{count}
        </span>
      )}
    </div>
  );
}

/**
 * What a card on the table carries, drawn over its art's top left corner: the rules' marks on it
 * ({@link cardStates}: face down, phased out, summoning sick, a Class's level, goaded and its kin,
 * what was chosen), its counters, then one chip per effect on it — what happened and where from,
 * `+Demon · Clavileño` (issue #1327). A chip too long for the card is cut short; the preview and
 * the card's name for a screen reader have each in full. Past {@link EFFECT_CHIPS} the rest of the
 * effects are counted in one more chip. The damage marked on it is apart, red in the bottom-left
 * corner, across from its P/T.
 *
 * Decorative and inert: it is inside the card's own button, which names all of it.
 */
function CardChips({
  counters,
  effects,
  states,
}: {
  counters: string;
  effects: string[];
  states: readonly CardState[];
}): JSX.Element {
  const shown = effects.length > EFFECT_CHIPS ? effects.slice(0, EFFECT_CHIPS - 1) : effects;
  const more = effects.length - shown.length;
  const damage = states.find((s) => s.key === "damage");
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1 right-1 left-1 flex flex-col items-start gap-0.5"
      >
        {states
          .filter((s) => s !== damage)
          .map((state) => (
            <span
              key={state.key}
              data-state={state.key}
              className={cn(
                "max-w-full truncate rounded border bg-bg/90 px-[5px] text-[10px]/4",
                state.tone === "dim" ? "border-border text-dim" : "border-border text-text",
              )}
            >
              {state.chip}
            </span>
          ))}
        {counters !== "" && (
          <span className="max-w-full truncate rounded border border-border bg-bg px-[5px] font-mono text-[11px] text-text">
            {counters}
          </span>
        )}
        {shown.map((chip, i) => (
          <span
            key={i}
            data-effect=""
            className="max-w-full truncate rounded border border-accent/60 bg-bg/90 px-[5px] text-[10px]/4 text-text"
          >
            {chip}
          </span>
        ))}
        {more > 0 && (
          <span className="rounded border border-accent/60 bg-bg/90 px-[5px] text-[10px]/4 text-dim">
            +{more} more
          </span>
        )}
      </span>
      {damage !== undefined && (
        <span
          aria-hidden="true"
          data-state="damage"
          className="pointer-events-none absolute bottom-1 left-1 rounded border border-white/25 bg-black/80 px-[5px] font-mono text-[11px] font-semibold text-destructive tabular-nums"
        >
          {damage.chip}
        </span>
      )}
    </>
  );
}

/**
 * One Aura or Equipment tucked under the card it is attached to: only its top edge shows, and
 * that edge is the card's own to point at, open the menu of, pick, tap and carry off — an
 * Equipment's equip ability is activated from here.
 *
 * **Pointed at, it comes up whole** (`lifted`, issue #1331): over the card it is tucked under
 * and any attachment nearer that card, so the reader sees it on the table while its preview
 * waits for the pointer to rest. It goes back the moment the pointer leaves it. Lifted from
 * state rather than a `hover:` variant, `CardStack`'s way, so the class is `LAYER`'s own.
 *
 * **Only its edge is ever under the pointer** (issue #1364): the lifted card is a picture drawn
 * over the others, inert to the pointer, while the button stays tucked where it was. Raising the
 * button itself put its whole face over the card it is attached to, so a pointer that came down
 * through the edge stayed on the attachment, and a click meant for the creature — an attacker,
 * a blocker, a target — picked the attachment instead.
 */
function AttachedView({
  card,
  host,
  style,
  handled,
  carried,
  aim,
  sandbox,
  onAct,
  onPoint,
  onUnpoint,
  mark,
  onPick,
  onActivate,
  control,
  lifted,
  onLift,
}: {
  card: GameCard;
  host: GameCard;
  style: CSSProperties;
  /** Tapped by a click: the table's own card, with the sandbox's moves working. */
  handled: boolean;
  /** Picked up: by the sandbox's carry (`handled`), or the rules' — an Equipment to re-equip. */
  carried: boolean;
  /** What this edge takes when a card is let go on it — the card it belongs to, as a target. */
  aim: DropAim | undefined;
  sandbox: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  mark: CardMark | undefined;
  onPick: ((id: number) => void) | undefined;
  onActivate: ((id: number) => void) | undefined;
  control: readonly ControlSeat[] | undefined;
  lifted: boolean;
  /** Lifts the attachment by its id, or puts every one back (`null`). */
  onLift: (id: number | null) => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const { menu, menuKey } = useContextMenu();
  const ids = useMemo(() => [card.id], [card.id]);
  const counters = card.counters.map(counterLabel).join(" · ");
  const picks = onPick !== undefined;
  // Tapped for mana by a click when it is the reader's to activate (`onActivate`): never another
  // table's guest, never during a replay.
  const makesMana = onActivate !== undefined && card.canTapForMana && !card.tapped;
  /** Activated by a click (an equip, say) when the click has nothing else to do. */
  const activates = onActivate !== undefined && card.canActivate && !handled && !makesMana;
  const name = shownName(card);
  const aimed = useAimTarget({ ref, aim, overlay: true });

  useEffect(() => {
    const element = ref.current;
    if (!element || !carried) return;
    return tableDraggable({
      element,
      payload: () => ({ ids, from: "battlefield", name: card.name }),
    });
  }, [ids, card.name, carried]);

  const build = () =>
    cardMenu({ card, ids, place: "battlefield", sandbox, onAct, onActivate, control });
  const openMenu = menu(build);
  const ring = aimed
    ? MARK_RING.chosen
    : mark !== undefined
      ? MARK_RING[mark.tone]
      : picks && PICKABLE_RING;

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={[
          name,
          `attached to ${shownName(host)}`,
          card.tapped ? "tapped" : null,
          card.isToken ? "token" : null,
          ...cardStates(card).map((state) => state.line),
          counters === "" ? null : counters,
          mark?.word ?? null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        aria-pressed={picks ? mark !== undefined : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (onPick !== undefined) onPick(card.id);
          else if (makesMana) onAct({ type: "tapForMana", id: card.id });
          else if (handled) onAct({ type: "tap", ids, tapped: !card.tapped });
          else if (activates) onActivate?.(card.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (build().length === 0) return;
          onUnpoint();
          openMenu(e);
        }}
        onKeyDown={menuKey(build)}
        onMouseEnter={(e) => {
          onLift(card.id);
          onPoint({
            card,
            ids,
            place: "battlefield",
            line: `${name}, attached to ${shownName(host)}`,
            at: pointerAt(e),
          });
        }}
        onMouseLeave={() => {
          onLift(null);
          onUnpoint();
        }}
        data-point={card.id}
        data-activatable={activates ? "" : undefined}
        className={cn(
          "absolute rounded-md p-0",
          "transition-[left,top,transform] duration-150 ease-out motion-reduce:transition-none",
          FOCUS,
          carried ? "cursor-grab" : picks || activates ? "cursor-pointer" : "cursor-default",
          ring,
        )}
        style={style}
      >
        <CardFace card={card} />
      </button>
      {lifted && (
        <div
          aria-hidden="true"
          data-lifted={card.id}
          className={cn("pointer-events-none absolute rounded-md", LAYER.raised, ring)}
          style={style}
        >
          <CardFace card={card} />
        </div>
      )}
    </>
  );
}

/** An emblem as the table's pieces draw a card: its printing, or a tile of its words. */
export function emblemCard(emblem: PlaytestEmblem): GameCard {
  return {
    id: emblem.id,
    cardId: emblem.cardId,
    name: emblem.source === null ? "Emblem" : `${emblem.source} emblem`,
    typeLine: "Emblem",
    lane: "other",
    manaValue: 0,
    isLand: false,
    isToken: false,
    isCommander: false,
    tapped: false,
    counters: [],
    power: null,
    toughness: null,
    basePower: null,
    baseToughness: null,
    tax: 0,
    attachedTo: null,
    foretold: false,
    faceDown: false,
    damage: 0,
    sick: false,
    phasedOut: false,
    classLevel: null,
    chosen: [],
    marks: [],
    canForetell: false,
    canActivate: false,
    castable: false,
    canTapForMana: false,
    gaps: [],
    effects: [],
  };
}

/** What an emblem says, in a line: where it came from, then its words. */
export function emblemLine(emblem: PlaytestEmblem): string {
  const words = emblem.text.join(" ");
  const what = emblem.source === null ? "Emblem" : `Emblem from ${emblem.source}`;
  return words === "" ? what : `${what} — ${words}`;
}

/**
 * One emblem on the back row: the deck's printing of it when the deck keeps one, and otherwise a
 * tile with its source and words. It is not a card — nothing carries, taps or menus it — and it
 * stays for the rest of the game, so it stands upright at the size of the row's cards.
 */
function EmblemView({
  emblem,
  w,
  onPoint,
  onUnpoint,
}: {
  emblem: PlaytestEmblem;
  w: number;
  onPoint: ((pointed: Pointed) => void) | undefined;
  onUnpoint: () => void;
}): JSX.Element {
  const card = useMemo(() => emblemCard(emblem), [emblem]);
  const line = emblemLine(emblem);
  return (
    <div
      role="img"
      aria-label={line}
      data-emblem={emblem.id}
      data-point={emblem.id}
      onMouseEnter={(e) =>
        onPoint?.({ card, ids: [emblem.id], place: "command", line, at: pointerAt(e) })
      }
      onMouseLeave={onUnpoint}
      className="relative flex-none cursor-default"
      // A pile's box keeps room under its card for the ×N marker (`MARK`); so does this one, so
      // the emblem lines up with the cards beside it on the row's bottom edge.
      style={{ width: w, height: Math.round(w * ASPECT) + MARK }}
    >
      {emblem.cardId !== null ? (
        <span className="block" style={{ height: Math.round(w * ASPECT) }}>
          <CardFace card={card} />
        </span>
      ) : (
        <span
          aria-hidden="true"
          style={{ height: Math.round(w * ASPECT) }}
          className="flex w-full flex-col gap-0.5 overflow-hidden rounded-md border border-accent/60 bg-surface p-1 text-left text-[10px] leading-tight text-text"
        >
          <span className="text-[9px] tracking-[0.08em] text-accent uppercase">Emblem</span>
          {emblem.source !== null && (
            <span className="line-clamp-2 font-semibold break-words">{emblem.source}</span>
          )}
          {emblem.text.map((t, i) => (
            <span key={i} className="break-words text-dim">
              {t}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
