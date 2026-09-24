/**
 * The wishlist folders the **decks** keep, drawn apart from the drawers the reader keeps — issue
 * #512's "a separate section with a special icon".
 *
 * **`features/collection/PinnedFolders.tsx`, read across to the other cabinet, and deliberately
 * so.** That band is the collection's answer to exactly this shape — folders the app maintains on a
 * deck's behalf, beside folders the reader made — and a reader who has learnt one has learnt this
 * one: its own heading, a solid border where a reader's drawer is dashed, no `⋯`, no drop target,
 * and a press that opens the folder and does nothing else. Each of those is argued at that file;
 * what is this file's own is below.
 *
 * **The glyph is `Layers`, and that is one fact wearing one picture rather than a new icon.** The
 * collection draws its deck groups with `Layers` — "this folder belongs to a deck" — and a managed
 * wishlist folder is that exact statement one cabinet over. `Link2` or `RefreshCw` would each say
 * half of it (tied to something, kept up to date) in a vocabulary this app does not use anywhere
 * else, and `RefreshCw` would read as the Sync feature, which is a different thing entirely.
 *
 * **Drawn at every level, not only at the root where these folders live** — `PinnedFolders`' *pinned*,
 * for its reason: it is how a reader reaches a deck's list from three drawers down without walking
 * back out, and a section that came and went as they navigated is not one whose position can be
 * learnt. Not while flattened, which the caller decides: Flatten's promise is that the filing is off
 * screen, and every managed wish is in that list anyway, captioned with the deck's name.
 */
import { Layers } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import type { WishlistFolder } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { wishFolderFace, type WishFolderSummary } from "./WishFolderCard";

/** The section's heading, and the list's accessible name — one string so the two cannot drift. */
export const MANAGED_SECTION = "Managed by decks";

export function ManagedWishFolders({
  folders,
  totals,
  currency,
  openFolderId,
  onOpen,
}: {
  /** The managed folders only, in the order to draw them — `managedWishFolders`' answer. */
  folders: readonly WishlistFolder[];
  /** One folder's figures, or `null` while the summary is still reading — an em dash rather than
   *  a `0 wishes` that then jumps. See `wishFolderFace`. */
  totals: (folder: WishlistFolder) => WishFolderSummary | null;
  currency: Currency;
  /** The folder the reader is standing in, so the entry they are inside says so. */
  openFolderId: number | null;
  onOpen: (folderId: number) => void;
}) {
  // A reader with no Theory + Actual deck — or with the switch off on every one — has nothing
  // here, and a heading over nothing is chrome with nothing in it.
  if (folders.length === 0) return null;

  return (
    <div className="shrink-0">
      {/* `h3` because the page's own `sr-only` heading is the `h2`, and the typeset of the
          collection's `Decks` heading so the two bands read as one kind of thing. */}
      <h3 className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-dim">
        <Layers className="size-3" aria-hidden="true" />
        {MANAGED_SECTION}
      </h3>
      {/* Bounded, and padded for `FOCUS` rather than for a drop mark — nothing here takes a
          drop. `PinnedFolders`' scroller, verbatim, for its reasons. */}
      <div className="relative max-h-28 overflow-y-auto p-0.5">
        <ul
          aria-label={MANAGED_SECTION}
          className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5"
        >
          {folders.map((folder) => (
            <ManagedWishFolder
              key={folder.id}
              folder={folder}
              summary={totals(folder)}
              currency={currency}
              open={openFolderId === folder.id}
              onOpen={() => onOpen(folder.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * One managed folder: a door into it and what is in it, and nothing else. A component because
 * `useTooltip` is a hook — `PinnedFolder`'s reason.
 */
function ManagedWishFolder({
  folder,
  summary,
  currency,
  open,
  onOpen,
}: {
  folder: WishlistFolder;
  summary: WishFolderSummary | null;
  currency: Currency;
  open: boolean;
  onOpen: () => void;
}) {
  const tip = useTooltip();
  const { shown, spoken } = wishFolderFace(summary, currency);
  return (
    <li>
      <button
        type="button"
        // The name first (WCAG 2.5.3), then the word the glyph says on screen: which kind of
        // folder this is, out loud.
        aria-label={`${folder.name} managed wishlist, ${spoken}`}
        aria-current={open ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          // Solid, where a reader's drawer is dashed: the dash means *a container you file into*,
          // and nothing is filed into this one by hand.
          "block w-full rounded-lg border border-border p-2 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          open && "border-accent",
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2">
          <Layers className="size-3.5 flex-none text-dim" aria-hidden="true" />
          <span
            className="min-w-0 flex-1 truncate text-sm"
            {...tip(folder.name, { whenClipped: true })}
          >
            {folder.name}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs tabular-nums text-dim">{shown}</span>
      </button>
    </li>
  );
}

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
