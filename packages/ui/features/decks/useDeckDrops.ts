import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { DeckFinish } from "@/lib/ipc";
import { batchWrite, handled, type Write } from "@/lib/writes";
import { AUTO_CATEGORY } from "./autoCategory";
import { focusDeckGroup } from "./cardControl";
import type { DeckWrite } from "./dnd";
import type { Deck } from "./useDeck";

/*
 * **Where a drag becomes a write** — every card write a drop can make, and the caret hand-off that
 * follows a card out of a pile, moved out of `DeckEditor.tsx` unchanged (issue #557).
 *
 * The seam is the one the editor's own comments already drew: `dnd.ts` decides what a drop
 * *means*, and this decides nothing at all — each callback is a write a control already makes,
 * addressed by the slot a drop carries. What the editor keeps is everything a drop cannot reach:
 * the menu's writes, which are addressed by a whole row, and the layers.
 *
 * **Every callback here is stable for as long as its inputs are**, and that is load-bearing rather
 * than tidy: they are what every pile's drop target is registered with and what the views' memoised
 * `actions` are built from, so a callback with a fresh identity per render would re-register a
 * dozen drop targets mid-drag and redraw every pile on the desk.
 */

/** What the drops need from the editor. */
export interface DeckDropsInput {
  deck: Deck;
  /** The rows on screen — `deck.cards`, the list a slot is looked up in. */
  cards: Deck["cards"];
  /** The landed mark's entry point — `DeckEditor`'s `markAdded`, which skips a token's `0`. */
  markAdded: (entryId: number) => void;
  /** The editor's root — the caret's floor when no pile can take it. */
  editorRef: RefObject<HTMLElement | null>;
  /** The batch record the banner reads — see `DeckEditor`'s `lastBatch`. */
  setLastBatch: (batch: Write) => void;
  /** The picked set's clear, for a drop that has just moved every member. */
  setCardSelection: (selection: null) => void;
}

