import { useMemo, useState } from "react";
import { Dialog } from "@/components/Dialog";
import type { DeckCore } from "@/features/decks/useDeckCore";
import { useCardSearch, type FormatFilterOption } from "@/features/search/useCardSearch";
import { count } from "@/lib/counts";
import type { DeckCard } from "@/lib/ipc";
import { searchItem } from "../items";
import type { WallItem } from "../CardWall";
import { SearchLine, SearchResults } from "../pages/SearchPage";
import { useMore } from "../pages/parts";
import { ReceiptBar, type Receipt } from "./receipt";

/**
 * **Add cards** — the card database, searched from a deck, where a press on a tile puts one copy
 * of that printing into the list on screen.
 *
 * **The desktop's docked search panel, as a sheet**: the same `useCardSearch`, opened on the deck's
 * own format where the database can answer it (`defaultFormat`, a seed the reader can move — the
 * editor's `searchFormatDefault` rule) and counting owned copies as *copies this deck can use*
 * (`availableForDeck`). The line and the wall are the Search page's own, so the box, the filters
 * sheet and the count read here exactly as they do there.
 *
 * **One copy per press**, the app's rule for every Add: a playset is four presses. It is
 * `useDeck`'s `addCard` with `deckDefault`, so the card lands in the pile Deck settings names for
 * new cards — and, where that is Auto, in the pile the card's Oracle tags file it under, the
 * editor's own rule, resolved in the mutation rather than here. A token is filed as one of the
 * deck's token entries by Rust, as everywhere.
 *
 * **A sheet over the page, not a place**: page state, as the filters sheet is. Its foot is the
 * write's receipt — what the deck's history filed, how many of that card the list now holds, and
 * `Undo`.
 *
 * The body is mounted only while the sheet is open (`Dialog` mounts children only then), so the
 * search asks nothing until a reader presses `Add cards`.
 */
export function AddCards({
  open,
  deck,
  cards,
  listWord,
  defaultFormat,
  receipt,
  onClose,
}: {
  open: boolean;
  deck: DeckCore;
  cards: readonly DeckCard[];
  /** `Theory` / `Actual` on a deck that keeps a plan, `null` on one that does not. */
  listWord: string | null;
  defaultFormat: FormatFilterOption | null;
  receipt: Receipt;
  onClose: () => void;
}) {
  const name = deck.deck?.name ?? "this deck";
  return (
    <Dialog
      open={open}
      title="Add cards"
      subtitle={listWord === null ? `To ${name}` : `To ${name} · ${listWord}`}
      closeLabel="Close add cards"
      // The filters sheet's own shape: the whole window below 640px, with the top inset taken
      // because the shell's header is underneath; a tall centred panel above it. A height, not
      // content, because the wall is a virtualised scroller and has none of its own.
      size="h-full w-[40rem] pt-[env(safe-area-inset-top)] sm:pt-0"
      onDismiss={onClose}
      onClose={onClose}
    >
      <Body deck={deck} cards={cards} defaultFormat={defaultFormat} receipt={receipt} />
    </Dialog>
  );
}

function Body({
  deck,
  cards,
  defaultFormat,
  receipt,
}: {
  deck: DeckCore;
  cards: readonly DeckCard[];
  defaultFormat: FormatFilterOption | null;
  receipt: Receipt;
}) {
  const search = useCardSearch({ defaultFormat, availableForDeck: deck.deck?.id ?? null });
  const { query, marketplace } = search;
  const more = useMore(query, query.hasNextPage);
  const [added, setAdded] = useState<string | null>(null);

  // The tile's name says what its press does: this wall adds, where the Search page's opens.
  const items = useMemo(
    () =>
      search.rows.map((row) => {
        const item = searchItem(row, marketplace.currency);
        return { ...item, pressLabel: `Add ${item.pressLabel}` };
      }),
    [search.rows, marketplace.currency],
  );

  const add = (item: WallItem) => {
    const row = search.rows.find((r) => r.id === item.key);
    if (row === undefined) return;
    setAdded(row.id);
    receipt.track(
      deck.addCard.mutateAsync({
        cardId: row.id,
        deckDefault: true,
        typeLine: row.typeLine,
        quantity: 1,
      }),
      () => `Added 1 \u00d7 ${row.name}.`,
    );
  };

  // How many of that printing the list holds now, across its piles — read off the deck the page is
  // drawing, so it is the number the page will show when the sheet closes. A token is filed as a
  // token entry and holds no deck row, so it says nothing rather than `0`.
  const held =
    added === null
      ? 0
      : cards.reduce((sum, card) => (card.cardId === added ? sum + card.quantity : sum), 0);

  return (
    <>
      <SearchLine search={search} label="Search cards to add" />
      <SearchResults search={search} label="Cards to add" items={items} onOpen={add} more={more} />
      <ReceiptBar
        receipt={receipt}
        className="shrink-0 pb-[env(safe-area-inset-bottom)]"
        extra={held > 0 ? `${count(held)} in this list` : undefined}
      />
    </>
  );
}
