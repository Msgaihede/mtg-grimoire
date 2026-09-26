import {
  act,
  cleanup,
  configure,
  fireEvent,
  getConfig,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { isWebTarget } from "@/pwa/target";

// The build flag `cardArtSrc` branches on. `false` is what `__CORE__` already answers under
// vitest, so this changes nothing here until a case below asks for a browser.
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
// The shelf layout, **unchanged** — wrapped only so a case can count how often the wall is laid out
// (`CardGrid` and this page both call it). Every other case reads it through the real function.
vi.mock("@/lib/shelfLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shelfLayout")>();
  return { ...actual, layoutShelves: vi.fn(actual.layoutShelves) };
});
import { layoutShelves } from "@/lib/shelfLayout";
import { dndManager } from "@/lib/dndManager";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import { EMPTY_SHELF_ATTR } from "@/features/shelves/EmptyShelf";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import { folderDraggable, type FolderDrag } from "@/lib/folderDrag";
import type {
  CardSummary,
  CollectionFolder,
  CollectionQuery,
  CollectionRow,
  CollectionSummary,
  DeckRow,
  ImportMatch,
  ShelfCount,
} from "@/lib/ipc";
import { UNFILED_SHELF } from "@/lib/shelves";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { recordDrags, startPointerDrag } from "@/test-drag";
import { pickOption } from "@/test-dropdown";
import { stubNarrowWindow } from "@/test-viewport";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import { PHONE_TILE_WIDTH } from "@/features/search/CardGrid";
import { readCollectionTileDrag } from "./collectionDrag";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
const collectionSetQuantity = vi.hoisted(() => vi.fn());
const collectionRemove = vi.hoisted(() => vi.fn());
/**
 * The row's own `Edit copy…`, and **this command's first caller anywhere in `src/`** — it has
 * existed on both sides of the wire since the v1 rung with only `ipc.test.ts` exercising it, so
 * an unmocked one here is a rejection about a missing Tauri runtime rather than a write.
 */
const collectionUpdate = vi.hoisted(() => vi.fn());
// The set picker rides the filter row and asks for the set list on the way up.
const listSets = vi.hoisted(() => vi.fn());
// The wall pre-warms its own art in the background on the first load that has rows.
const prewarmCollection = vi.hoisted(() => vi.fn());
/** Which marketplace the Value column and the header figure quote. An unmocked command is a
 *  rejected query that silently resolves to the default, so it is answered explicitly. */
const getMarketplace = vi.hoisted(() => vi.fn());
// What the row's own context menu writes. Both are real `invoke`s, so an unmocked one is a
// rejection about a missing Tauri runtime rather than a call anything here could read.
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
/**
 * The deck end of the menu's "Add to → Deck", which the type-line case below drives all the way
 * through. `deckList`/`deckFolderList` are answered as well as seeded, so a picker that stopped
 * reading the cache says "Loading decks…" rather than hanging on an undefined command.
 */
const deckList = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
// The collection's own bulk-import entry point (Task 14): one resolved line and the commit it
// feeds, so `resolve` and `collectionImportCommit` both have a real answer rather than a
// rejection about a missing Tauri runtime.
const importResolve = vi.hoisted(() => vi.fn());
const collectionImportCommit = vi.hoisted(() => vi.fn());
/**
 * The cabinet: the census, the per-folder figures, the four writes that shape it, and the one
 * write that files a copy.
 *
 * Answered even where a test has no folders, because an unmocked command is `undefined` called as
 * a function — a rejected query rather than an empty cabinet, which is a different picture and one
 * no test here means to draw.
 */
const collectionFolderList = vi.hoisted(() => vi.fn());
const collectionFolderSummary = vi.hoisted(() => vi.fn());
const collectionFolderCreate = vi.hoisted(() => vi.fn());
const collectionFolderRename = vi.hoisted(() => vi.fn());
const collectionFolderMove = vi.hoisted(() => vi.fn());
const collectionFolderReorder = vi.hoisted(() => vi.fn());
const collectionFolderDelete = vi.hoisted(() => vi.fn());
/** Setting a drawer aside, and bringing it back — issue #365's one new write. */
const collectionFolderSetLocked = vi.hoisted(() => vi.fn());
const collectionSetFolder = vi.hoisted(() => vi.fn());
/** `Clear…` inside `Recently removed` (issue #506): every entry in the holding area, one write. */
const collectionRemovedClear = vi.hoisted(() => vi.fn());
/**
 * The three reads shelves added: the per-shelf counts every heading's figures and every shelf's
 * slot count come from, and the stored folds. Answered on every mount — an `ipc` mock is an object
 * literal, and a command it does not carry is a synchronous `TypeError` inside a hook.
 */
const collectionShelfCounts = vi.hoisted(() => vi.fn());
const shelfFolds = vi.hoisted(() => vi.fn());
const setShelfFolds = vi.hoisted(() => vi.fn());
/**
 * The docked card-search column's own three commands.
 *
 * **Answered on every mount in this file rather than only by the tests that name them**, because
 * the column opens *open* — `DEFAULT_SEARCH_OPEN.collection` is `true`, and a reader who has never
 * pressed the disclosure gets a wall. An `ipc` mock is an object literal, so a command it does not
 * carry is `undefined` and calling it is a synchronous `TypeError` fired from inside a hook on the
 * way up, which no `.catch` in a `queryFn` can reach.
 */
const searchCards = vi.hoisted(() => vi.fn());
const searchOpen = vi.hoisted(() => vi.fn());
const setSearchOpen = vi.hoisted(() => vi.fn());
/**
 * The Share control's own two reads, and the three writes behind its menu.
 *
 * **Answered on every mount rather than only by the cases that name them**, for the sidebar's
 * reason one comment up: the control is drawn in the figures band of every render below, and an
 * `ipc` mock is an object literal — a command it does not carry is `undefined` called as a
 * function, which is a synchronous `TypeError` from inside a hook rather than a query this page
 * could fail gracefully over.
 */
const shareList = vi.hoisted(() => vi.fn());
const shareCreate = vi.hoisted(() => vi.fn());
const shareRefresh = vi.hoisted(() => vi.fn());
const shareRevoke = vi.hoisted(() => vi.fn());
const shareOpen = vi.hoisted(() => vi.fn());
const syncSupporterStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    searchOpen,
    setSearchOpen,
    shareList,
    shareCreate,
    shareRefresh,
    shareRevoke,
    shareOpen,
    syncSupporterStatus,
    // The panel's filter row asks for facet counts beside the page's. Answered **cold** —
    // `ready: false`, every map empty — so nothing greys and every control keeps its name.
    facetCards: vi.fn().mockResolvedValue({
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      sets: {},
      rarities: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    }),
    collectionList,
    collectionSummary,
    collectionSetQuantity,
    collectionRemove,
    collectionUpdate,
    collectionAdd,
    wishlistAdd,
    listSets,
    prewarmCollection,
    getMarketplace,
    deckList,
    deckFolderList,
    deckGet,
    deckAddCard,
    oracleTagsForPrintings,
    importResolve,
    collectionImportCommit,
    collectionFolderList,
    collectionFolderSummary,
    collectionFolderCreate,
    collectionFolderRename,
    collectionFolderMove,
    collectionFolderReorder,
    collectionFolderDelete,
    collectionFolderSetLocked,
    collectionSetFolder,
    collectionRemovedClear,
    collectionShelfCounts,
    shelfFolds,
    setShelfFolds,
  },
}));

import { CollectionPage } from "./CollectionPage";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { CardToDeckProvider } from "@/features/card/cardMenu";
import { useAppStore } from "@/lib/store";

const BOLT: CollectionRow = {
  promoTypes: null,
  legalities: null,
  id: 7,
  cardId: "c1",
  // At the root of the cabinet, which is where every copy starts and where a deleted folder's
  // cards return to — Not sorted's shelf.
  folderId: null,
  folderName: null,
  name: "Lightning Bolt",
  oracleId: "o1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  layout: "normal",
  finish: "foil",
  condition: "NM",
  quantity: 2,
  tradelistQuantity: 0,
  unitPrice: 400.5,
  purchasePrice: null,
  purchaseCurrency: null,
  acquiredAt: null,
  acquisitionSource: null,
  serialNumber: null,
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  tags: "[]",
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/**
 * The one printing the sidebar's card search answers with — a `CardSummary`, which is a different
 * object from the {@link BOLT} above it: that one is a `collection_entries` row the reader owns,
 * this is a printing off the corpus that they may not.
 *
 * **A card the fixtures above do not hold**, deliberately: the sidebar's whole subject is a card
 * that is *not* in the binder yet, and naming Bolt here would put two things called Lightning Bolt
 * on one screen for every query in this file to be ambiguous about.
 */
const SEARCH_LOTUS: CardSummary = {
  promoTypes: null,
  id: "lotus",
  name: "Black Lotus",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "232",
  rarity: "rare",
  typeLine: "Artifact",
  manaCost: "{0}",
  price: 12000,
  layout: "normal",
  oracleId: "o-lotus",
  // Nonfoil only, which is what a drop writes: `searchCardDrag` **refuses** a finish this build
  // does not know rather than normalising one, so the panel builds it from `parseFinishes`.
  finishes: `["nonfoil"]`,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 12000,
  priceHigh: 12000,
  gameChanger: false,
};

/** What `search_cards` answers. `totalIsCapped` false, so the caption is a plain count. */
const searchPage = (items: CardSummary[]) => ({
  items,
  total: items.length,
  totalIsCapped: false,
});

/** The one printing `import_resolve` answers with for the import test below — everything the
 *  collection's planner does not read filled in as nothing, `DeckEditor.test.tsx`'s own
 *  `SOL_RING` cut to what this file needs. */
const SOL_RING: ImportMatch = {
  cardId: "sol-ring",
  name: "Sol Ring",
  setCode: "ltc",
  collectorNumber: "285",
  lang: "en",
  oracleId: null,
  manaCost: null,
  cmc: null,
  typeLine: "Artifact",
  oracleText: null,
  colors: null,
  colorIdentity: null,
  legalities: null,
  power: null,
  toughness: null,
  layout: null,
  rarity: null,
  faces: null,
  gameChanger: false,
  everUncommon: false,
  printingCount: 1,
  ownedQuantity: 0,
};

/** One deck for the menu's "Add to → Deck" to reach. No theory list, so it is one row. */
const BURN: DeckRow = {
  gameKey: "any",
  id: 7,
  name: "Burn",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  archived: false,
  cardCount: 0,
  updatedAt: 0,
  folderId: null,
  notesOpen: false,
  theoryEnabled: false,
  virtualOnly: false,
  theoryMarkExact: true,
  theoryMarkName: true,
  theoryMarkUnplanned: true,
  managedWishlist: "off",
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  tokensOpen: false,
  tokenStack: false,
  tokenRailIndex: -1,
  // `true` where its neighbour above is `false` — `decks.stats_open` is `NOT NULL
  // DEFAULT 1`, because every deck that exists today draws the Deck stats band and has
  // no control to hide it.
  statsOpen: true,
  defaultCategoryId: 0,
  bracket: 0,
};

/** Two drawers, one inside the other — flat rows, because the tree is the page's to build from
 *  `parentId`. `kind: "user"` is a folder the reader made and named, which is the only kind this
 *  PR can produce and the only kind the nestable wall draws.
 *
 *  **`locked: false` on every fixture here is the state schema v33's `NOT NULL DEFAULT 0` puts
 *  every existing database in**, so the whole of this file goes on describing the app as it was.
 *  The lock block near the end spreads its own drawers off these rather than turning the flag on
 *  here, which is what keeps "a locked folder" a claim one describe makes and not a property the
 *  file's fixtures quietly acquired. */
const BINDER: CollectionFolder = {
  id: 3,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  // The cross-device name, which every creation path mints and which is the only thing a share
  // can be addressed by — a row id names a row in a database no other device has seen. Nullable
  // in the DDL, so the sharing block near the end has a fixture for that state too.
  syncUid: "uid-binder",
};
const FOILS: CollectionFolder = {
  id: 9,
  parentId: 3,
  name: "Foils",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "uid-foils",
};

/** A **second** drawer at the top level, so the wall has a *level* to rearrange rather than one
 *  card. `sortOrder` 1 puts it after `Trade binder`, which is the order every reorder below is
 *  measured against. */
const SEALED: CollectionFolder = {
  id: 4,
  parentId: null,
  name: "Sealed",
  kind: "user",
  deckId: null,
  sortOrder: 1,
  locked: false,
  syncUid: "uid-sealed",
};

/** A drawer whose parent this list does not carry — another window deleted it between the two
 *  reads. `buildFolderTree` draws it at the **root** rather than dropping it, so its row names a
 *  folder that is gone while the wall it appears on is the top level. */
const ORPHAN: CollectionFolder = {
  id: 5,
  parentId: 99,
  name: "Odds and ends",
  kind: "user",
  deckId: null,
  sortOrder: 2,
  locked: false,
  syncUid: "uid-orphan",
};

/**
 * The two kinds the **app** owns, which schema v25 creates and nothing on this page can make,
 * rename or delete: one folder per deck, and exactly one holding area.
 *
 * They are not fixtures of convenience — every rule the pinned section has is about one of them,
 * and each is a rule the reader can otherwise walk into by dragging: a copy may not be dropped
 * *into* either (the backend refuses the destination outright, and a deck group would end up
 * holding copies no `deck_cards` row knows about), and a copy may not be dragged *out of* a deck
 * group (which the backend would happily allow, leaving the deck listing a card whose copies have
 * gone). Out of `Recently removed` is the one direction that is the feature.
 */
const DECK_GROUP: CollectionFolder = {
  id: 20,
  parentId: null,
  name: "Mono-Red Aggro",
  kind: "deck",
  deckId: 1,
  sortOrder: 0,
  // Never anything but `false` for either of these two: `collection_folder_set_locked` calls
  // `user_folder` first, so the app's own folders refuse the write in words.
  locked: false,
  // The app's own folders carry a uid like any other row — and are still unshareable, which is
  // the point: `kind` is what refuses them, never the absence of a name to refuse.
  syncUid: "uid-deck-group",
};
const REMOVED: CollectionFolder = {
  id: 21,
  parentId: null,
  name: "Recently removed",
  kind: "removed",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "uid-removed",
};

const summary = (over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  totalCards: 0,
  uniqueCards: 0,
  entries: 0,
  tradelistCards: 0,
  value: 0,
  unpriced: 0,
  needsReview: 0,
  ...over,
});

const page = (items: CollectionRow[], total = items.length) => ({ items, total });

/**
 * What the reconciler actually writes into `needs_review` — `reconcile::flag_deleted`'s
 * sentence, date and all, at its real length of 175 characters.
 *
 * Length is the point: the band is one line of a 44px row and holds ~110 of them, and the
 * half that goes over the edge is the half that says what to *do*. A fixture reading "This
 * printing left the card database." would pass a rendering that throws the instruction away.
 */
const REVIEW_NOTE =
  "Scryfall removed this printing from its database on 2026-04-12. Your copies are still " +
  "recorded — check the printing and re-add it if you can identify it, or remove this entry.";

const lastQuery = () =>
  collectionList.mock.calls[collectionList.mock.calls.length - 1][0] as CollectionQuery;

/**
 * How many **sweep** requests (`limit: 500`, `scope.ts`'s `SWEEP_PAGE`) have gone out at a given
 * marketplace — as opposed to the ordinary paged list's own `limit: 100` requests, which also
 * carry `marketplace` in their key and legitimately refetch on a feed switch regardless of this
 * task. A cache-key test on the export sweep has to filter those out, or a marketplace switch
 * reads as "a fresh sweep went out" when it was really just the list behind the table doing what
 * it always does.
 */
const sweepCallsAt = (marketplace: string) =>
  collectionList.mock.calls.filter(
    ([q]) => (q as CollectionQuery).limit === 500 && (q as CollectionQuery).marketplace === marketplace,
  ).length;

/**
 * The filter bar's sort control.
 *
 * By role and exact name, not a loose label match. Every sortable column header carries a
 * `SORT_HINT` — since the tooltip sweep, a hover tooltip rather than a `title` — but a header's
 * own **accessible name** can still contain "Sort" (`headerLabel`, e.g. "Value. Prices as of…"),
 * so `/sort/i` on `getByLabelText` would still risk matching the whole header row rather than
 * only the control this file means. A dropdown's trigger is a `button`, not a `combobox` — the
 * combobox role belongs to a `searchable` dropdown's search box, and this one has none.
 */
// **`Sort results` and not the bare `Sort` this page drew before it shared `FilterBar`.**
// That row is mounted on four surfaces and one of them - the deck editor - already has a
// `Sort` of its own, so the shared control names what it orders. `FilterBar`'s own label
// carries the argument.
//
// **A `button`, not a `combobox`.** The control became a `Dropdown` on 2026-08-26: the combobox
// role belongs to a `searchable` dropdown's search box and this one has none, so the trigger is
// a plain disclosure button whose content is the picked order.
const sortSelect = () => onPage(screen.getAllByRole("button", { name: "Sort results" }));

/**
 * The docked card-search column, or `null` where nothing drew one.
 *
 * `queryBy`, because two states have no panel: the railing a narrow row would cause (never
 * reachable under jsdom, which measures every box as zero and therefore always reads as roomy),
 * and a reader who has shut it.
 */
const searchColumn = () =>
  screen.queryByRole("region", { name: "Add cards to your collection" });

/**
 * The one match that is **not** inside the sidebar — the page's own half of the screen.
 *
 * **Two `FilterBar`s are mounted together on this page since the sidebar landed**, and every
 * control in the row carries the same name on both: `Show filters`, `Sort results`, the colour
 * chips, the mana values. Only the search box differs, which is exactly what `FilterLabels` is
 * for — so everything else needs saying which row it means, and the honest way to say it is
 * *outside the panel* rather than by index. An index would pass today and answer about the
 * sidebar the day the dock moved above the list.
 *
 * `getAllByRole` at every call site rather than `getBy`, because `getBy` throws on the ambiguity
 * before this function can resolve it.
 */
function onPage(matches: readonly HTMLElement[]): HTMLElement {
  const own = offPanel(matches);
  if (own.length !== 1) {
    throw new Error(`expected exactly one match outside the search panel, found ${own.length}`);
  }
  return own[0];
}

/**
 * Everything in `matches` that is **not** inside the sidebar.
 *
 * {@link onPage}'s plural, for the sweeps that count rather than address: the panel draws a
 * `CardGrid` of its own, so an owned badge, an as-of line, a drag source or a felt backing is
 * whatever this page draws **plus** whatever the column beside it does. Every one of those counts
 * was written before there was a second wall, and each is still asking about the first one.
 */
function offPanel<T extends Element>(matches: readonly T[] | ArrayLike<T>): T[] {
  const panel = searchColumn();
  return [...Array.from(matches)].filter((el) => panel === null || !panel.contains(el));
}

/**
 * The page's own sort dropdown, opened.
 *
 * `openDropdown`/`pickOption` address their trigger **by name**, and both filter rows carry a
 * `Sort results` — so the shared helpers cannot be used on this page any more. This is those two
 * functions over {@link sortSelect}, and the `getByRole("listbox")` is theirs verbatim: the
 * listbox is a plain conditional render, so it commits with the click and querying it here is a
 * fail-fast rather than a wait.
 */
async function openPageSort(user: { click: (element: Element) => Promise<unknown> }): Promise<void> {
  await user.click(sortSelect());
  screen.getByRole("listbox");
}

/** Open the page's own sort dropdown and pick one row, by the label a reader sees. */
async function pickPageSort(
  user: { click: (element: Element) => Promise<unknown> },
  option: string | RegExp,
): Promise<void> {
  await openPageSort(user);
  await user.click(screen.getByRole("option", { name: option }));
}

/**
 * Open the filter tray, so a cell behind the Filters disclosure can be pressed.
 *
 * Everything but the box, the colours, the order and the layout pair lives behind that button
 * since this page started drawing `FilterBar` - so a suite that reached straight for a chip is
 * now reaching into a tray that is not mounted. Matched on a prefix: the button's name carries
 * the live count (`Show filters - 2 active`), which moves as a case presses things.
 */
async function openTray(user: {
  // Structural, so the bare `userEvent` module and a `userEvent.setup()` instance both satisfy it
  // - this file uses each in different cases, and the two are not the same type.
  click: (element: Element) => Promise<unknown>;
}): Promise<void> {
  await user.click(onPage(screen.getAllByRole("button", { name: /^Show filters/ })));
}


/**
 * The page, under the providers `App` mounts above it.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider
 * is above it (so that every surface offering a right-click stays renderable on its own), which
 * means a page
 * rendered bare would open nothing and pass every menu assertion below by never being asked.
 * `TooltipProvider` is the same trade, for `useTooltip` — the needs-review band's hover
 * assertion below would bind a tooltip that can never open without it.
 */
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ContextMenuProvider>{ui}</ContextMenuProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}

/**
 * A right-click, and nothing awaited.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads
 * `clientX`/`clientY` to place the panel — and `bubbles`, because the surface's handler is on
 * the row or the tile, never on the cell the pointer happened to be over.
 */
function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/**
 * The **card** drag sources on screen, in document order — a wall tile (`[data-grid-index]`, the
 * element `CardGrid` registers) or a table row (`DraggableRow`, `role="row"`).
 *
 * **Filtered by shape, because a shelf heading is a drag source too** — the reader's own folder
 * headings carry a folder drag (spec §3.9) — and the docked search column's tiles are card sources
 * of their own (`offPanel`).
 */
const cardSources = (container: HTMLElement): HTMLElement[] =>
  offPanel(
    [...container.querySelectorAll<HTMLElement>(`[${DND_SOURCE_ATTR}]`)].filter((element) =>
      element.matches('[data-grid-index], [role="row"]'),
    ),
  );

/**
 * Whether a target wears any drop mark — `DROP_EDGE`'s `border-accent/45` (armed, and a folder's
 * before/after landing), `DROP_OVER`'s `bg-accent/15` (under the pointer, or a folder landing
 * inside), `DROP_RING`'s `ring-accent/45` (the sticky bar and a breadcrumb segment), or a folder's
 * drop line. Asked of the whole subtree, and per class with `classList.contains`, for the reason
 * `CollectionFolderCard.test.tsx` gave: a `hover:` variant makes a substring test vacuous.
 */
const wearsDropMark = (target: HTMLElement): boolean =>
  [target, ...target.querySelectorAll("*")].some(
    (box) =>
      box.classList.contains("border-accent/45") ||
      box.classList.contains("bg-accent/15") ||
      box.classList.contains("ring-accent/45") ||
      box.hasAttribute("data-folder-drop-line"),
  );

/**
 * Two boxes, because dnd-kit hit-tests by **coordinate** and jsdom measures every rectangle as
 * zero: a source with no box is pressed at the origin and a target with no box can never be
 * collided with, and both failures are silent. The two are kept well apart so that a gesture
 * between them really travels.
 */
const SOURCE_BOX = new DOMRect(0, 0, 100, 100);
const CARD_BOX = new DOMRect(400, 400, 100, 100);

/**
 * Pick a **copy** up — a table row or a wall tile — pressing where a reader would.
 *
 * The source needs a box or dnd-kit presses the origin. The press and the drag land on two
 * different elements, which is the case that bites — a press on a control inside a row is a
 * press on the control, and `NOT_A_DRAG` is what says so.
 */
async function holdCopy(source: HTMLElement, { pressOn }: { pressOn: Element }) {
  source.getBoundingClientRect = () => SOURCE_BOX;
  return startPointerDrag(source, { pressOn });
}

/* -------------------------------------------------------------------------------------------- *
 * Shelves — the DOM this file reads (Task 3's components; Step 1's table)
 * -------------------------------------------------------------------------------------------- */

type Clicker = { click: (element: Element) => Promise<unknown> };

/**
 * What `collection_shelf_counts` would answer over these rows: one entry per non-empty shelf the
 * query names, `tiles` counted per (card, finish) as the backend counts them, `unpriced` per row.
 * The default mock below derives it from whatever `collectionList` answers, so a case that sets
 * the list sets the counts with it and cannot draw a wall its own counts contradict.
 */
function shelfCountsOf(
  rows: readonly CollectionRow[],
  shelves: readonly number[] | undefined,
): ShelfCount[] {
  const by = new Map<
    number,
    {
      tiles: Set<string>;
      copies: number;
      value: number | null;
      unpriced: number;
      peek: Set<string>;
    }
  >();
  for (const row of rows) {
    const shelf = row.folderId ?? UNFILED_SHELF;
    if (shelves !== undefined && !shelves.includes(shelf)) continue;
    const at = by.get(shelf) ?? {
      tiles: new Set<string>(),
      copies: 0,
      value: null,
      unpriced: 0,
      peek: new Set<string>(),
    };
    at.tiles.add(`${row.cardId}:${row.finish}`);
    at.copies += row.quantity;
    // `unpriced` is in the page's own unit — copies, like the "42 cards" beside it.
    if (row.unitPrice === null) at.unpriced += row.quantity;
    else at.value = (at.value ?? 0) + row.unitPrice * row.quantity;
    if (at.peek.size < 4) at.peek.add(row.cardId);
    by.set(shelf, at);
  }
  return [...by].map(([folderId, c]) => ({
    folderId,
    tiles: c.tiles.size,
    copies: c.copies,
    value: c.value,
    unpriced: c.unpriced,
    peek: [...c.peek],
  }));
}

const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A shelf's heading, by the shelf's name — found through its chevron (`Collapse <name>` /
 * `Expand <name>`, the one control every heading has, Not sorted's included) and widened to
 * `ShelfHeading`'s root, which is where its drop target and its drag source both register.
 */
function queryHeading(name: string): HTMLElement | null {
  const chevron = offPanel(
    screen.queryAllByRole("button", { name: new RegExp(`^(Collapse|Expand) ${ESC(name)}$`) }),
  )[0];
  return chevron?.closest<HTMLElement>(`[${SHELF_HEADING_ATTR}]`) ?? null;
}
function heading(name: string): HTMLElement {
  const found = queryHeading(name);
  if (found === null) throw new Error(`no heading for ${name}`);
  return found;
}
const findHeading = (name: string) => waitFor(() => heading(name));

/** A heading's own controls, by the names `ShelfHeading` gives them. `null` where it has none. */
const addIn = (name: string) =>
  within(heading(name)).queryByRole("button", { name: `Add folder in ${name}` });
const renameOf = (name: string) =>
  within(heading(name)).queryByRole("button", { name: `Rename ${name}` });
const manageOf = (name: string) =>
  within(heading(name)).queryByRole("button", { name: `Manage ${name}` });

/** Open a folder the way a reader does now: its heading's title (spec §3.7). */
async function openShelf(user: Clicker, name: string): Promise<void> {
  await user.click(within(await findHeading(name)).getByRole("button", { name }));
}

/** Open a heading's ⋯ — `menuClick`'s door, the one a pointer produces. */
async function shelfMenu(user: Clicker, name: string): Promise<void> {
  const trigger = manageOf(name);
  if (trigger === null) throw new Error(`${name}'s heading has no menu`);
  await user.click(trigger);
  await screen.findByRole("menu");
}

/** The path row's toolbar (`ShelfToolbar`), and its **Add folder** — the level's, not a heading's. */
const pathRow = () => screen.getByRole("group", { name: "Shelves" });
const pathRowAddFolder = () => within(pathRow()).queryByRole("button", { name: "Add folder" });

const crumbs = () => screen.getByRole("navigation", { name: "Collection folders" });

/** What the header last asked. */
const lastSummary = () =>
  collectionSummary.mock.calls[collectionSummary.mock.calls.length - 1][0] as CollectionQuery;

/**
 * Where the page is standing, read off the wire: the header counts every shelf at and below the
 * level, and the first of them is the level's own — Not sorted (`0`) at the root. It replaces every
 * `lastQuery().folderId` this file used to read; `folderId` no longer reaches the wire at all.
 */
const standingIn = (): number | null => {
  const first = lastSummary().shelves?.[0];
  return first === undefined || first === UNFILED_SHELF ? null : first;
};

/** Seed the stored folds with these shelves opened — a deck group and Recently removed start
 *  shut, and a shut shelf's cards are never fetched. */
const opened = (...ids: number[]) =>
  shelfFolds.mockResolvedValue({
    collection: Object.fromEntries(ids.map((id) => [String(id), false])),
    wishlist: {},
  });

/** `a` comes before `b` in the document. */
const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * Give a heading somewhere to be. jsdom measures every rectangle as four zeroes and dnd-kit
 * hit-tests by coordinate, so a heading with no box can never be collided with. The whole subtree
 * takes the rect, so the pointer lands on the root whichever child it is over.
 */
function standHeading(name: string, rect: DOMRect = CARD_BOX): HTMLElement {
  const root = heading(name);
  for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    element.getBoundingClientRect = () => rect;
  }
  return root;
}

/**
 * Whether an element is a live drag source — **read off the manager's registry**, the instrument
 * `dndAccessibility.test.tsx` uses. A folder source (`folderDraggable`) registers no
 * `DND_SOURCE_ATTR` of its own (only `dndDraggable`'s card sources carry that attribute), so the
 * attribute would call every heading undraggable and prove nothing either way.
 */
const isDragSource = (element: Element): boolean =>
  [...dndManager.registry.draggables].some((draggable) => draggable.element === element);

/** Pick a heading up by its folder drag source — the root, which the heading registers. */
async function holdHeading(name: string) {
  const root = standHeading(name, SOURCE_BOX);
  if (!isDragSource(root)) throw new Error(`${name}'s heading is not a drag source`);
  return startPointerDrag(root);
}

/** A heading is read along the **vertical** axis — `EDGE_ZONE` is a quarter, so a tenth from
 *  either end is beside it and the middle is inside it. */
const AT_TOP = { y: 0.1 };
const AT_CENTRE = { y: 0.5 };
const AT_BOTTOM = { y: 0.9 };

/**
 * jsdom lays nothing out, so the virtualiser measures a scroller of zero height and renders
 * no rows at all. `@tanstack/react-virtual` sizes it with `offsetHeight` and scrolls it with
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

/**
 * **How long every `findBy*` and `waitFor` here gives the page to settle — a ceiling, never a
 * pause.** Nothing on this page exists until reads have answered in turn: the folder census,
 * then the per-shelf counts and the page of rows, then the virtualiser's measure. Under
 * `npm run verify`, with the whole suite beside `tsc`, `vite build` and `eslint`, that chain ran
 * past Testing Library's 1000ms default — `closes a naming field when the reader walks into
 * another folder` failed on `findHeading("Trade binder")` there on 2026-09-26 and passed alone —
 * and every case here opens on the same chain, so the ceiling is the file's rather than one
 * wait's. A wait that finds its element returns the moment it does: a passing case pays nothing,
 * which is `vite.config.ts`'s `testTimeout` argument (budget, not bound) one level down.
 *
 * Set for this file and put back after it: `configure` is module state, and each test file has
 * its own copy under Vitest's isolation, so this reaches no other suite either way.
 */
const WALL_SETTLES_MS = 5000;
let defaultAsyncTimeout = 1000;
beforeAll(() => {
  defaultAsyncTimeout = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: WALL_SETTLES_MS });
});
afterAll(() => configure({ asyncUtilTimeout: defaultAsyncTimeout }));

