/**
 * How the goldfish table is laid out — the arithmetic, with nothing drawn.
 *
 * **The artboards' numbers** (`Goldfish · the table, turn 9`, 2026-10-12), kept as the design gave
 * them and measured against the table's real box rather than its 1440 × 900 frame: the mockup's
 * table was 1100 px between the two zone columns, and a window is whatever size the reader made
 * it, so every width here is a function of the box `Battlefield` measures.
 *
 * Two lanes, front to back the way a table is laid out: **creatures toward the opponent**, and
 * behind them **one row with the lands on the left and every other permanent on the right**. A
 * lane is always one row: the cards size down until every pile fits across the table — solved,
 * not searched, since a pile's width is linear in its card's.
 */
import type { GameCard, GoldfishLane } from "@/lib/ipc";

/** The gap between two piles in a row. */
export const GAP = 10;
/** Each card under the top one of a pile sits this many px up and to the right of it — enough
 *  of its edge to count the cards at a glance (issue #1001). */
export const PILE = 5;
/** At most this many cards are drawn underneath, so a pile shows five cards at most; the ×N
 *  marker says the rest. */
export const UNDER = 4;
/** Room under a pile for the half of its ×N marker that hangs below the card (the marker is
 *  26 px tall). */
export const MARK = 14;
/** The back row's divider: 14 px either side of a 1 px rule. */
export const SPLIT = 29;
/** A card's height over its width (the 5:7 frame). */
export const ASPECT = 1.4;
/** A tapped card lies on its side, so it takes this many card-widths of the row. */
export const TAPPED = 1.4;
/** Only a guard against a zero; in practice the piles keep a lane far above it. */
export const FLOOR = 24;
/**
 * The largest a creature is drawn, and the largest a land or other permanent is. Large on
 * purpose: a table of a few cards draws them big, and the lane's height and the row's width
 * shrink them as the table fills (`fitWidth`) — in practice the lane's height is what stops a
 * sparse row, so these are only a ceiling for a very tall window.
 */
export const CREATURE_MAX = 260;
export const BACK_MAX = 220;

/** A card in hand, and how much of it shows above the window's edge while it rests. */
export const HAND_CARD_W = 140;
export const HAND_CARD_H = 196;
export const HAND_PEEK = 124;
/** How far a card pointed at in hand is pulled up out of the row. */
export const HAND_LIFT = 44;
/** The gap between two cards of a hand that fits without overlapping. */
export const HAND_GAP = 8;
/** The widest the hand's row grows before its cards overlap to stay inside it: seven cards
 *  side by side. */
export const HAND_ROW_MAX = 7 * HAND_CARD_W + 6 * HAND_GAP;
/** However many cards are held, each shows at least this much of its left edge. */
export const HAND_MIN_STEP = 36;

/** The zone columns' cards: command, exile, graveyard, library. */
export const ZONE_W = 180;
export const ZONE_H = 252;

/** A zone card's box — the goldfish's {@link ZONE_W} × {@link ZONE_H} unless a board passes
 *  another (the playtest board's two tables share the window's height, so its zones are smaller). */
export interface ZoneSize {
  width: number;
  height: number;
  /** Each zone's count drawn on its card, rather than its name and count in a line under it —
   *  for a column too narrow for the line. */
  compact?: boolean;
}

/**
 * One pile: the cards of one name that look the same — same tapped state, same counters — and
 * so are drawn as one card with the rest edged under it. The ids are the engine's, in table order.
 */
export interface Pile {
  /** Stable within one view: the first card's id. */
  key: string;
  card: GameCard;
  ids: number[];
  tapped: boolean;
}

/** What makes two cards one pile: the picture, the name, the state and the counters. */
function pileKey(c: GameCard): string {
  const counters = c.counters.map((k) => `${k.kind}=${k.count}`).join(",");
  return [c.cardId ?? "", c.name, c.tapped ? 1 : 0, counters, c.isToken ? "t" : ""].join("|");
}

/**
 * Something beyond the look that keeps two cards apart — the playtest board's: a creature picked
 * as an attacker, or one that can be, is its own pile, so a click on it picks that creature and
 * not its untouched twin (`Battlefield`'s `pick`). Two cards with different answers are never one
 * pile; the goldfish passes none, and its piles are the look alone.
 */
export type PileApart = (card: GameCard) => string;

/** The cards of one lane, grouped into piles in the order each pile's first card arrived. */
export function pilesOf(cards: readonly GameCard[], lane: GoldfishLane, apart?: PileApart): Pile[] {
  const seen = new Map<string, Pile>();
  const out: Pile[] = [];
  for (const card of cards) {
    if (card.lane !== lane) continue;
    const k = apart === undefined ? pileKey(card) : `${pileKey(card)}|${apart(card)}`;
    const pile = seen.get(k);
    if (pile !== undefined) {
      pile.ids.push(card.id);
      continue;
    }
    const fresh: Pile = { key: String(card.id), card, ids: [card.id], tapped: card.tapped };
    seen.set(k, fresh);
    out.push(fresh);
  }
  return out;
}

/** How many cards are drawn under a pile's top card. */
export function underOf(pile: Pile): number {
  return Math.min(pile.ids.length - 1, UNDER);
}

