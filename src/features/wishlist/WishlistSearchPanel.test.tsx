import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import { SEARCH_OVER_ATTR } from "@/features/search/CardSearchPanel";
import { SEARCH_OPEN_KEY } from "@/features/search/useSearchOpen";
import { buildFolderTree } from "@/lib/folderTree";
import type { CardSummary, WishlistFolder } from "@/lib/ipc";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";

/**
 * Everything this column reaches, and every one of them a real `invoke` — so an unmocked member is
 * a `TypeError` rather than a query that quietly resolves to nothing.
 *
 * `collectionAdd` is here for the arm this panel can never take: `AddToCollectionButton` holds both
 * writes and `lockMode` is what makes one of them unreachable, so mocking it is what lets the lock
 * be asserted as *nothing happened* rather than as a crash.
 */
const searchCards = vi.hoisted(() => vi.fn());
const facetCards = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
const searchOpen = vi.hoisted(() => vi.fn());
const setSearchOpen = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
const collectionAdd = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    facetCards,
    listSets,
    prefetchImages,
    searchOpen,
    setSearchOpen,
    getMarketplace,
    wishlistAdd,
    collectionAdd,
  },
}));

import { readWishDrop } from "./wishDrag";
import { WishlistSearchPanel } from "./WishlistSearchPanel";

/** One printing, which is all the wall needs to be a wall — every case below is about the tile's
 *  two controls rather than about the search behind them. */
const BOLT: CardSummary = {
  promoTypes: null,
  id: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  price: 400.5,
  layout: "normal",
  oracleId: "o-bolt",
  finishes: `["nonfoil","foil"]`,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
  gameChanger: false,
};

const ORDERED: WishlistFolder = { id: 1, parentId: null, name: "Ordered", sortOrder: 0 };
const SOMEDAY: WishlistFolder = { id: 3, parentId: null, name: "Someday", sortOrder: 1 };
const FOLDERS = [ORDERED, SOMEDAY];
/** `buildFolderTree(folders, [])` — the page's own call, with no members, because a picker is a
 *  list of destinations rather than a picture of what is in them. */
const NODES = buildFolderTree(FOLDERS, []);
const folderName = (id: number | null) =>
  id === null ? "Wishlist" : (FOLDERS.find((f) => f.id === id)?.name ?? null);

/**
 * jsdom lays nothing out, so the virtualiser measures a scroller of zero height and renders no
 * tiles at all — one number is the whole of what it is missing. `scrollTo` is the other thing
 * `@tanstack/react-virtual` reaches for that jsdom does not implement.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  searchCards.mockReset().mockResolvedValue({ items: [BOLT], total: 1, totalIsCapped: false });
  // Cold — `ready: false`, every map empty — so nothing in the filter row greys and every control
  // keeps its name.
  facetCards.mockReset().mockResolvedValue({
    colors: {},
    manaValues: {},
    manaX: 0,
    formats: {},
    sets: {},
    owned: { owned: 0, missing: 0 },
    total: 0,
    ready: false,
  });
  listSets.mockReset().mockResolvedValue([]);
  prefetchImages.mockReset().mockResolvedValue(undefined);
  searchOpen.mockReset().mockResolvedValue({});
  setSearchOpen.mockReset().mockResolvedValue(undefined);
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  wishlistAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
});

/**
 * The panel under the one provider it needs, with the disclosure seeded rather than pressed.
 *
 * `useSearchOpen`'s query is `staleTime: Infinity`, so a seeded entry is the answer and there is no
 * round trip to race — `WishlistPage.test.tsx`'s seam, reached from the component side. The default
 * here is **open**, which is the app's own (`DEFAULT_SEARCH_OPEN.wishlist`), because this file is
 * about the body rather than about the page it hangs off.
 */
function mount(
  ui: ReactElement,
  { open = true }: { open?: boolean } = {},
): { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SEARCH_OPEN_KEY, { wishlist: open });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
  return { client };
}

const panel = (props: Partial<Parameters<typeof WishlistSearchPanel>[0]> = {}) => (
  <WishlistSearchPanel
    folderId={null}
    folderNodes={NODES}
    folderName={folderName}
    {...props}
  />
);

/** The `+` on the wall's one tile, whose name states the destination it would file into. */
const plus = (destination: string) =>
  screen.findByRole("button", { name: `Add Lightning Bolt (LEA 161) to ${destination}` });

