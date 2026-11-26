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
 * **What only the game itself does is said with its subject, the reader's too**: "You won the
 * flip", "You rolled 4 on a d6", "You named Lightning Bolt", "You became the monarch", "The Ring
 * tempted you", "It became night" — there is no action of the reader's for the line to echo.
 * So is what the rules did to a card, whoever's it is: "Tarmogoyf got two +1/+1 counters",
 * "Llanowar Elves became tapped", "Soul Warden's ability triggered", "Grizzly Bears was
 * destroyed", "The opponent gained control of Grizzly Bears" — where a sandbox edit of the same
 * reads as the reader's own doing ("Tapped Llanowar Elves").
 *
 * `turn` on a line is the game's turn (`PlaytestView.turn`, every seat's turns counted), so the
 * log's headings follow the table's own "Turn 5".
 */
import type {
  GameManaKind,
  GamePlace,
  PlaytestClash,
  PlaytestDesignation,
  PlaytestHappened,
  PlaytestPlayer,
  PlaytestPlayerCounter,
  PlaytestRemoval,
  PlaytestTally,
} from "@/lib/ipc";
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
  // A draw is told as `drew`; a card from the library to the hand otherwise is a search's find
  // (a tutor), named for an opponent's only when it was revealed.
  if (from === "libraryTop" && to === "hand") {
    const card = named ?? "a card";
    return you
      ? `Put ${card} from your library into your hand`
      : `${who} put ${card} from their library into their hand`;
  }
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
  if ((from === "hand" || from === "command") && to === "graveyard") return `Cast ${name} · unpaid`;
  return `${name} to ${PUT_YOURS[to]}`;
}

/** A card the rules moved for a reason: "Grizzly Bears was destroyed", "The opponent sacrificed
 *  Food", "Cycled Lórien Revealed", "The opponent discarded Lightning Bolt". A destroyed or
 *  sacrificed card that went somewhere other than a graveyard says where. */
function removedSentence(
  seat: PlaytestPlayer,
  named: string | null,
  how: PlaytestRemoval,
  to: GamePlace,
  opponents: number,
) {
  const you = seat === "you";
  const who = playerName(seat, opponents);
  const name = named ?? "a face-down card";
  const where = to === "graveyard" ? "" : ` · to ${(you ? YOUR : THEIR)[to]}`;
  switch (how) {
    case "destroyed": {
      const card = you
        ? (named ?? "Your face-down card")
        : `${playerPossessive(seat, opponents)} ${named ?? "face-down card"}`;
      return `${card} was destroyed${where}`;
    }
    case "sacrificed":
      return `${you ? "Sacrificed" : `${who} sacrificed`} ${name}${where}`;
    case "cycled":
      return you ? `Cycled ${name}` : `${who} cycled ${name}`;
    case "discarded":
      return `${you ? "Discarded" : `${who} discarded`} ${name}${where}`;
  }
}

/** A card the rules gave to a player (CR 108.4): "The opponent gained control of Grizzly Bears",
 *  "You gained control of Opponent 2's Hill Giant", "You regained control of Grizzly Bears". */
function controlledByRulesSentence(
  seat: PlaytestPlayer,
  name: string,
  controller: PlaytestPlayer,
  opponents: number,
) {
  const who = playerName(controller, opponents);
  if (controller === seat) return `${who} regained control of ${name}`;
  const whose = seat === "you" ? "your" : playerPossessive(seat, opponents, "mid");
  return `${who} gained control of ${whose} ${name}`;
}

/** Whose permanent it is, as the start of a sentence: "Tarmogoyf", "The opponent's Tarmogoyf",
 *  and a face-down one of an opponent's as just that. */
function permanent(seat: PlaytestPlayer, name: string | null, opponents: number) {
  if (seat === "you") return name ?? "Your face-down permanent";
  return `${playerPossessive(seat, opponents)} ${name ?? "face-down permanent"}`;
}

