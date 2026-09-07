import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { CardGrid } from "@/features/search/CardGrid";
import { FilterBar, type FilterLabels } from "@/features/search/FilterBar";
import { summaryOf } from "@/features/search/SearchPage";
import type { CardSearch } from "@/features/search/useCardSearch";
import type { ZoomSection } from "@/lib/cardZoom";
import { FOCUS } from "@/lib/focus";
import { ipcError, type CardSummary } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { pricesAsOf } from "@/lib/prices";
import { priceRange } from "@/lib/priceRange";
import { cn } from "@/lib/utils";

/**
 * How wide a tile is in a docked search column at 100%, and the number that decides whether the
 * column shows one card or two at its opening width.
 *
 * 384 is **331** by the time the panel's own left padding (12), the scrollbar (17) and the
 * wall's padding (24) are off it — measured at 330 in the running window — which is 23 short
 * of two of `CardGrid`'s standard 170px tiles. At the standard size the column drew one
 * 330×490 card per row inside a 341px-tall wall: less than a whole card, ever. At 150 the same
 * 331 is two tiles with 19px of gutter split either side, which is the "~2 tiles per row" these
 * panels were scoped around.
 *
 * **All of that describes 100% zoom at the opening width, and only that.** Two things move it and
 * both are the reader's: `CardGrid` scales this by the zoom held for the column's own section
 * (every card section carries its own number), so at 2× the column draws one 300px tile and at
 * 0.5× four 75px ones; and the panel itself is draggable, so the 331 is only where it starts.
 * Neither needs an override — the measurement is what sets the resting value, and everything
 * downstream is arithmetic on it.
 */
export const TILE_BASE = 150;

/**
 * Whether a tile's card is a Commander **game changer**, for the crown `CardArt` draws in the
 * tile's top-right chip.
 *
 * The same wall over the same rows, so it says the same thing: `gameChanger` is a fact about the
 * *card* and not about the view it is drawn in, and a card crowned on the search page and bare
 * here would teach the reader that the mark means something about the wall. **Which is also why
 * it is not a slot** — three surfaces each deciding whether to crown is three chances to
 * disagree about one fact.
 *
 * The chip is shared with the finish mark and holds the crown alone here, because this wall
 * passes no `finish` — its tiles are 150px and the sheen is the search view's.
 *
 * Module scope, which is what `CardGrid` asks of every per-card callback it takes: a tile
 * re-registers its drag when a callback in its ref's dependency list changes identity, and these
 * panels re-render on every keystroke in their search box.
 */
const tileGameChanger = (card: CardSummary) => card.gameChanger;

export interface CardSearchBodyProps {
  /**
   * The caller's own `useCardSearch(...)`, handed down rather than mounted here.
   *
   * **Because the options are the caller's and are not all the same shape.** The deck panel seeds
   * the Format select from the open deck and narrows `owned` to what *that deck* can use
   * (`availableForDeck`); the collection's and the wishlist's sidebars ask for neither. A body
   * that called the hook itself would have to take every one of those options as a prop and hand
   * them straight back through — and the mount gate would move with it, which is the one thing
   * that must not: the panel's `open` is what decides whether a `search_cards` is issued at all,
   * and it does that by not rendering this component.
   */
  search: CardSearch;
  /**
   * What this surface calls its search box and the `id` stem its labels bind through.
   *
   * **Not optional in practice even though it has a default**, because two of these panels can
   * never be on screen at once but a panel and its *page's* own filter row always are: two
   * mounted `FilterBar`s sharing an `idStem` share their `id`s, and the second `<label htmlFor>`
   * then names the first one's field.
   */
  labels?: FilterLabels;
  /**
   * Which stored zoom sizes these tiles — the column's own section, never the page wall's.
   *
   * The two walls are on screen together, so one number would make a ctrl+wheel over the sidebar
   * resize the list the reader is filing into, which they did not ask for and cannot undo
   * separately. See `ZOOM_SECTIONS`.
   */
  zoomSection: ZoomSection;
  /**
   * What a press in here picks *within* — distinct per surface for the same reason
   * {@link zoomSection} is: two walls on one screen must pass different scopes, or picking in the
   * sidebar puts the page's own selection down.
   */
  selectionScope: string;
  /** The tile width at 100% zoom. {@link TILE_BASE} unless a surface has measured something
   *  else. */
  baseTileWidth?: number;
  /**
   * Why the last add was refused, or `null` — drawn as a banner above the filter row.
   *
   * The caller's because the write is: each surface presses a different command through a
   * different mutation, and the sentence a failed one produces is `ipcError`'s over that error.
   */
  addFailure?: string | null;
  /**
   * The tile's drag registration, at the lower of `CardGrid`'s two seams — the deck panel's,
   * which registers its own `cardDraggable` on the element.
   *
   * **Exactly one of this and {@link dragRecord}.** They do not compose and `CardGrid` enforces
   * it: `dragRecord` wins where both are passed, so a caller that sent both would silently lose
   * this one.
   */
  tileRef?: (card: CardSummary, element: HTMLElement | null) => void | (() => void);
  /** The tile's drag registration at `CardGrid`'s own seam — a flat record of one or more marks,
   *  which is what the collection and the wishlist sidebars pass. See {@link tileRef}. */
  dragRecord?: (card: CardSummary) => Record<string, unknown> | null;
  /** What rides the tile's caption — the owned/wishlisted pair on every surface that draws one. */
  badge?: (card: CardSummary) => ReactNode;
  /** The tile's one control: `Add to <pile>` on the deck, `AddToCollectionButton` on the other
   *  two. */
  action?: (card: CardSummary) => ReactNode;
  /** What a tile offers on a right-click — the page's own card menu, already built. */
  cardMenu?: (
    card: CardSummary,
    picked: readonly CardSummary[],
  ) => ((e: ReactMouseEvent) => void) | undefined;
  /** The same menu from the keyboard. Its own slot rather than something derived from the one
   *  above, because a keypress has no coordinates; see `CardGrid`'s `cardMenuKey`. */
  cardMenuKey?: (
    card: CardSummary,
    picked: readonly CardSummary[],
  ) => ((e: ReactKeyboardEvent) => void) | undefined;
  /** Which tile is open in the card surface, so the wall can mark it. */
  selectedId: string | null;
  /**
   * Open the card a tile is about.
   *
   * One argument, and the row is deliberately dropped: `CardGrid`'s `onSelect` widened to
   * `(id, card)` for the walls whose tiles are not simply printings. These are — one tile per
   * printing, no keys, no finishes — so there is nothing on the row a caller wants. Passing the
   * store's own setter bare would also line the tile's `CardSummary` up against that setter's
   * *second* parameter, which is an optional `Finish`, and fail to compile.
   */
  onSelect: (id: string) => void;
}

