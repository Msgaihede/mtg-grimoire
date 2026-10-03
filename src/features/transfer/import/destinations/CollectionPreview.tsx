/**
 * The collection as a destination **on the desktop** — the store-free step in
 * `./CollectionPreviewBody`, with `useAppStore`'s `importDefaults` handed in.
 *
 * The body moved out so the light app's phone face could draw the same step over a store of its
 * own (`mobile/phone/fence.test.ts` keeps the app store off that face); this file kept the names
 * every desktop caller and test imports, so none of them changed.
 */
import type { JSX } from "react";
import { useAppStore } from "@/lib/store";
import type { DestinationPreviewProps, ImportDestination } from "../destination";
import { COLLECTION_DESTINATION, CollectionPreviewBody } from "./CollectionPreviewBody";

export { COLLECTION_MODES } from "./CollectionPreviewBody";

export function CollectionPreview(props: DestinationPreviewProps): JSX.Element {
  // The defaults live in the store so a reader importing box after box re-picks nothing.
  const defaults = useAppStore((s) => s.importDefaults);
  const setDefaults = useAppStore((s) => s.setImportDefaults);
  return <CollectionPreviewBody {...props} defaults={defaults} setDefaults={setDefaults} />;
}

export const collectionDestination: ImportDestination = {
  ...COLLECTION_DESTINATION,
  Preview: CollectionPreview,
};
