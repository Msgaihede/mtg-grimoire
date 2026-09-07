import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import { readSearchCardDrag } from "@/features/search/searchCardDrag";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import { buildFolderTree, type FolderNode } from "@/lib/folderTree";
import type { CardSummary } from "@/lib/ipc";
import { recordDrags, startPointerDrag } from "@/test-drag";

const searchCards = vi.hoisted(() => vi.fn());
const collectionAdd = vi.hoisted(() => vi.fn());
const searchOpen = vi.hoisted(() => vi.fn());
const setSearchOpen = vi.hoisted(() => vi.fn());
/**
 * Everything the column reaches for on the way up.
 *
 * An `ipc` mock is an object literal, so a command it does not carry is `undefined` and calling it
 * is a synchronous `TypeError` fired from inside a hook — which no `.catch` in a `queryFn` can
 * reach. `facetCards` is answered **cold** (`ready: false`, every map empty) so nothing greys and
 * every filter keeps its name; `cardDetail` is the `+` popup's price hint, whose own behaviour is
 * `AddToCollection.test.tsx`'s subject rather than this file's.
 */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    collectionAdd,
    searchOpen,
    setSearchOpen,
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
    listSets: vi.fn().mockResolvedValue([]),
    cardDetail: vi.fn().mockResolvedValue(null),
    wishlistAdd: vi.fn(),
    getMarketplace: vi.fn().mockResolvedValue("tcgplayer"),
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
  },
}));

import { CollectionSearchPanel } from "./CollectionSearchPanel";

/**
 * One printing off the corpus, in one finish.
 *
 * **Nonfoil only, and that is what the drag is measured against**: `readSearchCardDrag` *refuses*
 * a finish this build does not know rather than normalising it, so the panel builds the mark from
 * `parseFinishes(card.finishes)[0]` and a printing whose list this fixture got wrong would produce
 * a record every folder target reads as `null`.
 */
const LOTUS: CardSummary = {
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
  finishes: `["nonfoil"]`,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 12000,
  priceHigh: 12000,
  gameChanger: false,
};

/** A printing whose finish list is empty, which the column allows and means *unknown*. The mark
 *  falls back to `nonfoil` rather than being refused — the one place a default is honest, because
 *  every card exists in the plain finish and none of the premium ones is implied. */
const NO_FINISHES: CardSummary = { ...LOTUS, id: "mystery", name: "Restart Sequence", finishes: null };

const page = (items: CardSummary[]) => ({ items, total: items.length, totalIsCapped: false });

/** Two drawers, through `buildFolderTree` rather than as literals, for `AddToCollection.test.tsx`'s
 *  reason: `depth`/`count`/`children` are that function's arithmetic and a hand-written node is a
 *  fixture free to disagree with the shape every real caller passes. */
const NODES: readonly FolderNode[] = buildFolderTree(
  [
    { id: 7, parentId: null, name: "Rares", sortOrder: 1 },
    { id: 8, parentId: null, name: "Commons", sortOrder: 2 },
  ],
  [],
);

const folderName = (id: number | null) =>
  id === null ? "Collection" : (NODES.find((n) => n.folder.id === id)?.folder.name ?? null);

/**
 * The panel under the providers the page mounts above it.
 *
 * `TooltipProvider` is not scenery: `useTooltip` is a no-op with no provider above it, so the
 * hints the `+` and the disclosure bind would be bound to nothing.
 */
function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}

/** The column, with the page's three folder facts. `folderId` is required and `null` is the root,
 *  so a call site that means the root says so. */
const panel = (folderId: number | null = null) =>
  wrap(
    <CollectionSearchPanel folderId={folderId} folderNodes={NODES} folderName={folderName} />,
  );

const column = () => screen.getByRole("region", { name: "Add cards to your collection" });

