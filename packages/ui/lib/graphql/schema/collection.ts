/**
 * The graph's half of `lib/ipc/collection.ts`: the collection's entries, its totals and
 * breakdowns, its folders and their folder rules — what the home page's Summary, Collection value,
 * To review and Folders widgets read, and the binder itself, paged.
 *
 * The shapes the wishlist answers too — a breakdown bucket, a shelf count, rule conflicts — are
 * declared here, beside the `ipc` interface they mirror, and `./wishlist.ts` imports them.
 *
 * **Folder scope is one spelling on both lists.** `CollectionQuery` and `WishlistQuery` carry the
 * same three states with opposite polarity (`rootOnly` here, `flatten` there — the `ipc` docs have
 * why); the graph speaks only the collection's: `folderId` names a folder, `rootOnly` narrows to
 * the cards filed nowhere, and neither is every folder. `./wishlist.ts` translates.
 */
import type { BreakdownDimension } from "@/features/home/widgets";
import type { Condition } from "@/lib/conditions";
import type { Finish } from "@/lib/finish";
import { parseEntryTags } from "@/features/entryTags/entryTags";
import type {
  BreakdownRow,
  CollectionFolder,
  CollectionFolderSummary,
  CollectionPage,
  CollectionQuery,
  CollectionRow,
  CollectionSortKey,
  CollectionSummary,
  FolderConflicts,
  RuleConflicts,
  ShelfCount,
} from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import type { GraphQLContext } from "../builder";
import { builder, invalidatedBy, MarketplaceEnum, marketplaceOf } from "../builder";
import { filtersFromQuery } from "../filters";
import { ConditionEnum, FinishEnum } from "./enums";

/** The backend's page-size cap on `collection_list` and `wishlist_list`. */
export const PAGE_MAX = 500;
/** The page size a list field answers with when the document names none — the backend's own. */
export const PAGE_DEFAULT = 100;

/** A `limit`/`offset` pair as the two list commands take them: never negative, never past the cap. */
export function pageOf(args: { limit?: number | null; offset?: number | null }): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(PAGE_MAX, Math.max(1, args.limit ?? PAGE_DEFAULT));
  return { limit, offset: Math.max(0, args.offset ?? 0) };
}

/** `JSON.parse`, or `null` for a blank or unreadable column — a widget gets nothing rather than
 *  an error for one row's stored document. */
