import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollectionFolder,
  CollectionFolderSummary,
  CollectionQuery,
  CollectionSummary,
  HomeWidget,
  ScannerTrayRow,
  WishlistPage,
  WishlistQuery,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The six reads this body reaches, in front of an **intact** mirror, each typed against its own
 * signature — `NewPrintingsWidget.test.tsx`'s note.
 *
 * **The transport rather than the cache**, which is where this file parts from `DecksWidget`'s:
 * two of the six keys are `useCollectionFolders`' own and spelled nowhere this test may import
 * them from, and the question half the cases ask is *what the body asked* — a wishlist page of one
 * row, flattened and flagged; the collection with no filter at all. So every read is stubbed and
 * every assertion waits for the answer to land.
 */
const scannerTray = vi.hoisted(() => vi.fn<() => Promise<ScannerTrayRow[]>>());
const collectionSummary = vi.hoisted(() =>
  vi.fn<(query: CollectionQuery) => Promise<CollectionSummary>>(),
);
const wishlistList = vi.hoisted(() => vi.fn<(query: WishlistQuery) => Promise<WishlistPage>>());
const deckReviewCount = vi.hoisted(() => vi.fn<() => Promise<number>>());
const collectionFolderList = vi.hoisted(() => vi.fn<() => Promise<CollectionFolder[]>>());
const collectionFolderSummary = vi.hoisted(() =>
  vi.fn<(marketplace: MarketplaceId) => Promise<CollectionFolderSummary[]>>(),
);
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      scannerTray,
      collectionSummary,
      wishlistList,
      deckReviewCount,
      collectionFolderList,
      collectionFolderSummary,
    },
  };
});
/** The build's own answer, which only a module mock can reach — `ScannerPage.test.tsx:9`. */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { isWebTarget } from "@/pwa/target";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import {
  EMPTY,
  reviewRows,
  ToReviewWidget,
  trayCounts,
  WEB_DECK_HINT,
  type ReviewCounts,
} from "./ToReviewWidget";

const REMOVED_FOLDER = 9;

function trayRow(i: number, unresolved: boolean): ScannerTrayRow {
  return {
    key: `row-${i}`,
    cardId: `card-${i}`,
    oracleId: `oracle-${i}`,
    name: `Card ${i}`,
    setCode: "mh3",
    collectorNumber: String(100 + i),
    finish: "nonfoil",
    quantity: 1,
    choices: unresolved
      ? [
          {
            cardId: `alt-${i}`,
            oracleId: `oracle-${i}`,
            name: `Card ${i}`,
            setCode: "2x2",
            collectorNumber: "1",
          },
        ]
      : [],
    addedAt: 1_800_000_000_000 + i,
  };
}

function summary(needsReview: number): CollectionSummary {
  return {
    totalCards: 12,
    uniqueCards: 10,
    entries: 10,
    tradelistCards: 0,
    value: 40,
    unpriced: 0,
    needsReview,
  };
}

function folder(
  over: Partial<CollectionFolder> & { id: number; name: string; kind: string },
): CollectionFolder {
  return { parentId: null, deckId: null, sortOrder: 0, locked: false, syncUid: null, ...over };
}

/** A binder drawer, one deck's group, and the one holding area — the app's three folder kinds. */
const FOLDERS: CollectionFolder[] = [
  folder({ id: 1, name: "Binder", kind: "user" }),
  folder({ id: 4, name: "Burn", kind: "deck", deckId: 1 }),
  folder({ id: REMOVED_FOLDER, name: "Recently removed", kind: "removed" }),
];

interface World {
  scanned?: number;
  unresolved?: number;
  binder?: number;
  wishes?: number;
  deckCards?: number;
  removed?: number;
  folders?: CollectionFolder[];
}

/** Every read answering. `removed` copies are filed in the removed folder's summary row, and an
 *  empty folder answers no row at all — `CollectionFolderSummary`'s own rule. */
