import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { PlaytestFrame, PlaytestHappened, PlaytestStep, PlaytestView } from "@/lib/ipc";

/**
 * The AI's turn, played back: the views after each thing it did, one at a time, before the board
 * settles on where the game now waits for the reader.
 *
 * **Why**: one `playtestAct` returns everything the opponent did up to the reader's next decision
 * — often a whole turn — and without a replay the board jumps from before it to after it, and the
 * reader learns what happened from the log. The engine sends the views in between as `frames`
 * (oldest first; the step's own `view` and `happened` stay the final ones, and `happened` the
 * whole list), and this plays them {@link REPLAY_MS} apart. Each frame's facts reach the log and
 * the damage and life pops as its view is shown.
 *
 * **Skippable, and off under reduced motion**: Skip, Space or Escape shows the end at once, and
 * a reader who has asked for less motion is shown it at once every time.
 */

/** What the board is shown at one beat of a replay. `quiet` facts are logged but do not pop. */
export interface ReplayEntry {
  view: PlaytestView;
  happened: readonly PlaytestHappened[];
  quiet?: boolean;
}

/** How long each frame is shown. */
export const REPLAY_MS = 450;

/** The frames a step carries; a step from a host that sends none has none. */
export function framesOf(step: PlaytestStep): readonly PlaytestFrame[] {
  return Array.isArray(step.frames) ? step.frames : [];
}

const key = (h: PlaytestHappened) => JSON.stringify(h);

/** Where `run` starts in `all`, at or after `from`; `from` for an empty run, -1 if nowhere. */
function runAt(all: readonly string[], run: readonly string[], from: number): number {
  if (run.length === 0) return from;
  for (let i = from; i + run.length <= all.length; i++) {
    if (run.every((k, j) => all[i + j] === k)) return i;
  }
  return -1;
}

/**
 * The beats of a step's replay: one per frame, then the step's final view.
 *
 * **Every fact in `step.happened` is said exactly once, in its order.** Each frame's facts are
 * found in the whole list as a run, after the previous frame's; a frame's beat carries its run
 * and whatever came between it and the last run (the reader's own action, before the first
 * frame), and the final beat carries what is left (the reader's turn beginning, their draw). A
 * frame whose facts are not in the list as a run is shown with its own, and the final beat then
 * carries the list less every frame's facts.
 */
export function replayEntries(step: PlaytestStep, frames: readonly PlaytestFrame[]): ReplayEntry[] {
  if (frames.length === 0) return [{ view: step.view, happened: step.happened }];
  const all = step.happened.map(key);
  const entries: ReplayEntry[] = [];
  let cursor = 0;
  for (const frame of frames) {
    const run = frame.happened.map(key);
    const at = runAt(all, run, cursor);
    if (at < 0) return looseEntries(step, frames);
    const end = at + run.length;
    entries.push({ view: frame.view, happened: step.happened.slice(cursor, end) });
    cursor = end;
  }
  entries.push({ view: step.view, happened: step.happened.slice(cursor) });
  return entries;
}

/** {@link replayEntries} when the frames' facts cannot be found in order: each frame its own,
 *  and the final beat every fact no frame said. */
function looseEntries(step: PlaytestStep, frames: readonly PlaytestFrame[]): ReplayEntry[] {
  const said = new Map<string, number>();
  for (const f of frames) for (const h of f.happened) said.set(key(h), (said.get(key(h)) ?? 0) + 1);
  const rest = step.happened.filter((h) => {
    const n = said.get(key(h)) ?? 0;
    if (n === 0) return true;
    said.set(key(h), n - 1);
    return false;
  });
  return [
    ...frames.map((f) => ({ view: f.view, happened: f.happened })),
    { view: step.view, happened: rest },
  ];
}

/** Several beats as one: the last view, every fact, nothing popped. What a skip shows. */
function merged(entries: readonly ReplayEntry[]): ReplayEntry {
  return {
    view: entries[entries.length - 1].view,
    happened: entries.flatMap((e) => e.happened),
    quiet: true,
  };
}

export interface Replay {
  /** A replay is being shown: the board is read-only until it ends or is skipped. */
  replaying: boolean;
  /** Show these beats: the first now, each next {@link REPLAY_MS} later. */
  play: (entries: readonly ReplayEntry[]) => void;
  /** Show the end now, every fact still said. */
  skip: () => void;
  /** Drop what is left unshown — a new game, the page leaving. */
  cancel: () => void;
}

/** Plays replay beats through `apply`, the one place the page's state is set from. */
export function useReplay(apply: (entry: ReplayEntry) => void, interval = REPLAY_MS): Replay {
  const reduced = useReducedMotion() ?? false;
  const [replaying, setReplaying] = useState(false);
  const queue = useRef<ReplayEntry[]>([]);
  const timer = useRef<number | null>(null);
  const applyRef = useRef(apply);
  // Read through a ref, so `play` keeps one identity for the page's life: the page deals a game
  // from a callback built on it, and a new identity would be a new deal.
  const reducedRef = useRef(reduced);
  useEffect(() => {
    applyRef.current = apply;
    reducedRef.current = reduced;
  });

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const skip = useCallback(() => {
    stop();
    const rest = queue.current;
    queue.current = [];
    if (rest.length > 0) applyRef.current(merged(rest));
    setReplaying(false);
  }, [stop]);

  const cancel = useCallback(() => {
    stop();
    queue.current = [];
    setReplaying(false);
  }, [stop]);

  // Each beat schedules the next: one timer at a time, so a skip has exactly one to clear.
  const tick = useCallback(() => {
    const beat = () => {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const next = queue.current.shift();
        if (next !== undefined) applyRef.current(next);
        if (queue.current.length > 0) beat();
        else setReplaying(false);
      }, interval);
    };
    beat();
  }, [interval]);

  const play = useCallback(
    (entries: readonly ReplayEntry[]) => {
      // Anything still being shown is finished first, so no fact is lost or said twice.
      skip();
      if (entries.length === 0) return;
      if (entries.length === 1 || reducedRef.current) {
        applyRef.current(entries.length === 1 ? entries[0] : { ...merged(entries), quiet: false });
        return;
      }
      applyRef.current(entries[0]);
      queue.current = entries.slice(1);
      setReplaying(true);
      tick();
    },
    [skip, tick],
  );

  useEffect(() => stop, [stop]);

  return { replaying, play, skip, cancel };
}
