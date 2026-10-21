/**
 * The game log's sentences — what an action, the opponents' turns after it and the rules in
 * between did, as a reader would say it. One game, goldfish or AI, and so one log: every fact on
 * the wire (`PlaytestHappened`) is worded here, and nowhere else.
 *
 * **The reader's own lines read the way the old goldfish board's did** ("Cast Sol Ring",
 * "Drew Forest", "Put Sol Ring onto the battlefield", "Tapped 2 × Forest", "Tarmogoyf has 2
 * +1/+1 counters", "Kept six · put one on the bottom"), so nothing a reader of either old board
 * was used to reads differently on the one board. What a second player adds is whose doing it
 * was: an opponent's lines name them ("The opponent cast Lightning Bolt", "The opponent drew a
 * card" — the wire never says what they drew), and so does a sandbox edit of an opponent's card
 * ("Put the opponent's Grizzly Bears into their graveyard", "Tapped the opponent's Llanowar
 * Elves").
 *
 * **At a four-player table each opponent is named** (`players.ts`): "Opponent 2 cast Lightning
 * Bolt", where a duel's single opponent — the goldfish included — stays "the opponent". A player
 * knocked out is told as `eliminated` — "Opponent 3 is out", and "You are out", which ends the
 * reader's game.
 *
 * `turn` on a line is the game's turn (`PlaytestView.turn`, every seat's turns counted), so the
 * log's headings follow the table's own "Turn 5".
 */
import type { GamePlace, PlaytestHappened, PlaytestPlayer } from "@/lib/ipc";
import { lifeSentence, type LogKind, type LogLine } from "../table/log";
import { playerName, playerPossessive } from "./players";
import { promptTitle } from "./prompt";

/** Where a card of the reader's went, as the end of a sentence. */
const YOUR: Record<GamePlace, string> = {
  hand: "your hand",
  battlefield: "the battlefield",
  graveyard: "your graveyard",
  exile: "exile",
  command: "the command zone",
  libraryTop: "the top of your library",
  libraryBottom: "the bottom of your library",
};

/** Where a card of the opponent's went. */
const THEIR: Record<GamePlace, string> = {
  hand: "their hand",
  battlefield: "the battlefield",
  graveyard: "their graveyard",
  exile: "exile",
  command: "the command zone",
  libraryTop: "the top of their library",
  libraryBottom: "the bottom of their library",
};

/**
 * Where the reader put a card of their own by hand, as the end of "Sol Ring to …" — the goldfish
 * board's words, kept as they were (a sandbox move says "the graveyard", where a rules move says
 * "your graveyard").
 */
const PUT_YOURS: Record<GamePlace, string> = {
  hand: "your hand",
  battlefield: "the battlefield",
  graveyard: "the graveyard",
  exile: "exile",
  command: "the command zone",
  libraryTop: "the top of the library",
  libraryBottom: "the bottom of the library",
};

