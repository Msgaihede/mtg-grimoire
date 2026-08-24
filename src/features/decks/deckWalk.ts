/**
 * The deck as a **walk** — one stop per drawn row, in the order the desk draws them — so that
 * a surface which is not inside the editor can step from one card to the next.
 *
 * It exists because of where the printings modal is mounted. `AllPrintingsDialog` is drawn at
 * `App` level, a sibling of `AppShell` and therefore **outside** `DeckEditor`, so no React
 * context reaches it; and the order cannot be recomputed on its side either, because the three
 * things that decide it are all the editor's own. `groupBy` and `sortBy` are `useState` in that
 * component, and the rows are `shown` — the deck narrowed by a live text box and a set of tag
 * chips. Only the editor knows the order the reader is actually looking at. So the editor
 * publishes this and the modal reads it, through `useAppStore.cardWalk`, exactly as
 * `paneDeckContext` already carries the one row a card was opened from.
 *
 * **The order is `splitRail`'s and is derived nowhere else here.** That is the same function
 * `StackView` and `TextView` lay their piles out with, so the walk agrees with the desk by
 * construction rather than by two copies of one rule happening to agree today — which matters
 * because that rule has moved three times in a month (the Maybeboard joining the rail, then every
 * switched-off pile joining it, then the command zones leaving the flow for a pinned run of their
 * own) and each move would otherwise have had to be made here as well. The third is the one that
 * would have been missed: the first two moved a pile between two runs this file already
 * concatenated, and that one added a run.
 *
 * **It is the two column views' order specifically**, and that is the honest claim rather than
 * "the drawn order" flat: `GridView` and `TableView` map `groups` straight through and never
 * split a rail, so a deck whose Sideboard is not already last in `sortOrder` reads in a slightly
 * different order in those two. The reader asked for "all cards from stack 1, then all cards
 * from stack 2", which is the stacks' order, and the stacks are what `splitRail` answers for.
 */
import type { CardWalkStop, PaneDeckContext } from "@/lib/store";
import { deckCardSlot } from "./dnd";
import type { CardGroup } from "./grouping";
import { splitRail } from "./views/columns";

/**
 * One stop on the walk — re-exported here because this is where a **deck's** stops are made, and
 * every caller but the store reaches for the type beside {@link deckWalkStops}. The three card
 * lists build theirs in `features/card/cardWalk.ts`, out of rows that are not deck rows.
 *
 * **Defined in `src/lib/store.ts`**, next to {@link PaneDeckContext}, which is the same shape of
 * fact: an address the store carries between two surfaces that cannot see each other. Putting it
 * there rather than here is what keeps the dependency one-way — `lib` is underneath `features`,
 * and a `lib` module importing a type out of a feature is an edge nothing else in this app has.
 */
export type { CardWalkStop };


/**
 * The deck's rows in the order the desk draws them.
 *
 * Three facts do all the work and none of them is decided here. `splitRail` says which piles are
 * the command zone, which flow and which are pinned to the right, in the reader's own `sortOrder`
 * inside each run; the desk draws `command`, then `flow`, then `rail`, so that is the order the
 * three are concatenated in — the same order `StackView`'s own arrow keys walk; and each group's
 * `cards` is already in the order `sortBy` asked for, because `buildGroups` sorted it. So the
 * whole derivation is a concatenation and a `flatMap`, and every question about *why* a card is
 * where it is has an answer in one of those two files instead of a second answer in this one.
 *
 * **`variant` and the category are read off the card rather than passed in.** `DeckCard` carries
 * both — `variant` on every row of a read (each read is one list, and the field is there so a
 * caller holding a row can write it back) and `categoryId`/`categoryName` denormalized onto the
 * row — so the only thing a caller has to supply is `deckId`, which no `DeckCard` carries. That
 * also keeps this agreeing with `DeckEditor`'s `deckSlotOf`, which builds the same address from
 * the same fields: two hand-written copies of a five-part address is how one of them comes to
 * name four parts, and `PaneDeckContext`'s own doc records that happening twice — once over
 * `variant`, once over `finish` — each time rewriting a deck row the reader was not looking at.
 * Reading the category off the **card** rather than off the group is deliberate for one more
 * reason: under a derived grouping (`manaValue`, `type`) a group's `categoryId` is `null`, while
 * the card's is always the pile it is really filed in.
 *
 * **A row whose `oracleId` is `null` is skipped.** That field is nullable because the read is a
 * LEFT JOIN: the row is an orphan whose printing has left the corpus. There are no printings to
 * show for one, so it is not a stop on a walk *through printings* — stepping onto it would open
 * a modal with nothing in it and no way to say why. It stays in the deck and stays drawn; it is
 * only this walk it is not on.
 *
 * One card filed in two piles is **two** stops, and that is right rather than a duplicate: they
 * are two `deck_cards` rows with two addresses, and a press inside the modal writes to one of
 * them.
 */
