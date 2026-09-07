import { OwnedBadge } from "@/components/OwnedBadge";
import { dragData } from "@/features/decks/dnd";
import { CardSearchBody } from "@/features/search/CardSearchBody";
import { CardSearchPanel } from "@/features/search/CardSearchPanel";
import { searchCardDragData } from "@/features/search/searchCardDrag";
import { useCardSearch } from "@/features/search/useCardSearch";
import { useSearchOpen } from "@/features/search/useSearchOpen";
import { parseFinishes } from "@/lib/finish";
import type { FolderNode } from "@/lib/folderTree";
import type { CardSummary } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "./AddToCollection";

/**
 * The filter row's own names on this surface — **`collection-add`, which is not the page's
 * `collection`**, and that difference is the whole reason this constant exists.
 *
 * Two `FilterBar`s are mounted together here for the first time anywhere in the app: the page's
 * own row over `useCollection`, and this column's over `useCardSearch`. `idStem` is what every
 * `id` in the row is built from, so one stem shared would make the second row's `<label htmlFor>`
 * name the *first* row's field — a control a screen reader hands the caret to in the wrong column.
 *
 * The box keeps the app-wide `Search cards`, and it is unique on this page for the same reason:
 * the page's own box is `Search your collection`.
 */
const PANEL_LABELS = { idStem: "collection-add", search: "Search cards" } as const;

export interface CollectionSearchPanelProps {
  /**
   * The drawer the reader is standing in — where a press and a drop both file, and **`null` is
   * the root rather than "nothing chosen"** (spec §5.3).
   *
   * Required and never optional, which is the one prop of this component that could have gone
   * either way. `AddToCollectionButton` treats an *absent* `folderId` as "this surface has never
   * thought about folders" and sends no `folderId` field at all — right for the search page and
   * the Tags wall, and wrong here by exactly one wire field: a sidebar over a cabinet has always
   * thought about folders, and the page always has an answer, even when the answer is the root.
   */
  folderId: number | null;
  /** The tree the `+` popup's override picker offers — the reader's own folders, already built
   *  by the page. Deck groups and `Recently removed` are not in it, because nothing may be filed
   *  into either by hand. */
  folderNodes: readonly FolderNode[];
  /** What to call a destination, for the trigger's accessible name and the popup's Folder row.
   *  The page's own `folderNameOf`, handed down rather than re-derived. */
  folderName: (id: number | null) => string | null;
  /** Whether the page's row can hold this column beside the list — measured there, forwarded to
   *  `CardSearchPanel`, whose doc carries the whole of what it decides. */
  roomy?: boolean;
  /** How wide to draw this panel **over** the list, in px, for a row too narrow to hold both.
   *  Absent is a row that can. */
  overWidth?: number;
  /** The widest this panel may be drawn or dragged, in px — the page's answer, because the page
   *  holds the two measurements it is made of. */
  maxWidth?: number;
}

/**
 * The collection's docked card search — **the path by which a card the reader does not own yet
 * gets into the drawer they are standing in.**
 *
 * Chrome from `CardSearchPanel`, wall from `CardSearchBody`, and what is left here is the
 * collection: the destination is the page's open folder rather than a choice made in the popup,
 * the `+` is `AddToCollectionButton` locked to the collection, and a tile can be dragged onto a
 * folder card instead.
 *
 * **Two components rather than one, so the search is a thing the reader asks for.** `useCardSearch`
 * lives in {@link OpenPanel}, which the shell mounts only while the disclosure is open — a hook
 * cannot be called conditionally, so a search sitting in this root would issue a `search_cards`
 * for every reader who ever opened their collection. That is `DeckSearchPanel`'s arrangement and
 * its reason, unchanged.
 *
 * **A fixture of the page, not a dismissible layer**: this panel registers no rung of its own, so
 * Escape pressed in here falls past it. The way to put the column away is the disclosure it names
 * itself by, and that answer is remembered across restarts (`useSearchOpen`).
 */
export function CollectionSearchPanel({
  folderId,
  folderNodes,
  folderName,
  roomy,
  overWidth,
  maxWidth,
}: CollectionSearchPanelProps) {
  const { open, setOpen } = useSearchOpen("collection");

  return (
    <CardSearchPanel
      surface="collection"
      title="Search cards"
      // **A sentence naming the list, where the deck panel's is the bare `Add cards`.** That one
      // sits inside a deck editor, which is a landmark that has already said which deck; this one
      // shares a route with the collection it files into, and the page's own regions are all
      // about the copies the reader *has*. Distinct from the wishlist's for the same reason a
      // probe needs it to be: two panels answering to one name is one of them being found by
      // accident.
      sectionLabel="Add cards to your collection"
      toggleLabel="card search"
      open={open}
      setOpen={setOpen}
      roomy={roomy}
      overWidth={overWidth}
      maxWidth={maxWidth}
    >
      <OpenPanel folderId={folderId} folderNodes={folderNodes} folderName={folderName} />
    </CardSearchPanel>
  );
}

