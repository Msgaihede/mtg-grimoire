/**
 * The graph's half of `lib/ipc/wishlist.ts`: the wishlist's wishes, its totals and breakdowns,
 * its folders and their folder rules, and the optimise plan — what the home page's Summary,
 * Wishlist value, To review, Folders and Wishlist savings widgets read.
 *
 * The shapes the collection answers too (`BreakdownRow`, `ShelfCount`, `RuleConflicts`) are
 * `./collection.ts`'s, and so is the folder-scope spelling: `folderId` / `rootOnly` / neither,
 * translated here into `WishlistQuery`'s `folderId` / `flatten`.
 */
import { parseEntryTags } from "@/features/entryTags/entryTags";
import type { Finish } from "@/lib/finish";
import type {
  OptimizePrinting,
  WishlistFolder,
  WishlistFolderSummary,
  WishlistOptimizePlan,
  WishlistPage,
  WishlistQuery,
  WishlistSortKey,
  WishlistSummary,
  WishOptimizeMove,
  WishOwnedPlace,
  WishRow,
} from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import type { GraphQLContext } from "../builder";
import { builder, invalidatedBy, MarketplaceEnum, marketplaceOf } from "../builder";
import { filtersFromQuery } from "../filters";
import {
  BreakdownDimensionEnum,
  BreakdownRowRef,
  CollectionFolderRef,
  collectionFoldersOnce,
  pageOf,
  PAGE_DEFAULT,
  PAGE_MAX,
  RuleConflictsRef,
  ShelfCountRef,
} from "./collection";
import { FinishEnum } from "./enums";

/** The wishlist's folder list, read once per execution however many fields reach it. */
export function wishlistFoldersOnce(ctx: GraphQLContext): Promise<WishlistFolder[]> {
  return ctx.once("wishlistFolderList", () => ipc.wishlistFolderList());
}

function wishlistFolderSummariesOnce(
  ctx: GraphQLContext,
  marketplace: MarketplaceId,
): Promise<WishlistFolderSummary[]> {
  return ctx.once(`wishlistFolderSummary:${marketplace}`, () =>
    ipc.wishlistFolderSummary(marketplace),
  );
}

async function wishlistFolderOf(
  ctx: GraphQLContext,
  folderId: number | null,
): Promise<WishlistFolder | null> {
  if (folderId === null) return null;
  const folders = await wishlistFoldersOnce(ctx);
  return folders.find((f) => f.id === folderId) ?? null;
}

const WISHLIST_SORT_KEYS = [
  "name",
  "quantity",
  "cost",
  "price",
  "added",
] as const satisfies readonly WishlistSortKey[];

export const WishlistSortKeyEnum = builder.enumType("WishlistSortKey", {
  description:
    "What to order wishes by. `price` is one copy's price, `cost` is price × copies wanted, `added` is when the wish was last written.",
  values: WISHLIST_SORT_KEYS,
});

const marketplaceArg = builder.args((t) => ({
  marketplace: t.field({
    type: MarketplaceEnum,
    required: false,
    description: "The marketplace prices are quoted at. Defaults to the reader's.",
  }),
}));

export const WishlistFolderSummaryRef = builder
  .objectRef<WishlistFolderSummary>("WishlistFolderSummary")
  .implement({
    description:
      "What one wishlist folder holds **directly** — not counting the folders inside it.",
    fields: (t) => ({
      folderId: t.exposeInt("folderId"),
      wishes: t.exposeInt("wishes", { description: "Wishes filed directly in this folder." }),
      copies: t.exposeInt("copies", { description: "Copies those wishes want, summed." }),
      cost: t.exposeFloat("cost", {
        description:
          "What those copies cost at the marketplace, in its currency, as a decimal — over the wishes it prices. Read beside `unpriced`.",
      }),
      unpriced: t.exposeInt("unpriced", {
        description: "Wishes here the marketplace has no price for, and so left out of `cost`.",
      }),
    }),
  });

