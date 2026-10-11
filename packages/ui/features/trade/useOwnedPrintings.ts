import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import {
  collectionCandidates,
  deckCandidates,
  useDeckShelves,
  type TradeCandidate,
} from "./useTradeCandidates";

/** What the owned-printings wall draws: the reader's copies of one card, in two lists. */
export interface OwnedPrintings {
  /** The copies outside every deck, one row a printing and finish. */
  rows: TradeCandidate[];
  /** The copies a deck is holding, one row a printing, finish and deck. Never folded into
   *  {@link rows}. */
  deckRows: TradeCandidate[];
  pending: boolean;
  error: string | null;
}

/**
 * How many collection rows one card's read asks for — the backend's own `MAX_LIMIT`.
 *
 * One oracle card, so this is every copy short of a collection holding five hundred rows of a
 * single card across conditions, languages and binders; Rust clamps anything above it anyway.
 */
const OWNED_ROWS = 500;

const NO_ROWS: TradeCandidate[] = [];

/**
 * Every printing of one card the reader holds, split the way the trade's add field splits them
 * (issue #902).
 *
 * **The add field's two questions, asked of one card instead of of a name.** The first read is the
 * copies a trade can take without costing anything (`allocation: "unallocated"`, no locked folder,
 * and *Recently removed* dropped by kind once the folder list is in); the second is the deck groups
 * and nothing else. Both fold through the same functions {@link useTradeCandidates} folds through,
 * so a printing is offered here exactly as it is under the field — and a deck's copy is never
 * mixed in with the others, because taking it costs that deck a card.
 *
 * **Neither list offers a proxy**, for the add field's reason: a trade never counts one as the card.
 *
 * Under `["collection"]`, so a write that moves a copy refreshes the wall while it is open.
 */
export function useOwnedPrintings(oracleId: string, marketplace: MarketplaceId): OwnedPrintings {
  const { folders, folderList, deckFolders, deckShelves } = useDeckShelves();
  const decksAsked = deckShelves.length > 0;

  const outside = useQuery({
    queryKey: ["collection", "tradePrintings", marketplace, oracleId],
    queryFn: () =>
      ipc.collectionList({
        oracleId,
        allocation: "unallocated",
        excludeLocked: true,
        marketplace,
        limit: OWNED_ROWS,
        offset: 0,
      }),
  });

  const inDecks = useQuery({
    queryKey: ["collection", "tradePrintings", "decks", marketplace, oracleId, deckShelves],
    queryFn: () =>
      ipc.collectionList({
        oracleId,
        shelves: deckShelves,
        marketplace,
        limit: OWNED_ROWS,
        offset: 0,
      }),
    enabled: decksAsked,
  });

  const rows = useMemo(
    () => (outside.data ? collectionCandidates(outside.data.items, folders) : NO_ROWS),
    [outside.data, folders],
  );
  const deckRows = useMemo(
    () => (decksAsked && inDecks.data ? deckCandidates(inDecks.data.items, deckFolders) : NO_ROWS),
    [decksAsked, inDecks.data, deckFolders],
  );

  return {
    rows,
    deckRows,
    // Until the folder list is in, neither which rows are *Recently removed* nor whether there is
    // a deck to ask about is known — so "you hold none of this card" is not known either.
    pending: outside.isPending || folderList.isPending || (decksAsked && inDecks.isPending),
    error: outside.isError
      ? ipcError(outside.error)
      : decksAsked && inDecks.isError
        ? ipcError(inDecks.error)
        : null,
  };
}