function parseJson(text: string | null): unknown {
  if (text === null || text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The collection's folder list, read once per execution however many fields reach it. */
export function collectionFoldersOnce(ctx: GraphQLContext): Promise<CollectionFolder[]> {
  return ctx.once("collectionFolderList", () => ipc.collectionFolderList());
}

function collectionFolderSummariesOnce(
  ctx: GraphQLContext,
  marketplace: MarketplaceId,
): Promise<CollectionFolderSummary[]> {
  return ctx.once(`collectionFolderSummary:${marketplace}`, () =>
    ipc.collectionFolderSummary(marketplace),
  );
}

const BREAKDOWN_DIMENSIONS = [
  "rarity",
  "color",
  "set",
  "finish",
] as const satisfies readonly BreakdownDimension[];

export const BreakdownDimensionEnum = builder.enumType("BreakdownDimension", {
  description:
    "One way to slice the collection or the wishlist: by `rarity`, by `color` (a colour bucket — `multi` for two or more colours, `c` for colourless), by `set`, or by `finish`.",
  values: BREAKDOWN_DIMENSIONS,
});

const COLLECTION_SORT_KEYS = [
  "name",
  "set",
  "finish",
  "quantity",
  "value",
  "price",
  "added",
] as const satisfies readonly CollectionSortKey[];

export const CollectionSortKeyEnum = builder.enumType("CollectionSortKey", {
  description:
    "What to order collection entries by. `price` is one copy's price, `value` is price × copies held, `added` is when the entry was last written.",
  values: COLLECTION_SORT_KEYS,
});

export const BreakdownRowRef = builder.objectRef<BreakdownRow>("BreakdownRow").implement({
  description:
    "One bucket of the whole collection or the whole wishlist, sliced along one `BreakdownDimension`. The buckets partition the list: summed, they are its total.",
  fields: (t) => ({
    key: t.exposeString("key", {
      description:
        "The bucket: a rarity, a colour bucket (`multi` and `c` included), a lowercase set code, or a finish — and on the wishlist's finish slice, `any` for wishes that name no finish.",
    }),
    name: t.exposeString("name", {
      nullable: true,
      description:
        "A readable name where the key is a code — the set's name beside its set code. Null for the other dimensions.",
    }),
    cards: t.exposeInt("cards", { description: "Copies in the bucket, not entries." }),
    value: t.exposeFloat("value", {
      nullable: true,
      description:
        "What the bucket's copies are worth at the marketplace, in its currency, as a decimal — summed over the copies it prices. Null when it prices none of them, which is not zero.",
    }),
  }),
});

export const ShelfCountRef = builder.objectRef<ShelfCount>("ShelfCount").implement({
  description:
    "One folder's counts within a filtered list — the heading of one shelf on the collection's or the wishlist's Shelves view. Only shelves holding something in scope have one.",
  fields: (t) => ({
    folderId: t.exposeInt("folderId", {
      description: "The folder, or `0` for the cards (or wishes) filed in no folder.",
    }),
    tiles: t.exposeInt("tiles", {
      description:
        "Tiles the shelf draws: on the collection one per printing and finish, on the wishlist one per wish.",
    }),
    copies: t.exposeInt("copies", { description: "Copies, summed over the shelf." }),
    value: t.exposeFloat("value", {
      nullable: true,
      description:
        "What the shelf is worth (collection) or costs (wishlist) at the marketplace, in its currency, as a decimal. Null when it prices nothing on the shelf.",
    }),
    unpriced: t.exposeInt("unpriced", {
      description:
        "What the marketplace could not price: copies on the collection, wishes on the wishlist.",
    }),
    peek: t.exposeStringList("peek", {
      description:
        "Up to four Scryfall card ids to draw as the shelf's thumbnails, by card name. Ignores the filters.",
    }),
  }),
});

export const FolderConflictsRef = builder.objectRef<FolderConflicts>("FolderConflicts").implement({
  description:
    "One folder holding entries that break its folder rules (its own or inherited) — counted in that folder alone, not the folders inside it.",
  fields: (t) => ({
    folderId: t.exposeInt("folderId"),
    entries: t.exposeInt("entries", {
      description: "Rule-breaking entries filed directly in this folder.",
    }),
    copies: t.exposeInt("copies", { description: "Copies, summed over those entries." }),
  }),
});

export const RuleConflictsRef = builder.objectRef<RuleConflicts>("RuleConflicts").implement({
  description:
    "Which entries break a folder rule of the folder they are filed in — a rule conflict. Folder rules are advisory: they never refuse a card, they outline the ones that do not match. A rule only breaks on a fact the app knows (an unpriced card passes a price rule).",
  fields: (t) => ({
    folders: t.expose("folders", { type: [FolderConflictsRef] }),
    ids: t.exposeIntList("ids", { description: "Every conflicting entry's id." }),
  }),
});

export const CollectionFolderSummaryRef = builder
  .objectRef<CollectionFolderSummary>("CollectionFolderSummary")
  .implement({
    description:
      "What one collection folder holds **directly** — not counting the folders inside it. A folder holding nothing directly has none.",
    fields: (t) => ({
      folderId: t.exposeInt("folderId"),
      cards: t.exposeInt("cards", { description: "Copies filed directly in this folder." }),
      value: t.exposeFloat("value", {
        nullable: true,
        description:
          "What those copies are worth at the marketplace, in its currency, as a decimal. Null when it prices none of them.",
      }),
    }),
  });

const marketplaceArg = builder.args((t) => ({
  marketplace: t.field({
    type: MarketplaceEnum,
    required: false,
    description: "The marketplace prices are quoted at. Defaults to the reader's.",
  }),
}));

export const CollectionFolderRef = builder
  .objectRef<CollectionFolder>("CollectionFolder")
  .implement({
    description:
      "One folder of the collection's filing tree. Flat: build the tree from `parentId`. A card filed in no folder is at the root, which is not a folder.",
    fields: (t) => ({
      id: t.exposeInt("id"),
      parentId: t.exposeInt("parentId", {
        nullable: true,
        description: "The folder this one sits inside, or null at the root.",
      }),
      name: t.exposeString("name"),
      kind: t.exposeString("kind", {
        description:
          "Whose folder it is: `user` (one the reader made), `deck` (the app's folder holding the copies a deck uses — see `deckId`) or `removed` (Recently removed: copies that left the collection but not the database).",
      }),
      deckId: t.exposeInt("deckId", {
        nullable: true,
        description: "The deck a `deck` folder stands for. Null for every other kind.",
      }),
      sortOrder: t.exposeInt("sortOrder", {
        description: "Its position among its siblings, ascending.",
      }),
      locked: t.exposeBoolean("locked", {
        description:
          "Whether the reader set this folder aside (cards held for a trade, a display case), so the app stops offering its cards to decks. The folder's own flag: a folder inside a locked folder is locked too, which this does not repeat.",
      }),
      rules: t.expose("rules", {
        type: "JSON",
        description:
          "The folder's own folder rules (inherited ones are not repeated) — criteria a card filed here is expected to meet, as stored: a list of `{ kind, … }` objects (`price`/`manaValue` with `min`/`max`, `colors`/`types`/`sets`/`rarities`/`finishes`/`conditions`/`borders` with `values`, `released` with `from`/`to`, and `group` with `op` (`and`/`or`) and nested `rules`). `[]` for none.",
      }),
      summary: t.field({
        type: CollectionFolderSummaryRef,
        nullable: true,
        args: marketplaceArg,
        description:
          "What this folder holds directly, not counting its sub-folders. Null when it holds nothing directly.",
        resolve: async (folder, args, ctx) => {
          const rows = await collectionFolderSummariesOnce(ctx, marketplaceOf(args, ctx));
          return rows.find((r) => r.folderId === folder.id) ?? null;
        },
      }),
    }),
  });

export const CollectionRowRef = builder.objectRef<CollectionRow>("CollectionEntry").implement({
  description:
    "One entry of the collection: a stack of identical copies — one printing, finish, condition and folder — and what the card database still knows about that printing. Card fields are null when the printing has left the card database; the copies are still the reader's.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    cardId: t.exposeString("cardId", { description: "The printing's Scryfall id." }),
    oracleId: t.exposeString("oracleId", {
      nullable: true,
      description:
        "The card's Scryfall oracle id. Null only when the printing has left the card database.",
    }),
    name: t.exposeString("name", { nullable: true }),
    folderId: t.exposeInt("folderId", {
      nullable: true,
      description: "The folder these copies are filed in, or null at the root of the collection.",
    }),
    folderName: t.exposeString("folderName", { nullable: true }),
    folder: t.field({
      type: CollectionFolderRef,
      nullable: true,
      description: "The folder these copies are filed in, or null at the root.",
      resolve: async (row, _args, ctx) => {
        if (row.folderId === null) return null;
        const folders = await collectionFoldersOnce(ctx);
        return folders.find((f) => f.id === row.folderId) ?? null;
      },
    }),
    setCode: t.exposeString("setCode", { description: "As recorded on the entry, lowercase." }),
    setName: t.exposeString("setName", { nullable: true }),
    collectorNumber: t.exposeString("collectorNumber"),
    lang: t.exposeString("lang", { description: "The printing's language code, e.g. `en`." }),
    rarity: t.exposeString("rarity", { nullable: true }),
    manaCost: t.exposeString("manaCost", {
      nullable: true,
      description: "In Scryfall's notation, e.g. `{2}{G}{G}`.",
    }),
    typeLine: t.exposeString("typeLine", { nullable: true }),
    layout: t.exposeString("layout", { nullable: true, description: "Scryfall's layout word." }),
    finish: t.field({ type: FinishEnum, resolve: (row) => row.finish as Finish }),
    condition: t.field({
      type: ConditionEnum,
      resolve: (row) => row.condition as Condition,
    }),
    quantity: t.exposeInt("quantity", { description: "Copies in this stack." }),
    tradelistQuantity: t.exposeInt("tradelistQuantity", {
      description: "How many of those copies the reader has marked for trade.",
    }),
    unitPrice: t.exposeFloat("unitPrice", {
      nullable: true,
      description:
        "One copy's price at this finish, at the marketplace, in its currency, as a decimal. Null when that marketplace has no price for it — never another marketplace's figure.",
    }),
    purchasePrice: t.exposeFloat("purchasePrice", {
      nullable: true,
      description: "What the reader paid per copy, as recorded, in `purchaseCurrency`.",
    }),
    purchaseCurrency: t.exposeString("purchaseCurrency", { nullable: true }),
    acquiredAt: t.exposeString("acquiredAt", {
      nullable: true,
      description: "When the reader got these copies, as recorded — usually an ISO 8601 date.",
    }),
    acquisitionSource: t.exposeString("acquisitionSource", {
      nullable: true,
      description: "Where the reader got them, in their own words.",
    }),
    serialNumber: t.exposeString("serialNumber", {
      nullable: true,
      description: "A serialised printing's number, e.g. `042/500`.",
    }),
    altered: t.exposeBoolean("altered"),
    signed: t.exposeBoolean("signed"),
    proxy: t.exposeBoolean("proxy"),
    misprint: t.exposeBoolean("misprint"),
    grading: t.field({
      type: "JSON",
      nullable: true,
      description: "A graded slab's details as stored — `{ company, grade, cert }` — or null.",
      resolve: (row) => parseJson(row.grading),
    }),
    entryTags: t.stringList({
      description:
        "The reader's entry tags on this stack — free text, shared by every copy in it. Not Scryfall tags, deck labels or deck tags.",
      resolve: (row) => parseEntryTags(row.tags),
    }),
    entryNote: t.exposeString("notes", {
      nullable: true,
      description: "The reader's entry note on this stack — free text.",
    }),
    needsReview: t.exposeString("needsReview", {
      nullable: true,
      description:
        "A sentence saying why this entry needs the reader's attention (its printing vanished from Scryfall, or a merge landed it), or null.",
    }),
    updatedAt: t.exposeFloat("updatedAt", {
      description: "When the entry was last written, in Unix seconds.",
    }),
  }),
});