/** Where the reader put an opponent's card by hand, as the end of "Put the opponent's X …". */
const PUT_THEIRS: Record<GamePlace, string> = {
  hand: "into their hand",
  battlefield: "onto the battlefield",
  graveyard: "into their graveyard",
  exile: "into exile",
  command: "into the command zone",
  libraryTop: "on top of their library",
  libraryBottom: "on the bottom of their library",
};

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven"];
/** "seven", "eight" written as a number past the words a reader expects to see spelled. */
function spelled(n: number): string {
  return COUNT[n] ?? String(n);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Goblin Guide", "Goblin Guide and Ragavan", "A, B and C". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "nothing";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A rules move of a card, by whose card it was: a draw, a discard, a death, an arrival. A card
 * with no `name` is an opponent's that went face down ("The opponent's face-down card was
 * exiled"): the wire never says what it is.
 */
function movedSentence(
  seat: PlaytestPlayer,
  named: string | null,
  from: GamePlace,
  to: GamePlace,
  opponents: number,
) {
  const you = seat === "you";
  const who = playerName(seat, opponents);
  const whose = playerPossessive(seat, opponents);
  const name = named ?? "face-down card";
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
 * A card the reader put somewhere by hand (the sandbox), by whose card it was. The reader's own
 * read the goldfish board's way: a card put down onto the battlefield, a spell put down unpaid
 * ("Cast Ponder · not paid for" — a hand or command card put straight into the graveyard is the
 * sandbox's spell cast for free), anything else "Sol Ring to the bottom of the library". An
 * opponent's is put with its owner's name, into their own zones.
 */
function putSentence(
  seat: PlaytestPlayer,
  name: string,
  from: GamePlace,
  to: GamePlace,
  opponents: number,
) {
  if (seat !== "you")
    return `Put ${playerPossessive(seat, opponents, "mid")} ${name} ${PUT_THEIRS[to]}`;
  if ((from === "hand" || from === "command") && to === "battlefield")
    return `Put ${name} onto the battlefield`;
  if ((from === "hand" || from === "command") && to === "graveyard")
    return `Cast ${name} · not paid for`;
  return `${name} to ${PUT_YOURS[to]}`;
}

/** A tap or an untap by hand: "Tapped 2 × Forest", "Untapped the opponent's Llanowar Elves". */
function tappedSentence(
  seat: PlaytestPlayer,
  name: string,
  count: number,
  tapped: boolean,
  opponents: number,
) {
  const verb = tapped ? "Tapped" : "Untapped";
  const whose = seat === "you" ? "" : `${playerPossessive(seat, opponents, "mid")} `;
  return count === 1 ? `${verb} ${whose}${name}` : `${verb} ${whose}${count} × ${name}`;
}

/** A card's counters after a change by hand: "Tarmogoyf has 2 +1/+1 counters", "Opponent 2's
 *  Tarmogoyf has no +1/+1 counters". */
function countersSentence(
  seat: PlaytestPlayer,
  name: string,
  kind: string,
  count: number,
  opponents: number,
) {
  const card = seat === "you" ? name : `${playerPossessive(seat, opponents)} ${name}`;
  return count === 0
    ? `${card} has no ${kind} counters`
    : `${card} has ${plural(count, `${kind} counter`)}`;
}

/**
 * One fact, as a sentence, or `null` for a fact the log does not repeat. `opponents` is how many
 * the game has: one keeps the duel's "The opponent", three name each ("Opponent 2 cast …").
 * `goldfish` is a game against the goldfish, whose fatal blow is said as the old goldfish board said
 * it — "The opponent is dead" — since no `eliminated` follows.
 */
export function playtestSentence(
  h: PlaytestHappened,
  opponents = 1,
  goldfish = false,
): string | null {
  switch (h.type) {
    case "mulliganed":
      return `Mulligan ${h.mulligans} · drew seven`;
    case "kept":
      return h.bottomed === 0
        ? `Kept ${spelled(h.size)}`
        : `Kept ${spelled(h.size)} · put ${spelled(h.bottomed)} on the bottom`;
    case "put":
      return putSentence(h.seat, h.name, h.from, h.to, opponents);
    case "tapped":
      return tappedSentence(h.seat, h.name, h.count, h.tapped, opponents);
    case "untappedAll":
      return "Untapped everything";
    case "counters":
      return countersSentence(h.seat, h.name, h.kind, h.count, opponents);
    case "shuffled":
      return "Shuffled the library";
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
      if (h.name === null) return `${playerName(h.seat, opponents)} cast a face-down spell`;
      return h.seat === "you"
        ? `Cast ${h.name}`
        : `${playerName(h.seat, opponents)} cast ${h.name}`;
    case "activated":
      return h.seat === "you"
        ? `Activated ${h.name}`
        : `${playerName(h.seat, opponents)} activated ${h.name}`;
    case "foretold":
      if (h.seat !== "you") return `${playerName(h.seat, opponents)} foretold a card`;
      return h.name === null ? "Foretold a card" : `Foretold ${h.name}`;
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
      // The goldfish cannot lose, so nothing else says it would have: its plate's "dead on your
      // turn N" and this line, the old goldfish board's words for the blow that got it there.
      if (goldfish && h.seat !== "you" && h.total <= 0 && h.total - h.amount > 0)
        return `${playerName(h.seat, opponents)} is dead`;
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
    case "emblem": {
      const what = h.source === null ? "an emblem" : `an emblem from ${h.source}`;
      return h.seat === "you" ? `Got ${what}` : `${playerName(h.seat, opponents)} got ${what}`;
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
      return "deal";
    case "put":
      // A spell put down unpaid is a cast, as its line says; any other placing is a move.
      return h.to === "graveyard" && (h.from === "hand" || h.from === "command") ? "cast" : "move";
    case "tapped":
    case "untappedAll":
      return "tap";
    case "counters":
      return "counter";
    case "shuffled":
      return "shuffle";
    case "lifeSet":
      return "life";
    case "turnBegan":
      return "turn";
    case "played":
      return "land";
    case "cast":
    case "activated":
    case "foretold":
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
    case "emblem":
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
 * the turn the view after the step is on, `opponents` how many opponents the game has, and
 * `goldfish` whether the one opponent is the goldfish (`PlaytestView.goldfish`).
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
  goldfish = false,
): LogLine[] {
  const first = happened.find((h) => h.type === "turnBegan");
  let now = first?.type === "turnBegan" ? Math.max(0, first.turn - 1) : turn;
  const out: LogLine[] = [];
  for (const h of happened) {
    if (h.type === "turnBegan") now = h.turn;
    const text = playtestSentence(h, opponents, goldfish);
    if (text !== null) out.push({ turn: now, text, kind: playtestKind(h) });
  }
  return out.reverse();
}
