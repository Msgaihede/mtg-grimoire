/**
 * What the folders widget has to get right, and every case here is one of the ways it could be
 * quietly wrong.
 *
 * **Nothing here mocks `@/lib/ipc`.** A `vi.mock` of that module rebuilds `ipc` out of
 * `vi.fn()`s, which erases the mirror `ipc.test.ts` checks against Rust — so the happy paths
 * seed the **query cache** under the keys `useCollectionFolders` and `useWishlistFolders`
 * already use, with `staleTime: Infinity`, and no `queryFn` ever runs. The cases that are
 * *about* a read in flight or refused are the exception, and they use `vi.spyOn` on one method
 * of the real `ipc` object rather than replacing the module: the other ninety commands stay
 * exactly what they were.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ipc,
  type CollectionFolder,
  type CollectionFolderSummary,
  type HomeWidget,
  type WishlistFolder,
  type WishlistFolderSummary,
} from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { openDropdown } from "@/test-dropdown";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import type { Density } from "../widgetSettings";
import { FoldersWidget, FoldersWidgetSettings, shareRows } from "./FoldersWidget";

/**
 * The four keys this widget reads through, spelled here because the hooks that own them build
 * them inline. A key that drifts fails every case in this file at once, which is the point:
 * these are the keys every collection and wishlist write already invalidates, and a widget on a
 * private key of its own would be a dashboard that goes stale the moment a card moves.
 */
const COLLECTION_FOLDERS = ["collection", "folders"];
const COLLECTION_SUMMARY = ["collection", "folderSummary", "tcgplayer"];
const WISHLIST_FOLDERS = ["wishlist", "folders"];
const WISHLIST_SUMMARY = ["wishlist", "folderSummary", "tcgplayer"];

function folder(over: Partial<CollectionFolder> & { id: number; name: string }): CollectionFolder {
  return {
    parentId: null,
    kind: "user",
    deckId: null,
    sortOrder: 0,
    locked: false,
    syncUid: null,
    ...over,
  };
}

/**
 * A cabinet three levels deep, so a roll-up that stopped at the first level would still be
 * caught: `Deep` is a grandchild of `Binder`.
 */
const BINDER = folder({ id: 1, name: "Binder", sortOrder: 0 });
const FOILS = folder({ id: 2, name: "Foils", parentId: 1 });
const DEEP = folder({ id: 3, name: "Deep", parentId: 2 });
const TRADES = folder({ id: 4, name: "Trades", sortOrder: 1 });
const DECK_GROUP = folder({ id: 5, name: "Blue Tempo", kind: "deck", deckId: 7 });
const REMOVED = folder({ id: 6, name: "Recently removed", kind: "removed" });
const COLLECTION = [BINDER, FOILS, DEEP, TRADES, DECK_GROUP, REMOVED];

/**
 * The summary, which is **direct per folder** and has **no row at all** for a folder holding
 * nothing — `Trades` and `Recently removed` are absent on purpose, and that absence is a folder
 * with nothing in it rather than a folder nothing is known about.
 *
 * `Deep` and the deck group are priced at `null`: the marketplace quoted nothing in either.
 */
const COLLECTION_ROWS: CollectionFolderSummary[] = [
  { folderId: 1, cards: 3, value: 10 },
  { folderId: 2, cards: 4, value: 20 },
  { folderId: 3, cards: 5, value: null },
  { folderId: 5, cards: 2, value: null },
];

const BUY_SOON: WishlistFolder = { id: 10, parentId: null, name: "Buy soon", sortOrder: 0 };
const STAPLES: WishlistFolder = { id: 11, parentId: 10, name: "Staples", sortOrder: 0 };
const LATER: WishlistFolder = { id: 12, parentId: null, name: "Later", sortOrder: 1 };
const WISHES = [BUY_SOON, STAPLES, LATER];

const WISHLIST_ROWS: WishlistFolderSummary[] = [
  { folderId: 10, wishes: 1, copies: 1, cost: 5, unpriced: 0 },
  { folderId: 11, wishes: 2, copies: 3, cost: 7.5, unpriced: 1 },
];

interface Seed {
  collection?: CollectionFolder[];
  collectionRows?: CollectionFolderSummary[];
  wishlist?: WishlistFolder[];
  wishlistRows?: WishlistFolderSummary[];
  /** Leave a cabinet's two keys unseeded, so its queries are the ones a spy is driving. */
  skip?: "collection" | "wishlist";
}

