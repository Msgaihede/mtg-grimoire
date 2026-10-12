/**
 * Which share key a wishlist level publishes under — issue #941.
 *
 * A share names what it publishes by one opaque string (`ShareRow.folderUid`), which neither the
 * relay nor the share Worker reads: a wishlist share is a **key** in that namespace, and
 * `share::wishlist` in the desktop crate is its reader. The four shapes are spelled here and
 * there, and the two files must agree:
 *
 * | Key | Publishes |
 * | --- | --- |
 * | `wishlist:` | The whole wishlist — the root and every folder the reader made |
 * | `wishlist:folder:<syncUid>` | One folder the reader made, and everything under it |
 * | `wishlist:deck:<deck uid>` | A deck's managed wishlist, its Tokens child included |
 * | `wishlist:deck-tokens:<deck uid>` | A deck's managed Tokens folder alone |
 *
 * **A managed folder is named by its deck**, because its own `syncUid` is derived per device and
 * thrown away whenever the deck's mode goes off and back; the deck's uid syncs, so a second
 * device in the group finds the same share for its own copy of the folder.
 */
import type { WishlistFolder } from "@/lib/ipc";
import type { ShareTarget } from "@/features/collection/ShareFolderMenu";

/** What every wishlist key begins with — `share::wishlist::PREFIX`. */
export const WISHLIST_SHARE_PREFIX = "wishlist:";

/** `share::wishlist::WHOLE_WISHLIST_TITLE`. */
export const WHOLE_WISHLIST_TITLE = "Wishlist";

/** The key the whole wishlist is shared under. */
export const WHOLE_WISHLIST_KEY = WISHLIST_SHARE_PREFIX;

/** A uid worth naming — `folderShareUid`'s rule: `null` and `""` are both *no uid*. */
function named(uid: string | null): string | null {
  return uid !== null && uid !== "" ? uid : null;
}

/**
 * The Share control's target at this level of the wishlist, or `null` for no control.
 *
 * `null` in is the root, which shares the whole list. `null` out is a folder this build cannot
 * name to a share — one the list gave no uid for, which must be an absence rather than a fallback:
 * a fallback key would publish some other set of wishes under the reader's press.
 *
 * `folders` is the flat list, read for a Tokens child's parent: the child is called `Tokens` at
 * home and carries its deck's name on the dialog, as `share::wishlist` titles its snapshot.
 */
export function wishlistShareTarget(
  folder: WishlistFolder | null,
  folders: readonly WishlistFolder[],
): ShareTarget | null {
  if (folder === null) {
    return { kind: "wishlist", uid: WHOLE_WISHLIST_KEY, title: WHOLE_WISHLIST_TITLE };
  }
  if (folder.managedDeckId !== null) {
    const deck = named(folder.managedDeckUid);
    if (deck === null) return null;
    if (!folder.managedTokens) {
      return { kind: "wishlist", uid: `${WISHLIST_SHARE_PREFIX}deck:${deck}`, title: folder.name };
    }
    const parent = folders.find((f) => f.id === folder.parentId);
    return {
      kind: "wishlist",
      uid: `${WISHLIST_SHARE_PREFIX}deck-tokens:${deck}`,
      title: parent === undefined ? folder.name : `${parent.name} tokens`,
    };
  }
  const uid = named(folder.syncUid);
  if (uid === null) return null;
  return { kind: "wishlist", uid: `${WISHLIST_SHARE_PREFIX}folder:${uid}`, title: folder.name };
}
