import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { SUPPORTER_KEY, supporterState } from "@/lib/query";

/**
 * Whether this device may send scans: **a supporter's device, and no other** (the owner's
 * decision). `true` for a membership that is `active` or in `grace` — a card Patreon is still
 * retrying, where tokens are still minted, so it counts — and `false` for every other reading:
 * `never`, `ended`, and `unknown`.
 *
 * **`unknown` is `false`, on purpose.** It is the read in flight or refused, and a press drawn
 * before the answer would flash at every reader the answer then takes it from — the one reader
 * who must not see it. A supporter's press arrives with the answer instead.
 *
 * **This is the whole of what the page does about it, and it says nothing.** Where this is
 * `false` both Scanner pages draw no press — not a greyed one, not a sentence, not a tooltip,
 * nothing that names a membership or a way to get one. That is not coyness: the light app's
 * Android build is the one Google Play distributes, and it may not lead a reader to a payment
 * made somewhere else (`apps/light/CLAUDE.md`, §2). A hint here would be drawn there too, so
 * there is no hint, and **no string belongs in this file or beside its callers**.
 *
 * **It gates the press, not the send.** A membership that lapses while the dialog is open is
 * the engine's to refuse, in a sentence of its own, and the dialog already draws a refusal.
 *
 * The membership is read through the one key and the one reading of its four fields
 * (`@/lib/query`), imported and never re-spelled — `ShareFolderMenu` says why at length: the key
 * sits under `SYNC_KEY`, so a finished round trip re-reads it, and the order `supporterState`
 * asks its fields in is load-bearing. One hook for both pages, so the two cannot come to draw
 * the press for different readers.
 */
export function useMaySendScans(): boolean {
  const supporter = useQuery({ queryKey: SUPPORTER_KEY, queryFn: () => ipc.syncSupporterStatus() });
  const membership = supporterState(supporter.data ?? null);
  return membership === "active" || membership === "grace";
}
