import { describe, expect, it } from "vitest";

/**
 * **Every read the home page makes is a field of the read graph** — the prerequisite the graph
 * exists for: a widget a reader generates can show anything a hand-written one shows.
 *
 * The graph is Rust's (`crates/grimoire-graph`); its printout, `schema.graphql` beside it, is
 * held to that crate's code by its own golden test, so it is read here as text: the root fields
 * are the field lines of `type Query`. The census is the source text too — every `ipc.<name>`
 * the home feature and the hooks its widgets draw from reach is found by pattern, and must be
 * either a read {@link READS} maps to a root field that exists, or a call {@link WRITES} names.
 * A widget that learns a new read fails here, by name, until the graph can answer it too.
 */
const RUST_SDL = Object.values(
  import.meta.glob<string>("/crates/grimoire-graph/schema.graphql", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

/** The root fields: the lines of `type Query { … }` indented once — a field's description lines
 *  are quoted and its arguments, when they wrap, are indented twice. */
const ROOT_FIELDS: ReadonlySet<string> = (() => {
  const block = /^type Query \{\n([\s\S]*?)^\}/m.exec(RUST_SDL)?.[1] ?? "";
  return new Set([...block.matchAll(/^\t([A-Za-z]+)[(:]/gm)].map((m) => m[1]));
})();

describe("the read graph's root fields", () => {
  it("are read off the printout at all", () => {
    expect(ROOT_FIELDS.size).toBeGreaterThan(50);
    expect(ROOT_FIELDS.has("decks")).toBe(true);
  });
});

const HOME_SOURCES = import.meta.glob<string>(
  [
    "/packages/ui/features/home/**/*.{ts,tsx}",
    "!/packages/ui/features/home/**/*.{test,stories}.{ts,tsx}",
    // The hooks the widgets draw folders, marketplace and release notes from.
    "/packages/ui/features/collection/useCollectionFolders.ts",
    "/packages/ui/features/wishlist/useWishlistFolders.ts",
    "/packages/ui/lib/useMarketplace.ts",
    "/packages/ui/lib/useReleaseHistory.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** The read → the root field that answers it. */
const READS: Readonly<Record<string, string>> = {
  activityRecent: "activity",
  cardDetail: "card",
  collectionBreakdown: "collectionBreakdown",
  collectionFolderList: "collectionFolders",
  collectionFolderSummary: "collectionFolderSummaries",
  collectionRuleConflicts: "collectionRuleConflicts",
  collectionSummary: "collectionSummary",
  collectionValueHistory: "collectionValueHistory",
  deckCompletion: "deckCompletion",
  deckList: "decks",
  deckReviewCount: "deckCardsToReviewCount",
  deckValues: "deckValues",
  everyDeckTodoList: "deckTodoLists",
  getMarketplace: "marketplace",
  homeLayout: "homeLayout",
  newPrintings: "newPrintings",
  priceHistory: "priceHistory",
  priceMovers: "priceMovers",
  recentCards: "recentCards",
  scannerTray: "scannerTray",
  searchCards: "searchCards",
  setCompletion: "setCompletion",
  stickyNotes: "stickyNotes",
  upcomingSets: "upcomingSets",
  wishlistBreakdown: "wishlistBreakdown",
  wishlistFolderList: "wishlistFolders",
  wishlistFolderSummary: "wishlistFolderSummaries",
  wishlistList: "wishlistEntries",
  wishlistOptimizePlan: "wishlistOptimizePlan",
  wishlistRuleConflicts: "wishlistRuleConflicts",
  wishlistSummary: "wishlistSummary",
  wishlistValueHistory: "wishlistValueHistory",
};

/** Calls in those files that are not a read of the reader's data — never a field — and why. */
const WRITES: Readonly<Record<string, string>> = {
  collectionFolderCreate: "write",
  collectionFolderDelete: "write",
  collectionFolderMove: "write",
  collectionFolderRename: "write",
  collectionFolderReorder: "write",
  collectionFolderSetLocked: "write",
  collectionFolderSetRules: "write",
  collectionSetFolder: "write",
  collectionSetFolderMany: "write",
  deckTodoListUpdate: "write",
  deckUpdate: "write",
  markNewPrintingsSeen: "write",
  marketplaceFeedRefresh: "write (downloads a price feed)",
  setHomeLayout: "write",
  setMarketplace: "write",
  setPriceWatch: "write",
  stickyNoteCreate: "write",
  stickyNoteDelete: "write",
  stickyNoteReorder: "write",
  stickyNoteUpdate: "write",
  wishlistFolderClear: "write",
  wishlistFolderCreate: "write",
  wishlistFolderDelete: "write",
  wishlistFolderDeleteWithWishes: "write",
  wishlistFolderMove: "write",
  wishlistFolderRename: "write",
  wishlistFolderReorder: "write",
  wishlistFolderSetRules: "write",
  marketplaceFeedStatus:
    "a price feed's download state — what decides the host fallback `marketplace` already applies",
  onMarketplaceProgress: "an event subscription, not a read",
  updateHistory:
    "asks GitHub; `releaseNotes` answers from the notes bundled into the build, as the Change notes widget does",
};

describe("home widget coverage", () => {
  const found = new Set<string>();
  for (const text of Object.values(HOME_SOURCES)) {
    for (const m of text.matchAll(/\bipc\.([A-Za-z]+)\b/g)) found.add(m[1]);
  }

  it("finds the widgets' reads at all", () => {
    expect(found.size).toBeGreaterThan(20);
  });

  it("maps every read to a root field, and names every write", () => {
    const unaccounted = [...found].filter((name) => !(name in READS) && !(name in WRITES)).sort();
    expect(unaccounted).toEqual([]);
  });

  it("maps only to root fields that exist", () => {
    const dangling = Object.entries(READS)
      .filter(([, field]) => !ROOT_FIELDS.has(field))
      .map(([read, field]) => `${read} → ${field}`);
    expect(dangling).toEqual([]);
  });
});