export const WishlistFolderRef = builder.objectRef<WishlistFolder>("WishlistFolder").implement({
  description:
    "One folder of the wishlist's filing tree. Flat: build the tree from `parentId`. A wish filed in no folder is at the root, which is not a folder.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    parentId: t.exposeInt("parentId", {
      nullable: true,
      description: "The folder this one sits inside, or null at the root.",
    }),
    name: t.exposeString("name"),
    sortOrder: t.exposeInt("sortOrder", {
      description: "Its position among its siblings, ascending.",
    }),
    managedDeckId: t.exposeInt("managedDeckId", {
      nullable: true,
      description:
        "The deck this folder is the managed wishlist of — kept by the app as what that deck's planned list still lacks, and not editable by hand. Null for a folder the reader made.",
    }),
    managedTokens: t.exposeBoolean("managedTokens", {
      description:
        "Whether this is a managed wishlist's `Tokens` sub-folder: the token printings that deck still lacks.",
    }),
    rules: t.expose("rules", {
      type: "JSON",
      description:
        "The folder's own folder rules (inherited ones are not repeated), as stored — `CollectionFolder.rules`' shape. `conditions` rules are ignored on the wishlist. `[]` for none.",
    }),
    summary: t.field({
      type: WishlistFolderSummaryRef,
      nullable: true,
      args: marketplaceArg,
      description:
        "What this folder holds directly, not counting its sub-folders. Null when the backend answered no row for it.",
      resolve: async (folder, args, ctx) => {
        const rows = await wishlistFolderSummariesOnce(ctx, marketplaceOf(args, ctx));
        return rows.find((r) => r.folderId === folder.id) ?? null;
      },
    }),
  }),
});

export const WishOwnedPlaceRef = builder.objectRef<WishOwnedPlace>("WishOwnedPlace").implement({
  description:
    "One collection folder's share of the copies the collection already holds of a wish's card.",
  fields: (t) => ({
    folderId: t.exposeInt("folderId", {
      nullable: true,
      description: "The collection folder, or null for copies filed in no folder.",
    }),
    folder: t.field({
      type: CollectionFolderRef,
      nullable: true,
      description: "The collection folder, or null at the root.",
      resolve: async (place, _args, ctx) => {
        if (place.folderId === null) return null;
        const folders = await collectionFoldersOnce(ctx);
        return folders.find((f) => f.id === place.folderId) ?? null;
      },
    }),
    exact: t.exposeInt("exact", { description: "Copies here of the printing the wish asks for." }),
    other: t.exposeInt("other", {
      description: "Copies here of other printings of the same card.",
    }),
    held: t.exposeBoolean("held", {
      description:
        "Whether the copies here are spoken for: the folder is a deck's, or locked (set aside). False at the root.",
    }),
  }),
});

