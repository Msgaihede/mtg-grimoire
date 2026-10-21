import { useQueryClient } from "@tanstack/react-query";
import { useCreateCollectionFolder } from "@/features/collection/useCollectionFolders";
import { ipcError, type CollectionFolder } from "@/lib/ipc";

/** What the folder pickers' new-folder press is called — the wishlist destination's row's words. */
export const NEW_FOLDER_LABEL = "New folder…";

/** The refusal a picker draws under the name, the backend's own sentence after it. */
export function newFolderRefusal(error: string): string {
  return `Couldn't create the folder — ${error}`;
}

export interface TrayNewFolder {
  /**
   * Make a folder named `name` at the top level of the collection and pick it as the tray's
   * destination. Answers whether it was made — `false` for a refusal, which is then
   * {@link TrayNewFolder.error}, and for a press while one is already in flight.
   */
  create: (name: string) => Promise<boolean>;
  pending: boolean;
  /** The last refusal, in the backend's own words, or `null`. */
  error: string | null;
  /** Put the refusal down — a picker opening its name field again starts with none. */
  reset: () => void;
}

/**
 * **A new folder, made where the tray's destination is picked** (issue #1357): a reader about to
 * scan a fresh pile no longer leaves the Scanner for the Collection page to make the drawer it
 * goes in. Both faces' pickers draw it — the desktop tray's popup and the phone footer's sheet.
 *
 * **At the top level, always.** The picker is a question about where *these cards* go, and a
 * second question about where the drawer goes would turn one press into a form; a folder made
 * here can be moved under another on the Collection page, which is where the cabinet is shaped.
 *
 * **The new folder joins the cached list before it is picked**, and that order is load-bearing:
 * `useTrayFolder` reads a stored id the answered list does not hold as gone, and writes the root
 * back — so a pick landing before the list's re-read would be undone by the page a render later.
 * The cabinet's settle (`useCreateCollectionFolder`) still re-reads the list, which then holds
 * the folder in its own right.
 *
 * `onFolder` is the picker's own: it writes nothing but the choice (`prefs.folderId`).
 */
export function useTrayNewFolder(onFolder: (id: number) => void): TrayNewFolder {
  const queryClient = useQueryClient();
  const write = useCreateCollectionFolder();

  const create = async (name: string): Promise<boolean> => {
    if (write.isPending) return false;
    let folder: CollectionFolder;
    try {
      folder = await write.mutateAsync({ parentId: null, name });
    } catch {
      return false;
    }
    queryClient.setQueryData<CollectionFolder[]>(["collection", "folders"], (folders) =>
      folders === undefined || folders.some((known) => known.id === folder.id)
        ? folders
        : [...folders, folder],
    );
    onFolder(folder.id);
    return true;
  };

  return {
    create,
    pending: write.isPending,
    error: write.error === null ? null : ipcError(write.error),
    reset: write.reset,
  };
}
