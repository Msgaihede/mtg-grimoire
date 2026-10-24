/**
 * The last cards the reader opened, as a strip of card faces — each a press that opens the card
 * again.
 *
 * **A body, not a card.** `WidgetCard` draws the title and the tray; this draws the strip, sized
 * to the box it was handed.
 *
 * ## Why this is not a `WidgetRow` list
 *
 * `WidgetParts.tsx` names this body as the one that draws something none of its pieces fit: the
 * whole point of the widget is the picture, and a row's 34px art slot is a thumbnail beside a name
 * rather than a card a reader recognises from across the page. So the strip is its own markup, and
 * it borrows nothing from the rows but the dim ink of its captions.
 *
 * ## Full cards, never crops
 *
 * Each tile draws `CardArt` at the `grid` variant — the whole printed card, credit line included —
 * which is `packages/ui/CLAUDE.md`'s second arm of Scryfall's artist rule met by construction. An `art`
 * crop would have needed a credit beside every tile, and a film strip has no room for one.
 *
 * ## The tiles are laid out to the box, in JavaScript, and never scroll
 *
 * The design sized each tile in container units off the card's own height, because its runtime
 * could not measure. **This page may not use a container** (`fit.ts`'s module doc says why), and it
 * does not need one: `fit.bodyWidthPx` and `fit.bodyHeightPx` are the body's measured box, so
 * {@link tileGrid} tries every arrangement of the tiles in rows and keeps the one that draws them
 * largest — one row on a wide band, two or more on a tall card — with a tile's art 5/7 as wide as
 * it is tall and its caption line under it.
 *
 * **Until issue #1379 the strip was one row sized off the height alone, and scrolled sideways.**
 * A 2 × 3 card drew one tall card, a sliver of the next and a scrollbar under them; almost every
 * footprint clipped its last tile at the edge. Laid out against both axes the tiles always fit, so
 * the strip clips rather than scrolls and there is no bar to budget for. A box too small for every
 * tile at {@link MIN_TILE_PX} draws fewer of them rather than smaller ones nobody can read.
 *
 * The caption keeps its line with the names switched off (`visibility: hidden`), so switching them
 * does not move the art.
 *
 * ## One read, whatever the box
 *
 * The strip asks for {@link RECENT_CARDS_READ} cards — the most any setting of this widget draws —
 * and cuts what came back to the tiles that fit. A read sized to the tile count would re-issue
 * itself on every drag of the resize corner, and draw *pending* over a strip that was already
 * right.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { CardArt } from "@/components/CardArt";
import { FOCUS_INSET } from "@/lib/focus";
import { ipc, ipcError, type RecentCard } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

import type { WidgetFit } from "../fit";
import { recentCardsKey } from "../keys";
import { WidgetMessage } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOn } from "../widgetSettings";

/** How many cards the strip reads: the largest `count` the registry offers. See the module doc. */
export const RECENT_CARDS_READ = 8;

/** The caption under a tile: a 4px gap and one 16px line of 11px type, the design's. Reserved even
 *  with names off. */
export const CAPTION_PX = 20;

/** The gap between two tiles, across and down — `gap-1.5`, spelled for the arithmetic. */
export const TILE_GAP_PX = 6;

/** The narrowest a tile is drawn — art 56px tall — so a card squeezed below its footprint draws
 *  fewer tiles rather than slivers. */
export const MIN_TILE_PX = 40;

const PENDING = "Loading recent cards…";
export const EMPTY = "Cards you open will show up here.";

/**
 * How many tiles a card of this footprint draws — the design's rule, verbatim: the reader's
 * `count`, but never more than two a cell of width and never fewer than two.
 */
export function tileCount(count: number, w: number): number {
  return Math.min(count, Math.max(2, Math.min(8, w * 2)));
}

/** How the tiles are arranged: `count` of them, in `rows` × `columns`, each `width` wide. */
export interface TileGrid {
  count: number;
  rows: number;
  columns: number;
  /** The tile's width, floored, so the 5:7 frame built from it is never taller than budgeted. */
  width: number;
}

/**
 * The arrangement that draws up to `wanted` tiles largest in this body — see the module doc.
 *
 * Every row count is tried, each with the fewest columns that hold the tiles, and a tile's width is
 * the smaller of what the columns leave across and what the rows leave down (less the caption line,
 * at 5:7). Ties go to fewer rows. When even the best arrangement is narrower than
 * {@link MIN_TILE_PX}, one tile fewer is tried, down to one.
 */
