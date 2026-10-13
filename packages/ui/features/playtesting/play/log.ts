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
 * `turn` on a line is the game's turn (`PlaytestView.turn`, both seats' turns counted), so the
 * log's headings follow the table's own "Turn 5".
 */
import type { GoldfishPlace, GoldfishSeat, PlaytestHappened } from "@/lib/ipc";
import { kindOf, sentence as goldfishSentence, type LogKind, type LogLine } from "../goldfish/log";
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
function movedSentence(seat: GoldfishSeat, name: string, from: GoldfishPlace, to: GoldfishPlace) {
  const you = seat === "you";
  if (from === "libraryTop" && to === "hand")
    return you ? `Drew ${name}` : "The opponent drew a card";
  if (from === "libraryTop" && to === "graveyard")
    return you ? `Milled ${name}` : `The opponent milled ${name}`;
  if (from === "hand" && to === "graveyard")
    return you ? `Discarded ${name}` : `The opponent discarded ${name}`;
  if (from === "battlefield" && to === "graveyard")
    return you
      ? `${name} went to your graveyard`
      : `The opponent's ${name} went to their graveyard`;
  if (to === "battlefield")
    return you
      ? `${name} entered the battlefield`
      : `The opponent's ${name} entered the battlefield`;
  if (to === "exile") return you ? `${name} was exiled` : `The opponent's ${name} was exiled`;
  return you ? `${name} to ${YOUR[to]}` : `The opponent's ${name} to ${THEIR[to]}`;
}

/** One fact, as a sentence, or `null` for a fact the log does not repeat. */
export function playtestSentence(h: PlaytestHappened): string | null {
  switch (h.type) {
    case "mulliganed":
    case "kept":
    case "put":
    case "tapped":
    case "untappedAll":
    case "counters":
    case "shuffled":
    case "lifeSet":
      return goldfishSentence(h);
    case "turnBegan":
      return h.seat === "you"
        ? `Your turn ${h.turn} begins`
        : `The opponent's turn ${h.turn} begins`;
    case "played":
      return h.seat === "you" ? `Played ${h.name}` : `The opponent played ${h.name}`;
    case "cast":
      return h.seat === "you" ? `Cast ${h.name}` : `The opponent cast ${h.name}`;
    case "activated":
      return h.seat === "you" ? `Activated ${h.name}` : `The opponent activated ${h.name}`;
    case "moved":
      return movedSentence(h.seat, h.name, h.from, h.to);
    case "drew":
      if (h.seat === "opponent") return "The opponent drew a card";
      return h.name === null ? "Drew a card" : `Drew ${h.name}`;
    case "attacked":
      return h.seat === "you"
        ? `Attacked with ${listed(h.names)}`
        : `The opponent attacked with ${listed(h.names)}`;
    case "blocked":
      return h.seat === "you"
        ? `Blocked ${h.attacker} with ${h.blocker}`
        : `The opponent blocked ${h.attacker} with ${h.blocker}`;
    case "dealt":
      return `${h.source} dealt ${h.amount} damage to ${h.target}`;
    case "life": {
      if (h.amount === 0) return null;
      const n = Math.abs(h.amount);
      const verb = h.amount < 0 ? "lost" : "gained";
      return h.seat === "you" ? `You ${verb} ${n} life` : `The opponent ${verb} ${n} life`;
    }
    case "tokensCreated": {
      const what = h.count === 1 ? `a ${h.name} token` : `${h.count} ${h.name} tokens`;
      return h.seat === "you" ? `Created ${what}` : `The opponent created ${what}`;
    }
    case "chose":
      return `The rules engine chose for you: ${promptTitle(h.what)}`;
    case "gameOver":
      return h.winner === "you"
        ? "You won"
        : h.winner === "opponent"
          ? "You lost"
          : "The game is a draw";
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
    case "lifeSet":
      return kindOf(h);
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
    case "gameOver":
      return "end";
  }
}

/**
 * The lines one step adds, newest first, ready to go on top of the log (`appendLog`). `turn` is
 * the turn the view after the step is on.
 *
 * **A `turnBegan` moves the turn for the lines after it.** One call can carry the end of the
 * reader's turn, the whole of the opponent's and the start of the reader's next, and a line is
 * filed under the turn it happened in — so the count starts from the step's first `turnBegan`
 * less one and follows each one, and only a step with none takes `turn` as it is.
 */
export function playtestLines(happened: readonly PlaytestHappened[], turn: number): LogLine[] {
  const first = happened.find((h) => h.type === "turnBegan");
  let now = first?.type === "turnBegan" ? Math.max(0, first.turn - 1) : turn;
  const out: LogLine[] = [];
  for (const h of happened) {
    if (h.type === "turnBegan") now = h.turn;
    const text = playtestSentence(h);
    if (text !== null) out.push({ turn: now, text, kind: playtestKind(h) });
  }
  return out.reverse();
}
