import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  FolderInput,
  Plus,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { CardImage } from "@/components/CardImage";
import { ART_ASPECT, cardImageUrl, deckCoverUrl } from "@/lib/images";
import { ipc, ipcError, type DeckFolder, type DeckRow } from "@/lib/ipc";
import { writeFailure } from "@/lib/writes";
import { LAYER } from "@/lib/layers";
import { statusLine } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import { CreateDeckDialog } from "./CreateDeckDialog";
import { buildDeckMenu, type DeckMenuDeps } from "./deckMenu";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { buildFolderMenu, type FolderMenuDeps } from "./folderMenu";
import {
  buildFolderTree,
  deckDraggable,
  flattenFolders,
  folderDescendants,
  FOLDER_ROW_ATTR,
  FolderTree,
  MoveToFolder,
  plural,
  useDeckDragging,
  useDeckDropTarget,
  type DeckDrag,
  type FolderNaming,
  type FolderNode,
  type FolderRowMenu,
} from "./FolderTree";
import { ImportDeckDialog, type ImportTarget } from "./import/ImportDeckDialog";
import { RenameField } from "./metaRows";
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

/**
 * Every icon control on a tile, so four of them are one row rather than four sizes.
 *
 * The property list is written out instead of a colour utility beside a transform one: those
 * two compile to the same CSS longhand, tailwind-merge keeps one and drops the other, and what
 * it drops is only visible the moment someone presses the control.
 */
const ICON_BUTTON = cn(
  "grid size-6 place-items-center rounded-md text-dim hover:text-text",
  "transition-[color,background-color,border-color,opacity,transform,scale]",
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.97]",
  "motion-reduce:transition-none",
  FOCUS,
);

/** The quiet controls in the wall's heading row — everything that is not "New deck". Same
 *  height as it, because a row of controls that disagree about their own size reads as two
 *  rows that happen to be next to each other. One property list, for {@link ICON_BUTTON}'s
 *  reason. */
const HEADING_BUTTON = cn(
  "h-9 rounded-md border border-border bg-surface px-3 text-sm text-dim hover:text-text",
  "transition-[color,background-color,border-color,opacity,transform,scale]",
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.97]",
  "motion-reduce:transition-none",
  FOCUS,
);

/**
 * Scryfall's image policy (spec §5/§10), which is why it is not conditional on there being
 * any art on screen: the credit belongs to the interface that shows card images, and this
 * gallery is one whether or not a deck has picked a cover yet.
 */
const CREDIT = "Card images © Wizards of the Coast · Data © Scryfall";

/** How many member covers a folder card shows. Three, because the strip is 96px tall and a
 *  fourth crop at that width is a smear rather than a picture. */
const FOLDER_ARTS = 3;

/**
 * Which of a deck's two lists exist — the one thing a tile can say about a deck that a
 * card count cannot.
 *
 * Derived rather than stored, from the two fields `deck_list` already answers.
 * {@link DeckRow.cardCount} counts the **live** list only, so a deck with theory switched on
 * and nothing live in it is a plan and not yet a deck: `THEORY ONLY`. One derivation, because
 * a badge and the editor's Live/Theory switch must never disagree about which lists a deck has.
 *
 * `THEORY ONLY` is the state **switching the theory list on now produces**, rather than an
 * unusual one: the write moves the live list into the plan and leaves live empty, so the badge
 * reads the deck the way the editor does from that moment.
 */
export type DeckBadge = "LIVE" | "LIVE + THEORY" | "THEORY ONLY";

export function deckBadge(deck: DeckRow): DeckBadge {
  if (!deck.theoryEnabled) return "LIVE";
  return deck.cardCount === 0 ? "THEORY ONLY" : "LIVE + THEORY";
}

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
 */
