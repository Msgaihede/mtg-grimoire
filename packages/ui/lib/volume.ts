import { create } from "zustand";

/**
 * How loud a level is, and the app's own volume — the slider under Settings › Sound (issue #1703).
 *
 * **A level is a whole number in 0–100**, the number a slider shows; {@link volumeGain} is what a
 * sound is multiplied by. Every volume in the app is spelled this way: this one, and the playtest
 * board's own slider under its speaker button (`features/playtesting/sound/volume`).
 *
 * **The app's volume is over every sound the page makes** — the scanner's beeps and jingles
 * (`features/scanner/sounds/player`) and the playtest board (`useTableSounds`), each multiplied by
 * it. A sound's own settings still apply under it: the scanner's switch says whether a scan beeps
 * and the board's slider how loud the board is against the rest, and this is how loud the app is.
 * The computer's own volume, and the app's row in the Windows mixer (named by the desktop host's
 * `mixer`), are over all of it.
 *
 * **Remembered across launches in `localStorage`**, per device and never synced — the board's
 * mute's arrangement (`features/playtesting/sound/muted`): how loud this machine should be is a
 * fact about where it sits, not about the reader's collection. A host that refuses the store keeps
 * it for the session, and anything unreadable is full volume, which is the level every sound was
 * made at. **Every window of the app reads one level**: a change in one is adopted by the others
 * through the `storage` event, `lib/notifications.ts`' arrangement, so a scanner in a second
 * window is not left at the level the first window had a minute ago.
 */
export const APP_VOLUME_KEY = "grimoire.volume";

export const FULL_VOLUME = 100;

/** `volume` as a whole number in 0–100; anything else is full. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return FULL_VOLUME;
  return Math.round(Math.max(0, Math.min(FULL_VOLUME, volume)));
}

/**
 * The gain a level plays at: its square, so the slider's travel follows loudness as heard rather
 * than amplitude — half way is about a quarter of the signal, which sounds about half as loud.
 */
export function volumeGain(volume: number): number {
  const v = clampVolume(volume) / FULL_VOLUME;
  return v * v;
}

function readAppVolume(): number {
  try {
    const stored = window.localStorage.getItem(APP_VOLUME_KEY);
    return stored === null ? FULL_VOLUME : clampVolume(Number(stored));
  } catch {
    return FULL_VOLUME;
  }
}

interface AppVolume {
  /** The level, 0–100. */
  volume: number;
  setVolume: (volume: number) => void;
}

export const useAppVolume = create<AppVolume>((set) => ({
  volume: readAppVolume(),
  setVolume: (next) => {
    const volume = clampVolume(next);
    try {
      if (volume === FULL_VOLUME) window.localStorage.removeItem(APP_VOLUME_KEY);
      else window.localStorage.setItem(APP_VOLUME_KEY, String(volume));
    } catch {
      // Kept for the session.
    }
    set({ volume });
  },
}));

/**
 * The gain every sound is multiplied by now — for a caller outside React (the scanner's player),
 * which reads it as it plays.
 */
export function appVolumeGain(): number {
  return volumeGain(useAppVolume.getState().volume);
}

/**
 * Another window on this device moved the level: take it. `key` is `null` when the whole store was
 * cleared, which is full volume again.
 */
function adopt(e: StorageEvent): void {
  if (e.key !== APP_VOLUME_KEY && e.key !== null) return;
  useAppVolume.setState({ volume: readAppVolume() });
}

try {
  window.addEventListener("storage", adopt);
} catch {
  // No window to listen on (a Worker importing this by accident): nothing to adopt.
}
