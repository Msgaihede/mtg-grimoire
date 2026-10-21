/**
 * A wall of deck tiles: its tracks, and the two facts every tile on it reads once for the whole
 * wall.
 *
 * Lifted out of `DecksPage.tsx` when the Playtesting lobby came to draw the same wall to pick
 * decks from: two walls of one tile at two track widths, or with a bracket worked out two ways,
 * would be one deck drawn two ways in one app.
 */
import { useCallback, useMemo, type CSSProperties } from "react";
import { atLeast, scaled } from "@/lib/cardZoom";
import type { DeckRow } from "@/lib/ipc";
import type { PipCounts } from "@/lib/mana";
import { bracketLabel, useDeckBrackets } from "./useDeckBrackets";
import { useDeckPips } from "./useDeckPips";
import { useFormatSpecs } from "./useFormatSpecs";

/**
 * A tile's narrowest track, in px, at 100% zoom — the number the reader's gesture multiplies.
 *
 * A constant rather than a class because it is arithmetic now: {@link wallStyle} builds the
 * track out of it, and the tiles the track sizes carry the same zoom in their own type and
 * marks. It is deliberately not spelled as a Tailwind arbitrary value anywhere in this file,
 * comments included — this file is under Tailwind's `@source`, so writing one would go on
 * emitting a rule for a utility nothing uses.
 */
export const TILE_MIN_WIDTH = 200;

/** The gutter between tiles at 100% zoom (`gap-4`'s 16px), floored by {@link atLeast}. */
const TILE_GAP = 16;

/**
 * The wall's tracks and gutter at `zoom`.
 *
 * `auto-fill`, not `auto-fit`: with two decks in the gallery `auto-fit` collapses the empty
 * tracks and stretches those two across the whole window, which blows a 626 px art crop up to
 * half a screen. `auto-fill` keeps a tile a tile — and it is what makes the zoom read as *more
 * decks on screen* rather than as bigger boxes, because the column count is what falls out of a
 * track the reader has resized.
 *
 * The gutter takes {@link atLeast} rather than {@link scaled}: it is the one measurement here
 * that sits **between** tiles rather than **on** one, and halving it at 0.5× is exactly the zoom
 * a reader chose in order to see more decks at once.
 */
export function wallStyle(zoom: number): CSSProperties {
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(${scaled(TILE_MIN_WIDTH, zoom)}px, 1fr))`,
    gap: atLeast(TILE_GAP, zoom),
  };
}

/** What {@link useDeckWallMarks} answers, and what a wall hands each tile it draws. */
export interface DeckWallMarks {
  /** Every deck's printed pips; a deck the read has not reached is missing, and draws no band. */
  pipsByDeck: Map<number, PipCounts>;
  /** Each Commander deck's estimated bracket floor — the sort's `bracket` key reads it too. */
  floorByDeck: Map<number, number>;
  /** The tile's bracket pill, or `null` where the format has no command zone or nothing has answered. */
  bracketFor: (deck: DeckRow) => string | null;
  /** Whether a bracket pill is *coming* — see `DeckTile`'s `bracketExpected`. */
  bracketExpectedFor: (deck: DeckRow) => boolean;
}

/** A wall whose reads have not answered, or a surface with none to make: no bands, no pills. */
export const NO_WALL_MARKS: DeckWallMarks = {
  pipsByDeck: new Map(),
  floorByDeck: new Map(),
  bracketFor: () => null,
  bracketExpectedFor: () => false,
};

/**
 * The colours and the bracket of every deck in `decks`, each in one read for the whole wall.
 *
 * **One query each rather than one per tile**, for the reason the zoom is one store read handed
 * down: a folder of forty decks would otherwise be forty subscriptions and forty round trips for
 * a fact the backend can fold in a single statement.
 *
 * **Which decks even *have* a bracket is a question about the format rather than about the
 * deck** — `format_specs.commander_rule`, the same cell the editor's own bracket button is
 * fenced on. The array is the whole of the bracket read's cost, so a wall with no Commander deck
 * builds an empty one rather than every id: {@link useDeckBrackets} is `enabled`-gated on its
 * length, so a reader whose decks are all Modern pays no IPC call for a pill they will never see.
 * It is every deck handed in and not only the ones on screen, which costs one read and buys two
 * things: walking into a folder asks nothing new, and the `bracket` sort can order any wall the
 * moment it is picked.
 *
 * `formatSpecFor` rather than a map read out of the hook: {@link useFormatSpecs} exposes the
 * lookup and keeps the map private, and the lookup is a `useCallback` over it, so these are as
 * stable as the table is (`staleTime: Infinity` — it changes once per app version).
 */
export function useDeckWallMarks(decks: readonly DeckRow[]): DeckWallMarks {
  const { byDeck: pipsByDeck } = useDeckPips();
  const { formatSpecFor } = useFormatSpecs();
  const commanderDeckIds = useMemo(
    () => decks.filter((d) => formatSpecFor(d.formatKey)?.commanderRule != null).map((d) => d.id),
    [decks, formatSpecFor],
  );
  const { floorByDeck } = useDeckBrackets(commanderDeckIds);
  /**
   * The words on a tile's bracket pill, or `null` for a tile that draws none.
   *
   * `null` both for a format with no command zone and for a Commander deck no read has answered
   * yet — never `Bracket ?`, never a placeholder. {@link bracketLabel} decides the rest: the
   * reader's own answer where they gave one, the estimate's floor with a `~` where they did not.
   */
  const bracketFor = useCallback(
    (deck: DeckRow) =>
      formatSpecFor(deck.formatKey)?.commanderRule != null
        ? bracketLabel(deck.bracket, floorByDeck.get(deck.id))
        : null,
    [formatSpecFor, floorByDeck],
  );
  const bracketExpectedFor = useCallback(
    (deck: DeckRow) => formatSpecFor(deck.formatKey)?.commanderRule != null,
    [formatSpecFor],
  );
  return useMemo(
    () => ({ pipsByDeck, floorByDeck, bracketFor, bracketExpectedFor }),
    [pipsByDeck, floorByDeck, bracketFor, bracketExpectedFor],
  );
}
