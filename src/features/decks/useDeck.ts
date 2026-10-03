/**
 * `useDeck` — the deck editor's one deck read and every write to what is in it, **kept in step
 * with the desktop's card modal.**
 *
 * The hook's body is `useDeckCore.ts` since 2026-10-03, store-free so the light app's phone face
 * can write through the same mutations; everything that file exports is re-exported here, so no
 * desktop caller changed an import. What is left in this file is what reaches the app store: the
 * three things a deck write does to the card modal's address for a deck row
 * ({@link STORE_ANCHOR}), and the printing swap's own entrance for that modal
 * ({@link useSwapFromPane}).
 */
import { useAppStore, type PaneDeckContext } from "@/lib/store";
// The other end of the walk — the modal's own answer to "where does a reader go when the card
// they are looking at stops existing", imported rather than respelled here. See `unanchorPane`.
import { departureFrom, type PaneDeparture } from "@/features/card/cardReturn";
import type { DeckVariant } from "@/lib/ipc";
import { sameDeckSlot } from "./deckWalk";
import {
  DEFAULT_VARIANT,
  useDeckCore,
  type DeckAnchor,
  type PaneMove,
  type WrittenRow,
} from "./useDeckCore";

export * from "./useDeckCore";

/**
 * The open card's deck context, if it is the row that was written — the guard every re-anchor
 * shares, and the reason it is a function of its own.
 *
 * **Only the row that was written**, hence the whole address is compared: a reader can have a card
 * open on one row and right-click another, and a card open from a different deck, a different pile
 * or the other variant must not be dragged along. Nothing to move is the common case — most of
 * these writes happen with no card open at all.
 *
 * It answers the context rather than a boolean because both callers need it: one spreads a patch
 * over it and the other reads its `cardId`.
 */
function anchoredOn(wrote: WrittenRow): PaneDeckContext | null {
  const pane = useAppStore.getState().paneDeckContext;
  if (
    pane === null ||
    pane.deckId !== wrote.deckId ||
    pane.variant !== wrote.variant ||
    pane.categoryId !== wrote.categoryId ||
    pane.cardId !== wrote.cardId ||
    pane.finish !== wrote.finish
  ) {
    return null;
  }
  return pane;
}

/**
 * Move the open card's deck context onto the row a write has just made.
 *
 * **A deck row is addressed by `(deck, category, card, variant, finish)`**, and every write below
 * that changes one of those five leaves a context naming a row that no longer exists. Three things
 * break at once when it does, and all three were reported as one on 2026-08-18, when the card was
 * still a docked pane and `set_card_finish` was the only write that had been fixed: the editor's
 * `selectedSlot` matches nothing, so the picked card is silently unpicked while the card surface
 * stays open; `deckControlFor` — the pane's, now `deckControl.ts`'s — finds no control to hand the
 * caret back to on close; and the card's own foil button sends `null → null` on its next press,
 * which the backend refuses as `SAME_FINISH` — a toggle that could be pressed once and never
 * pressed back. `openCardFromDeck` is the answer to all of it, because the store action is both
 * "which card is open" and "which row it came from" in one write.
 *
 * **It lives on the mutations rather than at their call sites, and since 2026-09-03 that is true of
 * every one of them.** It was `setCardFinish`'s alone, on the argument that two surfaces press that
 * write and a rule about what a write does to the address it wrote is not something two callers
 * should have to remember separately — while `swapPrinting`'s re-anchor was said to be at its call
 * site "because the pane is its only presser and it carries a `handover` only the pane can build".
 * **Both halves of that sentence expired with the pane.** The presser is `AllPrintingsDialog` now,
 * which is not the pane and is not the only surface that swaps — the card modal's own Printing
 * picker is the other — and the `handover` it builds is a **caret** note (`swapped.current`, for
 * `handBackToDeckCard`), not a context: that dialog never re-anchored `paneDeckContext` at all, so
 * a swap made from it left the modal underneath addressing the printing the deck had stopped
 * playing. The rule the finish arm was written under is the general one, so it is applied
 * generally, and `move` and `refile` — which change the *third* part and had the identical hole —
 * come in with it.
 *
 * The **fold** needs no arm of its own on either write that can cause one. Setting a row to a
 * finish the pile already holds, or swapping onto a printing it already holds, turns two rows into
 * one — and the surviving row is the one at the address being moved *to*. That is where the context
 * lands either way.
 */
function reanchorPane(wrote: WrittenRow, to: PaneMove): void {
  const pane = anchoredOn(wrote);
  if (pane === null) return;
  useAppStore.getState().openCardFromDeck({ ...pane, ...to });
}

