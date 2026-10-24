import { create } from "zustand";

/**
 * Whether the playtest board's sounds are off — the speaker button in the board's top right.
 *
 * **Remembered across launches in `localStorage`**, per device and never synced (the
 * `apps/light/phone/wallDensity.ts` arrangement): whether this machine should make noise is a
 * fact about where it sits, not about the reader's collection. A host that refuses the store (a
 * private window) keeps it for the session, and anything unreadable is "on".
 */
export const MUTED_KEY = "grimoire.playtest.muted";

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

interface TableSoundsMuted {
  muted: boolean;
  setMuted: (muted: boolean) => void;
}

export const useTableSoundsMuted = create<TableSoundsMuted>((set) => ({
  muted: readMuted(),
  setMuted: (muted) => {
    try {
      if (muted) window.localStorage.setItem(MUTED_KEY, "1");
      else window.localStorage.removeItem(MUTED_KEY);
    } catch {
      // Kept for the session.
    }
    set({ muted });
  },
}));
