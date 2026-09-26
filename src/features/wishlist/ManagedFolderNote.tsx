/**
 * The sentence over a deck's managed wishlist, read from inside it — its own file since the
 * managed folders became shelves (2026-09-26) and `ManagedWishFolders`, the strip that held both,
 * was deleted.
 */
import { Layers } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The line a reader reads standing **inside** a managed folder: whose list this is, that it keeps
 * itself, and the way to the deck that decides it.
 *
 * Said once here rather than as a greyed stepper on every tile — the wishes inside draw no editing
 * controls at all, and this sentence is what makes that absence read as a rule rather than as a
 * broken wall. The deck's name is the folder's own: Rust names the folder after the deck and
 * renames it with the deck.
 */
export function ManagedFolderNote({
  deckName,
  onOpenDeck,
}: {
  deckName: string;
  onOpenDeck: () => void;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
      <Layers className="size-3.5 flex-none" aria-hidden="true" />
      <span>
        Follows the deck “{deckName}” and updates itself when the deck changes — its wishes can’t be
        edited here.
      </span>
      <button
        type="button"
        onClick={onOpenDeck}
        className={cn(
          "rounded-md text-accent underline-offset-2 hover:underline",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Open deck
      </button>
    </p>
  );
}