/**
 * Plan the departure a removal is about to force on the open card — **and it has to be planned
 * rather than worked out afterwards, which is the one subtle thing here.**
 *
 * `setQuantity`'s `onMutate` takes the row out of the deck's cache at the moment of the press, so
 * by the time the round trip answers the editor has re-derived its groups, republished its walk,
 * and the stop this needs to find is gone — with it, any way of knowing which stops used to be
 * its neighbours. So this is called from `onMutate`, *before* the optimistic patch, and its
 * answer rides the mutation's context to `onSuccess`.
 *
 * `null` for every case that is not "a card is open on the row being removed and that row is on
 * the walk": no card open, a card open on a different row, or a row that is on no walk at all —
 * an orphan whose printing has left the corpus is not a stop, and neither is any row while the
 * editor is not the surface publishing.
 */
function plannedDeparture(wrote: WrittenRow): PaneDeparture | null {
  const pane = anchoredOn(wrote);
  if (pane === null) return null;
  const { stops } = useAppStore.getState().cardWalk;
  // The modal's own arithmetic, asked from the other side — a deck row is told from a plain stop
  // and from another row of the same printing by all five parts of the grain.
  const at = stops.findIndex((stop) => stop.deck !== null && sameDeckSlot(stop.deck, pane));
  return departureFrom(stops, at);
}

/**
 * Let the open card go, for the one write that leaves **no** address to re-anchor to.
 *
 * Stepping a deck row to zero *deletes* it (see {@link useDeck}'s `setQuantity`), so there is no
 * `to` — and the three answers were: leave the context, clear it, or close the modal.
 *
 * **Leaving it is the one that is not available**, because the controls it feeds stop being able to
 * do anything and say nothing about it. `deck_set_card_quantity` answers `card_gone` for a slot
 * with no row, so the modal's own stepper — the very control the reader has just pressed — becomes
 * a `+` that can only be refused, and the modal draws no error state for the deck's mutations, so
 * the refusal is *silent*. The category and label pickers address the same dead row.
 *
 * **Closing the modal is not it either.** This write reaches here from the modal's stepper and, in
 * principle, from every other removal in the editor (`DeckEditor`'s `setQuantityAt` is one path for
 * the tray, the menu row and the `Delete` key), and a surface that vanished under a reader who was
 * looking at a card would be answering a question they had not asked. They may well want to press
 * `Add to deck` and put it back.
 *
 * So the context is **cleared** and the card stays open, which is exactly the state
 * `setSelectedCardId` means everywhere else in this app — *opened from somewhere that is not a deck
 * row*. What that costs is stated rather than hidden: the deck stepper and the two deck pickers go
 * (the card is not in the deck any more, so none of them has anything to address) and
 * `setSelectedCardId` also clears `cardOverlay`, so a legality or oracle-text popup open over the
 * card shuts. Both are the honest reading of *this card is no longer one of the deck's rows*.
 *
 * **A fourth answer arrived with issue #474, and it is the one taken whenever it is available.**
 * The cost this comment used to list third — *the modal leaves a deck walk (a removed row is not a
 * stop on it)* — was not a cost the reader could live with: it took both step chevrons away and
 * killed the arrow keys, on the surface where a cut is most often one of a run of them. So where
 * {@link plannedDeparture} found the row on the walk, the modal **steps onto the next stop**
 * instead, and remembers the one it left so Ctrl+Z can put it back
 * (`AppState.leaveRemovedCard`). Clearing survives as the floor for the cases that plan
 * finds nothing for — an orphan, which is on no walk, and any removal made while the editor is
 * not the surface publishing one.
 *
 * **`clearCategory` and `clearDeck` delete rows too and are deliberately not wired to this**, which
 * is a reachability fact rather than an oversight: `paneDeckContext` lives exactly as long as the
 * card modal is open on a deck row (`setSelectedCardId(null)` clears it, and both of `Dialog`'s
 * doors go through it), and both clears are pressed from behind that modal's scrim — a heading's
 * right-click and Deck settings. There is no state in which one of them can orphan a live context.
 */
function unanchorPane(wrote: WrittenRow, departure: PaneDeparture | null): void {
  // Asked again rather than trusted from the plan: the plan was made at the press and this runs
  // at the answer. **What it fences is that the open card is still the row being removed** — not
  // that the plan and the open card are the same *event*, which nothing here could tell. It does
  // not have to: the two are the same row by this test, and `paneReturns`' clearing means a
  // reader who left the card and came back has spent the memory in between.
  const pane = anchoredOn(wrote);
  if (pane === null) return;
  if (departure !== null) {
    useAppStore.getState().leaveRemovedCard(departure.leaving, departure.to);
    return;
  }
  useAppStore.getState().setSelectedCardId(pane.cardId);
}

