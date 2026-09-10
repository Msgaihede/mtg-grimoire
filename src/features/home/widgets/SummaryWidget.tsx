/**
 * What the whole grimoire adds up to: three figures — the collection, the decks and the
 * wishlist — each carrying its copies, its value and the copies that value could not include,
 * and each a press that opens the view it is about.
 *
 * ## Four reads, and why they are four rather than one
 *
 * There is no `home_summary` command and there deliberately is not one. Every figure here is
 * already answered by the command the view it names is built on — `collection_summary`,
 * `deck_list`, `deck_values`, `wishlist_summary` — so a fifth command would be a fifth place
 * the same arithmetic is written, and the first time one of them changed its mind about what
 * it counts this widget would quietly disagree with the page a press from it opens. Four reads
 * of the same rows a reader can navigate to is the whole point: **the number on this card and
 * the number on that page are one query, not two answers.**
 *
 * It is also why the four keys it reads are the roots that data already lives under. Every write
 * in this app already fires `invalidateQueries({ queryKey: ["collection"] })`, `["decks"]` or
 * `["wishlist"]` — `lib/query.ts` names the set — so this widget refreshes after an add, a
 * move or a removal with **no mutation anywhere learning a new key**. A `["home", …]` root
 * would have needed every one of those writes to grow a line, and the 30 s `staleTime` would
 * have hidden whichever one was forgotten.
 *
 * All four live in `../keys`, which is where that argument is written out in full, and it is
 * **one definition apiece rather than four spellings**: `deckListKey` is `["decks", "list"]`
 * **exactly** — `features/decks/useDecks.ts`'s own key rather than a private one beside it —
 * and `collectionTotalKey` and `wishlistTotalKey` are the very functions the two value widgets
 * read through. Two observers of one key are one fetch, so the gallery and this card can never
 * come to disagree about how many decks there are, and neither can this card and the value card
 * beside it about what the collection is worth.
 *
 * ## Money
 *
 * Every figure is quoted at the marketplace the reader picked, which is why its id is in each
 * priced key: switching marketplace re-issues the query rather than re-reading a second field
 * that does not exist. `formatPrice` writes it and `pricesAsOf` dates it — the sentence rides
 * as each figure's tooltip, exactly as it does on `CollectionSummary`'s value, because a row of
 * three figures has nowhere to print it. A `null` is an em dash and never another marketplace's
 * number.
 *
 * ## Why the figures are `<button>`s and not `@/components/Figure`
 *
 * `Figure` draws a `<dt>`/`<dd>` pair, which is only valid inside a `<dl>` — and a `<dl>` is
 * flow content, which a `<button>` (phrasing content only, no interactive descendants) may not
 * contain. So a pressable figure is either a real button that is not a `Figure`, or a `Figure`
 * inside a `<div role="button">`; `NewFolderCard.test.tsx` refuses the second in writing, and
 * it is right to — a div with that role is in no tab order and answers neither activation key
 * without handlers this file would have to write and keep correct.
 *
 * So these are real buttons wearing `Figure`'s own type scale, the way
 * `features/decks/stats/DeckFigures.tsx` already keeps a private figure of its own for a
 * reason of its own. The scale is copied deliberately rather than abstracted: what has to
 * match is what a reader *sees*, and this app's figures are one grammar in three surfaces.
 *
 * ## The three sentences
 *
 * Loading, empty and refused are three different statements and never one shrug. "We have not
 * read it yet", "there is nothing to read" and "the read was refused" send a reader to three
 * different places, and a widget that drew zeroes for all three would be lying in two of them.
 * A refusal says what the backend said, through `ipcError`.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type CollectionSummary,
  type DeckValue,
  type WishlistSummary,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore, type ViewId } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import {
  collectionTotalKey,
  deckListKey,
  deckValuesKey,
  wishlistTotalKey,
} from "../keys";
import { widgetSpan } from "../layout";
import type { WidgetProps } from "../widgetProps";
import { WidgetCard } from "../WidgetCard";
import { WIDGETS } from "../widgets";

// The four keys this widget reads through live in `../keys`, and **two of them are shared**:
// `collectionTotalKey` is also `CollectionValueWidget`'s and `wishlistTotalKey` is also
// `WishlistValueWidget`'s, so each pair is one fetch rather than two. They were spelled here as
// well until the keys moved, and a second spelling is one fetch only until somebody edits it —
// see that file's module doc, and `keys.test.tsx` for the assertion that keeps the pairs equal.

/**
 * Every deck's worth as one figure, and the copies no price was found for.
 *
 * **`DeckValue.value` is `number | null` and the two are not the same zero.** `null` is *the
 * marketplace priced nothing in this deck* — a pile of tokens, a deck of cards a bulk feed has
 * never listed — so it contributes nothing to the sum; `0` is a real answer and contributes it.
 * A sum that started at `0` would turn "we could not price a single card in any of your decks"
 * into `$0.00`, which is a number nobody quoted. So the total stays `null` until some deck
 * actually contributes, and `formatPrice` draws the em dash.
 *
 * `unpriced` is summed across every row regardless, because it is a count of copies rather than
 * a price: a deck whose value is `null` is exactly the deck with the most of them.
 *
 * Exported for its own test — the null rule is arithmetic, and arithmetic is worth asserting
 * without a render in the way.
 */