beforeEach(() => {
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  // One deck, no folders — the shape the menu's deck picker draws as a single row. Answered
  // rather than seeded into the cache: `useDecks` has no `staleTime`, so a seeded entry is
  // refetched on mount and the command is what the picker ends up drawing either way.
  deckList.mockReset().mockResolvedValue([BURN]);
  deckFolderList.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue({ deck: BURN, cards: [], categories: [], labels: [] });
  deckAddCard.mockReset().mockResolvedValue(undefined);
  // No taxonomy downloaded is the floor rather than an error: `autoCategoryFor` then files by
  // type line, which is exactly what the case below is about.
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  collectionList.mockReset().mockResolvedValue(page([BOLT]));
  collectionSummary.mockReset().mockResolvedValue(summary({ totalCards: 2, uniqueCards: 1 }));
  collectionSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 3, removed: false });
  collectionRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
  // The edited row, kept — `collection_update` is the one write in the module that leaves a row
  // at a quantity of zero, and it answers the id it edited unless the edit folded the row onto a
  // neighbour. Nothing on this page reads the answer beyond the fact that it resolved.
  collectionUpdate.mockReset().mockResolvedValue({ id: 7, quantity: 2, removed: false });
  listSets.mockReset().mockResolvedValue([]);
  prewarmCollection.mockReset().mockResolvedValue(0);
  // TCGplayer unless a test says otherwise — the default, and what every `$` below asserts.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  // One printing, so a one-line paste resolves to something the collection's own preview can
  // plan and commit. `resetImportDefaults` below is what keeps a written default from bleeding
  // between tests, since `importDefaults` lives in the store rather than in this component.
  importResolve.mockReset().mockResolvedValue([{ index: 0, matched: SOL_RING, hintMissed: false }]);
  collectionImportCommit.mockReset().mockResolvedValue({ added: 1, updated: 0, removed: 0 });
  // **A collection nobody has filed is the default**, which is what every test written before the
  // folders assumes: no breadcrumb, one shelf (Not sorted), and the whole binder on screen. The
  // folder tests below say otherwise for themselves.
  collectionFolderList.mockReset().mockResolvedValue([]);
  collectionFolderSummary.mockReset().mockResolvedValue([]);
  collectionFolderCreate.mockReset().mockResolvedValue(BINDER);
  collectionFolderRename.mockReset().mockResolvedValue(BINDER);
  collectionFolderMove.mockReset().mockResolvedValue(BINDER);
  // The whole cabinet, flat, is what `collection_folder_reorder` answers — but the hook settles by
  // invalidating the folder list rather than seeding the cache from it, so what it resolves with
  // reaches nothing here and the empty array is the honest fixture.
  collectionFolderReorder.mockReset().mockResolvedValue([]);
  collectionFolderDelete.mockReset().mockResolvedValue(undefined);
  // The re-read row the command answers with. It reaches nothing on screen — the hook settles by
  // invalidating `["collection"]` rather than seeding from the answer — so what matters here is
  // that the promise resolves rather than what is in it.
  collectionFolderSetLocked.mockReset().mockResolvedValue({ ...BINDER, locked: true });
  collectionSetFolder.mockReset().mockResolvedValue({ id: 7, quantity: 2, removed: false });
  collectionRemovedClear.mockReset().mockResolvedValue(0);
  // Counts derived from whatever the list answers, over the shelves the query names — see
  // `shelfCountsOf`. `getMockImplementation` reads the list mock without recording a call, so
  // `lastQuery()` still reads the list's own last request.
  collectionShelfCounts.mockReset().mockImplementation(async (query: CollectionQuery) => {
    const list = collectionList.getMockImplementation();
    const answer = (list ? await list({ ...query, limit: 500, offset: 0 }) : page([])) as {
      items: CollectionRow[];
    };
    return shelfCountsOf(answer.items, query.shelves);
  });
  // Nothing folded: every shelf opens on its kind's default.
  shelfFolds.mockReset().mockResolvedValue({ collection: {}, wishlist: {} });
  setShelfFolds.mockReset().mockResolvedValue(undefined);
  // One printing on the sidebar's wall, so every case has a tile to press or drag without saying
  // so — and so the ones that are not about the sidebar meet the same page a reader does.
  searchCards.mockReset().mockResolvedValue(searchPage([SEARCH_LOTUS]));
  // The stored disclosure, answered rather than left to the default: a resolved command and a
  // resolved default are the same picture here but not the same moment, and the map is what the
  // shipped read returns. `{}` would say the same thing — a section the row is silent about falls
  // back to `DEFAULT_SEARCH_OPEN` — and naming the section is what makes the fixture readable.
  searchOpen.mockReset().mockResolvedValue({ collection: true });
  setSearchOpen.mockReset().mockResolvedValue(undefined);
  // **A supporter is the default**, so the Share control is on screen for every case below and
  // the block that is about its absence says otherwise for itself. Nothing published yet: an
  // empty list is what a device that has never pressed Share reads back, and `share_list`
  // answers its cache rather than refusing when there is no membership behind it.
  shareList.mockReset().mockResolvedValue([]);
  shareCreate.mockReset().mockResolvedValue(undefined);
  shareRefresh.mockReset().mockResolvedValue(undefined);
  shareRevoke.mockReset().mockResolvedValue(undefined);
  shareOpen.mockReset().mockResolvedValue(undefined);
  syncSupporterStatus
    .mockReset()
    .mockResolvedValue({ entitled: true, status: "active", since: 1_750_000_000, groupBound: true });
  useAppStore.setState({
    collectionView: "table",
    selectedCardId: null,
    // **Reset beside `selectedCardId`, because the two are one answer.** The wall's ring is a
    // composite of the open card and the finish the pane was opened as, so a `paneFinish` left
    // behind by the case before would ring the wrong tile of the next case's printing.
    paneFinish: null,
    // **And the picked set, which a plain click on a tile writes.** `useCardSelection` keeps one
    // app-wide selection scoped by a string, so a case that presses a tile leaves `collection`
    // holding that tile's key — and the next case's wall rings it, because `CardGrid` draws one
    // gold ring for the pane's card *and* for every picked tile.
    cardSelection: null,
    // The store's own opening state, which moved with this PR: an import line whose file is
    // silent lands on `NONE` rather than on Near Mint. **A persisted `NM` is deliberately
    // left alone** by that change — a reader who has one chose it, or lived with it — so
    // this line is the fresh install rather than every reader.
    importDefaults: { condition: "NONE", finish: null },
    // **The folder hand-off, which this page *consumes* — so a case that left one written would
    // open the next case's page inside a drawer nothing asked for.** Store state outlives
    // `cleanup()`, as every field here does, and the block that is about the hand-off writes one
    // in every case.
    pendingFolder: null,
    // **The needs-review hand-off, for the folder's reason one line up** — this page consumes it,
    // and a case that left one written would open the next case on the flagged rows.
    pendingReviewFilter: null,
  });
});

