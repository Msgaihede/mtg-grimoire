/**
 * A card carried onto another card or a player (issue #1335) — the drag beside every click the
 * rules already have: attack by carrying a creature to the other side, block by carrying one onto
 * an attacker, equip, enchant or point a spell or an ability by carrying the card onto its target.
 *
 * **A drop is the same decision as the clicks, never a new one.** In the declare steps it makes
 * the reader's picks (`combat.ts`' {@link Picks}), which the stage button still declares as one
 * action; with priority it sends the `play` or `activate` a double-click or a menu sends, and
 * then answers the target question the engine asks with the card or player it was let go on
 * ({@link aimAnswer}). Nothing reaches the engine that a click could not have sent, so the
 * session's action model is untouched.
 *
 * **What a drop names is a target, never a guess at one.** The engine alone knows what a spell
 * or ability may target, and it says so only once asked. So a drop with priority is offered on
 * any card the table shows or any player, and when the question that comes back does not offer
 * the card it was let go on, nothing is chosen: the prompt stays for the reader, as it would have
 * after a click, and Cancel takes the cast back.
 */
import { useCallback, useEffect, useRef } from "react";
import type {
  GameCard,
  PlaytestAction,
  PlaytestPlayer,
  PlaytestPrompt,
  PlaytestView,
} from "@/lib/ipc";
import type { TableDrag } from "../table/tableDrag";
import { seatOf, type Picks } from "./combat";
import { pickableCards } from "./prompt";

/** What a card is let go on: a card on a table, by its id, or a player. */
export type AimAt = number | PlaytestPlayer;

/** What a drop does: new picks to declare, or an action and the target to answer it with. */
export type AimOutcome =
  { kind: "picks"; picks: Picks } | { kind: "act"; action: PlaytestAction; target: AimAt } | null;

/**
 * The reader's cards the rules let them pick up now, beside the sandbox's: in the declare steps
 * the creatures that may attack or block, and with priority (the main phase, a response) every
 * permanent but a land — a land's abilities are its mana, which a drag has no target for.
 */
export function canCarry(view: PlaytestView, card: Pick<GameCard, "id" | "isLand">): boolean {
  switch (view.stage) {
    case "attack":
      return view.attack?.attackers.some((a) => a.id === card.id) ?? false;
    case "block":
      return view.block?.blockers.some((b) => b.id === card.id) ?? false;
    case "main":
    case "respond":
      return !card.isLand;
    default:
      return false;
  }
}

/** A player sitting at this game: the reader, or one of the opponents still in it. */
function seated(view: PlaytestView, player: PlaytestPlayer): boolean {
  return player === "you" || view.opponents.some((o) => o.player === player && !o.out);
}

/**
 * What letting `drag` go over `at` asks — or `null`, when it asks nothing and the drop falls
 * through to whatever is under it. `felt` is a table's empty felt rather than a card on it, which
 * only an attack reads (as the player whose table it is).
 *
 * - **Declare attackers**: one of the reader's attackers onto an opponent — their plate, their
 *   felt or any card on their table — attacks that player; onto a planeswalker or battle it may
 *   attack, attacks it. What the rules do not allow is refused.
 * - **Declare blockers**: one of the reader's blockers onto an attacker it may block blocks it.
 * - **Priority** (the main phase, a response): a card from the hand or the command zone is
 *   played, and a permanent's ability activated, with the drop's card or player kept to answer
 *   the target question that follows. Never a land from the hand: dropped on a card it falls
 *   through to the table and is played, as it always was.
 *
 * A card is never let go on itself, and only one card is carried: a pile's top.
 */
