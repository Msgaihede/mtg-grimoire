/**
 * The folders the **app** owns, drawn beside the cabinet the reader owns — one entry per deck,
 * and the single `Recently removed`. Design spec §7.1, and PR 3's Bucket F.
 *
 * **Pinned, flat and locked, and every one of those three words is a decision.**
 *
 * *Pinned*: it is drawn at every level rather than only at the root, because it is how a reader
 * reaches `Recently removed` from three drawers down without walking back out — and because a
 * section that moved as you navigated would not be one a reader could learn the position of. It
 * costs a bounded band; the scroller below is what bounds it.
 *
 * *Flat*: `collection_folders.parent_id` is `NULL` on every row schema v25 creates and no command
 * can nest anything under one, so there is no tree here to build. It also means the summary's
 * *direct* count is the whole count for these — the arithmetic `subtotalsOf` does for the reader's
 * tree has nothing to add up here, and asking it to would be an answer computed from a tree these
 * rows are deliberately not in.
 *
 * *Locked*: no rename, no delete, no move, and no `⋯` at all. `collection_folders`' every write
 * refuses a folder that is not `kind = 'user'`, in words (`FOLDER_NOT_YOURS`), so a menu here
 * would be three rows that each end in a refusal — and a control whose only outcome is a sentence
 * explaining that it does not work teaches the reader nothing they could not have been shown by
 * its absence.
 *
 * **Neither kind is a drop target, and the two refusals are not the same refusal.**
 *
 * * A **deck group** is refused because a copy reaches one only through `collection_to_deck`,
 *   which writes the `deck_cards` row in the same transaction. A bare drag would call
 *   `collection_set_folder`, which knows nothing about decks — so it would file the copy into the
 *   group with **no deck card behind it**: the collection would say the copy is in a deck the deck
 *   has never heard of, and the deck's own list would go on reading as though it were missing.
 *   That is the exact asymmetry `collection_alloc.rs` exists to make impossible, and a ring here
 *   would be this page opening a second door into it.
 * * **`Recently removed`** is refused one layer lower down: `collection_folders::set_entry_folder`
 *   calls `user_folder` on its **destination**, so the write is refused whatever this page draws.
 *   A ring is a promise, and a ring over a target the backend always says no to is a promise the
 *   next press breaks.
 *
 * **What a reader can do is drag a copy _out_**, which is the whole of #209's "so you can sort
 * them back into your collection": the source side is not fenced, so a row standing in
 * `Recently removed` files into any folder the reader made. `CollectionPage` draws the reader's
 * own top-level drawers as the wall inside that folder for exactly this, and its `canFile` is
 * where the matching half — a copy may not be dragged *out* of a deck group either — is written.
 */
import { Inbox, Layers } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import type { CollectionFolder } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { folderFace, type CollectionFolderTotals } from "./CollectionFolderCard";

/** `CollectionFolder.kind` for the one folder that stands for a deck — `schema::
 *  COLLECTION_FOLDER_KINDS[1]`, spelled here because `kind` crosses the wire as a plain string. */
export const DECK_KIND = "deck";
/** `COLLECTION_FOLDER_KINDS[2]` — the single holding area, of which a partial unique index makes
 *  a second impossible. */
export const REMOVED_KIND = "removed";

/**
 * The app's own folders out of a list that also carries the reader's, in the order this section
 * draws them.
 *
 * **Sorted by name, which is this page's opinion rather than a second one.** Schema v25 writes
 * `sort_order = 0` on every group it creates, so the backend's `ORDER BY sort_order, id` is
 * deck-**id** order — the order the decks happened to be made in, which is not an order a reader
 * can predict or scan. The reader's own tree is left in the backend's order because there
 * `sort_order` is a field they will one day arrange.
 */
export function pinnedFolders(folders: readonly CollectionFolder[]): {
  decks: readonly CollectionFolder[];
  removed: CollectionFolder | null;
} {
  return {
    decks: folders
      .filter((folder) => folder.kind === DECK_KIND)
      .sort((a, b) => a.name.localeCompare(b.name)),
    removed: folders.find((folder) => folder.kind === REMOVED_KIND) ?? null,
  };
}