/** How wide a pile is at card width `w`: a tapped card lies on its side, and each card underneath
 *  adds its {@link PILE} px of edge. */
export function pileWidth(pile: Pile, w: number): number {
  return Math.round(w * (pile.tapped ? TAPPED : 1)) + underOf(pile) * PILE;
}

/** How tall a pile's box is at card width `w`, its ×N marker's overhang included. */
export function pileHeight(pile: Pile, w: number): number {
  return Math.round(w * ASPECT) + underOf(pile) * PILE + MARK;
}

/**
 * The card width that fits every pile of a row across `row` px, no wider than `max` and no taller
 * than the lane allows. What is fixed — the gaps, each pile's edges, the back row's divider —
 * comes off the top; what is left is shared out by how many card-widths the row holds.
 */
export function fitWidth(
  piles: readonly Pile[],
  {
    row,
    laneHeight,
    fixed = 0,
    max,
  }: { row: number; laneHeight: number; fixed?: number; max: number },
): number {
  if (piles.length === 0) return max;
  const widths = piles.reduce((n, p) => n + (p.tapped ? TAPPED : 1), 0);
  const edges = piles.reduce((n, p) => n + underOf(p) * PILE, 0);
  const room = row - fixed - edges - GAP * (piles.length - 1);
  // A tapped card is as tall as an untapped one is wide, so the lane's height bounds the
  // untapped card: its height plus the pile's edges and the marker must fit.
  const tallest = Math.floor((laneHeight - UNDER * PILE - MARK) / ASPECT);
  return Math.max(FLOOR, Math.min(max, tallest, Math.floor(room / widths) - 1));
}

/** Both lanes' piles and the card width each is drawn at. */
export interface TableLayout {
  creatures: Pile[];
  lands: Pile[];
  others: Pile[];
  creatureWidth: number;
  /** Lands and the other permanents share one card size, as they share one row. */
  backWidth: number;
}

export function layoutTable(
  battlefield: readonly GameCard[],
  { width, height }: { width: number; height: number },
  apart?: PileApart,
): TableLayout {
  const creatures = pilesOf(battlefield, "creature", apart);
  const lands = pilesOf(battlefield, "land", apart);
  const others = pilesOf(battlefield, "other", apart);
  const laneHeight = Math.max(0, height / 2);
  const both = lands.length > 0 && others.length > 0;
  return {
    creatures,
    lands,
    others,
    creatureWidth: fitWidth(creatures, { row: width, laneHeight, max: CREATURE_MAX }),
    backWidth: fitWidth([...lands, ...others], {
      row: width,
      laneHeight,
      fixed: both ? SPLIT : 0,
      max: BACK_MAX,
    }),
  };
}

/** The band the hand is held in: how wide, how tall, and each card's left edge in it. */
export interface HandRowLayout {
  width: number;
  height: number;
  /** Each card's left edge, in hand order. */
  lefts: number[];
  /** From the top of the band: where a resting card's top edge is, and a lifted one's. */
  restTop: number;
  liftTop: number;
}

/**
 * The hand, held in one straight row below the table: each card shows its top
 * {@link HAND_PEEK} px and is pulled {@link HAND_LIFT} px up out of the row when pointed at. Up
 * to seven sit side by side; more overlap, each closer to the last, so the row never grows past
 * {@link HAND_ROW_MAX} until every card shows only {@link HAND_MIN_STEP} of itself.
 */
export function handRow(count: number): HandRowLayout {
  const step =
    count <= 1
      ? 0
      : Math.max(
          HAND_MIN_STEP,
          Math.min(HAND_CARD_W + HAND_GAP, Math.floor((HAND_ROW_MAX - HAND_CARD_W) / (count - 1))),
        );
  const width = HAND_CARD_W + Math.max(0, count - 1) * step;
  const height = HAND_PEEK + HAND_LIFT + 8;
  return {
    width,
    height,
    lefts: Array.from({ length: count }, (_, i) => i * step),
    restTop: height - HAND_PEEK,
    liftTop: height - HAND_PEEK - HAND_LIFT,
  };
}

/** The cards with every land first, each group keeping the order it came in — how a reader
 *  sorts an opening hand. */
export function landsFirst<T extends { isLand: boolean }>(cards: readonly T[]): T[] {
  return [...cards.filter((c) => c.isLand), ...cards.filter((c) => !c.isLand)];
}

/**
 * The order the hand is held in, given the order it was held in a moment ago (`was`, ids).
 *
 * **A hand picked up fresh is sorted lands first** — the kept opening hand, which the reader has
 * just seen that way (`OpeningHand`). After that the cards stay where they are: a card drawn or
 * returned goes on the right, the way a card is added to a held hand, and a card played leaves a
 * gap the rest close up.
 */
export function arrangeHand(was: readonly number[], cards: readonly GameCard[]): number[] {
  if (was.length === 0) return landsFirst(cards).map((c) => c.id);
  const here = new Set(cards.map((c) => c.id));
  const kept = was.filter((id) => here.has(id));
  const held = new Set(kept);
  return [...kept, ...cards.filter((c) => !held.has(c.id)).map((c) => c.id)];
}
