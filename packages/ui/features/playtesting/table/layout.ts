/**
 * How the table is laid out — the arithmetic, with nothing drawn.
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
import type { GameCard, GameLane } from "@/lib/ipc";

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
/**
 * Each Aura or Equipment attached to a card shows this many card-widths of its top edge above
 * the card — its name bar, the way an attachment is tucked under its creature at a real table
 * (issue #1073).
 */
export const ATTACHED = 0.16;
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

/** A zone card's box — the artboard's {@link ZONE_W} × {@link ZONE_H} unless a board passes
 *  another (the board's two tables share the window's height, so its zones are smaller). */
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
  /**
   * The Auras, Equipment and Fortifications attached to the card, nearest first, drawn tucked
   * under it ({@link ATTACHED}). A card with any is a pile of its own, so this is never shared
   * by twins.
   */
  attached: GameCard[];
}

/** What makes two cards one pile: the picture, the name, the state and the counters. */
function pileKey(c: GameCard): string {
  const counters = c.counters.map((k) => `${k.kind}=${k.count}`).join(",");
  return [c.cardId ?? "", c.name, c.tapped ? 1 : 0, counters, c.isToken ? "t" : ""].join("|");
}

/**
 * Something beyond the look that keeps two cards apart — the board's combat: a creature picked
 * as an attacker, or one that can be, is its own pile, so a click on it picks that creature and
 * not its untouched twin (`Battlefield`'s `pick`). Two cards with different answers are never one
 * pile; with none passed, the piles are the look alone.
 */
export type PileApart = (card: GameCard) => string;

/** The cards of one lane, grouped into piles in the order each pile's first card arrived. A
 *  card with attachments (`attached`, by its id) is a pile of its own, with them under it. */
