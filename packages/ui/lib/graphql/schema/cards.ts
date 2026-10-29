/**
 * The graph's half of `lib/ipc/cards.ts`: the card corpus — search in Scryfall's syntax, one
 * printing in full, every printing of a card, prices per finish, the sets, and what the reader
 * holds of a card.
 *
 * Left out on purpose: the search page's facet counts (`facetCards`) and badge re-reads
 * (`searchMarks`), which are that page's plumbing; the image-cache warmers, which write; and
 * `cardImageUri`, a CDN address for a copy-to-clipboard press — a widget draws card art through
 * the app's `CardImage` component from a printing id, never from a URL.
 *
 * **A card's Oracle tags are an edge here** (`oracleTags` on {@link CardSummaryRef} and
 * {@link CardDetailRef}), batched per execution into one `oracleTagsForCards` read however many
 * cards a document reaches.
 */
import { parseFinishes } from "@/lib/finish";
import {
  ipc,
  type CardDetail,
  type CardFace,
  type CardHoldings,
  type CardSummary,
  type FinishPrices,
  type MeldRelation,
  type Printing,
  type PrintingPrices,
  type PrintingsResponse,
  type SearchRequest,
  type SearchResponse,
  type SearchSortKey,
  type SetSummary,
  type TcgplayerIds,
} from "@/lib/ipc";
import { cardTreatments } from "@/lib/treatment";
import type { GraphQLContext } from "../builder";
import { builder, invalidatedBy, marketplaceOf, MarketplaceEnum } from "../builder";
import { filtersFromQuery } from "../filters";
import { FinishEnum } from "./enums";

/** How every price in this file is written, for the descriptions that carry one. */
const MONEY =
  "In the marketplace's own currency, in whole units (2.18 is $2.18 or €2.18) — see `Query.marketplace` for which currency. Null when that marketplace quotes no price; never filled in from another marketplace.";

