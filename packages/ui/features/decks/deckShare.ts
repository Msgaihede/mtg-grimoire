/**
 * Which share key a deck publishes under — issue #1032.
 *
 * A share names what it publishes by one opaque string (`ShareRow.folderUid`), which neither the
 * relay nor the share Worker reads beyond its shape: a deck share is the **key** `deck:<syncUid>`,
 * and `share::deck` in the desktop crate is its reader. The deck's own `decks.sync_uid`, because
 * it syncs — a second device in the group resolves the same key to its copy of the deck, and
 * *Update now* keeps working there. Its row id would name a deck no other device can find.
 *
 * What travels is the deck's live list (its *Actual*), pile by pile; `share::deck`'s header has
 * what is left home and why.
 */
import type { ShareTarget } from "@/features/collection/ShareFolderMenu";
import type { DeckRow } from "@/lib/ipc";

/** What every deck key begins with — `share::deck::PREFIX`, and the share Worker's `DECK_PREFIX`. */
export const DECK_SHARE_PREFIX = "deck:";

/**
 * The Share control's target for this deck, or `null` for no control.
 *
 * `null` out is a deck with no uid yet — never a fallback key, which would publish under a name
 * no other device could find. `null` in is a deck whose row has not answered.
 */
export function deckShareTarget(
  deck: Pick<DeckRow, "name" | "syncUid"> | null,
): ShareTarget | null {
  if (deck === null || deck.syncUid === null || deck.syncUid === "") return null;
  return { kind: "deck", uid: `${DECK_SHARE_PREFIX}${deck.syncUid}`, title: deck.name };
}