export function tileGrid(wanted: number, fit: WidgetFit): TileGrid {
  for (let count = Math.max(1, wanted); ; count--) {
    let best: TileGrid | null = null;
    for (let rows = 1; rows <= count; rows++) {
      const columns = Math.ceil(count / rows);
      if (Math.ceil(count / columns) !== rows) continue;
      const across = (fit.bodyWidthPx - TILE_GAP_PX * (columns - 1)) / columns;
      const down = (fit.bodyHeightPx - TILE_GAP_PX * (rows - 1)) / rows - CAPTION_PX;
      const width = Math.max(0, Math.floor(Math.min(across, (down * 5) / 7)));
      if (best === null || width > best.width) best = { count, rows, columns, width };
    }
    if (best !== null && (best.width >= MIN_TILE_PX || count === 1)) return best;
  }
}

export function RecentCardsWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const count = Number(pickOf(widget, "count") ?? RECENT_CARDS_READ);
  const named = toggleOn(widget, "names");
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);

  const query = useQuery({
    queryKey: recentCardsKey(RECENT_CARDS_READ),
    queryFn: () => ipc.recentCards(RECENT_CARDS_READ),
  });

  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load recent cards — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  const wanted = Math.min(query.data.length, tileCount(count, fit.w));
  if (wanted === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;

  const grid = tileGrid(wanted, fit);
  const cards = query.data.slice(0, grid.count);
  const { width } = grid;

  return (
    <ul
      aria-label="Recently viewed cards"
      // Centred on both axes: the tiles are as large as the tighter axis allows, and what the other
      // axis has left over is shared on both sides rather than left in one strip. `overflow-hidden`
      // whether still or not — the grid fits by construction, so there is nothing to scroll — and
      // `relative` with it, because a clipping box has to be the containing block for its own
      // positioned content (`packages/ui/CLAUDE.md`'s phantom-scroll rule).
      className="relative m-0 grid flex-1 list-none content-center justify-center overflow-hidden p-0"
      style={{
        gridTemplateColumns: `repeat(${grid.columns}, ${width}px)`,
        gap: TILE_GAP_PX,
      }}
    >
      {cards.map((card) => (
        <li key={card.cardId} className="flex-none" style={{ width }}>
          <Tile
            card={card}
            named={named}
            still={still}
            width={width}
            onOpen={() => setSelectedCardId(card.cardId)}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * One card: the face, and its name under it.
 *
 * **A button, except in a still**, which opens nothing. The accessible name is written out —
 * the card's name and its set — because the name alone does not tell two printings of one card
 * apart, and the caption is `visibility: hidden` (so not in the name at all) whenever the reader
 * switched names off. An `aria-label` outranks the button's contents, so `CardArt`'s `alt` adds
 * nothing to that name — it is passed for the frame's own fallback, which prints the name on a
 * card whose picture has not arrived, and in a still (no button) it is the tile's only name.
 *
 * The focus mark is the **inset** outline: the tile fills a box that clips, so an outline standing
 * off its edge would be painted where nobody sees it (`FOCUS_INSET`'s own note).
 */
function Tile({
  card,
  named,
  still,
  width,
  onOpen,
}: {
  card: RecentCard;
  named: boolean;
  still: boolean;
  width: number;
  onOpen: () => void;
}): ReactElement {
  const inner = (
    <>
      <span className="block" style={{ width }}>
        <CardArt cardId={card.cardId} name={card.name} variant="grid" loading="lazy" />
      </span>
      <span
        className="mt-1 block h-4 truncate text-left text-[0.6875rem] leading-4 text-dim"
        // **The tile's own width, spelled out.** Stretched by the button's flex column it measured
        // 148px under a 106px tile in the shipped window (2026-09-15), because a nowrap line's
        // min-content is its whole text — so `truncate` clipped nothing and every name ran into the
        // next tile's.
        style={{ width, visibility: named ? "visible" : "hidden" }}
      >
        {card.name}
      </span>
    </>
  );
  if (still) return <div className="flex flex-col">{inner}</div>;
  return (
    <button
      type="button"
      aria-label={`${card.name} · ${card.setCode.toUpperCase()}`}
      onClick={onOpen}
      className={cn("flex flex-col rounded-lg", PRESS, FOCUS_INSET)}
    >
      {inner}
    </button>
  );
}
