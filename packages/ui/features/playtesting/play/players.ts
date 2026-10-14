/**
 * The players at the table, by name — who a sentence, a plate or a label is about.
 *
 * **A duel keeps its words.** With one opponent there is nobody to tell apart, so they are "the
 * opponent", as the board has always said. At a four-player table (issue #994) each is numbered
 * in turn order after the reader — **Opponent 1, 2 and 3**, the setup page's own names for the
 * three seats — rather than called by their deck: the same deck may sit in two seats, and a
 * number also says who plays next. The deck's name is on the plate beside the number.
 *
 * `opponents` is how many opponents the game has (`view.opponents.length`): 1 or 3.
 */
import type { PlaytestPlayer, PlaytestSeat, PlaytestView } from "@/lib/ipc";

/** Every opponent's player, in turn order after the reader. */
export const OPPONENTS: readonly PlaytestPlayer[] = ["opponent", "opponent2", "opponent3"];

/** An opponent's number at the table: 1, 2 or 3. */
export function opponentNumber(player: PlaytestPlayer): number {
  return OPPONENTS.indexOf(player) + 1;
}

/**
 * A player as a sentence's subject, at its start: "You", "The opponent" in a duel, "Opponent 2"
 * at a four-player table. `mid` is the same name inside a sentence ("the opponent").
 */
export function playerName(
  player: PlaytestPlayer,
  opponents: number,
  at: "start" | "mid" = "start",
): string {
  if (player === "you") return at === "start" ? "You" : "you";
  if (opponents <= 1) return at === "start" ? "The opponent" : "the opponent";
  return `Opponent ${opponentNumber(player)}`;
}

/** Whose a thing is: "Your", "The opponent's", "Opponent 2's" (and `mid`, inside a sentence). */
export function playerPossessive(
  player: PlaytestPlayer,
  opponents: number,
  at: "start" | "mid" = "start",
): string {
  if (player === "you") return at === "start" ? "Your" : "your";
  return `${playerName(player, opponents, at)}'s`;
}

/** A player's side of the table, or `undefined` for an opponent the game does not seat. */
export function seatOfPlayer(
  view: Pick<PlaytestView, "you" | "opponents">,
  player: PlaytestPlayer,
): PlaytestSeat | undefined {
  return player === "you" ? view.you : view.opponents.find((s) => s.player === player);
}

/** Every battlefield card on the table, the reader's first — for a card an answer names. */
export function tableCards(view: Pick<PlaytestView, "you" | "opponents">) {
  return [view.you, ...view.opponents].flatMap((s) => s.battlefield);
}
