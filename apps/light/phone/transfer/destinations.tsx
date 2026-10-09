import type { JSX } from "react";
import type {
  DestinationPreviewProps,
  ImportDestination,
} from "@grimoire/ui/features/transfer/import/destination";
import {
  COLLECTION_DESTINATION,
  CollectionPreviewBody,
} from "@grimoire/ui/features/transfer/import/destinations/CollectionPreviewBody";
import {
  DeckPreviewBody,
  type DeckImportInto,
} from "@grimoire/ui/features/transfer/import/destinations/DeckPreviewBody";
import { deckDestinationWith } from "@grimoire/ui/features/transfer/import/destinations/deckIntoWith";
import {
  NEW_DECK_DESTINATION,
  NewDeckPreviewBody,
  type NewDeckInto,
} from "@grimoire/ui/features/transfer/import/destinations/NewDeckPreviewBody";
import { usePhoneTransferPrefs } from "./prefs";

/**
 * The phone face's import destinations: **the desktop's own second steps**, handed this face's
 * remembered fallbacks instead of the app store's.
 *
 * Every deck and collection decision an import makes — the piles, the commander, the condition a
 * silent line falls back to, the mode, the commit and its invalidations, the collection's undo
 * ticket — is in those steps and the planners under them, so nothing here re-decides any of it.
 * What this file supplies is the one fact the steps are handed rather than reading: where the
 * condition and finish fallbacks live.
 */

function PhoneDeckPreview(props: DestinationPreviewProps & DeckImportInto): JSX.Element {
  const importDefaults = usePhoneTransferPrefs((s) => s.importDefaults);
  return <DeckPreviewBody {...props} importDefaults={importDefaults} />;
}

/**
 * The deck on screen, as a destination — `deckDestination`'s descriptor bound to the store-free
 * step. **Call it inside a `useMemo` keyed on identity only**, for that function's reason: what
 * comes back is a component identity, and a fresh one remounts the step under the reader.
 */
export function phoneDeckDestination(into: DeckImportInto): ImportDestination {
  return deckDestinationWith(into, PhoneDeckPreview);
}

function PhoneCollectionPreview(props: DestinationPreviewProps): JSX.Element {
  const defaults = usePhoneTransferPrefs((s) => s.importDefaults);
  const setDefaults = usePhoneTransferPrefs((s) => s.setImportDefaults);
  return <CollectionPreviewBody {...props} defaults={defaults} setDefaults={setDefaults} />;
}

function PhoneNewDeckPreview(props: DestinationPreviewProps & NewDeckInto): JSX.Element {
  const importDefaults = usePhoneTransferPrefs((s) => s.importDefaults);
  return <NewDeckPreviewBody {...props} importDefaults={importDefaults} />;
}

/**
 * A deck the list is about to become — `newDeckDestination` with the desktop's own step,
 * store-free, closing over what only the gallery knows: the format the reader last built in, the
 * folder the gallery is open on, and where to go once the deck exists. **Call it inside a
 * `useMemo`** for {@link phoneDeckDestination}'s reason: `Preview` is a component identity, and a
 * fresh one remounts the step and takes the name the reader typed with it.
 */
export function phoneNewDeckDestination(into: NewDeckInto): ImportDestination {
  return {
    ...NEW_DECK_DESTINATION,
    Preview: (props) => <PhoneNewDeckPreview {...props} {...into} />,
  };
}

/** The reader's collection, as a destination. A value: it closes over nothing. */
export const phoneCollectionDestination: ImportDestination = {
  ...COLLECTION_DESTINATION,
  Preview: PhoneCollectionPreview,
};
