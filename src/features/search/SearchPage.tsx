import { useCallback, useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { CountTag } from "@/components/CountTag";
import { FinishMark } from "@/components/FinishMark";
import { GameChangerMark } from "@/components/GameChangerMark";
import { ManaText } from "@/components/ManaText";
import { OwnedBadge } from "@/components/OwnedBadge";
import { RarityGem } from "@/components/RarityGem";
import { VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import type { DragPayload } from "@/features/decks/dnd";
import { parseFinishes, soleFinish } from "@/lib/finish";
import { ipc, ipcError, type CardSummary } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { statusLine } from "@/lib/motion";
import { pricesAsOf } from "@/lib/prices";
import { priceRange } from "@/lib/priceRange";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CardGrid } from "./CardGrid";
import { FilterBar } from "./FilterBar";
import { useCardSearch, type CardSearch } from "./useCardSearch";

/**
 * The six columns of the search table. The last is 2.5rem of quick-add: a 24px button and
 * the room to reach it.
 *
 * Name and type are `2fr`/`1fr` rather than `1fr` and a 16rem cap. A capped track is
 * *inflexible*: grid grows it to its cap out of the free space **before** any `fr` track is
 * fed, so on a narrow window with the card pane open the type column took its 16rem and the
 * name column was left with nothing — a row of mana symbols overflowing a zero-width track
 * across the set beside it. Two flexible tracks share the squeeze instead: at 1280px with
 * the pane open every column keeps a readable share, and closed they measure 381/190 where
 * the cap gave 315/256 — the name, which is what identifies a row, now truncates last.
 *
 * The keys are the backend's, verbatim: `SEARCH_SORTS` in `src-tauri/src/search.rs`. A key
 * that does not match one there is dropped silently at the far end, which is a header that
 * does nothing.
 *
 * A function of the marketplace rather than a module constant, because the Price column is:
 * the sentence in its header names the marketplace and the figures in its cells are read out
 * of that marketplace's currency. Rebuilt only when the marketplace changes — see the
 * `useMemo` in {@link Results}, which is what keeps this off the per-render path.
 */
function columnsFor(marketplace: Marketplace): TableColumn<CardSummary>[] {
  const asOf = pricesAsOf(marketplace);
  const currency = marketplace.currency;
  return [
    {
      key: "name",
      width: "minmax(0,2fr)",
      header: "Name",
      sortable: true,
      cellClassName: "flex items-baseline gap-2",
      cell: (card) => (
        <>
          <span className="truncate">{card.name}</span>
          {/* The printed symbols, from the bundled font — the same rule as the detail pane:
            a cost is read as symbols, and `{1}{W}{U}` is a wire format. */}
          <ManaText source={card.manaCost} className="shrink-0 text-xs" />
          {/* The three marks the tile carries over its art, in the cell that identifies the row —
            because they are facts about the *card*, and the table's other five columns are
            about the printing. One truth, stated the same way in both layouts. */}
          <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />
          {/* The table shows no art, so the glyph carries the whole of what the wall's sheen
            says: this printing exists in one finish and it is not the assumed one. */}
          {tileFinish(card) && <FinishMark finish={tileFinish(card)!} />}
          {/* And the crown, beside it, for the most card-level fact of the lot: the Commander
            bracket counts this one. Over the art it shares the finish chip; here it is a
            sibling of the finish glyph, because a 12px mark in the identifying cell is what
            both layouts have room for and a boxed "GC" badge would out-shout the name it
            annotates. Unlike the finish it needs no `soleFinish`-style derivation — the
            backend has already flattened the column's NULL into `false`. */}
          {card.gameChanger && <GameChangerMark />}
          {/* What a collapsed row stands for. Drawn only past one, because "×1 printings" on
            the 17 588 cards that have a single printing — and on *every* row once All
            printings is on — would be a column of noise saying nothing. */}
          {card.printings > 1 && (
            <span className="shrink-0 text-xs text-dim">×{card.printings} printings</span>
          )}
        </>
      ),
    },
    {
      key: "set",
      width: "8rem",
      header: "Set",
      sortable: true,
      cellClassName: "truncate font-mono text-dim",
      // `setName` is nullable and the code is not, so the code is what is shown; the full name
      // rides along as the tooltip when there is one. Mono because a collector number is data
      // — the same rule as the grid caption and the pane.
      cell: (card) => (
        <span title={card.setName ?? undefined}>
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
      ),
    },
    {
      key: "type",
      width: "minmax(0,1fr)",
      header: "Type",
      sortable: true,
      cellClassName: "truncate text-dim",
      cell: (card) => card.typeLine ?? "—",
    },
    {
      key: "rarity",
      width: "6rem",
      header: "Rarity",
      sortable: true,
      // Gem dot plus tinted word, exactly as the grid tiles caption a rarity — the two views
      // show the same fact and there is no reason for it to look like two facts.
      cell: (card) => <RarityGem rarity={card.rarity} withLabel className="max-w-full" />,
    },
    {
      key: "price",
      width: "6rem",
      header: "Price",
      sortable: true,
      firstDir: "desc",
      // Spec §5: a price is never shown without saying how old it is. The detail pane has room
      // to say it in the open; a 36px header row does not, so the same sentence rides as the
      // column's tooltip and inside its accessible name. The label *begins* with the visible
      // word, which is what keeps an overriding `aria-label` legitimate here (WCAG 2.5.3,
      // label in name) — "Price" still selects this column for anyone driving it by voice.
      headerTitle: asOf,
      headerLabel: `Price. ${asOf}`,
      headerClassName: "text-right",
      cellClassName: "text-right font-mono tabular-nums",
      // The spread across the printings the row stands for. Uncollapsed both ends are the
      // row's own price, so this renders exactly what `formatPrice(card.price, …)` would.
      //
      // The span covers the printings that have a price **at the marketplace the query named**,
      // so the same collapsed row's range is legitimately narrower at one marketplace than at
      // another — or absent at one and present at another, which is an em dash rather than a
      // borrowed number.
      cell: (card) => priceRange(card.priceLow, card.priceHigh, currency),
    },
    {
      key: "actions",
      width: "2.5rem",
      // Nothing to show, and a header a screen reader still needs: an unnamed column is
      // announced as "column 6" for every row.
      header: "Actions",
      srOnlyHeader: true,
      // The row opens the card on any click and on Enter or Space, and every one of those
      // lands here too: without stopping them, recording a copy would also open the card, and
      // typing `12` into the quantity box would scroll the list a screenful.
      interactive: true,
      cell: (card) => (
        <AddToCollectionButton
          className={REVEAL_ON_HOVER}
          target={{
            cardId: card.id,
            name: card.name,
            setCode: card.setCode,
            collectorNumber: card.collectorNumber,
            // Both ride on `CardSummary`, which is what lets a row be honest: the popup
            // offers the finishes this printing exists in — the backend checks the enum and
            // not the card, so a foil-only printing would otherwise take a nonfoil entry —
            // and a wish made here can be for the card rather than for this printing.
            oracleId: card.oracleId,
            finishes: parseFinishes(card.finishes),
          }}
        />
      ),
    },
  ];
}

/**
 * What a tile carries when it is dragged: the printing it draws, and nothing about this view.
 *
 * At module scope because it must hold still — the wall re-registers a tile's drag when this
 * changes identity, and a fresh arrow per render would do that on every scrolled row (see
 * `CardGrid`'s `dragPayload`).
 *
 * The tiles only. The table beside them is the view for *comparing* — five columns of facts
 * and a price — and a row there is read rather than picked up; the drag sources spec §1 names
 * are the wall's tiles, the two lists that are inventories, and the pane's printings.
 */
const tileDrag = (card: CardSummary): DragPayload => ({
  kind: "card",
  cardId: card.id,
  name: card.name,
  // What files the card when it is let go somewhere with no column to point at — the sidebar's
  // Decks entry. `autoCategoryFor`'s only input, carried rather than looked up (`dnd.ts`).
  typeLine: card.typeLine,
});

/**
 * The finish a result row's printing *is*, for the sheen over its art.
 *
 * Only the printings that leave no choice — foil-only and etched-only. Module scope for
 * `tileDrag`'s reason: the wall re-registers a tile when a callback's identity changes.
 */
const tileFinish = (card: CardSummary) => soleFinish(card.finishes);

/**
 * Whether a tile's card is one the Commander bracket counts — the crown, in the same top-right
 * chip as the finish mark.
 *
 * A field read and nothing more, where {@link tileFinish} beside it is a derivation: the backend
 * flattens `cards.game_changer`'s NULL into `false`, so there is no third state to fence and no
 * "which finish leaves no choice" question to answer. Module scope for `tileDrag`'s reason all
 * the same — the wall re-registers a tile's drag when a callback's identity changes, and this one
 * travels the same path.
 */
const tileGameChanger = (card: CardSummary) => card.gameChanger;

/**
 * The card a right-click on a result is about — the same object for a tile and for a table row,
 * because the two layouts draw one list of printings.
 *
 * **No `finish`.** A search row is a *printing*, not a copy: the reader has not said which
 * finish they hold, so "Add to → Collection" offers the ones this printing exists in rather
 * than choosing one for them. That is exactly the field the collection's and the wishlist's
 * adapters do fill, and the difference between the three surfaces is this one line.
 *
 * `typeLine` travels because `CardSummary` carries it and a menu add is filed by what the card
 * does — the same fact, from the same row, that {@link tileDrag} hands a drop.
 */
function cardTarget(card: CardSummary): CardMenuTarget {
  return {
    cardId: card.id,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    oracleId: card.oracleId,
    finishes: card.finishes,
    typeLine: card.typeLine,
  };
}

/**
 * Card search: a filter bar, and every match in one scroll.
 *
 * The result list is virtualised because an unfiltered search matches the whole database
 * — ~117 k rows — and the page opens on exactly that.
 */
export function SearchPage() {
  const search = useCardSearch();
  const { query, searchKey } = search;
  const view = useAppStore((s) => s.searchView);

  // Warm the images for the page that just landed, so its first paint is not a wall of
  // empty frames. The grid's own overscan mounts two rows of off-screen `<img>`s, which
  // covers the *next scroll*; this covers the *next page*. Grid only — the table shows no
  // art to warm.
  //
  // Keyed on an identity of the newest page rather than on `query.data`: an infinite
  // query hands back a new `data` object on every background refetch, and re-firing there
  // would re-walk 50 already-cached images for nothing. The page count alone is not
  // enough either — `keepPreviousData` means a new search with the same number of pages
  // never moves it, so the search the reader actually typed would be the one page that
  // never got warmed.
  const pages = query.data?.pages;
  const pageCount = pages?.length ?? 0;
  const latestPage = pages?.[pageCount - 1]?.items;
  const isPlaceholder = query.isPlaceholderData;
  const latestKey = `${searchKey}|${pageCount}|${latestPage?.[0]?.id ?? ""}`;
  useEffect(() => {
    // Placeholder rows belong to the search *before* this one; they are already warm, and
    // the real page is one render away.
    if (view !== "grid" || isPlaceholder) return;
    if (!latestPage || latestPage.length === 0) return;
    // Fire-and-forget by design: the command resolves as soon as the work is queued, and
    // a tile whose prefetch failed simply fetches when it renders.
    void ipc
      .prefetchImages(
        latestPage.map((c) => c.id),
        "grid",
      )
      .catch(() => {});
    // `latestPage` and `view` are both deliberately out of the dependency list.
    // `latestPage` is a fresh array on every render, and `latestKey` is the part that
    // means "a different page is now the newest one". `view` is read but not depended on:
    // it is a guard, not a trigger. Depending on it would make every table→grid toggle
    // re-send the newest page — 50 keys the grid warmed when they landed and the tiles
    // will hit from disk anyway — which is the same wasted round trip `latestKey` exists
    // to avoid. The cost is that a page which arrives *while the table is showing* is
    // never warmed, not even on the switch back: those tiles fetch as they mount, which
    // is exactly how the grid behaved before this effect existed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey, isPlaceholder]);

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not shown: the filter bar says what this view is far better than a title would,
          and the window is short. It is here to name the view for assistive tech. */}
      <h2 className="sr-only">Card search</h2>

      <FilterBar search={search} />

      <Results search={search} />
    </section>
  );
}

/**
 * How many matches there are, in words.
 *
 * The backend stops counting at 5 000 rather than scanning 116 k rows for a number nobody
 * reads precisely, so past that this says `5,000+ cards` — a floor, which is true —
 * instead of `5,000 cards`, which would not be.
 */
function countOf(total: number, capped: boolean): string {
  const n = `${total.toLocaleString("en-US")}${capped ? "+" : ""}`;
  return `${n} ${total === 1 && !capped ? "card" : "cards"}`;
}

/**
 * The one line that says what the result area is currently showing.
 *
 * Exported for the deck editor's docked panel, which shows the same six states over the same
 * hook in a 384px column. Two copies of these sentences would be two answers to "why is this
 * list empty" — and the one that matters most (an empty database still syncing, which is not
 * a search that missed) is the one a second copy would be likeliest to get wrong.
 */
export function summaryOf(search: CardSearch, failure: string | null): string {
  const { query, rows, total, totalIsCapped, unfiltered } = search;

  if (rows.length === 0) {
    // With no rows there is nothing to caption, so this line carries the whole story.
    if (failure) return failure;
    if (query.isPending) return "Searching…";
    // An unfiltered search asks for everything, so an empty answer to it is a statement
    // about the database, not about the query. Saying "no cards match" here would blame
    // the user for a sync that has not finished.
    return unfiltered
      ? "Card database is empty — waiting for the first sync to finish."
      : "No cards match these filters.";
  }

  const count = countOf(total, totalIsCapped);
  if (query.isFetchingNextPage) return `${count} · loading more…`;
  if (query.isFetching) return `${count} · searching…`;
  return count;
}

function Results({ search }: { search: CardSearch }) {
  const { query, rows, total, totalIsCapped, searchKey, marketplace } = search;
  // Only the Price column depends on it, and a `TableColumn[]` rebuilt every render would
  // re-key every header — so it is rebuilt when the marketplace changes and not otherwise.
  const columns = useMemo(() => columnsFor(marketplace), [marketplace]);
  // Read here rather than taken as a prop: the layout is the result area's own business,
  // and the page above it only needs to know which pager is live.
  const view = useAppStore((s) => s.searchView);
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list
  // never has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);

  /**
   * The right-click menu, built here rather than in either layout: one object for the page, as
   * `CardMenuDeps` asks — the two views are the same list, and a menu whose writes differed
   * between them would be two answers to one question.
   */
  const { menu, menuKey } = useContextMenu();
  const { deps: menuDeps, error: menuFailure } = useCardMenuDeps();
  /** One row's or one tile's handler. The item list is a **thunk** inside `menu`, so a wall of
   *  forty pays for nothing until a reader actually right-clicks one of them. */
  const cardMenu = useCallback(
    (card: CardSummary) => menu(() => buildCardMenu(cardTarget(card), menuDeps)),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key. Wired everywhere `cardMenu` is, because
   *  a menu only a mouse can open is a menu half this app's readers do not have. */
  const cardMenuKey = useCallback(
    (card: CardSummary) => menuKey(() => buildCardMenu(cardTarget(card), menuDeps)),
    [menuKey, menuDeps],
  );

  // query-core keeps `data` when a fetch fails, so `isError` arrives with every page that
  // did load still in hand. Reading it as "show the error instead" would throw away 400
  // rows because page 9 hit the ingest's database lock, or because a window-focus refetch
  // failed on results the reader was part way through.
  const failure = query.isError ? ipcError(query.error) : null;
  const empty = rows.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* One live region, mounted for the life of the view: a region that appears together
          with its text announces nothing, because there was no change for a screen reader
          to notice. The rows stay outside it — a live region wrapped around a virtualised
          list would read out every row that scrolls into the DOM. */}
      <p
        role="status"
        className={cn(
          empty ? "py-16 text-center text-sm" : "text-xs",
          empty && failure ? "text-destructive" : "text-dim",
        )}
      >
        {summaryOf(search, failure)}
      </p>

      {/* The banner grows into place rather than shoving the results list down by its whole
          height the instant a page fails. The animated element is the wrapper and carries only
          `overflow-hidden`: `statusLine` takes `height` to 0, and under `box-sizing:
          border-box` a box with its own padding and border can never be shorter than the two
          of them, so an animated element wearing either would bottom out short and jump the
          rest. `role="alert"` stays on the element that holds the sentence. */}
      <AnimatePresence initial={false}>
        {!empty && failure && (
          <motion.div {...statusLine} className="overflow-hidden">
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span className="min-w-0">
                {query.isFetchNextPageError
                  ? "Could not load more cards"
                  : "Could not refresh these results"}{" "}
                — {failure}
              </span>
              {query.isFetchNextPageError && (
                <button
                  type="button"
                  onClick={() => void query.fetchNextPage()}
                  className="ml-auto shrink-0 rounded-md border border-destructive/40 px-2 py-1 transition-colors hover:bg-destructive/20 motion-reduce:transition-none"
                >
                  Try again
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A write the menu started and the backend refused, said where the reader made it —
          beside the banner above rather than folded into it, because that one is about the
          *list* and this is about a card in it. */}
      <CardMenuRefusal error={menuFailure} />

      {!empty &&
        (view === "grid" ? (
          <CardGrid
            rows={rows}
            listKey={searchKey}
            // Which zoom is this wall's. The search is its own section, so a reader who sizes
            // the results up here has not touched the collection or the deck editor's column —
            // see `CardGrid`'s `zoomSection` for why it is required rather than defaulted.
            zoomSection="search"
            selectedId={selectedCardId}
            onSelect={selectCard}
            // Spec §1's first drag source: a tile is a printing the reader can carry to a
            // deck's category column or to the sidebar. The click paths beside it — the quick-add below,
            // the pane the art opens — are unchanged; this is speed, not capability.
            dragPayload={tileDrag}
            // Spec §7: "'owned' badges appear in search once a wish is fulfilled." Drawn
            // unconditionally because the badge is its own guard — on a browse of the whole
            // database almost every tile has nothing to say, and says nothing.
            badge={(card) => <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />}
            // How many printings this tile stands for, opposite the owned badge. Past one
            // only: on a wall where every tile said "1" the mark would be chrome.
            //
            // **The same object the deck editor counts copies with** — `CountTag`, the filled
            // banner cut off at a slant, in its neutral grey because a printing count is only a
            // count and has no tag to take a colour from. It used to be a `×N` in the wall's own
            // grey chip; a number laid on a card is drawn one way in this app, and the `×` was
            // a second glyph in a 22px box saying what the banner's shape already says.
            //
            // The `title` is the number in plain words, which the corner can surface now that it
            // takes its own pointer events (`CardGrid`'s `Tile`) — and it is the whole of what a
            // pointer user gets, since the mark is `aria-hidden`. It says *matched* rather than
            // "exist", because that is what the number counts: a collapsed row groups the
            // printings that got past the filters, so a search narrowed to one set reports the
            // printings in that set and not the card's whole print run.
            topLeft={(card) =>
              card.printings > 1 ? (
                <CountTag
                  count={card.printings}
                  title={`${card.printings} printings matched these filters`}
                />
              ) : null
            }
            // The 12 366 foil-only and 892 etched-only printings, which Scryfall's art has
            // no way to show — see `soleFinish`.
            finish={tileFinish}
            // The crown, in the same chip as that mark. Held still at module scope like every
            // other callback this wall is handed.
            gameChanger={tileGameChanger}
            // The whole tile is the target: the art, its two corner marks and the caption.
            cardMenu={cardMenu}
            cardMenuKey={cardMenuKey}
            // The tile's one control, built from the row it is about: the popup offers the
            // finishes this printing exists in — a foil-only card must not take a nonfoil
            // entry — and a wish made here can be for the card rather than for this piece of
            // cardboard. `static` hands the anchoring to the tile's caption, so a 256px
            // popup on a 170px tile opens from the tile's left edge instead of off the
            // scroller's.
            action={(card) => (
              <AddToCollectionButton
                align="start"
                className={cn(REVEAL_ON_HOVER, "static")}
                target={{
                  cardId: card.id,
                  name: card.name,
                  setCode: card.setCode,
                  collectorNumber: card.collectorNumber,
                  oracleId: card.oracleId,
                  finishes: parseFinishes(card.finishes),
                }}
              />
            )}
            onNeedNextPage={() => {
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
          />
        ) : (
          <VirtualTable
            rows={rows}
            columns={columns}
            label="Search results"
            // `null` is ARIA's "the total is unknown", which is exactly what a capped count
            // is: 5 000 would be a smaller lie than 20, but still a lie.
            total={totalIsCapped ? null : total}
            // Changing the sort changes the query key and therefore this, so a re-sorted
            // list starts at the top through the scroll-reset that was already there.
            listKey={searchKey}
            sort={search.sort}
            onSort={search.toggleSort}
            // A row opens the card, from the mouse and from the keyboard both — the table is
            // the view for comparing prices, and being unable to open the one you picked
            // would make it a dead end for anyone not using a mouse.
            onActivate={(card) => selectCard(card.id)}
            isSelected={(card) => card.id === selectedCardId}
            // The same menu the wall's tiles offer, on the row that stands for the same
            // printing. A right-click is not an activation: `onActivate` above is a left click
            // and the two keys, and neither of them fires for this one.
            //
            // The row's own `onKeyDown` runs first and is not replaced: it answers Enter and
            // Space (opening the card), and `menuKey` answers Shift+F10 and the ContextMenu key.
            // Two handlers for one event, because the row already had one — dropping `props`'
            // would take the keyboard's route to the *card* away in the act of adding one to
            // its menu.
            renderRow={(props, card) => (
              <div
                {...props}
                onContextMenu={cardMenu(card)}
                onKeyDown={(e) => {
                  props.onKeyDown?.(e);
                  cardMenuKey(card)(e);
                }}
              />
            )}
            onNeedNextPage={() => {
              // `isFetchNextPageError` is a stop, not a detail: a failed page leaves
              // `hasNextPage` true with the reader still at the bottom, so without it this
              // fires on every render — a tight retry loop against a database that is
              // already saying no. The banner's Try again button is the way back.
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
          />
        ))}
    </div>
  );
}
