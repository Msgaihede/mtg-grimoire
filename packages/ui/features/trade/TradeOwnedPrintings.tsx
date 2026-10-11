import { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { CardGrid, type GridSections } from "@/features/search/CardGrid";
import { plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { ipcError } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { ShelfSection } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import type { PrintingsRequest, TradePrintingsTarget } from "@/lib/store";
import { cn } from "@/lib/utils";
import { DECK_COPIES_HEADING, DECK_COPIES_WARNING, deckHolding, printingLabel } from "./tradeWords";
import { useOwnedPrintings } from "./useOwnedPrintings";
import type { TradeCandidate } from "./useTradeCandidates";

/**
 * One of the reader's copies as a tile: a printing in a finish, outside every deck or in one.
 *
 * `ringKey` is the printing and finish without the deck, so the line's own copy is ringed in both
 * sections when a deck holds it too — the line is a printing and a finish, not a folder.
 */
type OwnedTile = TradeCandidate & { id: string; ringKey: string };

/** The two shelves, as the wall's sectioned layout wants them. Ids are this wall's own. */
const OUTSIDE_SHELF = 1;
const DECKS_SHELF = 2;

function shelf(id: number, name: string, headless: boolean): Shelf {
  return {
    id,
    kind: headless ? "folder" : "deck",
    group: "own",
    name,
    pathIds: [id],
    path: [name],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless,
    collapsed: false,
    locked: false,
  };
}

/**
 * The tile's accessible name: the card, which printing, which finish — and the deck, for a copy
 * a deck is holding, so a screen reader hears the cost before the press rather than after it.
 */
function tileName(row: TradeCandidate): string {
  const printing = `${row.setCode.toUpperCase()} ${row.collectorNumber}, ${FINISH_LABEL[row.finish]}`;
  return row.deckName === null
    ? `${row.name} (${printing})`
    : `${row.name} (${printing}, in ${row.deckName})`;
}

function toTile(row: TradeCandidate): OwnedTile {
  return { ...row, id: row.cardId, name: tileName(row), ringKey: `${row.cardId}:${row.finish}` };
}

/** The copy's own finish: a tile here *is* a finish, the collection wall's rule. */
const tileFinish = (row: OwnedTile) => row.finish;

/**
 * `MH2 · 138 · 3 owned`, and for a deck's copy `MH2 · 138 · 1 in Serah` in the destructive colour —
 * the add field's own words for the same two rows.
 */
const tileCaption = (row: OwnedTile) => {
  const label = printingLabel(row.setCode, row.collectorNumber);
  const owned = row.owned ?? 0;
  return row.deckName === null ? (
    `${label} · ${owned} owned`
  ) : (
    <span className="text-destructive">{`${label} · ${deckHolding(owned, row.deckName)}`}</span>
  );
};

const NO_NEXT_PAGE = () => {};

/**
 * The trade line's printings wall **for a line the reader's collection supplies** (issue #902):
 * every printing of the card they hold, rather than every printing there is.
 *
 * **Split exactly as the add field splits it.** The copies outside every deck come first, with no
 * heading; the copies a deck is holding follow under *In your decks*, with the add field's warning
 * and every caption naming its deck in red. A press on either rewrites the line onto that printing
 * **and that finish** — a copy the reader holds is one printing in one finish, so a foil tile makes
 * the line foil — and the modal closes on the write's success. A refusal stays up beside the wall.
 *
 * A press on the copy the line already is changes nothing and only closes.
 *
 * Drawn by `AllPrintingsDialog` in place of its own body, inside the same shell, so the
 * header, the scrim and every way of closing are the modal's own.
 */
export function TradeOwnedPrintings({
  request,
  target,
  countSlot,
  onDone,
}: {
  request: PrintingsRequest;
  target: TradePrintingsTarget;
  /** The modal header's subtitle node, which the count line is portalled into. */
  countSlot: HTMLElement | null;
  onDone: () => void;
}) {
  const owned = useOwnedPrintings(request.oracleId, target.marketplace);
  const marketplace = MARKETPLACES[target.marketplace];
  const { currency } = marketplace;

  const outside = useMemo(() => owned.rows.map(toTile), [owned.rows]);
  const inDecks = useMemo(() => owned.deckRows.map(toTile), [owned.deckRows]);
  const tiles = useMemo(() => [...outside, ...inDecks], [outside, inDecks]);

  const sections = useMemo<readonly ShelfSection[]>(() => {
    const list: ShelfSection[] = [];
    if (outside.length > 0) {
      list.push({ shelf: shelf(OUTSIDE_SHELF, "Your copies", true), tileCount: outside.length });
    }
    if (inDecks.length > 0) {
      list.push({
        shelf: shelf(DECKS_SHELF, DECK_COPIES_HEADING, false),
        tileCount: inDecks.length,
      });
    }
    return list;
  }, [outside, inDecks]);
  const tilesOf = useCallback(
    (id: number) => (id === OUTSIDE_SHELF ? outside : id === DECKS_SHELF ? inDecks : []),
    [outside, inDecks],
  );

  const grid: GridSections<OwnedTile> = {
    sections,
    tilesOf,
    // The add field's heading and its warning, in the same colour and with the same glyph: the
    // two surfaces are one question asked twice and must look like it.
    renderHeading: () => (
      <div className="flex h-10 flex-col justify-center gap-0.5 border-t border-destructive/40 pt-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {DECK_COPIES_HEADING}
        </span>
        <span className="truncate text-xs text-destructive">{DECK_COPIES_WARNING}</span>
      </div>
    ),
    renderEmpty: () => null,
    renderLabel: () => null,
    renderSticky: () => null,
  };

  const choose = useMutation({
    mutationFn: ({ cardId, finish }: { cardId: string; finish: TradeCandidate["finish"] }) =>
      target.choose(cardId, finish),
    onSuccess: onDone,
  });
  const writing = choose.isPending;
  const start = choose.mutate;

  const onSelect = useCallback(
    (cardId: string, tile: OwnedTile) => {
      if (writing) return;
      if (cardId === request.cardId && tile.finish === target.finish) {
        onDone();
        return;
      }
      start({ cardId, finish: tile.finish });
    },
    [writing, request.cardId, target.finish, onDone, start],
  );

  const money = useCallback((row: OwnedTile) => formatPrice(row.unitPrice, currency), [currency]);

  const countLine =
    inDecks.length > 0
      ? `${plural(outside.length + inDecks.length, "printing")} in your collection, ${inDecks.length} in your decks`
      : `${plural(outside.length, "printing")} in your collection`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5 pt-4">
      {!owned.pending && owned.error === null && countSlot && createPortal(countLine, countSlot)}

      {owned.pending && <p className="shrink-0 text-xs text-dim">Loading your copies…</p>}
      {owned.error !== null && (
        <p className="shrink-0 text-xs text-destructive">
          Couldn't read your copies — {owned.error}
        </p>
      )}
      {choose.isError && (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          Couldn't change the trade line's printing — {ipcError(choose.error)}
        </p>
      )}
      {!owned.pending && owned.error === null && tiles.length === 0 && (
        <p className="shrink-0 text-sm text-dim">
          Your collection holds no copy of this card a trade can take.
        </p>
      )}

      {tiles.length > 0 && (
        <div
          aria-busy={writing || undefined}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            writing && "pointer-events-none opacity-60",
          )}
        >
          <CardGrid
            rows={tiles}
            sections={grid}
            onSelect={onSelect}
            onNeedNextPage={NO_NEXT_PAGE}
            listKey={`trade-owned:${request.oracleId}`}
            zoomSection="printings"
            selectedId={`${request.cardId}:${target.finish}`}
            label={`Your copies of ${request.name}`}
            finish={tileFinish}
            caption={tileCaption}
            money={money}
          />
          <p className="shrink-0 pt-1 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
        </div>
      )}
    </div>
  );
}
