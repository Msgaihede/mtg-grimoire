/**
 * The **managed wishlist** as the frontend reads it (user schema v48, issue #512): a folder a
 * `Theory + Actual` deck keeps, holding exactly what that deck's Compare dialog lists, rewritten by
 * Rust after every change to the deck.
 *
 * **It is the deck's and not the reader's**, and every write that would touch one is refused by the
 * backend in {@link MANAGED_REFUSAL}'s words — renaming, moving, deleting, clearing or reordering the
 * folder, making a folder in it, filing a wish into it or out of it, and any edit to a wish inside
 * it. So the rule on this side is the pinned deck groups' rule one cabinet over
 * (`features/collection/PinnedFolders.tsx`): **a managed folder is never offered as a destination,
 * and a wish inside one draws no control that could only end in that sentence.** A greyed control
 * whose only outcome is a refusal teaches nothing its absence does not.
 *
 * Pure and dependency-free on purpose, so every surface that draws a wishlist folder — the page, the
 * card menu, the destination picker, the home widget — asks the one question the one way.
 */
import type { ManagedWishlistMode, WishlistFolder } from "@/lib/ipc";

/** The backend's refusal for every hand edit of a managed folder, verbatim — the fake answers it
 *  too, so a story cannot stand up a write the app refuses. */
export const MANAGED_REFUSAL = "A managed wishlist follows its deck, so it can't be edited by hand.";

/** Whether this folder is a deck's managed wishlist. `!= null` rather than `!== null`, so a fixture
 *  written before v48 that leaves the field out reads as the reader's own folder. */
export function isManaged(folder: Pick<WishlistFolder, "managedDeckId">): boolean {
  return folder.managedDeckId != null;
}

/** The reader's own drawers out of a list that also carries the decks' — every list of
 *  **destinations** is built from this and never from the raw rows. */
export function userWishFolders<T extends Pick<WishlistFolder, "managedDeckId">>(
  folders: readonly T[],
): T[] {
  return folders.filter((folder) => !isManaged(folder));
}

/**
 * The managed folders, sorted by name — `pinnedFolders`' opinion one cabinet over: the backend's
 * `ORDER BY sort_order, id` is the order the decks happened to be made in, which is not an order a
 * reader can predict or scan, and these rows have no `sort_order` anybody arranged.
 *
 * **Less every deck's Tokens child** (user schema v55): each is named `Tokens`, so a list by name
 * would draw one indistinguishable row per deck — it is its parent that says whose it is. It is
 * still the deck's everywhere else ({@link userWishFolders}, {@link managedIds}).
 */
export function managedWishFolders<
  T extends Pick<WishlistFolder, "managedDeckId" | "name"> & Partial<Pick<WishlistFolder, "managedTokens">>,
>(folders: readonly T[]): T[] {
  return folders
    .filter((folder) => isManaged(folder) && folder.managedTokens !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The set of managed folder ids, for the per-row question "is this wish the deck's?". */
export function managedIds(folders: readonly WishlistFolder[]): ReadonlySet<number> {
  return new Set(folders.filter(isManaged).map((folder) => folder.id));
}

/**
 * What an **empty** managed folder says, by the Compare view its deck follows (live pass §13).
 *
 * The folder holds one view's own copies — `MANAGED_WISHLIST_HINT`'s words in
 * `features/decks/managedWishlist.ts` — so "nothing in it" is a statement about that view and no
 * other: an empty `missing` folder is a deck playing every planned card in *some* printing, which
 * is not an empty `all` folder (the two lists agree outright) and says nothing either way about
 * `other`'s substitutions. The one sentence this page had was `missing`'s, and it stood under every
 * folder whatever it followed. `all`'s is the Compare dialog's own empty `All` answer.
 *
 * **Words, never a target**: the folder is app-owned and takes no drop, so this is said in a box
 * and not in the dashed drawer a reader's empty folder draws.
 *
 * **No `tokens` sentence since user schema v57** (issue #617). From v55 `tokens` was a fifth
 * view, the one whose folder was *always* empty of its own, and it had a sentence saying where its
 * wishes went instead. Tokens are a switch beside the view now, so every managed folder holds one
 * view's cards and these three sentences — each about **cards** — are true of it whether or not a
 * `Tokens` child sits inside; the child says {@link MANAGED_TOKENS_EMPTY} for itself.
 */
export const MANAGED_EMPTY: Record<Exclude<ManagedWishlistMode, "off">, string> = {
  all: "The two lists agree. Everything requested by the plan is already in the deck.",
  missing: "Nothing missing. The deck includes every card in the plan.",
  other: "No substitutions. Every card matches the planned printing.",
};

/**
 * The sentence for a folder whose mode is not known — the deck list not read yet, or a deck this
 * page cannot find (another window deleted it between the two reads). It claims nothing about any
 * view, only what every managed folder is.
 */
export const MANAGED_EMPTY_UNKNOWN = "Empty. This folder updates automatically with its deck.";

/**
 * What an empty **Tokens child** says (user schema v55) — one sentence whichever view its parent
 * follows, because under all three it holds the same thing since v57's tokens switch (issue #617):
 * the token printings the plan asks for and the deck does not count. Its parent's sentence would
 * be wrong here — each of those is about cards, and this folder holds none.
 */
export const MANAGED_TOKENS_EMPTY = "No tokens missing.";

/**
 * {@link MANAGED_EMPTY} for a mode, or {@link MANAGED_EMPTY_UNKNOWN} where there is none to read —
 * `off` included, which is a deck that keeps no folder and so cannot be the one on screen. A
 * managed wishlist's Tokens child (`tokens`, its `managedTokens`) says {@link MANAGED_TOKENS_EMPTY}
 * under any view this build knows.
 *
 * **Named cases, never an index into the table.** The mode arrives over IPC from a column a later
 * schema can widen, and the type is a promise `ipc.ts` makes by hand: a mode this build has no
 * sentence for would index to `undefined` — or, for a name `Object.prototype` carries, to a
 * function — and draw nothing where a sentence belongs. Anything unnamed is the unknown sentence.
 */
export function managedEmptySentence(
  mode: ManagedWishlistMode | undefined,
  tokens = false,
): string {
  switch (mode) {
    case "all":
    case "missing":
    case "other":
      return tokens ? MANAGED_TOKENS_EMPTY : MANAGED_EMPTY[mode];
    default:
      return MANAGED_EMPTY_UNKNOWN;
  }
}