/**
 * jsdom lays nothing out, so `CardGrid`'s virtualiser measures a scroller of zero height and draws
 * **no tiles at all** — and it scrolls through `Element.scrollTo`, which jsdom does not implement
 * either. The same three lines every wall's suite installs, for the same reason.
 *
 * What it does not buy is the column count: the wall measures its own rows box with `clientWidth`
 * and a `ResizeObserver` that `src/test-setup.ts` stubs to a no-op, so every tile is one column
 * wide here. Name a tile, never count them.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  searchCards.mockReset().mockResolvedValue(page([LOTUS]));
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  searchOpen.mockReset().mockResolvedValue({ collection: true });
  setSearchOpen.mockReset().mockResolvedValue(undefined);
});

describe("CollectionSearchPanel", () => {
  it("names itself for the list it files into", async () => {
    panel();

    // Distinct from the deck panel's bare `Add cards` and from the wishlist's own sentence: this
    // column shares a route with the list it adds to, and two panels answering to one name is one
    // of them being found by accident.
    expect(column()).toBeInTheDocument();
    // And the search is really mounted — the disclosure's default is open, so the wall is there
    // without a press.
    expect(await within(column()).findByRole("button", { name: "Black Lotus" })).toBeInTheDocument();
  });

  /**
   * **The `+` states its destination before the press**, which is `DeckSearchPanel`'s rule
   * (`Add Ancient Tomb to Land`) applied: forty of these on a wall are forty different cards, and
   * on a page with a cabinet open the *drawer* is half of what pressing one would do.
   */
  it("names the folder it would file into", async () => {
    panel(7);

    expect(
      await screen.findByRole("button", { name: "Add Black Lotus (LEA 232) to Rares" }),
    ).toBeInTheDocument();
  });

  /** The root is the *list's* own word, never "no folder" — which would describe the same drawer
   *  the breadcrumb calls Collection. */
  it("names the collection at the root", async () => {
    panel(null);

    expect(
      await screen.findByRole("button", { name: "Add Black Lotus (LEA 232) to Collection" }),
    ).toBeInTheDocument();
  });

  /**
   * **A sidebar over the collection adds to the collection.**
   *
   * `lockMode` is what removes the switch, and the removal is structural rather than cosmetic: a
   * chip pair offering the wishlist here would change which page the results the reader is looking
   * at belong to, and it would offer the collection's folder tree for a wishlist add.
   */
  it("locks the popup to the collection", async () => {
    const user = userEvent.setup();
    panel(null);

    await user.click(await screen.findByRole("button", { name: /^Add Black Lotus/ }));

    expect(await screen.findByRole("button", { name: "Add to collection" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Wishlist" })).not.toBeInTheDocument();
  });

  /** And the press puts the folder on the wire, as the eleventh term of the row's storage grain
   *  rather than as a move made afterwards. */
  it("files a press into the folder it was given", async () => {
    const user = userEvent.setup();
    panel(7);

    await user.click(await screen.findByRole("button", { name: /^Add Black Lotus/ }));
    await user.click(await screen.findByRole("button", { name: "Add to collection" }));

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: "lotus", folderId: 7 }),
      ),
    );
  });

  /**
   * **The tile's record carries both marks, and each reader answers only its own.**
   *
   * `dragData`'s half is what keeps the tile droppable on a deck category, a quick zone and the
   * sidebar's Decks entry — every target that reads `readCards`. `searchCardDragData`'s half is
   * what a folder card, the parent-folder tile and a breadcrumb segment read. Read back out of the
   * library's own store rather than asserted over the composition, which would be the same
   * expression twice: what this proves is that the registration really happened and really carried
   * both.
   */
  it("carries the card and the new-copy mark in one record", async () => {
    panel(null);
    const art = await screen.findByRole("button", { name: "Black Lotus" });
    const tile = art.closest(`[${DND_SOURCE_ATTR}]`) as HTMLElement;
    // dnd-kit hit-tests by coordinate and jsdom measures every rect as zero, so a source with no
    // box is pressed at the origin and the drag starts nowhere.
    tile.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);

    const drags = recordDrags();
    const held = await startPointerDrag(tile, { pressOn: art });
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records).toHaveLength(1);
    expect(readDragData(drags.records[0])).toEqual({
      kind: "search-card",
      cardId: "lotus",
      name: "Black Lotus",
      typeLine: "Artifact",
    });
    expect(readSearchCardDrag(drags.records[0])).toEqual({
      cardId: "lotus",
      name: "Black Lotus",
      finish: "nonfoil",
      oracleId: "o-lotus",
    });
  });

  /**
   * A printing whose `finishes` column is empty means *unknown*, and `nonfoil` is the honest
   * reading of it — every card exists in the plain finish and none of the premium ones is implied.
   *
   * The case matters because the mark is **refused** rather than normalised at the other end: a
   * record whose `finish` is not a word this build knows reads as `null` for every folder target,
   * so the tile would be silently undroppable rather than visibly wrong.
   */
  it("falls back to nonfoil for a printing with no finishes recorded", async () => {
    searchCards.mockResolvedValue(page([NO_FINISHES]));
    panel(null);
    const art = await screen.findByRole("button", { name: "Restart Sequence" });
    const tile = art.closest(`[${DND_SOURCE_ATTR}]`) as HTMLElement;
    tile.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);

    const drags = recordDrags();
    const held = await startPointerDrag(tile, { pressOn: art });
    await held.cancel();
    drags.stop();

    expect(readSearchCardDrag(drags.records[0])?.finish).toBe("nonfoil");
  });

  /**
   * **The disclosure writes the reader's press through `useSearchOpen`, under this surface's own
   * section.** One `app_meta` row holds all three columns, so a panel that wrote the wrong word
   * would put the deck's search away instead of its own — and nothing on this page would say so.
   */
  it("remembers a collapse under the collection's own section", async () => {
    const user = userEvent.setup();
    panel(null);

    await user.click(await screen.findByRole("button", { name: "Collapse card search" }));

    await waitFor(() => expect(setSearchOpen).toHaveBeenCalledWith("collection", false));
    // Closed really is nothing mounted: the search, its filter row and its wall all begin at the
    // press and cost nothing before it.
    expect(within(column()).queryByRole("searchbox", { name: "Search cards" })).toBeNull();
  });
});