describe("CollectionPage", () => {
  /**
   * An empty collection is not a failed search. "No cards match" would blame the reader for
   * a table nobody has put anything in yet, and say nothing about how to.
   */
  it("explains an empty collection instead of blaming the reader for it", async () => {
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);

    expect(
      await screen.findByText(/nothing here yet\. add cards from search, or import a collection/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/match these filters/i)).not.toBeInTheDocument();
  });

  /** With a filter on, an empty answer *is* about the filter — and says so instead. */
  it("blames the filters when a filtered collection comes back empty", async () => {
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);
    await screen.findByText(/nothing here yet/i);

    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Foil" }));

    expect(
      await screen.findByText(/no cards in your collection match these filters/i),
    ).toBeVisible();
  });

  /**
   * Spec §5's pre-warm, from the one screen that knows the collection has anything in it:
   * the art for every owned and wished card is fetched in the background so the wall browses
   * without a network. Once per session — the backend skips what is already on disk, but a
   * call per re-render would still be a round trip per re-render.
   */
  it("warms the images for what the user owns, once, on the first load that has rows", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await waitFor(() => expect(prewarmCollection).toHaveBeenCalledTimes(1));

    // A filter click re-renders and re-fetches; the warm must not go again with it.
    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Foil" }));
    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(1));
    expect(prewarmCollection).toHaveBeenCalledTimes(1);
  });

  /** Nothing owned is nothing to warm, and a first launch should not spend a round trip
   *  finding that out. */
  it("does not warm anything for an empty collection", async () => {
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);
    await screen.findByText(/nothing here yet/i);

    expect(prewarmCollection).not.toHaveBeenCalled();
  });

  /** A pre-warm is best-effort background work: a refusal must never reach the user as an
   *  unhandled rejection, and must not disturb the list it ran behind. */
  it("swallows a failed pre-warm", async () => {
    prewarmCollection.mockRejectedValue("no such command");
    wrap(<CollectionPage />);

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * **One Value figure, not the pair this header used to draw.**
   *
   * Two totals for one collection was two answers to the question this row exists to answer,
   * and it was only there because there was no way for a reader to *say* which one they
   * wanted. The setting is that way, so the header quotes the marketplace they picked and the
   * other currency is not on screen at all.
   */
  it("adds the collection up in the selected currency, and says whose prices they are", async () => {
    collectionSummary.mockResolvedValue(
      summary({ totalCards: 1240, uniqueCards: 812, value: 9876.5 }),
    );
    wrap(<CollectionPage />);

    expect(await screen.findByText("1,240")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("$9,876.50")).toBeInTheDocument();
    expect(screen.queryByText("Value (EUR)")).not.toBeInTheDocument();

    // Spec §5: no price on screen without saying how old it is — and, with five marketplaces
    // in the picker, whose it is. The header has no room for the sentence beside the figures,
    // so it rides on the figure it is about — `Figure`'s own `title` prop, bound through
    // `useTooltip()` since the tooltip sweep rather than a native attribute.
    const figure = screen.getByText("Value (USD)").closest("div") as HTMLElement;
    await userEvent.hover(figure);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(panel).toHaveTextContent(pricesAsOf(MARKETPLACES.tcgplayer));
    expect(figure).toHaveAttribute("aria-describedby", panel.id);
    await userEvent.unhover(figure);
  });

  /**
   * The other side of the same switch: Cardmarket's figure, Cardmarket's label, Cardmarket's
   * sentence — and no dollars anywhere.
   *
   * **The euro figure is a different answer to the same query, not a second field.** The
   * marketplace is in `collection_summary`'s payload and in the query's key, so switching
   * re-runs the aggregate; the mock therefore answers a different number rather than the same
   * object with a second key on it.
   */
  it("adds it up in euros when the marketplace is Cardmarket", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionSummary.mockResolvedValue(
      summary({ totalCards: 1240, uniqueCards: 812, value: 8100 }),
    );
    wrap(<CollectionPage />);

    await waitFor(() => expect(screen.getByText("€8,100.00")).toBeInTheDocument());
    const figure = screen.getByText("Value (EUR)").closest("div") as HTMLElement;
    await userEvent.hover(figure);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(panel).toHaveTextContent(pricesAsOf(MARKETPLACES.cardmarket));
    await userEvent.unhover(figure);
  });

  /**
   * A total that silently omits the cards it has no price for is a number that lies by
   * rounding down — **and the count belongs to the figure beside it.**
   *
   * No two marketplaces have the same holes: `eur_etched` does not exist in Scryfall's data, so
   * an etched printing is priced on TCGplayer and unpriced on Cardmarket at once, and a card a
   * bulk feed has never listed is unpriced on that feed alone. Rust counts at the marketplace
   * it summed at, so the note is never about another one's gaps.
   */
  it("shows how many copies the value could not price", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 1240, value: 100, unpriced: 2 }));
    wrap(<CollectionPage />);

    expect(await screen.findByText("2 unpriced")).toBeInTheDocument();
  });

  it("shows the other marketplace's own unpriced count when it is chosen", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionSummary.mockResolvedValue(summary({ totalCards: 1240, value: 100, unpriced: 7 }));
    wrap(<CollectionPage />);

    await waitFor(() => expect(screen.getByText("7 unpriced")).toBeInTheDocument());
    expect(screen.queryByText("2 unpriced")).not.toBeInTheDocument();
  });

  it("leaves the unpriced note off when everything has a price", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 3, value: 10 }));
    wrap(<CollectionPage />);

    await screen.findByText("$10.00");
    expect(screen.queryByText(/unpriced/i)).not.toBeInTheDocument();
  });

  /**
   * A collection table is where quantities are *maintained*: making the reader open an
   * editor to change a 3 to a 4 is the difference between a tool and a form.
   */
  it("writes a quantity straight through from the row", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    const step = screen.getByRole("button", {
      name: "Increase Quantity of Lightning Bolt (Foil, NM)",
    });
    await userEvent.click(step);

    expect(collectionSetQuantity).toHaveBeenCalledWith(7, 3);
    // The row's own number follows the press rather than the round trip.
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ })).toHaveValue(3),
    );
    // Three copies at $400.50 — the value column is arithmetic over the number that moved.
    expect(screen.getByText("$1,201.50")).toBeInTheDocument();
  });

  /**
   * A row is the printing it lists, and can be carried off it — spec §1's second source.
   *
   * What it carries is the *card*, not the entry: a deck names a printing, and the finish and
   * condition that make this row an entry are the collection's own business (which is also
   * why the collection is never a drop *target*). This asks the drag rather than the attribute a
   * registered source wears, because a registration that closed over the wrong row would still
   * set it.
   */
  it("carries the row's printing when the row is dragged", async () => {
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    const rows = cardSources(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Lightning Bolt");

    const drags = recordDrags();
    const held = await holdCopy(rows[0], { pressOn: screen.getByText("Lightning Bolt") });
    // Asked while the drag is still up: `started` is a live reading of the manager's own
    // operation rather than a remembered one, so after a cancel it is false for every drag there
    // has ever been.
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records.map(readDragData)).toEqual([
      { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
  });

  /**
   * **A press on the stepper is a press on the stepper.**
   *
   * The whole row is the drag handle and the row is full of controls, so this is the failure
   * that costs a reader their counts: a pointer sensor listens on the row, so a press on `−`
   * that travels five pixels would drag the row and the press would never be delivered as a
   * click. `dndManager.ts` configures `PointerSensor.preventActivation` with the app's own
   * `NOT_A_DRAG` selector, once, for every draggable in the window — so the guard reads where
   * the *press* landed, which is why this presses one place and drags from another, exactly as
   * a reader's hand does.
   */
  it("does not drag a row when the press landed on its stepper", async () => {
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const row = cardSources(container)[0];

    const held = await holdCopy(row, {
      pressOn: screen.getByRole("button", {
        name: "Decrease Quantity of Lightning Bolt (Foil, NM)",
      }),
    });
    expect(held.started).toBe(false);
    await held.cancel();

    // And the row itself still is one: the guard is a control's press, not a row's. Asked before
    // the cancel, because `started` is a live reading of the manager's operation rather than a
    // remembered one.
    const again = await holdCopy(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * Everything else that counts these copies. The header is re-read because a wrong total is
   * a worse lie than a slow one, and the *wishlist* is re-read because a wish's
   * `ownedQuantity` is computed from `collection_entries` — a stepper press has just made
   * every cached wish for this card wrong. The same pair the quick-add invalidates.
   */
  it("re-reads the header and the wishlist after a write, and marks the search stale", async () => {
    const { client } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Foil, NM)" }),
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection", "summary"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    // And refetched, not merely marked: Task 12's badges put `ownedQuantity` on every result
    // row, so a search left on screen behind this write is now visibly wrong rather than
    // stale in a field nothing draws.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    // And every deck: a deck owns what its own group holds, summed per oracle id, so a copy
    // stepped away from a deck's group has just changed what that deck reads as owning — and
    // the shortfall its "missing to wishlist" button would push. A copy stepped away from
    // outside one moves the theory list's spare column instead.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    // And the header really is re-read — not just marked.
    await waitFor(() => expect(collectionSummary).toHaveBeenCalledTimes(2));
    // The list is not: the row's own number came back from the write, and re-reading a
    // hundred rows because one changed by one is a round trip nobody is waiting for.
    expect(collectionList).toHaveBeenCalledTimes(1);
  });

  /**
   * The rule since schema v24, which reverses the one this test was written under:
   * `set_quantity(0)` **deletes** the row — its condition, its purchase price and its whole
   * acquisition story with it — and answers `removed: true`. So the list drops it on the
   * answer, exactly as it does for an explicit removal, and no second command is sent.
   *
   * **The mock is as much the subject here as the assertion is.** It answered `removed: false`
   * for a while after the reversal — a response the backend cannot produce any more — and that
   * is a green test drawn over a ghost: the entry was gone from SQLite, the header (which
   * `settle` re-reads) had already stopped counting it, and the table went on drawing the row
   * until a filter change or a reload, with a `+` on it answering GONE.
   */
  it("drops a row the stepper empties to zero, because zero deletes it", async () => {
    collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: true });
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 1 }]));
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    // And the reader is told where the way out is before they look for one: the stepper is it,
    // and the sentence under the table is the whole of what says so.
    expect(screen.getByText(/to remove an entry, set its copies to zero/i)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Decrease Quantity of Lightning Bolt (Foil, NM)" }),
    );

    expect(collectionSetQuantity).toHaveBeenCalledWith(7, 0);
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
    // And on the one command: the delete happened inside `collection_set_quantity`, so a
    // second write here would be the page removing a row that is already gone.
    expect(collectionRemove).not.toHaveBeenCalled();
  });

  /**
   * The other write, whose failure path was missing entirely: a removal the backend refuses
   * is the same story as a stepper press it refuses — a row something else already changed —
   * and it has to reach the same three lists. Without it the row stayed on screen with no
   * word about why, and the header went on counting it.
   */
  it("re-reads every list that counts these copies when a removal is refused", async () => {
    // The stepper is not pressed here — the fixture below is what puts a row at zero on screen
    // — but the answer is the one the backend would actually give if it were: since v24 a
    // quantity of 0 comes back `removed: true`, and a mock saying otherwise is a shape nothing
    // can produce.
    collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: true });
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 0 }]));
    collectionRemove.mockRejectedValue("That collection entry is not there any more.");
    const { client } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(Foil, NM\) from your collection/,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/not there any more/i);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    // And the row is still there — the removal did not happen, so the list must not pretend
    // it did.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /** A row something else already deleted answers GONE, and the reader has to hear it — a
   *  stepper that silently does nothing is a stepper the reader presses again. */
  it("says so when the row a stepper writes to is not there any more", async () => {
    collectionSetQuantity.mockRejectedValue("That collection entry is not there any more.");
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Foil, NM)" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not there any more/i);
    // And the number goes back to what the collection actually holds.
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: /Quantity of Lightning Bolt/ })).toHaveValue(2),
    );
    // The whole view, not just the list: a collection that has lost a row has also lost the
    // copies, the value and the unique count that row was part of. Seen live — the header
    // went on counting a deleted entry until the refusal reached past the table.
    await waitFor(() => expect(collectionSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(collectionList).toHaveBeenCalledTimes(2));
  });

  it("offers the flagged rows when a sync left any behind", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 2, needsReview: 3 }));
    wrap(<CollectionPage />);

    // The region is mounted with the view and the banner is swapped into it — a live region
    // that arrives together with its own text announces nothing, because nothing changed for
    // a screen reader to notice.
    const banner = screen.getByRole("status", { name: /needs review/i });
    await waitFor(() => expect(banner).toHaveTextContent("3"));

    await userEvent.click(within(banner).getByRole("button", { name: /show them/i }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    // The list is those rows now, so the banner has nothing left to offer — and the region
    // it lived in stays, empty.
    await waitFor(() => expect(banner).toBeEmptyDOMElement());
    expect(banner).toBeInTheDocument();
  });

  it("says nothing about review when nothing is flagged", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("status", { name: /needs review/i })).toBeEmptyDOMElement();
  });

  /**
   * The third state the chip gained, and the one place the banner's guard has to be exact.
   *
   * It is hidden for `true` and only for `true` — `!== true`, not a falsy test. The reason it
   * hides is that the list *is* the answer, and that is true of exactly one of the three
   * states: under `false` the reader is looking at the healthy rows, which is the opposite of
   * the answer, so three entries still needing attention is news and Show them is one click
   * from them. A guard of `=== undefined` would have swallowed the offer precisely where it
   * is most worth making.
   */
  it("hides the banner only while the reader is looking at the flagged rows", async () => {
    collectionSummary.mockResolvedValue(summary({ totalCards: 2, needsReview: 3 }));
    wrap(<CollectionPage />);
    const banner = screen.getByRole("status", { name: /needs review/i });
    await waitFor(() => expect(banner).toHaveTextContent("3"));

    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    expect(banner).toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(false));
    expect(screen.getByRole("button", { name: "Not flagged" })).toBeInTheDocument();
    expect(banner).toHaveTextContent("3");
    // And it still goes where it says: pressing it from the complement lands on the flagged
    // rows rather than cycling the chip to the next state.
    await userEvent.click(within(banner).getByRole("button", { name: /show them/i }));
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
  });

  /**
   * The row a Scryfall update orphaned: `cards` knows nothing about it any more, so every
   * card-derived column is null — and the entry's own denormalized set and number are what
   * keep it a row the reader can recognise.
   */
  it("keeps a flagged orphan identifiable, and prints what happened to it", async () => {
    collectionList.mockResolvedValue(
      page([
        {
          ...BOLT,
          name: null,
          setName: null,
          rarity: null,
          manaCost: null,
          typeLine: null,
          unitPrice: null,
          needsReview: REVIEW_NOTE,
        },
      ]),
    );
    wrap(<CollectionPage />);

    const row = (await screen.findByText(/LEA · 161/)).closest('[role="row"]') as HTMLElement;
    const band = within(row).getByText(REVIEW_NOTE);
    expect(within(row).getByText("Needs review:")).toBeInTheDocument();
    // The band is one line and the sentence is 175 characters, so what is on screen is the
    // half that says what happened and not the half that says what to do about it. The whole
    // of it is one hover away — and a screen reader reads the text, never the clip (proven by
    // `getByText` above, since a screen reader reads text and not `title`).
    //
    // `whenClipped` pinned, the direction that stays shut: jsdom lays nothing out, so the
    // band's `scrollWidth`/`clientWidth` are both `0` here by default — unclipped — and
    // `TooltipProvider.enter()`'s `whenClipped` guard returns before arming the open timer at
    // all. Waiting past `TOOLTIP_OPEN_MS` and finding nothing is what actually pins the option:
    // a plain `tip(row.needsReview, { interactive: true })` with `whenClipped` dropped would
    // open here identically, just 400ms later, so asserting immediately would not tell the two
    // apart.
    fireEvent.pointerEnter(band);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 150));
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toBeNull();
    fireEvent.pointerLeave(band);

    // The hover affordance itself, `whenClipped` pinned the other direction: `scrollWidth`/
    // `clientWidth` are faked the way `tooltip.test.tsx` stands in for a real clip.
    // `whenClipped` wins over `interactive`'s own default, so the open panel is
    // `describes: false` and carries no `role="tooltip"` (it would double what a screen reader
    // already has from the band's own text) — found by `TOOLTIP_PANEL_ID` instead, the one
    // stable id the provider ever draws.
    Object.defineProperty(band, "scrollWidth", { value: 200, configurable: true });
    Object.defineProperty(band, "clientWidth", { value: 100, configurable: true });
    fireEvent.pointerEnter(band);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    const panel = document.getElementById(TOOLTIP_PANEL_ID) as HTMLElement;
    expect(panel).toHaveTextContent(REVIEW_NOTE);
    // `interactive` pinned: the panel takes its own pointer events and its text can be
    // selected, which a bare `whenClipped` tooltip does not — without this option a
    // `pointer-events-none` panel would still pass every assertion above unchanged.
    expect(panel).toHaveClass("select-text");
    expect(panel).not.toHaveClass("pointer-events-none");
    fireEvent.pointerLeave(band);

    // A price the data does not have is a dash, never an invented `$0.00`.
    expect(within(row).queryByText(/\$/)).not.toBeInTheDocument();
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("sends the collection's own filters and its sort", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Etched" }));
    await userEvent.click(screen.getByRole("button", { name: /^LP/ }));
    await pickPageSort(user, "Highest price");

    await waitFor(() => {
      const q = lastQuery();
      expect(q.finishes).toEqual(["etched"]);
      expect(q.conditions).toEqual(["LP"]);
      // The select sets one term, and the direction is the column's own first — "Highest
      // price" is the label, so descending is what it means.
      expect(q.sort).toEqual([{ key: "price", dir: "desc" }]);
      expect(q.limit).toBe(100);
    });
    // The header describes the same rows as the table under it, or it is worse than no
    // header at all.
    const asked = collectionSummary.mock.calls[collectionSummary.mock.calls.length - 1][0];
    expect(asked).toMatchObject({ finishes: ["etched"], conditions: ["LP"] });
  });

  /**
   * The select and the headers are one state seen from two ends. Picking from the select
   * replaces the sort; a header refines it; and once the sort starts somewhere the select
   * has no option for — the Value column, which is unit × copies rather than the unit price
   * the select offers — it says so rather than showing an order that is not the one running.
   */
  it("drives one sort from the headers and the select together", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    // **It opens on the order it is actually in, and `Custom…` is not there to open on.** The
    // trap this guards has changed shape but not gone away: a controlled `<select>` whose value
    // matched no option silently reported the **first** one — alphabetically `Highest price`
    // here — and a `Dropdown` draws its placeholder dash instead. Either way "the sort is name
    // order" and "the control fell back" look identical on screen, so the trigger's own text is
    // what tells them apart. Read as text rather than `toHaveValue`, which a `<button>` has none
    // of: the trigger says the picked row's **label**, not its key.
    expect(sortSelect()).toHaveTextContent("Name");
    // Closed, so there are no rows at all — which is the honest form of this assertion now. A
    // `Dropdown` renders its listbox only while open, so a `queryByRole("option")` here proves
    // the panel is shut rather than proving `Custom…` is absent from it.
    expect(screen.queryByRole("option", { name: "Custom…" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copies" }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    // A header the select also offers reads back on it.
    expect(sortSelect()).toHaveTextContent("Most copies");

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastQuery().sort).toEqual([
        { key: "quantity", dir: "desc" },
        { key: "value", dir: "desc" },
      ]),
    );

    // Still "Most copies": the select reads the sort's *first* term, and that is still one
    // it knows.
    expect(sortSelect()).toHaveTextContent("Most copies");

    // Now start from Value alone, which the select has no option for at all.
    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "value", dir: "desc" }]));
    expect(sortSelect()).toHaveTextContent("Custom…");
    await openPageSort(user);
    expect(screen.getByRole("option", { name: "Custom…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * **The Value column follows the marketplace, unit price and all.**
   *
   * The `ea` line under the total is the one that would go unnoticed: it is only drawn on
   * multi-copy rows, so a currency mix-up there survives every single-copy fixture in this
   * file.
   */
  it("prices the Value column in the selected currency", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 3, unitPrice: 350 }]));
    wrap(<CollectionPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(screen.getByText("€1,050.00")).toBeInTheDocument());
    expect(screen.getByText("€350.00 ea")).toBeInTheDocument();
  });

  /**
   * A row the selected marketplace does not quote — an etched printing on Cardmarket, where
   * `eur_etched` does not exist, or a printing a bulk feed has never listed — arrives with a
   * `null` unit price, so its Value cell is an em dash and no `ea` line is drawn under a total
   * that does not exist. Nothing is borrowed from anywhere: there is no other number on the row.
   */
  it("shows an em dash for a row this marketplace does not price", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    // At the root: the Folder column that drew a second em dash for a copy filed nowhere went with
    // shelves (the band above the row names the drawer), so the Value cell's dash is the only one
    // on the row wherever the copy is filed.
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 3, unitPrice: null }]));
    wrap(<CollectionPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
    expect(screen.queryByText(/ea$/)).not.toBeInTheDocument();
  });

  /**
   * **A zero-copy row is a shipped state, not a corner case**, and it is the other end of the
   * same rule. The stepper is `min={0}` and the Actions column exists solely to offer a delete
   * on the row that reaches it, so the reader who empties a row sits looking at it — and a
   * `$350.00 ea` under a total of `$0.00` quotes a price for cards that are not there. The
   * wishlist's twin cell guards on `> 1` for exactly this, and was seen live before it did.
   */
  it("draws no unit price under a zero-copy row", async () => {
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 0, unitPrice: 350 }]));
    wrap(<CollectionPage />);

    // Scoped to the row: an empty collection's summary quotes `$0.00` too, and the assertion
    // that matters is which of the two cells drew it.
    const row = (await screen.findByText(/LEA · 161/)).closest('[role="row"]') as HTMLElement;
    await waitFor(() => expect(within(row).getByText("$0.00")).toBeInTheDocument());
    expect(within(row).queryByText(/ea$/)).not.toBeInTheDocument();
  });

  /**
   * **The marketplace crosses the wire on every read, not only a money-sorted one.**
   *
   * It used to be a `currency` sent only while a money column was deciding the order, because
   * everything else about a price was decided on this side off the twin fields every row
   * carried. It decides the *figures* now — Card Kingdom's numbers come out of a different
   * table from TCGplayer's — so it is on every payload and in every key, and a Value column
   * cannot end up ordered in one marketplace's money while printing another's.
   */
  it("sends the marketplace on every read, sorted by money or not", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(lastQuery().marketplace).toBe("cardmarket"));

    await user.click(screen.getByRole("button", { name: /^Copies/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    expect(lastQuery().marketplace).toBe("cardmarket");

    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "value", dir: "desc" }]));
    expect(lastQuery().marketplace).toBe("cardmarket");
  });

  /**
   * The wall is a wall of *objects*: a foil and a played nonfoil of one printing are two pieces
   * of art, and each badge counts **that finish's** copies.
   *
   * **Two expectations moved with the grain on 2026-08-26 and the fixture did not.** This read
   * "two entries for one printing are one tile carrying what the reader owns of it" and asserted
   * one piece of art badged `3`; the finish is part of the wall's key now, so the same two rows
   * draw two pieces of art badged `2` and `1`. That is the change rather than a regression — the
   * tile is what a price is quoted under, and there is no honest single figure for two objects
   * that cost different money.
   */
  it("shows the collection as art, badged with how many of that finish are owned", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const { container } = wrap(<CollectionPage />);

    const art = await screen.findAllByAltText("Lightning Bolt");
    expect(art).toHaveLength(2);
    expect(screen.getByText("2 in your collection")).toBeInTheDocument();
    expect(screen.getByText("1 in your collection")).toBeInTheDocument();
    // One backing per tile, not two. The wall owns the corner and the table felt behind a mark,
    // and the mark it is handed is plain — a pill inside a pill painted the felt over itself and
    // doubled the horizontal padding on a 170px tile.
    //
    // **Scoped past `data-card-marks`**, and that is the third expectation this change moved:
    // that attribute is `CardArt`'s own top-right chip, which carries the same felt, and the
    // wall started passing a `finish` on 2026-08-26 — so a bare `bg-bg/85` sweep would count
    // that chip alongside the two badges this line is about.
    //
    // **This wording was itself the tell for a defect.** It read "the foil tile's sparkle",
    // singular, over a fixture whose *both* tiles carried the chip: passing `"nonfoil"` straight
    // through drew an empty one over the plain copy. It is singular and true now, because the
    // slot maps nonfoil to `null` — see the chip case above, which is the assertion that pins it.
    // This scope narrows past `CardArt`'s corner and nothing else; it never hid the badge.
    expect(
      offPanel(
        container.querySelectorAll('[data-grid-index] [class*="bg-bg/85"]:not([data-card-marks])'),
      ),
    ).toHaveLength(2);
  });

  /**
   * A row at zero copies is a real row — the table offers removal *only* there — so the wall
   * has to answer for one, and "×0" over the art is a sticker that says nothing. The guard
   * is `OwnedBadge`'s, which is the whole reason this view shares it instead of keeping a
   * second badge that never asked the question.
   */
  it("draws no mark on a tile the reader owns none of", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 0 }]));
    const { container } = wrap(<CollectionPage />);

    await screen.findByAltText("Lightning Bolt");
    expect(screen.queryByText("×0")).not.toBeInTheDocument();
    expect(screen.queryByText(/in your collection/)).not.toBeInTheDocument();
    // And no corner either: the backing collapses on a mark that rendered nothing, so a wall
    // of unowned tiles is not a wall of empty chips. (`CardGrid`'s own test pins the rule.)
    //
    // **Scoped past `data-card-marks` on 2026-08-26**, for the reason the badge count above
    // gives: `CardArt`'s finish chip carries the same felt, `BOLT` is a foil, and this wall
    // draws a finish now — so the unscoped query answered about that chip, which is first in
    // document order, rather than about the badge corner, and read as the corner having grown
    // content it had not.
    expect(
      container.querySelector('[data-grid-index] [class*="bg-bg/85"]:not([data-card-marks])'),
    ).toBeEmptyDOMElement();
  });

  /* ---------------------------------------------------------------------------------------- *
   * The wall's grain: a printing **and a finish**, with that finish's own price under it
   * ---------------------------------------------------------------------------------------- */

  /**
   * The tile a given price is drawn on — the wall's own outer box, which is what
   * {@link cardSources} matches and what carries the art, the badge and the chin between them.
   *
   * By the money rather than by the name, because the two tiles of one printing carry the same
   * name and the price is the whole of what tells them apart on screen.
   */
  const tileQuoting = (money: string): HTMLElement =>
    screen.getByText(money).closest(`[${DND_SOURCE_ATTR}]`) as HTMLElement;

  /**
   * A foil and a played nonfoil are two objects at two prices sharing only a set and a number.
   * The wall merged them into one piece of art and had no honest price to put under it.
   */
  it("draws a foil and a nonfoil of one printing as two priced tiles", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, finish: "foil", quantity: 1, unitPrice: 9 },
        { ...BOLT, id: 8, finish: "nonfoil", quantity: 2, unitPrice: 1 },
      ]),
    );
    wrap(<CollectionPage />);

    expect(await screen.findAllByAltText("Lightning Bolt")).toHaveLength(2);
    expect(screen.getByText("$9.00")).toBeInTheDocument();
    expect(screen.getByText("$1.00")).toBeInTheDocument();
  });

  /**
   * **A plain copy draws no chip at all, and this wall is where the app first had to say so.**
   *
   * Passing a tile's finish straight through made this the first production caller to hand
   * `CardGrid`'s `finish` slot the word `"nonfoil"`. `CardArt` gates its corner chip on
   * `finish !== null` while `FinishMark` early-returns for a plain copy with no treatment — so
   * the `bg-bg/85` felt got painted with nothing inside it: an empty rectangle over the art, on
   * most tiles of most collections.
   *
   * The convention it broke is the codebase's own, and it is written down in two places already:
   * `soleFinish` maps nonfoil to `null`, and `DeckFinish` excludes the word outright. Both exist
   * so that "plain" never reaches a slot whose job is to draw a mark.
   *
   * **Asserted on `data-card-marks`**, which is that chip and is on exactly one element in the
   * app. The two `bg-bg/85` sweeps above deliberately scope *past* it, so neither of them could
   * ever have caught this — which is why it is a case of its own rather than a line in one.
   */
  it("draws a finish chip on a foil tile and none at all on a plain one", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, finish: "nonfoil", unitPrice: 1 },
        { ...BOLT, id: 8, finish: "foil", unitPrice: 9 },
      ]),
    );
    const { container } = wrap(<CollectionPage />);
    await screen.findAllByAltText("Lightning Bolt");

    expect(container.querySelectorAll("[data-card-marks]")).toHaveLength(1);
    expect(tileQuoting("$1.00").querySelector("[data-card-marks]")).toBeNull();
    expect(tileQuoting("$9.00").querySelector("[data-card-marks]")).not.toBeNull();
  });

  /**
   * **Review Focus 1: one printing filed in two folders is a tile on each shelf** (decision 11).
   * The flattened wall merged copies across folders into one tile; on shelves a tile belongs to
   * one shelf, so each shelf draws its own, each badged with that shelf's own copies — and one
   * price each, since both are the same finish.
   */
  it("draws one printing filed in two folders as a tile on each shelf, each with its own count", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, finish: "nonfoil", folderId: null, quantity: 1, unitPrice: 1 },
        {
          ...BOLT,
          id: 8,
          finish: "nonfoil",
          folderId: 3,
          folderName: "Trade binder",
          quantity: 3,
          unitPrice: 1,
        },
      ]),
    );
    const { container } = wrap(<CollectionPage />);

    expect(await screen.findAllByAltText("Lightning Bolt")).toHaveLength(2);
    expect(screen.getByText("1 in your collection")).toBeInTheDocument();
    expect(screen.getByText("3 in your collection")).toBeInTheDocument();
    expect(screen.getAllByText("$1.00")).toHaveLength(2);
    // Each under its own heading: Not sorted's tile, then Trade binder's heading, then its tile.
    const [loose, filed] = cardSources(container);
    expect(follows(heading("Not sorted"), loose)).toBe(true);
    expect(follows(loose, heading("Trade binder"))).toBe(true);
    expect(follows(heading("Trade binder"), filed)).toBe(true);
  });

  /**
   * **…and opening it rings both.** The ring compares the pane's card and finish with a tile's
   * `ringKey`, which names no folder (spec §5.6) — the reader opened a printing, and every place it
   * sits on screen says so. A Ctrl-click still picks one tile, because the picked set keys on the
   * tile.
   */
  it("rings every tile of the printing and finish the pane was opened as", async () => {
    useAppStore.setState({ collectionView: "grid", selectedCardId: "c1", paneFinish: "nonfoil" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, finish: "nonfoil", folderId: null, quantity: 1 },
        { ...BOLT, id: 8, finish: "nonfoil", folderId: 3, folderName: "Trade binder", quantity: 3 },
        { ...BOLT, id: 9, finish: "foil", folderId: 3, folderName: "Trade binder", quantity: 1 },
      ]),
    );
    const { container } = wrap(<CollectionPage />);
    expect(await screen.findAllByAltText("Lightning Bolt")).toHaveLength(3);

    const ringed = cardSources(container).filter((tile) => tile.classList.contains("ring-accent"));
    expect(ringed).toHaveLength(2);
  });

  /**
   * "Clicking on a foil should display that printing, but in the foil version." The pane seeds
   * its foil view from this — there is no foil photograph to fetch, so what it turns on is
   * `FoilOverlay` over the same picture.
   */
  it("opens the pane as the finish the tile was pressed on", async () => {
    useAppStore.setState({ collectionView: "grid" });
    const user = userEvent.setup();
    collectionList.mockResolvedValue(page([{ ...BOLT, finish: "foil" }]));
    wrap(<CollectionPage />);

    await user.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(useAppStore.getState().selectedCardId).toBe("c1");
    expect(useAppStore.getState().paneFinish).toBe("foil");
  });

  /**
   * A tile that merges exactly one finish records that finish without asking — which is a fix
   * rather than a tidy-up. Before the split a tile holding a foil *and* a plain copy offered
   * both and made the reader pick, and picking wrongly on a wall of forty is one keystroke; now
   * the tile the reader pressed is already the answer.
   *
   * (This doc said "a reader owning two foils and no nonfoil used to fall to the menu's
   * unknown-list rule and get a silent **nonfoil** entry" until 2026-08-26. That was false and
   * came from the task brief, which had it from older repo prose: `ownedFinishes` has always
   * answered `["foil"]` for that reader. The unknown-list rule is reached only by a finish word
   * `FINISHES` cannot name — see `CollectionTile.finishes`, which carries the real warning.)
   *
   * Read through the menu's own write, which is what this file already uses to say what a tile
   * offered as its finish: `collection_add`'s `finish` argument is `CardMenuTarget.finishes`
   * resolved to one answer, and a `Collection` row with no submenu is that resolution happening
   * without a question.
   */
  it("names the tile's own finish to the card menu, and no longer asks which", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    // The nonfoil tile is the second: the fold keeps the order the rows arrived in, and the
    // fixture is deliberately foil-first.
    const tiles = await screen.findAllByRole("button", { name: "Lightning Bolt" });
    expect(tiles).toHaveLength(2);
    rightClick(tiles[1]);
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");
    await user.click(collection);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "nonfoil",
        // **`NONE`, and this reverses what the four cases below asserted until this PR.**
        // `MENU_CONDITION` was Near Mint — the one decision a menu made on the reader's
        // behalf, stated in the app rather than left to the backend's default. With a sixth
        // grade meaning *not set* there is nothing left for it to decide, so the quick-add
        // records silence. Spelled as the literal rather than imported: an assertion that
        // reads the same constant as the code under test cannot fail when that constant
        // moves.
        condition: "NONE",
        quantity: 1,
        folderId: null,
      }),
    );
  });

  /**
   * **The ring is about a tile, and two tiles now share one card id.** The pane's
   * `selectedCardId` alone would ring the foil and the nonfoil together for a reader who opened
   * one of them, so the wall compares a composite of the card and the finish the pane was
   * opened as.
   */
  it("rings only the tile of the finish the pane was opened as", async () => {
    useAppStore.setState({ collectionView: "grid", selectedCardId: "c1", paneFinish: "foil" });
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, finish: "foil", quantity: 1, unitPrice: 9 },
        { ...BOLT, id: 8, finish: "nonfoil", quantity: 2, unitPrice: 1 },
      ]),
    );
    const { container } = wrap(<CollectionPage />);
    await screen.findAllByAltText("Lightning Bolt");

    // The ring is on the tile's **root** since 2026-09-08 — around the art and the chin together
    // rather than around the picture alone — so these ask the tile itself where they used to
    // search inside it. The `querySelectorAll` still counts one across the whole page, which is
    // what catches a ring drawn in both places at once — scoped to the tiles, since a shelf
    // heading's controls carry focus-ring classes of their own.
    expect(cardSources(container).filter((tile) => tile.classList.contains("ring-accent"))).toHaveLength(1);
    expect(tileQuoting("$9.00").classList.contains("ring-accent")).toBe(true);
    expect(tileQuoting("$1.00").classList.contains("ring-accent")).toBe(false);
  });

  /**
   * **Spec §5: a price is never shown without saying how old it is.** This wall drew no money at
   * all until the chin landed on 2026-08-26, so the rule reaches it now where before it reached
   * only the table's Value column header — and it arrived here with no sentence anywhere, which
   * is what driving the shipped window found.
   *
   * Once, under the wall — not on forty tooltips, which is one statement made forty times and is
   * the reason the chin's money slot is a plain string.
   *
   * **Through `pricesAsOf` rather than the sentence typed out here**: spelling it would pin a copy
   * of the wording rather than the function, so a reworded sentence would go red in a place with
   * nothing to say about it while a wall drawing a *stale* sentence stayed green.
   *
   * The table is asserted to draw none of it, which is what proves this is the grid's line rather
   * than something the page draws in both views over a column header that already says it. The
   * header's own `Value (USD)` figure carries the same sentence and is **not** counted either way:
   * it is a `useTooltip()` binding, so it is an attribute and a panel that has not been opened,
   * never text on screen.
   */
  it("says how old the wall's prices are, once, under the grid", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(page([{ ...BOLT, unitPrice: 9 }]));
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    await screen.findByAltText("Lightning Bolt");
    expect(offPanel(screen.getAllByText(pricesAsOf(MARKETPLACES.tcgplayer)))).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Table view" }));

    // The table says it in the Value column's header instead — as a tooltip and an accessible
    // name, not as text — so the grid's line goes with the grid.
    expect(offPanel(screen.queryAllByText(pricesAsOf(MARKETPLACES.tcgplayer)))).toEqual([]);
  });

  /* ---------------------------------------------------------------------------------------- *
   * The wall's own stepper (issue #284)
   * ---------------------------------------------------------------------------------------- */

  /**
   * **Quantities were maintainable in the table and nowhere else**, which made the wall the
   * layout a reader looked at and the table the one they worked in. The stepper rides
   * `CardGrid`'s `action` strip over the foot of the art — the slot the search's quick-add and
   * the wishlist's pencil already use.
   *
   * Two things about it have no equivalent in the table and are what the cases below are mostly
   * about. **A tile is a sum where a row is an entry**, so the number the control shows is not
   * the number the write moves: a press is a *delta* applied to one addressed row, and the floor
   * is the copies that row cannot reach. And **not every tile gets one**: a stepper is drawn only
   * where every copy behind the art is at the root or in a drawer the reader made, because a
   * control that moved a total partly held in a deck's custody would be writing where
   * `set_entry_folder`'s `ENTRY_IN_A_DECK` exists to stop a drag.
   */
  describe("the wall's stepper", () => {
    /** Card view for every case here — the table draws its own stepper, with its own name, and
     *  the grid is the only layout this block is about. */
    beforeEach(() => useAppStore.setState({ collectionView: "grid" }));

    /**
     * A tile's stepper, by the name it announces: `Copies of <card> (<SET> <number>[, <Finish>])`.
     *
     * The finish is in the name **only where the tile wears the mark** — the wall's own rule (a
     * plain tile draws no finish chip), stated in words instead of in a sheen. It is deliberately
     * *not* the table's `Quantity of Lightning Bolt (Foil, NM)`: a row names an entry, condition
     * and all, where a tile names the object the art is a picture of.
     *
     * **The printing is matched rather than spelled**, and that is the point of the helper. A name
     * carrying `LEA 161` would pin this block to the seed's collector numbers, so every case here
     * would go red the day a fixture moved — for a reason that has nothing to do with the rule
     * being tested. What the pattern *does* assert is that the segment is there at all, which is
     * what stops the label collapsing back to the card's own name.
     */
    const ESCAPE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = (label: string) => {
      const finish = /\(([^)]+)\)$/.exec(label)?.[1] ?? null;
      const card = label.replace(/\s*\([^)]+\)$/, "");
      return `Copies of ${ESCAPE(card)} \\([^,)]+${finish ? `, ${ESCAPE(finish)}` : ""}\\)`;
    };
    const stepper = (direction: "Increase" | "Decrease", label: string) =>
      screen.getByRole("button", { name: new RegExp(`^${direction} ${named(label)}$`) });
    const box = (label: string) => screen.getByRole("spinbutton", { name: new RegExp(`^${named(label)}$`) });
    /** The same lookup where the expected answer is *nothing* — a fenced tile, or one that has
     *  left the list. `query`, so a miss is `null` rather than a throw. */
    const noBox = (label: string) =>
      screen.queryByRole("spinbutton", { name: new RegExp(`^${named(label)}$`) });

    /** Every stepper on the wall, however many tiles drew one. */
    const steppers = () => screen.queryAllByRole("spinbutton");

    /**
     * The ordinary tile: one entry behind the art, so the sum the control shows and the number it
     * writes are the same and the delta is invisible. This is the case that proves the plumbing —
     * the press reaches `collection_set_quantity` with the **entry's** id rather than the card's.
     */
    it("writes a press on a tile through to the entry behind the art", async () => {
      wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");

      await userEvent.click(stepper("Increase", "Lightning Bolt (Foil)"));

      expect(collectionSetQuantity).toHaveBeenCalledWith(7, 3);
      // And the tile's own figure follows the press rather than the round trip — the badge in the
      // corner and the box in the strip are one number, so both moved.
      await waitFor(() => expect(box("Lightning Bolt (Foil)")).toHaveValue(3));
      expect(screen.getByText("3 in your collection")).toBeInTheDocument();
    });

    /**
     * **The floor of a single-entry tile is zero, and zero is a real press.** `min` is arithmetic
     * — `tile.copies - row.quantity` — rather than a constant, so this is the arm where that
     * arithmetic lands on the table's own `min={0}`, and the consequence is the same one: since
     * schema v24 `collection::set_quantity(id, 0)` **deletes**, so the last `−` on a tile is how a
     * mis-added copy leaves. Mirrors the table's case, which is the shape this is measured
     * against.
     */
    it("floors a single-entry tile at zero, where zero deletes the entry", async () => {
      collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: true });
      collectionList.mockResolvedValue(page([{ ...BOLT, quantity: 1 }]));
      wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");

      expect(box("Lightning Bolt (Foil)")).toHaveAttribute("min", "0");
      await userEvent.click(stepper("Decrease", "Lightning Bolt (Foil)"));

      expect(collectionSetQuantity).toHaveBeenCalledWith(7, 0);
      // The tile goes with the entry — there is nothing left behind that art.
      await waitFor(() => expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument());
      // And on the one command: the delete happened inside `collection_set_quantity`.
      expect(collectionRemove).not.toHaveBeenCalled();
    });

    /**
     * **The number shown and the number written are two different things, and this is the case
     * that can only pass if the write is a delta.**
     *
     * Two entries of one printing in one finish — an NM pair and a played single — are one piece
     * of art holding three copies, and `OwnedBadge` in the corner already says `3`. So the control
     * says 3 too, because two numbers six pixels apart disagreeing about one tile is not a state
     * this wall may draw. The press then moves the **addressed row** by one: `2 - 1`, never
     * `3 - 1`. A build that sent the control's own next value would write `(7, 2)` here, which is
     * the reader asking for one fewer copy and getting one more.
     */
    it("shows a two-entry tile's sum and writes one press to the first entry behind it", async () => {
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, finish: "nonfoil", condition: "NM", quantity: 2 },
          { ...BOLT, id: 8, finish: "nonfoil", condition: "MP", quantity: 1 },
        ]),
      );
      collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 1, removed: false });
      wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");

      // One tile for the two entries — the finish is the wall's grain and the condition is not.
      expect(screen.getAllByAltText("Lightning Bolt")).toHaveLength(1);
      expect(box("Lightning Bolt")).toHaveValue(3);

      await userEvent.click(stepper("Decrease", "Lightning Bolt"));

      expect(collectionSetQuantity).toHaveBeenCalledWith(7, 1);
    });

    /**
     * **The floor is the copies this stepper cannot reach** — `tile.copies - row.quantity`, i.e.
     * everything the rows it does not address are holding. Without it the control would walk a
     * three-copy tile down to zero while writing negative numbers at one entry, and the backend
     * would clamp them into a delete of the wrong row.
     *
     * The fixture puts the addressed row at **zero copies**, which is a real state rather than a
     * contrivance: `collection_update` sends eight fields at once and must not delete its own
     * subject, so a row holding none is a shape the backend still produces and the seeded fixture
     * in `.storybook/fake/seeds.ts` carries one. There the sum *is* the floor, so `−` has nowhere
     * to go and says so by greying — while `+` still reaches the row it addresses.
     */
    it("stops a tile's minus at the copies its own entry cannot reach", async () => {
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, finish: "nonfoil", condition: "NM", quantity: 0 },
          { ...BOLT, id: 8, finish: "nonfoil", condition: "MP", quantity: 2 },
        ]),
      );
      collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 1, removed: false });
      wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");

      expect(box("Lightning Bolt")).toHaveValue(2);
      expect(box("Lightning Bolt")).toHaveAttribute("min", "2");
      expect(stepper("Decrease", "Lightning Bolt")).toBeDisabled();

      await userEvent.click(stepper("Increase", "Lightning Bolt"));
      expect(collectionSetQuantity).toHaveBeenCalledWith(7, 1);
    });

    /**
     * **The walk out of a multi-entry tile, which is a consequence of the two formulas rather
     * than a case anything special-cases.**
     *
     * Three copies as an NM single and a played pair: the floor is 2, so `−` moves the NM row to
     * zero and `collection::set_quantity` deletes it. The list drops the row on the answer — the
     * page deliberately does not re-read it — the played row becomes the first behind the art, and
     * the floor recomputes to 0 against a tile now holding 2. So the same button that had one
     * press left in it has two more.
     */
    it("re-aims at the next entry when the addressed one is stepped away", async () => {
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, finish: "nonfoil", condition: "NM", quantity: 1 },
          { ...BOLT, id: 8, finish: "nonfoil", condition: "MP", quantity: 2 },
        ]),
      );
      collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: true });
      wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");
      expect(box("Lightning Bolt")).toHaveAttribute("min", "2");

      await userEvent.click(stepper("Decrease", "Lightning Bolt"));
      expect(collectionSetQuantity).toHaveBeenCalledWith(7, 0);

      // The art stays — the tile still stands for the played pair — and the control is now aimed
      // at them, which is the whole of what the recomputed floor says.
      await waitFor(() => expect(box("Lightning Bolt")).toHaveValue(2));
      expect(box("Lightning Bolt")).toHaveAttribute("min", "0");
      expect(stepper("Decrease", "Lightning Bolt")).not.toBeDisabled();
    });

    /**
     * **A tile is a drag source and the whole of it is the handle**, so a press on `−` that
     * travels five pixels would drag the card and the press would never be delivered as a click —
     * the reader's counts, lost to a gesture they did not make. `data-no-drag` on the wrapper is
     * the whole of the fix: `NOT_A_DRAG` (`dnd.ts`) excludes fields by tag but not buttons, and
     * `cardDraggable` asks `closest()`, so one mark covers both of the stepper's.
     *
     * The table's rows carry the identical case, for the identical reason. This presses one place
     * and drags from another, exactly as a hand does.
     */
    it("does not drag a tile when the press landed on its stepper", async () => {
      const { container } = wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");
      const tile = cardSources(container)[0];

      const held = await holdCopy(tile, { pressOn: stepper("Decrease", "Lightning Bolt (Foil)") });
      expect(held.started).toBe(false);
      await held.cancel();

      // And the tile itself still is a source: the guard is a control's press, not a tile's.
      const again = await holdCopy(tile, {
        pressOn: screen.getByRole("button", { name: "Lightning Bolt" }),
      });
      expect(again.started).toBe(true);
      await again.cancel();
    });

    /**
     * **The root and the reader's own drawers are where a stepper is drawn**, which is the
     * positive half of the fence — and the half that would go red if the predicate were narrowed
     * to the root alone.
     *
     * It doubles as this block's proof that the accessible name follows the wall's finish mark: a
     * foil tile says so and a plain one does not, because the plain tile draws no chip either.
     * Both tiles are one printing, so a name without the finish in it would be two controls a
     * screen reader could not tell apart.
     */
    it("draws a stepper at the root and in a drawer the reader made", async () => {
      collectionFolderList.mockResolvedValue([BINDER]);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, finish: "foil", folderId: null, quantity: 2 },
          { ...BOLT, id: 8, finish: "nonfoil", folderId: 3, folderName: "Trade binder", quantity: 1 },
        ]),
      );
      wrap(<CollectionPage />);
      await screen.findAllByAltText("Lightning Bolt");

      expect(await screen.findByRole("spinbutton", { name: new RegExp(`^${named("Lightning Bolt")}$`) })).toHaveValue(
        1,
      );
      expect(box("Lightning Bolt (Foil)")).toHaveValue(2);
    });

    /**
     * **A copy in a deck's group is where the card physically is, and the wall may not move it.**
     *
     * Since schema v25 a deck owns what its own group holds, so a stepper there would take a card
     * out of the deck's custody without touching `deck_cards` — the deck would go on listing a
     * card whose copies had walked off. `set_entry_folder` fences the *drag* out of a deck group
     * with `ENTRY_IN_A_DECK`; this is the same boundary reached by the other gesture.
     *
     * **The binder row is not scenery.** The fence is fail-closed while the folder census is still
     * loading, so a bare "no stepper" assertion would pass over a page that had simply not
     * answered `collection_folder_list` yet — a green test for a defect. A stepper on a tile in
     * `Trade binder` can only be drawn once that census has arrived, which is what makes the
     * absence below a claim about the fence rather than about the clock.
     */
    it("draws no stepper on a tile the deck's own group holds", async () => {
      collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
      opened(DECK_GROUP.id);
      collectionList.mockResolvedValue(
        page([
          {
            ...BOLT,
            id: 7,
            finish: "nonfoil",
            folderId: 3,
            folderName: "Trade binder",
            quantity: 1,
          },
          {
            ...BOLT,
            id: 8,
            cardId: "c2",
            name: "Counterspell",
            finish: "nonfoil",
            folderId: 20,
            folderName: "Mono-Red Aggro",
            quantity: 4,
          },
        ]),
      );
      wrap(<CollectionPage />);
      await screen.findByAltText("Counterspell");

      // The sentinel: the census has answered, so a filed tile can draw one.
      expect(await screen.findByRole("spinbutton", { name: new RegExp(`^${named("Lightning Bolt")}$`) })).toHaveValue(
        1,
      );
      expect(noBox("Counterspell")).toBeNull();
      // And the tile is still a tile — badged with what the deck holds, openable, draggable.
      expect(screen.getByText("4 in your collection")).toBeInTheDocument();
    });

    /**
     * **A printing held in a binder and in a deck's group is two tiles now, and only the binder's
     * steps.** The mixed tile this case was written against — a sum partly in a deck's custody —
     * cannot be drawn any more: every row behind a tile shares its folder (decision 11), so the
     * fence is the tile's one folder, and `stepperByTile`'s "every row, not any" is one question.
     */
    it("steps the binder's tile of a printing and not the deck group's", async () => {
      collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
      opened(DECK_GROUP.id);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, finish: "nonfoil", folderId: 3, folderName: "Trade binder", quantity: 1 },
          { ...BOLT, id: 8, finish: "nonfoil", folderId: 20, folderName: "Mono-Red Aggro", quantity: 2 },
        ]),
      );
      wrap(<CollectionPage />);

      expect(await screen.findAllByAltText("Lightning Bolt")).toHaveLength(2);
      await waitFor(() => expect(steppers()).toHaveLength(1));
      expect(box("Lightning Bolt")).toHaveValue(1);
      // The deck's tile is still a tile, badged with what the deck holds.
      expect(screen.getByText("2 in your collection")).toBeInTheDocument();
    });

    /**
     * **`Recently removed` is stepped like a binder since issue #506** — and this case asserted the
     * opposite until then, under the title *draws no stepper on the wall inside Recently removed*.
     * The fence on a count is about deck custody, and the holding area's copies belong to no deck,
     * so a reader thinning the pile no longer has to drag each copy back into a binder first.
     *
     * Driven by **standing in the folder**, which is the half with no page-level branch: every row
     * on that wall is in the folder, so it is the per-tile rule alone that now lets them through.
     * The last `−` is the ordinary delete — `set_quantity(id, 0)` — which is the table's and every
     * binder tile's, so the write is the same one with the same entry id.
     */
    it("draws a stepper on the wall inside Recently removed, and the last press deletes", async () => {
      collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
      collectionList.mockResolvedValue(
        page([
          {
            ...BOLT,
            id: 7,
            finish: "nonfoil",
            folderId: 21,
            folderName: "Recently removed",
            quantity: 1,
          },
        ]),
      );
      collectionSetQuantity.mockResolvedValue({ id: 7, quantity: 0, removed: true });
      wrap(<CollectionPage />);

      await openShelf(userEvent, "Recently removed");
      await waitFor(() => expect(standingIn()).toBe(21));

      await screen.findByAltText("Lightning Bolt");
      expect(await screen.findByRole("spinbutton", { name: new RegExp(`^${named("Lightning Bolt")}$`) })).toHaveValue(1);

      await userEvent.click(stepper("Decrease", "Lightning Bolt"));
      expect(collectionSetQuantity).toHaveBeenCalledWith(7, 0);
    });

    /**
     * **The deck group beside it stays fenced** — the half of #506's change that must not move.
     * At the root, with both shelves opened, both kinds are on one wall and the holding area's tile
     * is the sentinel that the census has answered: its stepper can only be drawn once the page
     * knows which folder `Recently removed` is.
     */
    it("still draws no stepper on a deck group's tile beside a Recently removed one", async () => {
      collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
      opened(DECK_GROUP.id, REMOVED.id);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, finish: "nonfoil", folderId: 21, folderName: "Recently removed", quantity: 1 },
          {
            ...BOLT,
            id: 8,
            cardId: "c2",
            name: "Counterspell",
            finish: "nonfoil",
            folderId: 20,
            folderName: "Mono-Red Aggro",
            quantity: 4,
          },
        ]),
      );
      wrap(<CollectionPage />);
      await screen.findByAltText("Counterspell");

      expect(await screen.findByRole("spinbutton", { name: new RegExp(`^${named("Lightning Bolt")}$`) })).toHaveValue(1);
      expect(noBox("Counterspell")).toBeNull();
      expect(steppers()).toHaveLength(1);
    });
  });

  /**
   * **The table's half of the same fence — and this is the *wiring* test rather than the fence's
   * own.**
   *
   * `CollectionTable` owns the cell and has its own cases for what a blocked row draws; what
   * cannot be proved from inside that component is that anything ever hands it the predicate.
   * This repo has shipped a fix that was fully tested and unreachable, with the whole suite
   * green, for exactly that reason — the question "what calls this?" belongs in the plan and not
   * only in the diff. So the claim here is the page's: the same `countEditable` that decides
   * which tiles draw a stepper is what reaches the table's rows, so the two layouts of one list
   * cannot disagree about which copies are editable.
   */
  describe("the table's stepper, fenced by the same predicate", () => {
    it("hands the table the page's fence, so a row in a deck's group cannot be stepped", async () => {
      collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
      opened(DECK_GROUP.id);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, folderId: null, quantity: 2 },
          {
            ...BOLT,
            id: 8,
            cardId: "c2",
            name: "Counterspell",
            finish: "nonfoil",
            condition: "NM",
            folderId: 20,
            folderName: "Mono-Red Aggro",
            quantity: 4,
          },
        ]),
      );
      wrap(<CollectionPage />);
      await screen.findByText("Counterspell");

      // The row the deck physically holds: no control, and a sentence saying where the way out
      // is. The words are the page's — `CollectionTable` prints what it is given.
      await waitFor(() =>
        expect(
          screen.queryByRole("spinbutton", { name: "Quantity of Counterspell (Nonfoil, NM)" }),
        ).toBeNull(),
      );
      expect(
        screen.getByText(
          "In Mono-Red Aggro. Cut the card from the deck to change how many you hold.",
        ),
      ).toBeInTheDocument();

      // And the unfiled row beside it still is maintained here, which is what keeps the absence
      // above a claim about the fence rather than about the table having lost its stepper.
      expect(
        screen.getByRole("spinbutton", { name: "Quantity of Lightning Bolt (Foil, NM)" }),
      ).toHaveValue(2);
    });

    /**
     * **A row in `Recently removed` is stepped here too** (issue #506), and says nothing about
     * moving it back — the sentence it used to carry is gone with the fence. The deck row beside
     * it is the sentinel that the census answered, since a fenced row is what a filed row reads
     * while it has not.
     */
    it("draws a stepper on a row in Recently removed, and still none on a deck's", async () => {
      collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
      opened(DECK_GROUP.id, REMOVED.id);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, folderId: 21, folderName: "Recently removed", quantity: 2 },
          {
            ...BOLT,
            id: 8,
            cardId: "c2",
            name: "Counterspell",
            finish: "nonfoil",
            condition: "NM",
            folderId: 20,
            folderName: "Mono-Red Aggro",
            quantity: 4,
          },
        ]),
      );
      wrap(<CollectionPage />);
      await screen.findByText("Counterspell");

      expect(
        await screen.findByRole("spinbutton", { name: "Quantity of Lightning Bolt (Foil, NM)" }),
      ).toHaveValue(2);
      expect(screen.queryByText(/Move it back to your collection/)).toBeNull();
      expect(
        screen.queryByRole("spinbutton", { name: "Quantity of Counterspell (Nonfoil, NM)" }),
      ).toBeNull();
    });
  });

  /**
   * **Task 11's first export entry point outside the deck editor.** The list here is a
   * `useInfiniteQuery` at 100 rows a page, so what is in memory is a scroll position rather
   * than a decision — exporting it would silently truncate a filtered collection to whatever
   * page the reader happened to have loaded. The sweep asks for the whole filtered set at 500
   * a page instead, which is what the `limit: 500` assertion below is pinning.
   */
  it("exports every row the filter matches, not the page that happens to be loaded", async () => {
    // 250 rows, a 100-row list page, a 500-row sweep page: one sweep call for the lot.
    const rows250 = Array.from({ length: 250 }, (_, i) => ({
      ...BOLT,
      id: i + 1,
      cardId: `c${i + 1}`,
      name: `Card ${i + 1}`,
    }));
    collectionList.mockImplementation(async ({ limit, offset }: CollectionQuery) =>
      page(rows250.slice(offset, offset + limit), rows250.length),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Card 1");

    await user.click(await screen.findByRole("button", { name: "Export collection" }));
    await waitFor(() =>
      expect(collectionList).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 })),
    );
    await user.click(await screen.findByRole("button", { name: /Show decklist/ }));
    // **251, not 250.** A collection opens on CSV (see the store's defaults) and CSV writes a
    // header row. Asserting the row count here is how a correct implementation reads as red.
    expect(await screen.findByText(/251 lines/)).toBeInTheDocument();
  });

  /**
   * **Task 14's entry point: the Import button, over `collectionDestination`.** Wired the same
   * way Export is — one press, one dialog, one destination — so the round trip that matters here
   * is that a paste reaches `collectionImportCommit` with the plan `planCollectionImport` builds,
   * in the mode the reader picked, through the shell `ImportDialog` mounts without knowing which
   * destination it is holding.
   */
  it("imports a pasted list into the collection", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "Import cards" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a decklist" });
    await user.click(within(dialog).getByLabelText("Decklist"));
    await user.paste("1 Sol Ring");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));

    // The collection's own preview: a condition/finish default pair the deck's importer has
    // no equivalent of, and an `add`/`set` mode radio rather than `merge`/`replace`.
    expect(await screen.findByText(/will be added to your collection/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Condition when the file doesn't say" }),
    ).toHaveTextContent("Not set");

    // Scoped to the dialog: the page's own trigger is still on screen behind it and shares the
    // same accessible name.
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(collectionImportCommit).toHaveBeenCalledWith(
        [
          {
            cardId: "sol-ring",
            quantity: 1,
            finish: "nonfoil",
            // The dialog's own default, which is the store's: a pasted line says nothing
            // about a grade, and `NONE` is now how the app records that it was not told.
            condition: "NONE",
            conditionOriginal: undefined,
            purchasePrice: undefined,
            purchaseCurrency: undefined,
            acquiredAt: undefined,
            acquisitionSource: undefined,
            notes: undefined,
            // The six grain columns the planner carries now rather than letting `commit_import`
            // default them. A pasted line states none of them, so they arrive as the values a
            // plain copy has — which is the point: the fold key is the full grain since schema
            // v24, so a re-import has to be able to land on the reader's *altered* row instead of
            // writing a second all-defaults one beside it.
            altered: false,
            signed: false,
            proxy: false,
            misprint: false,
            serialNumber: undefined,
            grading: undefined,
          },
        ],
        "add",
      ),
    );
    // The dialog closes on its own report — `onDone` — the same precedent `DeckEditor` and
    // `DecksPage` set for their own import dialogs.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Import a decklist" })).not.toBeInTheDocument(),
    );
  });

  /**
   * **Fix round 1's marketplace ruling.** `marketplace` sits inside the same `filters` object as
   * every row-narrowing field (`useCollection.ts`), but it decides which *price* a row is quoted
   * at rather than which rows match, and it is not one of the filter bar's own controls — so
   * "Export everything, ignoring the filters" must not also silently reprice the export at the
   * backend's default (TCGplayer) for a reader who had picked another marketplace. A regression
   * to `scope.ts`'s old `{}` for the "everything" case fails this the moment `getMarketplace`
   * answers anything but the default.
   */
  it("keeps the reader's marketplace when Export everything is ticked, and drops only the filters", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(lastQuery().marketplace).toBe("cardmarket"));

    // A filter switched on, so there is something real for "everything" to have dropped — the
    // marketplace assertion below is not just "the field was never set to begin with".
    await openTray(user);
    await user.click(screen.getByRole("button", { name: "Foil" }));
    await waitFor(() => expect(lastQuery().finishes).toEqual(["foil"]));

    await user.click(await screen.findByRole("button", { name: "Export collection" }));
    await waitFor(() =>
      expect(collectionList).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 })),
    );
    collectionList.mockClear();

    await user.click(
      screen.getByRole("checkbox", { name: "Export everything, ignoring the filters" }),
    );

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = lastQuery();
    // The marketplace survives the toggle...
    expect(asked.marketplace).toBe("cardmarket");
    // ...and the filter that was on does not: "everything" really does ignore the filters.
    expect(asked.finishes).toBeUndefined();
  });

  /**
   * **Fix round 2's cache-key ruling.** `scope.ts`'s "everything" branch used to key its query
   * as the literal `[surface, "export", "everything"]`, with no `marketplace` in it — so a
   * reader who exported everything, then switched marketplace, and exported everything again
   * could be served the *first* sweep straight back out of cache, priced at the feed they had
   * left. That is Important 1's wrong-prices symptom again, arriving through the cache instead
   * of through the request this time. `marketplace` is part of the `everything` key now, so a
   * feed switch is a different query and issues a fresh request.
   *
   * The switch is driven the way `useMarketplace`'s own `select` mutation actually makes it —
   * `queryClient.setQueryData(MARKETPLACE_KEY, id)` on success — rather than through a Settings
   * control this page does not have. That is the one write the real code path performs, so
   * reaching for the query client directly here exercises the same mechanism a Settings press
   * would, without needing a second page mounted in this suite.
   */
  it("issues a fresh sweep when the marketplace changes while Export everything is on", async () => {
    const user = userEvent.setup();
    const { client } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(lastQuery().marketplace).toBe("tcgplayer"));

    await user.click(await screen.findByRole("button", { name: "Export collection" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Export everything, ignoring the filters" }),
    );
    // The first sweep, at the marketplace the reader had when they ticked the box.
    await waitFor(() => expect(sweepCallsAt("tcgplayer")).toBeGreaterThan(0));

    client.setQueryData(MARKETPLACE_KEY, "cardmarket");

    // A genuinely new **sweep** request (`limit: 500`) at the new marketplace — filtered to
    // that limit specifically, because the ordinary paged list behind the table also carries
    // `marketplace` in its own key and refetches on a feed switch regardless of this fix; that
    // refetch alone must not make this assertion pass. Without the cache-key fix this `waitFor`
    // times out: the "everything" query's key never changes, so nothing at `limit: 500` goes
    // out a second time and the previous sweep's cards are served back at the new marketplace.
    await waitFor(() => expect(sweepCallsAt("cardmarket")).toBeGreaterThan(0));
  });
});

