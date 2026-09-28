/**
 * The one bulk write per list that can still be taken back, offered where the list is drawn —
 * issue #555.
 *
 * `@/lib/bulkUndo` holds the ticket and the sentence; whoever made the write (an import's
 * preview, `Remove from collection`, `Move to`) puts them there, and this draws them on the page
 * that owns the list: the sentence, **Undo**, and a ✕ that takes the offer down unpressed. It
 * reads nothing but that store and writes nothing but `bulk_undo`, so a page mounts it with one
 * prop.
 *
 * **The region is mounted for the life of the page and the offer is swapped into it**, the
 * collection's *Needs review* banner's arrangement one row down: a live region that appears
 * together with its own sentence announces nothing, because there was no change for a screen
 * reader to notice. A newer write replacing the offer changes the words in place — not keyed on
 * the ticket, which would draw two notices crossing for the length of the fade — so the new
 * sentence is announced as the change it is. `className` is the host's, for the one thing a host
 * knows and this does not: how much flex gap an empty region is holding open.
 *
 * **A refusal is said in the page's alert voice and takes the offer down.** `bulk_undo` refuses a
 * ticket whose rows have changed since and one it no longer holds, and either refusal retires the
 * ticket — so an offer left on screen after one would be a button promising a second press the
 * backend will answer the same way. The sentence is `CardMenuRefusal`'s box, for that
 * component's own reason: the same markup pasted once per surface is a place per surface for it
 * to drift. It stays until a newer offer replaces it, the page banner's rule — a refusal speaks
 * for the state of the list until something else does.
 *
 * **Both answers re-read the list.** A success put rows back, so the scope's roots are refetched
 * — `OWNED_WRITE_KEYS` through `invalidateOwnedWrite` for the collection (every figure counted
 * from `collection_entries`, the search's owned badges patched in place, every deck), and the
 * wishlist page's own `settleWhole` pair for a wishlist. A refusal says a row has changed since,
 * which is a list this page may be drawing stale, so it takes the same re-read: the refused
 * write's rule everywhere else on these pages.
 */
import { useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Undo2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { useBulkUndo, useUndoOffer, type UndoOffer, type UndoScope } from "@/lib/bulkUndo";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { invalidateOwnedWrite, refreshCardSearches } from "@/lib/searchMarks";
import { cn } from "@/lib/utils";

/** What an undo owes the cache, by the list the ticket was about. */
function settleUndo(client: QueryClient, scope: UndoScope): void {
  if (scope === "collection") {
    invalidateOwnedWrite(client);
    return;
  }
  // `WishlistPage`'s `settleWhole`: every wish list and subtotal, and the search's hearts.
  void client.invalidateQueries({ queryKey: ["wishlist"] });
  void refreshCardSearches(client);
}

/** The words the ✕ answers to. Named for what it takes down, so it is never read as a close
 *  button for the page around it. */
export const DISMISS_UNDO = "Dismiss";

export function UndoNotice({
  scope,
  className,
}: {
  scope: UndoScope;
  /** The host's layout for the always-mounted region — `empty:-mt-2` in a `gap-2` column, so a
   *  region saying nothing gives back the gap it would otherwise hold open. */
  className?: string;
}) {
  const offer = useUndoOffer(scope);
  const drop = useBulkUndo((s) => s.drop);
  const queryClient = useQueryClient();
  const tip = useTooltip();

  /** The last refusal's sentence, as the alert draws it — or `null`. */
  const [refusal, setRefusal] = useState<string | null>(null);
  // **A newer offer takes the refusal down**, adjusted during render rather than in an effect:
  // the refusal is about a ticket that is gone, and a new write has replaced it as the thing this
  // region speaks for. `seen` is the offer this render last saw, so the comparison is identity.
  const [seen, setSeen] = useState<UndoOffer | null>(offer);
  if (seen !== offer) {
    setSeen(offer);
    if (offer !== null) setRefusal(null);
  }

  const undo = useMutation({
    mutationFn: (id: number) => ipc.bulkUndo(id),
    onMutate: () => setRefusal(null),
    onSuccess: (outcome) => settleUndo(queryClient, outcome.scope),
    onError: (error) => {
      setRefusal(`Couldn't undo — ${ipcError(error)}`);
      settleUndo(queryClient, scope);
    },
    // **`drop` names the ticket that was pressed**, so an answer arriving after a newer write has
    // replaced the offer cannot take that newer one down — the store's own `id` guard.
    onSettled: (_outcome, _error, id) => drop(scope, id),
  });
  const pending = undo.isPending;

  return (
    <>
      <div role="status" aria-label="Undo" className={className}>
        <AnimatePresence initial={false}>
          {offer !== null && (
            // `statusLine` and `overflow-hidden` on a wrapper with no box of its own, the failure
            // banner's grow-in beside it and for its reason: `height` animates to 0, and a box
            // with padding and a border can never be shorter than the two of them.
            <motion.div {...statusLine} className="overflow-hidden">
              {/* The *Needs review* banner's box — the page's own voice for a line that offers an
                  act rather than reporting a failure — with the right padding tightened so the ✕
                  sits in the corner rather than a gutter in from it. */}
              <div
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border",
                  "bg-surface py-1.5 pr-1.5 pl-3 text-xs",
                )}
              >
                <span className="min-w-0 flex-1">{offer.label}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    // **`aria-disabled`, never `disabled`**, while the undo is on its way: a
                    // `disabled` button leaves the tab order, and the caret on it would drop to
                    // `<body>`. The press is refused here instead.
                    aria-disabled={pending || undefined}
                    onClick={() => {
                      if (pending) return;
                      undo.mutate(offer.id);
                    }}
                    // The *Needs review* banner's `Show them`, verbatim but for the glyph: the one
                    // accent press in a surface-toned box, which is what a banner offering a single
                    // act looks like on this page already.
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border border-accent px-2 py-1",
                      "text-accent transition-colors duration-150 motion-reduce:transition-none",
                      "hover:bg-accent hover:text-accent-foreground",
                      "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent",
                      "aria-disabled:hover:text-accent",
                      FOCUS,
                    )}
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    Undo
                  </button>
                  <button
                    type="button"
                    aria-label={DISMISS_UNDO}
                    {...tip(DISMISS_UNDO, { describes: false })}
                    onClick={() => drop(scope, offer.id)}
                    className={cn(
                      "rounded-md p-1 text-dim",
                      "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
                      "motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <CardMenuRefusal error={refusal} />
    </>
  );
}