function world({
  scanned = 0,
  unresolved = 0,
  binder = 0,
  wishes = 0,
  deckCards = 0,
  removed = 0,
  folders = FOLDERS,
}: World = {}): void {
  scannerTray.mockResolvedValue(
    Array.from({ length: scanned }, (_, i) => trayRow(i, i < unresolved)),
  );
  collectionSummary.mockResolvedValue(summary(binder));
  wishlistList.mockResolvedValue({ items: [], total: wishes });
  deckReviewCount.mockResolvedValue(deckCards);
  collectionFolderList.mockResolvedValue(folders);
  collectionFolderSummary.mockResolvedValue(
    removed > 0 ? [{ folderId: REMOVED_FOLDER, cards: removed, value: null }] : [],
  );
}

const EVERYTHING: World = { scanned: 4, unresolved: 1, binder: 2, wishes: 1, deckCards: 3, removed: 5 };

function widget(config: unknown = null): HomeWidget {
  return { id: "toReview", kind: "toReview", x: 0, y: 0, w: 3, h: 6, config };
}

function fitFor(w: number, h: number, density: "comfortable" | "compact" = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density });
}

/** Room for all five rows, captioned, in one column. */
const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false, web }: { fit?: WidgetFit; still?: boolean; web?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <ToReviewWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
      web={web}
    />,
    { wrapper },
  );
}

/** The row names in drawn order. */
function drawnNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

/**
 * The writes a press makes, in the order it makes them — the half an end state cannot show, and
 * the half that matters: `setActiveView` clears every hand-off, so the view must come first.
 */
function recordWrites(): string[] {
  const writes: string[] = [];
  const real = useAppStore.getState();
  useAppStore.setState({
    setActiveView: (view) => {
      writes.push(`view:${view}`);
      real.setActiveView(view);
    },
    setPendingReviewFilter: (value) => {
      writes.push(`review:${value.scope}`);
      real.setPendingReviewFilter(value);
    },
    setPendingSettingsGroup: (group) => {
      writes.push(`group:${group}`);
      real.setPendingSettingsGroup(group);
    },
    setPendingFolder: (value) => {
      writes.push(`folder:${value.scope}:${value.id}`);
      real.setPendingFolder(value);
    },
  });
  return writes;
}

