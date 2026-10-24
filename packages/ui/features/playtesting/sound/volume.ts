import { create } from "zustand";

/**
 * How loud the playtest board's sounds are, 0–100 — the slider under the speaker button. Mute
 * (`./muted`) is apart from it, so turning sounds back on returns to the level the reader set.
 *
 * **Remembered across launches in `localStorage`**, per device and never synced, as mute is: how
 * loud this machine should be is a fact about where it sits. A host that refuses the store keeps
 * it for the session, and anything unreadable is full volume — the level the sounds were tuned at.
 */
export const VOLUME_KEY = "grimoire.playtest.volume";

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

function readVolume(): number {
  try {
    const stored = window.localStorage.getItem(VOLUME_KEY);
    return stored === null ? FULL_VOLUME : clampVolume(Number(stored));
  } catch {
    return FULL_VOLUME;
  }
}

interface TableSoundsVolume {
  volume: number;
  setVolume: (volume: number) => void;
}

export const useTableSoundsVolume = create<TableSoundsVolume>((set) => ({
  volume: readVolume(),
  setVolume: (next) => {
    const volume = clampVolume(next);
    try {
      if (volume === FULL_VOLUME) window.localStorage.removeItem(VOLUME_KEY);
      else window.localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      // Kept for the session.
    }
    set({ volume });
  },
}));