export const CollectionPageRef = builder
  .objectRef<CollectionPage>("CollectionEntryPage")
  .implement({
    description: "One page of collection entries.",
    fields: (t) => ({
      items: t.expose("items", { type: [CollectionRowRef] }),
      total: t.exposeInt("total", { description: "Entries matching, across every page." }),
    }),
  });

export const CollectionSummaryRef = builder
  .objectRef<CollectionSummary>("CollectionSummary")
  .implement({
    description: "The collection's totals, over the same filters as the entries they caption.",
    fields: (t) => ({
      totalCards: t.exposeInt("totalCards", { description: "Copies, not entries." }),
      uniqueCards: t.exposeInt("uniqueCards", { description: "Distinct printings recorded." }),
      entries: t.exposeInt("entries", { description: "Entries (stacks)." }),
      tradelistCards: t.exposeInt("tradelistCards", { description: "Copies marked for trade." }),
      value: t.exposeFloat("value", {
        description:
          "What the copies are worth at the marketplace, in its currency, as a decimal — over the copies it prices. Read beside `unpriced`.",
      }),
      unpriced: t.exposeInt("unpriced", {
        description: "Copies the marketplace has no price for, and so left out of `value`.",
      }),
      needsReview: t.exposeInt("needsReview", {
        description: "Entries that need the reader's attention.",
      }),
    }),
  });