beforeEach(() => {
  for (const stub of [
    scannerTray,
    collectionSummary,
    wishlistList,
    deckReviewCount,
    collectionFolderList,
    collectionFolderSummary,
  ]) {
    stub.mockReset();
  }
  world();
  vi.mocked(isWebTarget).mockReturnValue(false);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("trayCounts", () => {
  it("counts every row, and the rows still waiting on a printing", () => {
    expect(trayCounts([trayRow(0, true), trayRow(1, false), trayRow(2, true)])).toEqual({
      scanned: 3,
      unresolved: 2,
    });
    expect(trayCounts([])).toEqual({ scanned: 0, unresolved: 0 });
  });
});

describe("reviewRows", () => {
  const ALL: ReviewCounts = {
    scanned: 4,
    unresolved: 1,
    binder: 2,
    wishes: 1,
    deckCards: 3,
    removed: 5,
    removedFolderId: REMOVED_FOLDER,
  };

  it("draws every row with a count, always in the same order", () => {
    expect(reviewRows(ALL, { web: false, removed: true }).map((r) => r.kind)).toEqual([
      "scanned",
      "binder",
      "wishes",
      "deckCards",
      "removed",
    ]);
  });

  it("leaves out a row whose count is zero", () => {
    expect(
      reviewRows({ ...ALL, binder: 0, wishes: 0 }, { web: false, removed: true }).map((r) => r.kind),
    ).toEqual(["scanned", "deckCards", "removed"]);
  });

  it("says what the scanned cards need, in the singular and the plural", () => {
    const one = reviewRows(ALL, { web: false, removed: true })[0];
    expect(one).toEqual(
      expect.objectContaining({
        name: "Scanned cards",
        caption: "1 needs a printing chosen",
        tileCaption: "4 · 1 to choose",
        value: "4",
      }),
    );
    expect(reviewRows({ ...ALL, unresolved: 3 }, { web: false, removed: true })[0].caption).toBe(
      "3 need a printing chosen",
    );
    const ready = reviewRows({ ...ALL, unresolved: 0 }, { web: false, removed: true })[0];
    expect([ready.caption, ready.tileCaption]).toEqual(["Ready to add", "4 ready"]);
  });

  /** Rows where the table counts rows, copies where the reader thinks in copies — and the
   *  removed row's caption is what says so, which is why it carries no second figure. */
  it("counts the removed folder in copies, in its caption", () => {
    const removed = reviewRows(ALL, { web: false, removed: true })[4];
    expect(removed).toEqual(
      expect.objectContaining({
        name: "Recently removed",
        caption: "5 copies",
        value: null,
        folderId: REMOVED_FOLDER,
      }),
    );
    expect(
      reviewRows({ ...ALL, removed: 1 }, { web: false, removed: true })[4].caption,
    ).toBe("1 copy");
  });

  it("leaves the removed row out when the reader switched it off, or there is no holding area", () => {
    expect(reviewRows(ALL, { web: false, removed: false }).map((r) => r.kind)).not.toContain(
      "removed",
    );
    expect(
      reviewRows({ ...ALL, removedFolderId: null }, { web: false, removed: true }).map((r) => r.kind),
    ).not.toContain("removed");
  });

  it("hides the scanner and disarms the deck cards on the browser build", () => {
    const rows = reviewRows(ALL, { web: true, removed: true });
    expect(rows.map((r) => r.kind)).toEqual(["binder", "wishes", "deckCards", "removed"]);
    const deckCards = rows.find((r) => r.kind === "deckCards");
    expect(deckCards?.pressable).toBe(false);
    expect(deckCards?.hint).toBe(WEB_DECK_HINT);
    expect(rows.filter((r) => r.kind !== "deckCards").every((r) => r.pressable)).toBe(true);
  });
});

describe("ToReviewWidget", () => {
  describe("what it draws", () => {
    it("draws a row per place with something waiting, in the fixed order", async () => {
      world(EVERYTHING);

      draw();

      expect(
        await screen.findByRole("button", { name: "Scanned cards · 1 needs a printing chosen · 4" }),
      ).toBeInTheDocument();
      expect(drawnNames()).toEqual([
        "Scanned cards",
        "Binder entries",
        "Wishes",
        "Deck cards",
        "Recently removed",
      ]);
      expect(
        screen.getByRole("button", { name: "Binder entries · Flagged for review · 2" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Wishes · Flagged for review · 1" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Deck cards · Flagged for review · 3" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Recently removed · 5 copies" })).toBeInTheDocument();
    });

    /** The questions the body asks: the whole collection, and a one-row page of flagged wishes. */
    it("asks the collection with no filter and the wishlist for one flagged row, flattened", async () => {
      world(EVERYTHING);

      draw();

      await screen.findByText("Binder entries");
      expect(collectionSummary).toHaveBeenCalledWith({
        limit: 0,
        offset: 0,
        marketplace: DEFAULT_MARKETPLACE,
      });
      expect(wishlistList).toHaveBeenCalledWith({
        needsReview: true,
        flatten: true,
        limit: 1,
        offset: 0,
      });
    });

    it("draws only the rows with a count", async () => {
      world({ binder: 2 });

      draw();

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(drawnNames()).toEqual(["Binder entries"]);
    });

    it("leaves Recently removed out when the reader switched it off", async () => {
      world({ removed: 5 });

      draw({ removed: false });

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    });

    it("draws no removed row in a database with no holding area", async () => {
      world({ removed: 5, folders: FOLDERS.slice(0, 2) });

      draw();

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    });

    it("moves each count under its name on a two-cell tile", async () => {
      world(EVERYTHING);

      draw(null, { fit: fitFor(2, 6) });

      expect(await screen.findByText("4 · 1 to choose")).toBeInTheDocument();
      expect(screen.getByText("2 flagged")).toBeInTheDocument();
      expect(screen.getByText("5 copies")).toBeInTheDocument();
      expect(screen.queryByText("Flagged for review")).toBeNull();
    });

    it("keeps the count and drops the caption on a compact card", async () => {
      world({ binder: 2, removed: 5 });

      draw(null, { fit: fitFor(3, 3, "compact") });

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByText("Flagged for review")).toBeNull();
      expect(screen.getByText("2")).toBeInTheDocument();
      // The removed row has no second figure, so its caption becomes the figure.
      expect(screen.getByText("5 copies")).toBeInTheDocument();
    });
  });

  describe("the states", () => {
    it("says it is looking while a read is out", () => {
      collectionSummary.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Looking for anything waiting on you…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      deckReviewCount.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not read what is waiting — The database is busy."),
      ).toBeInTheDocument();
    });

    it("says nothing is waiting when every count is zero", async () => {
      draw();

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
      expect(EMPTY).toBe("Nothing waiting for you.");
    });
  });

  describe("pressing a row", () => {
    it.each([
      ["Scanned cards", ["view:scanner"]],
      ["Binder entries", ["view:collection", "review:collection"]],
      ["Wishes", ["view:wishlist", "review:wishlist"]],
      ["Deck cards", ["view:settings", "group:sync"]],
      ["Recently removed", ["view:collection", `folder:collection:${REMOVED_FOLDER}`]],
    ])("%s opens its place, the view first", async (name, expected) => {
      const user = userEvent.setup();
      const writes = recordWrites();
      world(EVERYTHING);
      draw();

      await user.click(await screen.findByRole("button", { name: new RegExp(`^${name} · `) }));

      expect(writes).toEqual(expected);
    });

    /** The end state as well as the order: each hand-off survives the view change it rode in on. */
    it("leaves each hand-off in the store for the page to read", async () => {
      const user = userEvent.setup();
      world(EVERYTHING);
      draw();

      await user.click(await screen.findByRole("button", { name: /^Wishes · / }));
      expect(useAppStore.getState().activeView).toBe("wishlist");
      expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "wishlist" });

      await user.click(screen.getByRole("button", { name: /^Deck cards · / }));
      expect(useAppStore.getState().activeView).toBe("settings");
      expect(useAppStore.getState().pendingSettingsGroup).toBe("sync");
      // The previous hand-off went with the view change, which is what makes it one-shot.
      expect(useAppStore.getState().pendingReviewFilter).toBeNull();

      await user.click(screen.getByRole("button", { name: /^Recently removed · / }));
      expect(useAppStore.getState().pendingFolder).toEqual({
        scope: "collection",
        id: REMOVED_FOLDER,
      });
    });

    it("draws a still body with no presses", async () => {
      world(EVERYTHING);

      draw(null, { still: true });

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  describe("the browser build", () => {
    it("reads no tray and draws no scanner row", async () => {
      world(EVERYTHING);

      draw(null, { web: true });

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByText("Scanned cards")).toBeNull();
      expect(scannerTray).not.toHaveBeenCalled();
    });

    it("draws the deck cards without a press", async () => {
      world({ deckCards: 3 });

      draw(null, { web: true });

      expect(await screen.findByText("Deck cards")).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("says nothing is waiting when only the tray has rows", async () => {
      world({ scanned: 4 });

      draw(null, { web: true });

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    });

    /** The page never passes `web`, so the build's own answer is what decides there. */
    it("asks the build which target it is when nobody says", async () => {
      vi.mocked(isWebTarget).mockReturnValue(true);
      world(EVERYTHING);

      draw();

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByText("Scanned cards")).toBeNull();
    });
  });
});