/**
 * The card menu, over both of this view's layouts.
 *
 * The two are one surface as far as the menu is concerned — one `CardMenuDeps` for the page —
 * but they are **not** one adapter: a table row is an entry and therefore *is* a finish, while
 * a tile is a card the reader may hold in two of them. That difference is what the two writes
 * below are about; the panel's own markup is `ContextMenu.test.tsx`'s subject.
 */
describe("the card menu", () => {
  it("opens on a right-click of a row, without opening the card", async () => {
    wrap(<CollectionPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    rightClick(row);

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // The pane belongs to a left click; a right-click asks a question about the row. `App`
    // owns the pane, so the store is the whole of what opening the card means from here —
    // asserting on a `complementary` this page never renders would be an assertion that
    // cannot fail.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The keyboard's route to the same menu, which is a feature rather than a nicety: the reader
   * was asked and chose a menu that opens by keyboard over a mouse-only one. Shift+F10 here;
   * the dedicated ContextMenu key is the primitive's other arm and its rule, not this surface's.
   */
  it("opens from the keyboard on a row, without opening the card", async () => {
    wrap(<CollectionPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** And the row's own keys still work: the menu's handler is added to the row's, not put in
   *  place of it. A single `onKeyDown` would have eaten this. */
  it("still opens the card on Enter, which the menu's handler sits beside", async () => {
    wrap(<CollectionPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "Enter" });

    expect(useAppStore.getState().selectedCardId).toBe("c1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * A collection row *is* a finish — it is one of the ten columns its identity is made of — so
   * the menu does not ask. `BOLT` is the foil entry, and a nonfoil copy recorded from it would
   * be a different row in the same table.
   */
  it("adds the row's own finish without asking", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));

    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    // An action, not a submenu: the surface named the finish.
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "foil",
        // **`NONE`, and this reverses what the four cases below asserted until this PR.**
        // `MENU_CONDITION` was Near Mint — the one decision a menu made on the reader's
        // behalf, stated in the app rather than left to the backend's default. With a sixth
        // grade meaning *not set* there is nothing left for it to decide, so the quick-add
        // records silence. Spelled as the literal rather than imported: an assertion that
        // reads the same constant as the code under test cannot fail when that constant
        // moves.
        condition: "NONE",
        quantity: 1,
        // The root of the cabinet — a real destination, and what the menu names when the reader
        // has no folders for it to offer.
        folderId: null,
      }),
    );
  });

  /**
   * "View all printings", live rather than greyed, reaching the oracle card the entry is of.
   *
   * This item is fenced on `oracleId`, and until `CollectionRow` carried one every row and tile
   * of the reader's collection drew it greyed with the reason *"this printing has left the card
   * database"* — a true sentence about a perfectly healthy card, which is a worse failure than
   * no item at all. The column exists to make that reason fire only when it is true, so the
   * assertion is on both halves: the row is pressable, and pressing it asks about **this**
   * card's oracle id rather than some fallback.
   *
   * `openAllPrintings` writes one field and moves nothing, so the store is where the press is
   * observed — the modal itself is mounted once in `App`, over whatever view is on screen.
   */
  it("offers View all printings, and asks about the entry's own oracle card", async () => {
    const user = userEvent.setup();
    // Standing where the page is actually drawn, so "it did not navigate" is a fact rather than
    // the store's own default — `activeView` starts on `"search"`, which is where the old
    // channel took the reader.
    useAppStore.setState({ activeView: "collection" });
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");

    const printings = screen.getByRole("menuitem", { name: /View all printings/ });
    // `aria-disabled`, never the `disabled` attribute — the house rule, and what the menu's
    // greyed rows are drawn with.
    expect(printings).not.toHaveAttribute("aria-disabled", "true");

    await user.click(printings);

    expect(useAppStore.getState().printingsRequest).toEqual({
      // The printing the menu was opened on: the modal's "you are here" ring, and how it finds
      // the reader's place on the walk this page publishes.
      cardId: "c1",
      oracleId: "o1",
      name: "Lightning Bolt",
      // A collection row is not a row of an open deck, so there is no slot for a press in the
      // modal to swap — it opens the card pane on the printing instead.
      deck: null,
      // No wish either: `wishlist_set_printing`'s target is set only by the wishlist's own
      // rows, and `toEqual` reads an absent key and a `null` one as two different answers.
      wish: null,
    });
    // **And the reader is still on their collection.** This press used to write `activeView`,
    // `selectedCardId`, `paneDeckContext` and `openDeckId` in the same `set`, so asking which
    // printings a card had moved them to the Search page and lost their place in a filtered
    // list. The modal is drawn over this page; nothing navigates.
    expect(useAppStore.getState().activeView).toBe("collection");
  });

  /**
   * The other side of the same fence, and the reason the adapter passes the column through with
   * no fallback: `cards.oracle_id` is null for 0 of 116 590 live rows, so a null here really is
   * an entry whose printing has left the corpus — and the greyed row's sentence is then true.
   */
  it("greys View all printings for an orphaned entry, which is what a null oracle id means", async () => {
    collectionList.mockResolvedValue(page([{ ...BOLT, oracleId: null }]));
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");

    expect(screen.getByRole("menuitem", { name: /View all printings/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * The rule the shared `useCardMenuDeps` exists to hold in one place, asserted rather than
   * assumed: a menu's collection add re-reads **four** keys and a wish re-reads **two**.
   *
   * They differ because the writes differ. A copy recorded changes what every wish counts as
   * owned (`ownedQuantity` is summed from `collection_entries`), what every search row is
   * badged with, and what every deck's theory list reads as spare — the copy lands unfiled at
   * the root, which is no deck's group, and the spare column counts exactly those. A wish is a
   * copy the reader does *not* have, so it moves no collection figure and no deck's arithmetic
   * — only the heart on a result row. Three pages writing that out again is three places for
   * one rule to drift, and the drift is silent: a stale badge fails nothing.
   */
  it("re-reads what a menu add changed, and only that", async () => {
    const user = userEvent.setup();
    const { client } = wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Collection" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });

    // And the wish's two, which are a strict subset — so the assertion that matters is the one
    // that must *not* fire: a wish is a copy nobody has, so it files nothing anywhere and no
    // deck's group — or the spare count outside every group — can have moved.
    invalidate.mockClear();
    rightClick(screen.getByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });
  });

  /**
   * The banner is superseded by the next add rather than standing until one succeeds — the same
   * rule the stepper's and the removal's banner follow, and for the reason written beside them:
   * an alert about something the reader has already dealt with is worse than no alert.
   *
   * **The assertion is made while the second add is still in flight, and that is the whole
   * fence.** Cleared-on-start and cleared-on-success agree about every settled state: a second
   * add that succeeds ends with no banner either way, and one that is refused ends with its own
   * sentence either way. The single moment they differ is the one below — between the press and
   * the answer — so the second write is held open deliberately rather than answered. (Written
   * the obvious way first, this test passed against the un-fixed code.)
   */
  it("clears a refused add's sentence when the next add starts, not when one answers", async () => {
    collectionAdd.mockRejectedValue("that card is not in the database");
    // Held open: nothing resolves it until this test says so.
    let refuseWish: (reason: unknown) => void = () => {};
    wishlistAdd.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuseWish = reject;
        }),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Collection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not add to your collection — that card is not in the database",
    );

    // A *wishlist* add, so what follows cannot be the same sentence written again.
    rightClick(screen.getByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    // Still pending — and the collection's complaint is already gone, because the reader has
    // moved on from it. This is the assertion the finding was about.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    // And when this one is refused in its turn, its own sentence takes the place.
    await act(async () => refuseWish("the wishlist is locked"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not add to your wishlist — the wishlist is locked",
    );
  });

  /**
   * The one field on the target nothing else here can see, and the reason it is carried: a
   * deck add naming no category is filed by what the card *does*, and the type line is
   * `autoCategoryFor`'s fallback. A drag of the same row carries it; a menu add would be the
   * one path that did not.
   *
   * This is also the only test on these three surfaces that drives the deck picker, so it is
   * what says the `lazy` row is reachable from a real page and that the provider nesting the
   * app uses is the one that works — the panel's own cascade is `cardMenu.test.tsx`'s subject.
   */
  it("carries the row's type line into a deck add, so the pile is chosen by what the card does", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        {/* **Above `ContextMenuProvider`, and that nesting is the whole of what makes this
            work** — it is the arrangement `App.tsx` uses, for the reason it documents. The
            panel is a *sibling* of the menu provider's children, not a descendant of them, so a
            `CardToDeckProvider` mounted inside the surface is not above the picker at all and
            `useAddCardToDeck` throws on expand. A page rendered on its own has to supply this,
            because the picker throws without it rather than swallowing the add.

            No `value`: the provider mounts the real `useCardToDeck`, so the assertion below is
            on `ipc.deckAddCard` — the write itself, which is stronger than a spy on the callback
            that was supposed to reach it. */}
        <CardToDeckProvider>
          <ContextMenuProvider>
            <CollectionPage />
          </ContextMenuProvider>
        </CardToDeckProvider>
      </QueryClientProvider>,
    );

    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Deck" }));
    await user.click(await screen.findByRole("menuitem", { name: "Burn" }));

    // `deck_add_card(deckId, cardId, categoryId, typeLine, variant, quantity)` — no category,
    // so the app's own `autoCategoryFor` files the card, and the type line is what it files it
    // by. That is the arm a drag with no column under it and an imported line both take.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "c1", null, "Instant", "live", null, 1),
    );
  });

  /**
   * The wall's tile is a *card* — `CollectionPage` sums the entries behind one printing into
   * one piece of art — so unlike the row it cannot *be* one finish. What it offers instead is
   * the finishes its own entries are in, and with one entry that is one finish and no question.
   *
   * The wrong answer here is not a hypothetical: a tile that said nothing about finishes fell
   * to the menu's unknown-list rule and recorded a **nonfoil** copy for a reader whose only
   * copy of this card is a foil.
   */
  it("records the one finish the reader owns, from a tile that is a card rather than an entry", async () => {
    useAppStore.setState({ collectionView: "grid" });
    const user = userEvent.setup();
    // The default page is the foil entry and nothing else.
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");
    await user.click(collection);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "foil",
        // **`NONE`, and this reverses what the four cases below asserted until this PR.**
        // `MENU_CONDITION` was Near Mint — the one decision a menu made on the reader's
        // behalf, stated in the app rather than left to the backend's default. With a sixth
        // grade meaning *not set* there is nothing left for it to decide, so the quick-add
        // records silence. Spelled as the literal rather than imported: an assertion that
        // reads the same constant as the code under test cannot fail when that constant
        // moves.
        condition: "NONE",
        quantity: 1,
        // The root of the cabinet — a real destination, and what the menu names when the reader
        // has no folders for it to offer.
        folderId: null,
      }),
    );
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The wall's own keyboard route. `CardGrid`'s mechanism is covered by the search suite; what
   * this pins is that this view passes it — `cardMenuKey` is a separate prop from `cardMenu`,
   * so a wall can be given one and not the other and nothing says so.
   */
  it("opens from the keyboard on a tile of the wall", async () => {
    useAppStore.setState({ collectionView: "grid" });
    wrap(<CollectionPage />);
    // The press lands on the art button and bubbles to the tile, which is what carries the
    // handler — the tile is the card, and the button inside it is what holds the caret.
    fireEvent.keyDown(await screen.findByRole("button", { name: "Lightning Bolt" }), {
      key: "F10",
      shiftKey: true,
    });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The other arm of the same pair, pressed on the **foil** tile of a printing the reader also
   * holds plain. The one above presses the nonfoil tile of exactly this fixture, and together
   * they are what says the two tiles do not share an answer.
   *
   * **This test asserted the opposite until 2026-08-26 and is rewritten rather than deleted.**
   * It read "the wall has two finishes behind it and has to ask which one the reader means", and
   * pinned a `Collection` row with `aria-haspopup="menu"` offering `Nonfoil · Foil` in `FINISHES`
   * order. The finish is part of the wall's key now, so a tile can never merge two of them and
   * there is no question left to ask — the submenu the reader had to answer correctly is gone,
   * and with it the way to answer it wrongly. The `FINISHES` ordering it also pinned is not lost:
   * it belongs to `cardMenu`'s own suite and to the search wall, whose targets can still carry a
   * multi-finish list.
   *
   * The fixture stays deliberately foil-first, which is now what makes the *first* tile the foil.
   */
  it("records the foil tile's own finish, on a printing also held plain", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    const tiles = await screen.findAllByRole("button", { name: "Lightning Bolt" });
    rightClick(tiles[0]);
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);
    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "foil",
        // **`NONE`, and this reverses what the four cases below asserted until this PR.**
        // `MENU_CONDITION` was Near Mint — the one decision a menu made on the reader's
        // behalf, stated in the app rather than left to the backend's default. With a sixth
        // grade meaning *not set* there is nothing left for it to decide, so the quick-add
        // records silence. Spelled as the literal rather than imported: an assertion that
        // reads the same constant as the code under test cannot fail when that constant
        // moves.
        condition: "NONE",
        quantity: 1,
        // The root of the cabinet, as above: the finish is the tile's, the folder was never
        // the question.
        folderId: null,
      }),
    );
  });

  /**
   * `Edit copy…` — the row that carries this page's half of `ipc.collectionUpdate`'s first
   * caller, driven end to end: right-click a table row, open the dialog, change the grade, save.
   *
   * **A table row and never a tile**, which is the whole of the fence: a row *is* one
   * `collection_entries` entry, and the wall's tile is the page's summary of a printing across
   * however many entries it happens to hold. The pair of cases below is what says so — a menu
   * built from the same page, over the same card, with and without the row.
   */
  describe("Edit copy…", () => {
    it("opens the editor on the row's own copy and writes what changed", async () => {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
      await screen.findByRole("menu");

      await user.click(screen.getByRole("menuitem", { name: "Edit copy…" }));

      // Seeded from the row the menu was opened on — `BOLT` is a foil Near Mint copy at the root
      // with no purchase price recorded, so a dialog showing anything else is reading the wrong
      // entry or none at all.
      const dialog = await screen.findByRole("dialog", { name: "Edit copy" });
      expect(within(dialog).getByText("LEA 161 · Foil · Collection")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Condition" })).toHaveTextContent(
        "Near mint",
      );

      await pickOption(user, "Condition", "Lightly played");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      // `BOLT.id`, and only the field that moved.
      await waitFor(() => expect(collectionUpdate).toHaveBeenCalledWith(7, { condition: "LP" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("offers no editor on the wall, where a tile stands for the printing", async () => {
      useAppStore.setState({ collectionView: "grid" });
      wrap(<CollectionPage />);
      rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
      await screen.findByRole("menu");

      // Present on the row, absent here — and absent rather than greyed, because it is missing
      // from every tile of this wall and therefore reads as a fact about the surface.
      expect(screen.queryByRole("menuitem", { name: "Edit copy…" })).toBeNull();
      // The neighbouring row that *can* express the several is unaffected: this fixture has no
      // folders, so `Move to` is out for its own reason and the claim here is only about the
      // menu still being the collection's.
      expect(screen.getByRole("menuitem", { name: /Add to/ })).toBeInTheDocument();
    });
  });

  /**
   * `Remove from collection` — issue #506's right-click, wired by this page only where the copies
   * behind the target may have their count changed: the stepper's fence, asked of every row.
   */
  describe("Remove from collection", () => {
    it("removes a Recently removed tile's copies, every entry behind the art", async () => {
      useAppStore.setState({ collectionView: "grid" });
      collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
      opened(REMOVED.id);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, folderId: 21, folderName: "Recently removed", quantity: 1 },
          // A second grade of the same printing and finish: one tile, two entries.
          { ...BOLT, id: 9, condition: "LP", folderId: 21, folderName: "Recently removed", quantity: 2 },
        ]),
      );
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      const tile = await screen.findByRole("button", { name: "Lightning Bolt" });
      // The census has answered once a stepper is drawn on the tile — before that, the page does
      // not yet know which folder is the holding area and the row is correctly withheld.
      await screen.findByRole("spinbutton", { name: /^Copies of Lightning Bolt/ });

      rightClick(tile);
      await screen.findByRole("menu");
      await user.click(screen.getByRole("menuitem", { name: "Remove 2 cards from collection" }));

      await waitFor(() => expect(collectionRemove).toHaveBeenCalledTimes(2));
      expect(collectionRemove).toHaveBeenCalledWith(7);
      expect(collectionRemove).toHaveBeenCalledWith(9);
    });

    it("offers no removal on a tile a deck's group holds", async () => {
      useAppStore.setState({ collectionView: "grid" });
      collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
      opened(DECK_GROUP.id, REMOVED.id);
      collectionList.mockResolvedValue(
        page([
          { ...BOLT, id: 7, folderId: 21, folderName: "Recently removed", quantity: 1 },
          {
            ...BOLT,
            id: 8,
            cardId: "c2",
            name: "Counterspell",
            folderId: 20,
            folderName: "Mono-Red Aggro",
            quantity: 4,
          },
        ]),
      );
      wrap(<CollectionPage />);
      // Sentinel: the holding area's tile has its stepper, so the census is in.
      await screen.findByRole("spinbutton", { name: /^Copies of Lightning Bolt/ });

      rightClick(screen.getByRole("button", { name: "Counterspell" }));
      await screen.findByRole("menu");

      expect(screen.queryByRole("menuitem", { name: /^Remove/ })).toBeNull();
      // Still the collection's menu, so the absence is the fence's and not an empty panel's.
      expect(screen.getByRole("menuitem", { name: /Add to/ })).toBeInTheDocument();
    });

    it("offers it on a table row at the root, one entry", async () => {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
      await screen.findByRole("menu");

      await user.click(screen.getByRole("menuitem", { name: "Remove from collection" }));
      await waitFor(() => expect(collectionRemove).toHaveBeenCalledWith(7));
      expect(collectionRemove).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * `Clear…` inside `Recently removed` — issue #506. Drawn only while standing in the holding area
 * with the cabinet on screen and cards in it, asked in words before it writes, and one write.
 */
describe("clearing Recently removed", () => {
  beforeEach(() => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER, REMOVED]);
    collectionFolderSummary.mockResolvedValue([{ folderId: 21, cards: 3, value: null }]);
    collectionList.mockResolvedValue(
      page([{ ...BOLT, id: 7, folderId: 21, folderName: "Recently removed", quantity: 3 }]),
    );
  });

  async function standInRemoved() {
    await openShelf(userEvent, "Recently removed");
    await waitFor(() => expect(standingIn()).toBe(21));
  }

  it("is drawn inside Recently removed and nowhere else", async () => {
    wrap(<CollectionPage />);
    await findHeading("Recently removed");
    expect(screen.queryByRole("button", { name: "Clear…" })).toBeNull();

    await standInRemoved();
    expect(await screen.findByRole("button", { name: "Clear…" })).toBeInTheDocument();
  });

  it("is not drawn over an empty holding area", async () => {
    collectionFolderSummary.mockResolvedValue([]);
    collectionList.mockResolvedValue(page([]));
    wrap(<CollectionPage />);
    await standInRemoved();
    // The summary has answered (its `0` is what hides the button), so this is not a race.
    await waitFor(() => expect(collectionFolderSummary).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Clear…" })).toBeNull();
  });

  it("asks first, and Cancel writes nothing", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await standInRemoved();

    await user.click(await screen.findByRole("button", { name: "Clear…" }));
    const question = await screen.findByRole("group", { name: "Clear Recently removed" });
    expect(question).toHaveTextContent(
      "Remove all 3 cards in Recently removed from your collection?",
    );
    expect(question).toHaveTextContent("This cannot be undone.");

    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Clear Recently removed" })).toBeNull();
    expect(collectionRemovedClear).not.toHaveBeenCalled();
    // The caret goes back to the control that raised the question.
    expect(screen.getByRole("button", { name: "Clear…" })).toHaveFocus();
  });

  it("clears on confirm, in one write, and re-reads what it changed", async () => {
    collectionRemovedClear.mockResolvedValue(1);
    const user = userEvent.setup();
    const { client } = wrap(<CollectionPage />);
    await standInRemoved();
    await user.click(await screen.findByRole("button", { name: "Clear…" }));
    const question = await screen.findByRole("group", { name: "Clear Recently removed" });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(within(question).getByRole("button", { name: "Clear Recently removed" }));

    await waitFor(() => expect(collectionRemovedClear).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Clear Recently removed" })).toBeNull(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  it("keeps the question open and says why when the clear is refused", async () => {
    collectionRemovedClear.mockRejectedValue("There is no Recently removed folder.");
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await standInRemoved();
    await user.click(await screen.findByRole("button", { name: "Clear…" }));
    const question = await screen.findByRole("group", { name: "Clear Recently removed" });

    await user.click(within(question).getByRole("button", { name: "Clear Recently removed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change your collection — There is no Recently removed folder.",
    );
    expect(screen.getByRole("group", { name: "Clear Recently removed" })).toBeInTheDocument();
  });
});

/**
 * The arrow keys on this wall, and the one thing this page contributes to them.
 *
 * The mechanism is `CardGrid`'s and is pinned by its own suite and by `gridNav.test.ts`. But
 * `arrowNav` is a prop, and three of that component's four callers are deliberately built
 * without it, so a wall can be given the whole feature and say nothing about it. What is claimed
 * here is that this page passes it — and that the press therefore moves `selectedCardId`, the
 * field the docked card pane reads, rather than only an outline on the wall.
 *
 * ArrowDown, and at one column that is the same step as ArrowRight: jsdom measures this wall at
 * 0px, so every tile is its own row. Telling the two keys apart needs a column count, which is
 * `gridNav.test.ts`'s subject. `userEvent.keyboard` on a caret placed by hand, never `type`,
 * which focuses what it is handed and would make the focus assertion pass for the wrong reason.
 */
describe("the arrow-key walk", () => {
  it("selects the next card on the wall, which is the card the pane is showing", async () => {
    useAppStore.setState({ collectionView: "grid" });
    // Two printings, so there are two tiles: this wall sums the entries behind one printing into
    // a single piece of art, and a second entry for `c1` would be one tile with nowhere to walk.
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, cardId: "c2", name: "Ancestral Recall" }]),
    );
    wrap(<CollectionPage />);

    const first = await screen.findByRole("button", { name: "Lightning Bolt" });
    first.focus();
    await userEvent.keyboard("{ArrowDown}");

    expect(useAppStore.getState().selectedCardId).toBe("c2");
    expect(screen.getByRole("button", { name: "Ancestral Recall" })).toHaveFocus();
  });
});

/**
 * The list the printings modal's own arrow keys walk, published to the store by this page.
 *
 * It goes through the store because `AllPrintingsDialog` is mounted at `App` level, outside every
 * view, and the order is this page's — a query narrowed by its filter bar. What the modal *does*
 * with a walk belongs to `AllPrintingsDialog.test.tsx`; what this file owes is that a walk of the
 * right shape is published at all, and taken back when the page goes.
 */
describe("the walk it publishes for the printings modal", () => {
  const walk = () => useAppStore.getState().cardWalk;

  // The walk is derived from the rows rather than from either layout, so which one is on screen
  // is not this suite's business — but the store is one global and the suite above it leaves the
  // wall on, so say which and read the same page both ways.
  beforeEach(() => useAppStore.setState({ collectionView: "table" }));

  /**
   * **Deduplicated by printing, and it is the *tiles* this is built from.** Two entries of one
   * printing — a foil and a played nonfoil — are two rows of the table, one tile of the wall, and
   * one wall with one ring from the modal. A stop for each would be a press that moved nothing on
   * screen. This is the case that discriminates the tiles from the rows: the table draws three
   * rows here and the walk has two stops.
   */
  it("publishes one stop per printing, in the order the list is drawn", async () => {
    collectionList.mockResolvedValue(
      page([
        BOLT,
        { ...BOLT, id: 8, finish: "nonfoil" },
        { ...BOLT, id: 9, cardId: "c2", name: "Ancestral Recall", oracleId: "o2" },
      ]),
    );
    wrap(<CollectionPage />);

    await waitFor(() =>
      expect(walk().stops).toEqual([
        { cardId: "c1", oracleId: "o1", name: "Lightning Bolt", deck: null },
        { cardId: "c2", oracleId: "o2", name: "Ancestral Recall", deck: null },
      ]),
    );
  });

  /** The noun the modal's chevrons read into their own names — `Next card in your collection`. */
  it("says which list it is", async () => {
    wrap(<CollectionPage />);

    await waitFor(() => expect(walk().label).toBe("your collection"));
  });

  /** And it goes when the page does: a walk left behind would step a modal opened somewhere else
   *  through a list nobody is looking at. */
  it("clears the walk when the page goes", async () => {
    const view = wrap(<CollectionPage />);
    await waitFor(() => expect(walk().stops).toHaveLength(1));

    view.unmount();

    expect(walk().stops).toEqual([]);
  });
});

/**
 * The shelves the page draws in whichever view is on — the headings, the path row's breadcrumb
 * and toolbar, and the two ways a copy is filed.
 *
 * **Drawn once for both layouts rather than inside each**, so the wall and the table navigate
 * identically. The filing itself is the backend's: `collection_list` takes the open shelves in
 * wall order, so the rows arrive shelf by shelf and nothing here filters.
 */
describe("the collection's shelves", () => {
  /** An empty cabinet: no breadcrumb (a lone `Collection` under a ribbon that says Collection),
   *  and the way to make a first folder is on the path row — the band that used to hold it is gone. */
  it("offers Add folder on the path row over an empty cabinet, and draws no breadcrumb", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.queryByRole("navigation", { name: "Collection folders" })).toBeNull();
    expect(pathRowAddFolder()).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
  });

  /**
   * **A keystroke re-lays nothing.** Every render of this page builds its heading callbacks anew —
   * they close over mutations, and a `useMutation` result is a fresh object each render — so what
   * the wall is *laid out from* has to be keyed on data instead: `CardGrid` on `sections` and
   * `tilesOf`, the table on its layout, lookup and paging flag. A key in the filter box re-renders
   * the whole page before the box's debounce has asked anything, and must not reach
   * `layoutShelves` in either view. (The table's own row list is built without `layoutShelves`,
   * so its half — rebuilt on nothing but the three inputs — is pinned in `CollectionTable.test.tsx`.)
   *
   * `fireEvent.change` rather than `userEvent.type`, and nothing awaited before the count: the
   * debounce is a real 300ms timer, and a count taken after it had fired would be counting a
   * legitimate relayout under the new filter.
   */
  it.each(["grid", "table"] as const)(
    "lays the %s view's wall out once, not again on a keystroke in the filter box",
    async (view) => {
      useAppStore.setState({ collectionView: view });
      collectionFolderList.mockResolvedValue([BINDER]);
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      // The rows are in, so the wall has been laid out at its settled shape: the art on a tile,
      // the name in a row.
      await (view === "grid"
        ? screen.findAllByAltText("Lightning Bolt")
        : screen.findAllByText("Lightning Bolt"));
      const laid = vi.mocked(layoutShelves).mock.calls.length;

      fireEvent.change(screen.getByRole("searchbox", { name: "Search your collection" }), {
        target: { value: "b" },
      });

      expect(screen.getByRole("searchbox", { name: "Search your collection" })).toHaveValue("b");
      expect(vi.mocked(layoutShelves).mock.calls.length).toBe(laid);
    },
  );

  /**
   * **The wire, at the root and inside a folder** — `shelves`, and never `folderId` / `rootOnly`.
   * The root is every shelf (the page stops being empty for a reader who files everything), and a
   * folder is its own cards and everything under it.
   */
  it("asks for every shelf at the root, and the opened folder's shelves once opened", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 3, 9]));
    expect(lastQuery().folderId).toBeUndefined();
    expect(lastQuery().rootOnly).toBeUndefined();

    await openShelf(user, "Trade binder");

    await waitFor(() => expect(lastQuery().shelves).toEqual([3, 9]));
    expect(standingIn()).toBe(3);
  });

  /**
   * **Review Focus 2 at the page: a folder whose cards are all in its subfolders** — its heading
   * states the subtree's figures rather than `0 cards`, and there is no empty box under it.
   */
  it("adds a sub-folder's copies into the heading above it, and draws no box under a container", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    collectionList.mockResolvedValue(
      page([{ ...BOLT, folderId: 9, folderName: "Foils", quantity: 4, unitPrice: 22 }]),
    );
    const { container } = wrap(<CollectionPage />);

    const binder = await findHeading("Trade binder");
    await waitFor(() => expect(within(binder).getByText("4 cards · $88.00")).toBeInTheDocument());
    expect(container.querySelector(`[${EMPTY_SHELF_ATTR}]`)).toBeNull();
    // Filed everywhere, loose nowhere: no Not sorted heading at all.
    expect(queryHeading("Not sorted")).toBeNull();
  });

  it("climbs back out through the breadcrumb", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));

    expect(within(crumbs()).getByText("Trade binder")).toHaveAttribute("aria-current", "page");
    await user.click(within(crumbs()).getByRole("button", { name: "Collection" }));

    await waitFor(() => expect(standingIn()).toBeNull());
  });

  /**
   * **Add folder, both doors** (spec §3.8): the path row's makes one at the level, a heading's makes
   * one inside that folder. Both levels in one flow, because a door hard-wired to the root would
   * pass a case that only ever created there.
   */
  it("adds a folder at the level from the path row, and inside a folder from its heading", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await user.click(pathRowAddFolder()!);
    await user.type(await screen.findByRole("textbox", { name: "Folder name" }), "Sealed");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Sealed"));

    await user.click(addIn("Trade binder")!);
    await user.type(await screen.findByRole("textbox", { name: "Folder name" }), "Foils");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(3, "Foils"));
  });

  /** The up tile is gone; the breadcrumb's parent segment is the way up, two levels down too. */
  it("offers the level above as a breadcrumb segment, two levels down", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");
    expect(within(crumbs()).queryByRole("button")).toBeNull();

    await openShelf(user, "Trade binder");
    await openShelf(user, "Foils");
    await waitFor(() => expect(standingIn()).toBe(9));

    expect(within(crumbs()).getByRole("button", { name: "Trade binder" })).toBeInTheDocument();
    expect(within(crumbs()).getByRole("button", { name: "Collection" })).toBeInTheDocument();
  });

  it("walks up one level from the breadcrumb's parent segment", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await openShelf(user, "Foils");
    await waitFor(() => expect(standingIn()).toBe(9));

    await user.click(within(crumbs()).getByRole("button", { name: "Trade binder" }));

    await waitFor(() => expect(standingIn()).toBe(3));
  });

  /** Issue #283's drop, on the segment that replaced the tile. */
  it("files a copy up a level when it is dropped on the breadcrumb's parent segment", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 9, folderName: "Foils" }]));
    const user = userEvent.setup();
    const { container } = wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await openShelf(user, "Foils");
    await waitFor(() => expect(standingIn()).toBe(9));
    await screen.findByText("Lightning Bolt");

    const up = within(crumbs()).getByRole("button", { name: "Trade binder" });
    up.getBoundingClientRect = () => CARD_BOX;
    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    await held.over(up);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
  });

  it("files a copy out of Recently removed and back to the root from the breadcrumb", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 21, folderName: "Recently removed" }]));
    const user = userEvent.setup();
    const { container } = wrap(<CollectionPage />);
    await openShelf(user, "Recently removed");
    await waitFor(() => expect(standingIn()).toBe(21));
    await screen.findByText("Lightning Bolt");

    const root = within(crumbs()).getByRole("button", { name: "Collection" });
    root.getBoundingClientRect = () => CARD_BOX;
    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    await held.over(root);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, null));
  });

  /** A refile is a re-read, never an optimistic patch — the wishlist's three-way bug, fenced. */
  it("re-reads the whole collection after a copy is dropped on a heading", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const { client, container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await findHeading("Trade binder");
    const binder = standHeading("Trade binder");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    await held.over(binder);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  it("refuses a drop onto the heading of the folder the copy is already in", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 3, folderName: "Trade binder" }]));
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await findHeading("Trade binder");
    const binder = standHeading("Trade binder");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    expect(wearsDropMark(binder)).toBe(false);
    await held.over(binder);
    await held.drop();
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });

  /**
   * **The app's own folders are shelves under `Decks`, after the reader's own, and start shut**
   * (spec §3.1, §3.4) — the pinned strip's arrangement, drawn as part of the wall.
   */
  it("draws deck groups and Recently removed under Decks, after the reader's shelves, shut", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    const binder = await findHeading("Trade binder");
    const deck = heading("Mono-Red Aggro");
    const removed = heading("Recently removed");
    const label = screen.getByRole("heading", { level: 3, name: "Decks" });

    expect(follows(binder, label)).toBe(true);
    expect(follows(label, deck)).toBe(true);
    expect(follows(deck, removed)).toBe(true);
    expect(within(deck).getByRole("button", { name: "Expand Mono-Red Aggro" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      within(removed).getByRole("button", { name: "Expand Recently removed" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * **An app-owned shelf offers nothing the backend refuses**: no Add folder, no Rename, no ⋯ and
   * no drag. The reader's own heading has all four, which is what makes the absences a fence.
   */
  it("gives an app-owned shelf no Add folder, no Rename, no menu and no drag", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await findHeading("Mono-Red Aggro");

    for (const name of ["Mono-Red Aggro", "Recently removed"]) {
      expect(addIn(name)).toBeNull();
      expect(renameOf(name)).toBeNull();
      expect(manageOf(name)).toBeNull();
      expect(isDragSource(heading(name))).toBe(false);
    }
    expect(addIn("Trade binder")).toBeInTheDocument();
    expect(renameOf("Trade binder")).toBeInTheDocument();
    expect(manageOf("Trade binder")).toBeInTheDocument();
    expect(isDragSource(heading("Trade binder"))).toBe(true);
  });

  it("refuses a drop onto a deck group's heading", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await findHeading("Mono-Red Aggro");
    const group = standHeading("Mono-Red Aggro");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    expect(wearsDropMark(group)).toBe(false);
    await held.over(group);
    await held.drop();
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });

  it("refuses to drag a copy out of a deck group", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    opened(DECK_GROUP.id);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 20, folderName: "Mono-Red Aggro" }]));
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await findHeading("Trade binder");
    const binder = standHeading("Trade binder");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    expect(wearsDropMark(binder)).toBe(false);
    await held.over(binder);
    await held.drop();
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------------------------------- *
   * The wall is a drag source too, and a tile is not one row
   * ---------------------------------------------------------------------------------------- */

  /**
   * **A tile's drag means two things at once, and both readers have to answer the same payload.**
   * The card half is what a deck category and the sidebar's Decks entry have always taken from
   * this page's *table*; the tile half is what a folder card reads. They travel under different
   * keys so neither can see the other's — `collectionDrag.ts` carries the argument — and a wall
   * that carried only one of them would either lose the deck drop or lose the filing.
   */
  it("picks a wall tile up as a card and as the rows behind the art at once", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(page([BOLT, { ...BOLT, id: 8, finish: "foil" }]));
    const { container } = wrap(<CollectionPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    const tiles = cardSources(container);
    expect(tiles).toHaveLength(1);

    const drags = recordDrags();
    const held = await holdCopy(tiles[0], {
      pressOn: screen.getByRole("button", { name: "Lightning Bolt" }),
    });
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records.map(readDragData)).toEqual([
      { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
    // The same payload, read by the other key: both entries behind the art, with where each
    // one sits — which is what lets a folder refuse the copies already in it.
    expect(drags.records.map(readCollectionTileDrag)).toEqual([
      {
        cardId: "c1",
        name: "Lightning Bolt",
        copies: [
          { entryId: 7, folderId: null },
          { entryId: 8, folderId: null },
        ],
      },
    ]);
  });

  /** The drag carries the tile's own rows: one finish **and one folder** since decision 11. */
  it("picks up only the rows behind the tile's own finish and folder", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(
      page([
        BOLT,
        { ...BOLT, id: 8, finish: "nonfoil" },
        { ...BOLT, id: 9, folderId: 3, folderName: "Trade binder" },
      ]),
    );
    const { container } = wrap(<CollectionPage />);
    await screen.findAllByAltText("Lightning Bolt");

    const tiles = cardSources(container);
    expect(tiles).toHaveLength(3);
    const drags = recordDrags();
    const held = await holdCopy(tiles[0], {
      pressOn: screen.getAllByRole("button", { name: "Lightning Bolt" })[0],
    });
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records.map(readCollectionTileDrag)).toEqual([
      { cardId: "c1", name: "Lightning Bolt", copies: [{ entryId: 7, folderId: null }] },
    ]);
  });

  /**
   * The same fix seen through the menu, which is `copiesByTile`'s **other** consumer
   * (`entryIdsOf` → `tileTarget`'s `entryIds`) and the one that writes without a dialog.
   *
   * **`Move to`, singular, is half the assertion.** `moveItem` counts *entries*: keyed by the
   * card this foil tile would have carried two of them, so the row would have read `Move 2 cards
   * to` and the press would have opened the copy picker instead of filing anything — which is
   * why the dialog is asserted absent as well as the write asserted present.
   */
  it("files only the pressed tile's own finish from the card menu", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([BOLT, { ...BOLT, id: 8, finish: "nonfoil" }]));
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    const tiles = await screen.findAllByRole("button", { name: "Lightning Bolt" });
    rightClick(tiles[0]);
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /^Move to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Trade binder" }));

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    expect(collectionSetFolder).not.toHaveBeenCalledWith(8, 3);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("files a tile that stands for one row without asking", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([BOLT]));
    const { container } = wrap(<CollectionPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });
    await findHeading("Trade binder");
    const binder = standHeading("Trade binder");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByRole("button", { name: "Lightning Bolt" }),
    });
    await held.over(binder);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks which copies when the art stands for more than one row", async () => {
    useAppStore.setState({ collectionView: "grid" });
    const user = userEvent.setup();
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([BOLT, { ...BOLT, id: 8, condition: "LP" }]));
    const { container } = wrap(<CollectionPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });
    await findHeading("Trade binder");
    const binder = standHeading("Trade binder");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByRole("button", { name: "Lightning Bolt" }),
    });
    await held.over(binder);
    await held.drop();

    await screen.findByRole("dialog");
    expect(collectionSetFolder).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Move 4 copies to Trade binder" }));
    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    expect(collectionSetFolder).toHaveBeenCalledWith(8, 3);
  });

  /**
   * **A copy in a deck's group is drawn and refused in the picker, never silently dropped.** A
   * tile no longer mixes a deck's copy with a loose one, so the question reaches the picker the
   * other way it always could: a **picked set** spanning both, moved from the menu.
   */
  it("greys a picked copy that is in a deck, says what to do instead, and never files it", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    opened(DECK_GROUP.id);
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, folderId: 20, folderName: "Mono-Red Aggro" }]),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    const tiles = await screen.findAllByRole("button", { name: "Lightning Bolt" });
    expect(tiles).toHaveLength(2);

    await user.keyboard("{Control>}");
    await user.click(tiles[0]);
    await user.click(tiles[1]);
    await user.keyboard("{/Control}");
    rightClick(tiles[0]);
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /^Move 2 cards to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Trade binder" }));

    await screen.findByRole("dialog");
    const stuck = screen.getByRole("checkbox", { name: /Mono-Red Aggro/ });
    expect(stuck).toBeDisabled();
    expect(stuck).not.toBeChecked();
    expect(stuck).toHaveAccessibleName(/Cut the card from the deck/);
    await user.click(screen.getByRole("button", { name: "Move 2 copies to Trade binder" }));
    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    expect(collectionSetFolder).not.toHaveBeenCalledWith(8, 3);
  });

  /**
   * **Issue #209 without walking into the pile**: at the root, the holding area's shelf and the
   * reader's binders are one wall, so a copy goes back into a binder by dropping it on the heading.
   */
  it("files a copy out of Recently removed onto a binder's heading, and re-reads the list", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    opened(REMOVED.id);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 21, folderName: "Recently removed" }]));
    const { client, container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await findHeading("Trade binder");
    const binder = standHeading("Trade binder");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    await held.over(binder);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
  });

  it("walks a reader back out of a deck group they have no folders of their own", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Mono-Red Aggro");
    await waitFor(() => expect(standingIn()).toBe(20));

    await user.click(within(crumbs()).getByRole("button", { name: "Collection" }));
    await waitFor(() => expect(standingIn()).toBeNull());
  });

  /** A stepper press moves the heading's figures as well as the folder subtotals it is read from. */
  it("re-reads the folder subtotals and the shelf counts after a stepper press on a filed row", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 3, folderName: "Trade binder" }]));
    const { client } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Foil, NM)" }),
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection", "folderSummary"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection", "shelfCounts"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });
  });

  it("says which drawer an export is standing in", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));

    await user.click(screen.getAllByRole("button", { name: "Export collection" })[0]);

    const dialog = await screen.findByRole("dialog", { name: /export/i });
    expect(within(dialog).getByText(/in Trade binder/)).toBeInTheDocument();
    expect(within(dialog).getByText(/ignoring the filters and folders/)).toBeInTheDocument();
  });

  /**
   * **The root's wall is every folder now, so the export has nothing to widen past** — this
   * reverses the case it replaces, which offered "and folders" at a root that meant "filed
   * nowhere". The sweep asks for the wall's own shelves, the shut deck group and holding area
   * included.
   */
  it("offers no folders clause at the root, whose wall is already every folder", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Mono-Red Aggro");

    await user.click(screen.getAllByRole("button", { name: "Export collection" })[0]);

    const dialog = await screen.findByRole("dialog", { name: /export/i });
    expect(within(dialog).queryByText(/in Collection/)).toBeNull();
    expect(within(dialog).queryByText(/and folders/)).toBeNull();
    await waitFor(() =>
      expect(collectionList).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 500, shelves: [UNFILED_SHELF, 20, 21] }),
      ),
    );
  });

  /**
   * **An empty folder is its dashed box, and the status line stays quiet over it** — the box says
   * what to do (spec §3.8), so "Nothing filed here yet." would be the same sentence twice.
   */
  it("draws the empty box, and no sentence, inside a folder with nothing in it", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([]));
    collectionSummary.mockResolvedValue(summary());
    const user = userEvent.setup();
    const { container } = wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));

    await waitFor(() => expect(container.querySelector(`[${EMPTY_SHELF_ATTR}]`)).not.toBeNull());
    expect(screen.queryByText("Nothing filed here yet.")).toBeNull();
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });

  describe("a folder another page asked for", () => {
    it("opens the drawer it names, and spends the hand-off doing it", async () => {
      collectionFolderList.mockResolvedValue([BINDER]);
      useAppStore.setState({ pendingFolder: { scope: "collection", id: 3 } });
      wrap(<CollectionPage />);

      await waitFor(() => expect(standingIn()).toBe(3));
      expect(within(crumbs()).getByText("Trade binder")).toHaveAttribute("aria-current", "page");
      await waitFor(() => expect(useAppStore.getState().pendingFolder).toBeNull());
    });

    it("lands at the root when the folder it names is gone, and refuses nothing", async () => {
      collectionFolderList.mockResolvedValue([BINDER]);
      useAppStore.setState({ pendingFolder: { scope: "collection", id: 404 } });
      wrap(<CollectionPage />);

      expect(await findHeading("Trade binder")).toBeInTheDocument();
      expect(standingIn()).toBeNull();
      await waitFor(() => expect(useAppStore.getState().pendingFolder).toBeNull());
    });

    it("does not survive to a second visit", async () => {
      collectionFolderList.mockResolvedValue([BINDER]);
      useAppStore.setState({ pendingFolder: { scope: "collection", id: 3 } });
      const first = wrap(<CollectionPage />);
      await waitFor(() => expect(standingIn()).toBe(3));

      first.unmount();
      wrap(<CollectionPage />);

      expect(await findHeading("Trade binder")).toBeInTheDocument();
      await waitFor(() => expect(standingIn()).toBeNull());
    });

    it("leaves the wishlist's hand-off untouched", async () => {
      collectionFolderList.mockResolvedValue([BINDER]);
      useAppStore.setState({ pendingFolder: { scope: "wishlist", id: 3 } });
      wrap(<CollectionPage />);

      expect(await findHeading("Trade binder")).toBeInTheDocument();
      expect(standingIn()).toBeNull();
      expect(useAppStore.getState().pendingFolder).toEqual({ scope: "wishlist", id: 3 });
    });
  });
});

