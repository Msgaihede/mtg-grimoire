import { useEffect, type RefObject } from "react";
import { isTextField } from "@/components/menu/useContextMenu";
import type { DeckCard, DeckFinish } from "@/lib/ipc";
import { matchesShortcut, shortcut } from "@/lib/shortcuts";

/*
 * The deck editor's two bindings on `window` — undo/redo, and the picked set's Delete — moved out
 * of `DeckEditor.tsx` unchanged (issue #557). They are one hook because they are one kind of thing:
 * a key the editor answers for its own scope, registered for the editor's whole life, yielding to a
 * text field — and because a reader looking for "what does a key do in the deck builder" should find
 * every such key in one file rather than four thousand lines apart.
 *
 * Every argument is something the editor already holds still: the undo hook's two runners, the
 * write a removal goes through (`useDeckDrops`' `setQuantityAt`), the batch record, and the picked
 * set **as a ref** — the Delete handler's own doc below says why a set in a dependency list would
 * tear the listener down on every Ctrl-click.
 */

/**
 * The three chords this editor binds, looked up **once at module scope** — `AppShell`'s
 * arrangement for the two it binds, and it is the right one here for the same reason.
 *
 * `shortcut()` throws on an id the catalogue does not carry, which is the whole reason it is a
 * function rather than an index; resolving at import makes that throw arrive before a render and
 * before a press. Resolved inside a `keydown` handler instead, a renamed id throws on a `window`
 * listener where no error boundary is standing — the editor keeps drawing, and the only symptom
 * is a key that quietly stopped working.
 */
const UNDO = shortcut("deckEditor", "undo");
const REDO = shortcut("deckEditor", "redo");
const REMOVE = shortcut("deckEditor", "remove");

/** What the two bindings need from the editor — each one already stable there. */
export interface DeckKeyboard {
  runUndo: () => void;
  runRedo: () => void;
  /** Whether one of the editor's own layers is up — the Delete binding's second fence. */
  layerOpen: boolean;
  /** The picked set, read at the press — see `DeckEditor`'s `pickedRef`. */
  pickedRef: RefObject<readonly DeckCard[]>;
  setQuantityAt: (
    cardId: string,
    categoryId: number,
    finish: DeckFinish,
    quantity: number,
  ) => Promise<unknown>;
  reportBatch: (presses: readonly Promise<unknown>[]) => void;
  setCardSelection: (selection: null) => void;
}

