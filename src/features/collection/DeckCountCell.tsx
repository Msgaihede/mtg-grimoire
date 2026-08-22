import { useQuery } from "@tanstack/react-query";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { ipc, type CollectionRow } from "@/lib/ipc";

/**
 * How long a row's deck names stay fresh, in ms.
 *
 * A hover is a question about the page as it is on screen, and the page behind it is already
 * a snapshot of the same moment — so a second hover on the same row inside half a minute is
 * the same question and does not go back to SQLite. Any write that could change the answer
 * invalidates `["decks"]` and `["collection"]`, which takes this with it; the number is what
 * covers the gap between two hovers, not a substitute for that.
 */
export const ROW_DECKS_STALE_MS = 30_000;

/**
 * The panel's own contents: which decks hold this printing, and how many copies each.
 *
 * **A component rather than a string, and that is what makes the fetch lazy.** `useTooltip`'s
 * `content` is a `ReactNode` that `TooltipProvider` renders inside itself — under the app's
 * `QueryClientProvider`, deliberately — so the query below does not exist until a panel is
 * open, and it re-renders in place when the answer lands. There is no `onOpenChange` on this
 * API and none is needed: mounting *is* the open, and unmounting is the close.
 *
 * Lines rather than one joined sentence: a hover over a card in eleven decks is a list to scan,
 * and a wrapped run of `2 × Burn, 1 × Boros Aggro, …` is not one.
 */
function RowDecks({ row }: { row: CollectionRow }) {
  const decks = useQuery({
    // Under `["collection"]` so that every write in the app that already invalidates the
    // collection takes these with it — the copies these lines count are the copies the row
    // above them counts, and one going stale without the other is the tooltip contradicting
    // the number that opened it.
    queryKey: ["collection", "row-decks", row.cardId, row.finish, row.lang],
    // The row's own `finish` verbatim: it is the collection's spelling — `"nonfoil"`, never
    // the deck table's `NULL` — and `collection_row_decks` coalesces at its end. Reaching for
    // a translation here would be a second place for that mapping to live.
    queryFn: () => ipc.collectionRowDecks(row.cardId, row.finish, row.lang),
    staleTime: ROW_DECKS_STALE_MS,
  });

  if (decks.isPending) return <>Loading…</>;
  // Said rather than swallowed: the panel is already open and an empty one reads as a bug in
  // the hover. It is not an `alert` and takes no colour — nothing is broken about the row, and
  // the count beside it is still true.
  if (decks.isError) return <>Could not read which decks these are in.</>;
  // Only reachable if a deck lost the card between the page load and the hover, since a row
  // with no decks behind it is not in a derived collection at all.
  if (decks.data.length === 0) return <>No decks hold these copies any more.</>;

  return (
    <>
      {decks.data.map((deck) => (
        <div key={deck.deckId}>
          {deck.quantity} × {deck.deckName}
        </div>
      ))}
    </>
  );
}

/**
 * How many decks this row's copies are spread across, and — on hover — which.
 *
 * **Where the delete button was.** A derived row cannot be deleted: the copies are in the
 * decks, and the decks are where they are removed. So the Actions column would otherwise be
 * blank on every row, and "which decks is this card in?" is the one question a derived row
 * raises that nothing else on the page answers.
 *
 * **The names are fetched on hover, never with the page.** The count rides along in the same
 * aggregate the quantity is summed by and is free; the names are a query each, and a 100-row
 * page would carry several hundred deck names nobody looks at. {@link RowDecks} is where that
 * laziness actually lives.
 *
 * `describes: false`, so the panel wires no `aria-describedby`. Its text is asynchronous —
 * pointing a description at a panel that says "Loading…" at the moment it is read is worse
 * than pointing at nothing — and the count itself, which is the fact this cell is *for*, is
 * plain text in the accessibility tree either way.
 */
export function DeckCountCell({ row }: { row: CollectionRow }) {
  const tip = useTooltip();
  // `null`, not `0`: `deckCount` is `null` on a hand-kept row, where this cell is not drawn at
  // all, and a defensive `?? 0` here would be the one place in the file that pretended the two
  // were the same thing.
  const count = row.deckCount;
  if (count === null || count === 0) return null;

  return (
    <span
      {...tip(<RowDecks row={row} />, { describes: false })}
      // Dim and small, like the unit price under a value: it is a fact *about* the row rather
      // than one of its columns, and the Actions column is 2rem wide.
      className="whitespace-nowrap text-[0.7rem] text-dim"
    >
      {/* Singular matters — a reader with one deck should not be told "1 decks". */}
      {count === 1 ? "1 deck" : `${count} decks`}
    </span>
  );
}
