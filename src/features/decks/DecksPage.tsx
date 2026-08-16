import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckFolder, type DeckRow } from "@/lib/ipc";
import { writeFailure } from "@/lib/writes";
import { LAYER } from "@/lib/layers";
import { PRESS, statusLine } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { CreateDeckDialog } from "./CreateDeckDialog";
import { DeckTile } from "./DeckTile";
import { type DeckMenuDeps } from "./deckMenu";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { decksUnder, FolderCard } from "./FolderCard";
import { buildFolderMenu, type FolderMenuDeps } from "./folderMenu";
import {
  buildFolderTree,
  flattenFolders,
  folderDescendants,
  FOLDER_ROW_ATTR,
  FolderTree,
  MoveToFolder,
  useDeckDragging,
  type DeckDrag,
  type FolderNaming,
  type FolderNode,
  type FolderRowMenu,
} from "./FolderTree";
import { ImportDeckDialog, type ImportTarget } from "./import/ImportDeckDialog";
import type { Panel } from "./panels";
import { useDeckFolders } from "./useDeckFolders";
import { useDecks, type Decks } from "./useDecks";
import { useNewDeckFormat } from "./useNewDeckFormat";

/** The gallery imports into a deck of its own and never into an existing one — there is no
 *  deck open here to import into. A module constant so the prop keeps one identity across
 *  every render of a view that redraws on every drag. */
const NEW_DECK: ImportTarget = { kind: "new" };

/**
 * The wall.
 *
 * `auto-fill`, not `auto-fit`: with two decks in the gallery `auto-fit` collapses the empty
 * tracks and stretches those two across the whole window, which blows a 626 px art crop up to
 * half a screen. `auto-fill` keeps a tile a tile.
 */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4";

/** The quiet controls in the wall's heading row — everything that is not "New deck". Same
 *  height as it, because a row of controls that disagree about their own size reads as two
 *  rows that happen to be next to each other. {@link PRESS} for the same reason `DeckTile.tsx`'s
 *  `ICON_BUTTON` uses it, and it never greys either, so it carries no out-of-reach clause. */
const HEADING_BUTTON = cn(
  "h-9 rounded-md border border-border bg-surface px-3 text-sm text-dim hover:text-text",
  PRESS,
  FOCUS,
);

/**
 * Scryfall's image policy (spec §5/§10), which is why it is not conditional on there being
 * any art on screen: the credit belongs to the interface that shows card images, and this
 * gallery is one whether or not a deck has picked a cover yet.
 */
const CREDIT = "Card images © Wizards of the Coast · Data © Scryfall";

/**
 * The decks, filed.
 *
 * Two columns: the folders on the left, and on the right the one folder the reader is standing
 * in — its sub-folders as dashed cards, then its decks as the art they were built around. The
 * gallery's whole story is still the covers, so the chrome is a heading, a count, four controls
 * and one credit line.
 */
