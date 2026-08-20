/**
 * The deck that is already open, as a destination — the descriptor, bound to one deck.
 *
 * **Its own module rather than the bottom of `deck.ts`, and rather than the bottom of
 * `DeckPreview.tsx`.** `deck.ts` is the planner and is React-free on purpose: `decklists.test.ts`
 * imports it for the round trip, and a descriptor there would pull React, `useDeck` and the whole
 * IPC surface into a suite that only wants a pure function — and would close an import cycle,
 * since the preview reads the planner. `DeckPreview.tsx` is a component file. So the descriptor
 * sits where the other destinations' do: `destinations/<key>.ts`, beside `newDeck.ts` and, from
 * Task 14, `collection.ts` and `wishlist.ts`.
 *
 * `createElement` rather than JSX for the same reason the file is `.ts`: two one-line wrappers
 * are not worth breaking that convention over.
 */
import { createElement } from "react";
import type { ImportDestination } from "../destination";
import { DeckImportSubtitle, DeckPreview, type DeckImportInto } from "./DeckPreview";

/**
 * The deck as a destination, with its own identity closed over.
 *
 * **A function and not a value**, and that is the one place this destination departs from the
 * shape the other three have. `DeckPreview` needs a deck id, and a `deckDestination` constant
 * whose `Preview` were `DeckPreview` behind a cast would be a value that type-checks everywhere
 * and crashes wherever anybody mounted it without the wrapper. So the wrapper *is* the
 * destination, and there is no unbound one to mount by mistake.
 *
 * **Call it inside a `useMemo`, and key that memo on identity only.** What comes back is a pair
 * of *component identities*, so a fresh one on any render remounts the step under the reader and
 * takes their commander choice with it. {@link DeckImportInto} is deliberately nothing but "which
 * deck, which list" for that reason: **a presentational value in the closure is a remount waiting
 * to happen** — it changes when the data changes, which is precisely when the reader is least
 * expecting the step to blink. Anything the preview needs to *draw* it reads from the query it is
 * already making.
 */
export function deckDestination(into: DeckImportInto): ImportDestination {
  return {
    key: "deck",
    label: "this deck",
    // The deck's line names the deck, which is a `deck_get` — so this is a component, mounted by
    // the shell inside its own `open &&`, and never a string computed by a host.
    Subtitle: () =>
      createElement(DeckImportSubtitle, {
        deckId: into.deckId,
        variant: into.variant,
        forcedCategoryName: into.forcedCategoryName,
      }),
    Preview: (props) => createElement(DeckPreview, { ...props, ...into }),
  };
}
