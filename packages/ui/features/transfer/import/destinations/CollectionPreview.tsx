/**
 * The collection as a destination **on the desktop** — the store-free step in
 * `./CollectionPreviewBody`, with `useAppStore`'s `importDefaults` and the folder list handed in.
 *
 * The body moved out so the light app's phone face could draw the same step over a store of its
 * own (`apps/light/phone/fence.test.ts` keeps the app store off that face); this file kept the names
 * every desktop caller and test imports, so none of them changed.
 */
import type { JSX } from "react";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { useAppStore } from "@/lib/store";
import type { DestinationPreviewProps, ImportDestination } from "../destination";
import { COLLECTION_DESTINATION, CollectionPreviewBody } from "./CollectionPreviewBody";

export { COLLECTION_MODES, FOLDER_MODES } from "./CollectionPreviewBody";

/** Which folder the step's `Import into` opens on — `null` for Not sorted. */
export interface CollectionImportInto {
  folderId: number | null;
}

export function CollectionPreview(
  props: DestinationPreviewProps & Partial<CollectionImportInto>,
): JSX.Element {
  // The defaults live in the store so a reader importing box after box re-picks nothing.
  const defaults = useAppStore((s) => s.importDefaults);
  const setDefaults = useAppStore((s) => s.setImportDefaults);
  // The collection page's own cache entry — it has answered long before a preview mounts.
  const { folders } = useCollectionFolderList();
  const { folderId = null, ...rest } = props;
  return (
    <CollectionPreviewBody
      {...rest}
      defaults={defaults}
      setDefaults={setDefaults}
      folders={folders}
      initialFolderId={folderId}
    />
  );
}

/**
 * The collection as a destination, opening on one folder (issue #872) — the drawer the reader is
 * standing in, or the one whose menu they pressed Import on.
 *
 * **Call it inside a `useMemo` keyed on the folder id**, `deckDestination`'s rule for its reason:
 * `Preview` is a component identity, and a fresh one on any render remounts the step under the
 * reader and takes the folder they picked with it.
 */
export function collectionDestinationInto(into: CollectionImportInto): ImportDestination {
  return {
    ...COLLECTION_DESTINATION,
    Preview: (props) => <CollectionPreview {...props} folderId={into.folderId} />,
  };
}

/** The collection as a destination, opening on Not sorted. */
export const collectionDestination: ImportDestination = {
  ...COLLECTION_DESTINATION,
  Preview: CollectionPreview,
};
