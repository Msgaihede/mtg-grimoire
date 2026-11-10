import { useQuery } from "@tanstack/react-query";
import { ipc, type DraftSaved, type DraftStatus, type LobbyState } from "@/lib/ipc";

/**
 * **The app's one draft slot, as the page sees it** (issue #1586). The host holds one draft at a
 * time (`draft::DraftSlot`): a solo start or resume takes that slot from whatever was in it. So
 * the page asks before a press puts a draft in progress away, and withholds the press while a pod
 * this app hosts is drafting — every guest's picks are answered from that slot. The host refuses
 * the same press (`draft::POD_AT_TABLE`), so the page's question is never the only fence.
 */

/** The saved solo draft — read fresh whenever the hub is drawn (it moves with every pick). */
export const DRAFT_SAVED_KEY = ["draft", "saved"] as const;

/** The saved solo draft (`draft_saved`), or `null` for none — the hub's *Draft in progress*. */
export function useSavedDraft(): DraftSaved | null {
  const saved = useQuery({
    queryKey: DRAFT_SAVED_KEY,
    queryFn: () => ipc.draftSaved(),
    retry: false,
    // Every pick moves it; the hub is drawn between drafts, so it is always asked again.
    staleTime: 0,
  });
  return saved.data ?? null;
}

/** Whether `lobby` is a pod this app hosts that is drafting — the slot is its guests' then. */
export function hostsDraftingPod(lobby: LobbyState | null): boolean {
  // Only a draft's lobby is ever `drafting` (a game's plays, a trade's agrees).
  return lobby?.role === "host" && lobby.phase === "drafting";
}

/** Why a solo draft cannot start or resume while the pod is drafting — the host's sentence. */
export const POD_HOLDS_TABLE =
  "You are hosting a pod draft. Finish it or leave its lobby before starting another draft.";

/** Where a draft is, in a row's words: its pack and pick, or done picking. */
export function whereOf(at: {
  status: DraftStatus;
  packNumber: number;
  packCount: number;
  pickNumber: number;
}): string {
  return at.status === "deckbuilding"
    ? "Done picking"
    : `Pack ${at.packNumber + 1} of ${at.packCount} · Pick ${at.pickNumber + 1}`;
}
