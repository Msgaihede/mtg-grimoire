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

/**
 * The lines one action adds, newest first, ready to go on top of the log. `turn` is the turn the
 * view after the action is on, so a "turn begins" and the draw that follows it carry the new turn.
 */
export function linesFor(happened: readonly Happened[], turn: number): LogLine[] {
  const out: LogLine[] = [];
  for (const h of happened) {
    const text = sentence(h);
    if (text !== null) out.push({ turn, text });
  }
  return out.reverse();
}

/** The log with an action's lines on top, kept to {@link LOG_LIMIT}. */
export function appendLog(log: readonly LogLine[], lines: readonly LogLine[]): LogLine[] {
  return [...lines, ...log].slice(0, LOG_LIMIT);
}