/** "Tarmogoyf got two +1/+1 counters", "The opponent's Jace lost one loyalty counter". */
function countersChangedSentence(
  seat: PlaytestPlayer,
  name: string | null,
  kind: string,
  delta: number,
  opponents: number,
) {
  const n = Math.abs(delta);
  const what = `${spelled(n)} ${kind} counter${n === 1 ? "" : "s"}`;
  return `${permanent(seat, name, opponents)} ${delta >= 0 ? "got" : "lost"} ${what}`;
}

/** "Llanowar Elves became tapped", "The opponent's Grizzly Bears and Hill Giant became untapped". */
function becameTappedSentence(
  seat: PlaytestPlayer,
  names: readonly (string | null)[],
  tapped: boolean,
  opponents: number,
) {
  const shown = names.map((n) => n ?? "a face-down permanent");
  const cards =
    seat === "you" ? listed(shown) : `${playerPossessive(seat, opponents)} ${listed(shown)}`;
  return `${cards} became ${tapped ? "tapped" : "untapped"}`;
}

/** "Rancor was attached to Grizzly Bears", "Bonesplitter was unattached from the opponent's
 *  Hill Giant", "Curse of Opulence was attached to Opponent 2". */
function attachedSentence(
  seat: PlaytestPlayer,
  name: string,
  to: string | null,
  toSeat: PlaytestPlayer,
  attached: boolean,
  opponents: number,
) {
  const what = seat === "you" ? name : `${playerPossessive(seat, opponents)} ${name}`;
  const onto =
    to === null
      ? playerName(toSeat, opponents, "mid")
      : toSeat === "you"
        ? to
        : `${playerPossessive(toSeat, opponents, "mid")} ${to}`;
  return attached ? `${what} was attached to ${onto}` : `${what} was unattached from ${onto}`;
}

const PLAYER_COUNTER: Record<Exclude<PlaytestPlayerCounter, "speed">, string> = {
  poison: "poison counter",
  energy: "energy",
  experience: "experience counter",
  rad: "rad counter",
  ticket: "ticket",
};

/** "You got two energy, up to 5", "The opponent got one poison counter, up to 3", "Your speed
 *  is now 2". */
function playerCountersSentence(
  seat: PlaytestPlayer,
  kind: PlaytestPlayerCounter,
  delta: number,
  total: number,
  opponents: number,
) {
  if (kind === "speed") {
    const whose = seat === "you" ? "Your" : playerPossessive(seat, opponents);
    return `${whose} speed is now ${total}`;
  }
  const n = Math.abs(delta);
  const noun = PLAYER_COUNTER[kind];
  // Energy is a count of its own ("two energy"); the rest are counters ("two poison counters").
  const what =
    kind === "energy" ? `${spelled(n)} ${noun}` : `${spelled(n)} ${noun}${n === 1 ? "" : "s"}`;
  const verb = delta >= 0 ? "got" : "lost";
  const now = delta >= 0 ? `up to ${total}` : `down to ${total}`;
  return `${playerName(seat, opponents)} ${verb} ${what}, ${now}`;
}

/** "Lightning Bolt 2 · Counterspell 1". */
function talliesSentence(tallies: readonly PlaytestTally[]) {
  const counted = tallies.map((t) => `${t.choice} ${t.votes}`).join(" · ");
  return counted === "" ? "The vote is in" : `The vote is in: ${counted}`;
}

/** "You won a clash with the opponent (3 to 1)", "Opponent 2 tied a clash with you". */
function clashedSentence(
  seat: PlaytestPlayer,
  withSeat: PlaytestPlayer,
  mine: number | null,
  theirs: number | null,
  result: PlaytestClash,
  opponents: number,
) {
  const verb = result === "won" ? "won" : result === "lost" ? "lost" : "tied";
  const values = mine === null || theirs === null ? "" : ` (${mine} to ${theirs})`;
  return `${playerName(seat, opponents)} ${verb} a clash with ${playerName(withSeat, opponents, "mid")}${values}`;
}