/** The folder scope and structural filters every filtered collection read takes. */
const collectionScopeArgs = builder.args((t) => ({
  query: t.string({
    required: false,
    description:
      "A card search in Scryfall's syntax, as the app's search box takes it — e.g. `t:creature c:g otag:ramp`.",
  }),
  folderId: t.int({
    required: false,
    description:
      "Only the copies filed directly in this folder — not in the folders inside it. Absent: every folder.",
  }),
  rootOnly: t.boolean({
    required: false,
    description: "Only the copies filed in no folder. Ignored when `folderId` is given.",
  }),
  excludeLocked: t.boolean({
    required: false,
    description:
      "Leave out the copies in locked (set-aside) folders and the folders inside them. Ignored when `folderId` is given.",
  }),
  needsReview: t.boolean({
    required: false,
    description: "`true`: only entries needing review; `false`: only the others.",
  }),
  ruleBreaks: t.boolean({
    required: false,
    description: "`true`: only entries that break a folder rule of their folder.",
  }),
  marketplace: t.field({
    type: MarketplaceEnum,
    required: false,
    description: "The marketplace prices are quoted at. Defaults to the reader's.",
  }),
}));

interface CollectionScopeArgs {
  query?: string | null;
  folderId?: number | null;
  rootOnly?: boolean | null;
  excludeLocked?: boolean | null;
  needsReview?: boolean | null;
  ruleBreaks?: boolean | null;
  marketplace?: MarketplaceId | null;
}

