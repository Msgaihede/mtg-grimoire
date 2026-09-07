import { isFinish, type Finish } from "@/lib/finish";

/**
 * The gesture that files a card the reader does **not** own yet into one of the collection's or
 * the wishlist's own folders — the payload a search tile carries, and the reader every folder
 * target asks about it. Design spec §8.1.
 *
 * **A port of `collectionDrag.ts`, which is itself a port of `wishDrag.ts`, and it is a port
 * because the decision those files exist for is the same decision here.** `deckDrag.ts` puts a
 * *different mark* under `dnd.ts`'s **own key** (`dragSource`), so a deck and a card refuse each
 * other's payload outright — right for a deck, because a deck is never a card. A search tile is
 * not like a deck: it genuinely is both a **card** (something a deck category, a quick zone or the
 * sidebar's Decks entry can take — that drag has been on the table since the docked panel existed)
 * and a **printing a folder can file**, and both readers have to say yes to the *same tile's*
 * record at once. Sharing `dragSource` the way `deckDrag.ts` shares it would force this module's
 * mark onto that one key, so `dnd.ts`'s reader would see only whichever mark won and the other
 * would be lied to. So this module answers under its **own key**, `searchCardSource`, spelled once
 * as {@link SEARCH_CARD_MARK}.
 *
 * A tile's record is therefore the union of what `dnd.ts`'s `dragData` wrote and what
 * {@link searchCardDragData} writes — two keys in one flat object, each reader answering only its
 * own and staying blind to the other's. `CardGrid`'s `dragRecord` seam is what carries it, exactly
 * as the collection wall's tile already composes its two.
 *
 * **Deliberately not a fourth arm on `dnd.ts`'s `DragPayload`.** That is the change that looks
 * smaller and is not: an arm there is read by `readCards`, so a card nobody owns would become
 * droppable on every deck category, every quick zone and the sidebar's Decks entry at once — a lot
 * of new behaviour bought by accident, and none of it asked for. A key of its own means a reader
 * that has never heard of this drag goes on answering `null` for one rather than reading half of
 * it, which is the same property that lets `dnd.ts` stay blind to the collection's and the
 * wishlist's marks.
 *
 * Every field is read one at a time rather than cast, `dnd.ts`'s boundary rule and its reason:
 * this is the app's edge with the drag library's own store, which every draggable in the window
 * writes into untyped, and "it type-checked" means nothing at that edge.
 */

/**
 * The mark that says a record carries a card off a search wall, and its key.
 *
 * **Deliberately not `dnd.ts`'s `dragSource`** — see the module comment above for why sharing it
 * would be wrong here where it is exactly right for `deckDrag.ts`'s `DECK_MARK`. The key is none
 * of the five already in the window (`dragSource`, `collectionSource`, `collectionTileSource`,
 * `wishSource`, `folderSource`), because a record is flat and two marks under one name is one of
 * them silently winning.
 */
const SEARCH_CARD_MARK = "mtg-grimoire/search-card-drag";
const MARK_KEY = "searchCardSource";

/** What a search-wall drag carries: the printing, and the two facts a drop has to write with it. */
export interface SearchCardDrag {
  cardId: string;
  /** For whatever says what was filed. Allowed to be empty, `dnd.ts`'s rule: a name denormalises
   *  whatever `cards` had, where an id addresses a row. */
  name: string;
  /** The finish a drop writes. The printing's first available finish, never a guess. A copy is
   *  stored per finish on both lists — `collection_entries.finish` is part of the grain and a
   *  wish for the foil is a different wish — so this is part of the **address** rather than extra
   *  information, and there is nothing for a drop to look it up *by* without it. */
  finish: Finish;
  /** For a wish for "any printing". `null` mirrors the column's nullability: `CardSummary.oracleId`
   *  is nullable, an orphaned printing has no oracle row, and "the app does not know" is a real
   *  answer rather than a malformed one. */
  oracleId: string | null;
}

/** What a search tile hands the adapter under its own key. Flat, and meant to be merged with
 *  whatever `dnd.ts`'s `dragData` writes for the same tile, so `canDrop` on either side reads its
 *  own key without unwrapping anything. */
export function searchCardDragData(drag: SearchCardDrag): Record<string, unknown> {
  return { [MARK_KEY]: SEARCH_CARD_MARK, ...drag };
}

/**
 * The record a folder card or a breadcrumb segment may act on, or `null` for everything else —
 * including a well-formed card payload that carries no search mark at all, and a collection
 * entry, which is a different drag under a different key.
 *
 * Field by field rather than a cast — `dnd.ts`'s rule, for its reason: this is the app's boundary
 * with an untyped store every draggable in the window writes into.
 *
 * **An unreadable field is `null` for the whole record, never a partial one.** Each of the three
 * checked fields is part of what the drop *writes* — the row it addresses, the finish it is filed
 * under, the oracle id a wish for any printing needs — so a record read half-way would file a card
 * under facts nobody stated, which is precisely the objection `useSidebarDrops.ts` raises against
 * a drop that invents a grade. A refused drop is a failure the reader can see.
 */
export function readSearchCardDrag(data: Record<string, unknown>): SearchCardDrag | null {
  if (data[MARK_KEY] !== SEARCH_CARD_MARK) return null;
  const { cardId, name, finish, oracleId } = data;
  // Empty is refused for `dnd.ts`'s `isId` reason, stated there: an empty `card_id` addresses
  // every row and no row. A search tile is a printing by construction, so there is no honest
  // caller this costs.
  if (typeof cardId !== "string" || cardId.length === 0) return null;
  if (typeof name !== "string") return null;
  // **Refused rather than normalised, which puts this on the opposite side of `dnd.ts`'s split.**
  // That module reads a bad `finish` as the regular copy, because there the wrong value can only
  // ever be "not one of the two premium words" and the row that is neither is the regular one.
  // Here the word is not a narrowing of a row that already exists — it is what a *new* row will be
  // filed under, on both lists, and `nonfoil` is one of the three rather than the absence of the
  // other two. Guessing it would write a fact the reader never said.
  if (typeof finish !== "string" || !isFinish(finish)) return null;
  if (oracleId !== null && typeof oracleId !== "string") return null;
  return { cardId, name, finish, oracleId };
}
