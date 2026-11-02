/**
 * **Where the pick screen draws the pool** (issue #1474): `bottom`, the curve of stacked cards
 * under the pack (the default, and the only layout before the issue), or `side`, a compact tray of
 * name rows beside the pack — MTG Arena's two drafting views. A toggle in the pack's heading row
 * switches between them mid-pick.
 *
 * **Remembered across launches in `localStorage`, per device** — `packs/reducedPick.ts`' arrangement
 * and its reasons: it is a way of looking at this page on this machine's screen, never `app_meta`
 * (a phone's choice would be wrong for a wide monitor). A host that refuses the store keeps it for
 * the session, and an unreadable value is the default.
 *
 * A module of its own importing nothing that reaches a host, for `marketplacePick.ts`' reason:
 * `test-setup.ts` and the fake's `installWorld` reset it.
 */
import { create } from "zustand";

export type DraftTrayLayout = "bottom" | "side";

export const STORAGE_KEY = "grimoire.draft.trayLayout";

export const DEFAULT_TRAY_LAYOUT: DraftTrayLayout = "bottom";

/** What the store held, or the default for nothing (or anything else). */
export function parseStored(raw: string | null): DraftTrayLayout {
  return raw === "side" || raw === "bottom" ? raw : DEFAULT_TRAY_LAYOUT;
}

function readStored(): DraftTrayLayout {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_TRAY_LAYOUT;
  }
}

interface StoredLayout {
  layout: DraftTrayLayout;
  keep: (layout: DraftTrayLayout) => void;
}

export const useDraftTrayLayout = create<StoredLayout>((set) => ({
  layout: readStored(),
  keep: (layout) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, layout);
    } catch {
      // Kept for the session.
    }
    set({ layout });
  },
}));

/** Forget the choice — a fresh device's state. For tests and stories. */
export function resetDraftTrayLayout(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept.
  }
  useDraftTrayLayout.setState({ layout: DEFAULT_TRAY_LAYOUT });
}