/** A JSON array of strings, as Scryfall's list columns are stored — `[]` for null or junk. */
function jsonStrings(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * One card's Oracle tags, read with every other card's in the same execution.
 *
 * Every `oracleTags` edge asked while graphql-js completes a list is queued synchronously, and the
 * queue is flushed once on the next microtask — so a page of 50 search rows is one
 * `oracleTagsForCards` call rather than 50. Answers are kept per execution, keyed by oracle id.
 */
interface TagBatch {
  known: Map<string, Promise<string[]>>;
  waiting: Map<string, { resolve: (slugs: string[]) => void; reject: (e: unknown) => void }>;
}

const tagBatches = new WeakMap<GraphQLContext, TagBatch>();

function flushTags(batch: TagBatch): void {
  const waiting = new Map(batch.waiting);
  batch.waiting.clear();
  ipc.oracleTagsForCards([...waiting.keys()]).then(
    (answers) => {
      const byId = new Map(answers.map((a) => [a.oracleId, a.slugs]));
      for (const [id, { resolve }] of waiting) resolve(byId.get(id) ?? []);
    },
    (e: unknown) => {
      for (const { reject } of waiting.values()) reject(e);
    },
  );
}

function oracleTagsOf(ctx: GraphQLContext, oracleId: string | null): Promise<string[]> {
  if (oracleId === null || oracleId === "") return Promise.resolve([]);
  let batch = tagBatches.get(ctx);
  if (!batch) {
    batch = { known: new Map(), waiting: new Map() };
    tagBatches.set(ctx, batch);
  }
  const known = batch.known.get(oracleId);
  if (known) return known;
  const queue = batch;
  const promise = new Promise<string[]>((resolve, reject) => {
    if (queue.waiting.size === 0) queueMicrotask(() => flushTags(queue));
    queue.waiting.set(oracleId, { resolve, reject });
  });
  queue.known.set(oracleId, promise);
  return promise;
}

const ORACLE_TAGS_DESCRIPTION =
  "The card's Scryfall Oracle tags — what the card does (`removal`, `ramp`, `card-advantage`) — as slugs, sorted, with every ancestor tag included. Empty for an untagged card and on a database that has never downloaded the Oracle tags (see `Query.oracleTagsStatus`). Not deck labels, deck tags or keyword abilities.";

const TREATMENTS_DESCRIPTION =
  "Named special treatments of this printing (`Surge Foil`, `Showcase`, `Serialized`), read from Scryfall's promo types. Empty for an ordinary printing.";

const FINISHES_DESCRIPTION =
  "The finishes this printing is published in. Empty when the corpus does not say.";

const CARD_ID_DESCRIPTION =
  "The printing's Scryfall id (a UUID). To draw its art, pass it to the app's `CardImage` component (through `cardImageUrl(id, face, variant)`); never build an image URL by hand.";

export const FinishPricesRef = builder.objectRef<FinishPrices>("FinishPrices").implement({
  description: `What one printing costs per finish (Near Mint), at one marketplace. ${MONEY}`,
  fields: (t) => ({
    nonfoil: t.exposeFloat("nonfoil", { nullable: true }),
    foil: t.exposeFloat("foil", { nullable: true }),
    etched: t.exposeFloat("etched", { nullable: true }),
  }),
});

export const PrintingPricesRef = builder.objectRef<PrintingPrices>("PrintingPrices").implement({
  description: "One printing's prices per finish, keyed by its id.",
  fields: (t) => ({
    cardId: t.exposeString("cardId", { description: "The printing's Scryfall id." }),
    finishPrices: t.expose("finishPrices", { type: FinishPricesRef }),
  }),
});

export const CardSummaryRef = builder.objectRef<CardSummary>("CardSummary").implement({
  description:
    "One card search result: a printing (or, with `onePerCard`, a card represented by its newest matching printing) with the columns a card grid needs.",
  fields: (t) => ({
    id: t.exposeString("id", { description: CARD_ID_DESCRIPTION }),
    oracleId: t.exposeString("oracleId", {
      nullable: true,
      description:
        "The oracle card this printing is of — shared by every printing of the same card.",
    }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode", { description: "Lowercase set code, e.g. `m21`." }),
    setName: t.exposeString("setName", { nullable: true }),
    collectorNumber: t.exposeString("collectorNumber"),
    rarity: t.exposeString("rarity", {
      nullable: true,
      description: "`common`, `uncommon`, `rare`, `mythic`, `special` or `bonus`.",
    }),
    typeLine: t.exposeString("typeLine", { nullable: true }),
    manaCost: t.exposeString("manaCost", {
      nullable: true,
      description: "In Scryfall's symbol notation, e.g. `{2}{R}{R}`.",
    }),
    layout: t.exposeString("layout", {
      description: "Scryfall's layout word: `normal`, `transform`, `modal_dfc`, `split`, `meld`, …",
    }),
    price: t.exposeFloat("price", {
      nullable: true,
      description: `This printing's price — nonfoil, falling back to foil, then etched. ${MONEY}`,
    }),
    priceLow: t.exposeFloat("priceLow", {
      nullable: true,
      description: `With \`onePerCard\`, the cheapest \`price\` among the printings this row stands for; otherwise equal to \`price\`. ${MONEY}`,
    }),
    priceHigh: t.exposeFloat("priceHigh", {
      nullable: true,
      description: `With \`onePerCard\`, the dearest \`price\` among the printings this row stands for; otherwise equal to \`price\`. ${MONEY}`,
    }),
    finishes: t.field({
      type: [FinishEnum],
      description: FINISHES_DESCRIPTION,
      resolve: (card) => parseFinishes(card.finishes),
    }),
    treatments: t.stringList({
      description: TREATMENTS_DESCRIPTION,
      resolve: (card) => cardTreatments(card.promoTypes).map((tr) => tr.label),
    }),
    gameChanger: t.exposeBoolean("gameChanger", {
      description: "One of the cards the Commander bracket system counts as a game changer.",
    }),
    releasedAt: t.exposeString("releasedAt", {
      nullable: true,
      description:
        "The printing's release date, `YYYY-MM-DD`. A date after today is a card not out yet.",
    }),
    imageUpdatedAt: t.exposeString("imageUpdatedAt", {
      nullable: true,
      description: "When Scryfall last replaced this printing's images, as an ISO 8601 timestamp.",
    }),
    ownedQuantity: t.exposeInt("ownedQuantity", {
      description:
        "Copies of this printing in the reader's collection, every finish and condition together. 0 when none.",
    }),
    wishlisted: t.exposeBoolean("wishlisted", {
      description:
        "Whether a wishlist entry covers this printing — pinned to it, or wishing for any printing of the card.",
    }),
    printings: t.exposeInt("printings", {
      description:
        "How many matching printings this row stands for: 1 unless the search was asked with `onePerCard`.",
    }),
    oracleTags: t.stringList({
      description: ORACLE_TAGS_DESCRIPTION,
      resolve: (card, _args, ctx) => oracleTagsOf(ctx, card.oracleId),
    }),
  }),
});

export const SearchResponseRef = builder.objectRef<SearchResponse>("CardSearchResult").implement({
  description: "One page of a card search, and how many cards matched in all.",
  fields: (t) => ({
    items: t.expose("items", { type: [CardSummaryRef] }),
    total: t.exposeInt("total", {
      description:
        "How many matched, counted no further than 5000 — read with `totalIsCapped`. With `onePerCard`, counts cards; otherwise printings.",
    }),
    totalIsCapped: t.exposeBoolean("totalIsCapped", {
      description: "The count stopped at its ceiling: there are `total` matches or more.",
    }),
  }),
});

export const CardFaceRef = builder.objectRef<CardFace>("CardFace").implement({
  description: "One physical side of a multi-faced card (transform, modal double-faced, split…).",
  fields: (t) => ({
    name: t.exposeString("name", { description: "Empty when the face carries no name." }),
    typeLine: t.exposeString("typeLine", { nullable: true }),
    oracleText: t.exposeString("oracleText", { nullable: true }),
    manaCost: t.exposeString("manaCost", {
      nullable: true,
      description: "In Scryfall's symbol notation. Null or empty means no cost.",
    }),
    artist: t.exposeString("artist", { nullable: true }),
  }),
});

interface Legality {
  format: string;
  status: string;
}

export const CardLegalityRef = builder.objectRef<Legality>("CardLegality").implement({
  description: "Whether a card may be played in one format.",
  fields: (t) => ({
    format: t.exposeString("format", {
      description: "Scryfall's format key: `standard`, `modern`, `commander`, `vintage`, …",
    }),
    status: t.exposeString("status", {
      description: "`legal`, `not_legal`, `restricted` or `banned`.",
    }),
  }),
});

function legalitiesOf(json: string | null): Legality[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    return Object.entries(parsed)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([format, status]) => ({ format, status }));
  } catch {
    return [];
  }
}

