/**
 * **The deck card's missing figure** — the `0/2` in the chin of a stacked card and a grid tile,
 * coloured by whether the reader owns the card anywhere else (issue #986).
 *
 * - **Red** (`text-destructive`): no copy of the card anywhere in the collection outside this
 *   deck's own group. It has to be bought.
 * - **Gold** (`text-accent`, the app's warning colour — the Toaster's `warning` tone): copies
 *   exist elsewhere — at the root, in a binder, in another deck, in `Recently removed` — and the
 *   tooltip names each place and how many sit there. It has to be fetched, not bought.
 *
 * The answer is `deck_owned_elsewhere`'s, read once per deck by the editor and handed down
 * through {@link OwnedElsewhereContext} rather than through the four memoised view layers. A
 * missing provider (the light app, a story that mounts a view alone) or an answer still loading
 * is `null`, and the figure reads as it always did: red, with no places named. A fully covered
 * card draws no figure at all — the callers' `deckCardShort` decides that, not this.
 *
 * **Any printing and any finish counts as owned elsewhere**, where the figure's own owned count
 * is the exact printing and finish: the colour answers "do I own this card?", and an M10 Bolt in
 * a binder is the answer to that for an Alpha line.
 */
import { createContext, useContext } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { DeckCard, DeckElsewherePlace, DeckOwnedElsewhere } from "@/lib/ipc";

/** Where the reader owns each card the deck is short of, by oracle id — or `null` while there is
 *  no answer, which draws the figure as it was before issue #986. A card owned nowhere else has
 *  no key. */
export type OwnedElsewhereMap = ReadonlyMap<string, readonly DeckElsewherePlace[]>;

export const OwnedElsewhereContext = createContext<OwnedElsewhereMap | null>(null);

/** `deck_owned_elsewhere`'s rows, keyed for {@link OwnedElsewhereContext}. */
export function ownedElsewhereMap(rows: readonly DeckOwnedElsewhere[]): OwnedElsewhereMap {
  return new Map(rows.map((r) => [r.oracleId, r.places]));
}

/** The collection's root, as the Collection page's folder tree and the pull dialog call it. */
const ROOT_LABEL = "Collection";

/** One place in the tooltip's words. A deck's group is named by its deck, so it says so. */
export function placeLabel(place: DeckElsewherePlace): string {
  if (place.kind === null) return ROOT_LABEL;
  const name = place.name ?? ROOT_LABEL;
  return place.kind === "deck" ? `${name} (deck)` : name;
}

/** The places this card is owned outside the deck, or `null` when nothing is known yet. */
export function elsewhereFor(
  card: Pick<DeckCard, "oracleId">,
  map: OwnedElsewhereMap | null,
): readonly DeckElsewherePlace[] | null {
  if (map === null) return null;
  return (card.oracleId === null ? undefined : map.get(card.oracleId)) ?? [];
}

export function ShortfallFigure({ card }: { card: DeckCard }) {
  const tip = useTooltip();
  const places = elsewhereFor(card, useContext(OwnedElsewhereContext));
  const owned = `You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`;
  const content =
    places === null ? (
      owned
    ) : places.length === 0 ? (
      <>
        {owned}
        <br />
        No other copies anywhere in your collection
      </>
    ) : (
      <>
        {owned}
        <br />
        Elsewhere in your collection:
        {places.map((p) => (
          <span key={p.folderId ?? "root"} className="block">
            {p.quantity} in {placeLabel(p)}
          </span>
        ))}
      </>
    );
  return (
    <span
      // `aria-hidden`, and the tooltip `describes: false`: the card's own button already says
      // the shortage in words (`deckCardName`'s "you own N of M" clause), and a screen reader
      // should not hear "1 slash 2" as well.
      aria-hidden="true"
      data-elsewhere={places === null ? undefined : places.length > 0 ? "owned" : "none"}
      {...tip(content, { describes: false })}
      className={
        places !== null && places.length > 0
          ? "shrink-0 tabular-nums text-accent"
          : "shrink-0 tabular-nums text-destructive"
      }
    >
      {card.ownedQuantity}/{card.quantity}
    </span>
  );
}
