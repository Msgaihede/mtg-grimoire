/**
 * Which printings a **tile** is showing the back of — issue #844, the flip that does not need the
 * card modal.
 *
 * The modal has always been able to turn a two-sided card over (`CardModalArt`'s "Flip card"),
 * and that was the only place: a reader scanning a wall of transforming cards for the one whose
 * back half they wanted had to open each one. The walls and the deck editor's two picture views
 * now draw a flip button under a card's quantity controls, and the card menu offers the same verb
 * on a right-click. This module is the one answer all of them read.
 *
 * ## Keyed by printing, and shared by every surface
 *
 * The key is the printing id rather than a tile, and that is a decision rather than a shortcut.
 * A wall tile, a deck card and a menu target all carry the printing id already; a tile key does
 * not exist on a deck card and is not on a menu target, so keying by tile would have meant
 * threading a second identity through every menu builder for a fact the reader thinks of as being
 * about the *card*. The consequence is one a reader expects rather than one they have to learn:
 * the same printing drawn twice on screen — a card played in the main deck and in the maybe pile,
 * or one printing filed in two collection folders — shows the same side in both places.
 *
 * **Session memory, not a setting.** Nothing is persisted. A turned card stays turned while the
 * app is open, across view switches, because putting a card back the way it was is a press the
 * reader can make and silently undoing one is not; a restart starts every card face up.
 *
 * **Only a face index of `0` or `1`**, because the only cards offered the control are the ones
 * `faceCount` calls two-sided. The modal's own state is deliberately separate: it opens on the
 * front as it always has, and turning the card there does not turn the tile under it.
 */
import { create } from "zustand";

interface ShownFaceState {
  /** The printing ids currently showing their back. Absent is the front. */
  backs: ReadonlySet<string>;
  toggle: (cardId: string) => void;
}

const useShownFaceStore = create<ShownFaceState>((set) => ({
  backs: new Set(),
  toggle: (cardId) =>
    set(({ backs }) => {
      // A new set on every press: zustand compares by reference, and a mutated set would leave
      // every subscribed tile reading the snapshot it already had.
      const next = new Set(backs);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return { backs: next };
    }),
}));

/**
 * The face a printing is drawn on: `1` when the reader turned it over, `0` otherwise.
 *
 * `null` is a card with no second side (or no printing at all) and always answers `0`, so a
 * caller can pass its gate straight through rather than branching around the hook — the selector
 * returns a primitive, so a press on one card re-renders that card's tiles and no others.
 */
export function useShownFace(cardId: string | null): 0 | 1 {
  return useShownFaceStore((state) => (cardId !== null && state.backs.has(cardId) ? 1 : 0));
}

/** Turn a printing over, wherever it is drawn. The press behind the button and the menu row. */
export function toggleShownFace(cardId: string): void {
  useShownFaceStore.getState().toggle(cardId);
}

/** Whether a printing is currently showing its back — the menu's read, outside React. */
export function showsBack(cardId: string): boolean {
  return useShownFaceStore.getState().backs.has(cardId);
}

/** Every card face up again. For tests, which share this module across cases. */
export function resetShownFaces(): void {
  useShownFaceStore.setState({ backs: new Set() });
}
