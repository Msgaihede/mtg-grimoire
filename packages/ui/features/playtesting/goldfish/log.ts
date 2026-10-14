/**
 * The game log's sentences — what an action did, as a reader would say it.
 *
 * **The engine says what happened; this file says it in words** (the boundary `ipc/goldfish.ts`
 * describes). `Happened` is a fact a row — which card went where and how — and a line here is one
 * of those, phrased the way the artboard's log reads: "Drew Boseiju, Who Endures", "Cast Old
 * Gnawbone", "The opponent took 7, down to 12". The newest line is first.
 */
import type { GoldfishPlace, Happened } from "@/lib/ipc";

export interface LogLine {
  /** The reader's turn it happened on; 0 for the opening hand. */
  turn: number;
  text: string;
  /** What kind of thing happened, for the line's glyph; a line without one gets a plain dot. */
  kind?: LogKind;
}

/** The kinds of line the log draws a glyph for — coarser than `Happened`, and finer where a
 *  reader's words are: a move from the library to the hand is a draw. */
export type LogKind =
  | "deal"
  | "draw"
  | "land"
  | "cast"
  | "move"
  | "tap"
  | "counter"
  | "token"
  | "shuffle"
  | "life"
  | "turn"
  | "engine"
  /** The playtest board's: an attack, a block, damage. */
  | "combat"
  /** The playtest board's: the game is over. */
  | "end";

/** The kind of line one fact makes. */
export function kindOf(h: Happened): LogKind {
  switch (h.type) {
    case "mulliganed":
    case "kept":
      return "deal";
    case "played":
      return "land";
    case "cast":
      return "cast";
    case "put":
      return h.to === "graveyard" && (h.from === "hand" || h.from === "command") ? "cast" : "move";
    case "moved":
      return h.from === "libraryTop" && h.to === "hand" ? "draw" : "move";
    case "tapped":
    case "untappedAll":
      return "tap";
    case "counters":
      return "counter";
    case "tokensCreated":
      return "token";
    case "shuffled":
      return "shuffle";
    case "lifeSet":
      return "life";
    case "turnBegan":
    case "opponentTurn":
      return "turn";
    case "life":
      return "life";
    case "chose":
      return "engine";
  }
}

/** How many lines the log keeps; the panel scrolls, but a long game is not a long list. */
export const LOG_LIMIT = 200;

