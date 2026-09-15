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
 * which is `src/CLAUDE.md`'s second arm of Scryfall's artist rule met by construction. An `art`
 * crop would have needed a credit beside every tile, and a film strip has no room for one.
 *
 * ## The tile is sized from the box, in JavaScript
 *
 * The design sized each tile in container units off the card's own height, because its runtime
 * could not measure. **This page may not use a container** (`fit.ts`'s module doc says why), and it
 * does not need one: `fit.bodyHeightPx` is the body's measured height, so a tile's art is that
 * height less the caption line under it and the strip's own scrollbar, and its width is 5/7 of
 * that. **Both are reserved whether or not they are drawn**: the caption keeps its line with the
 * names switched off (`visibility: hidden`, so switching them does not move the art), and the
 * scrollbar's height is budgeted whether or not the strip overflows — a budget that depended on
 * whether the content it sizes happens to overflow is a budget that cannot settle. The one
 * exception is a still, which clips rather than scrolls and so never draws a bar at all.
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

/** `.scrollbar-slim`'s horizontal bar — `src/index.css` draws it 10px tall. */
export const STRIP_BAR_PX = 10;

/** The shortest a tile's art is drawn, so a card squeezed below its footprint still reads as a
 *  card rather than a sliver; the body scrolls past it. */
const MIN_ART_PX = 48;

const PENDING = "Reading the cards you opened…";
export const EMPTY = "Cards you open anywhere in the app will appear here.";

/**
 * How many tiles a card of this footprint draws — the design's rule, verbatim: the reader's
 * `count`, but never more than two a cell of width and never fewer than two.
 */
export function tileCount(count: number, w: number): number {
  return Math.min(count, Math.max(2, Math.min(8, w * 2)));
}

/** A tile's art height, in pixels — the body less the caption and the strip's bar. */
export function artHeight(fit: WidgetFit, still: boolean): number {
  const reserved = CAPTION_PX + (still ? 0 : STRIP_BAR_PX);
  return Math.max(MIN_ART_PX, Math.floor(fit.bodyHeightPx - reserved));
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
        Could not read the cards you opened — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  const cards = query.data.slice(0, tileCount(count, fit.w));
  if (cards.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;

  const height = artHeight(fit, still);
  // Floored, so the 5:7 frame built from this width is never taller than the height budgeted.
  const width = Math.floor((height * 5) / 7);

  return (
    <ul
      aria-label="Recently viewed cards"
      className={cn(
        // `relative` because a scroll container has to be the containing block for its own
        // positioned content — `src/CLAUDE.md`'s phantom-scroll rule.
        "relative m-0 flex shrink-0 list-none items-start gap-1.5 p-0",
        // A still clips: a scroller behind `pointer-events: none` is a bar nobody can move.
        still
          ? "overflow-hidden"
          : "overflow-x-auto overflow-y-hidden scrollbar-slim scrollbar-accent",
      )}
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