async function collectionQueryOf(
  args: CollectionScopeArgs,
  ctx: GraphQLContext,
  page: { limit: number; offset: number },
): Promise<CollectionQuery> {
  const query: CollectionQuery = {
    ...(await filtersFromQuery(args.query)),
    marketplace: marketplaceOf(args, ctx),
    ...page,
  };
  if (args.folderId != null) query.folderId = args.folderId;
  else if (args.rootOnly) query.rootOnly = true;
  if (args.excludeLocked) query.excludeLocked = true;
  if (args.needsReview != null) query.needsReview = args.needsReview;
  if (args.ruleBreaks) query.ruleBreaks = true;
  return query;
}

builder.queryFields((t) => ({
  collectionSummary: t.field({
    ...invalidatedBy("collection"),
    description:
      "The collection's totals — copies, entries, value — over every entry, or over the ones the arguments narrow to.",
    type: CollectionSummaryRef,
    args: collectionScopeArgs,
    resolve: async (_root, args, ctx) =>
      ipc.collectionSummary(await collectionQueryOf(args, ctx, { limit: 0, offset: 0 })),
  }),
  collectionEntries: t.field({
    ...invalidatedBy("collection"),
    description:
      "The collection's entries, one page at a time — every entry, or the ones the arguments narrow to. Name order unless `sort` says otherwise.",
    type: CollectionPageRef,
    args: {
      ...collectionScopeArgs,
      sort: t.arg({ type: CollectionSortKeyEnum, required: false }),
      descending: t.arg.boolean({ required: false, description: "Reverse `sort`." }),
      limit: t.arg.int({
        required: false,
        description: `Entries per page, ${PAGE_DEFAULT} by default and at most ${PAGE_MAX}.`,
      }),
      offset: t.arg.int({ required: false, description: "Entries to skip. Default 0." }),
    },
    resolve: async (_root, args, ctx) => {
      const query = await collectionQueryOf(args, ctx, pageOf(args));
      if (args.sort) query.sort = [{ key: args.sort, dir: args.descending ? "desc" : "asc" }];
      return ipc.collectionList(query);
    },
  }),
  collectionShelfCounts: t.field({
    ...invalidatedBy("collection"),
    description:
      "Per-folder counts of the collection's entries — one row per folder holding something the arguments match.",
    type: [ShelfCountRef],
    args: {
      ...collectionScopeArgs,
      shelves: t.arg.intList({
        required: false,
        description:
          "Count only these folders (direct members of each), `0` for the root. Replaces `folderId`, `rootOnly` and `excludeLocked`.",
      }),
    },
    resolve: async (_root, args, ctx) => {
      const query = await collectionQueryOf(args, ctx, { limit: 0, offset: 0 });
      if (args.shelves) query.shelves = [...args.shelves];
      return ipc.collectionShelfCounts(query);
    },
  }),
  collectionBreakdown: t.field({
    ...invalidatedBy("collection"),
    description:
      "The whole collection sliced along one dimension — copies and value per bucket. Takes no filters.",
    type: [BreakdownRowRef],
    args: {
      dimension: t.arg({ type: BreakdownDimensionEnum, required: true }),
      ...marketplaceArg,
    },
    resolve: (_root, args, ctx) =>
      ipc.collectionBreakdown(args.dimension, marketplaceOf(args, ctx)),
  }),
  collectionFolders: t.field({
    ...invalidatedBy("collection"),
    description:
      "Every folder of the collection, flat — including the app's own (each deck's folder, Recently removed). Build the tree from `parentId`.",
    type: [CollectionFolderRef],
    resolve: (_root, _args, ctx) => collectionFoldersOnce(ctx),
  }),
  collectionFolderSummaries: t.field({
    ...invalidatedBy("collection"),
    description:
      "What each collection folder holds directly (not counting its sub-folders), for every folder that holds something.",
    type: [CollectionFolderSummaryRef],
    args: marketplaceArg,
    resolve: (_root, args, ctx) => collectionFolderSummariesOnce(ctx, marketplaceOf(args, ctx)),
  }),
  collectionRuleConflicts: t.field({
    ...invalidatedBy("collection"),
    description:
      "Which collection entries break a folder rule of the folder they are filed in, and how many per folder. A price rule is checked at the marketplace.",
    type: RuleConflictsRef,
    args: marketplaceArg,
    resolve: (_root, args, ctx) => ipc.collectionRuleConflicts(marketplaceOf(args, ctx)),
  }),
}));
