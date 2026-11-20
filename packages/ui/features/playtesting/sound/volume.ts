import { create } from "zustand";
import { clampVolume, FULL_VOLUME } from "@/lib/volume";

/**
 * How loud the playtest board's sounds are, 0–100 — the slider under the speaker button. Mute
 * (`./muted`) is apart from it, so turning sounds back on returns to the level the reader set.
 * **Under the app's own volume** (`@/lib/volume`, Settings › Sound), which multiplies it: this is
 * how loud the board is against the app's other sounds, and that is how loud the app is. A level
 * and its gain are spelled there, once, for both.
 *
 * **Remembered across launches in `localStorage`**, per device and never synced, as mute is: how
 * loud this machine should be is a fact about where it sits. A host that refuses the store keeps
 * it for the session, and anything unreadable is full volume — the level the sounds were tuned at.
 */
export const VOLUME_KEY = "grimoire.playtest.volume";

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