/**
 * **The wall at the root**, which is the page this design exists to fix (spec §1): every shelf on
 * one wall, the app's own shut under Decks, and the folds the reader stored — written only by the
 * chevrons and the path row's two buttons, and suspended (never rewritten) by a filter.
 */
describe("the wall at the root", () => {
  /**
   * **The page this design exists to fix** (spec §1): a reader who files everything saw the
   * figures band, the breadcrumb and an empty wall. Now the root's wall is every shelf, so both
   * cards are on screen — one of them two folders down — and the header counts every shelf the wall
   * covers, the shut deck group and holding area included.
   */
  it("shows every card with real figures when everything is filed", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS, DECK_GROUP, REMOVED]);
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, folderId: 3, folderName: "Trade binder", quantity: 2, unitPrice: 5 },
        {
          ...BOLT,
          id: 8,
          cardId: "c2",
          name: "Counterspell",
          folderId: 9,
          folderName: "Foils",
          quantity: 1,
          unitPrice: 2,
        },
      ]),
    );
    collectionSummary.mockResolvedValue(summary({ totalCards: 3, uniqueCards: 2, value: 12 }));
    wrap(<CollectionPage />);

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("Counterspell")).toBeInTheDocument();
    expect(queryHeading("Not sorted")).toBeNull();
    await waitFor(() => expect(lastSummary().shelves).toEqual([UNFILED_SHELF, 3, 9, 20, 21]));
    expect(await screen.findByText("$12.00")).toBeInTheDocument();
    // The headings say the same thing per shelf: Trade binder's covers its child.
    await waitFor(() =>
      expect(within(heading("Trade binder")).getByText("3 cards · $12.00")).toBeInTheDocument(),
    );
  });

  it("draws no Flatten switch", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    expect(screen.queryByRole("button", { name: "Flatten" })).toBeNull();
  });

  /**
   * **Review Focus 3: a collapsed parent hides its whole subtree and fetches none of it; Expand
   * all brings it back.** The press writes the fold (only a move off the default is stored), and
   * Expand all writes the whole level back to its defaults.
   */
  it("hides a collapsed folder's subtree, fetches none of it, and Expand all brings it back", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS, SEALED]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 9, folderName: "Foils" }]));
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Foils");
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();

    await user.click(within(heading("Trade binder")).getByRole("button", { name: "Collapse Trade binder" }));

    await waitFor(() => expect(queryHeading("Foils")).toBeNull());
    expect(screen.queryByText("Lightning Bolt")).toBeNull();
    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 4]));
    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledWith("collection", { "3": true }));
    // Still counted: the shut heading states what is under it.
    expect(lastSummary().shelves).toEqual([UNFILED_SHELF, 3, 9, 4]);

    await user.click(within(pathRow()).getByRole("button", { name: "Expand all" }));

    await findHeading("Foils");
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    await waitFor(() =>
      expect(setShelfFolds).toHaveBeenLastCalledWith("collection", {
        "0": null,
        "3": null,
        "9": null,
        "4": null,
      }),
    );
  });

  /** Collapse all folds the app's own shelves too — to their default, which is shut. */
  it("folds every shelf on Collapse all, the app's own included", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP]);
    opened(DECK_GROUP.id);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Mono-Red Aggro");

    await user.click(within(pathRow()).getByRole("button", { name: "Collapse all" }));

    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).toBeNull());
    await waitFor(() =>
      expect(setShelfFolds).toHaveBeenLastCalledWith("collection", {
        "0": true,
        "3": true,
        "20": null,
      }),
    );
    for (const name of ["Not sorted", "Trade binder", "Mono-Red Aggro"]) {
      expect(within(heading(name)).getByRole("button", { name: `Expand ${name}` })).toBeInTheDocument();
    }
  });

  /**
   * **A shut heading peeks at what it hides** (spec §3.2) — `ShelfCount.peek`, which the counts
   * answer for a collapsed shelf as well as an open one, so a deck group that starts shut still
   * shows the reader which deck it is. Its tiles are not fetched; its thumbnails come with the
   * counts.
   */
  it("peeks at a shut deck group's cards, from the counts, without fetching its tiles", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, id: 7, folderId: 20, folderName: "Mono-Red Aggro" },
        {
          ...BOLT,
          id: 8,
          cardId: "c2",
          name: "Counterspell",
          folderId: 20,
          folderName: "Mono-Red Aggro",
        },
      ]),
    );
    wrap(<CollectionPage />);
    const group = await findHeading("Mono-Red Aggro");

    await waitFor(() =>
      expect(group.querySelectorAll("[data-shelf-peek] img")).toHaveLength(2),
    );
    expect(lastQuery().shelves).not.toContain(20);
    // Shut, so its own cards are not on the wall.
    expect(screen.queryByText("Counterspell")).toBeNull();
  });

  /**
   * **Decision 4: a search opens every shelf it has a match in, hides the rest, and reads `N of M`**
   * — and clearing it hands the folds back without writing one. `M` is the unfiltered folder
   * subtotal; `N` is the counts over the filter.
   */
  it("opens a shut shelf that holds a match while filtering, and states N of M on its heading", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionFolderSummary.mockResolvedValue([{ folderId: 3, cards: 42, value: 100 }]);
    shelfFolds.mockResolvedValue({ collection: { "3": true }, wishlist: {} });
    collectionList.mockResolvedValue(
      page([{ ...BOLT, folderId: 3, folderName: "Trade binder", quantity: 3 }]),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");
    expect(screen.queryByText("Lightning Bolt")).toBeNull();

    await user.type(screen.getByRole("searchbox", { name: "Search your collection" }), "bolt");

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(heading("Trade binder")).getByText("3 of 42 cards")).toBeInTheDocument(),
    );
    // Sealed holds no match, so it is not drawn at all while the filter is on.
    expect(queryHeading("Sealed")).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search your collection" }));

    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).toBeNull());
    expect(await findHeading("Sealed")).toBeInTheDocument();
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /** Reset all is about the filters; where the reader stands and what they folded are theirs. */
  it("leaves the level and the folds alone on Reset all", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));
    await user.type(screen.getByRole("searchbox", { name: "Search your collection" }), "bolt");

    await openTray(user);
    await user.click(onPage(screen.getAllByRole("button", { name: /^Reset all/ })));

    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Search your collection" })).toHaveValue(""),
    );
    expect(standingIn()).toBe(3);
    expect(setShelfFolds).not.toHaveBeenCalled();
  });
});

/**
 * **Add folder** (spec §3.8): on the path row it makes a folder at the level, on a heading inside
 * that folder — and either way the new folder appears where it will live, as a placeholder heading
 * whose name is the field, last among its siblings, over an empty shelf.
 */
describe("Add folder", () => {
  it("is on the path row and on the heading of every folder the reader made, and nowhere else", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    wrap(<CollectionPage />);
    await findHeading("Foils");

    expect(pathRowAddFolder()).toBeInTheDocument();
    expect(addIn("Trade binder")).toBeInTheDocument();
    expect(addIn("Foils")).toBeInTheDocument();
    // Not sorted is not a folder: its only control is its chevron.
    expect(within(heading("Not sorted")).getAllByRole("button")).toHaveLength(1);
  });

  /** `create_folder` refuses the holding area as a parent (`FOLDER_NOT_YOURS`), so neither door is drawn there. */
  it("is not offered inside Recently removed, on its heading or on the path row", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Recently removed");
    expect(addIn("Recently removed")).toBeNull();
    expect(pathRowAddFolder()).toBeInTheDocument();

    await openShelf(user, "Recently removed");
    await waitFor(() => expect(standingIn()).toBe(21));

    expect(pathRowAddFolder()).toBeNull();
    expect(within(pathRow()).getByRole("button", { name: "Expand all" })).toBeInTheDocument();
  });

  it("is not offered inside a deck group", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Mono-Red Aggro");
    expect(addIn("Mono-Red Aggro")).toBeNull();

    await openShelf(user, "Mono-Red Aggro");
    await waitFor(() => expect(standingIn()).toBe(20));

    expect(pathRowAddFolder()).toBeNull();
  });

  /**
   * **The new folder appears where it will live** (spec §3.8): a heading, last among its siblings,
   * over an empty shelf — typed on the line the name will occupy. Nothing else on the wall became a
   * field.
   */
  it("names the new folder on a heading drawn last among its siblings, over an empty shelf", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED, DECK_GROUP, REMOVED]);
    const user = userEvent.setup();
    const { container } = wrap(<CollectionPage />);
    await findHeading("Sealed");

    await user.click(pathRowAddFolder()!);

    const field = await screen.findByRole("textbox", { name: "Folder name" });
    const draft = field.closest<HTMLElement>(`[${SHELF_HEADING_ATTR}]`)!;
    expect(follows(heading("Sealed"), draft)).toBe(true);
    expect(follows(draft, heading("Mono-Red Aggro"))).toBe(true);
    const boxes = [...container.querySelectorAll(`[${EMPTY_SHELF_ATTR}]`)];
    expect(boxes.some((box) => follows(draft, box) && follows(box, heading("Mono-Red Aggro")))).toBe(
      true,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  /** On a heading, inside that folder — and a shut parent opens so the new heading has somewhere to be. */
  it("adds inside a folder from its heading, opening it first when it was shut", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    shelfFolds.mockResolvedValue({ collection: { "3": true }, wishlist: {} });
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");
    expect(queryHeading("Foils")).toBeNull();

    await user.click(addIn("Trade binder")!);

    await waitFor(() => expect(setShelfFolds).toHaveBeenCalledWith("collection", { "3": null }));
    const field = await screen.findByRole("textbox", { name: "Folder name" });
    expect(follows(await findHeading("Foils"), field)).toBe(true);
    await user.type(field, "Showcase");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(3, "Showcase"));
  });

  it("closes the field on ✕ and hands the caret back to Add folder", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(pathRowAddFolder()!);
    expect(await screen.findByRole("textbox", { name: "Folder name" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull());
    expect(pathRowAddFolder()).toHaveFocus();
  });

  it("hands the caret back to Add folder when the write lands", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(pathRowAddFolder()!);
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Sealed");
    await user.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Sealed"));
    await waitFor(() => expect(pathRowAddFolder()).toHaveFocus());
  });

  /**
   * **Walking into another folder closes a field whose parent is no longer on screen** — the
   * `openPanel` clause — reached through a write in flight, the one state the field's own blur
   * does not discard. Without it the page's `"inner"` rung would stand over nothing and eat the
   * Escape that walks the reader back out.
   */
  it("closes a naming field when the reader walks into another folder", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionFolderCreate.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await user.click(pathRowAddFolder()!);
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Sealed");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    expect(screen.getByRole("textbox", { name: "Folder name" })).toBeInTheDocument();

    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));

    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(standingIn()).toBeNull());
  });
});

