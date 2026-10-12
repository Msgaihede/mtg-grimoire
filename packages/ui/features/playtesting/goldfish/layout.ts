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
/** Each card under the top one of a pile sits this many px up and to the right of it. */
export const PILE = 3;
/** At most this many cards are drawn underneath; the ×N marker says the rest. */
export const UNDER = 3;
/** Room under a pile for the half of its ×N marker that hangs below the card. */
export const MARK = 11;
/** The back row's divider: 14 px either side of a 1 px rule. */
export const SPLIT = 29;
/** A card's height over its width (the 5:7 frame). */
export const ASPECT = 1.4;
/** A tapped card lies on its side, so it takes this many card-widths of the row. */
export const TAPPED = 1.4;
/** Only a guard against a zero; in practice the piles keep a lane far above it. */
export const FLOOR = 24;
/** The largest a creature is drawn, and the largest a land or other permanent is. */
export const CREATURE_MAX = 120;
export const BACK_MAX = 100;

/** A card in hand, and how much of it shows above the window's edge while it rests. */
export const HAND_CARD_W = 132;
export const HAND_CARD_H = 185;
export const HAND_PEEK = 112;

/** The zone columns' cards: command, exile, graveyard, library. */
export const ZONE_W = 104;
export const ZONE_H = 146;

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

/** The cards of one lane, grouped into piles in the order each pile's first card arrived. */
export function pilesOf(cards: readonly GameCard[], lane: GoldfishLane): Pile[] {
  const seen = new Map<string, Pile>();
  const out: Pile[] = [];
  for (const card of cards) {
    if (card.lane !== lane) continue;
    const k = pileKey(card);
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
 *  adds its 3 px of edge. */
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
): TableLayout {
  const creatures = pilesOf(battlefield, "creature");
  const lands = pilesOf(battlefield, "land");
  const others = pilesOf(battlefield, "other");
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

/** One card of the hand as it is held: where it sits and how it leans. */
export interface HandSlot {
  left: number;
  /** From the top of the hand's band; a lifted card is at 0. */
  top: number;
  rotate: number;
}

/** The band the hand is held in: how wide, and each card's place in it. */
export interface HandFanLayout {
  width: number;
  height: number;
  slots: HandSlot[];
}

/**
 * The hand, held below the table: each card shows its top {@link HAND_PEEK} px and rises whole
 * when pointed at. Fanned around its middle — a card leans 4° a place out from the centre and
 * sinks by the square of its distance, so the edges dip the way held cards do. Seven or fewer
 * are 96 px apart; more close up to 70.
 */
export function fanHand(count: number, lifted: number | null): HandFanLayout {
  const step = count > 7 ? 70 : 96;
  const mid = (count - 1) / 2;
  const width = count > 0 ? HAND_CARD_W + (count - 1) * step : HAND_CARD_W;
  const height = HAND_CARD_H + 16;
  const slots = Array.from({ length: count }, (_, i) => {
    const d = i - mid;
    const up = lifted === i;
    return {
      left: i * step,
      top: up ? 0 : height - HAND_PEEK + Math.round(d * d * 4),
      rotate: up ? 0 : d * 4,
    };
  });
  return { width, height, slots };
}
