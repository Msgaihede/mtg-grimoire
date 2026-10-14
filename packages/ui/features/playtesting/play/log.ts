/**
 * The playtest log's sentences — what an action, the opponent's turn after it and the rules in
 * between did, as a reader would say it.
 *
 * **The goldfish's log, with a second player in it.** The lines are the goldfish's `LogLine`, cut
 * into turns by the same `byTurn` and drawn by the same `LogPanel`; the facts the two wires share
 * — a card put down by hand, a tap, a counter, a life total set — are worded by the goldfish's own
 * `sentence`, so one fact never reads two ways on two boards. What is new is whose doing it was:
 * the reader's lines read the goldfish's way ("Cast Sol Ring", "Drew Forest") and the opponent's
 * name them ("The opponent cast Lightning Bolt", "The opponent drew a card" — the wire never says
 * what they drew).
 *
 * **At a four-player table each opponent is named** (`players.ts`): "Opponent 2 cast Lightning
 * Bolt", where a duel's single opponent stays "the opponent". A player knocked out is told as
 * `eliminated` — "Opponent 3 is out", and "You are out", which ends the reader's game.
 *
 * `turn` on a line is the game's turn (`PlaytestView.turn`, every seat's turns counted), so the
 * log's headings follow the table's own "Turn 5".
 */
import type { GoldfishPlace, PlaytestHappened, PlaytestPlayer } from "@/lib/ipc";
import {
  kindOf,
  lifeSentence,
  sentence as goldfishSentence,
  type LogKind,
  type LogLine,
} from "../goldfish/log";
import { playerName, playerPossessive } from "./players";
import { promptTitle } from "./prompt";

/** Where a card of the reader's went, as the end of a sentence. */
const YOUR: Record<GoldfishPlace, string> = {
  hand: "your hand",
  battlefield: "the battlefield",
  graveyard: "your graveyard",
  exile: "exile",
  command: "the command zone",
  libraryTop: "the top of your library",
  libraryBottom: "the bottom of your library",
};

/** Where a card of the opponent's went. */
const THEIR: Record<GoldfishPlace, string> = {
  hand: "their hand",
  battlefield: "the battlefield",
  graveyard: "their graveyard",
  exile: "exile",
  command: "the command zone",
  libraryTop: "the top of their library",
  libraryBottom: "the bottom of their library",
};

/** "Goblin Guide", "Goblin Guide and Ragavan", "A, B and C". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "nothing";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A rules move of a card, by whose card it was: a draw, a discard, a death, an arrival. */
function movedSentence(
  seat: PlaytestPlayer,
  name: string,
  from: GoldfishPlace,
  to: GoldfishPlace,
  opponents: number,
) {
  const you = seat === "you";
  const who = playerName(seat, opponents);
  const whose = playerPossessive(seat, opponents);
  if (from === "libraryTop" && to === "hand") return you ? `Drew ${name}` : `${who} drew a card`;
  if (from === "libraryTop" && to === "graveyard")
    return you ? `Milled ${name}` : `${who} milled ${name}`;
  if (from === "hand" && to === "graveyard")
    return you ? `Discarded ${name}` : `${who} discarded ${name}`;
  if (from === "battlefield" && to === "graveyard")
    return you ? `${name} went to your graveyard` : `${whose} ${name} went to their graveyard`;
  if (to === "battlefield")
    return you ? `${name} entered the battlefield` : `${whose} ${name} entered the battlefield`;
  if (to === "exile") return you ? `${name} was exiled` : `${whose} ${name} was exiled`;
  return you ? `${name} to ${YOUR[to]}` : `${whose} ${name} to ${THEIR[to]}`;
}

/**
 * One fact, as a sentence, or `null` for a fact the log does not repeat. `opponents` is how many
 * the game has: one keeps the duel's "The opponent", three name each ("Opponent 2 cast …").
 */
