/**
 * What the folders widget has to get right, and every case here is one of the three ways it
 * could be quietly wrong.
 *
 * **Nothing here mocks `@/lib/ipc`.** A `vi.mock` of that module rebuilds `ipc` out of
 * `vi.fn()`s, which erases the mirror `ipc.test.ts` checks against Rust — so the happy paths
 * seed the **query cache** under the keys `useCollectionFolders` and `useWishlistFolders`
 * already use, with `staleTime: Infinity`, and no `queryFn` ever runs. The two cases that are
 * *about* a read in flight or refused are the exception, and they use `vi.spyOn` on one method
 * of the real `ipc` object rather than replacing the module: the other ninety commands stay
 * exactly what they were.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import type { WidgetProps } from "../widgetProps";
import { FoldersWidget } from "./FoldersWidget";

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
  return { id: "folders", kind: "folders", span: 2, config };
}

/** Fresh spies per call — a shared one makes `toHaveBeenCalledTimes(1)` pass or fail by the
 *  order vitest happened to run the file in. `WidgetCard.test.tsx`'s `props()` is the precedent. */
function props(over: Partial<WidgetProps> = {}): WidgetProps {
  return {
    widget: widget(),
    editing: false,
    onConfig: vi.fn(),
    onRemove: vi.fn(),
    onSpan: vi.fn(),
    dragHandleRef: vi.fn(),
    onNudge: vi.fn(),
    ...over,
  };
}