describe("renaming a folder on its heading", () => {
  /** The field is drawn on the pressed heading, its figures stay beside it (spec §3.8), and every
   *  other heading keeps its title and its Rename. */
  it("draws the field on the pressed heading, and leaves the others resting", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Sealed");

    await user.click(renameOf("Trade binder")!);

    const field = await screen.findByRole("textbox", { name: "Rename Trade binder" });
    const renaming = field.closest<HTMLElement>(`[${SHELF_HEADING_ATTR}]`)!;
    expect(renaming).toHaveAttribute(SHELF_HEADING_ATTR, "3");
    expect(await within(renaming).findByText("0 cards")).toBeInTheDocument();
    expect(within(renaming).queryByRole("button", { name: "Trade binder" })).toBeNull();
    expect(within(renaming).queryByRole("button", { name: "Rename Trade binder" })).toBeNull();
    expect(within(heading("Sealed")).getByRole("button", { name: "Sealed" })).toBeInTheDocument();
    expect(renameOf("Sealed")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("renames the folder from its heading", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await user.click(renameOf("Trade binder")!);
    const field = await screen.findByRole("textbox", { name: "Rename Trade binder" });
    expect(field).toHaveValue("Trade binder");
    await user.clear(field);
    await user.type(field, "Binder");
    await user.click(screen.getByRole("button", { name: "Rename folder" }));

    await waitFor(() => expect(collectionFolderRename).toHaveBeenCalledWith(3, "Binder"));
  });

  /** The Rename button the field replaced is a *new* element when it comes back; `ShelfHeading`'s
   *  `useFolderFieldReturn` is what finds it — the page's own `dismiss` would focus a detached node. */
  it("hands the caret back to Rename when Escape closes the field", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await user.click(renameOf("Trade binder")!);
    await screen.findByRole("textbox", { name: "Rename Trade binder" });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Rename Trade binder" })).toBeNull(),
    );
    expect(renameOf("Trade binder")).toHaveFocus();
  });

  /** The ⋯ keeps what the folder card's menu held, minus Rename, plus the keyboard's reorder
   *  (spec §3.2); Move to folder… and Delete… still open the strip, outside every heading. */
  it("offers Move to folder…, Move up, Move down, Lock and Delete… in the ⋯, and not Rename", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await shelfMenu(user, "Trade binder");
    expect(screen.queryByRole("menuitem", { name: /^Rename/ })).toBeNull();
    for (const row of [/^Move to folder/, /^Move up/, /^Move down/, /^Lock folder/, /^Delete/]) {
      expect(screen.getByRole("menuitem", { name: row })).toBeInTheDocument();
    }
    expect(screen.getByRole("menuitem", { name: /^Move up/ })).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("menuitem", { name: /^Move to folder/ }));
    const move = await screen.findByRole("group", { name: "Move Trade binder into a folder" });
    expect(move.closest(`[${SHELF_HEADING_ATTR}]`)).toBeNull();
    expect(move.parentElement).toHaveClass("border", "border-border");

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Move Trade binder into a folder" })).toBeNull(),
    );
    await shelfMenu(user, "Trade binder");
    await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));
    const remove = await screen.findByRole("group", { name: "Delete Trade binder" });
    expect(remove.closest(`[${SHELF_HEADING_ATTR}]`)).toBeNull();
  });

  /** Move up / Move down are the non-drag reorder (WCAG 2.5.7), written through the placement a
   *  before / after drop makes — and greyed at the ends. */
  it("moves a folder up and down from its ⋯, through the same write a drop makes", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Sealed");

    await shelfMenu(user, "Sealed");
    await user.click(screen.getByRole("menuitem", { name: /^Move up/ }));
    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [4, 3]));
    collectionFolderReorder.mockClear();

    await shelfMenu(user, "Trade binder");
    await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [4, 3]));

    await shelfMenu(user, "Sealed");
    expect(screen.getByRole("menuitem", { name: /^Move down/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

/**
 * **Where the caret goes after Add folder in a heading and after Move up / Move down** (live pass,
 * check 8): to that heading's own control — its `Add folder`, or its `⋯` — brought into view
 * first. Both landed on `<body>` in the shipped window, because the heading the page remembered
 * had been virtualised away (or moved out of the virtual window) by the time the caret came back.
 */
describe("the caret after Add folder in a heading and after a move", () => {
  /**
   * **Let jsdom scroll, for the cases that reveal a heading.** Both views reveal through the
   * virtualiser's `scrollTo`, which jsdom does not implement (this file stubs it as a no-op), clamped
   * to the scroller's `scrollHeight`, which jsdom answers as 0. Returns the undo.
   */
  const letJsdomScroll = () => {
    const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, to: ScrollToOptions | number, y?: number) {
        this.scrollTop = typeof to === "number" ? (y ?? 0) : (to.top ?? this.scrollTop);
        this.dispatchEvent(new Event("scroll"));
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1_000_000,
    });
    return () => {
      if (scrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollTo);
      // jsdom's own `scrollHeight` lives on `Element.prototype`; removing the shadow restores it.
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    };
  };

  /** `count` copies filed in folder `id`, each a card of its own — enough rows to push a band out
   *  of the table's window, or a heading out of the wall's. */
  const filedIn = (id: number, count: number): CollectionRow[] =>
    Array.from({ length: count }, (_, i) => ({
      ...BOLT,
      id: 1000 + i,
      cardId: `c-filed-${i}`,
      name: `Filed ${i}`,
      folderId: id,
      folderName: id === BINDER.id ? BINDER.name : SEALED.name,
    }));
  /** The list over those rows, paged and narrowed to the shelves the query names. */
  const listOf = (rows: readonly CollectionRow[]) => async (q: CollectionQuery) => {
    const shown = rows.filter((row) => q.shelves === undefined || q.shelves.includes(row.folderId!));
    const from = q.offset ?? 0;
    return page(shown.slice(from, from + (q.limit ?? 100)), shown.length);
  };

  /**
   * The census as a move's write leaves it — `order`, in that order — answered only when the case
   * says so, because in the app the write's own answer lands well before the folder list has
   * re-read. Returns the release.
   */
  const rereadAfterReorder = (order: readonly CollectionFolder[]) => {
    const after = order.map((folder, sortOrder) => ({ ...folder, sortOrder }));
    const waiting: (() => void)[] = [];
    let released = false;
    collectionFolderReorder.mockImplementation(async () => {
      collectionFolderList.mockImplementation(() =>
        released
          ? Promise.resolve(after)
          : new Promise((resolve) => waiting.push(() => resolve(after))),
      );
      return [];
    });
    return () => {
      released = true;
      waiting.splice(0).forEach((go) => go());
    };
  };

  /**
   * The move's **write** held until the case answers it (`answer`). The folder list then reads
   * `order` — at once, or, with `reread: "held"`, only once the case lets that read go too
   * (`reread`), which is the app's order of events: the write's answer, then the list's.
   */
  const holdWrite = (
    order: readonly CollectionFolder[],
    { reread = "at once" }: { reread?: "at once" | "held" } = {},
  ) => {
    const after = order.map((folder, sortOrder) => ({ ...folder, sortOrder }));
    const waiting: (() => void)[] = [];
    let released = reread === "at once";
    let answer: (() => void) | undefined;
    collectionFolderReorder.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => {
            collectionFolderList.mockImplementation(() =>
              released
                ? Promise.resolve(after)
                : new Promise((go) => waiting.push(() => go(after))),
            );
            resolve([]);
          };
        }),
    );
    return {
      answer: async () => {
        await waitFor(() => expect(answer).toBeDefined());
        await act(async () => answer!());
      },
      reread: async () => {
        released = true;
        await act(async () => waiting.splice(0).forEach((go) => go()));
      },
    };
  };

  /** A few turns of the event loop, for anything a case says must **not** happen to have had its
   *  chance. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  };

  /** Whether anything on the page has been scrolled — a reveal is a scroll, in either view. */
  const scrolled = () =>
    [...document.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollTop > 0);

  /**
   * **The table keys its rows by position**, so a move used to leave the `⋯` the reader pressed
   * mounted and focused — drawing whichever folder took the moved one's place. The caret has to
   * follow the folder, not the row.
   */
  it("hands the caret to the moved folder's ⋯ after Move up", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Sealed");

    await shelfMenu(user, "Sealed");
    await user.click(screen.getByRole("menuitem", { name: /^Move up/ }));
    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
    // The write has answered; the folder list has not. The heading is still where it was.
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(follows(heading("Trade binder"), heading("Sealed"))).toBe(true);

    await act(async () => reread());

    await waitFor(() => expect(follows(heading("Sealed"), heading("Trade binder"))).toBe(true));
    await waitFor(() => expect(manageOf("Sealed")).toHaveFocus());
  });

  /**
   * **A move far down the table reveals the heading where it landed**, then hands it the caret —
   * `Trade binder` stepped past `Sealed`'s forty rows is a band the virtualiser has not drawn. And
   * **the caret is never left on another folder's control** on the way: the row that drew
   * `Trade binder` draws `Sealed` now, and its `⋯` goes with its folder.
   */
  it("reveals the moved heading in the table, then hands it the caret", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 40)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");

      await shelfMenu(user, "Trade binder");
      // The ⋯ the reader pressed. Were its row re-used for the folder that takes its place, this
      // very element would be relabelled `Manage Sealed` with the caret still on it — so every
      // relabelling is recorded.
      const pressed = manageOf("Trade binder")!;
      const relabelled: string[] = [];
      const watch = new MutationObserver((records) =>
        records.forEach((r) => relabelled.push((r.target as Element).getAttribute("aria-label")!)),
      );
      watch.observe(pressed, { attributes: true, attributeFilter: ["aria-label"] });
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [4, 3]));
      await act(async () => reread());

      // Forty rows down — its band's row index says so, and a band that far down is drawn only
      // because it was revealed — and holding the caret.
      await waitFor(() => {
        expect(manageOf("Trade binder")).toHaveFocus();
        const band = heading("Trade binder").closest('[role="row"]');
        expect(Number(band?.getAttribute("aria-rowindex"))).toBeGreaterThan(40);
      });
      watch.disconnect();
      expect(relabelled).toEqual([]);
      expect(pressed.isConnected).toBe(false);
    } finally {
      undo();
    }
  });

  /**
   * **A caret handed back is spent.** The table answers every new `revealIndex`, so a request left
   * standing after the heading took the caret would drag the reader back to it whenever something
   * above it moved — here, `Sealed` re-reading with ten rows fewer after the reader has scrolled
   * back to the top.
   */
  it("does not bring the heading back once it has taken the caret", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 40)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      const { client } = wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
      await act(async () => reread());
      await waitFor(() => {
        expect(manageOf("Trade binder")).toHaveFocus();
        const band = heading("Trade binder").closest('[role="row"]');
        expect(Number(band?.getAttribute("aria-rowindex"))).toBeGreaterThan(40);
      });

      // The reader scrolls back to the top…
      const scroller = [...document.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.scrollTop > 0,
      )!;
      act(() => {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll"));
      });
      // …and the rows above the heading change under it.
      const asked = collectionList.mock.calls.length;
      collectionList.mockImplementation(listOf(filedIn(SEALED.id, 30)));
      act(() => void client.invalidateQueries({ queryKey: ["collection", "list"] }));
      await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
      for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));

      expect(scroller.scrollTop).toBe(0);
    } finally {
      undo();
    }
  });

  /**
   * **The table reveals Add folder's draft heading**, which lands after the parent's forty rows —
   * and, once the name is committed, reveals the parent's heading again and hands its Add folder
   * the caret.
   */
  it("reveals the draft heading in the table, and gives the caret back to Add folder", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockImplementation(listOf(filedIn(BINDER.id, 40)));
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");

      await user.click(addIn("Trade binder")!);
      const field = await screen.findByRole("textbox", { name: "Folder name" });
      // The reveal took the parent's heading out of the table's window.
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());

      await user.type(field, "Sleeves{Enter}");

      await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(3, "Sleeves"));
      await waitFor(() => expect(addIn("Trade binder")).toHaveFocus());
    } finally {
      undo();
    }
  });

  /**
   * **The grid reveals the name field at the end of the parent's subtree**, which on a long wall
   * scrolls the parent's own heading out of the virtual window — so the opener is detached by the
   * time the field closes. The wall is made long with two hundred cards in `Trade binder`.
   */
  it("hands the caret back to the heading's Add folder once the name is committed", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockImplementation(listOf(filedIn(BINDER.id, 200)));
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");

      await user.click(addIn("Trade binder")!);
      const field = await screen.findByRole("textbox", { name: "Folder name" });
      // The reveal took the parent's heading out of the virtual window.
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());

      await user.type(field, "Sleeves{Enter}");

      await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(3, "Sleeves"));
      await waitFor(() => expect(addIn("Trade binder")).toHaveFocus());
    } finally {
      undo();
    }
  });

  /** The ✕ is a keyboard cancel's twin: the name is given up, and the caret goes back to the
   *  heading's Add folder, revealed first. */
  it("hands the caret back to the heading's Add folder when the field is cancelled", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockImplementation(listOf(filedIn(BINDER.id, 200)));
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");

      await user.click(addIn("Trade binder")!);
      await screen.findByRole("textbox", { name: "Folder name" });
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(addIn("Trade binder")).toHaveFocus());
      expect(collectionFolderCreate).not.toHaveBeenCalled();
    } finally {
      undo();
    }
  });

  /**
   * **A click away is an outside click, and an outside click hands nothing back** (review Minor 5).
   * The reader clicks a tile below the draft: the field is given up, and the wall neither scrolls
   * back up to the parent's heading nor takes the caret off the tile they pressed.
   */
  it("leaves the wall and the caret where a click away put them", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockImplementation(listOf(filedIn(BINDER.id, 200)));
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await user.click(addIn("Trade binder")!);
      await screen.findByRole("textbox", { name: "Folder name" });
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());

      const tiles = [...document.querySelectorAll<HTMLElement>("[data-grid-index]")];
      const tile = tiles[tiles.length - 1].querySelector<HTMLElement>("button")!;
      await user.click(tile);
      for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));

      expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull();
      expect(tile).toHaveFocus();
      expect(queryHeading("Trade binder")).toBeNull();
    } finally {
      undo();
    }
  });

  /** **A blur that leaves the caret nowhere** — away to nothing focusable — is the one blur that
   *  records the return: with nowhere else to be, the caret goes back to the heading's Add folder. */
  it("hands the caret back to the heading's Add folder when a blur leaves it nowhere", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockImplementation(listOf(filedIn(BINDER.id, 200)));
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await user.click(addIn("Trade binder")!);
      const field = await screen.findByRole("textbox", { name: "Folder name" });
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());

      act(() => field.blur());

      await waitFor(() => expect(addIn("Trade binder")).toHaveFocus());
    } finally {
      undo();
    }
  });

  /**
   * **A blur's decision goes with the page** (D4). It waits one task, so a page unmounted in that
   * task — the reader leaving with the very click that blurred the field — must not leave it behind
   * to write into a page that is gone. Nothing a reader sees can witness that, because React drops a
   * write to an unmounted component without a word, so the timer is the witness: the page clears
   * the one its blur scheduled.
   */
  it("clears a blur's waiting decision when the page goes", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    const { unmount } = wrap(<CollectionPage />);
    await findHeading("Trade binder");
    await user.click(addIn("Trade binder")!);
    const field = await screen.findByRole("textbox", { name: "Folder name" });
    const scheduled = vi.spyOn(window, "setTimeout");
    const cleared = vi.spyOn(window, "clearTimeout");
    try {
      act(() => field.blur());
      unmount();

      const decision = scheduled.mock.calls.findIndex(([callback]) =>
        String(callback).includes("blurDecision"),
      );
      expect(decision).toBeGreaterThanOrEqual(0);
      expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[decision].value);
    } finally {
      scheduled.mockRestore();
      cleared.mockRestore();
    }
  });

  /**
   * **A Move is decided at the first folder-list answer after the write** (review Minor 4). Here
   * that answer does not carry the planned order, so the request is dropped — and a later re-read
   * that does carry it must not bring the caret back to the heading the reader has moved on from.
   */
  it.each([
    ["an answer without the planned order", "stale"],
    ["a refusal", "refused"],
  ] as const)("drops a Move's caret on %s, whatever a later re-read says", async (_how, first) => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const moved = [
      { ...SEALED, sortOrder: 0 },
      { ...BINDER, sortOrder: 1 },
    ];
    collectionFolderReorder.mockImplementation(async () => {
      if (first === "stale") collectionFolderList.mockResolvedValueOnce([BINDER, SEALED]);
      else collectionFolderList.mockRejectedValueOnce("database is locked");
      collectionFolderList.mockResolvedValue(moved);
      return [];
    });
    const user = userEvent.setup();
    const { client } = wrap(<CollectionPage />);
    await findHeading("Sealed");

    await shelfMenu(user, "Sealed");
    await user.click(screen.getByRole("menuitem", { name: /^Move up/ }));
    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    // The first answer is in, and it left the heading where it was.
    expect(follows(heading("Trade binder"), heading("Sealed"))).toBe(true);

    act(() => void client.invalidateQueries({ queryKey: ["collection", "folders"] }));
    await waitFor(() => expect(follows(heading("Sealed"), heading("Trade binder"))).toBe(true));
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(manageOf("Sealed")).not.toHaveFocus();
  });

  /**
   * **A layer opened while the write is in flight supersedes the move** (D1). The reader pressed
   * Move down, then Rename on another heading before the write answered: the request is the last
   * layer's business, so when the write lands nothing is recorded — no reveal drags the table down
   * to `Trade binder`, and the rename field keeps the caret.
   */
  it("records nothing for a move whose write answers after a layer opened", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 40)));
    const write = holdWrite([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [4, 3]));

      await user.click(renameOf("Sealed")!);
      const field = await screen.findByRole("textbox");
      await waitFor(() => expect(field).toHaveFocus());

      await write.answer();
      // The move is on screen: `Trade binder` is past Sealed's forty rows, and not drawn.
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());
      await settle();

      expect(queryHeading("Trade binder")).toBeNull();
      expect(scrolled()).toEqual([]);
      expect(screen.getByRole("textbox")).toHaveFocus();
    } finally {
      undo();
    }
  });

  /**
   * **And a request already recorded is dropped by the next layer** — the move's write has answered
   * and its folder list has not, so the request is waiting on its order when Rename opens. It must
   * not wake up when the order lands.
   */
  it("drops a waiting move's request when a layer opens", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 40)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
      await settle();

      await user.click(renameOf("Sealed")!);
      await screen.findByRole("textbox");

      await act(async () => reread());
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());
      await settle();

      expect(queryHeading("Trade binder")).toBeNull();
      expect(scrolled()).toEqual([]);
    } finally {
      undo();
    }
  });

  /**
   * **A move is decided by the first answer after its write, not by the first answer after the
   * press** (D2). Another window's change re-reads the folder list while this write is still in
   * flight — an answer carrying the order as it was, which is no verdict on a write that has not
   * landed. Counted from the press, that answer decided the request the moment the write answered,
   * before the write's own re-read had come back, and dropped it.
   */
  it("is not decided by a folder-list answer that lands while the write is in flight", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const write = holdWrite([SEALED, BINDER], { reread: "held" });
    const user = userEvent.setup();
    const { client } = wrap(<CollectionPage />);
    await findHeading("Sealed");
    await shelfMenu(user, "Sealed");
    await user.click(screen.getByRole("menuitem", { name: /^Move up/ }));
    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());

    const reads = collectionFolderList.mock.calls.length;
    act(() => void client.invalidateQueries({ queryKey: ["collection", "folders"] }));
    await waitFor(() => expect(collectionFolderList.mock.calls.length).toBeGreaterThan(reads));
    await settle();
    expect(follows(heading("Trade binder"), heading("Sealed"))).toBe(true);

    await write.answer();
    // The write has answered and its re-read is out; the heading is still where it was.
    await settle();
    expect(follows(heading("Trade binder"), heading("Sealed"))).toBe(true);
    await write.reread();

    await waitFor(() => expect(follows(heading("Sealed"), heading("Trade binder"))).toBe(true));
    await waitFor(() => expect(manageOf("Sealed")).toHaveFocus());
  });

  /**
   * **A request walked away from is not brought back on the return.** The reader moved `Trade
   * binder` down, walked into `Sealed` before the folder list had re-read, and came back up: the
   * table must not jump to `Trade binder` forty rows down, which they left a level ago.
   */
  it("drops a move's request when the reader walks to another level", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 40)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
      await settle();

      await openShelf(user, "Sealed");
      await waitFor(() => expect(standingIn()).toBe(SEALED.id));
      await act(async () => reread());
      await settle();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(standingIn()).toBeNull());
      await findHeading("Sealed");
      await settle();

      expect(queryHeading("Trade binder")).toBeNull();
      expect(scrolled()).toEqual([]);
    } finally {
      undo();
    }
  });

  /**
   * **And when the level asked for changes, even while the level drawn has not** (D3). The reader
   * asks for `Sealed` while its reads are still arriving, so the page goes on drawing the root —
   * and the move's folder list lands in that hold. The request was made for the root the reader
   * has asked to leave, so the held wall is not scrolled to `Trade binder`.
   */
  it("drops a move's request when another level is asked for, during the hold", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    const rows = filedIn(SEALED.id, 40);
    const parked: (() => void)[] = [];
    const answer = listOf(rows);
    // `Sealed`'s own level is the one whose reads have not answered: its first shelf is its own.
    collectionList.mockImplementation((q: CollectionQuery) =>
      q.shelves?.[0] === SEALED.id
        ? new Promise((resolve) => parked.push(() => void answer(q).then(resolve)))
        : answer(q),
    );
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
      await settle();

      await openShelf(user, "Sealed");
      await waitFor(() => expect(parked.length).toBeGreaterThan(0));
      // Still drawing the root: `Trade binder`'s heading leads the wall.
      expect(queryHeading("Trade binder")).not.toBeNull();

      await act(async () => reread());
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());
      await settle();

      expect(queryHeading("Trade binder")).toBeNull();
      expect(scrolled()).toEqual([]);
    } finally {
      undo();
    }
  });

  /**
   * **A view change drops the request**: a move made in the table, whose folder list lands after the
   * reader switched to the cards, does not scroll the wall they switched to.
   */
  it("drops a move's request when the reader switches view", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 200)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
      await settle();

      const cards = onPage(screen.getAllByRole("button", { name: "Card view" }));
      await user.click(cards);
      await waitFor(() => expect(document.querySelector("[data-grid-index]")).not.toBeNull());

      await act(async () => reread());
      await waitFor(() => expect(queryHeading("Trade binder")).toBeNull());
      await settle();

      expect(queryHeading("Trade binder")).toBeNull();
      expect(scrolled()).toEqual([]);
    } finally {
      undo();
    }
  });

  /**
   * **The heading takes the caret only while nothing else has it** — at the page, not only in the
   * heading's own suite. The reader moved `Trade binder` down and then put the caret in the search
   * box while the folder list re-read: the table still reveals the moved heading, and the caret
   * stays where the reader put it.
   */
  it("reveals the moved heading without taking the caret the reader has put elsewhere", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 40)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");
      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalled());
      await settle();

      const box = screen.getByRole("searchbox", { name: "Search your collection" });
      await user.click(box);
      expect(box).toHaveFocus();

      await act(async () => reread());

      await waitFor(() => {
        const band = heading("Trade binder").closest('[role="row"]');
        expect(Number(band?.getAttribute("aria-rowindex"))).toBeGreaterThan(40);
      });
      await settle();
      expect(manageOf("Trade binder")).not.toHaveFocus();
      expect(box).toHaveFocus();
    } finally {
      undo();
    }
  });

  /**
   * **The grid's half of a move** — `Trade binder` stepped past `Sealed`'s two hundred cards is a
   * heading the wall has not drawn, revealed where it landed and handed the caret.
   */
  it("reveals the moved heading on the wall, then hands it the caret", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionFolderList.mockResolvedValue([BINDER, SEALED]);
    collectionList.mockImplementation(listOf(filedIn(SEALED.id, 200)));
    const reread = rereadAfterReorder([SEALED, BINDER]);
    const undo = letJsdomScroll();
    try {
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await findHeading("Trade binder");

      await shelfMenu(user, "Trade binder");
      await user.click(screen.getByRole("menuitem", { name: /^Move down/ }));
      await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [4, 3]));
      await act(async () => reread());

      // After Sealed's wall, drawn only because it was revealed, and holding the caret.
      await waitFor(() => {
        expect(manageOf("Trade binder")).toHaveFocus();
        expect(queryHeading("Sealed")).toBeNull();
      });
    } finally {
      undo();
    }
  });
});

/**
 * **A drawer the reader has set aside** — issue #365, design §§3–6.
 *
 * The one sentence the whole feature is a consequence of: a locked folder is a drawer the app
 * stops *offering* what is in, without ever stopping the reader reaching it. So everything here is
 * about a mark, two greyed rows and one interruption — and **nothing here is a refusal**, because
 * filing a card into and out of a locked drawer has no Rust fence behind it at all.
 *
 * **Every case is about the *effective* lock**, which is the folder's own flag OR any ancestor's:
 * the badge, the greyed rows and the confirmation are all four computed once by the page over the
 * whole cabinet (`lockedFolderIds`), and the two cases below that put an inherited lock beside an
 * own one are what would go red if any of them started reading `CollectionFolder.locked`.
 */
