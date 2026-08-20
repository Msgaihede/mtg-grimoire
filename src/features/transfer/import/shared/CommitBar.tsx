/**
 * The footer every destination's preview ends with: Back, one live region, and the button that
 * writes.
 *
 * Shared rather than copied because it is the one row on this surface where a mistake is a
 * reader losing their paste — a Back that resets the text, a refusal announced twice, a button
 * that stays pressable while the write is in flight. Four destinations agreeing about that by
 * accident is four chances to disagree.
 */
import type { JSX } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The one gold control on the surface, in both steps — the same shape `CreateDeckDialog`'s
 * submit carries, at the width a footer button wants rather than a form's full width.
 *
 * Exported because the source step's Preview button is the same control one step earlier, and
 * two footers on one dialog drawing the same button two ways is exactly what `Dialog.tsx` was
 * promoted to stop.
 */
export const PRIMARY = cn(
  "h-9 shrink-0 rounded-md border border-accent px-4 text-sm text-accent",
  "transition-colors duration-[var(--duration-fast)] ease-standard",
  "hover:bg-accent hover:text-accent-foreground",
  "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
  "motion-reduce:transition-none",
);

export interface CommitBarProps {
  /** The button's word at rest — `Import`. */
  label: string;
  /** Its word while the write is in flight — `Importing…`. An action keeps its *name* through
   *  the whole flow, so this is the same verb in another tense and never a different one. */
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
  /**
   * What the live region says, or `""` for nothing.
   *
   * **One region for every answer this step gives** — the write's refusal, and the one reason
   * the button can be dark that the reader cannot see from here. It is rendered always, so the
   * region is in the tree before it has anything to say: a live region mounted together with
   * its own text announces nothing.
   */
  message: string;
  /** Whether {@link message} is a refusal (red) or a note (dim). */
  failed: boolean;
  /** Back to the paste step. The text survives, so a refusal costs one press rather than a
   *  retype. */
  onBack: () => void;
}

/**
 * `role="status"` and not `alert`, which is `TheoryDiffDialog`'s arrangement for the same slot:
 * the region is already on screen and polite is what a reader who is standing here wants.
 *
 * The button is a **submit**, so the preview's own `<form>` is what commits — Enter in the step
 * does what the button does, and the two can never drift.
 */
export function CommitBar({
  label,
  pendingLabel,
  pending,
  disabled,
  message,
  failed,
  onBack,
}: CommitBarProps): JSX.Element {
  return (
    <footer className="flex items-center gap-3 border-t border-border px-5 py-3.5">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          "h-9 shrink-0 rounded-md border border-border px-3 text-sm text-dim",
          "transition-colors duration-[var(--duration-fast)] ease-standard",
          "hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Back
      </button>

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "min-w-0 flex-1 text-right text-xs",
          failed ? "text-destructive" : "text-dim",
        )}
      >
        {message}
      </p>

      <button type="submit" disabled={pending || disabled} className={cn(PRIMARY, FOCUS)}>
        {pending ? pendingLabel : label}
      </button>
    </footer>
  );
}

/**
 * The write every bulk-import destination makes, once its own plan and mode are ready — the
 * collection's and the wishlist's own version of `useImport`'s `commit`.
 *
 * A `useMutation` around whichever `ipc.*ImportCommit` the caller names, invalidating every key
 * in `keys` **on both success and failure** — `useImport`'s rule for `["decks"]`, carried to the
 * two surfaces it does not reach. **The set is not just the destination's own root.**
 * `CollectionPage`'s and `WishlistPage`'s own row-level writes (`settle`/`settleFailure`) each
 * invalidate several keys for a *single* stepper press, because a change to what is owned moves
 * more than one screen: the collection's own list and summary, the wishlist's owned-progress,
 * the search wall's owned badges, and every open deck's allocator claims. A bulk import moves
 * ownership at least as much as one stepper press — usually far more of it — so each caller
 * passes the same set its row-level neighbours do rather than a narrower one of its own; see the
 * two call sites for which keys that is. A refused write can still have been a database another
 * surface has changed, which is why both branches invalidate the same way. **A `useMutation`
 * with no query key of its own**, exactly like `useImport`'s `commit`: two previews calling this
 * hook are two independent mutations, which is what lets one preview's refusal die with it
 * instead of leaking into the other's.
 */
export function useImportCommit<T>(keys: readonly QueryKey[], mutationFn: () => Promise<T>) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
  };
  return useMutation({ mutationFn, onSuccess: invalidate, onError: invalidate });
}
