import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HOLDINGS_KEY } from "./cardKeys";

/**
 * Refetch the grimoire figures whenever **any** write in the app has finished.
 *
 * **This is the price of one read replacing three, and it is a mechanism rather than a
 * belt-and-braces.** Every writer that can move these three numbers settles its own roots and
 * only its own: `useCardMenuDeps`' collection add fires all four of `query.ts`'s
 * `OWNED_WRITE_KEYS`, its wishlist add fires `["wishlist"]` and `["cards", "search"]`,
 * `AllPrintingsDialog`'s wish fires the same pair, and an ordinary deck write fires `["decks"]`
 * alone. {@link HOLDINGS_KEY} can sit under exactly one of those, so a key chosen for any one
 * writer is a figure that silently stops moving for the others — and `query.ts`'s 30 s
 * `staleTime` is what turns that into *a wrong number on screen* rather than a slow one.
 *
 * **The last write in flight settling is the one signal that catches all of them**, including
 * the three presses the desktop modal makes through callbacks it cannot chain: the action row's
 * two adds go through `CardMenuDeps`, whose `mutate` returns `void`, and `Add to deck` reaches the
 * app's single `useCardToDeck` through a context that returns `void` too. A mutation's own
 * `onSuccess` has already run by the time its status leaves `pending`, so when the last one
 * settles every root the writer meant to settle is settled and the backend row is committed —
 * this read is the last one to be asked and gets the written answer.
 *
 * **Heard from the mutation cache, not read off `useIsMutating`** (2026-10-04). That hook was
 * this one's first shape — an effect on its count, firing when it fell to zero — and it rests on
 * React *rendering* the count while it is above zero. A write answered inside one task never is:
 * the count goes 0 → 1 → 0 between two renders, the effect sees 0 and 0, and nothing is
 * invalidated. The desktop's IPC always took a task, so it held there; over the Storybook fake
 * — which is what every phone test runs on — the effect ran once, at mount, and never again. The
 * cache's own event has no render in it to miss.
 *
 * What it costs is **one extra read per press while a card is open**, and nothing while none is:
 * invalidating a key nothing is mounted on marks what is cached stale and fetches nothing. A
 * write that cannot have moved a holding (a label, a deck cover) pays it too; that is the same
 * trade the desktop modal's `settle` already makes by firing four roots for a write that moves
 * one of them.
 *
 * **Its own module since 2026-10-04, because the phone face draws these figures too** and had
 * nothing settling them: its card sheet read the same key (`mobile/phone/CardSheet.tsx`), so
 * after the sheet's own *Add to collection* it still said `Owned 0`, and went on saying it when
 * closed and opened again. It was a function inside `CardDetailModal.tsx`, which reaches the app
 * store and so is a file the phone face may not import (`mobile/phone/fence.test.ts`); it never
 * read the store itself, so it moved as it was. **Where it is mounted decides what it hears**:
 * the desktop mounts it with the open card, the phone face with the sheet's shell, which is
 * mounted whether or not a card is open — so a copy removed on the page *behind* a closed sheet
 * is heard there too.
 */
export function useHoldingsFreshness(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "updated") return;
        // Settled either way: a refused write may still have moved a row before it was refused.
        const { status } = event.mutation.state;
        if (status !== "success" && status !== "error") return;
        // Not until the last of them: a press that makes two writes is read once, after both.
        if (queryClient.isMutating() > 0) return;
        void queryClient.invalidateQueries({ queryKey: HOLDINGS_KEY });
      }),
    [queryClient],
  );
}