export function useDeckKeyboard({
  runUndo,
  runRedo,
  layerOpen,
  pickedRef,
  setQuantityAt,
  reportBatch,
  setCardSelection,
}: DeckKeyboard): void {
  /**
   * Undo and redo, on `window` for the length of this editor.
   *
   * **The chords are the catalogue's** — {@link UNDO} and {@link REDO}, `deckEditor`'s entries in
   * `packages/ui/lib/shortcuts.ts` — rather than comparisons written out here, so the key map cannot
   * advertise a chord this handler does not bind. `redo` carries more than one spelling and this
   * site does not know how many; the argument for the pair is written at that entry, where the
   * chords are, and a spelling added there is bound with no edit here.
   *
   * **It yields inside a text field**, which is the whole of what keeps the quick-add box, the
   * deck name and the notes usable: those get the browser's own undo, which this cannot
   * replace and must not swallow. That yield stays at this call site rather than moving into
   * the matcher, because it is a fact about *this* binding — `Ctrl+1` has no native meaning in
   * a field, and yielding there would kill view-switching exactly where the caret usually is.
   * `isTextField` is `useContextMenu`'s — the same predicate the native-context-menu carve-out
   * already turns on, rather than a second spelling of "is the caret in something typed".
   *
   * **The match runs first and the caret test second**, which is the `Delete` handler's order one
   * screen down and the *inverse* of `useContextMenu.ts:119`'s. Both orders are the same rule —
   * pay for the cheap half first — read against two different expensive halves: there the item
   * list is built on every press and `isTextField` is the cheap guard, here matching two chords
   * is arithmetic over an event and `isTextField` is a `closest()` walk up the DOM. Tested first
   * it walked the tree on every keystroke typed into the quick-add box, for the two presses in a
   * session that are `Ctrl+Z`.
   *
   * There is no modifier pre-check left: `matchesChord`, which `packages/ui/lib/shortcuts.ts` builds
   * {@link matchesShortcut} out of, is exact in both directions — so an unlisted modifier is
   * already a non-match and a guard for it would be a second, looser statement of the same rule.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = matchesShortcut(UNDO, e) ? runUndo : matchesShortcut(REDO, e) ? runRedo : null;
      if (run === null) return;
      if (isTextField(e.target)) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runUndo, runRedo]);

  /**
   * **The catalogue's `remove` takes the picked cards out of the deck** — issue #214, and the one
   * keyboard verb this editor has that is not undo. The chord is {@link REMOVE}, `deckEditor`'s
   * `remove` entry in `packages/ui/lib/shortcuts.ts`, rather than a comparison written out here, so the
   * key map cannot advertise a chord this handler does not bind.
   *
   * ## Why it exists here and nowhere else in the app
   *
   * "Remove" is a defined act on a deck row and is not one anywhere else a card is drawn: on a
   * search wall Delete would name nothing, and on the collection it would mean destroying a record
   * of cardboard the reader owns. So the key is bound by the editor, for the editor's own scope,
   * and the walls get multi-select without it.
   *
   * ## Three fences, each closing a real way this goes wrong
   *
   * **A text field keeps the key**, through the same `isTextField` the undo handler one screen up
   * yields to and the native context menu's carve-out turns on — a reader deleting a character out
   * of the deck's name must not lose four cards. It stays at this call site for that handler's
   * reason: which bindings yield to a caret is a fact about each binding, not about matching a
   * chord. **A layer takes it too**: with a dialog or a confirmation open the deck is behind a
   * scrim, and a key that reached past it would act on a surface the reader cannot see.
   * **And so does a modal this editor does not own** (issue #553): `AllPrintingsDialog` and
   * `CardDetailModal` are mounted at `App` level, so `layer` knows nothing about them — and
   * `openAllPrintings` leaves the picked set standing, so a Delete pressed on a printing tile cut
   * two picked cards from behind the scrim with no confirmation. The test is `AppShell`'s own
   * for `Ctrl+1…9`: any `[aria-modal="true"]` in the document, which every `Dialog` carries and
   * which answers for a modal that is added later without anybody remembering this handler.
   * And **nothing is written for a set of one**, which is the
   * deliberate asymmetry — one card has a stepper, a menu row and a tray, all of them visible, and
   * a bare Delete that silently removed whatever was last clicked is a keystroke away from a deck
   * the reader did not mean to edit.
   *
   * It goes through `setQuantityAt(…, 0)` like every other removal in this editor — the stepper's
   * zero, the menu's `Remove card`, the tray's drop — so it inherits the optimistic patch, the
   * rollback, and the collection write that files the copies into `Recently removed`. There is no
   * remove mutation and this is not the place to add one.
   *
   * **What it costs is one press of Ctrl+Z per card**, because `deck_audit` has a row per write.
   * Named rather than hidden: batching is a Rust change to `deck_undo`'s grain. What it no longer
   * costs is a refusal: every card's outcome goes to {@link reportBatch}, so a cut the backend
   * refused for the second card of four is said even when the fourth went through.
   */
  useEffect(() => {
    if (layerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!matchesShortcut(REMOVE, event)) return;
      if (isTextField(event.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      const held = pickedRef.current;
      if (held.length < 2) return;
      event.preventDefault();
      reportBatch(held.map((card) => setQuantityAt(card.cardId, card.categoryId, card.finish, 0)));
      setCardSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layerOpen, pickedRef, setQuantityAt, reportBatch, setCardSelection]);
}
