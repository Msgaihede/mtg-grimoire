/**
 * The game log's shared pieces — a line, its kind, the log's length, and the log cut into turns —
 * which the board's log panel (`Panels.tsx`' `LogPanel`) draws and `../undo.ts` keeps a history of.
 *
 * **The sentences are `../play/log.ts`'s.** There is one game now, goldfish or AI, and one wire
 * of facts (`PlaytestHappened`); that file words every one of them. What stays here is what does
 * not depend on which fact a line came from, and {@link lifeSentence}, the words for a life
 * total moved by a stepper ("The opponent took 7, down to 12"). The newest line is first.
 */
export interface LogLine {
  /** The game's turn it happened on (`PlaytestView.turn`, every seat's turns counted); 0 for the
   *  opening hands. */
  turn: number;
  text: string;
  /** What kind of thing happened, for the line's glyph; a line without one gets a plain dot. */
  kind?: LogKind;
}

/** The kinds of line the log draws a glyph for — coarser than `PlaytestHappened`, and finer where
 *  a reader's words are: a move from the library to the hand is a draw. */
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
  /** An attack, a block, damage. */
  | "combat"
  /** A player is out, or the game is over. */
  | "end";

/** How many lines the log keeps; the panel scrolls, but a long game is not a long list. */
export const LOG_LIMIT = 200;

/**
 * "The opponent took 7, down to 12" / "You gained 3, up to 43" / "The opponent is dead".
 * `opponent` names the opponent, for a four-player table ("Opponent 2").
 */
export function lifeSentence(
  seat: "you" | "opponent",
  was: number,
  life: number,
  opponent = "The opponent",
): string {
  const who = seat === "you" ? "You" : opponent;
  const diff = life - was;
  if (seat === "opponent" && life <= 0 && was > 0) return `${opponent} is dead`;
  if (diff < 0) return `${who} took ${-diff}, down to ${life}`;
  if (diff > 0) return `${who} gained ${diff}, up to ${life}`;
  return `${who} ${seat === "you" ? "are" : "is"} at ${life}`;
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
