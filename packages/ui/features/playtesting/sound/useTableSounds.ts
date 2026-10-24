import { useCallback, useEffect, useRef } from "react";
import type { PlaytestAction, PlaytestHappened } from "@/lib/ipc";
import { atPress, cuesFor } from "./cues";
import { useTableSoundsMuted } from "./muted";
import { createTableSynth, type TableSynth } from "./synth";

/** The one synth for every board: its audio context is made on the first sound, never before. */
const shared = createTableSynth();

/**
 * The board's sounds: each beat's facts heard as it is shown, and the reader's own presses.
 *
 * **Keyed on the beat** (`happened`, the game's `lastHappened`), as the damage pops are: a new
 * list is a new beat, so a replay sounds frame by frame, and a skip or a board coming back —
 * which set the empty list — makes no sound. Returns `onAct` wrapped, so the press itself can
 * sound (`atPress`) and the action is remembered for the next beat's {@link cuesFor}: the
 * action's own answer is the beat that comes after it. The next press replaces it, so a refused
 * action says nothing about a later beat.
 *
 * **The context is woken from a press.** A webview lets an audio context made outside a user
 * gesture start suspended, and the first beat's sounds come from an IPC answer, not a click; so
 * every press on the page (`pointerdown`, `keydown`) makes or resumes it — cheap after the first.
 * Nothing is made while muted.
 */
export function useTableSounds(
  happened: readonly PlaytestHappened[],
  onAct: (action: PlaytestAction) => void,
  synth: TableSynth = shared,
): (action: PlaytestAction) => void {
  const muted = useTableSoundsMuted((s) => s.muted);
  const pending = useRef<PlaytestAction | null>(null);
  /** The beat last heard: a strict-mode remount runs the effect again on the same one. */
  const heard = useRef<readonly PlaytestHappened[] | null>(null);

  useEffect(() => {
    if (muted) return;
    const wake = () => synth.unlock();
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    return () => {
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("keydown", wake, true);
    };
  }, [muted, synth]);

  useEffect(() => {
    if (happened.length === 0 || heard.current === happened) return;
    heard.current = happened;
    const action = pending.current;
    pending.current = null;
    if (useTableSoundsMuted.getState().muted) return;
    for (const cue of cuesFor(happened, action)) synth.play(cue.id, cue.delay);
  }, [happened, synth]);

  return useCallback(
    (action: PlaytestAction) => {
      pending.current = action;
      const sound = atPress(action);
      if (sound !== null && !useTableSoundsMuted.getState().muted) synth.play(sound);
      onAct(action);
    },
    [onAct, synth],
  );
}