/**
 * A card put under a player's control by hand (issue #1713), by whose card it is and who has it
 * now. On the battlefield it is a change of control alone — "Gained control of the opponent's
 * Hill Giant", "Gave Grizzly Bears to the opponent", "Gave the opponent's Hill Giant back",
 * "Regained control of Grizzly Bears"; from anywhere else it is put onto the battlefield, as a
 * reanimation says it — "Put the opponent's Hill Giant onto the battlefield under your control".
 */
function controlledSentence(
  seat: PlaytestPlayer,
  name: string,
  from: GamePlace,
  controller: PlaytestPlayer,
  opponents: number,
) {
  const whose = seat === "you" ? "" : `${playerPossessive(seat, opponents, "mid")} `;
  if (from !== "battlefield")
    return `Put ${whose}${name} onto the battlefield under ${playerPossessive(controller, opponents, "mid")} control`;
  if (controller === "you")
    return seat === "you" ? `Regained control of ${name}` : `Gained control of ${whose}${name}`;
  if (controller === seat) return `Gave ${whose}${name} back`;
  return `Gave ${whose}${name} to ${playerName(controller, opponents, "mid")}`;
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

/** "Added two green mana to your pool", "Took one colorless mana from your pool". */
function manaSentence(kind: GameManaKind, delta: number) {
  const n = spelled(Math.abs(delta));
  return delta >= 0
    ? `Added ${n} ${kind} mana to your pool`
    : `Took ${n} ${kind} mana from your pool`;
}

/** A spell countered, by whose spell it was: "Your Counterspell was countered by Mana Leak",
 *  "The opponent's face-down spell was countered". */
function counteredSentence(
  seat: PlaytestPlayer,
  name: string | null,
  by: string | null,
  opponents: number,
) {
  const spell = `${playerPossessive(seat, opponents)} ${name ?? "face-down spell"}`;
  return by === null ? `${spell} was countered` : `${spell} was countered by ${by}`;
}

/** A die rolled: "You rolled 4 on a d6", "The opponent rolled the planar die". */
function rolledSentence(
  seat: PlaytestPlayer,
  sides: number,
  result: number | null,
  opponents: number,
) {
  const who = playerName(seat, opponents);
  return result === null
    ? `${who} rolled the planar die`
    : `${who} rolled ${result} on a d${sides}`;
}

/** A designation taken: "You became the monarch", "The Ring tempted Opponent 2". */
function becameSentence(seat: PlaytestPlayer, what: PlaytestDesignation, opponents: number) {
  const who = playerName(seat, opponents);
  switch (what) {
    case "monarch":
      return `${who} became the monarch`;
    case "initiative":
      return `${who} took the initiative`;
    case "cityBlessing":
      return `${who} got the city's blessing`;
    case "ringTempted":
      return `The Ring tempted ${playerName(seat, opponents, "mid")}`;
  }
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
    case "controlled":
      return h.byHand
        ? controlledSentence(h.seat, h.name, h.from, h.controller, opponents)
        : controlledByRulesSentence(h.seat, h.name, h.controller, opponents);
    case "tapped":
      return tappedSentence(h.seat, h.name, h.count, h.tapped, opponents);
    case "untappedAll":
      return "Untapped everything";
    case "counters":
      return countersSentence(h.seat, h.name, h.kind, h.count, opponents);
    case "shuffled":
      return "Shuffled the library";
    case "manaChanged":
      return manaSentence(h.kind, h.delta);
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
    case "companionRevealed":
      return h.seat === "you"
        ? `Revealed ${h.name} as your companion`
        : `${playerName(h.seat, opponents)} revealed ${h.name} as their companion`;
    case "companionToHand":
      return h.seat === "you"
        ? `Put ${h.name}, your companion, into your hand`
        : `${playerName(h.seat, opponents)} put ${h.name}, their companion, into their hand`;
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
    case "commanderDamage":
      return `${h.source} has dealt ${playerName(h.seat, opponents, "mid")} ${h.total} commander damage`;
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
    case "revealed":
      return h.seat === "you"
        ? `Revealed ${listed(h.names)}`
        : `${playerName(h.seat, opponents)} revealed ${listed(h.names)}`;
    case "countered":
      return counteredSentence(h.seat, h.name, h.by, opponents);
    case "flipped":
      return `${playerName(h.seat, opponents)} ${h.won ? "won" : "lost"} the flip`;
    case "rolled":
      return rolledSentence(h.seat, h.sides, h.result, opponents);
    case "named":
      return `${playerName(h.seat, opponents)} named ${h.name}`;
    case "became":
      return becameSentence(h.seat, h.what, opponents);
    case "dayNight":
      return `It became ${h.now}`;
    case "countersChanged":
      return h.delta === 0
        ? null
        : countersChangedSentence(h.seat, h.name, h.kind, h.delta, opponents);
    case "becameTapped":
      return becameTappedSentence(h.seat, h.names, h.tapped, opponents);
    case "triggered":
      return h.seat === "you"
        ? `${h.name ?? "Your face-down permanent"}'s ability triggered`
        : `${playerPossessive(h.seat, opponents)} ${h.name ?? "face-down permanent"}'s ability triggered`;
    case "transformed":
      return `${permanent(h.seat, h.name, opponents)} transformed`;
    case "turnedFaceUp":
      return `${permanent(h.seat, h.name, opponents)} was turned face up`;
    case "turnedFaceDown":
      return `${permanent(h.seat, h.name, opponents)} was turned face down`;
    case "attached":
      return attachedSentence(h.seat, h.name, h.to, h.toSeat, h.attached, opponents);
    case "removed":
      return removedSentence(h.seat, h.name, h.how, h.to, opponents);
    case "playerCounters":
      return h.delta === 0
        ? null
        : playerCountersSentence(h.seat, h.kind, h.delta, h.total, opponents);
    case "roomEntered":
      return `${playerName(h.seat, opponents)} entered ${h.room} (${h.dungeon})`;
    case "dungeonCompleted":
      return `${playerName(h.seat, opponents)} completed ${h.dungeon}`;
    case "voted":
      return `${playerName(h.seat, opponents)} voted for ${h.choice}`;
    case "voteResolved":
      return talliesSentence(h.tallies);
    case "clashed":
      return clashedSentence(h.seat, h.with, h.manaValue, h.theirManaValue, h.result, opponents);
    case "extraTurn":
      return h.seat === "you"
        ? "You will take an extra turn"
        : `${playerName(h.seat, opponents)} will take an extra turn`;
    case "chose":
      return `The engine chose for you: ${promptTitle(h.what)}`;
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
    case "controlled":
      return "move";
    case "tapped":
    case "untappedAll":
      return "tap";
    case "counters":
      return "counter";
    case "shuffled":
      return "shuffle";
    case "lifeSet":
      return "life";
    case "manaChanged":
      return "tap";
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
    case "commanderDamage":
      return "combat";
    case "life":
      return "life";
    case "tokensCreated":
    case "emblem":
      return "token";
    case "revealed":
    case "named":
    case "companionRevealed":
      return "reveal";
    case "companionToHand":
      return "move";
    case "countered":
      return "cast";
    case "flipped":
    case "rolled":
      return "chance";
    case "became":
      return "status";
    case "dayNight":
      return "turn";
    case "countersChanged":
      return "counter";
    case "becameTapped":
      return "tap";
    case "triggered":
      return "cast";
    case "transformed":
    case "turnedFaceUp":
    case "turnedFaceDown":
    case "attached":
      return "move";
    case "removed":
      return "move";
    case "playerCounters":
      return "counter";
    case "roomEntered":
    case "dungeonCompleted":
    case "voted":
    case "voteResolved":
      return "status";
    case "clashed":
      return "reveal";
    case "extraTurn":
      return "turn";
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