export function PinnedFolders({
  decks,
  removed,
  totals,
  currency,
  openFolderId,
  onOpen,
}: {
  decks: readonly CollectionFolder[];
  removed: CollectionFolder | null;
  /**
   * One folder's figures, or `null` while the summary read is still in flight — which is a
   * different answer from an empty folder and is drawn as an em dash. The caller looks it up
   * rather than this component holding the map, so the page's one `summaryQuery.isPending` branch
   * decides for both walls at once.
   */
  totals: (folder: CollectionFolder) => CollectionFolderTotals | null;
  currency: Currency;
  /** Which folder the reader is standing in, so the entry they are inside says so. */
  openFolderId: number | null;
  onOpen: (folderId: number) => void;
}) {
  // A database with neither kind is one no migration has reached — v25 makes the removed folder
  // unconditionally — so this is the honest empty answer rather than a guard: nothing to pin, no
  // heading, and no band of empty chrome under the breadcrumb.
  if (decks.length === 0 && removed === null) return null;

  return (
    <div className="shrink-0">
      {decks.length > 0 && (
        <>
          {/* `h3` because the page's own `sr-only` heading is the `h2`. The heading is what makes
              this a *section* rather than more folder cards: without it the reader has a wall of
              drawers, half of which cannot be renamed and take no cards, and nothing on screen
              saying which half is which. */}
          <h3 className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-dim">Decks</h3>
          {/* Bounded, for the wall above's reason: a reader with twenty decks must not lose the
              cards to the list of them. **No `DROP_MARK_ROOM` here and that is not an omission** —
              that padding exists to keep a drop ring and a focus outline out of the clip, and
              nothing in this band is a drop target. The focus ring still is: `FOCUS` is
              `outline-offset-2`, so the scroller carries `p-0.5` of its own to keep the top and
              bottom rows' rings whole. */}
          <div className="relative max-h-28 overflow-y-auto p-0.5">
            <ul
              aria-label="Deck folders"
              className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5"
            >
              {decks.map((folder) => (
                <PinnedFolder
                  key={folder.id}
                  folder={folder}
                  Icon={Layers}
                  summary={totals(folder)}
                  currency={currency}
                  open={openFolderId === folder.id}
                  onOpen={() => onOpen(folder.id)}
                />
              ))}
            </ul>
          </div>
        </>
      )}

      {removed !== null && (
        // Its own list, and outside the `Decks` heading: the holding area is not a deck, and a
        // reader scanning under that word for their decks must not find a row that is not one.
        // No heading of its own — the folder is named `Recently removed`, which is the heading.
        // `p-0.5` is the scroller's above, repeated so this row's left edge lines up with the deck
        // entries rather than sitting 2px inside them.
        <ul aria-label="Removed cards" className={cn("p-0.5", decks.length > 0 && "mt-1.5")}>
          <PinnedFolder
            folder={removed}
            Icon={Inbox}
            summary={totals(removed)}
            currency={currency}
            open={openFolderId === removed.id}
            onOpen={() => onOpen(removed.id)}
          />
        </ul>
      )}
    </div>
  );
}

/**
 * One pinned entry: a door into the folder, and the two figures its face says.
 *
 * **A component rather than a branch inside the `.map` above, because `useTooltip` is a hook** —
 * the same reason `CollectionBreadcrumb`'s `Segment` is one.
 *
 * **Solid-bordered where a folder card is dashed**, which keeps that dash meaning what it means
 * everywhere else in this app: *provisional*. A binder the reader made is a container they can put
 * a card into and take one out of; a deck group and the holding area are records of where copies
 * already **are**, maintained by the app, and nothing the reader does on this page moves a card
 * into one. A solid border is the visible half of "locked", and the missing `⋯` is the other half.
 */
function PinnedFolder({
  folder,
  Icon,
  summary,
  currency,
  open,
  onOpen,
}: {
  folder: CollectionFolder;
  Icon: typeof Layers;
  summary: CollectionFolderTotals | null;
  currency: Currency;
  open: boolean;
  onOpen: () => void;
}) {
  const tip = useTooltip();
  const { shown, spoken } = folderFace(summary, currency);

  return (
    <li>
      <button
        type="button"
        // The name first and the figures as a sentence after it — `CollectionFolderCard`'s
        // arrangement, and WCAG 2.5.3. The word after the name is what tells the two pinned kinds
        // apart out loud, where the icon does it on screen.
        aria-label={`${folder.name} ${folder.kind === DECK_KIND ? "deck" : "folder"}, ${spoken}`}
        // `"true"` rather than `"page"`, which the breadcrumb's last segment already carries for
        // this very folder — two elements claiming to be the current *page* is one claim too many,
        // and this one is "the entry you are inside" rather than "where you are".
        aria-current={open ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "block w-full rounded-lg border border-border p-2 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          open && "border-accent",
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2">
          <Icon className="size-3.5 flex-none text-dim" aria-hidden="true" />
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
