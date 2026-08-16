import { useCallback, useEffect, useRef, useState } from "react";
import { LANDED_MS } from "./cardControl";

/** A `setTimeout` handle, as this project's DOM-only lib types one. */
type Timer = ReturnType<typeof setTimeout>;

/** Nothing has landed — one stable identity, so a view's memo does not see a new empty map on
 *  every render of the editor. `CardStack`'s `NONE_LANDED` is the same idea one floor down. */
const NOTHING_LANDED: ReadonlyMap<number, number> = new Map();

/** What {@link useRecentAdds} answers with. */
export interface RecentAdds {
  /** `deck_cards.id` → the nonce that add was given, for every card still inside its ten
   *  seconds. Handed to all four views whole, the way `violations` is. */
  landed: ReadonlyMap<number, number>;
  /** A card just landed in this row. The id is `EntryChange.id` — what the add answered. */
  markLanded: (entryId: number) => void;
}

/**
 * Which cards have just been added, and for how much longer they say so.
 *
 * A file of its own rather than a hundred lines at the top of `DeckEditor.tsx`: it is complete,
 * named and self-contained — it reads nothing of the editor's and the editor reads nothing of
 * its internals, only the pair it answers with. {@link LANDED_MS} stays imported from
 * `./cardControl`, where it is paired with the `--animate-card-landed` stylesheet duration and
 * where `cardControl.test.ts` is what holds the two together.
 *
 * ## Why the row id, and not the printing
 *
 * `deck_add_card` **folds**: adding a card the deck already holds does not make a second row, it
 * increments the one that is there. `EntryChange.id` is the row either way — the one it created
 * or the one it folded into — which is exactly the thing the reader wants pointed at, and it is
 * what every view already keys its cards by (`DeckCard.id`). A `cardId` would light the same
 * printing in *every* pile that holds it, which is wrong for the one question this answers:
 * where did **this** copy go.
 *
 * ## Why there is a nonce as well as a timer
 *
 * The fade is a CSS animation (`--animate-card-landed`), and a CSS animation runs once per
 * element. So a second add of a card that is still glowing has to hand the mark a new React key
 * or nothing happens on screen — the reader presses Add, the deck's number goes up, and the card
 * they were told to look at does not so much as blink. The value in the map is that key. It is a
 * counter rather than a timestamp because `Date.now()` twice in one tick is one number.
 *
 * ## Why a timer at all, when the animation ends by itself
 *
 * Two reasons, and neither is the fade. The mark has to **leave the DOM**, or a session's worth
 * of adds is a session's worth of invisible overlays sitting on cards; and the map has to empty,
 * or nothing above ever goes back to `NOTHING_LANDED`. {@link LANDED_MS} is the same five seconds
 * the stylesheet fades over — see it for why the number is in two places and what holds them
 * together.
 */
export function useRecentAdds(): RecentAdds {
  const [landed, setLanded] = useState<ReadonlyMap<number, number>>(NOTHING_LANDED);
  // Neither is a thing to draw, and writing one must never schedule a render of its own —
  // `CardStack`'s `useFlipThrough` keeps its two timers in a ref for the same reason.
  const nonce = useRef(0);
  const timers = useRef(new Map<number, Timer>());

  // Read out of the ref here rather than in the cleanup, which is what the hooks lint asks for
  // and is honest besides: the map is created by this hook and never replaced.
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
      running.clear();
    };
  }, []);

  const markLanded = useCallback((entryId: number) => {
    nonce.current += 1;
    const stamp = nonce.current;
    const running = timers.current;
    // At most one timer per row: a card added three times in quick succession glows once, for
    // five seconds from the last press, rather than going dark while the reader is still pressing.
    const pending = running.get(entryId);
    if (pending !== undefined) clearTimeout(pending);
    running.set(
      entryId,
      setTimeout(() => {
        running.delete(entryId);
        setLanded((was) => {
          const next = new Map(was);
          next.delete(entryId);
          return next.size === 0 ? NOTHING_LANDED : next;
        });
      }, LANDED_MS),
    );
    setLanded((was) => new Map(was).set(entryId, stamp));
  }, []);

  return { landed, markLanded };
}