export function sumDeckValues(values: readonly DeckValue[]): {
  value: number | null;
  unpriced: number;
} {
  let value: number | null = null;
  let unpriced = 0;
  for (const row of values) {
    if (row.value !== null) value = (value ?? 0) + row.value;
    unpriced += row.unpriced;
  }
  return { value, unpriced };
}

/**
 * The card's heading, read off the same meta the Add widget menu draws its row from.
 *
 * Looked up rather than written out, so the words on the menu row and the words on the card it
 * adds cannot drift apart. The fallback is unreachable — `WIDGET_META` is a
 * `Record<WidgetKind, …>`, so `"summary"` is always there — and exists only because `find`
 * answers `T | undefined`.
 */
const HEADING = WIDGETS.find((meta) => meta.kind === "summary")?.label ?? "Summary";

/** One figure's worth of already-decided facts. Nothing here is computed during the draw. */
interface SummaryRow {
  /** Where the press goes. */
  view: ViewId;
  label: string;
  copies: number;
  /** The singular of what {@link copies} counts — `cards` for two of the three, `decks` for
   *  the middle one, which counts piles rather than cardboard. */
  noun: string;
  /** Already summed at the marketplace; `null` is an em dash. */
  value: number | null;
  /** Copies that value could not include, at that same marketplace. */
  unpriced: number;
}

export function SummaryWidget({
  widget,
  editing,
  onRemove,
  onSpan,
  dragHandleRef,
  onNudge,
}: WidgetProps): ReactElement {
  const { marketplace } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);

  const collection = useQuery({
    queryKey: collectionTotalKey(marketplace.id),
    // No filters at all, which is what makes this the *whole* collection: `folderId` absent and
    // `rootOnly` absent is every folder there is — `CollectionQuery.folderId` says so — and
    // `excludeLocked` keeps its `false` default, so a drawer the reader set aside is still
    // cardboard they own. `limit: 0` is the summary's own idiom for "count, do not list".
    queryFn: () => ipc.collectionSummary({ limit: 0, offset: 0, marketplace: marketplace.id }),
  });
  const decks = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const deckValues = useQuery({
    queryKey: deckValuesKey(marketplace.id),
    queryFn: () => ipc.deckValues(marketplace.id),
  });
  const wishlist = useQuery({
    queryKey: wishlistTotalKey(marketplace.id),
    queryFn: () => ipc.wishlistSummary(marketplace.id),
  });

  // The first refusal there is, whichever read produced it. One sentence rather than four,
  // because a reader whose database will not answer one of these is not helped by learning
  // which: the card has no figures either way, and the message the backend gave is the part
  // worth reading.
  const failure = collection.error ?? decks.error ?? deckValues.error ?? wishlist.error;

  return (
    <WidgetCard
      heading={HEADING}
      span={widgetSpan(widget)}
      editing={editing}
      onRemove={onRemove}
      onSpan={onSpan}
      dragHandleRef={dragHandleRef}
      onNudge={onNudge}
      // No `settings`: this widget has nothing to remember, and `WidgetCard` draws no control
      // at all for that rather than a greyed one.
    >
      {failure !== null ? (
        <p className="text-sm text-dim">Your totals could not be read. {ipcError(failure)}</p>
      ) : collection.data === undefined ||
        decks.data === undefined ||
        deckValues.data === undefined ||
        wishlist.data === undefined ? (
        <p className="text-sm text-dim">Adding up your collection, decks and wishlist…</p>
      ) : (
        <SummaryFigures
          rows={figures(collection.data, decks.data.length, deckValues.data, wishlist.data)}
          currency={marketplace.currency}
          asOf={pricesAsOf(marketplace)}
          onOpen={setActiveView}
        />
      )}
    </WidgetCard>
  );
}