export function pilesOf(
  cards: readonly GameCard[],
  lane: GameLane,
  apart?: PileApart,
  attached?: ReadonlyMap<number, GameCard[]>,
): Pile[] {
  const seen = new Map<string, Pile>();
  const out: Pile[] = [];
  for (const card of cards) {
    if (card.lane !== lane) continue;
    const under = attached?.get(card.id) ?? [];
    const own = under.length > 0 ? `|#${card.id}` : "";
    const k = (apart === undefined ? pileKey(card) : `${pileKey(card)}|${apart(card)}`) + own;
    const pile = seen.get(k);
    if (pile !== undefined) {
      pile.ids.push(card.id);
      continue;
    }
    const fresh: Pile = {
      key: String(card.id),
      card,
      ids: [card.id],
      tapped: card.tapped,
      attached: under,
    };
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

/** How much of each attachment shows above a card `w` wide. */
export function attachedPeek(w: number): number {
  return Math.round(w * ATTACHED);
}

/** How tall a pile's box is at card width `w`, its attachments' edges and its ×N marker's
 *  overhang included. */
export function pileHeight(pile: Pile, w: number): number {
  return (
    Math.round(w * ASPECT) + pile.attached.length * attachedPeek(w) + underOf(pile) * PILE + MARK
  );
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
  // The pile with the most attachments is the tallest.
  const most = piles.reduce((n, p) => Math.max(n, p.attached.length), 0);
  return Math.max(
    FLOOR,
    Math.min(max, tallestWidth(laneHeight, most), Math.floor(room / widths) - 1),
  );
}

/**
 * The widest an untapped card stands in a lane `laneHeight` px tall with `attached` cards tucked
 * under it: a tapped card is as tall as an untapped one is wide, so the lane's height bounds the
 * untapped card — its height plus a pile's edges, its attachments' edges and the marker must fit.
 * What a sparse row is drawn at, before its width shrinks it.
 */
export function tallestWidth(laneHeight: number, attached = 0): number {
  return Math.floor((laneHeight - UNDER * PILE - MARK) / (ASPECT + attached * ATTACHED));
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

/**
 * What one table has of the attachments that cross between tables: an Aura one player controls
 * on another player's creature is drawn under the creature, on the creature's table.
 */
export interface Across {
  /** Other tables' cards attached to one of this table's. */
  guests: readonly GameCard[];
  /** The other tables' permanents: this table's cards attached to one of them leave its lanes. */
  away: ReadonlySet<number>;
}

/** Each table's {@link Across}, in the order the tables were given. */
export function acrossTables(tables: readonly (readonly GameCard[])[]): Across[] {
  return tables.map((here, i) => {
    const ids = new Set(here.map((c) => c.id));
    const others = tables.filter((_, j) => j !== i).flat();
    return {
      guests: others.filter((c) => c.attachedTo !== null && ids.has(c.attachedTo)),
      away: new Set(others.map((c) => c.id)),
    };
  });
}

/**
 * The table's lanes and what rides under each card: `attached` by the id of the card each
 * attachment is drawn under, and the lanes without them. An attachment on an attachment (an Aura
 * on an Equipment) rides under the card at the bottom of the chain; one whose card is on no table
 * shown stays in its own lane.
 */
export function attachmentsOf(
  battlefield: readonly GameCard[],
  across?: Across,
): { lanes: GameCard[]; attached: Map<number, GameCard[]> } {
  const byId = new Map(battlefield.map((c) => [c.id, c]));
  const away = across?.away;
  const rides = (c: GameCard) =>
    c.attachedTo !== null && (byId.has(c.attachedTo) || away?.has(c.attachedTo) === true);
  /** The card at the bottom of `c`'s chain on this table, at most a few links down. */
  const root = (c: GameCard): number | null => {
    let at = c;
    for (let i = 0; i < 8 && at.attachedTo !== null; i++) {
      const next = byId.get(at.attachedTo);
      if (next === undefined) return away?.has(at.attachedTo) === true ? null : at.id;
      at = next;
    }
    return at.attachedTo === null ? at.id : null;
  };
  const attached = new Map<number, GameCard[]>();
  for (const c of [...battlefield, ...(across?.guests ?? [])]) {
    if (c.attachedTo === null) continue;
    const host = root(c);
    if (host === null || host === c.id) continue;
    attached.set(host, [...(attached.get(host) ?? []), c]);
  }
  return { lanes: battlefield.filter((c) => !rides(c)), attached };
}

export function layoutTable(
  battlefield: readonly GameCard[],
  { width, height }: { width: number; height: number },
  apart?: PileApart,
  across?: Across,
): TableLayout {
  const { lanes, attached } = attachmentsOf(battlefield, across);
  const creatures = pilesOf(lanes, "creature", apart, attached);
  const lands = pilesOf(lanes, "land", apart, attached);
  const others = pilesOf(lanes, "other", apart, attached);
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

/**
 * Which slot of a held hand of `count` a card let go at `x` takes — `x` in the row's own pixels
 * from its left edge (`handRow`). The slot whose card's middle is nearest the pointer, so a card
 * dropped over another card takes that card's place.
 */
export function handSlotAt(x: number, count: number): number {
  const { lefts } = handRow(count);
  let slot = 0;
  for (let i = 1; i < lefts.length; i++) {
    if (Math.abs(lefts[i] + HAND_CARD_W / 2 - x) < Math.abs(lefts[slot] + HAND_CARD_W / 2 - x)) {
      slot = i;
    }
  }
  return slot;
}

/**
 * The held order with `id` taken out and put back at `slot` (issue #1330): the reader reordering
 * their own hand, which is theirs to arrange at any moment of the game and asks the engine
 * nothing. A slot past either end is the end; an id not held leaves the order as it was.
 */
export function moveInHand(order: readonly number[], id: number, slot: number): number[] {
  if (!order.includes(id)) return [...order];
  const rest = order.filter((held) => held !== id);
  const at = Math.max(0, Math.min(slot, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
