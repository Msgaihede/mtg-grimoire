/**
 * The deck that is already open, as a destination — the descriptor, bound to one deck **and to
 * whichever step draws it**.
 *
 * `deckInto.ts`'s `deckDestination` is this with the desktop's `DeckPreview`, which reads the app
 * store for the "I own these" box's fallbacks; the light app's phone face binds the store-free
 * `DeckPreviewBody` with answers of its own instead. One descriptor shape, so the two faces cannot
 * come to disagree about the destination's key, its word, or the subtitle that names the deck.
 *
 * `createElement` rather than JSX for `deckInto.ts`'s reason: a `.ts` file of two one-line
 * wrappers.
 */
import { createElement, type ComponentType } from "react";
import type { DestinationPreviewProps, ImportDestination } from "../destination";
import { DeckImportSubtitle, type DeckImportInto } from "./DeckPreviewBody";

/**
 * The deck as a destination, with its own identity and its step closed over. **Call it inside a
 * `useMemo` keyed on identity only** — `deckDestination`'s rule, for its reason: what comes back
 * is a pair of component identities, and a fresh one remounts the step under the reader.
 */
export function deckDestinationWith(
  into: DeckImportInto,
  Preview: ComponentType<DestinationPreviewProps & DeckImportInto>,
): ImportDestination {
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
    Preview: (props) => createElement(Preview, { ...props, ...into }),
  };
}
