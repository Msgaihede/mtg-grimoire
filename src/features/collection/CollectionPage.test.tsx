import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import type {
  CollectionFolder,
  CollectionQuery,
  CollectionRow,
  CollectionSummary,
  DeckRow,
  ImportMatch,
} from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { startDrag } from "@/test-drag";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
const collectionSetQuantity = vi.hoisted(() => vi.fn());
const collectionRemove = vi.hoisted(() => vi.fn());
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
const collectionFolderDelete = vi.hoisted(() => vi.fn());
const collectionSetFolder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionSummary,
    collectionSetQuantity,
    collectionRemove,
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
    collectionFolderDelete,
    collectionSetFolder,
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
  // cards return to. The table's Folder column draws an em dash for it.
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
  notes: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
};

/** Two drawers, one inside the other — flat rows, because the tree is the page's to build from
 *  `parentId`. `kind: "user"` is a folder the reader made and named, which is the only kind this
 *  PR can produce and the only kind the nestable wall draws. */
const BINDER: CollectionFolder = {
  id: 3,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
};
const FOILS: CollectionFolder = {
  id: 9,
  parentId: 3,
  name: "Foils",
  kind: "user",
  deckId: null,
  sortOrder: 0,
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
};
const REMOVED: CollectionFolder = {
  id: 21,
  parentId: null,
  name: "Recently removed",
  kind: "removed",
  deckId: null,
  sortOrder: 0,
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
 * only the control this file means.
 */
// **`Sort results` and not the bare `Sort` this page drew before it shared `FilterBar`.**
// That row is mounted on four surfaces and one of them — the deck editor — already has a
// `Sort` of its own, so the shared control names what it orders. `FilterBar`'s own label
// carries the argument.
const sortSelect = () => screen.getByRole("combobox", { name: "Sort results" });
/**
 * Open the filter tray, so a cell behind the Filters disclosure can be pressed.
 *
 * Everything but the box, the colours, the order and the layout pair lives behind that button
 * since this page started drawing `FilterBar` — so a suite that reached straight for a chip is
 * now reaching into a tray that is not mounted. Matched on a prefix: the button's name carries
 * the live count (`Show filters — 2 active`), which moves as a case presses things.
 */
async function openTray(user: {
  // Structural, so the bare `userEvent` module and a `userEvent.setup()` instance both satisfy it
  // — this file uses each in different cases, and the two are not the same type.
  click: (element: Element) => Promise<unknown>;
}): Promise<void> {
  await user.click(screen.getByRole("button", { name: /^Show filters/ }));
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
 * jsdom lays nothing out, so the virtualiser measures a scroller of zero height and renders
 * no rows at all. `@tanstack/react-virtual` sizes it with `offsetHeight` and scrolls it with
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  // One deck, no folders — the shape the menu's deck picker draws as a single row. Answered
  // rather than seeded into the cache: `useDecks` has no `staleTime`, so a seeded entry is
  // refetched on mount and the command is what the picker ends up drawing either way.
  deckList.mockReset().mockResolvedValue([BURN]);
  deckFolderList.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue({ deck: BURN, cards: [], categories: [], tags: [] });
  deckAddCard.mockReset().mockResolvedValue(undefined);
  // No taxonomy downloaded is the floor rather than an error: `autoCategoryFor` then files by
  // type line, which is exactly what the case below is about.
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  collectionList.mockReset().mockResolvedValue(page([BOLT]));
  collectionSummary.mockReset().mockResolvedValue(summary({ totalCards: 2, uniqueCards: 1 }));
  collectionSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 3, removed: false });
  collectionRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
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
  // folders assumes: no breadcrumb, no folder cards, and the whole binder on screen. The folder
  // tests below say otherwise for themselves.
  collectionFolderList.mockReset().mockResolvedValue([]);
  collectionFolderSummary.mockReset().mockResolvedValue([]);
  collectionFolderCreate.mockReset().mockResolvedValue(BINDER);
  collectionFolderRename.mockReset().mockResolvedValue(BINDER);
  collectionFolderMove.mockReset().mockResolvedValue(BINDER);
  collectionFolderDelete.mockReset().mockResolvedValue(undefined);
  collectionSetFolder.mockReset().mockResolvedValue({ id: 7, quantity: 2, removed: false });
  useAppStore.setState({
    collectionView: "table",
    selectedCardId: null,
    importDefaults: { condition: "NM", finish: null },
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
   * why the collection is never a drop *target*). This asks the drag rather than the
   * `draggable="true"` attribute, because a registration that closed over the wrong row would
   * still set it.
   */
  it("carries the row's printing when the row is dragged", async () => {
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    const rows = [...container.querySelectorAll('[draggable="true"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Lightning Bolt");

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const held = await startDrag(rows[0], { pressOn: screen.getByText("Lightning Bolt") });
    await held.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
  });

  /**
   * **A press on the stepper is a press on the stepper.**
   *
   * The whole row is the drag handle and the row is full of controls, so this is the failure
   * that costs a reader their counts: Chromium starts a drag from the nearest draggable
   * *ancestor* of whatever was pressed, and the drag library excludes nothing of its own — so
   * without the mark, a press on `−` that travels five pixels drags the row and the press is
   * never delivered as a click. `cardDraggable` reads where the *press* landed, which is why
   * this presses one place and drags from another, exactly as the platform does.
   */
  it("does not drag a row when the press landed on its stepper", async () => {
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const row = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(row, {
      pressOn: screen.getByRole("button", {
        name: "Decrease Quantity of Lightning Bolt (Foil, NM)",
      }),
    });
    expect(held.started).toBe(false);
    await held.cancel();

    // And the row itself still is one: the guard is a control's press, not a row's.
    const again = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
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
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Etched" }));
    await userEvent.click(screen.getByRole("button", { name: /^LP/ }));
    await userEvent.selectOptions(sortSelect(), "price");

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

    // **It opens on the order it is actually in, and `Custom…` is not there to open on.** A
    // controlled `<select>` whose value matches no option silently reports the **first** one —
    // alphabetically `Highest price` here — so this is the assertion that tells "the sort is name
    // order" from "the control fell back to row zero", and the two look identical on screen.
    expect(sortSelect()).toHaveValue("name");
    expect(screen.queryByRole("option", { name: "Custom…" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copies" }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    // A header the select also offers reads back on it.
    expect(sortSelect()).toHaveValue("quantity");

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
    expect(sortSelect()).toHaveValue("quantity");

    // Now start from Value alone, which the select has no option for at all.
    await user.click(screen.getByRole("button", { name: /^Value/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "value", dir: "desc" }]));
    expect(sortSelect()).toHaveValue("");
    expect(screen.getByRole("option", { name: "Custom…" })).toBeDisabled();
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
    // **Filed, so the Value cell's dash is the only one on the row.** The Folder column draws an
    // em dash for a copy at the root, which is exactly what `BOLT` is — and two of them would
    // make `getByText("—")` ambiguous, which reads as a missing dash rather than as a second one.
    // A filed row keeps this test about the price it is not being quoted.
    collectionList.mockResolvedValue(
      page([
        { ...BOLT, quantity: 3, unitPrice: null, folderId: 4, folderName: "Trade binder" },
      ]),
    );
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

  /** The wall is a wall of *cards*: two entries for one printing (a foil and a nonfoil) are
   *  one tile carrying what the reader owns of it. */
  it("shows the collection as art, badged with how many are owned", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const { container } = wrap(<CollectionPage />);

    const art = await screen.findAllByAltText("Lightning Bolt");
    expect(art).toHaveLength(1);
    expect(screen.getByText("3 in your collection")).toBeInTheDocument();
    // One backing, not two. The wall owns the corner and the table felt behind a mark, and
    // the mark it is handed is plain — a pill inside a pill painted the felt over itself and
    // doubled the horizontal padding on a 170px tile.
    expect(container.querySelectorAll('[class*="bg-bg/85"]')).toHaveLength(1);
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
    expect(container.querySelector('[class*="bg-bg/85"]')).toBeEmptyDOMElement();
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
    expect(within(dialog).getByLabelText("Condition when the file doesn't say")).toHaveValue("NM");

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
            condition: "NM",
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
        condition: "NM",
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
        condition: "NM",
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
   * The other arm, and the one that says the tile is a *card*: two entries for one printing are
   * one piece of art, so the wall has two finishes behind it and has to ask which one the reader
   * means. The same component asks the same question on the search wall for the same reason —
   * one wall behaving two ways would be the bug.
   *
   * Offered in `FINISHES` order rather than in the order the entries arrived, which is why the
   * fixtures below are deliberately foil-first.
   */
  it("asks which, when the reader owns the printing in two finishes", async () => {
    useAppStore.setState({ collectionView: "grid" });
    collectionList.mockResolvedValue(
      page([BOLT, { ...BOLT, id: 8, finish: "nonfoil", condition: "LP", quantity: 1 }]),
    );
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    expect(collection).toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);
    const offered = (await screen.findAllByRole("menuitem")).filter((item) =>
      ["Nonfoil", "Foil", "Etched"].includes(item.textContent ?? ""),
    );
    expect(offered.map((item) => item.textContent)).toEqual(["Nonfoil", "Foil"]);

    await user.click(screen.getByRole("menuitem", { name: "Nonfoil" }));
    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "nonfoil",
        condition: "NM",
        quantity: 1,
        // The root of the cabinet, as above: the finish was the question, the folder was not.
        folderId: null,
      }),
    );
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
 * The cabinet the page draws above whichever view is on — the breadcrumb, the folder cards, and
 * the two ways a copy is filed.
 *
 * **Drawn once for both layouts rather than inside each**, so the wall and the table navigate
 * identically; the alternative is two drill-downs that agree today. The filing itself is the
 * backend's: `collection_list` takes the folder, so the rows below are already the rows of the
 * level on screen and nothing here filters.
 */
describe("the collection's folders", () => {
  /** A collection nobody has filed draws no cabinet at all: a lone inert "Collection" under a
   *  ribbon that already says Collection is a subheading repeating its own heading. */
  it("draws nothing at all when there are no folders", async () => {
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(
      screen.queryByRole("navigation", { name: "Collection folders" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Folders" })).not.toBeInTheDocument();
  });

  /**
   * **The root of this cabinet is every folder, which is where the collection parts company with
   * the wishlist.** `CollectionQuery.folderId` absent means "every folder" rather than "the copies
   * filed nowhere", so opening the page still asks the question it always asked — and a reader who
   * has made drawers still sees their whole binder until they open one.
   */
  it("asks for every folder at the root, and for one folder once opened", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionFolderSummary.mockResolvedValue([{ folderId: 3, cards: 12, value: 340.25 }]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    expect(lastQuery().folderId).toBeUndefined();

    await userEvent.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));

    await waitFor(() => expect(lastQuery().folderId).toBe(3));
  });

  /** The recursive total, never the summary's own row: that one is direct per folder, and a drawer
   *  holding a full sub-folder and nothing of its own would otherwise read as empty. */
  it("adds a sub-folder's copies into the card above it", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    // Nothing filed directly in `Trade binder`; everything is one level down. A raw lookup would
    // draw `0 cards` over a drawer holding four.
    collectionFolderSummary.mockResolvedValue([{ folderId: 9, cards: 4, value: 88 }]);
    wrap(<CollectionPage />);

    expect(
      await screen.findByRole("button", { name: "Trade binder folder, 4 cards, $88.00" }),
    ).toBeInTheDocument();
  });

  /** The breadcrumb is the way back out, and the level the reader is in is not a place to go. */
  it("climbs back out through the breadcrumb", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    wrap(<CollectionPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));

    expect(screen.getByText("Trade binder")).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("button", { name: "Collection" }));

    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
  });

  /**
   * `+ New folder` makes one **inside the folder the reader is standing in**, which at the root is
   * the top level — and the field says so in words for a reader who cannot see which level the
   * strip is drawn over.
   */
  it("makes a folder inside the level the reader is standing in", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "+ New folder" }));
    expect(screen.getByText("in Collection")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Trade binder");
    await user.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Trade binder"));
  });

  /**
   * **Filing a copy is a re-read, never an optimistic patch.**
   *
   * The wishlist shipped the optimistic version and it was wrong three ways at once: the row left
   * every cached list page and **nothing ever put it back**, so a filed wish was gone from the app
   * until a reload; the destination folder said "Nothing filed here yet" under a card already
   * counting it; and the header under-counted on the way out to the root as well as on the way in.
   *
   * So the assertion is the *invalidation*, and it is the whole `["collection"]` root rather than
   * the summary and the folder keys: `invalidateQueries` matches by prefix, so that reaches
   * `["collection", "list", …]` itself. Marking it stale would not be enough on its own —
   * `lib/query.ts` sets `staleTime: 30_000`, so a mounted observer that is merely stale never
   * refetches, which is exactly why the wishlist's bug survived every reload-free session.
   */
  it("re-reads the whole collection after a folder move rather than guessing", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const { client, container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const card = (await screen.findByRole("button", { name: /^Trade binder folder/ })).closest(
      "li",
    )!;
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const row = container.querySelector('[draggable="true"]')!;
    const held = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    await held.over(card);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
    // And every deck, which is the half this page's own copy of the mutation was missing before
    // the two were collapsed onto `useSetCollectionFolder`: since schema v25 a deck owns the
    // copies filed in its own group, and a copy dragged *out* of one is a copy that deck has
    // just lost — and a move onto a taken grain **merges**, deleting one row and adding its
    // copies to the survivor, which moves the destination folder's sum too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    // And the row is still on screen: nothing took it off the level on a guess about where it
    // went. The backend is what says which list it belongs to now.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * **The folder a copy is already filed in refuses it before the drop.** A ring there would lead
   * to a write that moves nothing and bumps `updated_at` — `dropWrite`'s rule about a card dropped
   * back into its own column, which is why `CollectionDrag` carries `folderId` at all.
   */
  it("refuses a drop onto the folder the copy is already in", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    collectionList.mockResolvedValue(page([{ ...BOLT, folderId: 3, folderName: "Trade binder" }]));
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const card = (await screen.findByRole("button", { name: /^Trade binder folder/ })).closest(
      "li",
    )!;

    const row = container.querySelector('[draggable="true"]')!;
    const held = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(card.classList.contains("ring-2")).toBe(false);

    await held.over(card);
    await held.drop();
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });

  /**
   * **Deck groups and `Recently removed` are the app's, not the reader's**, so they never join the
   * nestable tree — they are a pinned flat section beside it.
   *
   * This test was written one PR early, when nothing created either kind and the section was
   * deliberately empty; schema v25 creates them now, so it asserts the arrangement rather than the
   * absence. The half that has not changed is the one that mattered then and matters now: the
   * `Folders` wall holds the reader's drawer and **only** the reader's drawer. A pinned folder
   * leaking into it would be a folder the reader could drag a card into, drag between other
   * folders, rename and delete — four writes the backend refuses in words.
   */
  it("pins the app's own folders beside the reader's tree, never inside it", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);

    await screen.findByRole("button", { name: /^Trade binder folder/ });
    expect(await screen.findByRole("button", { name: /^Mono-Red Aggro deck/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Recently removed folder/ })).toBeInTheDocument();
    // One card in the reader's own wall, and it is the drawer they made.
    expect(
      within(screen.getByRole("list", { name: "Folders" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    // And each pinned kind is in its own list, so a reader scanning under "Decks" for their decks
    // does not find the holding area among them.
    expect(
      within(screen.getByRole("list", { name: "Deck folders" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: "Removed cards" })).getAllByRole("listitem"),
    ).toHaveLength(1);
  });

  /**
   * **Locked means no affordance, not a refusal after the press.** Every folder write in
   * `collection_folders` calls `user_folder` first and answers `FOLDER_NOT_YOURS` for either
   * pinned kind, so a `⋯` here would open a menu of three rows that each end in the same sentence.
   * The reader's own drawer keeps its trigger, which is what makes this a statement about the
   * pinned entries rather than about the page.
   */
  it("gives a pinned folder no rename, move or delete affordance", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await screen.findByRole("button", { name: /^Mono-Red Aggro deck/ });

    expect(screen.getByRole("button", { name: "Manage Trade binder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Mono-Red Aggro" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage Recently removed" }),
    ).not.toBeInTheDocument();
  });

  /**
   * **A deck group takes no drop, and the reason is that the drag has no way to write the other
   * half of the move.** A copy reaches a deck's group through `collection_to_deck`, which files
   * the row *and* writes the `deck_cards` row in one transaction. A drag would call
   * `collection_set_folder`, which knows nothing about decks — so the copy would land in the group
   * with no deck card behind it, and the collection would claim a deck holds a card that deck has
   * never heard of.
   *
   * The ring is asserted as well as the write: `useCollectionDropTarget` raises every eligible
   * target's ring the moment a row leaves the table, so a ring on a target that then refuses the
   * drop is a promise this page cannot keep.
   */
  it("refuses a drop onto a deck group", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const group = (await screen.findByRole("button", { name: /^Mono-Red Aggro deck/ })).closest(
      "li",
    )!;

    const row = container.querySelector('[draggable="true"]')!;
    const held = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(group.classList.contains("ring-2")).toBe(false);

    await held.over(group);
    await held.drop();
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });

  /**
   * **The other half of the deck boundary, and the half with no backend fence behind it.**
   * `collection_set_folder` would accept this move — the destination is a folder the reader made,
   * which is the only thing it checks — and the copy would leave the deck's custody without
   * anything touching `deck_cards`, leaving the deck listing a card whose copies have walked off.
   * Copies leave a deck through `deck_to_collection`, which decrements the list in the same
   * transaction.
   *
   * So this refusal is the page's own, and it is the reason `canFile` reads the drag's **source**
   * as well as its destination.
   */
  it("refuses to drag a copy out of a deck group", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    collectionList.mockResolvedValue(
      page([{ ...BOLT, folderId: 20, folderName: "Mono-Red Aggro" }]),
    );
    const { container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    const binder = (await screen.findByRole("button", { name: /^Trade binder folder/ })).closest(
      "li",
    )!;

    const row = container.querySelector('[draggable="true"]')!;
    const held = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(binder.classList.contains("ring-2")).toBe(false);

    await held.over(binder);
    await held.drop();
    expect(collectionSetFolder).not.toHaveBeenCalled();
  });

  /**
   * **Issue #209's whole story, in one gesture.** Copies that leave a deck land in
   * `Recently removed` rather than vanishing, and the reader sorts them back into their collection
   * from there. The source side of a move is not fenced — only the destination is — so a row
   * standing in the holding area files into any drawer the reader made.
   *
   * **The wall inside that folder is the reader's own top level**, which is the one place this page
   * substitutes one list for another: nothing nests under the holding area, so its own children are
   * always empty and a reader standing in the pile would have had no drop target on screen at all.
   *
   * The invalidation is asserted rather than the row leaving the screen, for the reason the folder
   * move above states in full: the answer to "which list does this row belong to now" is the
   * backend's, and `lib/query.ts` caches 30s, so marking the list stale without refetching it is
   * how the wishlist shipped a row that was gone until reload.
   */
  it("files a copy back out of Recently removed and re-reads the list", async () => {
    collectionFolderList.mockResolvedValue([BINDER, DECK_GROUP, REMOVED]);
    collectionList.mockResolvedValue(
      page([{ ...BOLT, folderId: 21, folderName: "Recently removed" }]),
    );
    const { client, container } = wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(await screen.findByRole("button", { name: /^Recently removed folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(21));

    // The sentence that says what the wall of binders under it is for.
    expect(
      screen.getByText(/drag a card onto a folder to file it back into your collection/i),
    ).toBeInTheDocument();
    const binder = (await screen.findByRole("button", { name: /^Trade binder folder/ })).closest(
      "li",
    )!;
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const row = container.querySelector('[draggable="true"]')!;
    const held = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    await held.over(binder);
    await held.drop();

    await waitFor(() => expect(collectionSetFolder).toHaveBeenCalledWith(7, 3));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["collection"] }));
  });

  /**
   * **A pinned folder is a place a reader can be standing, and the breadcrumb is the only way back
   * out of one.** The trail used to be drawn only where the reader had folders of their own, which
   * was right while every folder was theirs — a reader with none can now open a deck group, and
   * the gate would have closed the door behind them.
   */
  it("walks a reader back out of a deck group they have no folders of their own", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(await screen.findByRole("button", { name: /^Mono-Red Aggro deck/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(20));

    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
  });

  /**
   * **A stepper press moves the folder card above the row, and the page has to say so.**
   *
   * `collection_folder_summary`'s `cards` is `sum(quantity)` and its `value` is
   * `sum(quantity * unit_price)`, so a copy added to a filed row changes both — arithmetic this
   * page cannot redo, over a query whose observer is mounted for the life of the view. The
   * wishlist shipped without this and a folder card went on saying `2 wishes · $20.00` over a
   * drawer holding one; marking it stale is not enough, because `lib/query.ts` caches 30s and a
   * mounted observer that is merely stale never refetches.
   */
  it("re-reads the folder subtotals after a stepper press on a filed row", async () => {
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
    // And *not* the whole root: the list is deliberately left alone here, because the row's own
    // number has already been rewritten from the answer.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });
  });

  /**
   * The export dialog has to name the drawer, because the sweep already reads it: `folderId` is on
   * `collection.filters` and therefore in the sweep's key, so standing in `Trade binder` and
   * pressing Export exports that drawer — and a sentence saying only "matching your filters" would
   * be describing something else.
   */
  it("says which drawer an export is standing in", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await user.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));

    await user.click(screen.getAllByRole("button", { name: "Export collection" })[0]);

    const dialog = await screen.findByRole("dialog", { name: /export/i });
    expect(within(dialog).getByText(/in Trade binder/)).toBeInTheDocument();
    expect(within(dialog).getByText(/ignoring the filters and folders/)).toBeInTheDocument();
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

  /** One level, not all the way out: the parent is the trail's second-to-last segment, which is
   *  the breadcrumb's own last pressable one. */
  it("goes up one level, and the breadcrumb says so", async () => {
    collectionFolderList.mockResolvedValue([BINDER, FOILS]);
    wrap(<CollectionPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    await userEvent.click(await screen.findByRole("button", { name: /^Foils folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(9));

    expect(escape()).toBe(false);

    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    expect(screen.getByText("Trade binder")).toHaveAttribute("aria-current", "page");
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

    expect(lastQuery().folderId).toBeUndefined();
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
    await userEvent.click(await screen.findByRole("button", { name: /^Mono-Red Aggro deck/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(20));

    expect(escape()).toBe(false);

    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
  });

  /** The holding area is the other pinned kind, and the reader leaves it the same way. */
  it("walks back out of Recently removed", async () => {
    collectionFolderList.mockResolvedValue([DECK_GROUP, REMOVED]);
    wrap(<CollectionPage />);
    await screen.findByText("Lightning Bolt");
    await userEvent.click(await screen.findByRole("button", { name: /^Recently removed folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(21));

    expect(escape()).toBe(false);

    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
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
    await user.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    await user.type(filterBox(), "bolt");

    await user.keyboard("{Escape}");

    expect(filterBox()).toHaveValue("");
    expect(lastQuery().folderId).toBe(3);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
  });

  /** An empty box has nothing to undo, so the press is not its — the reader who cleared the filter
   *  with the ✕ and pressed again goes up a level, from the same caret. */
  it("lets an empty filter box hand the press on", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await user.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    await user.click(filterBox());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
  });

  /**
   * **The folder strip is the nearer thing and takes the press first.** It is an `"inner"` rung
   * and therefore capture-phase, so it is ahead of the floor whatever order the two mounted in —
   * and a reader half-way through naming a folder must not be walked out of the drawer they are
   * naming it in.
   */
  it("closes the new-folder field without leaving the folder", async () => {
    collectionFolderList.mockResolvedValue([BINDER]);
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    await user.click(await screen.findByRole("button", { name: /^Trade binder folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    await user.click(screen.getByRole("button", { name: "+ New folder" }));
    expect(screen.getByRole("textbox", { name: "New folder name" })).toBeInTheDocument();

    expect(escape()).toBe(false);

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "New folder name" })).not.toBeInTheDocument(),
    );
    expect(lastQuery().folderId).toBe(3);
  });
});