type Panel =
  /** Where the deck being made will be filed — `null` is the top level, which is what the
   *  heading's own "New deck" has always meant. A folder row's menu passes its folder, because
   *  "New deck **here**" has to be true. */
  | { kind: "createDeck"; folderId: number | null }
  | { kind: "importDeck" }
  | { kind: "deleteDeck"; deckId: number }
  | { kind: "moveDeck"; deckId: number }
  | { kind: "renameDeck"; deckId: number }
  /**
   * The hosted {@link DeckSettingsDialog}, which carries no deck id: the id outlives the flag by
   * the length of the panel's fade, so it is held in `settingsDeckId` beside this. The *flag* is
   * in here for the union's own reason — one layer at a time, structurally, so opening settings
   * over a half-answered delete question replaces it rather than making two Escape peers.
   */
  | { kind: "deckSettings" }
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  /**
   * The delete question, which carries **no folder id — and must not**.
   *
   * It used to, and nothing ever read it: {@link DeleteFolderConfirm} both names and deletes
   * `openNode.folder.id`, because it is anchored to the heading row's own "Delete folder…"
   * control and that control exists only for the folder the reader is standing in. A second id
   * in here would be a second source of truth that no code consults — and the day one did, the
   * two could disagree about which folder a delete was aimed at.
   *
   * Both routes into it therefore make that folder the open one: the heading's control is
   * already about it, and the folder row's menu opens the drawer on its way (see
   * {@link folderMenuDeps}).
   */
  | { kind: "deleteFolder" }
  | null;

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
 * Which of a deck's two covers is showing, as a URL — or `null` when it has neither.
 *
 * **`coverKind` is the one answer, and reading either id instead is the bug this exists to
 * close.** A deck usually carries both at once: `deckSetCoverImage` leaves `coverCardId` alone
 * and picking a card leaves the file on disk, so "has a custom cover" and "is showing one" are
 * different questions. The gallery used to ask only for `coverCardId`, which meant a custom
 * cover was never drawn *anywhere* on this screen — measured in the live window, where the tile
 * said "No cover" while the route answered the file 626×457 in 2 ms.
 *
 * **A card cover this app cannot credit is not drawn at all.** Scryfall's image policy is that
 * an `art` crop, having no printed frame, may be shown only where the illustrator is named — so
 * if the credit cannot be shown, neither can the crop. `DeckRow.coverArtist` is `null` exactly
 * when the printing has left `cards`, and it comes back on the next sync that brings the
 * printing back, so this is a state that heals itself and never a picture permanently withheld.
 * The frame then says "No cover" rather than claiming a failure, because from the reader's side
 * that is what it is: nothing to show yet.
 *
 * **The rule belongs to the card-art arm and must never be moved onto the custom one.** The
 * policy is about *Scryfall's* pictures. A file the reader uploaded is theirs, carries no
 * Scryfall artist, and needs no credit — so a `coverArtist === null` test on that arm would
 * hide every custom cover, and it would read like a missing guard rather than the bug it is.
 *
 * `DeckSettingsDialog`'s `CoverPreview` makes the same two decisions in the same words, which is
 * the point: the gallery and the dialog draw one picture and used to disagree about this exact
 * case. If a third surface ever draws a cover, these four lines want a shared home rather than
 * a third copy.
 */
function coverUrl(deck: DeckRow): string | null {
  if (deck.coverKind === "custom") return deckCoverUrl(deck.id);
  return deck.coverCardId !== null && deck.coverArtist !== null
    ? cardImageUrl(deck.coverCardId, 0, "art")
    : null;
}

/** Every live deck filed in a folder **or in anything under it** — what a folder card draws
 *  its strip of art from, in `deck_list`'s own order (most recently touched first). */
function decksUnder(
  node: FolderNode,
  live: readonly DeckRow[],
  folderOf: (deck: DeckRow) => number | null,
): DeckRow[] {
  const ids = new Set(flattenFolders([node]).map((n) => n.folder.id));
  return live.filter((deck) => {
    const id = folderOf(deck);
    return id !== null && ids.has(id);
  });
}

/**
 * A folder on the wall: what is in it, drawn from the art of the decks it holds.
 *
 * Dashed, where a deck tile is not — and that dash is the screen's one visual rule: **dashed
 * means provisional**. A folder is a container rather than a thing you can play, and a deck
 * that exists only as a theory list is a plan rather than a deck. Both wear it; nothing else
 * does.
 */