export function playtestSentence(h: PlaytestHappened, opponents = 1): string | null {
  switch (h.type) {
    case "mulliganed":
    case "kept":
    case "put":
    case "tapped":
    case "untappedAll":
    case "counters":
    case "shuffled":
      return goldfishSentence(h);
    case "lifeSet":
      return lifeSentence(
        h.seat === "you" ? "you" : "opponent",
        h.was,
        h.life,
        playerName(h.seat, opponents),
      );
    case "turnBegan":
      return h.seat === "you"
        ? `Your turn ${h.turn} begins`
        : `${playerPossessive(h.seat, opponents)} turn ${h.turn} begins`;
    case "played":
      return h.seat === "you"
        ? `Played ${h.name}`
        : `${playerName(h.seat, opponents)} played ${h.name}`;
    case "cast":
      return h.seat === "you"
        ? `Cast ${h.name}`
        : `${playerName(h.seat, opponents)} cast ${h.name}`;
    case "activated":
      return h.seat === "you"
        ? `Activated ${h.name}`
        : `${playerName(h.seat, opponents)} activated ${h.name}`;
    case "moved":
      return movedSentence(h.seat, h.name, h.from, h.to, opponents);
    case "drew":
      if (h.seat !== "you") return `${playerName(h.seat, opponents)} drew a card`;
      return h.name === null ? "Drew a card" : `Drew ${h.name}`;
    case "attacked":
      return h.seat === "you"
        ? `Attacked with ${listed(h.names)}`
        : `${playerName(h.seat, opponents)} attacked with ${listed(h.names)}`;
    case "blocked":
      return h.seat === "you"
        ? `Blocked ${h.attacker} with ${h.blocker}`
        : `${playerName(h.seat, opponents)} blocked ${h.attacker} with ${h.blocker}`;
    case "dealt":
      return `${h.source} dealt ${h.amount} damage to ${h.target}`;
    case "life": {
      if (h.amount === 0) return null;
      const n = Math.abs(h.amount);
      const verb = h.amount < 0 ? "lost" : "gained";
      const to = h.amount < 0 ? `down to ${h.total}` : `up to ${h.total}`;
      return `${playerName(h.seat, opponents)} ${verb} ${n}, ${to}`;
    }
    case "tokensCreated": {
      const what = h.count === 1 ? `a ${h.name} token` : `${h.count} ${h.name} tokens`;
      return h.seat === "you"
        ? `Created ${what}`
        : `${playerName(h.seat, opponents)} created ${what}`;
    }
    case "chose":
      return `The rules engine chose for you: ${promptTitle(h.what)}`;
    case "eliminated":
      // The reader's own is the end of their game: the others play on without them, unseen.
      return h.seat === "you" ? "You are out" : `${playerName(h.seat, opponents)} is out`;
    case "gameOver":
      // A duel's loss is the reader's; at a four-player table the winner is named.
      return h.winner === "you"
        ? "You won"
        : h.winner === null
          ? "The game is a draw"
          : opponents <= 1
            ? "You lost"
            : `${playerName(h.winner, opponents)} won`;
  }
}

/** The kind of line one fact makes, for its glyph in the log. */
export function playtestKind(h: PlaytestHappened): LogKind {
  switch (h.type) {
    case "mulliganed":
    case "kept":
    case "put":
    case "tapped":
    case "untappedAll":
    case "counters":
    case "shuffled":
      return kindOf(h);
    case "lifeSet":
      return "life";
    case "turnBegan":
      return "turn";
    case "played":
      return "land";
    case "cast":
    case "activated":
      return "cast";
    case "moved":
      return h.from === "libraryTop" && h.to === "hand" ? "draw" : "move";
    case "drew":
      return "draw";
    case "attacked":
    case "blocked":
    case "dealt":
      return "combat";
    case "life":
      return "life";
    case "tokensCreated":
      return "token";
    case "chose":
      return "engine";
    case "eliminated":
    case "gameOver":
      return "end";
  }
}

/**
 * The lines one step adds, newest first, ready to go on top of the log (`appendLog`). `turn` is
 * the turn the view after the step is on, and `opponents` how many opponents the game has.
 *
 * **A `turnBegan` moves the turn for the lines after it.** One call can carry the end of the
 * reader's turn, the whole of the opponent's and the start of the reader's next, and a line is
 * filed under the turn it happened in — so the count starts from the step's first `turnBegan`
 * less one and follows each one, and only a step with none takes `turn` as it is.
 */
export function playtestLines(
  happened: readonly PlaytestHappened[],
  turn: number,
  opponents = 1,
): LogLine[] {
  const first = happened.find((h) => h.type === "turnBegan");
  let now = first?.type === "turnBegan" ? Math.max(0, first.turn - 1) : turn;
  const out: LogLine[] = [];
  for (const h of happened) {
    if (h.type === "turnBegan") now = h.turn;
    const text = playtestSentence(h, opponents);
    if (text !== null) out.push({ turn: now, text, kind: playtestKind(h) });
  }
  return out.reverse();
}