export const WishRowRef = builder.objectRef<WishRow>("WishlistEntry").implement({
  description:
    "One wish: a card the reader wants, how many copies, and where it is filed. A wish pins one printing (`cardId`) or asks for any printing of the card (`cardId` null).",
  fields: (t) => ({
    id: t.exposeInt("id"),
    oracleId: t.exposeString("oracleId", {
      nullable: true,
      description: "The card's Scryfall oracle id.",
    }),
    cardId: t.exposeString("cardId", {
      nullable: true,
      description: "The pinned printing's Scryfall id, or null for any printing.",
    }),
    artCardId: t.exposeString("artCardId", {
      nullable: true,
      description:
        "The printing to draw the wish as — its own if pinned, else the card's newest printing. Never read as what the wish is for. Null when no printing is known.",
    }),
    folderId: t.exposeInt("folderId", {
      nullable: true,
      description: "The folder this wish is filed in, or null at the root of the wishlist.",
    }),
    folder: t.field({
      type: WishlistFolderRef,
      nullable: true,
      description: "The folder this wish is filed in, or null at the root.",
      resolve: (row, _args, ctx) => wishlistFolderOf(ctx, row.folderId),
    }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode", { nullable: true, description: "Null for any printing." }),
    collectorNumber: t.exposeString("collectorNumber", { nullable: true }),
    lang: t.exposeString("lang", { nullable: true }),
    rarity: t.exposeString("rarity", { nullable: true }),
    manaCost: t.exposeString("manaCost", {
      nullable: true,
      description: "In Scryfall's notation, e.g. `{2}{G}{G}`.",
    }),
    typeLine: t.exposeString("typeLine", { nullable: true }),
    layout: t.exposeString("layout", { nullable: true, description: "Scryfall's layout word." }),
    quantity: t.exposeInt("quantity", { description: "Copies wanted." }),
    preferredFinish: t.field({
      type: FinishEnum,
      nullable: true,
      description: "The finish the reader wants, or null for any.",
      resolve: (row) => row.preferredFinish as Finish | null,
    }),
    unitPrice: t.exposeFloat("unitPrice", {
      nullable: true,
      description:
        "The cheapest way to buy one copy at the marketplace, in its currency, as a decimal — at the preferred finish if one is named. Null when that marketplace has no price.",
    }),
    elsewhere: t.exposeInt("elsewhere", {
      description: "How many other wishes ask for the same card — a chance to buy it twice.",
    }),
    ownedExact: t.exposeInt("ownedExact", {
      description:
        "Copies the collection already holds of the printing this wish asks for (any printing, for an unpinned wish). Reported only: nothing subtracts it.",
    }),
    ownedOther: t.exposeInt("ownedOther", {
      description: "Copies the collection holds of other printings of the same card.",
    }),
    ownedPlaces: t.expose("ownedPlaces", {
      type: [WishOwnedPlaceRef],
      description: "Where those owned copies are filed, per collection folder.",
    }),
    entryTags: t.stringList({
      description:
        "The reader's entry tags on this wish — free text. Not Scryfall tags, deck labels or deck tags.",
      resolve: (row) => parseEntryTags(row.tags),
    }),
    entryNote: t.exposeString("notes", {
      nullable: true,
      description: "The reader's entry note on this wish — free text.",
    }),
    needsReview: t.exposeString("needsReview", {
      nullable: true,
      description: "A sentence saying why this wish needs the reader's attention, or null.",
    }),
    updatedAt: t.exposeFloat("updatedAt", {
      description: "When the wish was last written, in Unix seconds.",
    }),
  }),
});

export const WishlistPageRef = builder.objectRef<WishlistPage>("WishlistEntryPage").implement({
  description: "One page of wishes.",
  fields: (t) => ({
    items: t.expose("items", { type: [WishRowRef] }),
    total: t.exposeInt("total", { description: "Wishes matching, across every page." }),
  }),
});

export const WishlistSummaryRef = builder.objectRef<WishlistSummary>("WishlistSummary").implement({
  description: "The whole wishlist's totals, every folder and the root.",
  fields: (t) => ({
    wishes: t.exposeInt("wishes", { description: "Wishes (rows), not copies." }),
    copies: t.exposeInt("copies", { description: "Copies wanted, summed." }),
    cost: t.exposeFloat("cost", {
      description:
        "What those copies cost at the marketplace, in its currency, as a decimal — an any-printing wish at its cheapest printing, over the copies it prices. Read beside `unpriced`.",
    }),
    unpriced: t.exposeInt("unpriced", {
      description: "Copies the marketplace has no price for, and so left out of `cost`.",
    }),
  }),
});

export const OptimizePrintingRef = builder
  .objectRef<OptimizePrinting>("OptimizePrinting")
  .implement({
    description: "One printing in a wishlist optimise plan.",
    fields: (t) => ({
      cardId: t.exposeString("cardId", { description: "The printing's Scryfall id." }),
      setCode: t.exposeString("setCode"),
      collectorNumber: t.exposeString("collectorNumber"),
      lang: t.exposeString("lang"),
      price: t.exposeFloat("price", {
        nullable: true,
        description:
          "One copy at the wish's finish, at the marketplace, in its currency, as a decimal. Null when unpriced — only ever on the printing a wish is moving from.",
      }),
    }),
  });

export const WishOptimizeMoveRef = builder
  .objectRef<WishOptimizeMove>("WishOptimizeMove")
  .implement({
    description: "One pinned wish that a cheaper printing of the same card could answer.",
    fields: (t) => ({
      wishId: t.exposeInt("wishId"),
      name: t.exposeString("name"),
      quantity: t.exposeInt("quantity", { description: "Copies wanted." }),
      preferredFinish: t.expose("preferredFinish", { type: FinishEnum, nullable: true }),
      folderId: t.exposeInt("folderId", {
        nullable: true,
        description: "The wishlist folder the wish is filed in, or null at the root.",
      }),
      folder: t.field({
        type: WishlistFolderRef,
        nullable: true,
        resolve: (move, _args, ctx) => wishlistFolderOf(ctx, move.folderId),
      }),
      from: t.expose("from", { type: OptimizePrintingRef, description: "The printing now." }),
      to: t.expose("to", { type: OptimizePrintingRef, description: "The cheaper printing." }),
      savedPerCopy: t.exposeFloat("savedPerCopy", {
        nullable: true,
        description:
          "`from.price - to.price`, in the marketplace's currency. Null when `from` is unpriced.",
      }),
      saved: t.exposeFloat("saved", {
        nullable: true,
        description: "`savedPerCopy` × `quantity`. Null with it.",
      }),
      managed: t.exposeBoolean("managed", {
        description:
          "Whether the wish is in a deck's managed wishlist — informational only: its printing follows the deck.",
      }),
    }),
  });

export const WishlistOptimizePlanRef = builder
  .objectRef<WishlistOptimizePlan>("WishlistOptimizePlan")
  .implement({
    description:
      "What moving the wishes in scope to their cheapest priced printings would save. Nothing is written. `moves`, `alreadyCheapest` and `skipped` partition `considered`.",
    fields: (t) => ({
      moves: t.expose("moves", { type: [WishOptimizeMoveRef] }),
      considered: t.exposeInt("considered", { description: "Wishes looked at." }),
      alreadyCheapest: t.exposeInt("alreadyCheapest", {
        description: "Already on the cheapest priced printing, plus every any-printing wish.",
      }),
      skipped: t.exposeInt("skipped", {
        description:
          "Passed over: no card to compare against, or no printing priced at the wish's finish.",
      }),
    }),
  });

/** The folder scope and structural filters every filtered wishlist read takes. */
const wishlistScopeArgs = builder.args((t) => ({
  query: t.string({
    required: false,
    description:
      "A card search in Scryfall's syntax, as the app's search box takes it — e.g. `t:creature c:g otag:ramp`.",
  }),
  folderId: t.int({
    required: false,
    description:
      "Only the wishes filed directly in this folder — not in the folders inside it. Absent: every folder.",
  }),
  rootOnly: t.boolean({
    required: false,
    description: "Only the wishes filed in no folder. Ignored when `folderId` is given.",
  }),
  shelves: t.intList({
    required: false,
    description:
      "Only the wishes filed directly in these folders, `0` for the root. Replaces `folderId` and `rootOnly`.",
  }),
  needsReview: t.boolean({
    required: false,
    description: "`true`: only wishes needing review; `false`: only the others.",
  }),
  marketplace: t.field({
    type: MarketplaceEnum,
    required: false,
    description: "The marketplace prices are quoted at. Defaults to the reader's.",
  }),
}));

interface WishlistScopeArgs {
  query?: string | null;
  folderId?: number | null;
  rootOnly?: boolean | null;
  shelves?: readonly number[] | null;
  needsReview?: boolean | null;
  marketplace?: MarketplaceId | null;
}

async function wishlistQueryOf(
  args: WishlistScopeArgs,
  ctx: GraphQLContext,
  page: { limit: number; offset: number },
): Promise<WishlistQuery> {
  const query: WishlistQuery = {
    ...(await filtersFromQuery(args.query)),
    marketplace: marketplaceOf(args, ctx),
    ...page,
  };
  // `WishlistQuery` reads `folderId: null` as the root and needs `flatten` for "every folder".
  if (args.folderId != null) query.folderId = args.folderId;
  else if (args.rootOnly) query.folderId = null;
  else query.flatten = true;
  if (args.shelves) query.shelves = [...args.shelves];
  if (args.needsReview != null) query.needsReview = args.needsReview;
  return query;
}

builder.queryFields((t) => ({
  wishlistSummary: t.field({
    ...invalidatedBy("wishlist"),
    description: "The whole wishlist's totals — wishes, copies, cost. Takes no filters.",
    type: WishlistSummaryRef,
    args: marketplaceArg,
    resolve: (_root, args, ctx) => ipc.wishlistSummary(marketplaceOf(args, ctx)),
  }),
  wishlistEntries: t.field({
    // `ownedPlaces` moves with a collection write or a collection folder's lock.
    ...invalidatedBy("wishlist", "collection"),
    description:
      "The wishlist's wishes, one page at a time — every wish, or the ones the arguments narrow to. Name order unless `sort` says otherwise.",
    type: WishlistPageRef,
    args: {
      ...wishlistScopeArgs,
      sort: t.arg({ type: WishlistSortKeyEnum, required: false }),
      descending: t.arg.boolean({ required: false, description: "Reverse `sort`." }),
      limit: t.arg.int({
        required: false,
        description: `Wishes per page, ${PAGE_DEFAULT} by default and at most ${PAGE_MAX}.`,
      }),
      offset: t.arg.int({ required: false, description: "Wishes to skip. Default 0." }),
    },
    resolve: async (_root, args, ctx) => {
      const query = await wishlistQueryOf(args, ctx, pageOf(args));
      if (args.sort) query.sort = [{ key: args.sort, dir: args.descending ? "desc" : "asc" }];
      return ipc.wishlistList(query);
    },
  }),
  wishlistShelfCounts: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "Per-folder counts of the wishlist's wishes — one row per folder holding a wish the arguments match.",
    type: [ShelfCountRef],
    args: wishlistScopeArgs,
    resolve: async (_root, args, ctx) =>
      ipc.wishlistShelfCounts(await wishlistQueryOf(args, ctx, { limit: 0, offset: 0 })),
  }),
  wishlistBreakdown: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "The whole wishlist sliced along one dimension — copies and cost per bucket (`value` is the cost). Takes no filters.",
    type: [BreakdownRowRef],
    args: {
      dimension: t.arg({ type: BreakdownDimensionEnum, required: true }),
      ...marketplaceArg,
    },
    resolve: (_root, args, ctx) => ipc.wishlistBreakdown(args.dimension, marketplaceOf(args, ctx)),
  }),
  wishlistFolders: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "Every folder of the wishlist, flat — including the decks' managed wishlists. Build the tree from `parentId`.",
    type: [WishlistFolderRef],
    resolve: (_root, _args, ctx) => wishlistFoldersOnce(ctx),
  }),
  wishlistFolderSummaries: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "What each wishlist folder holds directly (not counting its sub-folders) — wishes, copies, cost.",
    type: [WishlistFolderSummaryRef],
    args: marketplaceArg,
    resolve: (_root, args, ctx) => wishlistFolderSummariesOnce(ctx, marketplaceOf(args, ctx)),
  }),
  wishlistRuleConflicts: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "Which wishes break a folder rule of the folder they are filed in, and how many per folder. A price rule is checked at the marketplace.",
    type: RuleConflictsRef,
    args: marketplaceArg,
    resolve: (_root, args, ctx) => ipc.wishlistRuleConflicts(marketplaceOf(args, ctx)),
  }),
  wishlistOptimizePlan: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "What re-pointing every pinned wish in scope to its cheapest priced printing would save, at the marketplace. Nothing is written. Every wish by default.",
    type: WishlistOptimizePlanRef,
    args: {
      ...wishlistScopeArgs,
      includeManaged: t.arg.boolean({
        required: false,
        description:
          "Include the decks' managed wishlists (their moves are marked `managed`). Default false.",
      }),
    },
    resolve: async (_root, args, ctx) =>
      ipc.wishlistOptimizePlan({
        ...(await wishlistQueryOf(args, ctx, { limit: 0, offset: 0 })),
        includeManaged: args.includeManaged ?? false,
      }),
  }),
}));
