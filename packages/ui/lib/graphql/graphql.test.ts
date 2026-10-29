import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isNonNullType,
  isObjectType,
  isUnionType,
  type GraphQLField,
  type GraphQLNamedType,
} from "graphql";
import { ROOTS } from "./builder";
import { runQuery } from "./execute";
import { schema, schemaSDL } from "./schema";

const ROOT_FIELDS = schema.getQueryType()?.getFields() ?? {};

describe("the schema", () => {
  it("names the cache roots of every root field, and describes it", () => {
    const missing = Object.values(ROOT_FIELDS).flatMap((field) => {
      const roots = field.extensions[ROOTS] as readonly string[] | undefined;
      const problems: string[] = [];
      if (!roots || roots.length === 0) problems.push(`${field.name}: no invalidatedBy(…) roots`);
      if (!field.description) problems.push(`${field.name}: no description`);
      return problems;
    });
    expect(missing).toEqual([]);
  });

  it("describes every type a reader can meet", () => {
    const undescribed = Object.values(schema.getTypeMap())
      .filter(
        (t) =>
          !t.name.startsWith("__") && !["String", "Int", "Float", "Boolean", "ID"].includes(t.name),
      )
      .filter((t) => isObjectType(t) || isEnumType(t) || isUnionType(t) || isInputObjectType(t))
      .filter((t) => !t.description)
      .map((t) => t.name);
    expect(undescribed).toEqual([]);
  });

  it("is the reviewed SDL beside it", async () => {
    // `pnpm exec vitest run packages/ui/lib/graphql -u` writes it after an intended change.
    await expect(schemaSDL() + "\n").toMatchFileSnapshot("./schema.graphql");
  });
});

/**
 * **Every read the home page makes is a field of the graph** — the prerequisite this layer exists
 * for: a generated widget can show anything a hand-written one shows.
 *
 * The census is the source text, not a list somebody keeps: every `ipc.<name>` the home feature
 * and the hooks its widgets draw from reach is found by pattern, and must be either a read this
 * table maps to a root field that exists, or a write named in {@link WRITES}. A widget that
 * learns a new read fails here, by name, until the graph can answer it too.
 */
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
      .filter(([, field]) => !(field in ROOT_FIELDS))
      .map(([read, field]) => `${read} → ${field}`);
    expect(dangling).toEqual([]);
  });
});

/**
 * **Every field of the graph answers the fake backend's starter world without an error** — one
 * generated document per root field, selecting every field it can reach.
 *
 * This is what holds the graph's nullability to the data rather than to the interface's word for
 * it: a field declared non-null that the backend can answer `null` for is an error here, by path.
 * The fake is held to the real commands by `packages/fake/parity.test.ts`, which is what makes
 * its answers worth checking against.
 *
 * A path stops at {@link SELECT_DEPTH} and never re-enters a type it is already inside (a deck's
 * folder's decks), which keeps each document finite without hand-writing any of them. A required
 * argument is answered from {@link argValues} by name, or with an enum's first value.
 */
const SELECT_DEPTH = 4;

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function argsFor(
  field: GraphQLField<unknown, unknown>,
  values: Readonly<Record<string, unknown>>,
): string | null {
  const parts: string[] = [];
  for (const arg of field.args) {
    if (!isNonNullType(arg.type) || arg.defaultValue !== undefined) continue;
    const named = getNamedType(arg.type);
    if (arg.name in values) parts.push(`${arg.name}: ${literal(values[arg.name])}`);
    else if (isEnumType(named)) parts.push(`${arg.name}: ${named.getValues()[0].name}`);
    else return null;
  }
  return parts.length === 0 ? "" : `(${parts.join(", ")})`;
}

function selectionOf(
  type: GraphQLNamedType,
  inside: readonly string[],
  values: Readonly<Record<string, unknown>>,
  unanswerable: Set<string>,
): string | null {
  if (isUnionType(type) || isInterfaceType(type)) {
    const arms = schema
      .getPossibleTypes(type)
      .map((arm) => {
        const sel = selectionOf(arm, inside, values, unanswerable);
        return sel ? `... on ${arm.name} { ${sel} }` : null;
      })
      .filter((arm): arm is string => arm !== null);
    return ["__typename", ...arms].join(" ");
  }
  if (!isObjectType(type)) return null;
  const parts: string[] = [];
  for (const field of Object.values(type.getFields())) {
    const args = argsFor(field, values);
    if (args === null) {
      unanswerable.add(`${type.name}.${field.name}`);
      continue;
    }
    const named = getNamedType(field.type);
    if (isLeafType(named)) {
      parts.push(`${field.name}${args}`);
      continue;
    }
    if (inside.length >= SELECT_DEPTH || inside.includes(named.name)) continue;
    const sel = selectionOf(named, [...inside, named.name], values, unanswerable);
    if (sel) parts.push(`${field.name}${args} { ${sel} }`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

describe("against the fake backend", () => {
  it("answers every field of the graph without an error", async () => {
    installWorld({ seed: "starter" });
    const seed = await runQuery(
      { query: "{ decks { id } searchCards(limit: 1) { items { id oracleId } } }" },
      { marketplace: "tcgplayer" },
    );
    const data = seed.data as {
      decks: { id: number }[];
      searchCards: { items: { id: string; oracleId: string }[] };
    };
    const deckId = data.decks[0].id;
    const { id: cardId, oracleId } = data.searchCards.items[0];
    const argValues: Record<string, unknown> = {
      id: cardId,
      cardId,
      cardIds: [cardId],
      oracleId,
      oracleIds: [oracleId],
      deckId,
    };

    const unanswerable = new Set<string>();
    const failures: string[] = [];
    for (const field of Object.values(ROOT_FIELDS)) {
      // `deck(id: Int!)` takes a deck's id where every other `id` is a printing's.
      const values = field.name === "deck" ? { ...argValues, id: deckId } : argValues;
      const args = argsFor(field, values);
      if (args === null) {
        unanswerable.add(`Query.${field.name}`);
        continue;
      }
      const named = getNamedType(field.type);
      const sel = isLeafType(named)
        ? ""
        : ` { ${selectionOf(named, [named.name], values, unanswerable) ?? "__typename"} }`;
      const result = await runQuery(
        { query: `{ ${field.name}${args}${sel} }` },
        { marketplace: "tcgplayer" },
      );
      for (const e of result.errors ?? [])
        failures.push(`${e.path?.join(".") ?? field.name}: ${e.message}`);
      if (result.data?.[field.name] == null) failures.push(`${field.name}: answered null`);
    }
    expect(unanswerable).toEqual(new Set());
    expect(failures).toEqual([]);
  });
});
