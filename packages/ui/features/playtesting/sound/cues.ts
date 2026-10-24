/**
 * Which sounds a beat of the board makes — the selection, with nothing played, as `../play/pops.ts`
 * is for the damage and life pops.
 *
 * **Out of the beat's facts** (`PlaytestHappened`), one sound a fact, in their order, each
 * {@link GAP} after the last (longer after a sound that needs room: the turn's mallet, a shuffle).
 * A beat is one replay frame, or the whole step when there are no frames — so a busy one is capped:
 * at most {@link SAME_MAX} of one sound (three draws are heard, seven are three) and
 * {@link MAX_CUES} in all, the ones dropped being the least telling ({@link RANK}).
 *
 * **The action that led to it says what a fact cannot.** A rules mana tap is reported as a plain
 * `tapped`, and a `counters` fact carries the new total but not which way it moved, so the
 * reader's own `tapForMana` and `counters` action settle those (`action`).
 *
 * The reader's undo, redo, pass and choice are heard at the press instead (`atPress`): undo and
 * redo answer with no facts at all, and the pass is the reader's own knock on the table — it
 * should not wait for the AI's whole turn to come back.
 */
import type { PlaytestAction, PlaytestHappened } from "@/lib/ipc";
import type { SoundId } from "./synth";

export interface Cue {
  id: SoundId;
  /** Seconds after the beat is shown. */
  delay: number;
}

/** The space between two sounds of one beat. */
export const GAP = 0.12;
/** Most sounds one beat makes. */
export const MAX_CUES = 5;
/** Most times one beat makes the same sound. */
export const SAME_MAX = 3;

/** The space a sound wants after it before the next starts, where more than {@link GAP}. */
const ROOM: Partial<Record<SoundId, number>> = {
  shuffle: 1.1,
  mulligan: 0.9,
  turnYours: 0.35,
  turnTheirs: 0.35,
  attack: 0.3,
  cast: 0.2,
};

/** What a beat too busy to say whole keeps first: the lower, the more telling. */
function rank(id: SoundId): number {
  switch (id) {
    case "win":
    case "lose":
    case "eliminated":
      return 0;
    case "turnYours":
    case "turnTheirs":
      return 1;
    case "attack":
    case "block":
    case "damage":
    case "commanderDamage":
      return 2;
    case "cast":
    case "play":
    case "exile":
    case "graveyard":
    case "lifeLoss":
    case "lifeGain":
      return 3;
    default:
      return 4;
  }
}

/** The sound of one fact, or `null` for one that makes none. */
export function soundOf(h: PlaytestHappened): SoundId | null {
  switch (h.type) {
    case "mulliganed":
      return "mulligan";
    case "kept":
      return "keep";
    case "turnBegan":
      return h.seat === "you" ? "turnYours" : "turnTheirs";
    case "played":
      return "play";
    case "cast":
      return "cast";
    case "activated":
      return "activate";
    case "foretold":
      return "foretell";
    case "moved":
    case "put":
      switch (h.to) {
        case "hand":
        case "command":
          return "toHand";
        case "battlefield":
          return "play";
        case "graveyard":
          return h.from === "libraryTop" || h.from === "libraryBottom" ? "mill" : "graveyard";
        case "exile":
          return "exile";
        case "libraryTop":
        case "libraryBottom":
          return "toLibrary";
      }
      return null;
    case "drew":
      return "draw";
    case "attacked":
      return "attack";
    case "blocked":
      return "block";
    case "dealt":
      return h.amount > 0 ? "damage" : null;
    case "life":
      return h.amount < 0 ? "lifeLoss" : h.amount > 0 ? "lifeGain" : null;
    case "lifeSet":
      return h.life < h.was ? "lifeLoss" : h.life > h.was ? "lifeGain" : null;
    case "commanderDamage":
      return "commanderDamage";
    case "tokensCreated":
      return "token";
    case "emblem":
      return "emblem";
    case "tapped":
      return h.tapped ? "tap" : "untap";
    case "untappedAll":
      return "untapAll";
    case "counters":
      return "counterAdd";
    case "shuffled":
      return "shuffle";
    case "chose":
      return "choose";
    case "eliminated":
      return "eliminated";
    case "gameOver":
      return h.winner === "you" ? "win" : "lose";
  }
}

/** The sound the reader's press makes at once, before any answer: see the module comment. */
export function atPress(action: PlaytestAction): SoundId | null {
  switch (action.type) {
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    case "pass":
    case "endTurn":
      return "pass";
    case "choose":
    case "pickCards":
      return "choose";
    default:
      return null;
  }
}

/** The sounds of one beat, `action` being the reader's that led to it (for its first beat). */
export function cuesFor(
  happened: readonly PlaytestHappened[],
  action: PlaytestAction | null = null,
): Cue[] {
  let ids = happened.map(soundOf).filter((id): id is SoundId => id !== null);

  if (action?.type === "tapForMana") {
    const first = ids.indexOf("tap");
    if (first >= 0) ids[first] = "mana";
  }
  if (action?.type === "counters" && action.delta < 0) {
    ids = ids.map((id) => (id === "counterAdd" ? "counterRemove" : id));
  }

  // At most SAME_MAX of one sound, then the MAX_CUES most telling, kept in their order.
  const seen = new Map<SoundId, number>();
  const capped = ids
    .map((id, at) => ({ id, at }))
    .filter(({ id }) => {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      return n <= SAME_MAX;
    });
  const kept =
    capped.length <= MAX_CUES
      ? capped
      : [...capped]
          .sort((a, b) => rank(a.id) - rank(b.id) || a.at - b.at)
          .slice(0, MAX_CUES)
          .sort((a, b) => a.at - b.at);

  const cues: Cue[] = [];
  let delay = 0;
  for (const { id } of kept) {
    cues.push({ id, delay });
    delay += ROOM[id] ?? GAP;
  }
  return cues;
}