export function deckWalkStops(groups: readonly CardGroup[], deckId: number): CardWalkStop[] {
  const { command, flow, rail } = splitRail(groups);
  const stops: CardWalkStop[] = [];

  // A plain loop rather than a `filter` and a `map`, for `splitRail`'s own reason one file over:
  // two passes are two places for the rule about which rows survive to be stated, and the second
  // one is the one that gets edited without the first.
  for (const group of [...command, ...flow, ...rail]) {
    for (const card of group.cards) {
      // The orphan. `oracleId` is the field, and narrowing it here is also what makes the stop's
      // own `oracleId` a `string` with no assertion.
      if (card.oracleId === null) continue;
      stops.push({
        // The same id as `deck.cardId` below and written from the same field, which is what
        // `CardWalkStop.cardId`'s own doc asks for: one of the two has to be the definition, and
        // this reads it off the row rather than off the address built beside it.
        cardId: card.cardId,
        oracleId: card.oracleId,
        name: card.name,
        deck: {
          deckId,
          categoryId: card.categoryId,
          categoryName: card.categoryName,
          cardId: card.cardId,
          variant: card.variant,
          finish: card.finish,
        },
      });
    }
  }

  return stops;
}

/**
 * The same drawn order as {@link deckWalkStops}, as **slots** — what a Shift-click measures a
 * range along (issue #214).
 *
 * ## Two differences from the walk, and both are deliberate
 *
 * **An orphan is on this list.** A row whose printing has left the corpus is skipped by the walk
 * because that walk steps *through printings* and an orphan has none — but it is a card the
 * reader can see, click and drag, so it is a card a range must be able to run over. Leaving it
 * out would make a Shift-click silently skip a row on screen, which is the one failure a range
 * cannot have.
 *
 * **It is slots rather than stops**, which is the key space `lib/multiSelect` is handed here and
 * the same string `cardControl`'s `deckCardProps` stamps on every drawn card. One spelling on
 * both sides of the lookup is `deckCardSlot`'s own rule.
 *
 * ## What order this actually is
 *
 * `splitRail`'s — command, then flow, then rail — which is what `StackView` and `TextView` draw.
 * `GridView` and `TableView` map `groups` straight through and never split a rail, so in those
 * two a range that *crosses* the rail boundary follows the stacks' order rather than the order of
 * the tiles under the pointer. That is the same honest caveat {@link deckWalkStops} carries, and
 * it is bounded the same way: inside a pile, and between piles that are all in the flow, the two
 * orders are identical, which is every range a reader is likely to draw.
 */
export function deckSlotOrder(groups: readonly CardGroup[]): string[] {
  const { command, flow, rail } = splitRail(groups);
  const slots: string[] = [];
  for (const group of [...command, ...flow, ...rail]) {
    for (const card of group.cards) {
      slots.push(deckCardSlot(card.categoryId, card.cardId, card.finish));
    }
  }
  return slots;
}

/**
 * Whether two slots are the same deck row — **the five parts of `DECK_CARD_GRAIN`**, which is
 * what the unique index is on and therefore what "the same row" means.
 *
 * It is here rather than written out at the one call site because the failure it prevents is a
 * comparison that names four parts. That is not hypothetical: `PaneDeckContext`'s doc records a
 * four-part *address* twice, over `variant` and then over `finish`, and each time the wrong deck
 * row was rewritten while the reader was shown the right-looking answer. A four-part comparison
 * fails the same way one step earlier — it finds the reader's place in the walk on the plain
 * copy of a card when they opened the foil one, and every step from there is off by a row.
 *
 * **`categoryName` is deliberately not compared.** It is not part of the grain: it is
 * `categoryId` spelled out for a sibling surface that has no category list to translate an id
 * with (see {@link PaneDeckContext}), so it is derived from a field this already tests. Comparing
 * it would make a pile renamed mid-walk read as a different row — the reader would lose their
 * place for a change to a heading.
 */
export function sameDeckSlot(a: PaneDeckContext, b: PaneDeckContext): boolean {
  return (
    a.deckId === b.deckId &&
    a.categoryId === b.categoryId &&
    a.cardId === b.cardId &&
    a.variant === b.variant &&
    a.finish === b.finish
  );
}