function draw(over: Partial<WidgetProps> = {}, seed: Seed = {}) {
  const client = new QueryClient({
    // `staleTime: Infinity` is what makes a seeded entry the whole answer: nothing refetches, so
    // no command is called and there is no round trip to race an assertion.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(MARKETPLACE_KEY, "tcgplayer");
  client.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  if (seed.skip !== "collection") {
    client.setQueryData(COLLECTION_FOLDERS, seed.collection ?? COLLECTION);
    client.setQueryData(COLLECTION_SUMMARY, seed.collectionRows ?? COLLECTION_ROWS);
  }
  if (seed.skip !== "wishlist") {
    client.setQueryData(WISHLIST_FOLDERS, seed.wishlist ?? WISHES);
    client.setQueryData(WISHLIST_SUMMARY, seed.wishlistRows ?? WISHLIST_ROWS);
  }
  const all = props(over);
  return {
    ...all,
    ...render(
      <QueryClientProvider client={client}>
        <FoldersWidget {...all} />
      </QueryClientProvider>,
    ),
  };
}

/** The list of collection tiles, addressed by the name the widget gives it. */
const collectionList = () => screen.getByRole("list", { name: "Collection folders" });
const wishlistList = () => screen.getByRole("list", { name: "Wishlist folders" });

/** Every tile in a list, in the order it is drawn. */
const tiles = (list: HTMLElement) =>
  within(list)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

/**
 * **The store is module state and outlives `cleanup()`**, so a case that leaves something
 * written is a case the next one inherits — and the two press cases below write a folder
 * hand-off that nothing in this file mounts a page to spend. `store.test.ts`'s own reset, for
 * its own reason.
 */
beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FoldersWidget", () => {
  /**
   * Trap 1. `collection_folder_summary` answers *direct* copies — this folder's own, never what
   * is nested under it — because SQL that walked the tree would be a second implementation of
   * arithmetic `buildFolderTree` already does. So `Binder` is 3 + 4 + 5 copies and $10 + $20,
   * and a widget that drew its raw row would say `3 cards · $10.00` over a drawer holding
   * twelve.
   */
  it("rolls a folder's sub-folders into its figures", () => {
    draw({ widget: widget({ collectionFolderIds: [1] }) });

    expect(
      screen.getByRole("button", { name: "Binder, collection folder, 12 cards, $30.00" }),
    ).toBeInTheDocument();
    expect(within(collectionList()).getByText("12 cards · $30.00")).toBeInTheDocument();
  });

  /** The same sum on the other cabinet, over four fields instead of two — and the unpriced note
   *  rolls up with them, because it qualifies the subtotal it travels beside. */
  it("rolls a wishlist folder's sub-folders in too", () => {
    draw({ widget: widget({ wishlistFolderIds: [10] }) });

    expect(
      screen.getByRole("button", {
        name: "Buy soon, wishlist folder, 3 wishes, $12.50, 1 unpriced",
      }),
    ).toBeInTheDocument();
  });

  /**
   * Trap 3. `CollectionFolderSummary.value` is `number | null` where the page header's is
   * `coalesce(…, 0.0)`, and the two differ on purpose: a tile has no room for the header's
   * "n unpriced" note, so a drawer the marketplace priced nothing in draws an em dash rather
   * than reading as a drawer worth nothing.
   */
  it("draws an em dash for a folder the marketplace priced nothing in", () => {
    draw({ widget: widget({ collectionFolderIds: [5] }) });

    expect(within(collectionList()).getByText("2 cards · —")).toBeInTheDocument();
    // And says it in words where a dash would be read aloud as punctuation.
    expect(
      screen.getByRole("button", { name: "Blue Tempo, deck folder, 2 cards, not priced" }),
    ).toBeInTheDocument();
  });

  /**
   * Trap 2. Both summaries `GROUP BY` their entries, so a folder holding nothing emits no row —
   * which is a folder with nothing in it, not a folder that failed to load. `0 cards` is the
   * honest face of an empty drawer.
   */
  it("counts a folder the summary skipped as empty rather than blank", () => {
    draw({ widget: widget({ collectionFolderIds: [4], wishlistFolderIds: [12] }) });

    expect(
      screen.getByRole("button", { name: "Trades, collection folder, 0 cards" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Later, wishlist folder, 0 wishes" }),
    ).toBeInTheDocument();
  });

  /**
   * The app owns two kinds of collection folder — one per deck, and the single `Recently
   * removed` — and a reader may pin either. What they may not do is mistake a deck's group for
   * a binder they made, so the tile says which it is in words as well as with a glyph.
   */
  it("labels the app's own folders for what they are", () => {
    draw({ widget: widget({ collectionFolderIds: [5, 6] }) });

    const list = collectionList();
    expect(within(list).getByText("Deck")).toBeInTheDocument();
    expect(within(list).getByText("Removed")).toBeInTheDocument();
    expect(tiles(list)).toEqual([
      "Blue Tempo, deck folder, 2 cards, not priced",
      "Recently removed, removed cards, 0 cards",
    ]);
  });

  /** …and offers them, which is where this parts company with every folder *picker* in the app:
   *  those offer `user` and only `user`, because they are choosing a destination to write to. */
  it("offers the app's own folders in its settings, labelled", async () => {
    const user = userEvent.setup();
    draw({ editing: true });

    await user.click(screen.getByRole("button", { name: "Settings for Folders" }));
    await openDropdown(user, "Collection folders");

    expect(screen.getByRole("option", { name: "Blue Tempo (deck)" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Recently removed (removed cards)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Binder" })).toBeInTheDocument();
  });

  /**
   * A `folders` widget is in the default layout with `config: null`, so this is what every
   * reader sees before they have pinned anything — a dead card there would be the first thing
   * the home page ever said. The fallback is the drawers **they made**, at the top level:
   * offering twenty deck groups would bury the two binders they care about.
   */
  it("falls back to the top-level folders the reader made when nothing is pinned", () => {
    draw();

    expect(tiles(collectionList())).toEqual([
      "Binder, collection folder, 12 cards, $30.00",
      "Trades, collection folder, 0 cards",
    ]);
    expect(tiles(wishlistList())).toEqual([
      "Buy soon, wishlist folder, 3 wishes, $12.50, 1 unpriced",
      "Later, wishlist folder, 0 wishes",
    ]);
  });

  /** A pinned set is drawn in the order it was pinned, not in the cabinet's order: the reader
   *  chose both which and where. */
  it("draws a pinned set in the order it was pinned", () => {
    draw({ widget: widget({ collectionFolderIds: [4, 1] }) });

    expect(tiles(collectionList())).toEqual([
      "Trades, collection folder, 0 cards",
      "Binder, collection folder, 12 cards, $30.00",
    ]);
  });

  /** A pinned id whose folder another surface has deleted draws nothing and refuses nothing —
   *  a widget is a shortcut, and a shortcut to somewhere that is gone is simply not a shortcut. */
  it("skips a pinned folder that is no longer there", () => {
    draw({ widget: widget({ collectionFolderIds: [1, 999] }) });

    expect(tiles(collectionList())).toEqual(["Binder, collection folder, 12 cards, $30.00"]);
  });

  /**
   * **A press is a navigation *and* a hand-off, and this asserts both halves of one press.**
   *
   * The view was the whole of what a press could do until the door existed: which drawer a reader
   * is standing in is `useCollection`'s own `useState`, deliberately, so a shortcut that only
   * changed the view landed them at the root of the cabinet whose *drawer* they had pressed.
   * `pendingFolder` carries the rest, and `CollectionPage` spends it as it arrives.
   *
   * **The order the two writes are made in is what this really pins.** `setActiveView` clears a
   * hand-off on every view change, so a press that named the folder *first* would erase its own
   * message — and the failure is silent, because the reader still lands on the right page, at the
   * root, exactly as they did before any of this existed. `store.test.ts` pins the two store
   * rules; this pins that the widget writes them the right way round.
   */
  it("opens the collection at the folder that was pressed", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ activeView: "settings" });
    draw({ widget: widget({ collectionFolderIds: [1] }) });

    await user.click(screen.getByRole("button", { name: /^Binder, collection folder/ }));

    expect(useAppStore.getState().activeView).toBe("collection");
    expect(useAppStore.getState().pendingFolder).toEqual({ scope: "collection", id: 1 });
  });

  /** The same press on the other cabinet — and the `scope` is what stops the wishlist's page
   *  reading the collection's post, since one field serves both. */
  it("opens the wishlist at the folder that was pressed", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ activeView: "settings" });
    draw({ widget: widget({ wishlistFolderIds: [10] }) });

    await user.click(screen.getByRole("button", { name: /^Buy soon, wishlist folder/ }));

    expect(useAppStore.getState().activeView).toBe("wishlist");
    expect(useAppStore.getState().pendingFolder).toEqual({ scope: "wishlist", id: 10 });
  });

  /**
   * The config is written back **spread**, so a key this build has never heard of — a newer
   * build's setting, carried through untouched by `widgetConfig` — survives a reader pinning a
   * folder in an older one.
   */
  it("writes the config back, keeping what it does not know about", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    draw({
      editing: true,
      onConfig,
      widget: widget({ collectionFolderIds: [], wishlistFolderIds: [], sortedBy: "value" }),
    });

    await user.click(screen.getByRole("button", { name: "Settings for Folders" }));
    await openDropdown(user, "Collection folders");
    await user.click(screen.getByRole("option", { name: "Trades" }));

    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig).toHaveBeenCalledWith({
      collectionFolderIds: [4],
      wishlistFolderIds: [],
      sortedBy: "value",
    });
  });

  /** Pinning is a toggle: a second press on a pinned folder takes it off the widget. */
  it("unpins a folder that is already pinned", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    draw({ editing: true, onConfig, widget: widget({ collectionFolderIds: [1, 4] }) });

    await user.click(screen.getByRole("button", { name: "Settings for Folders" }));
    await openDropdown(user, "Collection folders");
    await user.click(screen.getByRole("option", { name: "Binder" }));

    expect(onConfig).toHaveBeenCalledWith({ collectionFolderIds: [4], wishlistFolderIds: [] });
  });

  /**
   * The first of three states, each a sentence. A cabinet still being read says so rather than
   * drawing `0 cards` across the window — a wrong number that then jumps is not a spinner.
   *
   * `vi.spyOn` on the one method rather than a module mock: see this file's head. The promise
   * never settles, which is the state under test held still.
   */
  it("says the collection folders are still being read", () => {
    vi.spyOn(ipc, "collectionFolderList").mockReturnValue(new Promise(() => {}));
    vi.spyOn(ipc, "collectionFolderSummary").mockReturnValue(new Promise(() => {}));
    draw({}, { skip: "collection" });

    expect(screen.getByText("Reading your collection folders…")).toBeInTheDocument();
    // And the cabinet that *did* answer is drawn beside it: one refusal is not two.
    expect(tiles(wishlistList())).toHaveLength(2);
  });

  /** The second: a reader owed no folders is told there are none, in words that say what to do
   *  about it. */
  it("says when there are no folders at all", () => {
    draw({}, { collection: [], collectionRows: [], wishlist: [], wishlistRows: [] });

    expect(screen.getByText(/No collection folders to show/)).toBeInTheDocument();
    expect(screen.getByText(/No wishlist folders to show/)).toBeInTheDocument();
  });

  /** The third: a read the backend refused says so, and says what it said — `ipcError` is how a
   *  refusal becomes words. */
  it("says when the read was refused, and what the refusal was", async () => {
    vi.spyOn(ipc, "collectionFolderList").mockRejectedValue("database is locked");
    vi.spyOn(ipc, "collectionFolderSummary").mockResolvedValue([]);
    draw({}, { skip: "collection" });

    expect(
      await screen.findByText(/Could not read your collection folders — database is locked/),
    ).toBeInTheDocument();
  });

  /** The card is `WidgetCard`'s, named by its heading, and the width it is drawn at is the
   *  stored document's rather than anything this widget decides. */
  it("draws inside a widget card at the stored span", () => {
    draw({ widget: { id: "folders", kind: "folders", span: 1, config: null } });

    expect(screen.getByRole("region", { name: "Folders" })).toBeInTheDocument();
  });
});
