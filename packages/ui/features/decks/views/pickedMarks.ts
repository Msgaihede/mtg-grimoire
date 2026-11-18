import { useMemo } from "react";
import type { DeckCard } from "@/lib/ipc";
import type { DeckCardActions } from "../cardControl";
import { deckCardSlot } from "../dnd";

/**
 * **One Ctrl-click redraws the pile it landed in, and no other** — how the picked set reaches the
 * four views without every pile being handed a new prop per pick.
 *
 * Until this, the set travelled as `actions.isPicked`: one predicate over the whole set, inside
 * the bag every pile is handed. A pick is a new set, so it was a new predicate, so a new `actions`
 * — and `views/sameDrawn.ts` compares `actions` by identity, as it must — so every memoised pile on
 * the desk was drawn again to move one ring. On a deck of a hundred cards across a dozen piles that
 * is every face redrawn per click, and a Shift-range of forty cards is the same cost again.
 *
 * So the desk hands each view the picked **keys** (`DeckDesk`'s `picked.keys`), each view hands
 * each pile **the slots of that pile that are picked** ({@link pickedIn}), and the pile marks its
 * cards from that ({@link usePickedMarking}). The per-pile answer is an array of strings, and
 * `sameDrawnProps` already compares an array prop by its items — strings by value — so a pile whose
 * picked cards did not change is handed an equal prop and skipped. No deep comparison was added
 * anywhere; the widening that existed is what this rides on.
 *
 * `DeckDesk.test.tsx` counts it: a Ctrl-click on one card draws no face in another pile.
 */

/** Nothing picked in this pile — one array for every such pile, so "none" is never a new prop. */
export const NONE_PICKED: readonly string[] = Object.freeze([]);

/** The picked keys as a set, held still while the keys are — one per view render, not per pile. */
export function usePickedSet(picked: readonly string[] | undefined): ReadonlySet<string> | null {
  return useMemo(() => (picked === undefined || picked.length === 0 ? null : new Set(picked)), [picked]);
}

/**
 * The slots of `cards` that are picked, in the pile's own order — {@link NONE_PICKED} for a pile
 * with none, which is every pile but one or two on an ordinary click.
 */
export function pickedIn(
  cards: readonly DeckCard[],
  picked: ReadonlySet<string> | null,
): readonly string[] {
  if (picked === null) return NONE_PICKED;
  const out: string[] = [];
  for (const card of cards) {
    const slot = deckCardSlot(card.categoryId, card.cardId, card.finish);
    if (picked.has(slot)) out.push(slot);
  }
  return out.length === 0 ? NONE_PICKED : out;
}

/**
 * What a pile hands `deckCardMarked` — `actions` with `isPicked` answered from **this pile's**
 * picked slots, or `actions` untouched for a view given no `picked` at all (a story, a shared
 * read-only mount, a surface that still sets `isPicked` itself).
 *
 * Only the mark reads it. The cards themselves are still handed the editor's own `actions`, whose
 * identity every drag registration below them depends on.
 */
export function usePickedMarking(
  actions: DeckCardActions | undefined,
  picked: readonly string[] | undefined,
): DeckCardActions | undefined {
  return useMemo(
    () =>
      picked === undefined
        ? actions
        : { ...actions, isPicked: (slot: string) => picked.includes(slot) },
    [actions, picked],
  );
}