/**
 * Every drawn tile, as a card that can be dropped on a folder — **two marks in one flat record**,
 * which is what lets one gesture mean two things at once.
 *
 * `dragData`'s half is what keeps the tile droppable on a deck category, a quick zone and the
 * sidebar's Decks entry — every target that reads `readCards`, all of which a search tile has
 * always been able to reach. `searchCardDragData`'s half is this feature's own, under its own key,
 * and is what a folder card, the parent-folder tile and a breadcrumb segment read. Each reader
 * answers only its own key and stays blind to the other's, so neither had to learn about the
 * other (`searchCardDrag.ts`).
 *
 * **The finish is `parseFinishes`' first, never a bare string.** `readSearchCardDrag` *refuses* a
 * finish this build does not know rather than normalising it to `nonfoil` — the word is what a new
 * row will be filed under rather than a narrowing of a row that exists — so an unparsed
 * `card.finishes` would be a drop that silently never lands. `?? "nonfoil"` covers the printing
 * whose finish list is empty, which the column allows and means *unknown*.
 *
 * **Module scope, which is what `CardGrid` asks of every per-card callback it takes** and is
 * load-bearing rather than tidy: `dragRecord` is in the dependency list of the ref callback that
 * registers each tile's drag, and this panel re-renders on every keystroke in its search box. A
 * fresh arrow per render would tear down and rebuild every tile's registration between two
 * letters. It reads nothing but its argument, so there is nothing for a closure to capture.
 */
const tileDrag = (card: CardSummary): Record<string, unknown> => ({
  ...dragData({
    kind: "search-card",
    cardId: card.id,
    name: card.name,
    // Carried for the targets that name no pile of their own — the sidebar's Decks entry reads
    // it to decide which category a card lands in. One payload shape, whichever target takes it.
    typeLine: card.typeLine,
  }),
  ...searchCardDragData({
    cardId: card.id,
    name: card.name,
    finish: parseFinishes(card.finishes)[0] ?? "nonfoil",
    oracleId: card.oracleId,
  }),
});

/** The owned/wishlisted pair every wall of printings draws under its tiles. Module scope for
 *  {@link tileDrag}'s reason — `CardGrid` re-registers a tile when a per-card callback changes
 *  identity. */
const tileBadge = (card: CardSummary) => (
  <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />
);

/**
 * The wall, and the one control on each tile — **mounted only while the reader has the disclosure
 * open**, which is the whole reason this is a component rather than a branch in the root above.
 *
 * A collapse throws its search, its filters, its facets and its scroll position away, and that is
 * the intended reading: this is a column you open to do a job and shut when the job is done. **A
 * railing is not a collapse and must not be read as one** — the shell *hides* this subtree when
 * the page's row goes too narrow, so the query and the filters are where the reader left them when
 * the room comes back.
 */
function OpenPanel({
  folderId,
  folderNodes,
  folderName,
}: Pick<CollectionSearchPanelProps, "folderId" | "folderNodes" | "folderName">) {
  /**
   * The card search, unnarrowed.
   *
   * **No `defaultFormat` and no `availableForDeck`**, which the deck panel passes and this one
   * cannot: a format seed is a fact about the deck being built, and `availableForDeck` narrows
   * every `×N` to the copies one deck can use. A collection has neither — the owned count here is
   * the plain one, which is what the reader is comparing the wall against.
   */
  const search = useCardSearch();

  // Read here rather than handed down: the page holds `openCardAsFinish` for its *own* wall, whose
  // tiles are a printing **and a finish**, and a search tile is neither — it is one printing, and
  // the plain opener is what every non-deck surface in the app uses for one.
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const selectCard = useAppStore((s) => s.setSelectedCardId);

  /**
   * The `+`, and where it files.
   *
   * **`lockMode="collection"`, so the wishlist chips are not drawn at all.** A sidebar over the
   * collection adds to the collection: a switch offering the wishlist here would change which page
   * the results the reader is looking at belong to — and it would offer the collection's folder
   * tree for a wishlist add.
   *
   * `align="start"` and `static`, the search wall's own arrangement one page over: the anchor is
   * the tile's caption, and a 256px popup opening leftwards off the first column of a 206px-wide
   * panel would be clipped by the scroller, which is the one direction overflow cannot be
   * scrolled back into view.
   *
   * Not memoised, deliberately: `CardGrid` re-registers a tile's *drag* when a per-card callback
   * moves, and this is not one of those — `action` is rendered rather than registered, and it
   * closes over three props that genuinely move.
   */
  const action = (card: CardSummary) => (
    <AddToCollectionButton
      align="start"
      className={cn(REVEAL_ON_HOVER, "static")}
      lockMode="collection"
      folderId={folderId}
      folderNodes={folderNodes}
      folderName={folderName}
      target={{
        cardId: card.id,
        name: card.name,
        setCode: card.setCode,
        collectorNumber: card.collectorNumber,
        // Both ride on `CardSummary`: the popup offers the finishes this printing exists in — the
        // backend checks the enum and not the card, so a foil-only printing would otherwise take
        // a nonfoil entry — and `oracleId` is what a wish for "any printing" would need.
        oracleId: card.oracleId,
        finishes: parseFinishes(card.finishes),
      }}
    />
  );

  return (
    <CardSearchBody
      search={search}
      labels={PANEL_LABELS}
      // This column's own zoom, never the page wall's: the two walls are on screen together, so
      // one number would make a ctrl+wheel over the sidebar resize the list the reader is filing
      // into.
      zoomSection="collectionSearch"
      // And its own selection scope, for the same reason one rung over: a pick in a new scope
      // replaces the whole set, so a shared scope would make pressing a tile in here put the
      // binder's selection down.
      selectionScope="collection-panel"
      dragRecord={tileDrag}
      badge={tileBadge}
      action={action}
      selectedId={selectedCardId}
      onSelect={selectCard}
    />
  );
}