function widget(config: unknown = null): HomeWidget {
  return { id: "folders", kind: "folders", x: 0, y: 0, w: 4, h: 2, config };
}

/** The box a widget is told it is drawn in, at the grid's target cell. */
function fitFor(w: number, h: number, density: Density = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density });
}

/** Room for every fixture: a three-cell panel eight tall, one list column. */
const ROOMY = fitFor(3, 8);

function client(seed: Seed): QueryClient {
  const qc = new QueryClient({
    // `staleTime: Infinity` is what makes a seeded entry the whole answer: nothing refetches, so
    // no command is called and there is no round trip to race an assertion.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(MARKETPLACE_KEY, "tcgplayer");
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  if (seed.skip !== "collection") {
    qc.setQueryData(COLLECTION_FOLDERS, seed.collection ?? COLLECTION);
    qc.setQueryData(COLLECTION_SUMMARY, seed.collectionRows ?? COLLECTION_ROWS);
  }
  if (seed.skip !== "wishlist") {
    qc.setQueryData(WISHLIST_FOLDERS, seed.wishlist ?? WISHES);
    qc.setQueryData(WISHLIST_SUMMARY, seed.wishlistRows ?? WISHLIST_ROWS);
  }
  return qc;
}

function renderWith(seed: Seed, ui: ReactElement) {
  return render(<QueryClientProvider client={client(seed)}>{ui}</QueryClientProvider>);
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false, seed = {} }: { fit?: WidgetFit; still?: boolean; seed?: Seed } = {},
) {
  return renderWith(
    seed,
    <FoldersWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
  );
}

/** Every row's accessible name, in the order it is drawn. */
const rows = () =>
  screen
    .queryAllByRole("button")
    .map((button) => button.getAttribute("aria-label"))
    .filter((name) => name !== null);

/**
 * **The store is module state and outlives `cleanup()`**, so a case that leaves something
 * written is a case the next one inherits — and the press cases below write a folder hand-off
 * that nothing in this file mounts a page to spend.
 */
beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FoldersWidget", () => {
  /**
   * Trap 1. `collection_folder_summary` answers *direct* copies — this folder's own, never what
   * is nested under it. So `Binder` is 3 + 4 + 5 copies and $10 + $20, and a widget that drew
   * its raw row would say `3 cards · $10.00` over a drawer holding twelve.
   */
  it("rolls a folder's sub-folders into its figures", () => {
    draw({ collectionFolderIds: [1], wishlistFolderIds: [12] });

    const binder = screen.getByRole("button", {
      name: "Binder, collection folder, 12 cards, $30.00",
    });
    expect(within(binder).getByText("Collection · 12 cards")).toBeInTheDocument();
    expect(within(binder).getByText("$30.00")).toBeInTheDocument();
  });

  /** The same sum on the other cabinet, over four fields instead of two — and the unpriced note
   *  rolls up with them, because it qualifies the subtotal it travels beside. */
  it("rolls a wishlist folder's sub-folders in too", () => {
    draw({ wishlistFolderIds: [10] });

    const row = screen.getByRole("button", {
      name: "Buy soon, wishlist folder, 3 wishes, $12.50, 1 unpriced",
    });
    expect(within(row).getByText("Wishlist · 3 wishes · 1 unpriced")).toBeInTheDocument();
  });

  /**
   * Trap 3. `CollectionFolderSummary.value` is `number | null`: a drawer the marketplace priced
   * nothing in draws an em dash rather than reading as a drawer worth nothing.
   */
  it("draws an em dash for a folder the marketplace priced nothing in", () => {
    draw({ collectionFolderIds: [5] }, { seed: { wishlist: [] } });

    const row = screen.getByRole("button", { name: "Blue Tempo, deck folder, 2 cards, not priced" });
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  /**
   * Trap 2. Both summaries `GROUP BY` their entries, so a folder holding nothing emits no row —
   * which is a folder with nothing in it, not a folder that failed to load. An empty drawer shows
   * its count and no money at all.
   */
  it("counts a folder the summary skipped as empty rather than blank", () => {
    draw({ collectionFolderIds: [4], wishlistFolderIds: [12] });

    const trades = screen.getByRole("button", { name: "Trades, collection folder, 0 cards" });
    expect(trades).toHaveTextContent("TradesCollection · 0 cards");
    expect(
      screen.getByRole("button", { name: "Later, wishlist folder, 0 wishes" }),
    ).toBeInTheDocument();
  });

  /**
   * The app owns two kinds of collection folder — one per deck, and the single `Recently
   * removed` — and a reader may pin either. What they may not do is mistake a deck's group for
   * a binder they made, so the row says which it is in words as well as with a glyph.
   */
  it("labels the app's own folders for what they are", () => {
    draw({ collectionFolderIds: [5, 6] }, { seed: { wishlist: [] } });

    expect(rows()).toEqual([
      "Blue Tempo, deck folder, 2 cards, not priced",
      "Recently removed, removed cards, 0 cards",
    ]);
    expect(screen.getByText("Deck folder · 2 cards")).toBeInTheDocument();
    expect(screen.getByText("Removed cards · 0 cards")).toBeInTheDocument();
  });

  /**
   * A `folders` widget is in the default layout with `config: null`, so this is what every
   * reader sees before they have pinned anything. The fallback is the drawers **they made**, at
   * the top level: offering twenty deck groups would bury the two binders they care about.
   */
  it("falls back to the top-level folders the reader made when nothing is pinned", () => {
    draw();

    expect(rows()).toEqual([
      "Binder, collection folder, 12 cards, $30.00",
      "Trades, collection folder, 0 cards",
      "Buy soon, wishlist folder, 3 wishes, $12.50, 1 unpriced",
      "Later, wishlist folder, 0 wishes",
    ]);
  });

  /** A pinned set is drawn in the order it was pinned, not in the cabinet's order. */
  it("draws a pinned set in the order it was pinned", () => {
    draw({ collectionFolderIds: [4, 1] }, { seed: { wishlist: [] } });

    expect(rows()).toEqual([
      "Trades, collection folder, 0 cards",
      "Binder, collection folder, 12 cards, $30.00",
    ]);
  });

  /** A pinned id whose folder another surface has deleted draws nothing and refuses nothing. */
  it("skips a pinned folder that is no longer there", () => {
    draw({ collectionFolderIds: [1, 999], wishlistFolderIds: [12] });

    expect(rows()).toEqual([
      "Binder, collection folder, 12 cards, $30.00",
      "Later, wishlist folder, 0 wishes",
    ]);
  });

  describe("cabinets and captions", () => {
    it("draws only the collection when that is the cabinet chosen", () => {
      draw({ cabinets: "collection" });

      expect(screen.getByRole("list", { name: "Collection folders" })).toBeInTheDocument();
      expect(rows()).toEqual([
        "Binder, collection folder, 12 cards, $30.00",
        "Trades, collection folder, 0 cards",
      ]);
    });

    it("draws only the wishlist when that is the cabinet chosen", () => {
      draw({ cabinets: "wishlist" });

      expect(screen.getByRole("list", { name: "Wishlist folders" })).toBeInTheDocument();
      expect(rows()).toEqual([
        "Buy soon, wishlist folder, 3 wishes, $12.50, 1 unpriced",
        "Later, wishlist folder, 0 wishes",
      ]);
    });

    /**
     * With the switch off a row is one line: the name and its figure. **An empty drawer shows its
     * count there**, because it has no money and the count is the one fact it has.
     */
    it("drops the caption when Show which cabinet is off", () => {
      draw({ captions: false, collectionFolderIds: [1, 4] }, { seed: { wishlist: [] } });

      expect(screen.queryByText(/^Collection ·/)).toBeNull();
      expect(screen.getByRole("button", { name: /^Binder,/ })).toHaveTextContent("Binder$30.00");
      expect(screen.getByRole("button", { name: /^Trades,/ })).toHaveTextContent("Trades0 cards");
    });

    it("drops the caption on a compact card", () => {
      draw({ collectionFolderIds: [1] }, { fit: fitFor(3, 8, "compact"), seed: { wishlist: [] } });

      expect(screen.queryByText(/^Collection ·/)).toBeNull();
    });

    /** On a two-cell tile the figure moves under the name, and it is the folder's whole face —
     *  the count and the money — which is how every folder tile already reads. */
    it("moves the folder's face under the name on a two-cell tile", () => {
      draw({ collectionFolderIds: [1] }, { fit: fitFor(2, 4), seed: { wishlist: [] } });

      const binder = screen.getByRole("button", { name: /^Binder,/ });
      expect(within(binder).getByText("12 cards · $30.00")).toBeInTheDocument();
      expect(binder).toHaveTextContent("Binder12 cards · $30.00");
    });
  });

  describe("what fits", () => {
    const many = (n: number, from: number) =>
      // `sortOrder` carries the order: the tree sorts siblings by it before the name, and by name
      // alone `Drawer 10` files before `Drawer 2`.
      Array.from({ length: n }, (_, i) =>
        folder({ id: from + i, name: `Drawer ${i + 1}`, sortOrder: i }),
      );
    const wishes = (n: number, from: number): WishlistFolder[] =>
      Array.from({ length: n }, (_, i) => ({
        id: from + i,
        parentId: null,
        name: `Wish ${i + 1}`,
        sortOrder: i,
      }));

    /**
     * A three-by-two panel holds three captioned rows (170px of body at 51 + 6). **Both cabinets
     * share them** — two collection, one wishlist — rather than twelve drawers taking all three.
     */
    it("cuts the rows to the box and shares them between the cabinets", () => {
      draw(null, {
        fit: fitFor(3, 2),
        seed: { collection: many(12, 100), collectionRows: [], wishlist: wishes(5, 200), wishlistRows: [] },
      });

      expect(rows()).toEqual([
        "Drawer 1, collection folder, 0 cards",
        "Drawer 2, collection folder, 0 cards",
        "Wish 1, wishlist folder, 0 wishes",
      ]);
    });

    it("draws four bare rows in the same box with the captions off", () => {
      draw({ captions: false, cabinets: "collection" }, {
        fit: fitFor(3, 2),
        seed: { collection: many(12, 100), collectionRows: [] },
      });

      expect(rows()).toHaveLength(4);
    });

    it("gives the wishlist what the collection cannot use", () => {
      expect(shareRows([1], [2, 3, 4, 5], 4)).toEqual([1, 2, 3, 4]);
      expect(shareRows([1, 2, 3, 4, 5], [9], 4)).toEqual([1, 2, 3, 9]);
      expect(shareRows([1, 2, 3], [7, 8, 9], 3)).toEqual([1, 2, 7]);
    });
  });

  describe("opening a folder", () => {
    /**
     * **A press is a navigation *and* a hand-off, and the order the two writes are made in is what
     * this really pins.** `setActiveView` clears a hand-off on every view change, so a press that
     * named the folder *first* would erase its own message — and the failure is silent, because
     * the reader still lands on the right page, at the root. The end state alone passes for the
     * right order *and* for a store that happens to batch; the recorded order is the fence.
     */
    it("opens the collection at the folder that was pressed, view first", async () => {
      const user = userEvent.setup();
      const writes: string[] = [];
      const { setActiveView, setPendingFolder } = useAppStore.getState();
      useAppStore.setState({
        activeView: "settings",
        setActiveView: (view) => {
          writes.push(`view:${view}`);
          setActiveView(view);
        },
        setPendingFolder: (pending) => {
          writes.push(`folder:${pending.scope}:${pending.id}`);
          setPendingFolder(pending);
        },
      });
      draw({ collectionFolderIds: [1] }, { seed: { wishlist: [] } });

      await user.click(screen.getByRole("button", { name: /^Binder, collection folder/ }));

      expect(writes).toEqual(["view:collection", "folder:collection:1"]);
      expect(useAppStore.getState().activeView).toBe("collection");
      expect(useAppStore.getState().pendingFolder).toEqual({ scope: "collection", id: 1 });
    });

    /** The same press on the other cabinet — and the `scope` is what stops the wishlist's page
     *  reading the collection's post, since one field serves both. */
    it("opens the wishlist at the folder that was pressed", async () => {
      const user = userEvent.setup();
      useAppStore.setState({ activeView: "settings" });
      draw({ cabinets: "wishlist", wishlistFolderIds: [10] });

      await user.click(screen.getByRole("button", { name: /^Buy soon, wishlist folder/ }));

      expect(useAppStore.getState().activeView).toBe("wishlist");
      expect(useAppStore.getState().pendingFolder).toEqual({ scope: "wishlist", id: 10 });
    });

    it("draws a still body with no presses", () => {
      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Binder")).toBeInTheDocument();
      expect(useAppStore.getState().pendingFolder).toBeNull();
    });
  });

  describe("the states", () => {
    /**
     * A cabinet still being read says so rather than drawing `0 cards` across the window — a
     * wrong number that then jumps is not a spinner. The promise never settles, which is the
     * state under test held still.
     */
    it("says the collection folders are still being read, and draws the wishlist beside it", () => {
      vi.spyOn(ipc, "collectionFolderList").mockReturnValue(new Promise(() => {}));
      vi.spyOn(ipc, "collectionFolderSummary").mockReturnValue(new Promise(() => {}));
      draw(null, { seed: { skip: "collection" } });

      expect(screen.getByText("Reading your collection folders…")).toBeInTheDocument();
      // One cabinet still out is not two.
      expect(rows()).toHaveLength(2);
    });

    it("says when there are no folders at all", () => {
      draw(null, { seed: { collection: [], collectionRows: [], wishlist: [], wishlistRows: [] } });

      expect(screen.getByText(/No collection folders to show/)).toBeInTheDocument();
      expect(screen.getByText(/No wishlist folders to show/)).toBeInTheDocument();
      expect(screen.queryByRole("list")).toBeNull();
    });

    it("says nothing about a cabinet the card does not draw", () => {
      draw({ cabinets: "collection" }, { seed: { wishlist: [], wishlistRows: [] } });

      expect(screen.queryByText(/No wishlist folders to show/)).toBeNull();
    });

    /** A read the backend refused says so, and says what it said. */
    it("says when the read was refused, and what the refusal was", async () => {
      vi.spyOn(ipc, "collectionFolderList").mockRejectedValue("database is locked");
      vi.spyOn(ipc, "collectionFolderSummary").mockResolvedValue([]);
      draw(null, { seed: { skip: "collection" } });

      expect(
        await screen.findByText(/Could not read your collection folders — database is locked/),
      ).toBeInTheDocument();
    });
  });

  describe("its settings", () => {
    function settings(config: unknown, onConfig = vi.fn()) {
      renderWith({}, <FoldersWidgetSettings widget={widget(config)} onConfig={onConfig} />);
      return onConfig;
    }

    /** …and offers the app's own folders, which is where this parts company with every folder
     *  *picker* in the app: those offer `user` only, because they choose where to write. */
    it("offers the app's own folders, labelled", async () => {
      const user = userEvent.setup();
      settings(null);

      await openDropdown(user, "Collection folders");

      expect(screen.getByRole("option", { name: "Blue Tempo (deck)" })).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Recently removed (removed cards)" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Binder" })).toBeInTheDocument();
    });

    it("draws a picker only for the cabinets the card draws", () => {
      settings({ cabinets: "collection" });

      expect(screen.getByRole("button", { name: "Collection folders" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Wishlist folders" })).toBeNull();
    });

    /** The patch names one key; the page merges it and keeps every other one. */
    it("pins a folder, patching only its own cabinet's pins", async () => {
      const user = userEvent.setup();
      const onConfig = settings({ collectionFolderIds: [], wishlistFolderIds: [12] });

      await openDropdown(user, "Collection folders");
      await user.click(screen.getByRole("option", { name: "Trades" }));

      expect(onConfig).toHaveBeenCalledTimes(1);
      expect(onConfig).toHaveBeenCalledWith({ collectionFolderIds: [4] });
    });

    /** Pinning is a toggle: a second press on a pinned folder takes it off, in place. */
    it("unpins a folder that is already pinned", async () => {
      const user = userEvent.setup();
      const onConfig = settings({ collectionFolderIds: [1, 4] });

      await openDropdown(user, "Collection folders");
      await user.click(screen.getByRole("option", { name: "Binder" }));

      expect(onConfig).toHaveBeenCalledWith({ collectionFolderIds: [4] });
    });

    it("pins a wishlist folder at the end of its set", async () => {
      const user = userEvent.setup();
      const onConfig = settings({ wishlistFolderIds: [12] });

      await openDropdown(user, "Wishlist folders");
      await user.click(screen.getByRole("option", { name: "Buy soon" }));

      expect(onConfig).toHaveBeenCalledWith({ wishlistFolderIds: [12, 10] });
    });
  });
});
