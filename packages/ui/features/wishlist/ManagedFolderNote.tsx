/**
 * The sentence over a deck's managed wishlist, read from inside it — its own file since the
 * managed folders became shelves (2026-09-26) and `ManagedWishFolders`, the strip that held both,
 * was deleted.
 */
import type { MouseEvent } from "react";
import { Layers } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The line a reader reads standing **inside** a managed folder: whose list this is, that it keeps
 * itself, and the way to the deck that decides it.
 *
 * Said once here rather than as a greyed stepper on every tile — the wishes inside draw no editing
 * controls at all, and this sentence is what makes that absence read as a rule rather than as a
 * broken wall. The deck's name is the deck's own managed folder's: Rust names that folder after the
 * deck and renames it with the deck — so inside its Tokens subfolder (user schema v55), which is
 * named `Tokens` on every deck, the host hands the parent's name rather than the child's.
 */
export function ManagedFolderNote({
  deckName,
  onOpenDeck,
  deckLink,
}: {
  deckName: string;
  /** The way to the deck as a press — the desktop's, where opening a deck is a store write. */
  onOpenDeck?: () => void;
  /**
   * The way to the deck as a **link** — the light app's phone face, where opening a deck changes
   * the URL, and a control that changes the URL is a real `<a href>` so a middle click and "copy
   * link" work and a screen reader hears *link*. Given, it is drawn in place of the button.
   */
  deckLink?: { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };
}) {
  const look = cn(
    "rounded-md text-accent underline-offset-2 hover:underline",
    "motion-reduce:transition-none",
    FOCUS,
  );
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
      <Layers className="size-3.5 flex-none" aria-hidden="true" />
      <span>Managed by the deck “{deckName}”. Updates automatically and can’t be edited here.</span>
      {deckLink !== undefined ? (
        <a {...deckLink} className={look}>
          Open deck
        </a>
      ) : (
        <button type="button" onClick={onOpenDeck} className={look}>
          Open deck
        </button>
      )}
    </p>
  );
}