export function DecksPage() {
  const decks = useDecks();
  const folders = useDeckFolders();
  const { query } = decks;
  /** The gallery's two right-click surfaces — the tile's menu is built in {@link DeckTile}, the
   *  folder row's here, because a row's menu reads writes only this component has. */
  const { menu, menuKey } = useContextMenu();
  /**
   * What format a deck made from this screen starts on — the one the reader last created a deck
   * in, else Commander.
   *
   * **Resolved here rather than inside either dialog, and that is the load-bearing part.** The
   * gallery is mounted long before "New deck" is pressed, so by press time the answer is a real
   * value the dialog can seed its draft with *at mount*. A dialog that read this itself would
   * open on Commander and then have to overwrite the select a beat later — on top of a format
   * the reader may already have picked. It also asks once for the two surfaces that create a
   * deck, and the answer is invalidated for free: the query lives under the `["decks"]` root
   * every `useDecks` mutation invalidates.
   */
  const newDeckFormatKey = useNewDeckFormat();
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const returnToDeckId = useAppStore((s) => s.returnToDeckId);
  const clearReturnToDeck = useAppStore((s) => s.clearReturnToDeck);
  const [panel, setPanel] = useState<Panel>(null);
  /**
   * Which deck the settings dialog is about — **kept after it closes, and that is the point**.
   *
   * `DeckDialog` renders its panel inside an `AnimatePresence`, so an `{open && …}` around the
   * dialog would unmount the surface on the render that closes it and take its exit tween with
   * it (the rule `ImportDeckDialog` is mounted by, one control along). The dialog therefore has
   * to keep a deck id for the length of the fade, while `panel` — which is what says *open* —
   * has already gone back to null.
   */
  const [settingsDeckId, setSettingsDeckId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  /** Which drawer is open. `null` is the top level, which is also where every deck is drawn
   *  when the folder list could not be read. */
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const newDeckRef = useRef<HTMLButtonElement>(null);
  const wallRef = useRef<HTMLElement>(null);
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /**
   * The element a menu was opened on — the opener for every layer that menu's rows raise.
   *
   * **One note for both of this screen's menus**, the tile's and the folder row's: at most one
   * menu is open at a time, and each writes itself here as it opens, so a second ref would be a
   * second thing to keep in step for no fact the first cannot hold.
   *
   * **A menu row has no element of its own, which is the whole reason this exists.** A
   * `MenuAction.onSelect` is a bare callback; the panel keeps the element that was right-clicked
   * private to its own closures, so a row cannot pass an opener down and {@link deckMenuDeps}
   * used to send `null`. That reads as safe — the panel focuses the tile as it closes — and is
   * not, because **every layer on this screen then moves the caret into itself on mount**
   * (`DeleteConfirm`'s effect, `RenameField`'s, `DeckDialog`'s panel). So the panel's hand-back
   * is overwritten a moment later, and `dismiss`'s `openerRef.current?.focus()` — the one thing
   * that puts the caret back on Escape or Cancel — did nothing at all. The panel then unmounted
   * with the caret inside it, which by this file's own rule drops focus to `<body>` and makes the
   * next Tab restart from the top of the app.
   *
   * Written by the tile as its menu is built, read by the deps when a row is chosen: the same
   * shape as {@link openerRef} one level down, because the fact is the same fact.
   */
  const menuOpenerRef = useRef<HTMLButtonElement | null>(null);
  /**
   * The folder row to put the caret back on once the field that replaced it has gone.
   *
   * The opener rule's *reason* rather than its letter. A rename field stands where the row
   * stood, so the row the caret should return to does not exist while the layer is up and is a
   * **different element** when it comes back — `openerRef.current?.focus()` would be a call on
   * a detached node and the caret would land on `<body>`. So the id is remembered and the row
   * is found after the render that redraws it, which is why this is read from an effect and
   * `dismiss` cannot do it inline.
   */
  const refocusFolderRef = useRef<number | null>(null);

  /** The deck in the air, or `null` — what every drawer that could take *it* lights up for. */
  const drag = useDeckDragging();

  const setFolder = decks.setFolder;

  /**
   * The folder a deck is drawn in.
   *
   * A `folderId` naming a folder this list does not carry reads as the root — the same rule
   * `buildFolderTree` uses for a folder whose parent is missing, and the reason a refused
   * folder list still shows every deck the reader has rather than hiding the filed ones behind
   * a tree that never arrived.
   */
  const known = useMemo(() => new Set(folders.folders.map((f) => f.id)), [folders.folders]);
  const folderOf = useCallback(
    (deck: DeckRow) => (deck.folderId !== null && known.has(deck.folderId) ? deck.folderId : null),
    [known],
  );

  const nodes = useMemo(
    () => buildFolderTree(folders.folders, decks.decks),
    [folders.folders, decks.decks],
  );

  const live = useMemo(() => decks.decks.filter((d) => !d.archived), [decks.decks]);
  const archived = useMemo(() => decks.decks.filter((d) => d.archived), [decks.decks]);

  /**
   * The open drawer, resolved against the tree rather than trusted.
   *
   * A folder deleted by this screen or by another surface leaves `selectedFolderId` naming
   * nothing, and this is where that is corrected — by *deriving* the answer instead of writing
   * it back. There is no effect, so there is no render where the heading says a folder that is
   * not there; the stale number simply stops resolving and the reader is at the top level, one
   * click from anywhere.
   */
  const openNode = useMemo(
    () =>
      selectedFolderId === null
        ? null
        : (flattenFolders(nodes).find((n) => n.folder.id === selectedFolderId) ?? null),
    [nodes, selectedFolderId],
  );
  /** The selection as the wall can honour it: the number above, or the root. */
  const folderView = openNode?.folder.id ?? null;
  const childFolders = openNode === null ? nodes : openNode.children;

  const here = useMemo(
    () => live.filter((d) => folderOf(d) === folderView),
    [live, folderOf, folderView],
  );
  const archivedHere = useMemo(
    () => archived.filter((d) => folderOf(d) === folderView),
    [archived, folderOf, folderView],
  );

  /** The deck an editor just closed on, once the wall has read enough to know where it is
   *  filed. `null` while the query is out, and for a deck deleted from inside its own editor. */
  const returningDeck = useMemo(
    () =>
      returnToDeckId === null ? null : (decks.decks.find((d) => d.id === returnToDeckId) ?? null),
    [returnToDeckId, decks.decks],
  );

  /**
   * Coming back from an editor opens the drawer the deck is filed in — because a tile in a
   * folder nobody is standing in is not a tile the caret can be handed back to.
   *
   * A **render-phase** adjustment, which is React's own answer to "change some state when
   * something upstream changes" and not an effect: React throws this render away and restarts
   * it before committing, so the tile exists in the DOM by the time the focus effect below
   * runs — one pass, no flash of the wrong wall, and no cascade for the lint rule to object to.
   * Latched on the deck's id so it happens once per return rather than on every render.
   */
  const [returnedFor, setReturnedFor] = useState<number | null>(null);
  if (returningDeck !== null && returnedFor !== returningDeck.id) {
    setReturnedFor(returningDeck.id);
    setSelectedFolderId(folderOf(returningDeck));
  }

  // Warm the covers this gallery draws, the way `DeckEditor` warms a deck's cards.
  //
  // A card cover is an `art` crop, the same variant the deck builder uses and a different
  // URL on the CDN from the `grid` the search wall warms — so without this every tile on a
  // first visit is a cold fetch, from a plain scroller that mounts them all at once. Custom
  // covers are deliberately not included: they are served from `/cover/<deckId>`, which
  // touches Scryfall not at all and needs no warming.
  const coverKey = (query.data ?? [])
    .map((d) => (d.coverKind === "custom" ? "" : (d.coverCardId ?? "")))
    .filter((id) => id !== "")
    .join(",");
  useEffect(() => {
    if (coverKey === "") return;
    // Fire-and-forget, like every other prefetch: it resolves when the work is queued.
    void ipc.prefetchImages([...new Set(coverKey.split(","))], "art").catch(() => {});
  }, [coverKey]);

  // …and the hand-back itself. It waits for the query rather than running on mount, and it
  // clears the note either way once the answer is in, so a deck deleted from inside its own
  // editor does not leave one pending forever.
  useEffect(() => {
    if (returnToDeckId === null || query.isPending) return;
    wallRef.current
      ?.querySelector<HTMLButtonElement>(`[data-deck-id="${returnToDeckId}"]`)
      ?.focus();
    clearReturnToDeck();
  }, [returnToDeckId, query.isPending, decks.decks, clearReturnToDeck]);

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab
  // restarts from the top of the app.
  //
  // This is the **keyboard** way out — Escape, and the panels' own Cancel controls. The
  // click-away way out is `close` below and is a different function on purpose: CLAUDE.md's
  // rule is that an outside click does *not* hand the caret back, because the reader is
  // already somewhere else, and one function wired to both paths breaks it in two visible
  // ways (a Tab forward out of Cancel bounces backwards, and a control that disables itself
  // mid-write blurs into a hand-back nobody asked for).
  // The rename field is the one layer whose opener is not where the caret should land: it
  // *replaced* the row, so the row is what it comes back to — see {@link refocusFolderRef}.
  const dismiss = useCallback(() => {
    if (panel?.kind === "renameFolder") refocusFolderRef.current = panel.folderId;
    else openerRef.current?.focus();
    setPanel(null);
  }, [panel]);

  // The other end of that, after the render that redraws the row. No deps: a hand-back owed is
  // a hand-back owed on whatever render pays it, and the ref is cleared as it is spent.
  useEffect(() => {
    const id = refocusFolderRef.current;
    if (id === null) return;
    refocusFolderRef.current = null;
    wallRef.current?.querySelector<HTMLButtonElement>(`[${FOLDER_ROW_ATTR}="${id}"]`)?.focus();
  });

  /** The click-away way out: the layer goes, the caret stays where the reader put it. */
  const close = useCallback(() => setPanel(null), []);

  // Every panel on this screen but the three modals. `CreateDeckDialog`, `ImportDeckDialog` and
  // `DeckSettingsDialog` register their own rungs, because each outlives `panel` by the length
  // of its fade and a rung that came up with the *element* would still be consuming Escape
  // while the next layer opened. Two `"inner"` peers are not ordered by this protocol at all,
  // so the one that owns the press has to be the only one that asked for it — hence the
  // exclusion rather than a second registration.
  useDismissOnEscape({
    layer: "inner",
    onDismiss: dismiss,
    enabled:
      panel !== null &&
      panel.kind !== "createDeck" &&
      panel.kind !== "importDeck" &&
      panel.kind !== "deckSettings",
  });

  const openCreate = useCallback(() => {
    // A refusal from the last attempt is not news about this one.
    decks.create.reset();
    openerRef.current = newDeckRef.current;
    // The top level, and deliberately not the drawer the reader happens to be standing in:
    // this control says "New deck" and promises nothing about where, while the folder row's
    // menu says "New deck here" and promises exactly that. Changing this one would move a
    // behaviour nobody asked to have moved.
    setPanel({ kind: "createDeck", folderId: null });
  }, [decks.create]);

  // `null` is a real answer for the opener and not a missing argument: a layer raised from a
  // context menu has no trigger of its own on screen, and the menu hands the caret back to
  // whatever was right-clicked itself.
  const open = useCallback((next: NonNullable<Panel>, opener: HTMLButtonElement | null) => {
    openerRef.current = opener;
    setPanel(next);
  }, []);

  const askDelete = useCallback(
    (deck: DeckRow, opener: HTMLButtonElement | null) =>
      open({ kind: "deleteDeck", deckId: deck.id }, opener),
    [open],
  );

  const askMove = useCallback(
    (deck: DeckRow, opener: HTMLButtonElement) =>
      open({ kind: "moveDeck", deckId: deck.id }, opener),
    [open],
  );

  /**
   * The tile's own rename field, opened on the deck the caret is on.
   *
   * `decks.update.reset()` for `openCreate`'s reason — a refusal from the last attempt is not
   * news about this one. The opener really is the tile: unlike the folder rename, this field is
   * drawn *under* the tile rather than in place of it, so the element the caret comes back to is
   * still mounted the whole time and `openerRef` can serve.
   */
  const startDeckRename = useCallback(
    (deck: DeckRow, opener: HTMLButtonElement | null) => {
      decks.update.reset();
      openerRef.current = opener;
      setPanel({ kind: "renameDeck", deckId: deck.id });
    },
    [decks.update],
  );

  /** The field, answered. One callback for one field, `nameFolder`'s arrangement: which deck a
   *  name belongs to is a fact about the open `Panel`, which this component owns. */
  const renameDeck = useCallback(
    (name: string) => {
      if (panel?.kind !== "renameDeck") return;
      decks.update.mutate({ id: panel.deckId, patch: { name } }, { onSuccess: dismiss });
    },
    [panel, decks.update, dismiss],
  );

  /** Everything about a deck that is not a card in it, over the gallery — without opening the
   *  editor, which is the whole point of hosting the dialog here. */
  const openDeckSettings = useCallback(
    (deckId: number, opener: HTMLButtonElement | null) => {
      setSettingsDeckId(deckId);
      open({ kind: "deckSettings" }, opener);
    },
    [open],
  );

  /**
   * The tile's menu, as data — one object for the whole wall rather than one per tile.
   *
   * **The opener is {@link menuOpenerRef}, read when the row is chosen rather than captured when
   * this object is built** — that is what lets one object serve forty tiles and still hand the
   * caret back to the right one. It is a ref for the same reason it is not a dependency: the
   * value changes on a right-click, and rebuilding the deps then would be rebuilding them for
   * every tile the reader ever right-clicks.
   *
   * `askDelete` is the confirmation and not the delete — see {@link DeckMenuDeps}, which carries
   * no `remove` at all.
   *
   * The two mutations are taken as `mutate` rather than as the mutation objects: `useMutation`
   * answers a fresh object every render and a stable `mutate`, so this memo would otherwise be
   * rebuilt on every render of a wall that redraws on every drag.
   */
  const moveDeck = setFolder.mutate;
  const duplicateDeck = decks.duplicate.mutate;
  const deckMenuDeps = useMemo<DeckMenuDeps>(
    () => ({
      setOpenDeckId,
      startRename: (deck) => startDeckRename(deck, menuOpenerRef.current),
      openSettings: (deckId) => openDeckSettings(deckId, menuOpenerRef.current),
      moveToFolder: (deckId, folderId) => moveDeck({ id: deckId, folderId }),
      duplicate: duplicateDeck,
      askDelete: (deck) => askDelete(deck, menuOpenerRef.current),
    }),
    [setOpenDeckId, startDeckRename, openDeckSettings, moveDeck, duplicateDeck, askDelete],
  );

  const confirmDelete = useCallback(
    (deck: DeckRow) => {
      decks.remove.mutate(deck.id, {
        onSuccess: () => {
          // The tile the caret was on is about to leave with the deck, so the hand-back goes
          // to the one control that is certainly still there.
          openerRef.current = null;
          setPanel(null);
          newDeckRef.current?.focus();
        },
      });
    },
    [decks.remove],
  );

  const onCreated = useCallback(
    (deck: DeckRow) => {
      // Nobody makes a deck in order to look at a tile of it.
      setOpenDeckId(deck.id);
      dismiss();
    },
    [dismiss, setOpenDeckId],
  );

  /** The same thing one door along: a list imported as a deck opens as one. The outcome's
   *  numbers belong to the dialog that was showing them and are not repeated out here. */
  const onImported = useCallback(
    (deckId: number) => {
      setOpenDeckId(deckId);
      dismiss();
    },
    [dismiss, setOpenDeckId],
  );

  /**
   * The tree's one field, answered — whichever of its two jobs it is doing.
   *
   * One callback because there is one field: which write a name becomes is a fact about the
   * open `Panel`, which this component owns, rather than something the tree has to be told
   * twice and then hand back.
   */
  const nameFolder = useCallback(
    (name: string) => {
      if (panel?.kind === "newFolder") {
        folders.create.mutate(
          { parentId: panel.parentId, name },
          {
            onSuccess: (folder) => {
              // Made in order to put something in it: the new drawer is the one the reader is
              // standing in when the field closes.
              setSelectedFolderId(folder.id);
              dismiss();
            },
          },
        );
      } else if (panel?.kind === "renameFolder") {
        folders.rename.mutate({ id: panel.folderId, name }, { onSuccess: dismiss });
      }
    },
    [panel, folders.create, folders.rename, dismiss],
  );

  const fileDeck = useCallback(
    (drag: DeckDrag, folderId: number | null) => setFolder.mutate({ id: drag.deckId, folderId }),
    [setFolder],
  );

  // Back where it already is is not a move: it would write nothing, bump `updated_at` and
  // leave the wall exactly as it was — `dropWrite`'s rule about a card dropped in its own
  // column, one floor up.
  const canFile = useCallback(
    (drag: DeckDrag, folderId: number | null) => {
      const deck = decks.decks.find((d) => d.id === drag.deckId);
      return deck !== undefined && folderOf(deck) !== folderId;
    },
    [decks.decks, folderOf],
  );

  /**
   * Renaming, from either route.
   *
   * `folders.rename.reset()` for `openCreate`'s reason — a refusal from the last attempt is not
   * news about this one — and no opener, because the row the field replaces is what the caret
   * comes back to whichever control started it.
   */
  const startRename = useCallback(
    (folderId: number) => {
      folders.rename.reset();
      openerRef.current = null;
      setPanel({ kind: "renameFolder", folderId });
    },
    [folders.rename],
  );

  /**
   * The folder row's menu, as data — five callbacks, every one of them a write or a layer this
   * screen already has.
   *
   * **Built here rather than in the tree, and that is not only tidiness**: three of these five
   * are things the tree has no way to do (a deck is created by a dialog the gallery hosts, a
   * folder is moved and deleted by writes the gallery owns), and `folderMenu.tsx` reads
   * `folderDescendants` out of `FolderTree.tsx`, so building the menu inside that file would be
   * an import cycle. The tree draws rows; the page says what a row offers.
   *
   * **The opener is {@link menuOpenerRef}, read when a row is chosen rather than captured when
   * this object is built** — the deck tile's arrangement exactly, and for its reason: a
   * `MenuAction.onSelect` is a bare callback with no element behind it, so a layer raised from a
   * menu would otherwise have nothing to hand the caret back to, and every layer on this screen
   * moves the caret into itself on mount. `startRename` is the one that passes no opener, and
   * that is its own rule rather than an omission: the rename field **replaces** the row, so the
   * caret goes back to a row that does not exist yet — `refocusFolderRef` finds it by attribute
   * after the render that redraws it.
   */
  const moveFolder = folders.move.mutate;
  const folderMenuDeps = useMemo<FolderMenuDeps>(
    () => ({
      newDeck: (folderId) => {
        decks.create.reset();
        open({ kind: "createDeck", folderId }, menuOpenerRef.current);
      },
      newSubfolder: (parentId) => {
        folders.create.reset();
        open({ kind: "newFolder", parentId }, menuOpenerRef.current);
      },
      startRename,
      moveFolder: (folderId, parentId) => moveFolder({ id: folderId, parentId }),
      // **The drawer is opened on the way, and the question is asked over it.** The gallery
      // asks this once, in the heading row, about the folder the reader is standing in — so
      // reaching it from a row that is not that folder means standing in that folder. It is
      // also the honest order for a question about what is *inside* something: the wall behind
      // the sentence is then the thing the sentence is about. The confirm names the folder, and
      // its own Cancel and Escape leave the selection where this put it.
      // **The drawer is opened on the way, and this line is required rather than a courtesy.**
      // `DeleteFolderConfirm` both names *and deletes* `openNode.folder.id`, so without it the
      // question would be asked about — and the write aimed at — whichever folder the reader
      // happened to be standing in. It is also the honest order for a question about what is
      // *inside* something: the wall behind the sentence is then the thing the sentence is
      // about. The confirm's own Cancel and Escape leave the selection where this put it.
      askDelete: (folder) => {
        setSelectedFolderId(folder.id);
        open({ kind: "deleteFolder" }, menuOpenerRef.current);
      },
    }),
    [decks.create, folders.create, open, startRename, moveFolder],
  );

  /**
   * One row's pair of handlers. The item list is a **thunk** inside `menu`, so a cabinet of
   * thirty drawers builds no menu until a reader right-clicks one of them.
   *
   * `menuKey` is beside `menu` because the reader chose "open by keyboard, arrows and Escape"
   * over a pointer-only menu — and because this row's own F2 already proves a keyboard reader
   * gets here. The tree composes it with that F2 rather than in its place.
   */
  const folderRowMenu = useCallback(
    (folder: DeckFolder): FolderRowMenu => {
      const build = () => buildFolderMenu(folder, folderMenuDeps);
      return { onContextMenu: menu(build), onKeyDown: menuKey(build) };
    },
    [menu, menuKey, folderMenuDeps],
  );

  /** The tree's one field, as the tree needs to know it. */
  const naming: FolderNaming | null =
    panel?.kind === "newFolder"
      ? { kind: "new", parentId: panel.parentId }
      : panel?.kind === "renameFolder"
        ? { kind: "rename", folderId: panel.folderId }
        : null;

  const failure = query.isError ? ipcError(query.error) : null;
  const status = query.isPending ? "Reading your decks…" : failure;
  // The *latest* write on the screen, not whichever is still holding an error: a refused
  // archive used to leave its banner up while the reader went on to duplicate something
  // successfully, which is an alert about a thing already dealt with (the collection table's
  // lesson). The rule itself is `lib/writes.ts`, shared with the three other surfaces that
  // apply it. The folder writes are in the list because they are writes this screen makes —
  // including the one refusal that is a sentence worth reading, a folder moved into its own
  // descendant.
  const bannerFailure = writeFailure([
    decks.update,
    decks.remove,
    decks.duplicate,
    setFolder,
    folders.create,
    folders.rename,
    folders.move,
    folders.remove,
  ]);
  // **Where the re-read after a refusal comes from, since it is not here.** The editor keeps a
  // `refetch` effect keyed on the newest failure's `submittedAt`; this screen does not, because
  // it would be a second read of a query the refusal has already refetched. Every write in
  // `useDecks` and `useDeckFolders` invalidates the whole `["decks"]` root **on error as well
  // as on success**, and `["decks", "list"]` is an active observer for the life of this
  // component — so a `GONE` from deleting a deck another view already deleted takes the tile
  // off the wall without anything on this screen asking it to. The rule lives on the mutation
  // definitions, which is the one place it can be kept.

  const heading = openNode === null ? "All decks" : openNode.folder.name;
  const counts = [
    childFolders.length > 0 ? plural(childFolders.length, "folder") : null,
    plural(here.length, "deck"),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <section ref={wallRef} className="flex h-full flex-col gap-3">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second "Decks" under it
          would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Decks</h2>

      {/* Grown into place rather than shoved in: the wall and the folder tree below it both
          move by the banner's whole height otherwise. Only `overflow-hidden` on the animated
          wrapper — `statusLine` takes `height` to 0, and under `box-sizing: border-box` a box
          carrying its own padding and border can never be shorter than the two of them. */}
      <AnimatePresence initial={false}>
        {bannerFailure && (
          <motion.div {...statusLine} className="overflow-hidden">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              Could not change your decks — {bannerFailure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1 gap-5">
        <FolderTree
          nodes={nodes}
          totalDecks={live.length}
          selectedId={folderView}
          onSelect={setSelectedFolderId}
          drag={drag}
          canDropIn={canFile}
          onDropIn={fileDeck}
          naming={naming}
          onOpenNew={(parentId, opener) => {
            folders.create.reset();
            open({ kind: "newFolder", parentId }, opener);
          }}
          onOpenRename={startRename}
          onCloseNaming={close}
          onName={nameFolder}
          busy={folders.create.isPending || folders.rename.isPending}
          failure={folders.query.isError ? ipcError(folders.query.error) : null}
          pending={folders.query.isPending}
          rowMenu={folderRowMenu}
          menuOpenerRef={menuOpenerRef}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* A heading, not a caption: the tree's own `h2` is beside it and the wall is the
                other half of the same outline. */}
            <h2 className="font-heading text-xl leading-none">{heading}</h2>
            <span className="font-mono text-[0.7rem] tabular-nums text-dim">{counts}</span>

            <div className="ml-auto flex items-center gap-2">
              {openNode !== null && (
                <>
                  {/* The pointer's route to a rename. The field it opens is in the tree, where
                      the folder is — the trigger is here because a 208px row with an indent, a
                      glyph, a name, a count and a "new folder" control has no width left for a
                      second one, and because this is already where the three things you do
                      *to* a folder live. F2 on the row is the keyboard's shortcut. */}
                  {/* The ellipsis is the row's own convention and it is load-bearing here:
                      each of these three opens something and the thing it opens carries a
                      control named for the write itself ("Rename folder", "Delete folder"). A
                      trigger sharing that name would be two controls with one name on screen at
                      once — which is exactly what a screen reader would have to disambiguate by
                      position. */}
                  <button
                    type="button"
                    onClick={() => startRename(openNode.folder.id)}
                    className={HEADING_BUTTON}
                  >
                    Rename folder…
                  </button>

                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={panel?.kind === "moveFolder"}
                      aria-haspopup="dialog"
                      onClick={(e) =>
                        panel?.kind === "moveFolder"
                          ? dismiss()
                          : open(
                              { kind: "moveFolder", folderId: openNode.folder.id },
                              e.currentTarget,
                            )
                      }
                      className={HEADING_BUTTON}
                    >
                      Move folder…
                    </button>
                    {panel?.kind === "moveFolder" && (
                      <MoveToFolder
                        label={`Move ${openNode.folder.name} into a folder`}
                        nodes={nodes}
                        currentId={openNode.folder.parentId}
                        forbidden={
                          new Set([
                            openNode.folder.id,
                            ...folderDescendants(folders.folders, openNode.folder.id),
                          ])
                        }
                        forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
                        pending={folders.move.isPending}
                        onPick={(parentId) => {
                          folders.move.mutate(
                            { id: openNode.folder.id, parentId },
                            { onSuccess: dismiss },
                          );
                        }}
                        onClose={close}
                      />
                    )}
                  </div>

                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={panel?.kind === "deleteFolder"}
                      aria-haspopup="dialog"
                      onClick={(e) =>
                        panel?.kind === "deleteFolder"
                          ? dismiss()
                          : open({ kind: "deleteFolder" }, e.currentTarget)
                      }
                      className={cn(HEADING_BUTTON, "hover:text-destructive")}
                    >
                      Delete folder…
                    </button>
                    {panel?.kind === "deleteFolder" && (
                      <DeleteFolderConfirm
                        node={openNode}
                        pending={folders.remove.isPending}
                        onConfirm={() =>
                          folders.remove.mutate(openNode.folder.id, {
                            onSuccess: () => {
                              openerRef.current = null;
                              setPanel(null);
                              setSelectedFolderId(openNode.folder.parentId);
                            },
                          })
                        }
                        onCancel={dismiss}
                        onClose={close}
                      />
                    )}
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={(e) => {
                  folders.create.reset();
                  open({ kind: "newFolder", parentId: folderView }, e.currentTarget);
                }}
                className={HEADING_BUTTON}
              >
                New folder
              </button>

              {/* A quiet control beside the primary one: making a deck and importing one are
                  the same act with different starting material, and the gallery has exactly one
                  primary action. Pressed again, it closes what it opened — the row's own
                  convention for every trigger here. */}
              <div>
                <button
                  type="button"
                  aria-expanded={panel?.kind === "importDeck"}
                  aria-haspopup="dialog"
                  onClick={(e) =>
                    panel?.kind === "importDeck"
                      ? dismiss()
                      : open({ kind: "importDeck" }, e.currentTarget)
                  }
                  className={HEADING_BUTTON}
                >
                  Import deck
                </button>
                {/* Rendered always and told whether it is open, so the panel can fade *out*:
                    an `{open && …}` here would unmount the surface on the render that closes
                    it, and take its exit tween with it. */}
                <ImportDeckDialog
                  target={NEW_DECK}
                  // Resolved by this screen and handed down — see {@link useNewDeckFormat}'s
                  // call above. Both surfaces that make a deck take the same answer, so a list
                  // pasted into a new deck starts on the format the reader last built for.
                  defaultFormatKey={newDeckFormatKey}
                  open={panel?.kind === "importDeck"}
                  onDismiss={dismiss}
                  onClose={close}
                  onImported={onImported}
                />
              </div>

              <NewDeck
                buttonRef={newDeckRef}
                // The same answer, resolved once by this screen — see {@link useNewDeckFormat}'s
                // call above. The dialog seeds its draft with it at mount, which it can only do
                // because the value is already real by the time the button is pressed.
                defaultFormatKey={newDeckFormatKey}
                // Where the deck lands, which is a fact about *which control opened this*: the
                // button beside it means the top level, a folder row's "New deck here" means
                // that folder. Read off the open `Panel` for the same reason the format is read
                // off state — the dialog seeds its draft at mount and never again.
                defaultFolderId={panel?.kind === "createDeck" ? panel.folderId : null}
                open={panel?.kind === "createDeck"}
                onOpen={openCreate}
                onDismiss={dismiss}
                onClose={close}
                create={decks.create}
                onCreated={onCreated}
              />
            </div>
          </div>

          {/* Mounted for the life of the view and swapped into: a live region that appears
              together with its own text announces nothing, because there was no change for a
              screen reader to notice. */}
          <p
            role="status"
            className={cn(
              status && "py-16 text-center text-sm",
              failure ? "text-destructive" : "text-dim",
            )}
          >
            {status}
          </p>

          {/* A placeholder, not a pitch. It used to be a paragraph explaining what a deck is and
              what the app would do with one; the affordance was never the words — "New deck" is
              in the heading row above, where it is on every other visit — so the sentence was an
              explanation nobody needed twice. No `max-w-prose`: that width belongs to prose, and
              two words centre themselves. */}
          {!status && decks.decks.length === 0 && (
            <p className="py-16 text-center text-sm text-dim">No decks</p>
          )}

          {!status && decks.decks.length > 0 && childFolders.length === 0 && here.length === 0 && (
            <p className="mx-auto max-w-prose py-12 text-center text-sm text-dim">
              {openNode === null
                ? "Every deck you have is filed in a folder. Open one on the left."
                : `Nothing is filed in ${openNode.folder.name} yet. Drag a deck onto it, or use the Move control on a tile.`}
            </p>
          )}

          {(childFolders.length > 0 || here.length > 0) && (
            // Named, the way the search's wall of art is (`CardGrid`'s `role="group"` +
            // `aria-label`) — but left a list rather than made a group, because these tiles are
            // countable and a list says how many there are on the way in.
            <ul aria-label="Your decks" className={GRID}>
              {childFolders.map((node) => (
                <FolderCard
                  key={node.folder.id}
                  node={node}
                  members={decksUnder(node, live, folderOf)}
                  drag={drag}
                  canDrop={(d) => canFile(d, node.folder.id)}
                  onDropDeck={(d) => fileDeck(d, node.folder.id)}
                  onOpen={setSelectedFolderId}
                />
              ))}
              {here.map((deck) => (
                <DeckTile
                  key={deck.id}
                  deck={deck}
                  decks={decks}
                  nodes={nodes}
                  folderId={folderOf(deck)}
                  panel={panel}
                  moving={setFolder.isPending}
                  onOpen={setOpenDeckId}
                  onAskDelete={askDelete}
                  onAskMove={askMove}
                  onStartRename={startDeckRename}
                  onRename={renameDeck}
                  menuDeps={deckMenuDeps}
                  menuOpenerRef={menuOpenerRef}
                  onMove={(folderId) =>
                    setFolder.mutate({ id: deck.id, folderId }, { onSuccess: dismiss })
                  }
                  onConfirmDelete={confirmDelete}
                  onCancelPanel={dismiss}
                  onClosePanel={close}
                />
              ))}
            </ul>
          )}

          {!status && here.length === 0 && archivedHere.length > 0 && (
            <p className="py-8 text-center text-sm text-dim">
              Nothing here — every deck in this folder is filed away below.
            </p>
          )}

          {archivedHere.length > 0 && (
            <div className={cn(here.length > 0 && "mt-4 border-t border-border pt-4")}>
              {/* A disclosure rather than a second wall: filed decks are kept, not shown. */}
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md text-xs text-dim",
                  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                  FOCUS,
                )}
              >
                {/* The one chevron in this file that is a disclosure's, and the only one that
                    turns. On the app's `fast` tier, off the shared token, so it agrees with
                    the press feedback its own button carries. */}
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform duration-[var(--duration-fast)] ease-standard",
                    "motion-reduce:transition-none",
                    showArchived && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                Archived <span className="font-mono tabular-nums">{archivedHere.length}</span>
              </button>
              {showArchived && (
                <ul aria-label="Archived decks" className={cn(GRID, "mt-3")}>
                  {archivedHere.map((deck) => (
                    <DeckTile
                      key={deck.id}
                      deck={deck}
                      decks={decks}
                      nodes={nodes}
                      folderId={folderOf(deck)}
                      panel={panel}
                      moving={setFolder.isPending}
                      onOpen={setOpenDeckId}
                      onAskDelete={askDelete}
                      onAskMove={askMove}
                      onStartRename={startDeckRename}
                      onRename={renameDeck}
                      menuDeps={deckMenuDeps}
                      menuOpenerRef={menuOpenerRef}
                      onMove={(folderId) =>
                        setFolder.mutate({ id: deck.id, folderId }, { onSuccess: dismiss })
                      }
                      onConfirmDelete={confirmDelete}
                      onCancelPanel={dismiss}
                      onClosePanel={close}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* **The third host of `DeckSettingsDialog`**, and the shape that file was built for:
          `DeckSettingsForm` owns no mutation and imports no hook that reaches the backend, so
          every value and every write arrives as a prop and a host is free to be anywhere. It
          costs this screen nothing while it is shut — `DeckDialog` renders `children` only
          while `open`, so a closed dialog is no `deck_get`, no folder read and no format read —
          which is why it is mounted once out here rather than once per tile.
          Mounted only once a deck has been named, and then for good: see {@link settingsDeckId}
          for why the id outlives the flag. */}
      {settingsDeckId !== null && (
        <DeckSettingsDialog
          deckId={settingsDeckId}
          open={panel?.kind === "deckSettings"}
          onDismiss={dismiss}
          onClose={close}
        />
      )}

      <p className="text-[0.7rem] text-dim">{CREDIT}</p>
    </section>
  );
}

/**
 * The other question, and the one whose answer a reader will guess wrong.
 *
 * **Deleting a folder does not delete the decks in it.** `decks.folder_id` is
 * `ON DELETE SET NULL`, so they surface at the top level, filed nowhere and otherwise exactly
 * as they were. `deck_folders.parent_id` is `ON DELETE CASCADE` on itself, so the folders
 * inside *do* go. The two cascades point opposite ways and the confirmation says both, in that
 * order — the reassuring half first, because the fear is what stops the press.
 */
function DeleteFolderConfirm({
  node,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  node: FolderNode;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const inside = flattenFolders(node.children).length;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Delete ${node.folder.name}`}
      className={cn(
        "absolute right-0 top-9 w-72 rounded-lg border border-border bg-bg/95 p-2",
        "text-xs shadow-lg",
        LAYER.popup,
        FOCUS,
      )}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{node.folder.name}”?</p>
      <p className="mt-1 leading-relaxed text-dim">
        {node.deckCount === 0
          ? "It holds no decks."
          : `The ${plural(node.deckCount, "deck")} in it ${
              node.deckCount === 1 ? "is" : "are"
            } kept — ${node.deckCount === 1 ? "it moves" : "they move"} to the top level.`}
        {inside > 0 &&
          ` The ${plural(inside, "folder")} inside ${inside === 1 ? "goes" : "go"} with it.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            "rounded-md border border-destructive px-2 py-1 text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Delete folder
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The view's one primary action, and the dialog behind it.
 *
 * **The blur dismissal is gone with the anchored form it belonged to.** A popup closes when
 * focus leaves it; a modal does not, because the caret cannot leave — {@link CreateDeckDialog}
 * traps Tab, which is what makes its `aria-modal` true rather than merely claimed. The guard
 * that handler needed (a `Create deck` button disabling itself on the press blurs with no
 * `relatedTarget`, and the form would have closed *as if the write had worked*) is gone with
 * it: there is nothing left to guard.
 *
 * The trigger keeps `aria-haspopup="dialog"` and `aria-expanded`, both of which are now
 * simply true.
 */
function NewDeck({
  buttonRef,
  defaultFormatKey,
  defaultFolderId,
  open,
  onOpen,
  onDismiss,
  onClose,
  create,
  onCreated,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** The format the dialog's draft starts on, resolved by {@link DecksPage} and passed straight
   *  through — this component holds no state of its own and decides nothing about it. */
  defaultFormatKey: string;
  /** The folder it starts in, decided by whichever control opened the dialog — passed straight
   *  through for {@link defaultFormatKey}'s reason. */
  defaultFolderId: number | null;
  open: boolean;
  onOpen: () => void;
  /** Escape, the dialog's ✕ and the trigger pressed a second time: the caret comes back here. */
  onDismiss: () => void;
  /** A press on the scrim: the dialog goes, the caret stays where the reader put it. */
  onClose: () => void;
  create: Decks["create"];
  onCreated: (deck: DeckRow) => void;
}) {
  return (
    <div>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border border-accent px-3 text-sm",
          "text-accent transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <Plus className="size-4" aria-hidden="true" />
        New deck
      </button>
      {/* Rendered always and told whether it is open, so the panel can fade *out*: an
          `{open && …}` here would unmount the surface on the render that closes it, and take
          its exit tween with it. */}
      <CreateDeckDialog
        create={create}
        defaultFormatKey={defaultFormatKey}
        defaultFolderId={defaultFolderId}
        open={open}
        onCreated={onCreated}
        onDismiss={onDismiss}
        onClose={onClose}
      />
    </div>
  );
}
