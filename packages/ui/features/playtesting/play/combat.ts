/**
 * The playtest board's arithmetic, with nothing drawn: what the middle line says, which button
 * the foot offers, and what combat looks like on the two tables — the picks the reader is making
 * and the marks they leave.
 *
 * **The engine decides, the board only collects.** `view.attack` names the creatures that may
 * attack and what each may attack, and `view.block` what each blocker may block; the reader's
 * picks are kept here ({@link Picks}) until the one action that declares them all, because a
 * declaration is one decision in the rules (CR 508.1, 509.1) and the engine takes it whole.
 */
import type {
  PlaytestAction,
  PlaytestAttackPair,
  PlaytestBlockPair,
  PlaytestPlayer,
  PlaytestStage,
  PlaytestStopStep,
  PlaytestView,
} from "@/lib/ipc";
import type { CardMark } from "../goldfish/Battlefield";
import { playerName, playerPossessive } from "./players";
import { pickableCards } from "./prompt";

/** The reader's combat picks, until they are declared. */
export interface Picks {
  /** The creatures picked to attack and what each attacks, in the order they were picked. */
  attacks: PlaytestAttackPair[];
  /**
   * An attacker picked and waiting to be aimed — one that can attack a planeswalker or a battle
   * as well as (or instead of) a player, or more than one player. A click on one of its targets,
   * or on an opponent's plate, aims it there.
   */
  aiming: number | null;
  blocks: PlaytestBlockPair[];
  /** A blocker picked and waiting for the attacker it is to block. */
  chosen: number | null;
}

export const NO_PICKS: Picks = { attacks: [], aiming: null, blocks: [], chosen: null };

/**
 * One of the reader's creatures clicked in the declare-attackers step.
 *
 * - **Not attacking**: it attacks — the first player it can (in a duel, the opponent), else its
 *   first target — and, when it has anything else it could attack, it waits to be aimed.
 * - **Waiting to be aimed**: clicked again, it is put back.
 * - **Attacking, not waiting**: one with a choice waits to be aimed again; one without is put
 *   back.
 */
export function toggleAttacker(picks: Picks, view: PlaytestView, id: number): Picks {
  const can = view.attack?.attackers.find((a) => a.id === id);
  if (can === undefined) return picks;
  const aimable = can.targets.length + can.players.length > 1;
  const has = picks.attacks.some((a) => a.attacker === id);
  const without = {
    ...picks,
    attacks: picks.attacks.filter((a) => a.attacker !== id),
    aiming: null,
  };
  if (!has) {
    const player = can.players[0] ?? null;
    const target = player !== null ? null : (can.targets[0] ?? null);
    return {
      ...picks,
      attacks: [...picks.attacks, { attacker: id, target, player }],
      aiming: aimable ? id : null,
    };
  }
  if (picks.aiming === id || !aimable) return without;
  return { ...picks, aiming: id };
}

/**
 * Where the attacker waiting to be aimed attacks: a planeswalker's or battle's id, or a player —
 * taken only when the rules allow that attacker to attack it.
 */
export function aimAttacker(picks: Picks, view: PlaytestView, at: number | PlaytestPlayer): Picks {
  const id = picks.aiming;
  if (id === null) return picks;
  const can = view.attack?.attackers.find((a) => a.id === id);
  if (can === undefined) return picks;
  if (typeof at === "number" ? !can.targets.includes(at) : !can.players.includes(at)) return picks;
  const pair: PlaytestAttackPair =
    typeof at === "number"
      ? { attacker: id, target: at, player: null }
      : { attacker: id, target: null, player: at };
  return {
    ...picks,
    attacks: picks.attacks.map((a) => (a.attacker === id ? pair : a)),
    aiming: null,
  };
}