function FolderCard({
  node,
  members,
  drag,
  canDrop,
  onDropDeck,
  onOpen,
}: {
  node: FolderNode;
  members: readonly DeckRow[];
  drag: DeckDrag | null;
  canDrop: (drag: DeckDrag) => boolean;
  onDropDeck: (drag: DeckDrag) => void;
  onOpen: (id: number) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const over = useDeckDropTarget({ ref, canDrop, onDrop: onDropDeck });
  const eligible = drag !== null && canDrop(drag);

  // Scryfall's image policy, applied to a strip exactly as it is to a cover: an `art` crop has
  // no printed frame, so a cover this app cannot name an illustrator for is not drawn.
  //
  // **This excludes a custom cover, and that is deliberate — do not "fix" it.** A deck wearing
  // the reader's own picture therefore contributes its *card* art here (or nothing, if it has
  // none), which is a small inconsistency with its own tile and the cheaper of the two
  // mistakes. The strip is a sample of member card art under **one** credit line; letting an
  // uploaded picture in would make that line cover something it cannot speak for, and the
  // alternative — a credit line that names artists for some tiles in the strip and not others —
  // is worse than the inconsistency. Ruled 2026-08-11 rather than left as an oversight.
  const arts = members
    .flatMap((deck) =>
      deck.coverCardId !== null && deck.coverArtist !== null
        ? [{ id: deck.id, cardId: deck.coverCardId, artist: deck.coverArtist }]
        : [],
    )
    .slice(0, FOLDER_ARTS);
  const artists = [...new Set(arts.map((art) => art.artist))].join(", ");

  return (
    <li ref={ref} className={cn("group relative rounded-xl", eligible && DROP_RING)}>
      <button
        type="button"
        // Starts with the visible label, then says the two things the card's marks say — WCAG
        // 2.5.3, and the reason the count is not spliced into the middle of the name.
        aria-label={`${node.folder.name} folder, ${plural(node.deckCount, "deck")}`}
        onClick={() => onOpen(node.folder.id)}
        className={cn(
          "block w-full rounded-xl border border-dashed border-border p-2.5 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          over && cn("border-accent", DROP_OVER),
          FOCUS,
        )}
      >
        <span className="flex h-24 gap-[3px] overflow-hidden rounded-md bg-surface">
          {arts.length === 0 ? (
            <span
              aria-hidden="true"
              className="grid w-full place-items-center text-[0.7rem] text-dim"
            >
              {node.deckCount === 0 ? "Empty" : "No cover art"}
            </span>
          ) : (
            arts.map((art) => <MemberArt key={art.id} cardId={art.cardId} />)
          )}
        </span>
        <span className="mt-2 flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{node.folder.name}</span>
          <span className="flex-none font-mono text-[0.7rem] tabular-nums text-dim">
            {node.deckCount}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-dim">Folder</span>
      </button>

      {/* The price of the crop, per folder card, exactly as it is per tile: an art crop carries
          no printed frame, so every illustrator whose work is on this card is named. */}
      {artists && (
        <p className="mt-0.5 truncate text-[0.7rem] text-dim" title={artists}>
          Art by {artists}
        </p>
      )}
    </li>
  );
}

/** One member cover in a folder card's strip. Its own component because {@link useImageRetry}
 *  is a hook and a strip is a loop. */
function MemberArt({ cardId }: { cardId: string }) {
  const image = useImageRetry(cardImageUrl(cardId, 0, "art"));
  return (
    <span className="min-w-0 flex-1 overflow-hidden bg-surface">
      {image.src && (
        <CardImage
          // Decorative: the folder's name is under it, and the credit is its own line.
          alt=""
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}

/**
 * One deck: its cover art, its name, what it is and how big it is.
 *
 * The art is the tile — an `art` crop rather than a card image, because a wall of full cards
 * is what the *search* looks like and a deck is not a card. The price of the crop is the
 * credit line under it: an art crop carries no printed frame, so the illustrator is named
 * wherever one is shown.
 */
function DeckTile({
  deck,
  decks,
  nodes,
  folderId,
  panel,
  moving,
  onOpen,
  onAskDelete,
  onAskMove,
  onStartRename,
  onRename,
  menuDeps,
  menuOpenerRef,
  onMove,
  onConfirmDelete,
  onCancelPanel,
  onClosePanel,
}: {
  deck: DeckRow;
  decks: Decks;
  nodes: readonly FolderNode[];
  /** The folder it is in now, normalised through the folder list this screen actually has. */
  folderId: number | null;
  panel: Panel;
  moving: boolean;
  onOpen: (id: number) => void;
  onAskDelete: (deck: DeckRow, opener: HTMLButtonElement) => void;
  onAskMove: (deck: DeckRow, opener: HTMLButtonElement) => void;
  /** F2 — and the context menu's "Rename…", which is the pointer's route to the same field. */
  onStartRename: (deck: DeckRow, opener: HTMLButtonElement | null) => void;
  /** The field's own Save. */
  onRename: (name: string) => void;
  /** Everything the tile's right-click menu does that is not the deck. One object for the whole
   *  wall, built by {@link DecksPage} — a menu is data, and `buildDeckMenu` is what turns this
   *  and the deck into rows. */
  menuDeps: DeckMenuDeps;
  /** Where this tile writes itself when its menu opens, so that a layer the menu raises has an
   *  opener to hand the caret back to. See {@link DecksPage}'s `menuOpenerRef`. */
  menuOpenerRef: RefObject<HTMLButtonElement | null>;
  onMove: (folderId: number | null) => void;
  onConfirmDelete: (deck: DeckRow) => void;
  /** Cancel: a control *in* the layer, so the caret goes back to what opened it. */
  onCancelPanel: () => void;
  /** Clicked or tabbed away: the layer goes and the caret stays where it went. */
  onClosePanel: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const { id, name } = deck;
  const { menu, menuKey } = useContextMenu();
  /** This tile's rows, built when the reader right-clicks it and never before — and from **one**
   *  thunk for both doors, so the pointer and the keyboard cannot come to two menus. */
  const build = () => buildDeckMenu(deck, menuDeps);
  const openMenu = menu(build);
  const openMenuByKey = menuKey(build);

  // The gesture half of filing. The whole tile is the handle — the art is the deck — and the
  // controls in the corner mark themselves `data-no-drag` so a press on Delete is a press on
  // Delete rather than the first five pixels of a drag.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return deckDraggable({ element, payload: () => ({ deckId: id, name }) });
  }, [id, name]);

  /** One derivation of the plural, for the caption and the question that quotes it. */
  const unit = deck.cardCount === 1 ? "card" : "cards";
  const badge = deckBadge(deck);
  const confirming = panel?.kind === "deleteDeck" && panel.deckId === deck.id;
  const choosingFolder = panel?.kind === "moveDeck" && panel.deckId === deck.id;
  const renaming = panel?.kind === "renameDeck" && panel.deckId === deck.id;

  return (
    <li ref={ref} className="group relative">
      {/* The art and the caption are one button — a deck is picked by looking at it, and a
          reader who aims at the name should not miss. The controls below are siblings of it
          rather than children: a button inside a button is invalid HTML. */}
      <button
        type="button"
        onClick={() => onOpen(deck.id)}
        // The tile's right-click menu, **on the button rather than on the `<li>`**: the panel
        // hands the caret back to the element the menu was opened on, and an `<li>` cannot take
        // it — `focus()` on a non-focusable node is a no-op, so Escape would drop the reader on
        // `<body>`. It is also the element a `menuKey` (Shift+F10) has to sit on, since only a
        // focusable one receives the press.
        //
        // `build` is a thunk, so a wall of forty tiles builds no menu until one is right-clicked;
        // the handler stops the event itself, so an outer surface offering its own menu never
        // replaces these rows.
        //
        // **The stash is this handler's own line and `e.currentTarget` is this button.** It is
        // written even for a press `menu` then declines (a right-click inside a text field), and
        // that is harmless rather than sloppy: nothing reads the opener until a menu *row* is
        // chosen, which can only follow a menu that opened. Writing it inside the `build` thunk
        // would be exact, and `react-hooks/refs` rejects it — a ref read in a callback handed to
        // a function during render is indistinguishable, to the rule, from a ref read *during*
        // render.
        onContextMenu={(e) => {
          menuOpenerRef.current = e.currentTarget;
          openMenu(e);
        }}
        // **F2 renames the tile the caret is on** — the tree's own key, one floor along
        // (`FolderTree`'s row answers the same press), and the keyboard's route to the field
        // below. A shortcut rather than the only way in: the tile's context menu is the
        // pointer's route to the same field.
        //
        // **Shift+F10 and the ContextMenu key open the same menu the right-click does, and they
        // are composed with F2 rather than put in its place.** The reader chose a menu that
        // opens by keyboard over a pointer-only one, and this is the element the press has to
        // land on for the same reason the right-click is here: an `<li>` cannot take the caret
        // back. A `menuKey` that *replaced* this handler would open a menu and take the rename
        // with it — which the F2 case in this file's suite is what catches.
        //
        // The stash is this handler's own line for the reason the right-click's is, and is
        // written even for a press `menuKey` declines: nothing reads the opener until a menu
        // *row* is chosen, which can only follow a menu that opened.
        onKeyDown={(e) => {
          menuOpenerRef.current = e.currentTarget;
          openMenuByKey(e);
          if (e.defaultPrevented) return;
          if (e.key !== "F2") return;
          e.preventDefault();
          onStartRename(deck, e.currentTarget);
        }}
        // How the caret finds its way back here from an editor: the tile the reader left
        // through is the tile they should return to, and this is the only handle that
        // survives the gallery unmounting while the editor is up.
        data-deck-id={deck.id}
        className={cn("block w-full rounded-lg text-left", FOCUS)}
      >
        <Cover deck={deck} />
        <span className="mt-2 block truncate text-sm">{deck.name}</span>
        <span className="mt-0.5 block truncate text-xs text-dim">
          {deck.formatName ?? deck.formatKey} ·{" "}
          <span className="font-mono tabular-nums">{deck.cardCount}</span> {unit}
        </span>
      </button>

      {/* Which lists this deck has, over its own art. Outside the button rather than in it:
          `aria-label` would otherwise read the badge before the name, and the tile is named
          for its deck. `pointer-events-none` so a corner of the picture is not a dead spot. */}
      <span
        className={cn(
          "pointer-events-none absolute left-1.5 top-1.5 rounded-sm border bg-bg/70 px-1.5",
          "font-mono text-[0.6rem] leading-4 tracking-wide",
          badge === "LIVE" ? "border-border text-dim" : "border-accent text-accent",
          // Dashed means provisional, here as on a folder card: a theory list is a plan.
          badge === "THEORY ONLY" && "border-dashed",
        )}
      >
        {badge}
      </span>

      {/* Scryfall's image policy, per tile — and the plan's ruling: a cover whose artist is
          unknown draws no line at all, never the word "null" and never a placeholder. An
          orphaned cover heals itself on the next sync.

          `coverKind` is in the condition because `coverArtist` is a lookup on `coverCardId`
          and nothing else — the backend's `LEFT JOIN cards c ON c.id = d.cover_card_id`, which
          does not know or care which cover is showing. A deck carrying both (the ordinary case
          after an upload) therefore answers an artist while wearing the reader's own picture,
          and crediting an illustrator whose work is *not on screen* is the one thing this line
          must never do. `DeckSettingsDialog`'s `CoverPreview` guards the same way. */}
      {deck.coverKind === "card_art" && deck.coverArtist && (
        <p className="mt-0.5 truncate text-[0.7rem] text-dim" title={deck.coverArtist}>
          Art by {deck.coverArtist}
        </p>
      )}

      {/* Renaming a deck, in the tile it belongs to.
          **Under the tile rather than in place of it**, which is where the folder tree's field
          stands — and the difference is what the two are standing over. A folder row is a name
          and a count, so a field can replace it whole; a tile is the art the deck was built
          around, and a reader renaming one deck out of forty needs to see which. It also has to
          be a *sibling* of the button: `RenameField` is a `<form>`, and a form inside a button
          is invalid HTML.
          `metaRows.tsx`'s field, not a third rename control — the caret handling in there was
          got wrong twice before it was written down once. `data-no-drag` because the tile is a
          drag handle: without it a press on Save plus five pixels of travel files the deck. */}
      {renaming && (
        <div data-no-drag="">
          <RenameField
            label={`Rename ${deck.name}`}
            initial={deck.name}
            pending={decks.update.isPending}
            onSave={onRename}
            onCancel={onCancelPanel}
          />
        </div>
      )}

      {/* Invisible until the tile is hovered or holds the caret — a wall of art is not a wall
          of buttons — and always in the tab order, because "visible on hover" is not a state a
          keyboard has. Over the art's corner on the app's own felt at 85%, which is the
          quietest thing that can sit on a picture.

          Mounted through the delete question as well, rather than swapped out for it: the
          question hands the caret back to the control that asked it, and a control that
          unmounts on the way up is one that drops focus onto `<body>` on the way down. Focus
          being *inside* the tile is also what keeps this row visible while the question is
          open — `group-focus-within`, the same clause that answers a keyboard. */}
      <div
        className={cn(
          "absolute right-1 top-1 flex gap-0.5 rounded-md bg-bg/85 p-0.5",
          REVEAL_ON_HOVER,
        )}
      >
        <button
          type="button"
          data-no-drag=""
          aria-label={`Move ${deck.name} to a folder`}
          aria-expanded={choosingFolder}
          aria-haspopup="dialog"
          title="Move to a folder"
          onClick={(e) => (choosingFolder ? onCancelPanel() : onAskMove(deck, e.currentTarget))}
          className={ICON_BUTTON}
        >
          <FolderInput className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`Duplicate ${deck.name}`}
          title="Duplicate"
          onClick={() => decks.duplicate.mutate(deck.id)}
          className={ICON_BUTTON}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`${deck.archived ? "Restore" : "Archive"} ${deck.name}`}
          title={deck.archived ? "Restore" : "Archive"}
          onClick={() => decks.update.mutate({ id: deck.id, patch: { archived: !deck.archived } })}
          className={ICON_BUTTON}
        >
          {deck.archived ? (
            <ArchiveRestore className="size-3.5" aria-hidden="true" />
          ) : (
            <Archive className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`Delete ${deck.name}`}
          title="Delete"
          onClick={(e) => onAskDelete(deck, e.currentTarget)}
          className={cn(ICON_BUTTON, "hover:text-destructive")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {choosingFolder && (
        <MoveToFolder
          label={`Move ${deck.name} to a folder`}
          nodes={nodes}
          currentId={folderId}
          pending={moving}
          onPick={onMove}
          onClose={onClosePanel}
        />
      )}

      {confirming && (
        <DeleteConfirm
          deck={deck}
          cards={`${deck.cardCount} ${unit}`}
          pending={decks.remove.isPending}
          onConfirm={() => onConfirmDelete(deck)}
          onCancel={onCancelPanel}
          onClose={onClosePanel}
        />
      )}
    </li>
  );
}

/**
 * What a cover is doing about its image — `CardGrid`'s `Tile`, in the one shape a deck needs.
 *
 * The frame is its own, because the two disagree about what a failure *looks* like: a card
 * tile falls back to the card's own name inside the frame, while a deck tile already has its
 * name in the caption underneath and needs the frame to say what happened instead — and it has
 * a third thing to say, "No cover", which is not a failure at all. What is shared is
 * {@link useImageRetry}: the schedule, and the reason for it. A deck that changes its cover
 * hands this component a different id without remounting it, which is exactly the reset the
 * hook does — and that reset is what lets one frame serve **both** kinds of cover
 * ({@link coverUrl}), because switching a deck from card art to its own picture changes the URL
 * and nothing else.
 *
 * A missing custom file is a **404**, never a placeholder — `images.rs` chose that deliberately
 * so the fault is visible rather than hidden behind a grey rectangle that looks like a picture.
 * It arrives here as an `<img>` error like any other, so it lands in the same three sentences
 * below and never as a broken-image glyph.
 */
function Cover({ deck }: { deck: DeckRow }) {
  const url = coverUrl(deck);
  const image = useImageRetry(url);

  return (
    <span
      className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src ? (
        <CardImage
          // Decorative: the deck's name is in the caption two lines down, and an `alt` here
          // would announce the tile twice.
          alt=""
          // Keyed on the `src` inside {@link CardImage}, which is what makes the note above
          // this component true rather than merely intended: a deck that changes its cover is
          // handed a different id without remounting, and the frame would otherwise keep
          // painting the old cover until the new crop arrived.
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className={cn(
            "size-full object-cover transition-transform duration-150",
            "group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
          )}
        />
      ) : (
        // Says what the empty frame is for rather than leaving a grey rectangle that reads as
        // a rendering fault — and tells "this deck has no cover yet" apart from "the art did
        // not arrive", which are two different things to do something about. Out of the
        // accessible name, which is the deck.
        <span aria-hidden="true" className="text-[0.7rem] text-dim">
          {!url ? "No cover" : image.retrying ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * The one question this view asks before doing something it cannot undo.
 *
 * `deckDelete` really deletes — the deck, its cards and its claims, by cascade — and a deck
 * is minutes of work, so the destructive control asks once, in words, naming what it would
 * take and offering the reversible thing instead.
 */
function DeleteConfirm({
  deck,
  cards,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  deck: DeckRow;
  cards: string;
  pending: boolean;
  onConfirm: () => void;
  /** The Cancel control, which is *in* here: hands the caret back to what opened the layer. */
  onCancel: () => void;
  /** Focus left the layer on its own. Closes and hands nothing back. */
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // The caret moves into the layer, as it does for every other one in the app: the panel's
  // own controls are then the next thing Tab reaches, and Escape has something to hand back.
  // Neither button is focused — the reader has not decided yet, and a stray Enter should not
  // decide for them.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Delete ${deck.name}`}
      data-no-drag=""
      // Anchored to the tile, not portalled: the shipped CSP is `style-src 'self'` and every
      // overlay primitive in reach injects a runtime <style> the moment it opens — fine under
      // `tauri dev`, blank in a packaged build. `SetCombobox`'s decision, for its reason. Not
      // `aria-modal` either: the gallery behind it stays live.
      // `top-8` rather than the tile's own top edge: the actions row stays where it was, so
      // the question reads as having dropped out of the control that asked it — and the
      // control the caret goes back to is still on screen while the reader decides.
      className={cn(
        "absolute inset-x-0 top-8 rounded-lg border border-border bg-bg/95 p-2",
        "text-xs shadow-lg",
        LAYER.popup,
        FOCUS,
      )}
      // Clicking or tabbing away is an answer too, and it is the safe one — `onClose`, not
      // `onCancel`: the reader is already somewhere else, and yanking the caret back to the
      // trash icon would bounce a Tab forward straight backwards.
      //
      // Not while the delete is in flight. `Delete deck` disables itself on the press, a
      // disabled control is blurred by the browser with no `relatedTarget` at all, and this
      // handler would read that as the reader leaving and take the panel down mid-write —
      // so the pending state is never seen and the answer arrives over a question that is
      // no longer on screen.
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{deck.name}”?</p>
      <p className="mt-1 text-dim">
        Its {cards} {deck.cardCount === 1 ? "goes" : "go"} with it. Archiving keeps the deck
        instead.
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
          Delete deck
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
