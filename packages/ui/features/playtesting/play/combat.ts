/**
 * The playtest board's arithmetic, with nothing drawn: what the middle line says, which button
 * the foot offers, and what combat looks like on the two tables — the picks the reader is making
 * and the marks they leave.
 *
 * **The engine decides, the board only collects.** `view.attack` names the creatures that may
 * attack and `view.block` what each blocker may block; the reader's picks are kept here
 * ({@link Picks}) until the one action that declares them all, because a declaration is one
 * decision in the rules (CR 508.1, 509.1) and the engine takes it whole.
 */
import type { GoldfishSeat, PlaytestAction, PlaytestBlockPair, PlaytestView } from "@/lib/ipc";
import type { CardMark } from "../goldfish/Battlefield";
import { pickableCards } from "./prompt";

/** The reader's combat picks, until they are declared. */
export interface Picks {
  /** The creatures picked to attack, in the order they were picked. */
  attackers: number[];
  blocks: PlaytestBlockPair[];
  /** A blocker picked and waiting for the attacker it is to block. */
  chosen: number | null;
}

export const NO_PICKS: Picks = { attackers: [], blocks: [], chosen: null };

/** An attacker picked or put back. */
export function toggleAttacker(picks: Picks, id: number): Picks {
  return picks.attackers.includes(id)
    ? { ...picks, attackers: picks.attackers.filter((a) => a !== id) }
    : { ...picks, attackers: [...picks.attackers, id] };
}

/**
 * One of the reader's blockers clicked: a blocker already blocking is taken off its attacker, the
 * blocker waiting is put down, and any other is the one now waiting.
 */
export function pickBlocker(picks: Picks, id: number): Picks {
  if (picks.blocks.some((b) => b.blocker === id))
    return { ...picks, blocks: picks.blocks.filter((b) => b.blocker !== id), chosen: null };
  return { ...picks, chosen: picks.chosen === id ? null : id };
}

/** An opponent's attacker clicked while a blocker waits: the block, if the rules allow it. */
export function pickAttacker(picks: Picks, view: PlaytestView, attacker: number): Picks {
  const blocker = picks.chosen;
  if (blocker === null) return picks;
  const can = view.block?.blockers.find((b) => b.id === blocker)?.attackers ?? [];
  if (!can.includes(attacker)) return picks;
  return {
    ...picks,
    blocks: [...picks.blocks.filter((b) => b.blocker !== blocker), { blocker, attacker }],
    chosen: null,
  };
}

const PHASE: Record<PlaytestView["phase"], string> = {
  beginning: "beginning phase",
  main1: "main phase",
  combat: "combat",
  main2: "second main phase",
  ending: "end step",
};

