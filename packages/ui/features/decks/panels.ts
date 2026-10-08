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
 * Which of a folder's two drawings is holding the rename field — see {@link Panel}'s
 * `renameFolder` arm, which carries the whole argument.
 *
 * A union of two words rather than a boolean, because neither name is the other's negation: a
 * reader meeting `at: "wall"` learns where the field is, where `inTree: false` only says where it
 * is not.
 */
export type FolderRenameAt = "tree" | "wall";

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
  /**
   * The folder rename field, and **which drawing of the folder became it**.
   *
   * A folder is drawn twice on this screen — as a row in the sidebar's tree and as a card on the
   * wall — and since 2026-09-08 both can put a field in place of themselves. One `folderId` cannot
   * say which, so wiring the card to a bare `renameFolder` opened *two* identical fields at once,
   * each answering to `Rename X` and each committing the same write.
   *
   * `at` is therefore the opener rule stated as data: **the field stands where the reader started
   * it.** A press on the wall — the card's pencil, its right-click, its `⋯` — is `"wall"`; the
   * tree's row menu and its F2 are `"tree"`, and so is the heading row's `Folder` control, because
   * that one renames the folder the reader is *standing in* and an open folder has no card on its
   * own wall. It also decides where the caret goes afterwards: a tree row is found by attribute
   * after the render that redraws it (`refocusFolderRef`), where a card hands itself back through
   * `useFolderFieldReturn`.
   */
  | { kind: "renameFolder"; folderId: number; at: FolderRenameAt }
  /**
   * **There is no `moveFolder` arm, and there must not be one again** (removed 2026-09-08).
   *
   * It existed for one control: the heading row's `Move folder…` button and the `MoveToFolder`
   * popup it anchored. That button is gone — the three folder verbs in the wall's heading row
   * are one `Folder` menu now, and the menu's `Move to` row is a **lazy submenu** whose
   * destination rows `folderMenu.tsx` builds. A submenu is drawn by the menu panel at the app
   * root, not by this view, so there is no layer here for this union to be about: the state it
   * would hold is `ContextMenuProvider`'s, one press deep, and a `Panel` arm beside it would be
   * a flag nothing sets and nothing reads.
   *
   * The two folder verbs that *do* still raise a layer of this view's own are in here — the
   * rename field, which the tree draws in place of a row, and the delete question, which the
   * `Folder` button anchors. A move needs neither, which is the whole distinction: a picker
   * that lives in a menu is not a panel.
   *
   * `CollectionPage` and `WishlistPage` each declare a `moveFolder` arm of their own, in their
   * own files. Those are different unions about different screens, and neither is evidence that
   * this one needs one back.
   */
  /**
   * The delete question, which carries **no folder id — and must not**.
   *
   * It used to, and nothing ever read it: `DecksPage`'s `DeleteFolderConfirm` both names and
   * deletes `openNode.folder.id`, because it is anchored to the heading row's `Folder` control
   * and that control is drawn only for the folder the reader is standing in. A second id in
   * here would be a second source of truth that no code consults — and the day one did, the two
   * could disagree about which folder a delete was aimed at.
   *
   * **Every route into it therefore makes that folder the open one**, and since 2026-09-08 both
   * routes are the same menu: `folderMenuDeps.askDelete` does `setSelectedFolderId(folder.id)`
   * on its way in, whether the menu was opened on a tree row or on the wall's own `Folder`
   * button. That is what puts the wall the sentence is about behind the sentence, and what
   * guarantees there is a button on screen to anchor the panel to.
   */
  | { kind: "deleteFolder" }
  | null;
