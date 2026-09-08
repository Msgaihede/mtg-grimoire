import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { ArrowUp, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { atLeast, cardScaleVars, scaled } from "@/lib/cardZoom";
import { plural } from "@/lib/counts";
import { ART_ASPECT } from "@/lib/images";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import { reorderedLevel } from "@/lib/folderOrder";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckFolder, type DeckRow } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { writeFailure } from "@/lib/writes";
import { LAYER } from "@/lib/layers";
import { PRESS, statusLine, TRANSITION } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { useDeskWidth } from "@/lib/useDeskWidth";
import { clearFieldOnEscape, useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { CreateDeckDialog } from "./CreateDeckDialog";
import { deckFormats, filterDecks, NO_DECK_FILTER, type DeckFilter } from "./deckFilter";
import { DeckTile } from "./DeckTile";
import { type DeckMenuDeps } from "./deckMenu";
import {
  DECK_SORT_OPTIONS,
  NATURAL_DESC,
  sortDecks,
  type DeckSort,
  type DeckSortKey,
} from "./deckSort";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { decksUnder, FolderCard, ParentDeckFolderCard } from "./FolderCard";
import { buildFolderMenu, type FolderMenuDeps } from "./folderMenu";
import {
  buildFolderTree,
  flattenFolders,
  folderDescendants,
  FOLDER_ROW_ATTR,
  FolderTree,
  MIN_FOLDER_TREE_WIDTH_PX,
  ROOT_LABEL,
  useDeckDragging,
  type DeckDrag,
  type FolderNaming,
  type FolderNode,
  type FolderRowMenu,
} from "./FolderTree";
import type { ImportDestination } from "@/features/transfer/import/destination";
import { NewDeckPreview } from "@/features/transfer/import/destinations/NewDeckPreview";
import { newDeckDestination } from "@/features/transfer/import/destinations/newDeck";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import type { Panel } from "./panels";
import { bracketLabel, useDeckBrackets } from "./useDeckBrackets";
import { useDeckFolders } from "./useDeckFolders";
import { useDeckPips } from "./useDeckPips";
import { useDecks, type Decks } from "./useDecks";
import { useDeckSort } from "./useDeckSort";
import { useFolderPane } from "./useFolderPane";
import { useFormatSpecs } from "./useFormatSpecs";
import { useNewDeckFormat } from "./useNewDeckFormat";

/**
 * The gallery imports into a deck of its own and never into an existing one — there is no deck
 * open here to import into, so the dialog is handed one destination and draws no destination
 * radios at all.
 *
 * A plain string rather than an `ImportDestination.Subtitle`, and that is the distinction the
 * two slots exist to draw: the deck destination's line names a deck and needs a `deck_get`, this
 * one names nothing at all, because the deck it is about does not exist yet.
 */
const NEW_DECK_SUBTITLE = "Paste a list or choose a file, and it becomes a deck of its own.";

/**
 * A tile's narrowest track, in px, at 100% zoom — the number the reader's gesture multiplies.
 *
 * A constant rather than a class because it is arithmetic now: {@link wallStyle} builds the
 * track out of it, and the tiles the track sizes carry the same zoom in their own type and
 * marks. It is deliberately not spelled as a Tailwind arbitrary value anywhere in this file,
 * comments included — this file is under Tailwind's `@source`, so writing one would go on
 * emitting a rule for a utility nothing uses.
 */
const TILE_MIN_WIDTH = 200;

/** The gutter between tiles at 100% zoom (`gap-4`'s 16px), floored by {@link atLeast}. */
const TILE_GAP = 16;

/**
 * The "All decks" row as {@link reorderedLevel} has to address it.
 *
 * That function takes the folder the pointer is over, and the root row is not one — it is the
 * level itself. `deck_folders.id` is an `INTEGER PRIMARY KEY`, so every real folder id is
 * positive and this addresses none of them, which keeps the `dragged === target` guard answering
 * *no* rather than answering by luck. It is only ever passed for an `inside` drop, which is the
 * one landing `reorderedLevel` ignores its `target` for; {@link DecksPage}'s `folderLanding`
 * refuses the other two on the root before it gets this far.
 *
 * **So the root's positional refusal is stated twice, and that is worth knowing before either
 * copy is tidied away.** `folderLanding`'s early return is the one that says *why*; this sentinel
 * would refuse the same drop on its own, because an id no level carries takes `reorderedLevel`'s
 * "the target has left the level" branch. Measured by mutation: removing either alone leaves
 * `takes no positional drop on the All decks row` green, and removing both turns it red.
 */
const ROOT_TARGET = 0;

/**
 * The wall — everything about it that is not a function of the zoom.
 *
 * The two tracks-and-gutter properties moved to {@link wallStyle} when the gallery learnt to
 * zoom; what is left here is the display mode, which is the same at every size.
 */
const GRID = "grid";

/**
 * The wall's tracks and gutter at `zoom`.
 *
 * `auto-fill`, not `auto-fit`: with two decks in the gallery `auto-fit` collapses the empty
 * tracks and stretches those two across the whole window, which blows a 626 px art crop up to
 * half a screen. `auto-fill` keeps a tile a tile — and it is what makes the zoom read as *more
 * decks on screen* rather than as bigger boxes, because the column count is what falls out of a
 * track the reader has resized.
 *
 * The gutter takes {@link atLeast} rather than {@link scaled}: it is the one measurement here
 * that sits **between** tiles rather than **on** one, and halving it at 0.5× is exactly the zoom
 * a reader chose in order to see more decks at once.
 */
function wallStyle(zoom: number): CSSProperties {
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(${scaled(TILE_MIN_WIDTH, zoom)}px, 1fr))`,
    gap: atLeast(TILE_GAP, zoom),
  };
}

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
 * The two ids the filter row's controls are addressed by, spelled once.
 *
 * **A fixed stem rather than `FilterBar`'s `idStem` prop, and the difference is how many of each
 * row can be mounted.** That component is drawn on five surfaces and twice at once in the deck
 * editor, so its ids have to be parameterised or two boxes end up sharing one `id` and a
 * `getByLabelText` cannot tell them apart. This row is `DecksPage`'s alone, and `DecksPage` is
 * one view of the app — there is no second gallery to collide with.
 */
const FILTER_FIELD_ID = "deck-gallery-filter";
const SORT_ID = "deck-gallery-sort";

/**
 * The sort picker's rows, in the order it offers them.
 *
 * **Through {@link sortOptions}, which is `src/lib/options.ts`' app-wide rule**: alphabetical by
 * the words on screen, so a reader looking for `Name` looks under N rather than wherever the
 * array happens to read. {@link DECK_SORT_OPTIONS} says so at its own site and is deliberately
 * written in an order that explains the sorts instead — so this is where the display decision is
 * made, and a seventh key appended there needs no thought about where it appears.
 *
 * Module level because the input is a constant: a `useMemo` would be a dependency array around
 * an array that cannot change.
 */
const SORT_ROWS: readonly DropdownOption[] = sortOptions(DECK_SORT_OPTIONS, (o) => o.label).map(
  (o) => ({ value: o.value, label: o.label }),
);

/**
 * What the direction toggle is called, and it names the press rather than the state alone.
 *
 * `FilterBar.tsx`'s `sortDirectionName` verbatim but for its first arm: that row's sort can be
 * `Best match`, which has no direction at all and greys the button. A gallery is always in one of
 * six orders and every one of them has two ways round, so there is no third case here and no
 * `unavailable` treatment to draw.
 */
function sortDirectionName(desc: boolean): string {
  return desc
    ? "Sort direction: descending — press for ascending"
    : "Sort direction: ascending — press for descending";
}

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
  /**
   * The gallery's right-click surfaces — the tile's menu is built in {@link DeckTile}, the
   * folder row's here, because a row's menu reads writes only this component has.
   *
   * **`menuClick` is the third door and it is not a right-click at all**: the wall's heading row
   * has one `Folder` control whose entire job is to open that same folder menu, and a button
   * reached by Tab fires a `click` carrying no coordinates. `menuClick` anchors under the
   * pointer for a press that had one and at the button's own bottom-left for a press that did
   * not, which is the failure its doc comment was written to prevent.
   */
  const { menu, menuKey, menuClick } = useContextMenu();
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
  /**
   * How the wall is ordered — **and this half is remembered**, in one `app_meta` row, the way
   * the list layouts are. See {@link filter} for why its neighbour is not.
   */
  const { sort, setSort } = useDeckSort();
  /**
   * Every deck's printed pips, in one read for the whole gallery.
   *
   * One query rather than one per tile, for the reason the zoom is one store read handed down: a
   * folder of forty decks would otherwise be forty subscriptions and forty round trips for a
   * fact the backend can fold in a single statement (90 rows for the whole dev database).
   */
  const { byDeck: pipsByDeck } = useDeckPips();
  /**
   * Which decks even *have* a bracket, and it is a question about the **format** rather than
   * about the deck — `format_specs.commander_rule`, which is the same cell the editor's own
   * bracket button is fenced on.
   *
   * **The array is the whole of the read's cost, so a gallery with no Commander deck must build
   * an empty one rather than every id.** {@link useDeckBrackets} is `enabled`-gated on its
   * length, so an empty list is *no IPC call at all* — a reader whose decks are all Modern pays
   * nothing for a control they will never see.
   *
   * It is every deck in the gallery and not only the ones on the wall, which costs one read and
   * buys two things: walking into a folder or opening the filed wall asks nothing new, and the
   * `bracket` sort can order *any* wall the moment it is picked rather than after a round trip.
   *
   * `formatSpecFor` rather than a map read out of the hook: {@link useFormatSpecs} exposes the
   * lookup and keeps the map private, and the lookup is a `useCallback` over it, so this memo is
   * as stable as the table is (`staleTime: Infinity` — it changes once per app version).
   */
  const { formatSpecFor } = useFormatSpecs();
  const commanderDeckIds = useMemo(
    () =>
      decks.decks
        .filter((d) => formatSpecFor(d.formatKey)?.commanderRule != null)
        .map((d) => d.id),
    [decks.decks, formatSpecFor],
  );
  const { floorByDeck } = useDeckBrackets(commanderDeckIds);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const returnToDeckId = useAppStore((s) => s.returnToDeckId);
  const clearReturnToDeck = useAppStore((s) => s.clearReturnToDeck);
  const [panel, setPanel] = useState<Panel>(null);
  /**
   * Which deck the settings dialog is about — **kept after it closes, and that is the point**.
   *
   * `Dialog` renders its panel inside an `AnimatePresence`, so an `{open && …}` around the
   * dialog would unmount the surface on the render that closes it and take its exit tween with
   * it (the rule `ImportDialog` is mounted by, one control along). The dialog therefore has
   * to keep a deck id for the length of the fade, while `panel` — which is what says *open* —
   * has already gone back to null.
   */
  const [settingsDeckId, setSettingsDeckId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  /**
   * How the wall is narrowed — **and it is deliberately not remembered.**
   *
   * The sort is an `app_meta` row and survives a restart ({@link useDeckSort}); this is
   * `useState` and does not, which is the plan's ruling and worth the sentence it costs. A filter
   * is a thing a reader is doing *right now*: a gallery that opened already narrowed, with no
   * memory of having asked for it, is a gallery that looks like it has lost decks — and the one
   * screen least able to explain that is the one whose whole content is the missing tiles.
   *
   * It **does** survive walking into a folder, which is the other half of the same argument: the
   * text is still in the box the reader typed it into, one glance above the wall it is narrowing,
   * so nothing about the state is hidden from them.
   */
  const [filter, setFilter] = useState<DeckFilter>(NO_DECK_FILTER);
  /** Which drawer is open. `null` is the top level, which is also where every deck is drawn
   *  when the folder list could not be read. */
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const newDeckRef = useRef<HTMLButtonElement>(null);
  const wallRef = useRef<HTMLElement>(null);
  /**
   * The scroller the tiles are drawn in — the right-hand column, and the element the zoom
   * gesture is attached to.
   *
   * Deliberately **not** {@link wallRef}, which is the whole view: a ctrl+wheel over the folder
   * tree is not a request to resize a wall the reader is not pointing at, and a tree row draws
   * nothing that scales — it is navigation chrome, and the reader sizes it by pulling its edge
   * rather than by rolling a wheel over it. It is the same rule `GridView` follows one floor down
   * — the listener goes on the thing that scrolls, because a wheel over the gap between two tiles
   * belongs to the scroller and not to either of them.
   */
  const tilesRef = useRef<HTMLDivElement>(null);
  /**
   * The desk row the tree and the wall share — measured, so the tree knows how far it may be
   * dragged and whether there is room to draw it open at all.
   *
   * The row itself rather than {@link wallRef}: the section above it carries the heading and the
   * failure banner, so the whole view is not the box the two columns are divided out of.
   */
  const deskRef = useRef<HTMLDivElement>(null);
  /**
   * How large the reader draws a deck, out of the one store the app keeps sizes in.
   *
   * **One read for the whole wall, handed down** rather than read inside each tile: a folder of
   * forty decks is forty `DeckTile`s, and forty subscriptions to one number they all share is a
   * re-render each per notch of a gesture that produces dozens.
   *
   * `deckGallery`, which is **not** the `deck` the editor's cards are drawn at. The two walls are
   * never on screen together, and that is not the argument — the argument is that they are
   * different questions: how many decks do I want to see at once, against how large is one deck's
   * cards laid out. A reader who sized the editor for a 100-card pile did not ask for four deck
   * tiles across the gallery.
   */
  const zoom = useAppStore((s) => s.cardZoom.deckGallery);
  // Ctrl+wheel, through the hook rather than an `onWheel` prop: React registers `wheel` as a
  // passive listener, and a passive listener's `preventDefault` does nothing — so without this
  // WebView2 would apply its own page zoom on top of the wall's, scaling the sidebar, the ribbon
  // and the title bar out from under a reader who asked one wall of decks to get bigger.
  useCardZoomGesture(tilesRef, "deckGallery");
  /**
   * How wide the folder tree is and whether the reader has railed it — one `app_meta` row, held
   * by the page because it is remembered rather than by the tree because it is drawn.
   *
   * The pair is `useSearchOpen`'s argument one page over: a width and a collapse are two answers
   * to one question — how much of this row do I want spent on navigation — and a component that
   * held either would be a component that had to know where it was stored.
   */
  const { width, collapsed, setWidth, setCollapsed } = useFolderPane();
  /**
   * What the desk row can spare, and whether it can spare anything at all.
   *
   * **The floor is one deck tile at the reader's own zoom**, which is the honest number rather
   * than a constant: the wall is `auto-fill` over `scaled(TILE_MIN_WIDTH, zoom)` tracks, so a
   * width below one track is a wall drawing a tile narrower than the reader asked for — and a
   * reader who has zoomed *out* to fit more decks on screen has bought the tree room to be wide
   * in the same gesture. `gap: 20` is this row's own `gap-5`, told to the hook rather than
   * assumed by it, because the two search columns it was written for are `gap-4`.
   *
   * **`overWidth` is deliberately ignored.** That is the phone arrangement — the search column
   * drawn *over* the list where the row cannot hold both — and this column does not do it: a
   * filing cabinet laid over the wall of decks it files would cover the thing it is for, so a row
   * too narrow for both rails the tree instead and the wall keeps every pixel.
   */
  const { maxPanelWidth, roomy } = useDeskWidth(deskRef, scaled(TILE_MIN_WIDTH, zoom), {
    gap: 20,
    min: MIN_FOLDER_TREE_WIDTH_PX,
  });
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
   * (`DeleteConfirm`'s effect, `RenameField`'s, `Dialog`'s panel). So the panel's hand-back
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
   *
   * **Two writers now, and the second is the same fact rather than a borrowed slot**
   * ({@link upOneFolder}): Escape walking up a level lands the caret on the row of the folder it
   * just left, and a *keypress* has no element behind it at all — `openerRef` is written by a
   * control that was pressed, and this one was not. An id resolved after the render is the only
   * thing either case can say, which is why it is one note rather than two. `null` still means
   * nothing is owed; there is no id for "All decks", which is the tree's root and not a folder,
   * and no press of either kind ever asks for one.
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

  /**
   * The two walls as they are actually drawn: **the drawer, then the filter, then the sort.**
   *
   * The plan states the order as filter-then-sort and it is the half that matters — sorting a
   * list and then throwing rows out of it is the same list in the same order and strictly more
   * work. The folder split leads because {@link here} and {@link archivedHere} have three other
   * readers that must never see a narrowed list: the heading's count, the format chips, and the
   * empty-state sentences that say a *drawer* is empty rather than a filter is.
   *
   * **The folder cards are not in here at all.** A filter narrows the wall you are looking at; a
   * tree that lost its branches would take away the way out of it, so the sub-folder cards, the
   * `ParentDeckFolderCard` and the sidebar are drawn from the unfiltered tree exactly as before.
   */
  const sortContext = useMemo(
    () => ({ pips: pipsByDeck, brackets: floorByDeck }),
    [pipsByDeck, floorByDeck],
  );
  const shown = useMemo(
    () => sortDecks(filterDecks(here, filter), sort, sortContext),
    [here, filter, sort, sortContext],
  );
  const shownArchived = useMemo(
    () => sortDecks(filterDecks(archivedHere, filter), sort, sortContext),
    [archivedHere, filter, sort, sortContext],
  );

  /**
   * The format chips, one per format actually present among the decks **on the wall**.
   *
   * Built from the drawer's *live* decks and not from the whole gallery, because a chip is only
   * ever useful about the wall it sits above — a `Pauper` chip in a drawer holding no Pauper deck
   * is a control whose only outcome is an empty wall. The filed decks are left out for the same
   * reason and it is the weaker half of the argument: they are behind a shut disclosure, so a
   * chip that existed only for them would empty the wall the reader can see in exchange for
   * narrowing one they cannot.
   *
   * Unfiltered on purpose — the chips are what the reader picks *between*, so a set that
   * reflowed as they typed would move the control out from under the pointer reaching for it.
   * That is `features/search/facets.ts`' rule (an option that vanishes reads as a control that
   * broke) applied to a row that has nothing to grey.
   *
   * The order is {@link deckFormats}' own and is not re-applied here: that function ends in
   * `sortOptions`, so the chips already read alphabetically by the words on them. A second sort
   * at this call site would be one more place for the app's option-list rule to be spelled, and
   * `src/lib/options.ts` is emphatic that there is exactly one.
   */
  const formats = useMemo(() => deckFormats(here), [here]);

  /**
   * Whether anything is narrowing the wall — the one thing the empty sentence below is allowed
   * to claim.
   *
   * Read off the filter rather than off the two lengths, because the lengths agree in one case
   * this must not swallow: a format chip pressed on a drawer where every deck is that format
   * narrows nothing and is still a filter that is on.
   */
  const filtering = filter.query.trim() !== "" || filter.formats.length > 0;

  const setFilterQuery = useCallback(
    (query: string) => setFilter((f) => ({ ...f, query })),
    [],
  );
  /** Multi-select: an empty selection is *no format filter*, never an empty gallery — which is
   *  the whole of why this toggles a list rather than setting a single key. */
  const toggleFormat = useCallback((key: string) => {
    setFilter((f) => ({
      ...f,
      formats: f.formats.includes(key)
        ? f.formats.filter((k) => k !== key)
        : [...f.formats, key],
    }));
  }, []);

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
  // first visit is a cold fetch, from a plain scroller that mounts them all at once.
  //
  // **`coverKind` is not consulted, and used to be.** It skipped `custom` rows, because those
  // were served from a `/cover/<deckId>` route that touched Scryfall not at all. That route is
  // gone and so is the picture behind it: a row still carrying the retired word now draws its
  // `coverCardId`'s art like every other, so it is exactly what wants warming. Reading the
  // column here would skip the one tile whose art is not yet in the cache.
  const coverKey = (query.data ?? [])
    .map((d) => d.coverCardId ?? "")
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

  // Every panel on this screen but the three modals. `CreateDeckDialog`, `ImportDialog` and
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

  /**
   * **Escape's floor on this screen: one folder level up.**
   *
   * `"navigation"` is the bottom rung, so this fires only on a press nothing nearer wanted —
   * every panel above is `"inner"` and takes its own press first, and the card pane a reader may
   * have open beside this wall is `"outer"` and outranks this. One press closes one thing.
   *
   * **`openNode`, never `selectedFolderId`.** A folder deleted by another surface leaves that
   * number naming nothing, and this screen's whole answer to a stale id is to *derive* it away —
   * see {@link openNode}. Reading the id here instead would mean asking a tree that no longer
   * holds it for a `parentId`, which is a throw where the reader can already see themselves at
   * the top level. `openNode` is the resolved answer, so "up" from a folder that has gone is the
   * root, which is where the wall already is.
   *
   * **`enabled` is the same test, and that is what makes "All decks" quiet.** At the root there
   * is nowhere above to go, so the rung is not registered at all and the press is neither
   * consumed nor `preventDefault`ed — it falls through to whatever the app puts below this,
   * exactly as it did before this existed. A rung that registered and did nothing would swallow
   * the press and look identical on screen.
   *
   * **The caret follows, onto the row of the folder being left** — which is the row that opened
   * it, so this is the app's "Escape hands the caret to the opener" rule at the navigation rung,
   * and it is the same hand-back the editor makes when it closes onto the deck's own tile. The
   * tree draws every folder flat, so that row is on screen at the new level too; {@link
   * refocusFolderRef} and the effect above are the mechanism, unchanged.
   */
  const upOneFolder = useCallback(() => {
    if (openNode === null) return;
    refocusFolderRef.current = openNode.folder.id;
    setSelectedFolderId(openNode.folder.parentId);
  }, [openNode]);
  useDismissOnEscape({ layer: "navigation", onDismiss: upOneFolder, enabled: openNode !== null });

  const openCreate = useCallback(() => {
    // A refusal from the last attempt is not news about this one.
    decks.create.reset();
    openerRef.current = newDeckRef.current;
    // **The drawer the reader is standing in, and it was the top level whatever was open until
    // 2026-09-01** ([#332](https://github.com/Msgaihede/mtg-grimoire/issues/332)). The rule this
    // reverses read: the control says "New deck" and promises nothing about where, while the
    // folder row's menu says "New deck here" and promises exactly that — true about the *words*
    // and wrong about the *act*. This button is drawn in the heading row of the folder whose
    // name is set in type beside it, over a wall showing that folder's decks and nothing else,
    // so a press there is a reader filing a deck where they already are. Making it at the root
    // meant every such deck had to be moved afterwards, which is the thing that was reported.
    //
    // **A default and not a destination**, which is what keeps the button's old promise intact
    // rather than trading it away: the form's own Folder select opens on this and offers every
    // other drawer, so a reader browsing one folder and building for another says so in one
    // press. The folder row's menu is untouched and still means exactly what it says.
    //
    // **`folderView` rather than `selectedFolderId`**, for {@link upOneFolder}'s reason: a
    // folder deleted by another surface leaves that number naming nothing, and this screen's
    // answer to a stale id is to *derive* it away rather than write it back. `folderView` is
    // that resolved answer, so the deck is made where the reader can **see** they are — the top
    // level in that case, which is where the wall already put them.
    setPanel({ kind: "createDeck", folderId: folderView });
  }, [decks.create, folderView]);

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
   *  numbers belong to the dialog that was showing them and are not repeated out here — and
   *  closing is `ImportDialog`'s `onDone`, which fires alongside this. */
  const onImported = useCallback(
    (deckId: number) => {
      setOpenDeckId(deckId);
    },
    [setOpenDeckId],
  );

  /**
   * The gallery's one import destination: a deck this list is about to become.
   *
   * The wrapper is where the two facts only this screen has are closed over — the format the
   * reader last built for (see {@link useNewDeckFormat}'s call above; both surfaces that make a
   * deck take the same answer, so a list pasted into a new deck starts where the gallery's own
   * dialog would) and where to go once it exists. **Memoised because `Preview` is a component
   * identity**: a new one each render would remount the preview step and take the name the
   * reader had typed with it.
   */
  const importIntoNewDeck = useMemo<ImportDestination>(
    () => ({
      ...newDeckDestination,
      Preview: (props) => (
        <NewDeckPreview {...props} defaultFormatKey={newDeckFormatKey} onImported={onImported} />
      ),
    }),
    [newDeckFormatKey, onImported],
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
   * The cabinet as **levels** — each level's ids in the order they are drawn, and which level
   * each folder sits in.
   *
   * Walked off `nodes` rather than read off `folders.folders`, and the two genuinely differ:
   * `buildFolderTree` resolves a folder whose parent is missing, and a folder caught in a corrupt
   * cycle, **to the root** — so a row's stored `parentId` can name a level that is nowhere on
   * screen. A drop is a gesture made against what the reader can see, so the level a folder is
   * placed in has to be the one it is drawn in. The order is the tree's own (`sortOrder`, then
   * name, then id), which is what {@link reorderedLevel} means by "their current order" and what
   * the backend writes back as `sort_order`.
   */
  const levels = useMemo(() => {
    const ids = new Map<number | null, number[]>();
    const parent = new Map<number, number | null>();
    const walk = (level: readonly FolderNode[], parentId: number | null) => {
      ids.set(
        parentId,
        level.map((n) => n.folder.id),
      );
      for (const node of level) {
        parent.set(node.folder.id, parentId);
        walk(node.children, node.folder.id);
      }
    };
    walk(nodes, null);
    return { ids, parent };
  }, [nodes]);

  /**
   * The level **above** the folder that is open, and what to call it — `null` and {@link
   * ROOT_LABEL} when the open folder sits at the top level, and the whole thing is absent when
   * nothing is open, because the root has nowhere above it.
   *
   * **Read out of {@link levels}, never off `openNode.folder.parentId`.** The two differ in
   * exactly the case that map was built for: `buildFolderTree` draws a folder whose parent is
   * missing — and one caught in a corrupt cycle — at the **root**, so a stored `parentId` can
   * name a level that is nowhere on screen. The tile is a gesture made against what the reader
   * can see, so it climbs to the level the folder is *drawn* in, which is where the sidebar's
   * tree would take them too.
   */
  const up = useMemo(() => {
    if (openNode === null) return null;
    const id = levels.parent.get(openNode.folder.id) ?? null;
    const label =
      id === null
        ? ROOT_LABEL
        : (flattenFolders(nodes).find((n) => n.folder.id === id)?.folder.name ?? ROOT_LABEL);
    return { id, label };
  }, [openNode, levels, nodes]);

  /**
   * What a folder drop **means**: the level it lands in, and that level's ids in their new order —
   * or `null` for a drop that may not happen or would change nothing.
   *
   * One function for the question and the write, so a mark can never promise a write that will
   * fail: `canDropFolder` is this answering non-`null` and {@link dropFolder} is this answering
   * and then sending it. A ring drawn off one rule and a write made by another is two rules to
   * keep in step, and the drag asks the question dozens of times per gesture.
   *
   * Three refusals, in the order they are cheapest to make.
   *
   * **The root row takes only a nest** — `folderId` is `null` for "All decks", and the tree says
   * at its own call site what that row offers and why.
   *
   * **A folder may not go inside itself or inside anything it holds.** The backend refuses this in
   * words (`FOLDER_CYCLE`) and that refusal is a fence rather than the affordance: `parent_id` is
   * `ON DELETE CASCADE` on itself, so a cycle is a graph SQLite would walk forever the day the
   * folder is deleted. It is asked about the **destination parent**, which is what catches the
   * case the obvious spelling misses: dropping a folder *beside* one of its own grandchildren
   * would file it under its own child, and neither the target nor the dragged folder is the
   * cycle — the level is.
   *
   * **A nest into the drawer it is already in is nothing to do.** `inside` says which drawer and
   * nothing about where in it, so a folder already there has nowhere to arrive; this is the
   * refusal `FolderDrag.parentId` travels for, and it is what keeps a folder's own parent from
   * drawing a mark that would move it to the end of a level it is already in.
   *
   * And last, {@link reorderedLevel}'s own `null`: dropped on itself, or landing exactly where it
   * already sits. A write for one of those would bump `updated_at` and re-read the tree to arrive
   * at the list already on screen.
   */
  const folderLanding = useCallback(
    (
      drag: FolderDrag,
      folderId: number | null,
      edge: FolderEdge,
    ): { parentId: number | null; ids: number[] } | null => {
      if (folderId === null && edge !== "inside") return null;
      // `inside` files it in the target; `before`/`after` file it in the level the target sits
      // in, which is the level it is *drawn* in rather than the one its own `parentId` names.
      const parentId =
        folderId === null
          ? null
          : edge === "inside"
            ? folderId
            : (levels.parent.get(folderId) ?? null);
      const under = folderDescendants(folders.folders, drag.folderId);
      if (parentId !== null && (parentId === drag.folderId || under.has(parentId))) return null;
      if (edge === "inside" && drag.parentId === parentId) return null;
      const ids = reorderedLevel({
        siblings: levels.ids.get(parentId) ?? [],
        dragged: drag.folderId,
        target: folderId ?? ROOT_TARGET,
        edge,
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [levels, folders.folders],
  );

  const canDropFolder = useCallback(
    (drag: FolderDrag, folderId: number | null, edge: FolderEdge) =>
      folderLanding(drag, folderId, edge) !== null,
    [folderLanding],
  );

  /**
   * The write. One command places the **whole level** — `sort_order` from each id's position and
   * `parent_id` from the argument, in one transaction — so a drag that re-parents *and* places is
   * never seen half done. A refused landing writes nothing at all rather than sending the folder
   * somewhere the reader was not shown.
   */
  const reorderFolders = folders.reorder.mutate;
  const dropFolder = useCallback(
    (drag: FolderDrag, folderId: number | null, edge: FolderEdge) => {
      const landing = folderLanding(drag, folderId, edge);
      if (landing !== null) reorderFolders(landing);
    },
    [folderLanding, reorderFolders],
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

  /**
   * The heading row's `Folder` control — **the same menu, from the same builder, opened by a
   * plain press.**
   *
   * The wall's heading row used to carry three trigger buttons: `Rename folder…`, `Move
   * folder…` with an inline `MoveToFolder` popup, and `Delete folder…` with the delete
   * question. Every one of those writes was already on the folder's own row menu one column to
   * the left, so the screen spelled one vocabulary twice — and the two spellings did not even
   * agree: the row menu offers `New deck here` and `New subfolder…` as well, so the folder a
   * reader right-clicked could do more than the folder they were standing *in*. Collapsing the
   * three into {@link buildFolderMenu} makes the two drawings of one folder offer one list, in
   * one order, with one set of words.
   *
   * **It also gives the row back two buttons' worth of width**: three verbs out, one control in,
   * beside a heading, a count, `New folder`, `Import deck` and `New deck` in a column that is
   * ~548px at the app's 1024px floor. See {@link DeckFilterRow}'s own note on what a row that
   * cannot shrink costs this view.
   *
   * A factory taking the folder, like {@link folderRowMenu} beside it, and the item list is a
   * **thunk** for the same reason: nothing is built until the button is pressed.
   */
  const openFolderMenu = useCallback(
    (folder: DeckFolder) => menuClick(() => buildFolderMenu(folder, folderMenuDeps)),
    [menuClick, folderMenuDeps],
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
    folders.reorder,
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

  /**
   * The bracket a tile prints, or `null` — **and `null` is the answer for every deck whose
   * format has no command zone**, which is most of them.
   *
   * The fence is the format's `commanderRule`, the same cell {@link commanderDeckIds} asks
   * `deck_bracket_reads` about, so a deck that was never read for cannot print a reading: the
   * two are one condition asked twice rather than two conditions that have to agree.
   * {@link bracketLabel} decides the rest — the reader's own answer where they gave one, the
   * estimate otherwise, and `null` while the read is in flight or has failed.
   */
  const bracketFor = useCallback(
    (deck: DeckRow) =>
      formatSpecFor(deck.formatKey)?.commanderRule != null
        ? bracketLabel(deck.bracket, floorByDeck.get(deck.id))
        : null,
    [formatSpecFor, floorByDeck],
  );

  const heading = openNode === null ? ROOT_LABEL : openNode.folder.name;
  /**
   * What the line under the heading counts — **the drawer, and the filter's share of it.**
   *
   * The folder figure is the drawer's own and is never narrowed: sub-folders are navigation, and
   * a name typed into a box about decks says nothing about which drawers exist. The deck figure
   * is the drawer's own too, and while a filter is on it is prefixed with what survived —
   * `2 of 9 decks`. Both numbers, never one: the whole is what says the decks are still there,
   * which is exactly the reassurance a wall that just lost seven tiles owes the reader, and the
   * share is what says the wall is short *because they asked*.
   *
   * The alternative — narrowing the figure outright — was rejected for the reason the folder tree
   * is not filtered either: this line is part of the heading that names the drawer, and a heading
   * whose count shrank as you typed is the second thing on screen agreeing that decks have gone.
   */
  const counts = [
    childFolders.length > 0 ? plural(childFolders.length, "folder") : null,
    filtering ? `${shown.length} of ${plural(here.length, "deck")}` : plural(here.length, "deck"),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  /**
   * **An open folder holding nothing still draws the wall** — the way out, and the way to fill
   * it.
   *
   * It used to draw a centred paragraph: *"Nothing is filed in X yet. Drag a deck onto it, or
   * use the Move control on a tile."* Two things were wrong with it. It described a gesture
   * instead of offering one — the `ParentDeckFolderCard` that every non-empty folder puts first
   * on the wall was the reader's way back out, and it was withheld from precisely the folder
   * with nothing else on screen to press. And it named "the Move control on a tile", which is a
   * control on a *different* wall from the one the reader is looking at; there are no tiles here
   * to have one.
   *
   * So an empty drawer gets two tiles instead: the up-tile it was already denied, and a dashed
   * `New deck` placeholder that files into this folder. The words that survive are the ones the
   * paragraph could not offer — *or drag one onto this folder* is still the second way in, and
   * it is written on the thing you would otherwise press.
   *
   * **The root is deliberately not in this**: at the top level the folder cards *are* the wall,
   * so "Every deck you have is filed in a folder" sits over a screen with something on it, and
   * there is no level above the root for an up-tile to climb to.
   *
   * **A named boolean rather than a fifth clause on the grid's gate**, because the four empty
   * states below have to stay legible as four — the condition each of them turns on is the
   * whole of what tells them apart, and a gate that grew a disjunction inline would make the
   * wall's own condition the one nobody could read.
   *
   * `here` rather than `shown`: a drawer emptied by the *filter* is the fourth empty state and
   * keeps its own sentence. `archivedHere` is not consulted either — a folder holding nothing
   * but filed decks is still a folder with nothing on its wall, and the disclosure below says
   * where they went.
   */
  const emptyFolder =
    !status &&
    decks.decks.length > 0 &&
    openNode !== null &&
    childFolders.length === 0 &&
    here.length === 0;

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

      {/* The row the two columns are divided out of, and the box {@link useDeskWidth} measures.
          Its `gap-5` is handed to that hook as a number, because Tailwind's own is not readable
          from JavaScript and the arithmetic has to subtract it. */}
      <div ref={deskRef} className="flex min-h-0 flex-1 gap-5">
        <FolderTree
          width={width}
          collapsed={collapsed}
          maxWidth={maxPanelWidth}
          roomy={roomy}
          onResize={setWidth}
          onCollapse={setCollapsed}
          nodes={nodes}
          totalDecks={live.length}
          selectedId={folderView}
          onSelect={setSelectedFolderId}
          drag={drag}
          canDropIn={canFile}
          onDropIn={fileDeck}
          canDropFolder={canDropFolder}
          onDropFolder={dropFolder}
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

        <div ref={tilesRef} className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* A heading, not a caption: the tree's own `h2` is beside it and the wall is the
                other half of the same outline. */}
            <h2 className="font-heading text-xl leading-none">{heading}</h2>
            <span className="font-mono text-[0.7rem] tabular-nums text-dim">{counts}</span>

            <div className="ml-auto flex items-center gap-2">
              {/* **One control for every verb, where there were three.**

                  `Rename folder…`, `Move folder…` and `Delete folder…` each stood here as a
                  trigger of its own, and each named a write the folder's own row menu — one
                  column to the left, on the very same folder — already offered. That is one
                  vocabulary spelled twice on one screen, and the two spellings did not even
                  agree: the row menu also carries `New deck here` and `New subfolder…`, so a
                  folder a reader right-clicked could do more than the folder they were standing
                  *in*. `Folder` opens {@link buildFolderMenu} verbatim, so the two drawings of
                  one folder now offer one list, in one order, in one set of words.

                  **It also halves the row.** Six buttons stood here at the widest — the three
                  verbs, `New folder`, `Import deck`, `New deck` — beside a heading and a count,
                  in a column that is ~548px at the app's own 1024px floor. Four do now, and
                  that is the same argument {@link DeckFilterRow} makes about why the filter
                  gets a row of its own: this column has no width to spend saying anything
                  twice.

                  The caret glyph is the affordance rather than an ellipsis, and that is a
                  distinction the three removed buttons drew for themselves — their ellipsis
                  meant "this opens something that asks you a question", which is true of a
                  rename field and a delete confirmation and false of a menu. */}
              {openNode !== null && (
                <div className="relative">
                  {/* **`aria-haspopup="menu"` and no `aria-expanded`** — `WishFolderCard`'s
                      ruling for its reasons, and this is the second plain-click menu trigger in
                      the app rather than the first. The popup *kind* is a fact about this
                      button and is free. The expanded *state* is `ContextMenuProvider`'s: it
                      holds the one open menu and publishes only `openMenu`/`closeMenu`, and a
                      static `aria-expanded="false"` would be an assertion that is wrong for
                      exactly as long as the menu is up.

                      **The stash on the first line is load-bearing and is not optional.** Every
                      row of this menu that raises a layer — `Rename…`, `New subfolder…`,
                      `Delete…`, `New deck here` — reads {@link menuOpenerRef} to decide what the
                      caret comes back to, because a `MenuAction.onSelect` is a bare callback
                      with no element behind it. It is the same line the deck tile and every
                      folder row write on their own handlers, and their comments carry the whole
                      reading. */}
                  {/* **`Folder actions`, and never the bare word this button prints.** The
                      create-deck dialog has a `Folder` control of its own — the drawer a new
                      deck lands in — and that dialog opens *over this row*, so for as long as
                      it is up two controls on one screen answer to one name. That is not a WCAG
                      failure; it is a control that cannot be addressed unambiguously, by a
                      screen reader walking the page, by anyone driving the app by voice, or by
                      a `getByRole("button", { name: "Folder" })` that starts throwing "found
                      multiple". It is the third time this exact collision has been ruled on in
                      this feature — `Sort decks` over the deck editor's `Sort`, `Filter decks
                      by name` over its `Filter this deck`, and the format chips' `Modern
                      format` over a *folder* somebody called Modern — and it is settled the
                      same way each time: the name says what kind of thing the control is
                      about.
                      **Found by the suite rather than by design**, which is the point of that
                      rule having a test at all: the collision only exists while a dialog is
                      open, so nothing about reading this row would have shown it.
                      The visible word stays the first word of the name, which is what WCAG
                      2.5.3 asks and what keeps "click Folder" working for a voice user. */}
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label="Folder actions"
                    onClick={(e) => {
                      menuOpenerRef.current = e.currentTarget;
                      openFolderMenu(openNode.folder)(e);
                    }}
                    className={cn(HEADING_BUTTON, "inline-flex items-center gap-1.5")}
                  >
                    Folder
                    <ChevronDown className="size-3.5" aria-hidden="true" />
                  </button>
                  {/* **The delete question stayed, and it is anchored here now.**

                      The menu's `Delete…` row raises this rather than deleting, and it works
                      from either route for one reason `folderMenuDeps.askDelete` states at its
                      own site: it does `setSelectedFolderId(folder.id)` on the way, so by the
                      time this panel renders the folder in question *is* the open one — which
                      is what puts the wall the sentence is about behind the sentence, and what
                      guarantees this button exists to anchor it.

                      `right-0`, unchanged: the group is `ml-auto`, so this trigger's near edge
                      is still the column's right-hand one and a 288px panel grows leftward into
                      the row it came out of. */}
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
                <ImportDialog
                  destinations={[importIntoNewDeck]}
                  subtitle={NEW_DECK_SUBTITLE}
                  open={panel?.kind === "importDeck"}
                  onDismiss={dismiss}
                  onClose={close}
                  onDone={dismiss}
                />
              </div>

              <NewDeck
                buttonRef={newDeckRef}
                // The same answer, resolved once by this screen — see {@link useNewDeckFormat}'s
                // call above. The dialog seeds its draft with it at mount, which it can only do
                // because the value is already real by the time the button is pressed.
                defaultFormatKey={newDeckFormatKey}
                // Where the deck lands, which is a fact about *which control opened this*: the
                // button beside it means the drawer the wall is standing in, a folder row's
                // "New deck here" means that row's folder. Read off the open `Panel` for the
                // same reason the format is read off state — the dialog seeds its draft at
                // mount and never again, so the answer has to be settled by the press rather
                // than recomputed under a dialog the reader is already typing into.
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

          {/* **A row of its own, beneath the heading rather than inside it.**

              The row above already carries a heading, a count and four controls — `Folder`, New
              folder, Import deck and New deck, where it was six until the three folder verbs
              became that one menu. Five more in it wrap badly at the app's 1024px floor, where
              this column is ~548px wide, and a heading that shares a line with a text box has
              stopped being a heading. The collapse changes neither of those, so this row stays
              where it is; it is also what the app does everywhere else, since `FilterBar` is a
              row on all five surfaces that draw it.

              Drawn only where there is a wall to narrow — a filter row over "No decks" is chrome
              about nothing — and the gate is the **unfiltered** drawer, so the row cannot vanish
              along with the last tile it matched and strand a reader with no way to undo. */}
          {!status && (here.length > 0 || archivedHere.length > 0) && (
            <DeckFilterRow
              filter={filter}
              onQuery={setFilterQuery}
              formats={formats}
              onToggleFormat={toggleFormat}
              archivedCount={shownArchived.length}
              archivedGate={archivedHere.length}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((v) => !v)}
              sort={sort}
              onSort={setSort}
            />
          )}

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

          {/* **The root's own sentence, and it is a sentence where the folder's is now a wall.**

              The second arm this used to carry — "Nothing is filed in X yet. Drag a deck onto
              it, or use the Move control on a tile." — is gone, and {@link emptyFolder} carries
              the argument. What is left is the root, which is a different state wearing the same
              shape: a reader standing at the top level with every deck filed is looking at a
              screen that has the folder cards on it, so nothing is being withheld and there is
              no level above for a way *out* to point at. It stays a sentence. */}
          {!status &&
            decks.decks.length > 0 &&
            openNode === null &&
            childFolders.length === 0 &&
            here.length === 0 && (
              <p className="mx-auto max-w-prose py-12 text-center text-sm text-dim">
                Every deck you have is filed in a folder. Open one on the left.
              </p>
            )}

          {/* **The fourth empty state, and it exists because the others would be read as lies
              here.** "Every deck you have is filed in a folder" is a sentence about a *drawer*,
              and a wall emptied by a filter is a full drawer the reader has narrowed to nothing
              — told that, they would go looking for decks that are exactly where they left them.

              **The empty-folder tiles are in this rule now that they have replaced the sentence
              that used to be** ("Nothing is filed in X yet…"), and {@link emptyFolder} is gated
              on `here` rather than on `shown` for exactly that reason. A dashed `New deck` box
              on a wall the reader has just narrowed says the same wrong thing the sentence would
              have: this drawer is bare, when what happened is that they asked for less of it.

              The condition needs no `filtering` beside it and deliberately does not carry one:
              `shown` is `here` narrowed, so the two lengths can only differ while something is
              narrowing them. A second guard would be a second thing to keep in step.

              The voice is the others' — short, no pitch (see the placeholder note above, which
              used to be a paragraph). No way out is offered because the way out is the box the
              reader typed into, one row up and still holding their words. */}
          {!status && here.length > 0 && shown.length === 0 && (
            <p className="py-12 text-center text-sm text-dim">No decks match this filter</p>
          )}

          {(childFolders.length > 0 || shown.length > 0 || emptyFolder) && (
            // Named, the way the search's wall of art is (`CardGrid`'s `role="group"` +
            // `aria-label`) — but left a list rather than made a group, because these tiles are
            // countable and a list says how many there are on the way in.
            <ul aria-label="Your decks" className={GRID} style={wallStyle(zoom)}>
              {/* **First on the wall, and only inside a folder.** The way *out* is the first thing
                  a reader looks for on a wall they have walked into, and it is what issue #283
                  asked for: a folder card only ever takes a deck deeper. The gallery has had a way
                  back since folders shipped — every row of the sidebar's tree is a deck target,
                  including "All decks" — but it is a 32px row on the far side of the window from
                  the tile being dragged, and a reader working on the wall should not have to cross
                  the page to undo a drop they made on it. The tree stays exactly as it was. */}
              {up !== null && (
                <ParentDeckFolderCard
                  label={up.label}
                  zoom={zoom}
                  drag={drag}
                  onOpen={() => setSelectedFolderId(up.id)}
                  canDrop={(d) => canFile(d, up.id)}
                  onDropDeck={(d) => fileDeck(d, up.id)}
                  canDropFolder={(d) => canDropFolder(d, up.id, "inside")}
                  onDropFolder={(d) => dropFolder(d, up.id, "inside")}
                />
              )}
              {childFolders.map((node) => (
                <FolderCard
                  key={node.folder.id}
                  node={node}
                  members={decksUnder(node, live, folderOf)}
                  zoom={zoom}
                  drag={drag}
                  canDrop={(d) => canFile(d, node.folder.id)}
                  onDropDeck={(d) => fileDeck(d, node.folder.id)}
                  canDropFolder={(d, at) => canDropFolder(d, node.folder.id, at)}
                  onDropFolder={(d, at) => dropFolder(d, node.folder.id, at)}
                  onOpen={setSelectedFolderId}
                  // The same menu the sidebar's row opens, from the same builder — so the two
                  // drawings of one folder cannot come to two sets of verbs.
                  rowMenu={folderRowMenu}
                />
              ))}
              {shown.map((deck) => (
                <DeckTile
                  key={deck.id}
                  deck={deck}
                  zoom={zoom}
                  // The two facts a tile cannot read for itself, both answered once for the whole
                  // wall. `null` is a real answer for each: a deck the pip read has not reached
                  // draws no colour bar, and a deck whose format has no command zone prints no
                  // bracket — see {@link bracketFor}.
                  pips={pipsByDeck.get(deck.id) ?? null}
                  bracketLabel={bracketFor(deck)}
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
              {/* **Last on the wall, and only on a wall with nothing else on it** — see
                  {@link emptyFolder}. It is not an always-present `+ New deck` tile: the
                  heading row's own primary control is two lines up on every visit, so a
                  permanent twin of it would be the gallery's one accent drawn twice, and a wall
                  of forty decks would end in a dashed box nobody was looking for. It is the
                  *empty* drawer that has nothing to press.

                  The dash is the collection's and the wishlist's vocabulary, borrowed exactly:
                  dashed means **container, not a thing you own** — a folder card is dashed, a
                  deck tile is not — and a drawer with nothing in it is the one place on this
                  wall where "put something here" is the whole content. */}
              {emptyFolder && openNode !== null && (
                <li style={cardScaleVars(zoom)}>
                  <button
                    type="button"
                    // Named for the drawer rather than left as "New deck", because the heading
                    // row's primary control is that string already and two buttons with one
                    // accessible name on one screen is exactly what a reader has to
                    // disambiguate by position. It also makes the promise the tile is here to
                    // make: this one files *here*, where that one merely defaults to it.
                    aria-label={`New deck in ${openNode.folder.name}`}
                    onClick={(e) => {
                      // `reset()` first for {@link openCreate}'s reason — a refusal from the
                      // last attempt is not news about this one — and `open` rather than
                      // `setPanel` so Escape hands the caret back to this tile.
                      decks.create.reset();
                      open({ kind: "createDeck", folderId: openNode.folder.id }, e.currentTarget);
                    }}
                    // The padding is the **mana band's** 20px, scaled by the reader's zoom the
                    // way everything else drawn on a tile is: a deck tile is a crop with that
                    // band fused to its bottom, so a placeholder that stopped at the crop would
                    // stand 20px short of the object beside it and the track would be ragged.
                    // Written as an inline `calc` rather than a Tailwind arbitrary value for
                    // `DeckTile`'s reason — the variable is inherited, and this is the one
                    // number that keeps every object in the track the same height.
                    style={{ paddingBottom: "calc(1.25rem * var(--mark-scale, 1))" }}
                    className={cn(
                      "block w-full rounded-lg border border-dashed border-border bg-transparent",
                      "text-dim transition-colors duration-150",
                      "hover:border-accent hover:text-accent motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    {/* The crop's own box, so the glyph and the words centre where a picture
                        would be rather than in the middle of the whole tile. */}
                    <span
                      className="grid place-items-center px-2 text-center"
                      style={{ aspectRatio: ART_ASPECT }}
                    >
                      <span
                        className={cn(
                          "grid justify-items-center",
                          "gap-[calc(0.25rem*var(--mark-scale,1))]",
                        )}
                      >
                        <Plus
                          className="size-[calc(1.25rem*var(--mark-scale,1))]"
                          aria-hidden="true"
                        />
                        {/* The tile's name line, at the deck tile's own size and leading. */}
                        <span
                          className={cn(
                            "text-[calc(0.875rem*var(--mark-scale,1))]",
                            "leading-[calc(1.25rem*var(--mark-scale,1))]",
                          )}
                        >
                          New deck
                        </span>
                        {/* The caption size, and the second way in written where the first one
                            is. A folder takes a deck dropped on it — on its card, on its tree
                            row, on this drawer's own way-out tile — and a drop is the one
                            gesture on this screen that nothing on screen can advertise. The
                            sentence this replaced said the same thing by naming "the Move
                            control on a tile", which is a control on a *different* wall from
                            the one the reader is looking at. */}
                        <span
                          className={cn(
                            "text-[calc(0.75rem*var(--mark-scale,1))]",
                            "leading-[calc(1rem*var(--mark-scale,1))]",
                          )}
                        >
                          or drag one onto this folder
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              )}
            </ul>
          )}

          {!status && here.length === 0 && archivedHere.length > 0 && (
            <p className="py-8 text-center text-sm text-dim">
              Nothing here — every deck in this folder is filed away below.
            </p>
          )}

          {/* **The wall of filed decks stays exactly where it was; its button did not.**

              The disclosure's trigger is the `Archived` chip in the filter row above — one
              control, moved, not two — and this is still the same `showArchived` it always
              toggled. The point the old comment made is the one the chip now has to carry, so it
              is written there rather than deleted: *filed decks are kept, not shown*. They are
              never mixed into the live wall, whatever the sort or the filter says; a deck the
              reader put away is a deck they asked not to look at.

              Drawn on the **unfiltered** count, like the chip, so the section and its own trigger
              appear and disappear together. */}
          {archivedHere.length > 0 && showArchived && (
            <div className={cn(shown.length > 0 && "mt-4 border-t border-border pt-4")}>
              {/* The filed wall is narrowed by the same filter as the live one, so it can be
                  emptied by it — and an opened disclosure revealing literally nothing reads as a
                  control that broke. Its own sentence, in the live wall's voice. */}
              {shownArchived.length === 0 && (
                <p className="py-6 text-center text-sm text-dim">
                  No filed decks match this filter
                </p>
              )}
              {/* The same tracks and the same gutter as the wall above it: filed decks are the
                  same wall behind a disclosure, so one size answers for both. */}
              {shownArchived.length > 0 && (
                <ul aria-label="Archived decks" className={GRID} style={wallStyle(zoom)}>
                  {shownArchived.map((deck) => (
                    <DeckTile
                      key={deck.id}
                      deck={deck}
                      zoom={zoom}
                      // As above: one read for the whole gallery, handed down per tile.
                      pips={pipsByDeck.get(deck.id) ?? null}
                      bracketLabel={bracketFor(deck)}
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
          costs this screen nothing while it is shut — `Dialog` renders `children` only
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
 * The row that narrows and orders the wall.
 *
 * **Five controls, and the row reads left to right as one sentence about the wall below it**:
 * everything that decides *which* decks are on it, then — past the auto margin — the one pair
 * that decides what order they are in. That is the division `FilterBar` draws with a hairline on
 * its own row, borrowed without the hairline: this row wraps at the app's 1024px floor, and a
 * divider is the one item in a wrapping row that can end up alone on a line saying nothing.
 *
 * **The controls are `FilterChips`' recipes rather than a second family.** A chip that invents
 * its own height sits 2px off the line and one that invents its own focus style is the only
 * control on the screen a keyboard reader loses — so the geometry, the press, the focus ring and
 * the on/off treatment all come from that module, and the gallery contributes nothing but the
 * arrangement.
 *
 * **`flex-wrap` is not optional.** This column is `flex-1` beside the folder tree, so at the
 * app's own 1024px floor it is ~548px wide — narrower than the row's contents. A flex item cannot
 * shrink below its own min-content, so an unwrapped row would hang out of the column and, since
 * the column is `overflow-y-auto` (which computes `overflow-x` to `auto`), the overhang would
 * become a horizontal scrollbar across the whole gallery. Wrapping makes the row's min-content
 * one control. `src/CLAUDE.md` carries the measured version of that failure from the deck
 * editor's docked panel. **The 548 was measured against a fixed 208px tree and is a ceiling
 * now**, not a figure: the tree is draggable, so a reader who widens it takes the difference out
 * of this column — which is why the wrap is what makes that free rather than something the row
 * has to be re-measured for.
 */
function DeckFilterRow({
  filter,
  onQuery,
  formats,
  onToggleFormat,
  archivedCount,
  archivedGate,
  showArchived,
  onToggleArchived,
  sort,
  onSort,
}: {
  filter: DeckFilter;
  onQuery: (query: string) => void;
  /** Every format present among the decks on the wall, already in display order. */
  formats: readonly { key: string; label: string; count: number }[];
  onToggleFormat: (key: string) => void;
  /** What the chip opens onto — the filed decks **this filter leaves**, so the number on the
   *  disclosure is the number of tiles behind it rather than a count that stops agreeing with the
   *  wall the moment anything is typed. */
  archivedCount: number;
  /** Whether the drawer holds filed decks at all, filter or no filter. The chip is drawn on
   *  this rather than on {@link archivedCount} so it cannot vanish out from under a reader
   *  narrowing the wall — `features/search/facets.ts`' rule, that an option which disappears
   *  reads as a control that broke. */
  archivedGate: number;
  showArchived: boolean;
  onToggleArchived: () => void;
  sort: DeckSort;
  onSort: (next: DeckSort) => void;
}) {
  const tip = useTooltip();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* **`Filter decks by name`, and never a bare `Filter`.** The deck editor already owns a
          box called "Filter this deck", and the two are one Escape apart in a reader's day: that
          one narrows the cards inside one deck, this one narrows the gallery of decks. A name
          that did not say which would be unaddressable by a screen reader walking the app, by
          voice, and by a `getByLabelText` — the argument `FilterBar.tsx:928-944` makes at length
          about `Sort results`, applied to the control beside it. The placeholder is the label
          with an ellipsis so the two cannot say different things. */}
      <label htmlFor={FILTER_FIELD_ID} className="sr-only">
        Filter decks by name
      </label>
      <input
        id={FILTER_FIELD_ID}
        type="search"
        value={filter.query}
        onChange={(e) => onQuery(e.target.value)}
        // Escape empties the box while there is something in it, and falls through when there is
        // not — which is load-bearing on *this* view rather than a courtesy. Chromium clears an
        // `<input type="search">` itself and leaves `defaultPrevented` false, and the gallery
        // binds Escape at the `"navigation"` rung to walk one folder up: without this, one press
        // in a box with text would clear the filter *and* take the reader out of the drawer they
        // were narrowing. jsdom implements no native clear, so the handler is also the only half
        // of the behaviour a test can see. The rule is `clearFieldOnEscape`'s.
        onKeyDown={(e) => clearFieldOnEscape(e, filter.query, () => onQuery(""))}
        placeholder="Filter decks by name…"
        // `FILTER_FIELD` and **never** `FILTER_CONTROL`: the row's chips dip 3% under a press and
        // a box the reader types into must not, or the native ✕ slides out from under the pointer
        // clearing it and the box bounces without emptying (issue #179 — the whole measurement is
        // on the constant). It is also where the finger's 44px floor comes from, through
        // `FILTER_SHAPE`, with no number written a second time here.
        //
        // `min-w-40 max-w-[22rem] flex-1` is the deck editor's own filter-box shape: it takes what
        // the row leaves, but a search box as wide as a maximised window is a box whose text sits
        // alone in the middle of the desk.
        className={cn(
          FILTER_FIELD,
          FILTER_FOCUS,
          "min-w-40 max-w-[22rem] flex-1 border-border bg-surface px-3",
          "placeholder:text-dim focus:border-accent",
        )}
      />

      {/* **One chip per format on the wall, and only where there is more than one.** A lone chip
          can do exactly two things — leave the wall as it is, or empty it — so it is a control
          whose only effect is the bad one. The group wraps for the row's own reason, and it is
          named so a reader sweeping the row hears what the chips are about before hearing the
          first of them.

          The count rides `title`, which `ToggleChip` makes both the tooltip *and* the accessible
          name, so the chip reads "Modern format, 3 decks" while still *beginning* with the word
          printed on it (WCAG 2.5.3). That is the search's Owned chip's arrangement, for its
          reason: the number is what tells a reader whether pressing it is worth doing.

          **The word `format` in that name is load-bearing and was found by a story going red.**
          Without it the chip is named `Commander, 1 deck` — and so is the sidebar's tree row for a
          *folder* somebody called Commander holding one deck, which is a folder name a Commander
          player is very likely to use. Two controls with one name is not a WCAG failure; it is a
          control that cannot be addressed unambiguously, by a screen reader walking the page, by
          anyone driving the app by voice, or by a `getByRole` that starts throwing "found
          multiple" — `FilterBar`'s `Sort results` rule, met here by a collision nobody designed
          rather than by two rows of one toolbar. The chip's name has to say what *kind* of thing
          it narrows by, because a folder's name is the reader's and can be anything at all. */}
      {formats.length > 1 && (
        <div role="group" aria-label="Format" className="flex flex-wrap items-center gap-1">
          {formats.map((format) => (
            <ToggleChip
              key={format.key}
              label={format.label}
              title={`${format.label} format, ${plural(format.count, "deck")}`}
              pressed={filter.formats.includes(format.key)}
              onClick={() => onToggleFormat(format.key)}
            />
          ))}
        </div>
      )}

      {/* **The archived disclosure, moved into the row and still a disclosure.**
          It carries `aria-expanded` rather than `aria-pressed`, which is the whole reason it is
          built out of the chip family's recipes instead of being a `ToggleChip`: that component
          states `aria-pressed`, and "this filter is on" and "the thing below is open" are two
          different sentences. A reader who is told the wrong one goes looking for a wall that is
          not there.

          It keeps the chevron for the same reason. Every other chip in this row narrows; this one
          *reveals*, and the turning glyph is the one mark that says so at a glance — filed decks
          are kept, not shown, and this is the control that shows them.

          The visible text is unchanged (`Archived 1`), so the accessible name the disclosure has
          always had survives the move. */}
      {archivedGate > 0 && (
        <button
          type="button"
          aria-expanded={showArchived}
          onClick={onToggleArchived}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            "inline-flex items-center gap-1.5 px-3",
            filterChipState(showArchived),
          )}
        >
          {/* The one chevron in this file that is a disclosure's, and the only one that turns. On
              the app's `fast` tier, off the shared token, so it agrees with the press feedback its
              own button carries. */}
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              showArchived && "rotate-90",
            )}
            aria-hidden="true"
          />
          Archived <span className="font-mono tabular-nums">{archivedCount}</span>
        </button>
      )}

      {/* The order, at the far end. `ml-auto` rather than a divider, and the pair is boxed rather
          than left to the row's own gap so `flex-wrap` can never break the arrow onto the line
          below the order it belongs to — a direction with its order on another line is a button
          about nothing. 4px apart, `FilterBar`'s number for the same pair. */}
      <div className="ml-auto flex items-center gap-1">
        {/* **`Sort decks`, and never shortened to `Sort`.** The deck editor's toolbar already has
            a `Sort`, and it sorts the cards *in* a deck; this sorts the decks. Two controls with
            one name is not a WCAG failure — it is a control that cannot be addressed
            unambiguously, by a screen reader, by voice, or by a `getByRole("button", { name:
            "Sort" })` that starts throwing "found multiple". `FilterBar.tsx:928-944` writes the
            argument out in full and this is the same call. Both `id` and `labelledBy`: the first
            keeps the label's pointer behaviour, the second pins the name against a later edit
            that moves one of the two. */}
        <label id={`${SORT_ID}-label`} htmlFor={SORT_ID} className="sr-only">
          Sort decks
        </label>
        <Dropdown
          id={SORT_ID}
          labelledBy={`${SORT_ID}-label`}
          value={sort.key}
          // **Picking a key sets the direction as well, and does not keep the old one.** Each key
          // has a way round it reads naturally — the deck touched most recently and the biggest
          // pile from the top, names and formats and colours and brackets forwards — and
          // `NATURAL_DESC` is where those six answers live. Carrying the previous key's direction
          // over would open `Name` at Z.
          onChange={(key) => onSort({ key: key as DeckSortKey, desc: NATURAL_DESC[key as DeckSortKey] })}
          options={SORT_ROWS}
          // **Never gold.** Accent on a picker means "this is not where the control opens", which
          // is a state a *filter* can be in. A wall is always in some order, so a sort cannot be
          // inactive, and a gold sort picker would be saying a filter is on about the one control
          // in this row that is not one.
        />

        {/* One arrow, turned over — never `ArrowDown` swapped in for `ArrowUp`. That is
            `SortableHeader.tsx:51-55`'s rule and `FilterBar.tsx:975` states the reason: a
            different element in the same slot is unmounted and remounted, so the indicator
            *teleports*, and the whole of what the press means is that the order reversed. Half a
            turn is that fact, drawn. `initial={false}` so a wall that opens descending — which is
            the default, `updated` — draws its arrow already turned rather than spinning on first
            paint.

            `rotate` is a transform prop, so `MotionConfig reducedMotion="user"` reaches it and no
            `useReducedMotion` opt-out is owed (`docs/reference/motion.md` — the trap there is the
            *non*-positional properties, and this animates none).

            The wrapper carries the tooltip rather than the button, `AllPrintingsDialog`'s
            arrangement: `aria-label` already carries the whole sentence, so the binding is
            `describes: false`, and a wrapper adds no box beyond the button's own. This button is
            never `disabled` — `FilterBar`'s is, because `Best match` has no direction — so the
            wrapper buys nothing that the button could not, and it is written this way so the two
            rows stay one arrangement. */}
        <span {...tip(sortDirectionName(sort.desc), { describes: false })}>
          <button
            type="button"
            onClick={() => onSort({ ...sort, desc: !sort.desc })}
            aria-label={sortDirectionName(sort.desc)}
            className={cn(
              FILTER_CONTROL,
              FILTER_FOCUS,
              "flex size-9 items-center justify-center",
              // Not `aria-pressed`, and never gold: descending is not a filter switched on, it is
              // the other half of a control that is always doing something.
              filterChipState(false),
            )}
          >
            {/* `flex` on the span is load-bearing and not decoration: a bare `<span>` is a
                non-replaced inline box, a transform does not apply to one at all, and the rotation
                would silently do nothing. `SortableHeader` carries the same class for the same
                reason. */}
            <motion.span
              aria-hidden="true"
              initial={false}
              animate={{ rotate: sort.desc ? 180 : 0 }}
              transition={TRANSITION.fast}
              className="flex"
            >
              <ArrowUp className="size-4" />
            </motion.span>
          </button>
        </span>
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
        // No focus outline: a landing pad, not a control — `tabIndex={-1}` only so the caret has
        // somewhere to go while the confirmation is open, and neither Tab nor an arrow reaches
        // it. Its two buttons keep theirs. `src/lib/focus.ts` has the rule.
      )}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{node.folder.name}”?</p>
      <p className="mt-1 leading-relaxed text-dim">
        {node.count === 0
          ? "It holds no decks."
          : `The ${plural(node.count, "deck")} in it ${
              node.count === 1 ? "is" : "are"
            } kept — ${node.count === 1 ? "it moves" : "they move"} to the top level.`}
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