describe("WishlistSearchPanel", () => {
  /**
   * The section's name is what tells this column from the collection's on a probe, and the two are
   * deliberately different sentences — `CardSearchPanel`'s `sectionLabel` doc carries the whole
   * argument.
   */
  it("names itself for the list it files into", async () => {
    mount(panel());

    const column = await screen.findByRole("region", { name: "Add cards to your wishlist" });
    expect(within(column).getByRole("button", { name: "Collapse card search" })).toBeInTheDocument();
  });

  /**
   * **The body mounts on the reader's press and on nothing else**, which is the whole reason this
   * component is two: a page nobody searched from must issue no `search_cards`.
   */
  it("searches nothing until the reader opens it", async () => {
    mount(panel(), { open: false });

    expect(await screen.findByRole("button", { name: "Expand card search" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(searchCards).not.toHaveBeenCalled();
  });

  /**
   * Its own `idStem`, which is what stops two mounted `FilterBar`s sharing an `id` — a duplicate
   * would make this row's `<label htmlFor>` name the *page's* field, handing the caret to a control
   * in the other column.
   */
  it("keeps its filter row's ids out of the page's", async () => {
    mount(panel());

    expect(await screen.findByLabelText("Search cards")).toHaveAttribute("id", "wishlist-add-text");
  });

  /**
   * **`data-search-over` is stamped only while the panel is drawn over the list**, and its value is
   * what says which of the three this is. One attribute, three values — the deck's probes stay
   * unambiguous because the three panels live on three routes.
   */
  it("says which surface it is while it is drawn over the list", async () => {
    mount(panel({ roomy: false, overWidth: 400 }));

    const column = await screen.findByRole("region", { name: "Add cards to your wishlist" });
    expect(column).toHaveAttribute(SEARCH_OVER_ATTR, "wishlist");
  });

  /**
   * **The destination is the page, not a choice** (spec §2.2). A switch offering the collection
   * here would change which list the results the reader is looking at belong to — and it would
   * offer the wishlist's folder tree for a collection add, which is a different table.
   */
  it("locks the popup to the wishlist and draws no destination switch", async () => {
    mount(panel());

    await userEvent.click(await plus("Wishlist"));

    expect(screen.queryByRole("group", { name: "Add to" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add to wishlist" })).toBeInTheDocument();
  });

  /** The folder the page is standing in is the destination, and it is in the trigger's own name
   *  before the press rather than in a report after it. */
  it("files a press into the folder it was given", async () => {
    mount(panel({ folderId: 3 }));

    await userEvent.click(await plus("Someday"));
    await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));

    expect(wishlistAdd).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "c1", folderId: 3 }),
    );
    expect(collectionAdd).not.toHaveBeenCalled();
  });

  /** And the default is a *default* rather than a pin: the reader can send one card elsewhere
   *  without leaving the drawer they are standing in. */
  it("offers the tree so one card can go somewhere else", async () => {
    mount(panel({ folderId: 3 }));

    await userEvent.click(await plus("Someday"));
    await userEvent.click(
      screen.getByRole("button", { name: "Change folder for Lightning Bolt" }),
    );
    await userEvent.click(
      within(screen.getByRole("group", { name: "File Lightning Bolt in a folder" })).getByRole(
        "button",
        { name: "Ordered" },
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));

    expect(wishlistAdd).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "c1", folderId: 1 }),
    );
  });

  /**
   * **Two marks in one flat record**, which is the whole of what lets one gesture mean two things:
   * `dnd.ts`'s half keeps the tile droppable on a deck category, and this feature's half is what a
   * folder card reads. Each reader answers only its own key.
   *
   * Read off the library's own store rather than off the component's props, because that store is
   * the boundary the two readers actually meet at — `collectionDrag.test.ts` proves its wall the
   * same way.
   */
  it("puts both marks on a dragged tile", async () => {
    mount(panel());
    const tile = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[${DND_SOURCE_ATTR}]`);
      if (!found) throw new Error("no tile");
      return found;
    });
    // A box, because dnd-kit hit-tests by coordinate and jsdom measures every rect as zero.
    boxed(tile, 0);
    const drags = recordDrags();

    const held = await startPointerDrag(tile);
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records).toHaveLength(1);
    const record = drags.records[0];
    // The card half — what a deck category, a quick zone and the sidebar's Decks entry read.
    expect(readDragData(record)).not.toBeNull();
    // And this feature's, which a folder card reads as a card nobody owns yet. The finish is the
    // printing's first, never a guess: `readSearchCardDrag` refuses a word this build does not
    // know rather than normalising it, so a wrong one would be a drop that silently never lands.
    expect(readWishDrop(record)).toEqual({
      kind: "new",
      card: { cardId: "c1", name: "Lightning Bolt", finish: "nonfoil", oracleId: "o-bolt" },
    });
  });
});
