/**
 * Keeping this device's published shares current while the app is open — issue #1025.
 *
 * **A share was a snapshot the owner had to remember to refresh**, and *Update now* is still the
 * press that does it at once. This hook is the same refresh made for them: a pass every
 * {@link AUTO_UPDATE_EVERY_MS}, which `share_auto_update` answers by republishing exactly the
 * shares whose folder no longer reads as what was last uploaded.
 *
 * **A timer rather than a reaction to each write, because the crate makes the timer free.**
 * Deciding which shares are due is a local read and a hash per share, with no token and no
 * request (`share::publish::changed`), so a pass over an unchanged binder spends nothing of the
 * account's shared Worker budget. A reaction to each write would be the opposite trade: a
 * reader filing forty cards one at a time would publish forty times, and the debounce that
 * fixes it is this interval with more moving parts. The cost is that a viewer waits up to one
 * interval for an edit — and a share edited just before the app closes is published on the next
 * launch's first pass, {@link AUTO_UPDATE_FIRST_MS} in.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type ShareRow } from "@/lib/ipc";
import { SUPPORTER_KEY, supporterState } from "@/lib/query";
import { SHARE_LIST_KEY } from "@/features/share/useShares";

/** How often a pass runs. Five minutes: long enough that a burst of filing is one publish, short
 *  enough that a friend looking at the link sees today's binder rather than last week's. */
export const AUTO_UPDATE_EVERY_MS = 5 * 60_000;

/** The first pass after launch — late enough to stay out of startup's way, early enough that an
 *  edit made just before the last close is not left waiting a whole interval. */
export const AUTO_UPDATE_FIRST_MS = 30_000;

/**
 * Run the pass for as long as this window can publish and the reader is connected.
 *
 * `publishes` is the shell's edition answer — false in the light app, whose hosts have no
 * `share_*` commands. The membership is read through `SUPPORTER_KEY`, the key the Share control
 * reads, so this asks nothing a connected reader's shell has not asked already; an unconnected
 * reader has no shares to keep and makes no pass at all.
 *
 * **The list is patched, not invalidated.** An updated share's row has a new `published` stamp,
 * and re-reading the list would be `share_list` — the one share read that reconciles against the
 * relay while holding the write connection. The pass already answered the rows that moved.
 */
export function useShareAutoUpdate(publishes: boolean): void {
  const client = useQueryClient();
  const supporter = useQuery({
    queryKey: SUPPORTER_KEY,
    queryFn: () => ipc.syncSupporterStatus(),
    enabled: publishes,
  });
  const membership = supporterState(supporter.data ?? null);
  const on = publishes && membership !== "unknown" && membership !== "never";

  useEffect(() => {
    if (!on) return;
    let live = true;
    const pass = () => {
      // Through a promise so a host with no such command — a test's partial `ipc`, a plain
      // `vite dev` — is a rejection swallowed here rather than a throw out of a timer.
      Promise.resolve()
        .then(() => ipc.shareAutoUpdate())
        .then(
          (updated) => {
            if (!live || updated.length === 0) return;
            client.setQueryData<ShareRow[]>(SHARE_LIST_KEY, (rows) =>
              rows?.map((row) => updated.find((u) => u.id === row.id) ?? row),
            );
          },
          // A failed upload is already in `error_log`, its old snapshot is still serving, and the
          // next pass tries it again. Nothing the reader pressed failed, so nothing is said.
          () => {},
        );
    };
    const first = setTimeout(pass, AUTO_UPDATE_FIRST_MS);
    const every = setInterval(pass, AUTO_UPDATE_EVERY_MS);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [on, client]);
}
