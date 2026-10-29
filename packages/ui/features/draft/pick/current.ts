import type { DraftView } from "@/lib/ipc";
import { viewMemory } from "@/lib/viewMemory";
import type { DraftRole } from "../build/BuildPanel";

/**
 * The draft this window is in, for the rest of the window's life (`lib/viewMemory.ts`) — so a
 * reader who goes to Decks to look something up mid-draft comes back to the pick they left, not
 * to the hub. Module memory and never storage: a restart opens on the hub, where a solo draft is
 * offered back from its saved copy (`draft_saved`).
 *
 * `view` is the last one seen. The host's app answers a solo or hosted draft again on demand
 * (`draft_view`); a guest's view only ever arrives pushed, so the last one kept here is all a
 * guest who left the page has until the host's next push.
 */
export interface CurrentDraft {
  /** The page's name for the draft — `null` for a guest, whose draft runs on the host. */
  draft: number | null;
  role: DraftRole;
  view: DraftView | null;
}

export const currentDraft = viewMemory<CurrentDraft | null>("draft.current");