/**
 * The wall and its furniture, in the order a docked search column draws them: the add-failure
 * banner, the filter row, the one live region, the refresh/next-page failure with its `Try
 * again`, the wall itself, and the as-of line under it.
 *
 * **A fragment and never a box**, which is what keeps these six flex children of
 * `CardSearchPanel`'s own column: the panel's `gap-2`, the `min-h-0` chain and the wall's
 * `flex-1` distribute exactly as they did when this was written out inside the deck panel.
 *
 * `layoutToggle={false}` on all three surfaces and it is not a prop: a panel has no table — that
 * is `CardSearchPanel`'s whole shape — so the grid-or-table pair would move a *stored* preference
 * and change nothing the reader can see from here.
 *
 * **What is a slot and what is not is the whole design of this file.** A slot is something the
 * three surfaces genuinely answer differently — what a press writes, what a tile carries when it
 * is dragged, which zoom and which selection scope. Everything that is a fact about the *card* is
 * built in: the crown, the price spread and the as-of sentence under it. Three surfaces each free
 * to decide whether a Commander game changer wears a crown is three chances to teach the reader
 * that the mark means something about which wall they found the card on.
 */
export function CardSearchBody({
  search,
  labels,
  zoomSection,
  selectionScope,
  baseTileWidth = TILE_BASE,
  addFailure = null,
  tileRef,
  dragRecord,
  badge,
  action,
  cardMenu,
  cardMenuKey,
  selectedId,
  onSelect,
}: CardSearchBodyProps): ReactElement {
  const { query, rows, searchKey, marketplace } = search;
  // The currency the chins quote in. Taken off the search's own marketplace rather than read
  // again here, so the rows and the money on them come from one answer — that marketplace is in
  // the query key, so a switch refetches instead of re-labelling figures from another feed.
  const currency = marketplace.currency;

  // query-core keeps the pages it has when a fetch fails, so `isError` arrives with rows still
  // in hand — reading it as "show the error instead" would throw away results the reader is
  // part way through.
  const failure = query.isError ? ipcError(query.error) : null;
  const empty = rows.length === 0;

  return (
    <>
      {/* Grown into place rather than shoved in: this panel is a fixed-width column of stacked
          rows, so a banner appearing at the top of it pushes the filter row, the summary and
          the whole wall of tiles down together. The animated element is the wrapper and carries
          only `overflow-hidden` — `statusLine` takes `height` to 0, and under `box-sizing:
          border-box` a box with its own padding and border can never be shorter than the two of
          them. */}
      <AnimatePresence initial={false}>
        {addFailure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              Could not add that card — {addFailure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <FilterBar search={search} labels={labels} layoutToggle={false} />

      {/* One live region, mounted for as long as the panel is open: a region that appears
          together with its text announces nothing, because there was no change to notice. */}
      <p
        role="status"
        className={cn(
          "shrink-0 text-xs",
          empty && failure ? "text-destructive" : "text-dim",
          empty && "py-8 text-center",
        )}
      >
        {summaryOf(search, failure)}
      </p>

      {/* The wall below is what moves when this arrives, so it grows in for the reason the
          add banner above it does. Same split for the same reason: padding and border on the
          child, height and `overflow-hidden` on the animated wrapper. */}
      <AnimatePresence initial={false}>
        {!empty && failure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              <span className="min-w-0">
                {query.isFetchNextPageError
                  ? "Could not load more cards"
                  : "Could not refresh these"}{" "}
                — {failure}
              </span>
              {query.isFetchNextPageError && (
                <button
                  type="button"
                  onClick={() => void query.fetchNextPage()}
                  className={cn(
                    "ml-auto shrink-0 rounded-md border border-destructive/40 px-2 py-0.5",
                    "transition-colors duration-150 hover:bg-destructive/20 motion-reduce:transition-none",
                    FOCUS,
                  )}
                >
                  Try again
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!empty && (
        <CardGrid
          rows={rows}
          // The panel's own search, so a new one starts at the top of the wall rather than
          // wherever the last one was scrolled to.
          listKey={searchKey}
          zoomSection={zoomSection}
          // Ctrl and Shift build a set of tiles here, and a drag from any member carries all of
          // them (issue #214).
          selectionScope={selectionScope}
          baseTileWidth={baseTileWidth}
          selectedId={selectedId}
          onSelect={(id) => onSelect(id)}
          tileRef={tileRef}
          dragRecord={dragRecord}
          // The crown in a tile's top-right chip: the same fact the search view's wall marks,
          // marked the same way here — see `tileGameChanger`.
          gameChanger={tileGameChanger}
          // What the chin says one copy costs — the **spread**, through `priceRange`, which is
          // the search page's own helper over the same rows. This *is* the card search in a
          // narrow column: same hook, same collapse, so a card that costs one thing on the search
          // page and another in here would be the reader learning that a price means something
          // about which wall they found it on. A collapsed row stands for every printing that got
          // past the filters, so a single figure would be a claim about one of them; equal ends
          // collapse to one price rather than repeating themselves.
          //
          // Spec §5's as-of sentence is said once for this wall, not on every tile, which is why
          // this slot is a bare figure.
          money={(card) => priceRange(card.priceLow, card.priceHigh, currency)}
          // The whole tile is the target — the art, its corner chip and the caption under it.
          // The wall's own `cardMenu` slot, so this component knows nothing about menus beyond
          // where a right-click lands.
          cardMenu={cardMenu}
          cardMenuKey={cardMenuKey}
          badge={badge}
          action={action}
          onNeedNextPage={() => {
            if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
              void query.fetchNextPage();
            }
          }}
        />
      )}

      {/* **Spec §5: a price is never shown without saying how old it is** — said once under the
          wall, in the same words and the same voice as the other catalogue walls, so they read as
          one thing.

          **This is the narrowest surface in the app, so it is the one where the sentence costs
          height — and it costs less than it looks like it will.** Measured headless over the built
          stylesheet with the real webfont, at the 193px content box `MIN_PANEL_WIDTH_PX` (206)
          leaves: **two lines, 33.59px**, and the same two lines for all five marketplaces —
          including the longest, `"Card Kingdom prices as of the last price-feed refresh."` At the
          panel's 384px opening width it is **one line, 16.8px**. So the worst case is one extra
          line of 11.2px type at a width the reader has to drag to.

          Drawn unconditionally either way: the rule has no narrow-surface exemption, and a price
          with no date is worse than a wall one line shorter. `shrink-0` so the wall gives up the
          height rather than this being squeezed to nothing.

          **Serve dist over http to re-measure this, never `file://`** — dist's CSS references its
          fonts with absolute `/assets/…` URLs, which from a file page resolve to the drive root
          and fall back to the generic sans-serif without saying so. The tell is measuring one
          string twice, once in the app's stack and once forced to `sans-serif`: identical widths
          mean the real face never loaded (265.2px against the true 272.78px here).

          Unconditional on the layout, unlike the search page's and the Tags page's, because a
          panel has no table: the wall is the only thing that can be on screen here. */}
      {!empty && <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>}
      {/* No `prefetchImages` effect, deliberately — the search view's warms a page of 50
          because a 1 200px wall shows forty tiles at once, and the reader is a scroll away from
          the rest. Two tiles per row is not that wall: `CardGrid`'s overscan already mounts the
          next two rows of `<img>`s, which is four images ahead of the reader by the same
          protocol and no round trip of its own. */}
    </>
  );
}