/**
 * The three moments a deck write reaches, answered against the app store — see
 * {@link DeckAnchor} for what each one is, and the three functions above for why each does what
 * it does.
 */
const STORE_ANCHOR: DeckAnchor = {
  moved: reanchorPane,
  planRemoval: plannedDeparture,
  removed: unanchorPane,
};

/**
 * One deck, everything in it, and every write that changes what is in it.
 *
 * **One query, not three.** The editor, the mana curve and the legality panel all read
 * `deck_get`, because they are asking the same question — *what is in this deck* — and a
 * screen that drew a curve from one query, a legality panel from another and an owned badge
 * from a third is a screen whose three answers can disagree.
 *
 * `id` is nullable because the gallery is the same view: Decks mounts this hook whether or
 * not a deck is open, and a query that fired anyway would ask the backend for deck `null`
 * on every gallery render.
 *
 * **Switching variant is a query-key change, not a refetch.** `["decks", "detail", id,
 * variant, marketplace]`, so Live and Theory are two cached answers rather than one that is
 * thrown away and re-read every time the reader flips the switch — flipping back is instant,
 * and each list keeps its own freshness. It also means the optimistic patch below is
 * addressing the right list by construction: the cache it writes into holds one variant's
 * cards and no other.
 *
 * **The marketplace is in the key for a different reason, and it is not free.** `deck_get`
 * prices every row and every category heading with it, so two marketplaces are two answers —
 * switching re-reads the deck. That is the trade the singular-price shape makes deliberately:
 * one number per row rather than one per marketplace per row. The read is local SQLite over a
 * deck-sized list, and flipping back finds the previous answer still cached.
 */
export function useDeck(id: number | null, variant: DeckVariant = DEFAULT_VARIANT) {
  return useDeckCore(id, variant, STORE_ANCHOR);
}

/** The whole of what the editor consumes, named so the view and the hook agree. */
export type Deck = ReturnType<typeof useDeck>;

/**
 * The printing swap, for the surface that presses it: the card pane's printings rows.
 *
 * The pane is not inside the editor — it is docked beside whatever view is up — so it cannot
 * be handed the editor's `Deck`. What it has instead is the store's {@link PaneDeckContext},
 * which names the deck row the open card came from, and this turns that into the one write it
 * offers. `null` — a card opened from anywhere but a deck row — mounts an idle mutation and a
 * query that asks for nothing, exactly as the gallery's `useDeck(null)` does.
 *
 * **The whole hook, deliberately, rather than a mutation defined here.** The query it brings
 * along is the same `["decks", "detail", id, variant]` the editor is already reading, and
 * TanStack shares a query's cache between observers — so with an editor open this costs no
 * `deck_get` at all (the app's `staleTime` is 30 s), and with the context set from a deck the
 * reader is looking at there is always an editor open. A second definition of the mutation
 * would cost more than the query does: the refusal rule that carries a pane-fired GONE back to
 * the editor lives on the definition, and two definitions are two places to keep it.
 *
 * **`variant` is a parameter with a `live` default, and the default is a known gap.**
 * {@link PaneDeckContext} does not carry a variant — it names a deck, a category and a
 * printing — so a pane opened from a **Theory** row and left to the default addresses the
 * `live` list. Two ways that goes wrong: the swap is refused, because
 * `(deck, card, category, variant)` matches no row; or, when the same printing sits in the
 * same category of *both* lists, it swaps the live row while the reader is looking at the
 * theory one. Closing it properly is a field on the store's context, which is the writer's to
 * add; until then the caller passes what the editor is showing, and this shares the editor's
 * cache only when the two agree.
 */
export function useSwapFromPane(
  context: PaneDeckContext | null,
  variant: DeckVariant = DEFAULT_VARIANT,
) {
  const deck = useDeck(context?.deckId ?? null, variant);
  return {
    swap: deck.swapPrinting,
    /**
     * The pane's foil button, for a card that **is** a row of the open deck.
     *
     * Handed over from the same hook mount as the swap rather than a second one, for the reason
     * that mount exists at all: `useDeck` is a live `deck_get`, and two of them would be two
     * reads of one deck. The pane presses this where it presses the swap — on the reader's own
     * copy — and where there is no deck row it draws a view toggle instead and presses nothing.
     */
    setCardFinish: deck.setCardFinish,
    /**
     * The read succeeded and answered nothing: another view has deleted this deck.
     *
     * `DeckEditor`'s `gone`, from the query the two of them share — which is the point of
     * mounting the whole hook. It lets the pane stop offering a write the deck can only refuse,
     * so the two surfaces agree *before* the press rather than after it. Loading is not gone.
     */
    deckGone:
      context !== null && !deck.query.isPending && !deck.query.isError && deck.query.data === null,
  };
}