describe("locking a folder", () => {
  /** `Trade binder`, set aside — the same drawer every other folder block here uses, with the one
   *  column that moved. Spread rather than mutated, so the shared fixture stays unlocked for the
   *  rest of the file. */
  const LOCKED_BINDER: CollectionFolder = { ...BINDER, locked: true };
  /** A second drawer *inside* `Trade binder`, beside {@link FOILS} — what a move that has crossed
   *  nothing needs, since both ends have to be under one locked parent. */
  const SLEEVED: CollectionFolder = {
    id: 10,
    parentId: 3,
    name: "Sleeved",
    kind: "user",
    deckId: null,
    sortOrder: 1,
    locked: false,
    syncUid: "uid-sleeved",
  };

  beforeEach(() => {
    collectionFolderSummary.mockResolvedValue([]);
  });

  /**
   * **The lock, on the heading of the drawer the reader locked and on every heading inside it.**
   * `Foils` carries `locked: false` of its own and wears the mark anyway, because the lock inherits
   * down the tree — and at the root both headings are on one wall.
   */
  it("marks the locked drawer's heading, and every heading inside it", async () => {
    collectionFolderList.mockResolvedValue([LOCKED_BINDER, FOILS]);
    wrap(<CollectionPage />);
    await findHeading("Foils");

    expect(within(heading("Trade binder")).getByRole("img", { name: "Locked" })).toBeInTheDocument();
    expect(within(heading("Foils")).getByRole("img", { name: "Locked" })).toBeInTheDocument();
  });

  /** Nothing is marked in a cabinet nobody has locked, which is every database the upgrade
   *  reaches: schema v33's column is `NOT NULL DEFAULT 0`. */
  it("leaves an unlocked cabinet exactly as it was", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    wrap(<CollectionPage />);

    await findHeading("Trade binder");
    expect(within(heading("Trade binder")).queryByRole("img", { name: "Locked" })).toBeNull();
  });

  /** The press, end to end: one row, the folder's **own** flag, and the id the heading was drawn
   *  from. */
  it("sets a drawer aside from its heading's menu", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await shelfMenu(user, "Trade binder");
    await user.click(screen.getByRole("menuitem", { name: "Lock folder" }));

    await waitFor(() => expect(collectionFolderSetLocked).toHaveBeenCalledWith(3, true));
  });

  /** …and back again. The row is the same row wearing the other word, because it toggles one
   *  flag — a second row would be a second copy of the fact to disagree with the first. */
  it("brings a locked drawer back from the same row", async () => {
    collectionFolderList.mockResolvedValue([LOCKED_BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await shelfMenu(user, "Trade binder");
    expect(screen.queryByRole("menuitem", { name: "Lock folder" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Unlock folder" }));

    await waitFor(() => expect(collectionFolderSetLocked).toHaveBeenCalledWith(3, false));
  });

  /**
   * **Greyed with its reason inside a locked parent**, because unlocking a child of a locked
   * parent changes nothing a reader can see — the badge stays, and so does the lock on every
   * copy filed in it — and a row that reported success over an unmoved badge is worse than a
   * greyed one.
   *
   * `aria-disabled` and never the attribute: a greyed row exists to be *read*. The name is
   * matched with two regexes rather than one string, because this repo's convention is that a
   * greyed row's accessible name carries the reason as well as the label — an exact-string query
   * fails here and reads as "the row is missing".
   */
  it("greys the lock row, with its reason, inside a locked parent", async () => {
    collectionFolderList.mockResolvedValue([LOCKED_BINDER, FOILS]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Foils");

    await shelfMenu(user, "Foils");
    const row = screen.getByRole("menuitem", { name: /Lock folder/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toHaveAttribute("disabled");
    expect(row).toHaveAccessibleName(/a folder above it is locked/);

    await user.click(row);
    expect(collectionFolderSetLocked).not.toHaveBeenCalled();
  });

  /**
   * **Delete… greys on the effective lock**, which is `delete_folder`'s own fence said early:
   * deleting re-files every card in the sub-tree to the root, silently undoing exactly the filing
   * the lock was protecting, so the backend refuses it in words. The UI must not let the press
   * happen at all — the rule app-owned shelves follow, that a control whose only outcome is a
   * sentence explaining that it does not work teaches the reader nothing its absence would not.
   *
   * **Move is asserted live in the same breath**, which is the other half of §4.4: it disturbs no
   * card, so it is not what the lock is about, and a greyed row there would be this feature
   * over-reaching. (Rename is on the heading, not in the ⋯, and the lock leaves it alone too.)
   */
  it("greys Delete…, with its reason, and leaves Move alone", async () => {
    collectionFolderList.mockResolvedValue([LOCKED_BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    await shelfMenu(user, "Trade binder");
    const remove = screen.getByRole("menuitem", { name: /^Delete/ });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).toHaveAccessibleName(/unlock it first/);
    expect(screen.getByRole("menuitem", { name: /^Move to folder/ })).not.toHaveAttribute(
      "aria-disabled",
    );

    await user.click(remove);
    expect(screen.queryByRole("group", { name: "Delete Trade binder" })).toBeNull();
  });

  /** The same greying one level down, wearing the *other* sentence: a drawer whose own flag is off
   *  is unlocked by its parent, so "unlock it first" would send the reader to a row that is itself
   *  greyed. */
  it("greys Delete… inside a locked parent, naming the parent as the reason", async () => {
    collectionFolderList.mockResolvedValue([LOCKED_BINDER, FOILS]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await findHeading("Foils");

    await shelfMenu(user, "Foils");
    const remove = screen.getByRole("menuitem", { name: /^Delete/ });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).toHaveAccessibleName(/a folder above it is locked/);
  });

  /**
   * **And downward** — `delete_folder`'s `FOLDER_HOLDS_LOCKED`. `Trade binder` carries no lock of
   * its own, but deleting it re-files everything under it, a locked `Graded` two levels down
   * included, so the row greys and names the folder *inside* as the reason. Two levels, so a
   * check of the direct children alone would miss it. Its own Lock row stays live: that flag is
   * still the reader's to set.
   *
   * The second render is the control, and it differs only in `Graded`'s flag: a drawer with an
   * unlocked sub-tree keeps a live Delete, so the greying is the lock's and not the children's.
   */
  it("greys Delete… over a locked folder inside it, naming that as the reason", async () => {
    const GRADED: CollectionFolder = {
      ...FOILS,
      id: 11,
      parentId: FOILS.id,
      name: "Graded",
      syncUid: "uid-graded",
    };
    collectionFolderList.mockResolvedValue([BINDER, FOILS, { ...GRADED, locked: true }]);
    const user = userEvent.setup();
    const { unmount } = wrap(<CollectionPage />);
    // The whole sub-tree on the wall, `Graded` included — so the menu opened below is asked about a
    // cabinet the page has finished reading, not one still missing its deepest folder.
    await findHeading("Graded");

    await shelfMenu(user, "Trade binder");
    const remove = screen.getByRole("menuitem", { name: /^Delete/ });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).toHaveAccessibleName(/a folder inside it is locked/);
    expect(screen.getByRole("menuitem", { name: "Lock folder" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await user.click(remove);
    expect(screen.queryByRole("group", { name: "Delete Trade binder" })).toBeNull();
    unmount();

    collectionFolderList.mockResolvedValue([BINDER, FOILS, GRADED]);
    wrap(<CollectionPage />);
    await findHeading("Graded");
    await shelfMenu(user, "Trade binder");
    expect(screen.getByRole("menuitem", { name: /^Delete/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  /**
   * **The drag, which is the one gesture worth interrupting** (design §5).
   *
   * A drop target is a rectangle a pointer can land on by mistake, so a drag across the edge of a
   * set-aside drawer asks first and names the drawer. An explicit menu pick does not, and the last
   * case in this block is the fence for that.
   *
   * The question carries no `dialog` or `alertdialog` role — no confirmation in this app does — so
   * it is found by its `role="group"` name and read for its text, which is the note
   * `CollectionSearchTab`'s cross-deck question already carries.
   */
  /**
   * **A set-aside card is still a card the reader owns** —
   * [issue #436](https://github.com/Msgaihede/mtg-grimoire/issues/436), which narrowed what the
   * lock is for and is the reason this block exists at all.
   *
   * #365 shipped the collection page asking its list and its header with `excludeLocked: true`,
   * so locking a drawer took its copies off the flattened wall **and** out of the reader's card
   * count, unique count and total value. The report was the header — *"38 cards 12 unique value
   * $120" should include locked cards because they are still owned* — and the answer is that the
   * lock was never a statement about what the reader *has*. It is a statement about what the app
   * offers a **deck**, and that half is untouched: `useCollectionSearch` still sends the flag
   * unconditionally, `OWNED_SPARE_SQL` still drops those copies from what a plan can count on,
   * and a share still refuses to publish them.
   *
   * **So absence stopped saying "set aside", and a mark had to start.** Every case here is about
   * that swap, and they come in pairs: the copy is *there*, and it is *marked*. A test that
   * asserted only the mark would go green over a wall that had lost the row it was marking, and
   * one that asserted only the row would go green over the #365 behaviour with the mark bolted
   * on.
   *
   * **Since shelves the lock is on the heading**, which names the drawer above its copies — and on
   * the locked tile's chin too, because a shelf of forty cards scrolls its heading off screen long
   * before its last row.
   */
  describe("a locked drawer's copies, counted and marked", () => {
    /** A copy of the same printing filed in the locked binder, beside {@link BOLT} at the root.
     *  Two rows and two folders, which is what makes every "and the unlocked one is not marked"
     *  half of these cases mean something. */
    const IN_BINDER: CollectionRow = {
      ...BOLT,
      id: 8,
      folderId: 3,
      folderName: "Trade binder",
      // A different grade, so the two are two rows of `collection_entries` rather than one the
      // backend would have folded — `folder_id` is the eleventh term of the grain and would do
      // it alone, but a fixture that leans on that and nothing else reads as an accident.
      condition: "LP",
      quantity: 3,
    };

    beforeEach(() => {
      collectionFolderList.mockResolvedValue([LOCKED_BINDER]);
      collectionList.mockResolvedValue(page([BOLT, IN_BINDER]));
    });

    /**
     * **The issue's own sentence, read off the wire.** Neither the list nor the header may ask
     * the backend to leave a locked drawer out — that flag is what #365 sent and #436 took away.
     *
     * Asserted on **both** calls because widening one alone is the plausible mistake and the
     * worse outcome: `collection::scope` is one predicate list, so a header that asked a
     * different question than the list would count 38 over a wall drawing 26. `useCollection`
     * has the same fence at the hook; this is it at the page, where the reader's figures are.
     */
    it("asks the backend for its list and its header without excluding the lock", async () => {
      wrap(<CollectionPage />);
      await screen.findAllByText("Lightning Bolt");

      await waitFor(() => expect(collectionSummary).toHaveBeenCalled());
      expect(lastQuery().excludeLocked).toBeUndefined();
      const header = collectionSummary.mock.calls[collectionSummary.mock.calls.length - 1][0];
      expect(header.excludeLocked).toBeUndefined();
    });

    it("keeps a locked drawer's copy in the table, under a heading that wears the lock", async () => {
      wrap(<CollectionPage />);
      expect(await screen.findAllByText("Lightning Bolt")).toHaveLength(2);
      await findHeading("Trade binder");

      expect(within(heading("Trade binder")).getByRole("img", { name: "Locked" })).toBeInTheDocument();
      expect(within(heading("Not sorted")).queryByRole("img", { name: "Locked" })).toBeNull();
    });

    /** Per folder now: the loose tile and the set-aside one are two, each with its own count, and
     *  only the set-aside one's chin wears the lock. */
    it("keeps a locked drawer's copy on the wall, and marks its tile", async () => {
      useAppStore.setState({ collectionView: "grid" });
      const { container } = wrap(<CollectionPage />);
      expect(await screen.findAllByAltText("Lightning Bolt")).toHaveLength(2);

      expect(screen.getByText("2 in your collection")).toBeInTheDocument();
      expect(screen.getByText("3 in your collection")).toBeInTheDocument();
      const [loose, filed] = cardSources(container);
      expect(within(filed).getByRole("img", { name: "Locked" })).toBeInTheDocument();
      expect(within(loose).queryByRole("img", { name: "Locked" })).toBeNull();
    });

    it("leaves an unlocked drawer's tile exactly as it was", async () => {
      collectionFolderList.mockResolvedValue([BINDER]);
      collectionList.mockResolvedValue(page([IN_BINDER]));
      useAppStore.setState({ collectionView: "grid" });
      const { container } = wrap(<CollectionPage />);
      await screen.findByAltText("Lightning Bolt");

      const [tile] = cardSources(container);
      expect(within(tile).queryByRole("img", { name: "Locked" })).toBeNull();
      expect(within(tile).getByText("LEA · 161")).toBeInTheDocument();
    });
  });

  describe("dragging a copy across the edge", () => {
    it("asks before filing a copy into a locked drawer, and files it when told to", async () => {
      collectionFolderList.mockResolvedValue([LOCKED_BINDER]);
      const user = userEvent.setup();
      const { container } = wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");
      await findHeading("Trade binder");
      const card = standHeading("Trade binder");

      const held = await holdCopy(cardSources(container)[0], {
        pressOn: screen.getByText("Lightning Bolt"),
      });
      await held.over(card);
      await held.drop();

      const question = await screen.findByRole("group", {
        name: "Move Lightning Bolt into Trade binder",
      });
      // Nothing has moved yet: the question is asked *instead of* the write, not after it.
      expect(collectionSetFolder).not.toHaveBeenCalled();
      expect(question).toHaveTextContent("“Trade binder” is locked.");

      await user.click(within(question).getByRole("button", { name: "Move it" }));
      await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    });

    /** Declining leaves the copy exactly where it was, and takes the question away with it. */
    it("leaves the copy where it is when the reader declines", async () => {
      collectionFolderList.mockResolvedValue([LOCKED_BINDER]);
      const user = userEvent.setup();
      const { container } = wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");
      await findHeading("Trade binder");
      const card = standHeading("Trade binder");

      const held = await holdCopy(cardSources(container)[0], {
        pressOn: screen.getByText("Lightning Bolt"),
      });
      await held.over(card);
      await held.drop();

      const question = await screen.findByRole("group", {
        name: "Move Lightning Bolt into Trade binder",
      });
      await user.click(within(question).getByRole("button", { name: "Leave it there" }));

      await waitFor(() =>
        expect(
          screen.queryByRole("group", { name: "Move Lightning Bolt into Trade binder" }),
        ).toBeNull(),
      );
      expect(collectionSetFolder).not.toHaveBeenCalled();
    });

    /**
     * **Out of a locked drawer asks too**, and the sentence is the other one: a copy leaving goes
     * back among the ones the app offers, which is the reader's own decision being undone rather
     * than made.
     */
    it("asks before taking a copy out of a locked drawer", async () => {
      collectionFolderList.mockResolvedValue([LOCKED_BINDER, SEALED]);
      collectionList.mockResolvedValue(
        page([{ ...BOLT, folderId: 3, folderName: "Trade binder" }]),
      );
      const { container } = wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");
      await findHeading("Sealed");
      const card = standHeading("Sealed");

      const held = await holdCopy(cardSources(container)[0], {
        pressOn: screen.getByText("Lightning Bolt"),
      });
      await held.over(card);
      await held.drop();

      const question = await screen.findByRole("group", {
        name: "Move Lightning Bolt out of Trade binder",
      });
      expect(question).toHaveTextContent("“Trade binder” is locked.");
      expect(collectionSetFolder).not.toHaveBeenCalled();
    });

    /**
     * **A move *within* one locked drawer is not a move across its edge**, and this is the case
     * that says the rule is computed from both ends rather than from either.
     *
     * Both `Foils` and `Sleeved` are effectively locked — they are inside `Trade binder` — so a
     * confirmation keyed on "is the destination locked" would fire here, and one keyed on "are
     * both ends locked" would fire here too. Only naming the *drawer* each end is set aside inside
     * and comparing the two gets this right: nothing has crossed the boundary the reader drew, so
     * the copy files with no question at all.
     */
    it("files a copy between two drawers inside one locked parent without asking", async () => {
      collectionFolderList.mockResolvedValue([LOCKED_BINDER, FOILS, SLEEVED]);
      collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 9, folderName: "Foils" }]));
      const { container } = wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");
      await findHeading("Sleeved");
      const card = standHeading("Sleeved");

      const held = await holdCopy(cardSources(container)[0], {
        pressOn: screen.getByText("Lightning Bolt"),
      });
      await held.over(card);
      await held.drop();

      await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 10));
      expect(screen.queryByRole("group", { name: /^Move Lightning Bolt/ })).toBeNull();
    });

    /**
     * **The drawer is the *outermost* lock, not the nearest one** — which is the half a "walk up
     * to the first locked ancestor" reading gets wrong.
     *
     * `Foils` is locked in its own right *and* sits inside a locked `Trade binder`. It is still
     * one drawer: the reader set the binder aside, and locking a shelf inside it did not carve a
     * second boundary through the middle of what they set aside. Stopping the walk at `Foils`
     * would make this move `Foils → Trade binder`, which is a crossing, and would ask a reader to
     * confirm a move inside their own drawer.
     */
    it("treats a locked drawer inside a locked drawer as one drawer", async () => {
      collectionFolderList.mockResolvedValue([
        LOCKED_BINDER,
        { ...FOILS, locked: true },
        SLEEVED,
      ]);
      collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 9, folderName: "Foils" }]));
      const { container } = wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");
      await findHeading("Sleeved");
      const card = standHeading("Sleeved");

      const held = await holdCopy(cardSources(container)[0], {
        pressOn: screen.getByText("Lightning Bolt"),
      });
      await held.over(card);
      await held.drop();

      await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 10));
      expect(screen.queryByRole("group", { name: /^Move Lightning Bolt/ })).toBeNull();
    });

    /**
     * **A drag that touches no locked drawer at either end is untouched by any of this**, which is
     * every drag in the rest of this file and the reason none of them had to change.
     */
    it("files a copy between two unlocked drawers without asking", async () => {
      collectionFolderList.mockResolvedValue([BINDER, SEALED]);
      const { container } = wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");
      await findHeading("Trade binder");
      const card = standHeading("Trade binder");

      const held = await holdCopy(cardSources(container)[0], {
        pressOn: screen.getByText("Lightning Bolt"),
      });
      await held.over(card);
      await held.drop();

      await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
      expect(screen.queryByRole("group", { name: /^Move Lightning Bolt/ })).toBeNull();
    });

    /**
     * **An explicit menu pick is deliberately not confirmed** (design §5). `Move to folder…` and
     * the card menu's `Add to → <folder>` both put the folder's name in the press the reader made,
     * so a question there would ask them to agree with a sentence they had just typed the answer
     * to — which is `PinnedFolders`' own rule one step further along.
     */
    it("does not ask when the reader names the locked folder themselves", async () => {
      collectionFolderList.mockResolvedValue([LOCKED_BINDER]);
      const user = userEvent.setup();
      wrap(<CollectionPage />);
      await screen.findByText("Lightning Bolt");

      screen
        .getByText("Lightning Bolt")
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await user.click(await screen.findByRole("menuitem", { name: /^Move to/ }));
      await user.click(await screen.findByRole("menuitem", { name: "Trade binder" }));

      await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
      expect(screen.queryByRole("group", { name: /^Move Lightning Bolt/ })).toBeNull();
    });
  });
});

/**
 * **Rearranging the cabinet itself** — a drawer dropped on another drawer's middle goes inside it,
 * and one dropped near an edge lands beside it.
 *
 * The write is always `collection_folder_reorder(parentId, ids)` and `ids` is the **whole** level,
 * in order: `sort_order` is written from position and `parent_id` from the argument, in one
 * transaction, so one gesture both re-parents and places. Sending only the folder that moved is
 * the mistake the command's name invites, which is why every assertion below names the whole list.
 *
 * **The three landings are driven by stating the box.** jsdom has no layout engine, so every real
 * `getBoundingClientRect` is four zeroes and `folderEdge` would answer `inside` for every drop —
 * a test that hoped for a rect would pass over any threshold at all. {@link standHeading} states
 * it, and the pointer is then walked to a fraction down it (a heading is read along the vertical
 * axis), which is the gesture a reader makes.
 */
describe("rearranging the collection's cabinet", () => {
  /** Two drawers at the top level and one inside the first — enough for a nest, a reorder and the
   *  drop that would change nothing. */
  beforeEach(() => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED, FOILS]);
    collectionFolderSummary.mockResolvedValue([]);
  });

  /** Both root headings on screen, which every test here starts from. */
  const wall = async () => {
    await findHeading("Trade binder");
    await findHeading("Sealed");
  };

  it("files a drawer inside the one it is dropped on the middle of", async () => {
    wrap(<CollectionPage />);
    await wall();
    const binder = standHeading("Trade binder");

    const held = await holdHeading("Sealed");
    await held.over(binder, AT_CENTRE);
    await held.drop();

    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(3, [9, 4]));
  });

  it("places a drawer before the one it is dropped on the top of", async () => {
    wrap(<CollectionPage />);
    await wall();
    const binder = standHeading("Trade binder");

    const held = await holdHeading("Sealed");
    await held.over(binder, AT_TOP);
    await held.drop();

    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [4, 3]));
  });

  it("draws no line and writes nothing for a drop that would change nothing", async () => {
    wrap(<CollectionPage />);
    await wall();
    const binder = standHeading("Trade binder");

    const held = await holdHeading("Sealed");
    await held.over(binder, AT_BOTTOM);
    expect(binder.querySelector("[data-folder-drop-line]")).toBeNull();
    await held.drop();
    expect(collectionFolderReorder).not.toHaveBeenCalled();
  });

  it("reorders into the level on screen, even beside a drawer whose parent is gone", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED, ORPHAN, FOILS]);
    wrap(<CollectionPage />);
    await wall();
    await findHeading("Odds and ends");
    const orphan = standHeading("Odds and ends");

    const held = await holdHeading("Sealed");
    await held.over(orphan, AT_BOTTOM);
    await held.drop();

    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [3, 5, 4]));
  });

  it("refuses a drawer dropped on itself, at every landing", async () => {
    wrap(<CollectionPage />);
    await wall();

    for (const at of [AT_TOP, AT_CENTRE, AT_BOTTOM]) {
      const held = await holdHeading("Sealed");
      await held.over(heading("Sealed"), at);
      await held.drop();
    }
    expect(collectionFolderReorder).not.toHaveBeenCalled();
  });

  /**
   * **The `kind` fence, which is this cabinet's alone.**
   * `collection_folders::reorder_folders` calls `user_folder` on the destination *and* on every id
   * it is handed, so a deck's group or `Recently removed` at either end is `FOLDER_NOT_YOURS` in
   * words. **No gesture on this page reaches it**: an app-owned heading is neither a folder drop
   * target nor a drag source, which the test below this one pins from the other side. So the
   * payload is built by hand here — the drag a future change would create, refused today.
   */
  it("refuses a folder the app owns, even when something puts one in the air", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED, DECK_GROUP, REMOVED]);
    const { container } = wrap(<CollectionPage />);
    await wall();

    const source = document.createElement("div");
    source.textContent = "the deck group";
    source.getBoundingClientRect = () => SOURCE_BOX;
    container.append(source);
    const stop = folderDraggable({
      element: source,
      folder: (): FolderDrag => ({
        folderId: DECK_GROUP.id,
        name: DECK_GROUP.name,
        parentId: null,
        scope: "collection",
      }),
    });

    const binder = standHeading("Trade binder");
    const held = await startPointerDrag(source);
    // Not even armed: no heading on the wall would take it at any landing.
    expect(wearsDropMark(binder)).toBe(false);

    await held.over(binder, AT_CENTRE);
    await held.drop();
    stop();
    source.remove();
    expect(collectionFolderReorder).not.toHaveBeenCalled();
  });

  it("leaves the app's own folders out of the gesture entirely", async () => {
    collectionFolderList.mockResolvedValue([BINDER, SEALED, DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await wall();
    const group = heading("Mono-Red Aggro");
    expect(isDragSource(group)).toBe(false);

    const held = await holdHeading("Sealed");
    expect(wearsDropMark(group)).toBe(false);
    await held.cancel();
  });

  /**
   * **The cycle fence, reachable now.** The band drew one level, so a descendant was never on
   * screen beside its ancestor and this case had to build its drag by hand; the wall draws the
   * whole subtree, so the parent's own heading is dragged onto its child's.
   */
  it("refuses a drawer dropped into something it holds", async () => {
    wrap(<CollectionPage />);
    await wall();
    await findHeading("Foils");
    const foils = standHeading("Foils");

    for (const at of [AT_TOP, AT_CENTRE, AT_BOTTOM]) {
      const held = await holdHeading("Trade binder");
      expect(wearsDropMark(foils)).toBe(false);
      await held.over(foils, at);
      await held.drop();
    }
    expect(collectionFolderReorder).not.toHaveBeenCalled();
  });

  it("still files a copy dropped on a heading", async () => {
    const { container } = wrap(<CollectionPage />);
    await wall();
    await screen.findByText("Lightning Bolt");
    const binder = standHeading("Trade binder");

    const held = await holdCopy(cardSources(container)[0], {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    await held.over(binder);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    expect(collectionFolderReorder).not.toHaveBeenCalled();
  });

  /** The up tile's folder drop, on the path row's segment (the only segments that take a folder). */
  it("moves a drawer up a level when its heading is dropped on a breadcrumb segment", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await wall();
    await openShelf(user, "Trade binder");
    await findHeading("Foils");
    const root = within(crumbs()).getByRole("button", { name: "Collection" });
    root.getBoundingClientRect = () => CARD_BOX;

    const held = await holdHeading("Foils");
    await held.over(root);
    await held.drop();

    await waitFor(() => expect(collectionFolderReorder).toHaveBeenCalledWith(null, [3, 4, 9]));
  });

  /**
   * **Spec §3.9: for the length of a folder drag every shelf folds to its heading** — a
   * render-time override that writes nothing, and unfolds when the drag ends.
   */
  it("folds every shelf to its heading while a folder is carried, and unfolds after", async () => {
    // Card view: the table never folds — `VirtualTable` keys its rows by position, so folding
    // under a carried heading would remount it and end the drag.
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, folderId: 3, folderName: "Trade binder" }]),
    );
    // **A viewport tall enough for the whole unfolded wall.** The grid virtualises against the
    // 600px this file stubs, and two rows of tiles (~290px each) put `Sealed`'s heading — the one
    // this case picks up — past the window and the overscan, so it would never mount to be held.
    const tall = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 2000 });
    try {
      wrap(<CollectionPage />);
      await wall();
      expect(await screen.findAllByAltText("Lightning Bolt")).toHaveLength(2);

      const held = await holdHeading("Sealed");

      await waitFor(() => expect(screen.queryAllByAltText("Lightning Bolt")).toHaveLength(0));
      for (const name of ["Not sorted", "Trade binder", "Foils", "Sealed"]) {
        expect(
          within(heading(name)).getByRole("button", { name: `Expand ${name}` }),
        ).toHaveAttribute("aria-expanded", "false");
      }
      expect(setShelfFolds).not.toHaveBeenCalled();

      await held.cancel();
      await waitFor(() => expect(screen.getAllByAltText("Lightning Bolt")).toHaveLength(2));
    } finally {
      if (tall) Object.defineProperty(HTMLElement.prototype, "offsetHeight", tall);
    }
  });

  /** And the table does not fold: its headings are still sources and targets, its rows stay. */
  it("leaves the table's rows where they are while a folder is carried", async () => {
    useAppStore.setState({ collectionView: "table" });
    wrap(<CollectionPage />);
    await wall();
    await screen.findByText("Lightning Bolt");

    const held = await holdHeading("Sealed");

    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    expect(
      within(heading("Trade binder")).getByRole("button", { name: "Collapse Trade binder" }),
    ).toHaveAttribute("aria-expanded", "true");
    await held.cancel();
  });
});

/**
 * **Escape is the way back out of a drawer** — the floor of the dismiss ladder, and the same step
 * the breadcrumb's last pressable segment takes.
 *
 * Two halves, and the second is what makes the first safe. The page registers a `"navigation"`
 * rung that walks one level up, `enabled` only while the reader is *inside* something — at the
 * root the press is nobody's here and has to fall through. And the filter box owns the press while
 * it has text in it (`clearFieldOnEscape`), because Chromium empties an `<input type="search">` on
 * Escape by itself **without** marking the press handled, so without that half one press would
 * clear the box and walk the reader up a folder at the same time.
 *
 * jsdom implements neither the native clear nor its missing `preventDefault`, so what is driven
 * below is the JS behaviour alone: the box's own handler, and what the page does with a press it
 * is left.
 */
describe("Escape walks out of a folder", () => {
  /**
   * A real press at the caret — never `window.dispatchEvent`, which collapses the capture phase
   * into registration order and reports a ladder this app does not have.
   *
   * The return value is the load-bearing half: `fireEvent` hands back `dispatchEvent`'s own
   * boolean, so `false` means something called `preventDefault()` and **took** the press. That is
   * the only way to tell "the rung was disabled" from "the rung ran and had nowhere to go", which
   * are the same picture on screen and opposite facts about every other layer in the app.
   */
  const escape = (on: Element = document.body) =>
    fireEvent.keyDown(on, { key: "Escape", code: "Escape" });

  const filterBox = () => screen.getByRole("searchbox", { name: "Search your collection" });

  /** Opened by its heading's title (spec §3.7), and Escape walks one level up — the breadcrumb's
   *  own parent segment, unchanged. */
  it("goes up one level after a folder is opened by its title, and the breadcrumb says so", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    wrap(<CollectionPage />);
    await openShelf(userEvent, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));
    await openShelf(userEvent, "Foils");
    await waitFor(() => expect(standingIn()).toBe(9));

    expect(escape()).toBe(false);

    await waitFor(() => expect(standingIn()).toBe(3));
    expect(within(crumbs()).getByText("Trade binder")).toHaveAttribute("aria-current", "page");
  });

  /**
   * **One press, one layer — with the copy editor open the floor gets nothing.**
   *
   * `Edit copy…` lives in this page's `Panel` union beside the three folder layers, and it is the
   * one member that is **not** the page's own Escape rung's business: it is drawn as a `Dialog`,
   * and every `Dialog` registers its own `"inner"` rung on its open flag. That rung listens in the
   * capture phase and `preventDefault()`s, so the `"navigation"` rung below — which is bubble
   * phase and returns early on `defaultPrevented` — never sees the press.
   *
   * What would go wrong without the split is not two closes: `captureStack` gives the press to
   * whichever `"inner"` layer is on top, so it would still be one. It is the *focus* — the page's
   * `dismiss` hands the caret back to {@link openerRef}, which only ever holds a heading's
   * control, and a copy editor raised from a context-menu row has no opener at all.
   */
  it("closes the copy editor and leaves the reader in the folder", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 3, folderName: "Trade binder" }]));
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));

    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Edit copy…" }));
    await screen.findByRole("dialog", { name: "Edit copy" });

    expect(escape()).toBe(false);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Still in the drawer: the press was the dialog's, and the floor got nothing.
    expect(standingIn()).toBe(3);
  });

  /**
   * **At the root the press is not this page's**, and `enabled` is the whole of that.
   *
   * A registered layer takes the press whether or not it has anywhere to go, so a rung left on at
   * the top of the cabinet would be a floor with nothing under it — every Escape on this page
   * would stop here and reach nothing else that might one day want the last one. Which is why the
   * assertion is `defaultPrevented` and not the folder: `openFolder(null)` at the root is a no-op,
   * so a rung that wrongly consumed the press would draw exactly the same screen.
   */
  it("leaves the press alone at the root", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(escape()).toBe(true);

    expect(standingIn()).toBeNull();
  });

  /**
   * **A deck group and `Recently removed` need no branch of their own**, and that is a fact about
   * `trailOf` rather than luck: it is handed every folder where the *tree* beside it is handed
   * only the reader's, so a pinned folder has a one-segment trail and the step up is the root —
   * the same place its breadcrumb goes. Schema v25 writes `parent_id` `NULL` on every pinned row
   * and no command can nest anything under one, so one segment is the only shape either can take.
   */
  it("walks back out of a deck group", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await openShelf(userEvent, "Mono-Red Aggro");
    await waitFor(() => expect(standingIn()).toBe(20));

    expect(escape()).toBe(false);

    await waitFor(() => expect(standingIn()).toBeNull());
  });

  /** The holding area is the other app-owned kind, and the reader leaves it the same way. */
  it("walks back out of Recently removed", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await openShelf(userEvent, "Recently removed");
    await waitFor(() => expect(standingIn()).toBe(21));

    expect(escape()).toBe(false);

    await waitFor(() => expect(standingIn()).toBeNull());
  });

  /**
   * **The filter box owns one press, and only while it has something to spend it on.**
   *
   * The folder assertion is the point rather than the cleared box: a reader filtering inside a
   * drawer presses Escape to undo the filter, and a press that did both would take the drawer out
   * from under the list they were looking at.
   */
  it("empties the filter box first, and walks out on the next press", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));
    await user.type(filterBox(), "bolt");

    await user.keyboard("{Escape}");

    expect(filterBox()).toHaveValue("");
    expect(standingIn()).toBe(3);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(standingIn()).toBeNull());
  });

  /** An empty box has nothing to undo, so the press is not its — the reader who cleared the filter
   *  with the ✕ and pressed again goes up a level, from the same caret. */
  it("lets an empty filter box hand the press on", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));
    await user.click(filterBox());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(standingIn()).toBeNull());
  });

  it("closes the add-folder field without leaving the folder", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));
    await user.click(pathRowAddFolder()!);
    expect(screen.getByRole("textbox", { name: "Folder name" })).toBeInTheDocument();

    expect(escape()).toBe(false);

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull());
    expect(standingIn()).toBe(3);
  });
});

/**
 * **FAIL 14 of the Folder Shelves live pass, on the page** — walking up to a level nothing has
 * cached drew `Cards 5 · $13.55` (the level being left) over a wall missing its own leading row,
 * for 36–106 ms. `useCollection`'s own suite pins the rule render by render; this pins the page's
 * half of it: the figures band, the breadcrumb and the wall are all drawn from the level on
 * screen, and the page's navigation from the level asked for.
 *
 * `Foils` is opened straight from the root's wall, so its parent `Trade binder` has never been
 * asked for — and each level answers with a card and a figure of its own, so a mix is visible.
 */
