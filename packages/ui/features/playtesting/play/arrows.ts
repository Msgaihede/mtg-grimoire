/**
 * Combat and targets drawn as arrows — the geometry, with nothing drawn: which arrows the combat
 * and the stack make, and the curve each one takes between two boxes on the board.
 *
 * **An arrow joins two things the board has already drawn** (`Anchor`): a card on a table, found
 * by the `data-point` its pile carries, a card on the stack (`data-stack`, its stack item's id),
 * or a player's life plate (`data-plate`, the player's name: `you`, `opponent`, `opponent2`,
 * `opponent3`). An attacker points at the card it attacks or the plate of the player it attacks,
 * a blocker points at the attacker it blocks, and a spell or ability on the stack points at each
 * thing it targets (issue #1071). `BoardArrows` measures the anchors from the DOM; everything here
 * is a pure function of the boxes, so it is tested without one.
 */
import type { PlaytestPlayer, PlaytestView } from "@/lib/ipc";
import { attacksOf, blocksOf, seatOf, type Picks } from "./combat";

/** Something on the board an arrow or a pop is drawn at. */
export type Anchor = { card: number } | { stack: number } | { plate: PlaytestPlayer };

/** A box on the board, in px from the board's own corner. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** An arrow before it is measured: what it joins, and how it is coloured. */
export interface ArrowSpec {
  key: string;
  from: Anchor;
  to: Anchor;
  /**
   * Whose attack it draws — the reader's, or any opponent's — or a block; or whose spell or
   * ability on the stack it is that targets (`targetYou`, `targetOpponent`).
   */
  tone: "you" | "opponent" | "block" | "targetYou" | "targetOpponent";
}

/**
 * The arrows the combat makes. The attacks and blocks are read as `tableMarks` reads them: the
 * reader's picks while they are declaring, the engine's combat at any other time — so an attacker
 * picked in the declare-attackers step is drawn at what it will attack before it is declared. An
 * attack at a planeswalker or a battle points at that card; at a player, at their plate.
 *
 * **Every attack is drawn, the AIs' on one another too**: at a four-player table an opponent may
 * attack another, and that arrow runs between two of the opponents' areas in the attacker's red.
 * An attack that names no player (an older view, or a pick the engine is left to aim) points at
 * the reader's plate from an opponent's creature and at the first opponent's from the reader's.
 */
export function combatArrows(view: PlaytestView, picks: Picks): ArrowSpec[] {
  const out: ArrowSpec[] = [];
  for (const { attacker, target, player } of attacksOf(view, picks)) {
    const seat = seatOf(view, attacker);
    if (seat === null) continue;
    out.push({
      key: `attack-${attacker}`,
      from: { card: attacker },
      to:
        target !== null && seatOf(view, target) !== null
          ? { card: target }
          : { plate: player ?? (seat === "you" ? "opponent" : "you") },
      tone: seat === "you" ? "you" : "opponent",
    });
  }
  for (const b of blocksOf(view, picks)) {
    if (seatOf(view, b.blocker) === null || seatOf(view, b.attacker) === null) continue;
    out.push({
      key: `block-${b.blocker}-${b.attacker}`,
      from: { card: b.blocker },
      to: { card: b.attacker },
      tone: "block",
    });
  }
  return out;
}

/**
 * The arrows the stack makes: from each spell or ability on it to each thing it targets — a card
 * on a table, another spell on the stack (a counterspell's), or a player's plate — in its
 * controller's colour. Every target gets its arrow; one the board does not draw (an item below the
 * stack column's first few, a card in a pile under its top) has no box, so `BoardArrows` leaves
 * that arrow out.
 */
export function targetArrows(view: PlaytestView): ArrowSpec[] {
  const out: ArrowSpec[] = [];
  const onStack = new Set(view.stack.map((item) => item.id));
  for (const item of view.stack) {
    const tone = item.seat === "you" ? "targetYou" : "targetOpponent";
    for (const target of item.targets) {
      out.push({
        key: `target-${item.id}-${target}`,
        from: { stack: item.id },
        to: onStack.has(target) ? { stack: target } : { card: target },
        tone,
      });
    }
    for (const player of item.targetPlayers) {
      out.push({
        key: `target-${item.id}-${player}`,
        from: { stack: item.id },
        to: { plate: player },
        tone,
      });
    }
  }
  return out;
}

export function centre(box: Box): Point {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/**
 * Where a line from `box`'s centre toward `toward` leaves the box — so an arrow starts at a card's
 * edge rather than over its picture. A point inside the box (or at its centre) is the centre.
 */
export function edgePoint(box: Box, toward: Point): Point {
  const c = centre(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const t = Math.min(sx, sy, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** An arrow measured: the SVG path, its two ends and where its curve is pulled. */
export interface ArrowPath {
  d: string;
  start: Point;
  end: Point;
  control: Point;
}

/**
 * The curve from one box to another: from `from`'s edge to `to`'s edge, `gap` px short of each,
 * pulled sideways by `bend` of its length so two arrows into one plate fan rather than lie on one
 * another. A quadratic Bézier, the arrowhead the SVG's own marker at the end.
 */
export function arrowPath(from: Box, to: Box, { bend = 0.15, gap = 4 } = {}): ArrowPath {
  const a = edgePoint(from, centre(to));
  const b = edgePoint(to, centre(from));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const ux = length === 0 ? 0 : dx / length;
  const uy = length === 0 ? 0 : dy / length;
  const trim = Math.min(gap, length / 2);
  const start = { x: a.x + ux * trim, y: a.y + uy * trim };
  const end = { x: b.x - ux * trim, y: b.y - uy * trim };
  // The perpendicular, turned the same way for every arrow, so arrows from one row fan together.
  const control = {
    x: (start.x + end.x) / 2 - uy * length * bend,
    y: (start.y + end.y) / 2 + ux * length * bend,
  };
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M ${r(start.x)} ${r(start.y)} Q ${r(control.x)} ${r(control.y)} ${r(end.x)} ${r(end.y)}`,
    start,
    end,
    control,
  };
}

/** The selector an anchor's element is found by. A card is looked for on the two tables only,
 *  so a stack chip or a hand card with the same id is never the one an arrow points at; a stack
 *  item by its own `data-stack`. */
export function anchorSelector(anchor: Anchor): string {
  if ("card" in anchor) return `[data-table] [data-point="${anchor.card}"]`;
  if ("stack" in anchor) return `[data-stack="${anchor.stack}"]`;
  return `[data-plate="${anchor.plate}"]`;
}

/** An anchor's box on the board, or `null` when it is not drawn. */
export function measureAnchor(root: HTMLElement, anchor: Anchor): Box | null {
  const el = root.querySelector(anchorSelector(anchor));
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  const base = root.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
}