export function useDeckDrops({
  deck,
  cards,
  markAdded,
  editorRef,
  setLastBatch,
  setCardSelection,
}: DeckDropsInput) {
  // The three category writes, each addressed by the slot rather than by a `DeckCard` — because
  // that is all a *drop* carries, and a drag and a control press must not be two ways of
  // writing the same thing. The card's stepper hands its own card to the first of the three;
  // the other two are a drop's alone now that the `Move…` select is gone, and the addressing is
  // still the drop's rather than the control's for the day one of them grows a control again.
  //
  // Each takes the mutation's `mutateAsync` rather than the mutation: TanStack hands back a
  // fresh result object on every render, so a callback that depended on the whole thing would
  // have a new identity every render — and these are what the drop targets are registered with,
  // so that would be every group unregistering and re-registering itself in the middle of a
  // drag. `mutateAsync` is stable for the life of the component, which makes the stability
  // `useCategoryDrop` asks for true rather than merely intended.
  //
  // **`mutateAsync` and not `mutate`, because a drop can carry several cards** (issue #553). A
  // `mutate` call's own callbacks belong to the *observer*, and the next call on the same one
  // replaces them — so a four-card drop ran the landed glow and the caret hand-off for the
  // fourth card only, and heard about the fourth card's refusal only. Each `mutateAsync` call
  // answers with a promise of its own, and a `.then` on it is that card's and nobody else's.
  // Every one is passed through {@link handled}, so a caller that ignores the answer — the
  // stepper, a menu row — leaves no unhandled rejection behind: the observer's state still
  // carries the refusal to the banner exactly as `mutate` did.
  const writeQuantity = deck.setQuantity.mutateAsync;
  const writeMove = deck.moveCard.mutateAsync;
  const writeAdd = deck.addCard.mutateAsync;

  /**
   * One copy into a category — the quick add's write, and a drop's.
   *
   * `categoryId` may be {@link AUTO_CATEGORY}, in which case the card's own type line goes
   * instead and `useDeck`'s `addCard` names the pile (`autoCategoryFor`). A drop always passes a
   * real id — pointing at a column is naming one — so the auto arm is the click path's alone,
   * and a caller with a real id may pass no type line at all.
   *
   * **The per-call `onSuccess` is where the landed mark comes from, and it has to be per call.**
   * The mutation's own `onSuccess` is `useDeck`'s invalidate and belongs to every surface that
   * borrows the hook — the sidebar's drop target adds to a deck with no editor on screen. What
   * is wanted here is the *row* the add answered with, which is the one thing only the caller
   * can do something with. TanStack runs both, the definition's first.
   */
  const addTo = useCallback(
    (
      cardId: string,
      categoryId: number,
      typeLine?: string | null,
      /*
       * **An `owned` argument stood here until 2026-08-25**, passed by the two callers the
       * own/need pair named — the quick-add field and the docked panel's Add button — and
       * absent at every drop, because a drag is a gesture about a card that is already
       * somewhere. With the pair deleted every add means the same thing, so there is nothing
       * left to say on the way past. See {@link DeckSearchPanelProps}.
       */
      // Which object goes in — the regular copy unless a docked-panel tile dragged under a
      // one-finish filter said otherwise (issue #933).
      finish: DeckFinish = null,
    ) =>
      handled(
        writeAdd(
          categoryId === AUTO_CATEGORY
            ? { cardId, typeLine: typeLine ?? null, finish, quantity: 1 }
            : { cardId, categoryId, finish, quantity: 1 },
        ).then(
          // **`change.id` is the `deck_cards` row this write landed in**, which the editor marks
          // for five seconds so the reader can find it in a deck they are not looking at. It was
          // tested against a `NO_DECK_ROW` floor until 2026-08-25: the `own` add went through
          // `collection_to_deck`, whose `deckCardId` is nullable on the wire, and a `null` arrived
          // here as `0` — a row id no card has, armed against a timer. Every add is `deck_add_card`
          // now, and **the floor is back for a second reason** (token stacks, spec §4.6): a token
          // printing is filed as a token entry and answers `id: 0`, {@link NO_DECK_CARD}, which
          // `markAdded` skips.
          (change) => markAdded(change.id),
        ),
      ),
    [writeAdd, markAdded],
  );

  /**
   * Give the caret to a pile, now **and once more after the deck redraws.**
   *
   * The second half is not belt and braces, it is the whole thing working. A card leaving a
   * pile takes the control the caret was on with it, so the caret has to go somewhere — and the
   * somewhere is the pile that changed, which announces its own name. Focusing it at the moment
   * of the write is right and is not enough: the stack and the text view **pack groups into
   * columns**, and a pile that changes size can push the pile after it into a different column.
   * A group that changes column changes parent, so React unmounts its section and mounts a new
   * one — taking the caret to `<body>` a beat after it was carefully placed there.
   *
   * So the target is remembered and re-focused on the next render that carries new cards.
   * `focusDeckGroup` looks the pile up by attribute rather than by ref for exactly this reason:
   * the element it finds the second time is a different element with the same identity.
   *
   * Measured, not guessed: it was `DeckEditor.stories.tsx`'s `MoveBetweenPiles` that failed
   * without the second pass and passed with it. **That story went with the `Move…` select on
   * 2026-08-14 and nothing replaced it**, because the only remaining route into this that
   * changes a pile's *size* is a drop, and Storybook cannot drive a drag (the page's own note
   * says why). What is still driven is the stepper's zero — `ZeroRemovesTheCard` asserts the
   * caret lands on the pile — which exercises the same two passes on the pile a card *left*.
   */
  /*
   * **`panelAdd` stood here from 2026-08-23 to 2026-08-25 and is gone with the own/need pair.**
   *
   * It was `deck.addCard` with `owned: addMode === "own"` folded into every `mutate` on the way
   * past — a wrapper rather than a prop, because the docked panel presses the mutation itself and
   * this component could not reach into that call. With no control over the mode there is nothing
   * to fold: every add from that panel writes a `deck_cards` row and claims nothing about the
   * reader's cardboard, which is what `DEFAULT_ADD_MODE` already meant. The panel takes
   * `deck.addCard` unwrapped, and moving a copy the reader owns into the deck is the Collection
   * tab's `collection_to_deck` — a different command, with a confirmation that names the deck a
   * spoken-for copy would come out of.
   */

  const owedFocus = useRef<number | null>(null);
  const handOffTo = useCallback(
    (categoryId: number) => {
      owedFocus.current = categoryId;
      if (!focusDeckGroup(categoryId)) editorRef.current?.focus();
    },
    // The editor's own ref, handed in — stable for the editor's life, and named here only because
    // it now arrives as an argument rather than being declared beside this callback.
    [editorRef],
  );
  useEffect(() => {
    const owed = owedFocus.current;
    if (owed === null) return;
    owedFocus.current = null;
    focusDeckGroup(owed);
  }, [cards]);

  /**
   * **The app's one removal path**, and since schema v25 that is a statement about the reader's
   * *cards* rather than about a list. The stepper stepped to zero, the card menu's `Remove card`
   * and the remove tray under the deck all arrive here, and on the **Live** list a decrease is
   * the write that files the copies the deck's group was holding into `Recently removed`
   * ({@link CUT_CARDS_NOTE}, the standing sentence on the price line).
   *
   * The row is looked up here rather than in the hook, and the reason is the ordering: TanStack
   * runs `onMutate` before the write, `onMutate` takes the row out of the cache optimistically,
   * and `deck_to_collection` addresses `deck_cards.id` and takes a *delta* — so the id and the
   * copies it currently holds have to travel with the press. See {@link CutFrom}.
   *
   * The finish is part of the `find` for the reason it is part of the write: a pile can hold this
   * printing twice, and stepping the foil row must not read the regular one's number. A row that
   * is not there is not an error — a drag can outlive the list it started in — and it falls back
   * to the absolute write, which is what every list did before the group existed.
   */
  const setQuantityAt = useCallback(
    (cardId: string, categoryId: number, finish: DeckFinish, quantity: number) => {
      // Zero takes the card out from under the caret — optimistically, so it happens on the
      // press — and the control the caret was on goes with it. Before the write, because the
      // card is gone by the time an answer arrives.
      if (quantity === 0) handOffTo(categoryId);
      const row = cards.find(
        (c) => c.cardId === cardId && c.categoryId === categoryId && c.finish === finish,
      );
      return handled(
        writeQuantity({
          cardId,
          categoryId,
          finish,
          quantity,
          held: row ? { deckCardId: row.id, quantity: row.quantity } : undefined,
        }),
      );
    },
    [cards, writeQuantity, handOffTo],
  );

  const moveTo = useCallback(
    (cardId: string, from: number, to: number, finish: DeckFinish) =>
      handled(
        // The dropped card has left the pile it was in, so the caret goes to where it landed
        // — which announces the category it is now in. The same hand-off the stepper's zero
        // makes: it is the card that unmounts either way, and focus follows it.
        writeMove({ cardId, from, to, finish }).then(() => handOffTo(to)),
      ),
    [writeMove, handOffTo],
  );

  /**
   * The quick zones' `Auto`, for a card the deck already holds: file it again by what it *does*.
   *
   * **The row is looked up here rather than carried in the drag**, which is `dnd.ts`'s decision
   * and is written out there: a `deck-card` payload is an address into a list this component is
   * already drawing, so the type line and the pile's name are one `find` away and a copy in the
   * payload would be the thing that goes stale. Addressed by the slot — `cardId` and the category
   * it is in — like every other write in this feature.
   *
   * A row that is not there is not an error and not a write: a drag can outlive the list it
   * started in (a filter, a refetch, another surface's delete), and nothing about failing to
   * re-file a card that is gone is worth a sentence.
   */
  const refileWrite = deck.refileCard.mutateAsync;
  const refile = useCallback(
    (cardId: string, from: number, finish: DeckFinish) => {
      // The finish is part of the `find` for the reason it is part of the write: a pile can
      // hold this printing twice, and the two rows share a type line but not a slot.
      const card = cards.find(
        (c) => c.cardId === cardId && c.categoryId === from && c.finish === finish,
      );
      if (!card) return Promise.resolve();
      return handled(
        refileWrite({
          cardId,
          from,
          finish,
          typeLine: card.typeLine,
          categoryName: card.categoryName,
        }).then(
          // The caret follows the card to the pile that now has it, which announces that pile's
          // name — the same hand-off a drag onto a heading makes, and the only feedback a move
          // needs. When nothing moved there is nowhere to send it, and the sentence below is
          // what says so instead.
          ({ moved, categoryId }) => {
            if (moved && categoryId !== null) handOffTo(categoryId);
          },
        ),
      );
    },
    [cards, refileWrite, handOffTo],
  );

  /**
   * What a drop writes — the one place a drag becomes a command.
   *
   * `dnd.ts` decided *what* the drop means and refused the ones that mean nothing; this decides
   * nothing at all, which is why the rule can be tested without a browser and this can be read
   * in one breath. Every branch is a write a control already makes: a drag adds nothing to what
   * a reader can do, only to how fast they can do it.
   */
  const applyDrop = useCallback(
    (write: DeckWrite): Promise<unknown> => {
      if (write.write === "add")
        return addTo(write.cardId, write.categoryId, undefined, write.finish);
      // The quick zones' `Auto`, and the same call the toolbar's `Add to → Auto (by what it
      // does)` makes: the type line goes and the pile does not, because `useDeck.addCard` names
      // it. The one drop in this editor that points at no column — see {@link QuickZones}.
      if (write.write === "auto-add")
        return addTo(write.cardId, AUTO_CATEGORY, write.typeLine, write.finish);
      // The same zone for a card the deck already holds, and the same rule — see {@link refile}.
      if (write.write === "auto-refile") return refile(write.cardId, write.from, write.finish);
      if (write.write === "move") return moveTo(write.cardId, write.from, write.to, write.finish);
      return setQuantityAt(write.cardId, write.categoryId, write.finish, 0);
    },
    [addTo, moveTo, refile, setQuantityAt],
  );

  /**
   * Wait out a batch of card writes and file **every** outcome as one {@link lastBatch}
   * (issue #553) — the multi-card drop's and Delete's.
   *
   * A batch of one is not a batch: its only call is also its observer's newest, so the observer
   * already tells the banner everything and a second record would be the same sentence twice.
   *
   * Two stamps, the moment it was fired and the moment it settled — `batchWrite` says which one
   * it keeps, and why a refusal cannot keep the first.
   */
  const reportBatch = useCallback(
    (presses: readonly Promise<unknown>[]) => {
      if (presses.length < 2) return;
      const firedAt = Date.now();
      void Promise.allSettled(presses).then((results) =>
        setLastBatch(batchWrite(results, firedAt, Date.now())),
      );
    },
    [setLastBatch],
  );

  /**
   * A whole drop — **every card it was carrying** (issue #214), and the picked set stood down
   * afterwards.
   *
   * One write per card rather than a batched command, and that is a cost this feature accepts
   * rather than hides. Each call is its own `deck_audit` row, so a four-card move is four
   * entries and four presses of Ctrl+Z to reverse. Batching would be a Rust change to `deck_undo`
   * — a grain the audit log does not have — and it is worth having the gesture before the tidier
   * undo rather than neither.
   *
   * **The set is cleared once the drop is applied.** The cards have moved, so a set still
   * pointing at where they *were* is a set whose next drag carries slots that no longer exist —
   * `pruneSelection` would empty it on the next render anyway, and clearing here is what stops
   * the ring standing on a pile the cards have left for the frame in between.
   */
  const applyDrops = useCallback(
    (writes: DeckWrite[]) => {
      reportBatch(writes.map(applyDrop));
      if (writes.length > 1) setCardSelection(null);
    },
    [applyDrop, reportBatch, setCardSelection],
  );

  return {
    addTo,
    handOffTo,
    setQuantityAt,
    moveTo,
    refile,
    applyDrop,
    reportBatch,
    applyDrops,
  };
}