/** The players the attacker waiting to be aimed could attack: their plates are its targets. */
export function aimablePlayers(picks: Picks, view: PlaytestView): readonly PlaytestPlayer[] {
  if (picks.aiming === null) return [];
  return view.attack?.attackers.find((a) => a.id === picks.aiming)?.players ?? [];
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

/** The step a reader names, where the engine says which one it is: "upkeep", "declare blockers". */
const STEP: Record<PlaytestStopStep, string> = {
  upkeep: "upkeep",
  draw: "draw step",
  main1: "main phase",
  beginCombat: "beginning of combat",
  attackers: "declare attackers step",
  blockers: "declare blockers step",
  damage: "combat damage step",
  main2: "second main phase",
  end: "end step",
};

/**
 * "Turn 5 · Your main phase", "Turn 6 · Opponent's turn · Upkeep" ("Opponent 2's turn" at a
 * four-player table), and — when the reader holds priority with something to answer — "… — you
 * may respond". The step when the view names one, the phase otherwise (the untap step, the end
 * of combat, cleanup).
 */
export function phaseLine(view: PlaytestView): string {
  if (view.turn === 0) return "Opening hands";
  if (view.stage === "over") return `Turn ${view.turn} · Game over`;
  const phase = view.step === null ? PHASE[view.phase] : STEP[view.step];
  // A duel's one opponent is "Opponent" here, as the tracker's chip says it.
  const whose =
    view.opponents.length > 1 ? playerPossessive(view.active, view.opponents.length) : "Opponent's";
  const line =
    view.active === "you"
      ? `Turn ${view.turn} · Your ${phase}`
      : `Turn ${view.turn} · ${whose} turn · ${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
  return view.stage === "respond" ? `${line} — you may respond` : line;
}

/** Whose creature `id` is. */
export function seatOf(view: PlaytestView, id: number): PlaytestPlayer | null {
  if (view.you.battlefield.some((c) => c.id === id)) return "you";
  return view.opponents.find((s) => s.battlefield.some((c) => c.id === id))?.player ?? null;
}

/** The attacks on the table: the reader's picks while they declare, the engine's otherwise. */
export function attacksOf(view: PlaytestView, picks: Picks): readonly PlaytestAttackPair[] {
  return view.stage === "attack" ? picks.attacks : (view.combat?.attacks ?? []);
}

/** The blocks on the table: the reader's picks while they declare, the engine's otherwise. */
export function blocksOf(view: PlaytestView, picks: Picks): readonly PlaytestBlockPair[] {
  return view.stage === "block" ? picks.blocks : (view.combat?.blocks ?? []);
}

/**
 * The combat as one line — "You attack with 2 · 1 blocked", "The opponent attacks with 3 · you
 * block 1" ("Opponent 2 attacks with 3" at a four-player table) — or `null` with no combat on.
 * While the reader declares, it counts their picks.
 */
export function combatLine(view: PlaytestView, picks: Picks): string | null {
  const attacks = attacksOf(view, picks);
  if (attacks.length === 0) return null;
  const blocked = new Set(blocksOf(view, picks).map((b) => b.attacker)).size;
  const seat = seatOf(view, attacks[0].attacker);
  if (seat === "you") {
    return `You attack with ${attacks.length}${blocked > 0 ? ` · ${blocked} blocked` : ""}`;
  }
  const who = playerName(seat ?? "opponent", view.opponents.length);
  return `${who} attacks with ${attacks.length}${blocked > 0 ? ` · you block ${blocked}` : ""}`;
}

/** One of the foot's buttons: what it says, and what it asks. */
export interface StageButton {
  label: string;
  action: PlaytestAction;
  /** Drawn but not pressable: "Passing turn…" while the game passes on the reader's behalf. */
  disabled?: boolean;
}

/** The second button while the reader is already ending the turn: it says so, and waits. */
const PASSING: StageButton = {
  label: "Passing turn…",
  action: { type: "endTurn" },
  disabled: true,
};

/**
 * The foot's buttons for the stage the game is in — the goldfish's "Next turn", grown into the
 * decisions an opponent makes room for. The primary is Space's.
 *
 * - **Main phase one**: on to combat, or skip the attack and end the turn.
 * - **Main phase two**: end the turn.
 * - **Respond**: pass priority once, or pass until the turn changes.
 * - **Declare attackers**: attack with the creatures picked, or with none.
 * - **Declare blockers**: the blocks picked, or none.
 *
 * Nothing in the opening hand, a prompt (its panel answers it), a replay frame or a game that is
 * over. While the reader is ending the turn (`endingTurn`) the second button says so.
 */
export function stageButtons(
  view: PlaytestView,
  picks: Picks,
): { primary: StageButton | null; secondary: StageButton | null } {
  const stage: PlaytestStage = view.stage;
  switch (stage) {
    case "main":
      return view.phase === "main1"
        ? {
            primary: { label: "To combat", action: { type: "pass" } },
            secondary: view.endingTurn
              ? PASSING
              : { label: "End turn", action: { type: "endTurn" } },
          }
        : {
            primary: {
              label: view.phase === "main2" ? "End turn" : "Pass",
              action: { type: "pass" },
            },
            secondary: view.endingTurn ? PASSING : null,
          };
    case "respond":
      return {
        primary: { label: "Pass", action: { type: "pass" } },
        secondary: view.endingTurn ? PASSING : { label: "Pass turn", action: { type: "endTurn" } },
      };
    case "attack": {
      const n = picks.attacks.length;
      return {
        primary: {
          label: n === 0 ? "No attack" : `Attack with ${n}`,
          action: { type: "attack", attacks: picks.attacks },
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
    case "mulligan":
    case "prompt":
    case "watching":
    case "over":
      return { primary: null, secondary: null };
  }
}

/** Every table's marks, by player — empty for a player the game does not seat. */
export type SideMarks = Record<PlaytestPlayer, Map<number, CardMark>>;

/**
 * What combat looks like on the table: every attacker ringed and pushed forward, each block one
 * number on the blocker and the same number on its attacker, and a blocker waiting for its
 * attacker — or an attacker waiting to be aimed — ringed gold.
 *
 * In the attack step the attacks are the reader's picks; in the block step the blocks are; at any
 * other time both are the engine's (`view.combat`).
 */
export function tableMarks(view: PlaytestView, picks: Picks): SideMarks {
  const out: SideMarks = {
    you: new Map(),
    opponent: new Map(),
    opponent2: new Map(),
    opponent3: new Map(),
  };
  const put = (id: number, mark: CardMark) => {
    const seat = seatOf(view, id);
    if (seat !== null) out[seat].set(id, mark);
  };
  const numbers = new Map<number, string[]>();
  blocksOf(view, picks).forEach((b, i) => {
    const n = String(i + 1);
    numbers.set(b.attacker, [...(numbers.get(b.attacker) ?? []), n]);
    put(b.blocker, { tone: "block", badge: n, word: `blocking ${n}` });
  });
  for (const { attacker: id } of attacksOf(view, picks)) {
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
  if (view.stage === "attack" && picks.aiming !== null) {
    put(picks.aiming, { tone: "chosen", word: "attacking, pick what it attacks" });
  }
  return out;
}

/** Every table's pickable cards, by player — empty for a player the game does not seat. */
export type SidePicks = Record<PlaytestPlayer, Set<number>>;

/**
 * Which cards a click picks rather than taps: the creatures that may attack and — while one waits
 * to be aimed — the planeswalkers and battles it may attack; the creatures that may block and —
 * once one is waiting — the attackers it may block; and a prompt's one-card answers wherever on
 * the table they are.
 */
export function tablePicks(view: PlaytestView, picks: Picks): SidePicks {
  const out: SidePicks = {
    you: new Set(),
    opponent: new Set(),
    opponent2: new Set(),
    opponent3: new Set(),
  };
  const add = (id: number) => {
    const seat = seatOf(view, id);
    if (seat !== null) out[seat].add(id);
  };
  if (view.stage === "attack") {
    const attackers = view.attack?.attackers ?? [];
    attackers.forEach((a) => add(a.id));
    if (picks.aiming !== null)
      (attackers.find((a) => a.id === picks.aiming)?.targets ?? []).forEach(add);
  }
  if (view.stage === "block") {
    const blockers = view.block?.blockers ?? [];
    blockers.forEach((b) => add(b.id));
    if (picks.chosen !== null)
      (blockers.find((b) => b.id === picks.chosen)?.attackers ?? []).forEach(add);
  }
  if (view.stage === "prompt") [...pickableCards(view.prompt).keys()].forEach(add);
  return out;
}