export const CardDetailRef = builder.objectRef<CardDetail>("CardDetail").implement({
  description: "Everything about one printing of a card, as the card detail pane shows it.",
  fields: (t) => ({
    id: t.exposeString("id", { description: CARD_ID_DESCRIPTION }),
    oracleId: t.exposeString("oracleId", {
      nullable: true,
      description:
        "The oracle card this printing is of — shared by every printing of the same card. Pass it to `cardPrintings` or `cardHoldings`.",
    }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode", { description: "Lowercase set code, e.g. `m21`." }),
    setName: t.exposeString("setName", { nullable: true }),
    collectorNumber: t.exposeString("collectorNumber"),
    rarity: t.exposeString("rarity", { nullable: true }),
    layout: t.exposeString("layout", { description: "Scryfall's layout word." }),
    lang: t.exposeString("lang", { description: "Scryfall's language code, e.g. `en`." }),
    manaCost: t.exposeString("manaCost", {
      nullable: true,
      description: "In Scryfall's symbol notation, e.g. `{2}{R}{R}`.",
    }),
    cmc: t.exposeFloat("cmc", {
      nullable: true,
      description: "Mana value. A Float because a few joke cards have half-mana costs.",
    }),
    typeLine: t.exposeString("typeLine", { nullable: true }),
    oracleText: t.exposeString("oracleText", { nullable: true }),
    illustrationId: t.exposeString("illustrationId", {
      nullable: true,
      description:
        "Scryfall's id for the artwork. Two printings differ in art exactly when this does.",
    }),
    artist: t.exposeString("artist", {
      nullable: true,
      description:
        "The illustrator. Scryfall's image policy asks for this credit wherever the art is shown.",
    }),
    releasedAt: t.exposeString("releasedAt", {
      nullable: true,
      description: "The printing's release date, `YYYY-MM-DD`.",
    }),
    legalities: t.field({
      type: [CardLegalityRef],
      description: "The card's standing in every format Scryfall tracks.",
      resolve: (card) => legalitiesOf(card.legalities),
    }),
    finishPrices: t.expose("finishPrices", {
      type: FinishPricesRef,
      description: "This printing's price per finish, at the marketplace `card` was asked at.",
    }),
    finishes: t.field({
      type: [FinishEnum],
      description: FINISHES_DESCRIPTION,
      resolve: (card) => parseFinishes(card.finishes),
    }),
    treatments: t.stringList({
      description: TREATMENTS_DESCRIPTION,
      resolve: (card) => cardTreatments(card.promoTypes).map((tr) => tr.label),
    }),
    imageStatus: t.exposeString("imageStatus", {
      nullable: true,
      description:
        "Scryfall's image quality word: `highres_scan`, `lowres`, `placeholder` or `missing`.",
    }),
    faces: t.expose("faces", {
      type: [CardFaceRef],
      description: "Each physical side, front first. Empty for a single-faced card.",
    }),
    oracleTags: t.stringList({
      description: ORACLE_TAGS_DESCRIPTION,
      resolve: (card, _args, ctx) => oracleTagsOf(ctx, card.oracleId),
    }),
  }),
});

export const PrintingRef = builder.objectRef<Printing>("Printing").implement({
  description: "One paper printing of a card, as the all-printings list shows it.",
  fields: (t) => ({
    id: t.exposeString("id", { description: CARD_ID_DESCRIPTION }),
    setCode: t.exposeString("setCode", { description: "Lowercase set code, e.g. `m21`." }),
    setName: t.exposeString("setName", { nullable: true }),
    collectorNumber: t.exposeString("collectorNumber"),
    releasedAt: t.exposeString("releasedAt", {
      nullable: true,
      description: "The printing's release date, `YYYY-MM-DD`.",
    }),
    rarity: t.exposeString("rarity", { nullable: true }),
    illustrationId: t.exposeString("illustrationId", {
      nullable: true,
      description:
        "Scryfall's id for the artwork. Two printings differ in art exactly when this does.",
    }),
    artist: t.exposeString("artist", { nullable: true }),
    lang: t.exposeString("lang", { description: "Scryfall's language code, e.g. `en`." }),
    finishes: t.field({
      type: [FinishEnum],
      description: FINISHES_DESCRIPTION,
      resolve: (p) => parseFinishes(p.finishes),
    }),
    finishPrices: t.expose("finishPrices", {
      type: FinishPricesRef,
      description:
        "This printing's price per finish, at the marketplace `cardPrintings` was asked at.",
    }),
    promo: t.exposeBoolean("promo", { description: "Scryfall marks this printing a promo." }),
    treatments: t.stringList({
      description: TREATMENTS_DESCRIPTION,
      resolve: (p) => cardTreatments(p.promoTypes).map((tr) => tr.label),
    }),
    fullArt: t.exposeBoolean("fullArt"),
    frameEffects: t.stringList({
      description: "Scryfall's frame effects: `showcase`, `extendedart`, `legendary`, …",
      resolve: (p) => jsonStrings(p.frameEffects),
    }),
    borderColor: t.exposeString("borderColor", {
      nullable: true,
      description: "`black`, `white`, `borderless`, `silver` or `gold`.",
    }),
    layout: t.exposeString("layout", { description: "Scryfall's layout word." }),
  }),
});

export const PrintingsResponseRef = builder
  .objectRef<PrintingsResponse>("PrintingsPage")
  .implement({
    description: "Every paper printing of one card, newest first, up to a limit.",
    fields: (t) => ({
      items: t.expose("items", { type: [PrintingRef] }),
      total: t.exposeInt("total", {
        description:
          "How many paper printings the card has in all. More than `items` holds when the list was cut at its limit.",
      }),
    }),
  });

export const MeldRelationRef = builder.objectRef<MeldRelation>("MeldRelation").implement({
  description:
    "Another card a meld card is part of: the card two halves meld into, or one of the halves a melded card is made from.",
  fields: (t) => ({
    id: t.exposeString("id", { description: CARD_ID_DESCRIPTION }),
    name: t.exposeString("name"),
    component: t.exposeString("component", {
      description: "`meld_part` (a half) or `meld_result` (the melded card).",
    }),
    artist: t.exposeString("artist", { nullable: true }),
  }),
});

export const CardHoldingsRef = builder.objectRef<CardHoldings>("CardHoldings").implement({
  description:
    "What the reader holds of one card, counted across every printing of it (the oracle card, not one piece of cardboard).",
  fields: (t) => ({
    owned: t.exposeInt("owned", {
      description: "Copies in the collection — every printing, finish and folder together.",
    }),
    wished: t.exposeInt("wished", {
      description: "Copies the wishlist asks for, every wishlist entry for the card together.",
    }),
    decks: t.exposeInt("decks", {
      description: "How many decks play the card (decks, not copies; built lists only).",
    }),
  }),
});

export const TcgplayerIdsRef = builder.objectRef<TcgplayerIds>("TcgplayerIds").implement({
  description:
    "TCGplayer's product ids for one printing. Both are null for a printing TCGplayer does not sell.",
  fields: (t) => ({
    productId: t.exposeInt("productId", {
      nullable: true,
      description: "The ordinary product, sold as Normal and Foil.",
    }),
    etchedProductId: t.exposeInt("etchedProductId", {
      nullable: true,
      description: "The etched-foil product, which TCGplayer lists separately.",
    }),
  }),
});

export const SetSummaryRef = builder.objectRef<SetSummary>("CardSet").implement({
  description: "One Magic set in the card corpus.",
  fields: (t) => ({
    code: t.exposeString("code", {
      description: "Lowercase set code, e.g. `m21` — what `s:` takes in a search query.",
    }),
    name: t.exposeString("name"),
    setType: t.exposeString("setType", {
      nullable: true,
      description: "Scryfall's set type: `expansion`, `core`, `masters`, `commander`, …",
    }),
    releasedAt: t.exposeString("releasedAt", {
      nullable: true,
      description: "The set's release date, `YYYY-MM-DD`.",
    }),
    cardCount: t.exposeInt("cardCount", {
      description: "Paper printings of this set in the local corpus. 0 for a digital-only set.",
    }),
  }),
});

const SEARCH_SORT_KEYS = [
  "name",
  "set",
  "type",
  "rarity",
  "price",
  "manaValue",
  "released",
  "imageUpdated",
] as const satisfies readonly SearchSortKey[];

export const CardSearchSortKeyEnum = builder.enumType("CardSearchSortKey", {
  description:
    "What a card search can be ordered by. `price` is at the marketplace the search was asked at; `released` is the printing's release date; `imageUpdated` when Scryfall last replaced its images.",
  values: SEARCH_SORT_KEYS,
});

export const CardSearchSortInput = builder.inputType("CardSearchSort", {
  description: "One ordering column of a card search.",
  fields: (t) => ({
    key: t.field({ type: CardSearchSortKeyEnum, required: true, description: "The column." }),
    descending: t.boolean({
      required: false,
      defaultValue: false,
      description: "Largest, latest or last-in-the-alphabet first.",
    }),
  }),
});

builder.queryFields((t) => ({
  searchCards: t.field({
    ...invalidatedBy("cards"),
    description:
      "Search every Magic card in the corpus (not only the reader's) with Scryfall's search syntax — the same search the app's Search page runs. Each row also says how many copies the reader owns and whether it is wishlisted.",
    type: SearchResponseRef,
    args: {
      query: t.arg.string({
        required: false,
        description:
          'A Scryfall-syntax query, e.g. `t:creature c:g cmc<=3 otag:ramp` or `!"Lightning Bolt"`. Supports names, `t:`, `o:`, `c:`/`id:`, `cmc`, `r:`, `s:`, `f:`, `kw:`, `otag:`/`atag:` (Scryfall tags), `or` and parentheses. Empty or absent matches every card. An unknown tag name is an error.',
      }),
      onePerCard: t.arg.boolean({
        required: false,
        defaultValue: false,
        description:
          "Fold every printing of a card into one row (its newest matching printing stands for it); `printings`, `priceLow` and `priceHigh` then span them.",
      }),
      owned: t.arg.boolean({
        required: false,
        description:
          "True: only printings in the reader's collection. False: only printings not in it. Absent: both.",
      }),
      paperOnly: t.arg.boolean({
        required: false,
        defaultValue: true,
        description: "Hide digital-only (Arena, MTGO) printings.",
      }),
      minPrice: t.arg.float({
        required: false,
        description:
          "Only printings priced at least this much at the marketplace, in its currency's whole units. Unpriced printings never match a bound.",
      }),
      maxPrice: t.arg.float({
        required: false,
        description: "Only printings priced at most this much at the marketplace.",
      }),
      sort: t.arg({
        type: [CardSearchSortInput],
        required: false,
        description:
          "Columns to order by, the first deciding and the rest breaking ties. Absent: relevance when there is free text, otherwise name.",
      }),
      limit: t.arg.int({
        required: false,
        defaultValue: 50,
        description: "Rows per page, at most 200.",
      }),
      offset: t.arg.int({ required: false, defaultValue: 0, description: "Rows to skip." }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: async (_root, args, ctx) => {
      const filters = await filtersFromQuery(args.query);
      const req: SearchRequest = {
        ...filters,
        marketplace: marketplaceOf(args, ctx),
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      };
      if (args.onePerCard) req.collapse = true;
      if (args.owned != null) req.owned = args.owned;
      if (args.paperOnly === false) req.paperOnly = false;
      if (args.minPrice != null) req.priceMin = args.minPrice;
      if (args.maxPrice != null) req.priceMax = args.maxPrice;
      if (args.sort) {
        req.sort = args.sort.map((s) => ({ key: s.key, dir: s.descending ? "desc" : "asc" }));
      }
      return ipc.searchCards(req);
    },
  }),

  card: t.field({
    ...invalidatedBy("card"),
    description:
      "One printing of a card in full — text, faces, legalities and prices per finish. Null when no printing has that id.",
    type: CardDetailRef,
    nullable: true,
    args: {
      id: t.arg.string({ required: true, description: "The printing's Scryfall id." }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx) => ipc.cardDetail(args.id, marketplaceOf(args, ctx)),
  }),

  cardPrintings: t.field({
    ...invalidatedBy("card"),
    description:
      "Every paper printing of one card (by its oracle id), newest first, each priced per finish.",
    type: PrintingsResponseRef,
    args: {
      oracleId: t.arg.string({
        required: true,
        description: "The oracle card — `oracleId` on `CardSummary` or `CardDetail`.",
      }),
      limit: t.arg.int({
        required: false,
        description: "At most this many printings (default 400, at most 1000).",
      }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx) =>
      ipc.cardPrintings(args.oracleId, marketplaceOf(args, ctx), args.limit ?? undefined),
  }),

  printingPrices: t.field({
    ...invalidatedBy("cards"),
    description:
      "Prices per finish for a set of printings, in one read. A printing id the corpus does not hold is left out of the answer; match rows by `cardId`.",
    type: [PrintingPricesRef],
    args: {
      cardIds: t.arg.stringList({ required: true, description: "Printing ids." }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx) => ipc.printingPrices(args.cardIds, marketplaceOf(args, ctx)),
  }),

  cardHoldings: t.field({
    ...invalidatedBy("card", "collection", "wishlist", "decks"),
    description:
      "How many copies of a card the reader owns, wants, and how many decks play it — every printing of the card together.",
    type: CardHoldingsRef,
    args: {
      oracleId: t.arg.string({
        required: true,
        description: "The oracle card — `oracleId` on `CardSummary` or `CardDetail`.",
      }),
    },
    resolve: (_root, args) => ipc.cardHoldings(args.oracleId),
  }),

  cardMeldParts: t.field({
    ...invalidatedBy("card"),
    description:
      "The cards a meld printing is part of. Empty for every card that is not a meld card.",
    type: [MeldRelationRef],
    args: {
      id: t.arg.string({ required: true, description: "The printing's Scryfall id." }),
    },
    resolve: (_root, args) => ipc.cardMeldParts(args.id),
  }),

  cardTcgplayerIds: t.field({
    ...invalidatedBy("card"),
    description:
      "TCGplayer's product ids for one printing, for a link to its product page. Both null when TCGplayer does not sell it.",
    type: TcgplayerIdsRef,
    args: {
      id: t.arg.string({ required: true, description: "The printing's Scryfall id." }),
    },
    resolve: (_root, args) => ipc.cardTcgplayerIds(args.id),
  }),

  sets: t.field({
    ...invalidatedBy("sets"),
    description: "Every Magic set in the card corpus, newest first.",
    type: [SetSummaryRef],
    resolve: () => ipc.listSets(),
  }),
}));