/** Where a card went, as the end of a sentence: "Sol Ring to the graveyard". */
const TO: Record<GoldfishPlace, string> = {
  hand: "your hand",
  battlefield: "the battlefield",
  graveyard: "the graveyard",
  exile: "exile",
  command: "the command zone",
  libraryTop: "the top of the library",
  libraryBottom: "the bottom of the library",
};

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven"];
/** "seven", "eight" written as a number past the words a reader expects to see spelled. */
function spelled(n: number): string {
  return COUNT[n] ?? String(n);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One fact, as a sentence, or `null` for a fact the log does not repeat. */
export function sentence(h: Happened): string | null {
  switch (h.type) {
    case "mulliganed":
      return `Mulligan ${h.mulligans} · drew seven`;
    case "kept":
      return h.bottomed === 0
        ? `Kept ${spelled(h.size)}`
        : `Kept ${spelled(h.size)} · put ${spelled(h.bottomed)} on the bottom`;
    case "played":
      return `Played ${h.name}`;
    case "cast":
      return h.from === "command" ? `Cast ${h.name} from the command zone` : `Cast ${h.name}`;
    case "put":
      if (h.from === "hand" && h.to === "battlefield") return `Put ${h.name} onto the battlefield`;
      if (h.from === "command" && h.to === "battlefield")
        return `Put ${h.name} onto the battlefield`;
      if (h.to === "graveyard" && (h.from === "hand" || h.from === "command"))
        return `Cast ${h.name} · not paid for`;
      return `${h.name} to ${TO[h.to]}`;
    case "moved":
      if (h.from === "libraryTop" && h.to === "hand") return `Drew ${h.name}`;
      if (h.from === "libraryTop" && h.to === "graveyard") return `Milled ${h.name}`;
      if (h.from === "hand" && h.to === "graveyard") return `Discarded ${h.name}`;
      if (h.to === "battlefield") return `${h.name} entered the battlefield`;
      return `${h.name} to ${TO[h.to]}`;
    case "tapped":
      return h.count === 1
        ? `${h.tapped ? "Tapped" : "Untapped"} ${h.name}`
        : `${h.tapped ? "Tapped" : "Untapped"} ${h.count} × ${h.name}`;
    case "untappedAll":
      return "Untapped everything";
    case "counters":
      return h.count === 0
        ? `${h.name} has no ${h.kind} counters`
        : `${h.name} has ${plural(h.count, `${h.kind} counter`)}`;
    case "tokensCreated":
      return h.count === 1 ? `Created a ${h.name} token` : `Created ${h.count} ${h.name} tokens`;
    case "shuffled":
      return "Shuffled the library";
    case "lifeSet":
      return lifeSentence(h.seat, h.was, h.life);
    case "turnBegan":
      return `Untapped · turn ${h.turn} begins`;
    case "life":
      return h.amount === 0 ? null : lifeSentence(h.seat, h.total - h.amount, h.total);
    case "opponentTurn":
      return opponentTurnSentence(h.drew, h.discarded);
    case "chose":
      return `The rules engine answered a ${h.what} prompt for you`;
  }
}

/** "The opponent took 7, down to 12" / "You gained 3, up to 43" / "The opponent is dead". */
export function lifeSentence(seat: "you" | "opponent", was: number, life: number): string {
  const who = seat === "you" ? "You" : "The opponent";
  const diff = life - was;
  if (seat === "opponent" && life <= 0 && was > 0) return "The opponent is dead";
  if (diff < 0) return `${who} took ${-diff}, down to ${life}`;
  if (diff > 0) return `${who} gained ${diff}, up to ${life}`;
  return `${who} ${seat === "you" ? "are" : "is"} at ${life}`;
}

/** The goldfish's turn: "The opponent drew a card and passed", "…, discarded one and passed". */
function opponentTurnSentence(drew: number, discarded: number): string {
  const did: string[] = [];
  if (drew > 0) did.push(drew === 1 ? "drew a card" : `drew ${spelled(drew)} cards`);
  if (discarded > 0) did.push(`discarded ${spelled(discarded)}`);
  return did.length === 0
    ? "The opponent passed the turn"
    : `The opponent ${did.join(", ")} and passed`;
}

/**
 * The lines one action adds, newest first, ready to go on top of the log. `turn` is the turn the
 * view after the action is on, so a "turn begins" and the draw that follows it carry the new turn.
 *
 * **What came before a `turnBegan` belongs to the turn before it**: a next turn carries the end
 * of the reader's turn and the goldfish's whole turn ahead of the new one, and those lines are
 * filed under the turn they happened in.
 */
export function linesFor(happened: readonly Happened[], turn: number): LogLine[] {
  const began = happened.find((h) => h.type === "turnBegan");
  let now = began?.type === "turnBegan" ? Math.max(0, began.turn - 1) : turn;
  const out: LogLine[] = [];
  for (const h of happened) {
    if (h.type === "turnBegan") now = h.turn;
    const text = sentence(h);
    if (text !== null) out.push({ turn: now, text, kind: kindOf(h) });
  }
  return out.reverse();
}

/** The log with an action's lines on top, kept to {@link LOG_LIMIT}. */
export function appendLog(log: readonly LogLine[], lines: readonly LogLine[]): LogLine[] {
  return [...lines, ...log].slice(0, LOG_LIMIT);
}

/** One turn's lines in the log panel, newest first like the log itself. */
export interface LogTurn {
  turn: number;
  lines: LogLine[];
  /** Where in the whole log the group's first line is. */
  from: number;
}

/** The log cut into turns, each run of lines of one turn its own group, newest turn first. */
export function byTurn(log: readonly LogLine[]): LogTurn[] {
  const out: LogTurn[] = [];
  log.forEach((line, i) => {
    const last = out[out.length - 1];
    if (last !== undefined && last.turn === line.turn) last.lines.push(line);
    else out.push({ turn: line.turn, lines: [line], from: i });
  });
  return out;
}