/**
 * The three rows, built once from the four answers.
 *
 * A plain function rather than a `useMemo`: it is three object literals over numbers that are
 * already in hand, and the array is read by the render that made it.
 */
function figures(
  collection: CollectionSummary,
  deckCount: number,
  deckValues: readonly DeckValue[],
  wishlist: WishlistSummary,
): SummaryRow[] {
  const decks = sumDeckValues(deckValues);
  return [
    {
      view: "collection",
      label: "Collection",
      copies: collection.totalCards,
      noun: "card",
      value: collection.value,
      unpriced: collection.unpriced,
    },
    {
      // **Every deck, archived ones included**, which is what the gallery a press from here
      // opens also draws — archived last rather than absent. The count and the value are one
      // set of decks for that reason: a total over piles the count leaves out is a figure that
      // cannot be checked against anything on screen.
      view: "decks",
      label: "Decks",
      copies: deckCount,
      noun: "deck",
      value: decks.value,
      unpriced: decks.unpriced,
    },
    {
      // Copies rather than `wishes`: the other two figures count cardboard, and a row that
      // counted *things shopped for* beside two that count copies would be three numbers in two
      // units under one heading.
      view: "wishlist",
      label: "Wishlist",
      copies: wishlist.copies,
      noun: "card",
      value: wishlist.cost,
      unpriced: wishlist.unpriced,
    },
  ];
}

/**
 * The three figures, or the one sentence that stands in for them.
 *
 * The empty state is *all three* being empty. One empty list among three is not an empty
 * grimoire — a reader with a collection and no decks is owed the collection's figure and a
 * plain `0` beside it, which is a true statement about their decks rather than a gap.
 */
function SummaryFigures({
  rows,
  currency,
  asOf,
  onOpen,
}: {
  rows: readonly SummaryRow[];
  currency: Currency;
  asOf: string;
  onOpen: (view: ViewId) => void;
}): ReactElement {
  if (rows.every((row) => row.copies === 0)) {
    return (
      <p className="text-sm text-dim">
        Nothing to add up yet. Cards you collect, decks you build and cards you wish for are counted
        here.
      </p>
    );
  }
  // `flex-wrap` and a basis rather than three fixed columns: this widget's default span is the
  // whole row, and it is one press away from being a single column — so the three figures have
  // to fall onto two lines and then one without anything overflowing the card.
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((row) => (
        <SummaryFigure key={row.view} row={row} currency={currency} asOf={asOf} onOpen={onOpen} />
      ))}
    </div>
  );
}

function SummaryFigure({
  row,
  currency,
  asOf,
  onOpen,
}: {
  row: SummaryRow;
  currency: Currency;
  asOf: string;
  onOpen: (view: ViewId) => void;
}): ReactElement {
  const tip = useTooltip();
  const copies = `${count(row.copies)} ${row.copies === 1 ? row.noun : `${row.noun}s`}`;
  const price = formatPrice(row.value, currency);
  const note = row.unpriced > 0 ? `${count(row.unpriced)} unpriced` : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(row.view)}
      // **Written out rather than assembled from the visible text.** An accessible name computed
      // from a flex column is the text nodes run together with no separator — a label and a
      // count come out as one word — so the sentence is stated here, and it holds every figure
      // the eye reads in the order the eye reads them.
      aria-label={`${row.label}: ${copies}, ${price}${note ? `, ${note}` : ""}`}
      // Which marketplace's money this is and how old it is — the sentence this app puts on
      // every price that has no room to write it out.
      {...tip(asOf)}
      className={cn(
        "flex min-w-0 flex-1 basis-40 flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-left",
        "hover:border-border hover:bg-surface",
        PRESS,
        FOCUS,
      )}
    >
      <span className="text-xs text-dim">{row.label}</span>
      <span className="font-mono text-lg tabular-nums">
        {count(row.copies)}
        <span className="ml-1 text-xs text-dim">
          {row.copies === 1 ? row.noun : `${row.noun}s`}
        </span>
      </span>
      <span className="font-mono text-sm tabular-nums">
        {price}
        {note !== null && <span className="ml-2 text-xs text-dim">{note}</span>}
      </span>
    </button>
  );
}
