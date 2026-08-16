/**
 * The one dismissible layer the deck gallery can have open — the union, and nothing else.
 *
 * **A module of its own so that the page and the tile can both name it without naming each
 * other.** `DecksPage.tsx` holds this in a `useState` and `DeckTile.tsx` is handed the whole value
 * (see the union's own note below), so with the type living in the page the tile imported the
 * module it had just been extracted from — and the page imported the tile back. Type-only, so
 * nothing crossed at runtime; but it is a cycle to a reader and to `import/no-cycle` all the same,
 * and `DeckTile.tsx` could not be read without opening the file it came out of. The wave that
 * produced these files began by deleting an import cycle, so it does not get to leave one.
 *
 * Nothing but a type is in here. It imports nothing, which is what makes it safe for anything on
 * this screen to import.
 */

/**
 * The one dismissible layer this view can have open, and there is deliberately only ever one.
 *
 * **At most one of these is ever meant to be open**, and modelling every panel on this screen as
 * *one* piece of state is what makes "never two" structural rather than remembered — a half-typed
 * new deck beside a half-answered delete question is not a state this view draws, and separate
 * flags can express it. The tree's create field is in here for that reason even though it is
 * drawn inline rather than floating.
 *
 * This used to be argued from Escape — "`useDismissOnEscape` orders exactly two rungs, so two
 * `"inner"` peers open at once are not ordered at all and would both close on a single press" —
 * and that is no longer true: the hook keeps a stack of capture-phase registrations and only the
 * token on top acts, so peers *are* ordered, by mount depth. (It was not true of the old hook
 * either: the capture rung checks `defaultPrevented`, so the first-registered peer took the press
 * and the newer one was starved rather than both closing.) The union stands on the sentence above,
 * which never depended on any of it.
 *
 * **`DeckTile.tsx` takes the whole union rather than three booleans.** Three of these arms are a
 * tile's own layers — its delete question, its move popup, its rename field — and handing it the
 * value itself is precisely what keeps "never two" a fact about one value.
 */
export type Panel =
  /** Where the deck being made will be filed — `null` is the top level, which is what the
   *  heading's own "New deck" has always meant. A folder row's menu passes its folder, because
   *  "New deck **here**" has to be true. */
  | { kind: "createDeck"; folderId: number | null }
  | { kind: "importDeck" }
  | { kind: "deleteDeck"; deckId: number }
  | { kind: "moveDeck"; deckId: number }
  | { kind: "renameDeck"; deckId: number }
  /**
   * The hosted `DeckSettingsDialog`, which carries no deck id: the id outlives the flag by the
   * length of the panel's fade, so it is held in `DecksPage`'s `settingsDeckId` beside this. The
   * *flag* is in here for the union's own reason — one layer at a time, structurally, so opening
   * settings over a half-answered delete question replaces it rather than making two Escape peers.
   */
  | { kind: "deckSettings" }
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  /**
   * The delete question, which carries **no folder id — and must not**.
   *
   * It used to, and nothing ever read it: `DecksPage`'s `DeleteFolderConfirm` both names and
   * deletes `openNode.folder.id`, because it is anchored to the heading row's own "Delete folder…"
   * control and that control exists only for the folder the reader is standing in. A second id
   * in here would be a second source of truth that no code consults — and the day one did, the
   * two could disagree about which folder a delete was aimed at.
   *
   * Both routes into it therefore make that folder the open one: the heading's control is
   * already about it, and the folder row's menu opens the drawer on its way (see
   * `DecksPage`'s `folderMenuDeps`).
   */
  | { kind: "deleteFolder" }
  | null;