describe("walking up to a level nothing has cached", () => {
  const LEVEL_ROWS = new Map<number | null, CollectionRow[]>([
    [null, [BOLT]],
    [3, [{ ...BOLT, id: 13, cardId: "c-binder", name: "Binder Bolt", folderId: 3 }]],
    [9, [{ ...BOLT, id: 19, cardId: "c-foils", name: "Foils Bolt", folderId: 9 }]],
  ]);
  const LEVEL_CARDS = new Map<number | null, number>([
    [null, 111],
    [3, 333],
    [9, 555],
  ]);
  const levelOf = (q: CollectionQuery): number | null => {
    const first = q.shelves?.[0];
    return first === undefined || first === UNFILED_SHELF ? null : first;
  };
  /** The answers for `Trade binder`, parked until a case lets them go. The counts are derived from
   *  the list's own answer, so parking the list parks them too — `parkList` off parks the figures
   *  alone. */
  let parked: (() => void)[] = [];
  let parkList = true;
  const answerFor = <T,>(q: CollectionQuery, value: T, list = false): Promise<T> =>
    levelOf(q) === 3 && (parkList || !list)
      ? new Promise((resolve) => parked.push(() => resolve(value)))
      : Promise.resolve(value);
  const releaseBinder = async () => {
    await waitFor(() => expect(parked.length).toBeGreaterThan(0));
    await act(async () => parked.splice(0).forEach((go) => go()));
  };
  const escape = () => fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

  beforeEach(() => {
    parked = [];
    parkList = true;
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    collectionList.mockImplementation((q: CollectionQuery) =>
      // `Trade binder` says it holds more than one page, so a wall that asks for the next one can.
      answerFor(q, page(LEVEL_ROWS.get(levelOf(q)) ?? [], levelOf(q) === 3 ? 250 : undefined), true),
    );
    collectionSummary.mockImplementation((q: CollectionQuery) =>
      answerFor(q, summary({ totalCards: LEVEL_CARDS.get(levelOf(q)) ?? 0 })),
    );
  });

  /** The breadcrumb's segment for the level it says the reader is standing in. */
  const current = () => crumbs().querySelector('[aria-current="page"]');

  it("keeps drawing the level being left until the one walked to has answered", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Foils");
    expect(await screen.findByText("555")).toBeInTheDocument();
    expect(await screen.findByText("Foils Bolt")).toBeInTheDocument();

    expect(escape()).toBe(false);

    // Asked for — the reads have gone out — and not yet drawn: the breadcrumb, the figures and the
    // wall are all still `Foils`', with nothing of `Trade binder`'s beside them.
    await waitFor(() => expect(standingIn()).toBe(3));
    expect(current()).toHaveTextContent("Foils");
    expect(screen.getByText("555")).toBeInTheDocument();
    expect(screen.getByText("Foils Bolt")).toBeInTheDocument();
    expect(screen.queryByText("333")).toBeNull();

    await releaseBinder();

    await waitFor(() => expect(current()).toHaveTextContent("Trade binder"));
    expect(screen.getByText("333")).toBeInTheDocument();
    expect(await screen.findByText("Binder Bolt")).toBeInTheDocument();
    expect(screen.queryByText("555")).toBeNull();
  });

  /** **Two presses are two levels.** Escape steps up from the level asked for, so a second press
   *  inside the round trip goes on to the root rather than asking for `Trade binder` again. */
  it("walks two levels on two quick presses", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Foils");
    await screen.findByText("555");

    expect(escape()).toBe(false);
    await waitFor(() => expect(standingIn()).toBe(3));
    expect(escape()).toBe(false);

    await waitFor(() => expect(standingIn()).toBeNull());
    await waitFor(() => expect(within(crumbs()).queryByText("Foils")).toBeNull());
    expect(await screen.findByText("111")).toBeInTheDocument();
  });

  /**
   * **Nothing pages past the rows of a level that is not drawn yet.** With `Trade binder`'s first
   * page in and its figures still out, the wall on screen is `Foils`' — so a wall reaching its end
   * is at the end of *those* rows, and `query` (already `Trade binder`'s list, which says 250) must
   * not be asked for a second page of a list the reader cannot see.
   */
  it("asks for no second page of a level while the previous one is still drawn", async () => {
    parkList = false;
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Foils");
    await screen.findByText("Foils Bolt");

    escape();
    await waitFor(() =>
      expect(collectionList.mock.calls.some(([q]) => levelOf(q as CollectionQuery) === 3)).toBe(
        true,
      ),
    );
    // Let the first page land, re-render the page and give the table's end-of-list check its turn.
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(screen.getByText("Foils Bolt")).toBeInTheDocument();
    expect(
      collectionList.mock.calls.filter(([q]) => {
        const asked = q as CollectionQuery;
        return levelOf(asked) === 3 && (asked.offset ?? 0) > 0;
      }),
    ).toEqual([]);
  });
});

/**
 * **G1 — the tile a phone is handed, and the proof this wall is wired to ask for it.**
 *
 * A 390px window with the bottom tab bar instead of the rail leaves this wall **324px** once
 * `main`'s `p-5` and the scroller's own `border` + `p-3` are off it, and at the standard 170 that
 * is a single column with 90px of margin either side. `PHONE_TILE_WIDTH` and the arithmetic that
 * chose it live in `CardGrid.tsx`; what is asserted here is only that this call site asks the
 * question at all — a width that is right in a constant and never passed is the failure mode.
 *
 * **The prop, not a pixel.** jsdom lays nothing out, so the wall measures itself at 0 and
 * `tileWidthFor` answers a zero-width wall with the size it was asked for — which is what makes
 * the tile's own inline width a faithful reading of the prop and nothing else.
 */
describe("the tile the collection's wall is given at the phone width", () => {
  beforeEach(() =>
    // `cardZoom` scales this width and lives in a module-level store that outlives a render, so
    // a suite that left `collection` above 1× would be measured here.
    useAppStore.setState({ collectionView: "grid", cardZoom: { ...DEFAULT_SECTION_ZOOMS } }),
  );

  afterEach(() => vi.unstubAllGlobals());

  /** The tile's root — the box the width is set on, not the art button that takes the caret. */
  const tileOf = (art: HTMLElement) => art.closest("[data-grid-index]");

  it("hands the wall the phone's narrower tile below the phone width", async () => {
    stubNarrowWindow(true);
    wrap(<CollectionPage />);

    const art = (await screen.findAllByAltText("Lightning Bolt"))[0];
    expect(tileOf(art)).toHaveStyle({ width: `${PHONE_TILE_WIDTH}px` });
  });

  it("leaves the wall's own default standing at every other width", async () => {
    stubNarrowWindow(false);
    wrap(<CollectionPage />);

    // 170 is `CardGrid`'s `TILE_BASE_WIDTH`, module-private and pinned by that component's own
    // suite. Spelled here because what this case is about is that the prop is *absent* — a wall
    // passing 144 unconditionally would pass the case above.
    const art = (await screen.findAllByAltText("Lightning Bolt"))[0];
    expect(tileOf(art)).toHaveStyle({ width: "170px" });
  });
});

/**
 * **The collection wall in a browser**, which drew named, artless frames until 2026-08-31.
 *
 * `collection_list` is routed on web (`web/route.rs`'s `COMMANDS`), but its rows carried no
 * picture and `mtgimg://` is a Tauri custom protocol wasm cannot register with a browser — so
 * every tile fell through to `CardArt`'s no-art frame while the search wall beside it drew
 * pictures. The device pass of 2026-08-30 could not see it, because the collection was empty.
 *
 * The branch itself is `cardArtSrc`'s, in `@/lib/images`, and neither this page nor `CardGrid`
 * knows which build it is in. What these two cases say is that this wall is *wired* to it.
 */
describe("the collection wall's art", () => {
  /** One key, because `WALL_CARD_VARIANT` is the one size any wall draws. */
  const SCRYFALL = { display: "https://cards.scryfall.io/display/front/c/1/c1.webp?1706230661" };

  // Restored inside this block, so nothing else in the suite has to know the flag exists.
  afterEach(() => {
    vi.mocked(isWebTarget).mockReturnValue(false);
  });

  it("draws the row's own picture in a browser", async () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(page([{ ...BOLT, imageUris: SCRYFALL }]));
    wrap(<CollectionPage />);

    expect(await screen.findByAltText("Lightning Bolt")).toHaveAttribute("src", SCRYFALL.display);
  });

  /**
   * The row carries the URL on **both** builds — one DTO, one shape — so the desktop claim is
   * that the local cache still wins, not that nothing was passed. A wall that preferred the
   * supplied URL would refetch a screenful of art the cache already holds, over the network and
   * at Scryfall's expense, and it would still draw cards — so there would be nothing to see.
   */
  it("keeps drawing the cached protocol picture on desktop", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(page([{ ...BOLT, imageUris: SCRYFALL }]));
    wrap(<CollectionPage />);

    const src = (await screen.findByAltText("Lightning Bolt")).getAttribute("src");
    expect(src).toContain("mtgimg");
    expect(src).not.toContain("scryfall.io");
  });
});

/**
 * **Which box scrolls the binder** — the page, or a box inside it.
 *
 * The wall took `CardGrid`'s `grow` on 2026-09-08, so in grid view it is as tall as its rows and
 * `AppShell`'s `main` is what scrolls them; the table did not, because `VirtualTable` mounts the
 * rows in view and holds a spacer open for the rest, and a virtualiser given no height renders
 * every row of a 100 k-row collection. That split is three classes on three elements, and this
 * block is what keeps the three agreeing with each other.
 *
 * **jsdom has no layout engine, so nothing here can measure a scroll.** What it can see is the
 * classes, which is exactly where this defect would live: a `min-h-0 flex-1` left on the desk row
 * caps a growing wall at one screen and clips the rest, and an `h-full` taken off the section
 * collapses the table to nothing. Both are silent — every existing case in this file passes
 * either way, because a row still renders in a box of zero height. The shipped window is the only
 * witness to the behaviour; these are the wiring.
 *
 * The two anchors are the list itself under each view — `role="group"` for the wall,
 * `role="table"` for the table, both named `Your collection` — and the boxes are reached by
 * `closest` from there rather than by position, so a box inserted between them does not silently
 * move what is asserted.
 */
describe("which box scrolls the binder", () => {
  /** The desk row: the flex row the list column and the docked search column share. */
  const deskOf = (list: HTMLElement) => list.closest(".gap-4");
  /** The page's own root, which is the top of the table's height chain. */
  const sectionOf = (list: HTMLElement) => list.closest("section");

  it("gives the grid view no scrollport of its own, and no height to be clipped by", async () => {
    useAppStore.setState({ collectionView: "grid" });
    wrap(<CollectionPage />);

    const wall = await screen.findByRole("group", { name: "Your collection" });
    // `grow`'s own half: the wall keeps its padding and drops the scrollport and the frame it
    // used to draw around one. `classList.contains` rather than a `toHaveClass` on the string,
    // because these are the classes that must be **absent**.
    expect(wall.classList.contains("overflow-auto")).toBe(false);
    expect(wall.classList.contains("border")).toBe(false);
    expect(wall).toHaveClass("shrink-0");

    // And the two boxes above it: neither may hand the wall a height, or a wall as tall as its
    // rows is drawn inside one screen and the rest of the binder is unreachable.
    expect(deskOf(wall)).not.toHaveClass("min-h-0");
    expect(deskOf(wall)).not.toHaveClass("flex-1");
    expect(sectionOf(wall)).not.toHaveClass("h-full");
  });

  it("keeps the table's height chain whole, from the section down to the scrollport", async () => {
    useAppStore.setState({ collectionView: "table" });
    wrap(<CollectionPage />);

    const table = await screen.findByRole("table", { name: "Your collection" });
    // Read bottom-up, because that is the order the chain fails in: the scrollport is the
    // `VirtualTable`'s, it has a height only while the desk row has one, and the desk row has one
    // only while the section is pinned to `main`.
    //
    // **The scrollport is the table's parent on a shelved table**: with a sticky band live,
    // `VirtualTable` scrolls a plain `div` around the `role="table"` element, because the bar it
    // pins may not be owned by a table.
    expect(table.parentElement).toHaveClass("overflow-auto");
    expect(deskOf(table)).toHaveClass("min-h-0", "flex-1");
    expect(sectionOf(table)).toHaveClass("h-full");
  });
});

/* -------------------------------------------------------------------------------------------- *
 * The docked card search (design §4, §5, §8)
 * -------------------------------------------------------------------------------------------- */

/**
 * The column beside the binder — **the path by which a card the reader does not own yet gets into
 * the drawer they are standing in.**
 *
 * Everything here is about the *page's* half of the arrangement: the shell's three drawn states,
 * the disclosure and the splitter are `CardSearchPanel.test.tsx`'s, and the popup's own behaviour
 * is `AddToCollection.test.tsx`'s. What only this file can say is which folder reaches the wire,
 * and that a drop on a folder card is an **add** rather than a refile.
 */
describe("the docked card search", () => {
  /** The panel's tile for one card, as a drag source — the element `dragRecord` registered on. */
  const panelTile = (name: string): HTMLElement =>
    within(searchColumn()!)
      .getByRole("button", { name })
      .closest(`[${DND_SOURCE_ATTR}]`) as HTMLElement;

  /** The `+` on the panel's tile, whose accessible name states where a press would file. */
  const quickAdd = () =>
    within(searchColumn()!).getByRole("button", { name: /^Add Black Lotus/ });

  /** Press the `+`, then the popup's own Add. Two presses because they are two decisions: the
   *  popup is where a reader says the finish, the grade and the price if they want to. */
  async function addFromPanel(user: { click: (element: Element) => Promise<unknown> }) {
    await user.click(quickAdd());
    await user.click(await screen.findByRole("button", { name: "Add to collection" }));
  }

  it("draws a card search beside the binder", async () => {
    wrap(<CollectionPage />);

    // Named for the list it files into, which is what keeps it apart from the wishlist's — see
    // the section label's own note.
    const panel = await screen.findByRole("region", { name: "Add cards to your collection" });
    // **Awaited, not read on the first frame.** `searchOpen` is mocked to `{ collection: true }` —
    // a reader who had left the column open — and that answer arrives a round trip after the
    // first paint, where `DEFAULT_SEARCH_OPEN.collection` (`false`) is what is drawn. Read
    // synchronously this passed on the default and never once observed the stored value, which is
    // exactly what it went red for when the default flipped on 2026-09-07.
    expect(
      await within(panel).findByRole("button", { name: "Collapse card search" }),
    ).toHaveAttribute("aria-expanded", "true");
    // And the wall is really the card search rather than a second drawing of the binder: this
    // printing is in no fixture `collection_list` answers with.
    expect(await within(panel).findByRole("button", { name: "Black Lotus" })).toBeInTheDocument();
  });

  /**
   * **What a database nobody has expressed a preference in draws** — the other half of the case
   * above, and the one the default actually decides.
   *
   * Railed since 2026-09-07, measured at seven window widths in the shipped window. This page
   * already draws a `FilterBar` of its own, so opening open puts two filter rows on screen before
   * the reader has asked for either; and below 544px the panel is an **overlay** rather than a
   * rail — these pages have no docked card pane to suppress it — so the default would cover the
   * binder outright on a small window. `useSearchOpen.ts` carries the whole reading. The rail is
   * still the affordance, and the press is remembered per section forever after.
   */
  it("opens railed on a database that has never been asked", async () => {
    searchOpen.mockResolvedValue({});

    wrap(<CollectionPage />);

    const panel = await screen.findByRole("region", { name: "Add cards to your collection" });
    expect(
      await within(panel).findByRole("button", { name: "Expand card search" }),
    ).toHaveAttribute("aria-expanded", "false");
    // **Nothing is mounted**, not merely hidden — which is what keeps `search_cards` off a page
    // nobody searched from. `CardSearchPanel`'s three gates: `open` mounts, `shown` hides.
    expect(within(panel).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(searchCards).not.toHaveBeenCalled();
  });

  /**
   * **The two filter rows are separately addressable, and only the search box says which is
   * which.** `FilterLabels` is the whole mechanism: one `idStem` shared would make the second
   * row's `<label htmlFor>` name the first row's field, and one `search` name shared would leave
   * a `getByLabelText` unable to tell the reader's binder from the corpus.
   */
  it("gives the two filter rows different names", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    const mine = screen.getByRole("searchbox", { name: "Search your collection" });
    const cards = screen.getByRole("searchbox", { name: "Search cards" });
    expect(mine).not.toBe(cards);
    // The panel's is the panel's, and the page's is not.
    expect(searchColumn()!.contains(cards)).toBe(true);
    expect(searchColumn()!.contains(mine)).toBe(false);
    // And the `id`s they bind through are two, which is what the stem buys. Read off the
    // elements rather than spelled, so a renamed stem is still one `id` per box.
    expect(mine.id).not.toBe(cards.id);
  });

  /**
   * The whole point of the column: a reader standing in a drawer files into that drawer.
   *
   * `folderId` is the eleventh term of the storage grain, so this is an add **into** a folder and
   * never an add followed by a move.
   */
  it("adds from the search into the folder on screen", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(3));
    // The drawer is in the button's name before the press, which is the only part of what
    // pressing it does that a screenshot cannot show.
    await waitFor(() =>
      expect(quickAdd()).toHaveAccessibleName("Add Black Lotus (LEA 232) to Trade binder"),
    );

    await addFromPanel(user);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: "lotus", folderId: 3 }),
      ),
    );
  });

  /**
   * **`null`, on the wire, and never an absent field.** Both land the copy at the root and
   * nothing on screen tells them apart — but absent means *this surface has never thought about
   * folders*, which is the search page and the Tags wall, and a page with a cabinet on screen has
   * chosen the root rather than said nothing.
   */
  it("adds at the root when no folder is open", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(quickAdd()).toHaveAccessibleName("Add Black Lotus (LEA 232) to Collection");
    await addFromPanel(user);

    await waitFor(() => expect(collectionAdd).toHaveBeenCalled());
    const sent = collectionAdd.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toHaveProperty("folderId", null);
  });

  /**
   * **A tile dropped on a folder's heading is an add, not a refile** — `collection_add` with the
   * folder, never `collection_set_folder`, because there is no row to move.
   *
   * The grade is `CONDITION_NOT_SET` and the finish is the printing's own first, which is the
   * answer to `useSidebarDrops.ts`' standing objection: nothing is invented. `quantity: 1`,
   * because a drop is one copy and the `+` beside it is where a reader says more.
   */
  it("files a dropped card into the folder it was dropped on", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await within(searchColumn()!).findByRole("button", { name: "Black Lotus" });

    await findHeading("Trade binder");
    const folder = standHeading("Trade binder");
    const tile = panelTile("Black Lotus");
    const held = await holdCopy(tile, {
      pressOn: within(searchColumn()!).getByRole("button", { name: "Black Lotus" }),
    });
    await held.over(folder);
    await held.drop();

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "lotus",
        finish: "nonfoil",
        condition: "NONE",
        quantity: 1,
        folderId: 3,
      }),
    );
    // And the *other* write did not happen: a card nobody owns has no `collection_entries` row
    // for `collection_set_folder` to address.
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });
});

/**
 * The Share control, as the page mounts it.
 *
 * `ShareFolderMenu.test.tsx` drives the menu, the publish form and the withdrawal; what is left
 * for this file is the one thing only the page can answer — **which level gets a control at
 * all** — plus the entry point that spec decision 6 left nowhere else to put.
 */
describe("sharing from the cabinet", () => {
  const shareControl = () => screen.queryByRole("button", { name: /^Share/ });

  /** The same drawer with no cross-device name — `collection_folders.sync_uid` is nullable in
   *  the DDL, and the fence below is what that state is for. */
  const UNNAMED: CollectionFolder = { ...BINDER, syncUid: null };

  /** The root is a target: `share_create`'s `null` `folderUid` is the whole collection, and a
   *  destination rather than an omission. */
  it("offers Share at the root of the cabinet", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    wrap(<CollectionPage />);
    await findHeading("Trade binder");

    expect(await screen.findByRole("button", { name: "Share your collection" })).toBeInTheDocument();
  });

  /**
   * **The app's own two kinds get no Share control at all**, as they get no other folder write —
   * the rule every app-owned shelf follows, and `share::snapshot::FOLDER_NOT_SHAREABLE` on the far
   * side.
   */
  it("offers no Share control inside a deck group or Recently removed", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    // **The presence first, in this same case.** An absence asserted over a page that never drew
    // the control passes for the wrong reason — the shape that has produced vacuous tests in
    // this repo more than once — so the root's own control is what proves the mount, the
    // membership read and the query all answered.
    await screen.findByRole("button", { name: "Share your collection" });

    await openShelf(user, "Mono-Red Aggro");
    await waitFor(() => expect(standingIn()).toBe(20));
    await waitFor(() => expect(shareControl()).toBeNull());
    // …and the way into somebody else's binder is still there, because viewing needs nothing.
    expect(screen.getByRole("button", { name: "Open a shared collection" })).toBeInTheDocument();

    // The other app-owned kind, from the same page rather than from a second case: they are one
    // rule (`kind <> 'user'`), reached from the root's wall.
    await user.click(within(crumbs()).getByRole("button", { name: "Collection" }));
    await waitFor(() => expect(standingIn()).toBeNull());
    await openShelf(user, "Recently removed");
    await waitFor(() => expect(standingIn()).toBe(21));
    await waitFor(() => expect(shareControl()).toBeNull());
  });

  /**
   * **A drawer the reader has opened is what the control is about**, and the breadcrumb above the
   * wall is what says which drawer that is. The level rather than a row of the wall, because the
   * root is a target too and the root has no card to hang a control on.
   */
  it("offers Share in a drawer the folder list names", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    await screen.findByRole("button", { name: "Share your collection" });
    await openShelf(user, "Trade binder");

    expect(await screen.findByRole("button", { name: "Share Trade binder" })).toBeInTheDocument();
  });

  /**
   * ⚠️ **The fence that keeps a missing uid from becoming the whole collection.**
   * `share_create`'s `null` `folderUid` means *the whole collection*, so a folder whose
   * `sync_uid` is absent quietly becoming `null` would publish every card the reader owns
   * instead of the one binder they picked, and succeed while doing it — the failure `ipc.ts`
   * warns about at `shareCreate` in as many words.
   *
   * So the control is **absent** in such a drawer rather than wrong, and this case is what would
   * go red the day somebody reaches for the tidier `?? null`. The column is nullable in the DDL,
   * so this is a state and not only a transitional one.
   */
  it("offers no Share control in a drawer with no sync uid", async () => {
    collectionFolderList.mockResolvedValue([UNNAMED]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    // At the root it is there, so the absence below is about the drawer rather than about the
    // membership or the read.
    await screen.findByRole("button", { name: "Share your collection" });
    await openShelf(user, "Trade binder");

    await waitFor(() => expect(shareControl()).toBeNull());
  });

  /** Hidden and not greyed, for a reader who has connected nothing (spec §9). The Settings sync
   *  panel is where the connection story lives, and a control that only ever produced a sentence
   *  saying so would teach nothing its absence does not. */
  it("hides the Share control when nothing is connected", async () => {
    // **The presence first**, so the absence below is about the membership rather than about a
    // page that never drew the control. `cleanup` between, because two mounts in one document
    // would put two of every button on screen.
    wrap(<CollectionPage />);
    await screen.findByRole("button", { name: "Share your collection" });
    cleanup();

    syncSupporterStatus.mockResolvedValue({
      entitled: false,
      status: "dead",
      since: null,
      groupBound: false,
    });
    wrap(<CollectionPage />);

    await screen.findByRole("button", { name: "Open a shared collection" });
    expect(shareControl()).toBeNull();
  });

  /**
   * **The entry point the plan had nowhere to put.** Decision 6 hides the *Shared* rail row until
   * a reader has opened a share, and this page's other half is for *publishing* — so without this
   * button the in-app viewer is reachable by `Ctrl+6` and discoverable by nothing. Beside the
   * Share control, because both halves are one idea read in two directions.
   */
  it("opens somebody else's share from the collection page", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);

    await user.click(await screen.findByRole("button", { name: "Open a shared collection" }));

    expect(await screen.findByLabelText("Link to a shared collection")).toBeInTheDocument();
  });
});

/**
 * **The flagged rows another page asked this one to open on** — `store.ts`'s
 * `pendingReviewFilter`, whose only writer is the home page's To review widget.
 *
 * `pendingFolder`'s block above, one filter over: read as the page renders, spent as it is read,
 * and remembered by nothing. Each case asserts the *query* and the *field*, because three of the
 * four ways this could be wrong draw a page that looks fine.
 */
describe("a needs-review filter another page asked for", () => {
  /**
   * **Every request, not the last one.** A render-phase adjustment puts the filter on before the
   * first commit, so no unfiltered list is ever asked for; a mount effect would fetch the whole
   * binder first and then the flagged rows, which a `lastQuery()` assertion cannot tell apart.
   */
  it("asks for the flagged rows from its first request, and spends the hand-off", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    wrap(<CollectionPage />);

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(
      collectionList.mock.calls.every(([q]) => (q as CollectionQuery).needsReview === true),
    ).toBe(true);
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /**
   * **The same promise over a folder census that has already answered** — the arrival a reader
   * actually makes, since the census outlives a visit in the app's one `QueryClient`. On shelves
   * the case above cannot see the seed at all: every read waits for a *cold* census, and by then
   * `settle`'s render-phase write has landed, so it stays green with `initialNeedsReview` deleted.
   * A warm census lets the list subscribe on the first pass, which is the pass the seed is for.
   */
  it("asks for the flagged rows first over a census that has already answered", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (ui: ReactElement) => (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ContextMenuProvider>{ui}</ContextMenuProvider>
        </TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(<CollectionPage />));
    await screen.findByText("Lightning Bolt");
    rerender(tree(<div />));
    collectionList.mockClear();

    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    rerender(tree(<CollectionPage />));

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(
      collectionList.mock.calls.every(([q]) => (q as CollectionQuery).needsReview === true),
    ).toBe(true);
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /** A hand-off that survived its read would open every later visit on the flagged rows. */
  it("does not survive to a second visit", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    const first = wrap(<CollectionPage />);
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());

    first.unmount();
    collectionList.mockClear();
    wrap(<CollectionPage />);

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().needsReview).toBeUndefined();
  });

  /** One field serves both lists, so the check is "is there one for me". */
  it("leaves the wishlist's hand-off untouched", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    wrap(<CollectionPage />);

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().needsReview).toBeUndefined();
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "wishlist" });
  });
});

/**
 * **A needs-review hand-off over a filed cabinet** — main's *cabinet the reader has not flattened*
 * block (the controller's ruling of 2026-09-26), ported to shelves.
 *
 * To review counts the flagged copies across **every** drawer. Before shelves an unflattened root
 * meant "filed nowhere", so the filter alone drew a flagged root — usually empty — under a widget
 * that had just said "5 binder entries", and the page read the cabinet flat for as long as the
 * hand-off's filter stood. On shelves the root's wall *is* every drawer, and a filter suspends
 * collapse, so the same promise is kept with no switch at all: each flagged copy on its own shelf,
 * a shut deck group's included. What the old block also guarded — that the hand-off writes nothing
 * the reader persisted (`collectionFlattened` then) — is the stored folds now, which the filter
 * overrides without writing. The two Flatten-press cases went with the chip; `draws no Flatten
 * switch` above is the fence on its absence.
 */
describe("a needs-review hand-off over a filed cabinet", () => {
  /** A flagged copy filed in `Trade binder` — a drawer of the reader's own. */
  const FLAGGED: CollectionRow = {
    ...BOLT,
    id: 11,
    cardId: "c-pearl",
    oracleId: "o-pearl",
    name: "Mox Pearl",
    collectorNumber: "263",
    folderId: BINDER.id,
    folderName: BINDER.name,
    needsReview: REVIEW_NOTE,
  };
  /** A flagged copy in a **deck group** — a shelf that starts shut, so its cards are fetched only
   *  while something suspends the collapse. */
  const FLAGGED_IN_DECK: CollectionRow = {
    ...BOLT,
    id: 12,
    cardId: "c-sapphire",
    oracleId: "o-sapphire",
    name: "Mox Sapphire",
    collectorNumber: "265",
    folderId: DECK_GROUP.id,
    folderName: DECK_GROUP.name,
    needsReview: REVIEW_NOTE,
  };

  /**
   * The backend's answer, by shelf: the rows on the shelves the query names, honouring the filter —
   * so the healthy Bolt on Not sorted drops out under it, and a shelf left off the list is empty.
   */
  const listByShelf = async (q: CollectionQuery) =>
    page(
      [BOLT, FLAGGED, FLAGGED_IN_DECK].filter(
        (row) =>
          (q.shelves === undefined || q.shelves.includes(row.folderId ?? UNFILED_SHELF)) &&
          (q.needsReview !== true || row.needsReview !== null),
      ),
    );

  beforeEach(() => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP]);
    collectionList.mockImplementation(listByShelf);
  });

  /**
   * **Every request asks for every drawer**, the shut one included, so there is no flagged root
   * fetched and thrown away — and the folds the reader stored are exactly where they left them.
   */
  it("draws each flagged copy on its own shelf, a shut deck group's included, and writes no fold", async () => {
    wrap(<CollectionPage />);

    await waitFor(() => {
      expect(screen.getByText("Mox Pearl")).toBeInTheDocument();
      expect(screen.getByText("Mox Sapphire")).toBeInTheDocument();
    });
    expect(screen.queryByText("Lightning Bolt")).toBeNull();
    expect(
      collectionList.mock.calls.every(([q]) => {
        const asked = q as CollectionQuery;
        return (
          asked.needsReview === true &&
          asked.rootOnly === undefined &&
          asked.folderId === undefined &&
          asked.shelves?.includes(BINDER.id) === true &&
          asked.shelves.includes(DECK_GROUP.id)
        );
      }),
    ).toBe(true);
    expect(standingIn()).toBeNull();
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /**
   * **A hand-off landing on a page that is already mounted** — `useReviewHandoff`'s `settle`, the
   * render-phase path, which every other case here skips by writing the hand-off before the mount.
   * It is the path the widget's two store writes take when they land in two commits.
   */
  it("answers a hand-off that lands after the page has mounted", async () => {
    useAppStore.setState({ pendingReviewFilter: null });
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    expect(lastQuery().needsReview).toBeUndefined();
    // The deck group is shut, so its copy is not on the wall before the hand-off.
    expect(screen.queryByText("Mox Sapphire")).toBeNull();

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "collection" } }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    expect(lastQuery().rootOnly).toBeUndefined();
    // **One wait over the whole wall, never a `findByText("Mox Pearl")`**: Pearl was on screen
    // before the hand-off too — its shelf is open at the root — so a find resolves on the
    // pre-filter node, which the filtered wall then replaces. What proves the filter landed is
    // the healthy Bolt leaving and the shut deck group's copy arriving, in the same frame.
    await waitFor(() => {
      expect(screen.queryByText("Lightning Bolt")).toBeNull();
      expect(screen.getByText("Mox Pearl")).toBeInTheDocument();
      expect(screen.getByText("Mox Sapphire")).toBeInTheDocument();
    });
    expect(
      onPage(screen.getAllByRole("button", { name: "Remove filter — Needs review" })),
    ).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /**
   * **A hand-off that lands on a page standing in a folder opens the root** — the one thing left of
   * the old sweep. A folder's wall holds only its own subtree, so the filter alone would draw that
   * drawer's flagged copies under a widget that counted every drawer's.
   */
  it("opens the root when the hand-off lands on a page standing in a folder", async () => {
    useAppStore.setState({ pendingReviewFilter: null });
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await openShelf(user, "Trade binder");
    await waitFor(() => expect(standingIn()).toBe(BINDER.id));

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "collection" } }));

    await waitFor(() => expect(standingIn()).toBeNull());
    expect(lastQuery().needsReview).toBe(true);
    // Sapphire is filed in a deck group, which no wall inside `Trade binder` can hold — so its
    // arrival is the root's, and Pearl beside it is the same wall rather than the folder's.
    await waitFor(() => {
      expect(screen.getByText("Mox Sapphire")).toBeInTheDocument();
      expect(screen.getByText("Mox Pearl")).toBeInTheDocument();
    });
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /** The filter is what opened the shut shelves: take it away, by its chip or by Reset all, and the
   *  page is the root it was before the hand-off — every card back, the deck group shut again. */
  it.each([
    ["its chip", "Remove filter — Needs review"],
    ["Reset all", /^Reset all/],
  ] as const)("keeps the root, and its folds, when the filter is cleared by %s", async (_how, name) => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Mox Sapphire");

    await user.click(onPage(screen.getAllByRole("button", { name })));

    await waitFor(() => expect(lastQuery().needsReview).toBeUndefined());
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    // Filed in the reader's own drawer, which the root's wall shows with or without a filter.
    expect(screen.getByText("Mox Pearl")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Mox Sapphire")).toBeNull());
    expect(standingIn()).toBeNull();
    expect(setShelfFolds).not.toHaveBeenCalled();
  });
});