/** "Turn 5 · Your main phase", "Turn 6 · Opponent's turn · Combat". */
export function phaseLine(view: PlaytestView): string {
  if (view.turn === 0) return "Opening hands";
  if (view.stage === "over") return `Turn ${view.turn} · Game over`;
  const phase = PHASE[view.phase];
  return view.active === "you"
    ? `Turn ${view.turn} · Your ${phase}`
    : `Turn ${view.turn} · Opponent's turn · ${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
}

/** Whose creature `id` is. */
export function seatOf(view: PlaytestView, id: number): GoldfishSeat | null {
  if (view.you.battlefield.some((c) => c.id === id)) return "you";
  if (view.opponent.battlefield.some((c) => c.id === id)) return "opponent";
  return null;
}

/**
 * The combat as one line — "You attack with 2 · 1 blocked", "The opponent attacks with 3 · you
 * block 1" — or `null` with no combat on. In the block step it counts the reader's picks, which
 * are the blocks that will be.
 */
export function combatLine(view: PlaytestView, picks: Picks): string | null {
  const attackers = view.combat?.attackers ?? [];
  if (attackers.length === 0) return null;
  const blocks = view.stage === "block" ? picks.blocks : (view.combat?.blocks ?? []);
  const blocked = new Set(blocks.map((b) => b.attacker)).size;
  if (seatOf(view, attackers[0]) === "you") {
    return `You attack with ${attackers.length}${blocked > 0 ? ` · ${blocked} blocked` : ""}`;
  }
  return `The opponent attacks with ${attackers.length}${blocked > 0 ? ` · you block ${blocked}` : ""}`;
}

/** One of the foot's buttons: what it says, and what it asks. */
export interface StageButton {
  label: string;
  action: PlaytestAction;
}

/**
 * The foot's buttons for the stage the game is in — the goldfish's "Next turn", grown into the
 * decisions an opponent makes room for. The primary is Space's.
 *
 * - **Main phase one**: on to combat, or skip the attack and end the turn.
 * - **Main phase two**: end the turn.
 * - **Declare attackers**: attack with the creatures picked, or with none.
 * - **Declare blockers**: the blocks picked, or none.
 *
 * Nothing in the opening hand, a prompt (its panel answers it) or a game that is over.
 */
export function stageButtons(
  view: PlaytestView,
  picks: Picks,
): { primary: StageButton | null; secondary: StageButton | null } {
  switch (view.stage) {
    case "main":
      return view.phase === "main1"
        ? {
            primary: { label: "To combat", action: { type: "pass" } },
            secondary: { label: "End turn", action: { type: "endTurn" } },
          }
        : {
            primary: {
              label: view.phase === "main2" ? "End turn" : "Pass",
              action: { type: "pass" },
            },
            secondary: null,
          };
    case "attack": {
      const n = picks.attackers.length;
      return {
        primary: {
          label: n === 0 ? "No attack" : `Attack with ${n}`,
          action: { type: "attack", attackers: picks.attackers },
        },
        secondary: null,
      };
    }
    case "block":
      return {
        primary: {
          label: picks.blocks.length === 0 ? "No blocks" : "Confirm blocks",
          action: { type: "block", blocks: picks.blocks },
        },
        secondary: null,
      };
    default:
      return { primary: null, secondary: null };
  }
}

/** Both tables' marks, by side. */
export interface SideMarks {
  you: Map<number, CardMark>;
  opponent: Map<number, CardMark>;
}

/**
 * What combat looks like on the table: every attacker ringed and pushed forward, each block one
 * number on the blocker and the same number on its attacker, and the blocker waiting for its
 * attacker ringed gold.
 *
 * In the attack step the attackers are the reader's picks; in the block step the blocks are; at
 * any other time both are the engine's (`view.combat`).
 */
export function tableMarks(view: PlaytestView, picks: Picks): SideMarks {
  const out: SideMarks = { you: new Map(), opponent: new Map() };
  const put = (id: number, mark: CardMark) => {
    const seat = seatOf(view, id);
    if (seat !== null) out[seat].set(id, mark);
  };
  const attackers = view.stage === "attack" ? picks.attackers : (view.combat?.attackers ?? []);
  const blocks = view.stage === "block" ? picks.blocks : (view.combat?.blocks ?? []);
  const numbers = new Map<number, string[]>();
  blocks.forEach((b, i) => {
    const n = String(i + 1);
    numbers.set(b.attacker, [...(numbers.get(b.attacker) ?? []), n]);
    put(b.blocker, { tone: "block", badge: n, word: `blocking ${n}` });
  });
  for (const id of attackers) {
    const by = numbers.get(id);
    put(
      id,
      by === undefined
        ? { tone: "attack", word: "attacking" }
        : { tone: "attack", badge: by.join("·"), word: `attacking, blocked ${by.join(" and ")}` },
    );
  }
  if (view.stage === "block" && picks.chosen !== null) {
    put(picks.chosen, { tone: "chosen", word: "picked to block" });
  }
  return out;
}

/** Both tables' pickable cards, by side. */
export interface SidePicks {
  you: Set<number>;
  opponent: Set<number>;
}

/**
 * Which cards a click picks rather than taps: the creatures that may attack, the creatures that
 * may block and — once one is waiting — the attackers it may block, and a prompt's one-card
 * answers wherever on the table they are.
 */
export function tablePicks(view: PlaytestView, picks: Picks): SidePicks {
  const out: SidePicks = { you: new Set(), opponent: new Set() };
  const add = (id: number) => {
    const seat = seatOf(view, id);
    if (seat !== null) out[seat].add(id);
  };
  if (view.stage === "attack") (view.attack?.attackers ?? []).forEach(add);
  if (view.stage === "block") {
    const blockers = view.block?.blockers ?? [];
    blockers.forEach((b) => add(b.id));
    if (picks.chosen !== null)
      (blockers.find((b) => b.id === picks.chosen)?.attackers ?? []).forEach(add);
  }
  if (view.stage === "prompt") [...pickableCards(view.prompt).keys()].forEach(add);
  return out;
}