export function aimDrop(
  view: PlaytestView,
  picks: Picks,
  drag: TableDrag,
  at: AimAt,
  felt = false,
): AimOutcome {
  const id = drag.ids[0];
  if (typeof at === "number" && drag.ids.includes(at)) return null;
  if (typeof at !== "number" && !seated(view, at)) return null;
  switch (view.stage) {
    case "attack": {
      if (drag.from !== "battlefield") return null;
      const can = view.attack?.attackers.find((a) => a.id === id);
      if (can === undefined) return null;
      let pair: Picks["attacks"][number] | null = null;
      if (typeof at === "number" && !felt && can.targets.includes(at)) {
        pair = { attacker: id, target: at, player: null };
      } else {
        const player = typeof at === "number" ? seatOf(view, at) : at;
        if (player !== null && player !== "you" && can.players.includes(player))
          pair = { attacker: id, target: null, player };
      }
      if (pair === null) return null;
      const attacks = picks.attacks.some((a) => a.attacker === id)
        ? picks.attacks.map((a) => (a.attacker === id ? pair : a))
        : [...picks.attacks, pair];
      return { kind: "picks", picks: { ...picks, attacks, aiming: null } };
    }
    case "block": {
      if (drag.from !== "battlefield" || typeof at !== "number" || felt) return null;
      const can = view.block?.blockers.find((b) => b.id === id);
      if (can === undefined || !can.attackers.includes(at)) return null;
      return {
        kind: "picks",
        picks: {
          ...picks,
          blocks: [...picks.blocks.filter((b) => b.blocker !== id), { blocker: id, attacker: at }],
          chosen: null,
        },
      };
    }
    case "main":
    case "respond": {
      if (felt) return null;
      if (typeof at === "number" && seatOf(view, at) === null) return null;
      const zone =
        drag.from === "hand"
          ? view.you.hand
          : drag.from === "command"
            ? view.you.command
            : drag.from === "battlefield"
              ? view.you.battlefield
              : null;
      const card = zone?.find((c) => c.id === id);
      if (card === undefined || card.isLand) return null;
      const action: PlaytestAction =
        drag.from === "battlefield" ? { type: "activate", id } : { type: "play", id };
      return { kind: "act", action, target: at };
    }
    default:
      return null;
  }
}

/**
 * One of the reader's attackers or blockers carried back onto their own table: taken off, as a
 * second click takes it off. `null` for any other drop, which asks nothing of the picks.
 */
export function retractDrop(view: PlaytestView, picks: Picks, drag: TableDrag): Picks | null {
  if (drag.from !== "battlefield") return null;
  const id = drag.ids[0];
  if (view.stage === "attack" && picks.attacks.some((a) => a.attacker === id)) {
    return {
      ...picks,
      attacks: picks.attacks.filter((a) => a.attacker !== id),
      aiming: picks.aiming === id ? null : picks.aiming,
    };
  }
  if (view.stage === "block" && (picks.blocks.some((b) => b.blocker === id) || picks.chosen === id))
    return { ...picks, blocks: picks.blocks.filter((b) => b.blocker !== id), chosen: null };
  return null;
}

/**
 * The answer to `prompt` that names exactly `target` — the option a click on that card (or a
 * press of that player's row) would have sent — or `null`.
 *
 * **Only a target question is answered**: `TargetSelection` and its kin. The questions that can
 * come first — which ability, which way to cast, X — are the reader's, and an answer that merely
 * mentions the card in another sense is never taken for a target.
 */
export function aimAnswer(prompt: PlaytestPrompt | null, target: AimAt): number | null {
  if (prompt === null || prompt.pick !== null || !prompt.kind.endsWith("TargetSelection"))
    return null;
  if (typeof target === "number") return pickableCards(prompt).get(target) ?? null;
  return (
    prompt.options.find(
      (o) => o.cards.length === 0 && o.players.length === 1 && o.players[0] === target,
    )?.index ?? null
  );
}

/**
 * The second half of a drop with priority: the target it was let go on, answered once the
 * engine asks for it. Returns `aim`, which the drop calls with its target and the view it was
 * made on, just before it sends its `play` or `activate`.
 *
 * - **A target question that offers the target** is answered with it, and the aim is spent.
 * - **Another question first** (which ability, how to cast it): the aim waits for the next one.
 * - **Anything but a question** — the spell went on the stack with no target, the equip had one
 *   legal target and the engine took it — spends the aim with nothing sent.
 * - **A refusal** comes back as the same view once the engine is no longer busy: spent too, so it
 *   cannot answer a later, unrelated cast.
 *
 * Held in a ref, not state: it draws nothing. A replay frame is never a question, and is waited
 * past rather than read as an answer.
 */
export function useAimFollowThrough(
  view: PlaytestView | null,
  busy: boolean,
  replaying: boolean,
  act: (action: PlaytestAction) => void,
): (target: AimAt, on: PlaytestView) => void {
  const held = useRef<{ target: AimAt; on: PlaytestView; asked: boolean } | null>(null);

  useEffect(() => {
    const aim = held.current;
    if (aim === null || replaying || view === null) return;
    if (busy) {
      aim.asked = true;
      return;
    }
    if (view === aim.on) {
      if (aim.asked) held.current = null;
      return;
    }
    // A new view: from here on the same view again is an answer the engine already gave.
    aim.on = view;
    aim.asked = false;
    if (view.stage !== "prompt") {
      held.current = null;
      return;
    }
    const index = aimAnswer(view.prompt, aim.target);
    if (index === null) return;
    held.current = null;
    act({ type: "choose", index });
  }, [view, busy, replaying, act]);

  return useCallback((target: AimAt, on: PlaytestView) => {
    held.current = { target, on, asked: false };
  }, []);
}
