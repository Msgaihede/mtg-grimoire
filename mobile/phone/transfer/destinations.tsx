import type { JSX } from "react";
import type {
  DestinationPreviewProps,
  ImportDestination,
} from "@/features/transfer/import/destination";
import {
  COLLECTION_DESTINATION,
  CollectionPreviewBody,
} from "@/features/transfer/import/destinations/CollectionPreviewBody";
import {
  DeckPreviewBody,
  type DeckImportInto,
} from "@/features/transfer/import/destinations/DeckPreviewBody";
import { deckDestinationWith } from "@/features/transfer/import/destinations/deckIntoWith";
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

/** The reader's collection, as a destination. A value: it closes over nothing. */
export const phoneCollectionDestination: ImportDestination = {
  ...COLLECTION_DESTINATION,
  Preview: PhoneCollectionPreview,
};
