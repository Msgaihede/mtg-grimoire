/**
 * The graph's half of `lib/ipc/home.ts`: the home page's own reads — its layout, the recently
 * viewed strip, set completion, price movers and one printing's price history, the collection's
 * and the wishlist's value over time, sticky notes, the new printings feed, deck completion, the
 * deck-card review count and the sets still to come.
 *
 * Every argument defaults to what the matching widget asks when nobody has configured it
 * (`features/home/widgets.ts` and each widget's read), so a bare `{ priceMovers { … } }` is the
 * question the Price movers widget asks out of the box.
 *
 * **Every money figure here is a decimal amount in the asked marketplace's currency**
 * (`marketplace { currency }` names it), and every instant is Unix **seconds** — the crate's
 * `unixepoch()`, never milliseconds.
 */
import { parseLayout } from "@/features/home/layout";
import type {
  DeckCompletion,
  DeckCompletionCompare,
  DeckCompletionMatch,
  HomeLayout,
  HomeWidget,
  NewPrinting,
  NewPrintingDeck,
  NewPrintings,
  PriceHistory,
  PriceMover,
  PriceMoverDirection,
  PriceMoverScope,
  PriceMovers,
  PricePoint,
  PriceMoverWindow,
  RecentCard,
  SetCompletion,
  StickyNote,
  UpcomingSet,
  UpcomingSets,
  ValueBucket,
  ValueHistory,
  ValuePoint,
  ValueSplit,
} from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import type { GraphQLContext } from "../builder";
import { builder, invalidatedBy, MarketplaceEnum, marketplaceOf } from "../builder";
import { DeckVariantEnum, FinishEnum } from "./enums";

// ── Enums ────────────────────────────────────────────────────────────────────────────────────

export const PriceMoverWindowEnum = builder.enumType("PriceMoverWindow", {
  description: "Which baseline price movers are measured against.",
  values: {
    DAYS_7: { value: "7d", description: "The snapshot from seven days ago." },
    DAYS_30: { value: "30d", description: "The snapshot from thirty days ago." },
    ALL: { value: "all", description: "The oldest snapshot kept." },
  } as const satisfies Record<string, { value: PriceMoverWindow; description: string }>,
});

const PRICE_MOVER_DIRECTIONS = [
  "both",
  "up",
  "down",
] as const satisfies readonly PriceMoverDirection[];

export const PriceMoverDirectionEnum = builder.enumType("PriceMoverDirection", {
  description:
    "Which way a mover went: `up` gainers, `down` losers, `both` the two together ranked by the size of the move.",
  values: PRICE_MOVER_DIRECTIONS,
});

const VALUE_SPLITS = ["total", "type", "color", "set"] as const satisfies readonly ValueSplit[];

export const ValueSplitEnum = builder.enumType("ValueSplit", {
  description:
    "How a value history is cut into lines: `total` is one line and no buckets; `type`, `color` and `set` put every copy in exactly one bucket, so a point's bucket values sum to its total.",
  values: VALUE_SPLITS,
});

const COMPARES = ["collection", "theory"] as const satisfies readonly DeckCompletionCompare[];

export const DeckCompletionCompareEnum = builder.enumType("DeckCompletionCompare", {
  description:
    "What deck completion measures. `collection`: every non-virtual deck's live list against the copies the collection files in that deck's own folder group. `theory`: every deck that keeps a theory list (virtual ones included), its live list against that plan.",
  values: COMPARES,
});

const MATCHES = ["exact", "missing"] as const satisfies readonly DeckCompletionMatch[];

export const DeckCompletionMatchEnum = builder.enumType("DeckCompletionMatch", {
  description:
    "How a planned copy is matched under `theory` (ignored under `collection`). `exact`: only the exact printing and finish counts. `missing`: any printing of the same card in the live list counts, so what is missing is what no printing in the deck covers.",
  values: MATCHES,
});

// ── Layout ───────────────────────────────────────────────────────────────────────────────────

export const HomeWidgetRef = builder.objectRef<HomeWidget>("HomeWidget").implement({
  description:
    "One tile on the home page and where it sits on the page's square-cell grid. Cell coordinates count from the top-left corner.",
  fields: (t) => ({
    id: t.exposeString("id", { description: "Stable across moves; unique within the layout." }),
    kind: t.exposeString("kind", {
      description:
        "Which widget this is, e.g. `summary`, `priceMovers`, `stickyNotes`. An open set: a layout written by a newer build may carry kinds this one does not know.",
    }),
    x: t.exposeInt("x", { description: "Column of the tile's left edge, in cells." }),
    y: t.exposeInt("y", { description: "Row of the tile's top edge, in cells." }),
    w: t.exposeInt("w", { description: "Width, in cells." }),
    h: t.exposeInt("h", { description: "Height, in cells." }),
    span: t.exposeInt("span", {
      nullable: true,
      description:
        "The legacy width (1 = one column, 2 = the whole row) kept for older builds. Use `w` instead.",
    }),
    config: t.field({
      type: "JSON",
      nullable: true,
      description:
        "The tile's own settings, as the widget stored them (keys depend on `kind`). `null` means every setting is at its default.",
      resolve: (widget) => widget.config ?? null,
    }),
  }),
});

export const HomeLayoutRef = builder.objectRef<HomeLayout>("HomeLayout").implement({
  description: "The whole home page: which tiles it shows and where.",
  fields: (t) => ({
    version: t.exposeInt("version", { description: "The layout document's version; `2` today." }),
    widgets: t.expose("widgets", {
      type: [HomeWidgetRef],
      description: "Every tile, in stored order. Empty when the reader removed them all.",
    }),
  }),
});

// ── Recently viewed, set completion ──────────────────────────────────────────────────────────

export const RecentCardRef = builder.objectRef<RecentCard>("RecentCard").implement({
  description: "A card this device opened recently.",
  fields: (t) => ({
    cardId: t.exposeString("cardId", { description: "The printing's Scryfall id." }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode"),
    viewedAt: t.exposeFloat("viewedAt", {
      description: "When it was last opened, in Unix seconds.",
    }),
  }),
});

export const SetCompletionRef = builder.objectRef<SetCompletion>("SetCompletion").implement({
  description: "How much of one set the collection holds.",
  fields: (t) => ({
    setCode: t.exposeString("setCode"),
    name: t.exposeString("name"),
    releasedAt: t.exposeString("releasedAt", {
      nullable: true,
      description: "Release date as `YYYY-MM-DD`, or null where Scryfall published none.",
    }),
    owned: t.exposeInt("owned", {
      description:
        "Distinct collector numbers the collection holds any copy of (any finish or language) within `1..size`; every collector number held when `size` is null.",
    }),
    size: t.exposeInt("size", {
      nullable: true,
      description: "The set's printed size, or null when unknown.",
    }),
  }),
});

// ── Prices ───────────────────────────────────────────────────────────────────────────────────

export const PriceMoverRef = builder.objectRef<PriceMover>("PriceMover").implement({
  description: "One printing (in one finish) whose price moved.",
  fields: (t) => ({
    cardId: t.exposeString("cardId", { description: "The printing's Scryfall id." }),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode"),
    setName: t.exposeString("setName", {
      nullable: true,
      description: "Null for a printing whose set has left the card data.",
    }),
    finish: t.expose("finish", { type: FinishEnum }),
    now: t.exposeFloat("now", { description: "Today's price." }),
    then: t.exposeFloat("then", { description: "The price in the baseline snapshot." }),
    delta: t.exposeFloat("delta", {
      description: "`now - then`, signed; never 0 (a printing that did not move is not a mover).",
    }),
  }),
});

export const PriceMoversRef = builder.objectRef<PriceMovers>("PriceMovers").implement({
  description:
    "The price movers and what they were measured against. An empty `movers` with `days` of 0 or 1 means there is no history yet, not that nothing moved.",
  fields: (t) => ({
    movers: t.expose("movers", {
      type: [PriceMoverRef],
      description: "Largest move first.",
    }),
    since: t.exposeFloat("since", {
      nullable: true,
      description:
        "The baseline snapshot actually used, in Unix seconds; null when no snapshot is old enough to compare against.",
    }),
    days: t.exposeInt("days", {
      description: "How many distinct days of price snapshots this marketplace holds.",
    }),
  }),
});

export const PricePointRef = builder.objectRef<PricePoint>("PricePoint").implement({
  description: "One day of one printing's price.",
  fields: (t) => ({
    day: t.exposeFloat("day", {
      description: "That day's UTC midnight, in Unix seconds.",
    }),
    price: t.exposeFloat("price"),
  }),
});

export const PriceHistoryRef = builder.objectRef<PriceHistory>("PriceHistory").implement({
  description:
    "One printing's daily price at one marketplace in one finish. Snapshots exist only for printings that are owned, wished for or watched by a Price movers widget.",
  fields: (t) => ({
    points: t.expose("points", {
      type: [PricePointRef],
      description: "One per day, oldest first, stopping before today.",
    }),
    now: t.exposeFloat("now", {
      nullable: true,
      description: "Today's live price; null when this marketplace has no price for it today.",
    }),
    today: t.exposeFloat("today", {
      description: "Today's UTC midnight according to the database, in Unix seconds.",
    }),
  }),
});

const PriceMoverScopeInput = builder.inputType("PriceMoverScopeInput", {
  description:
    "Narrows price movers to the printings named here instead of every owned printing. Folder ids are direct — a folder's subfolders are not included unless listed. A scope naming nothing answers no movers.",
  fields: (t) => ({
    collectionFolders: t.intList({
      required: false,
      description: "Collection folder ids; `0` is copies filed in no folder.",
    }),
    wishlistFolders: t.intList({
      required: false,
      description: "Wishlist folder ids; `0` is wishes filed in no folder.",
    }),
    cards: t.stringList({
      required: false,
      description:
        "Printing ids (Scryfall), owned or not, each measured in every finish it is priced in. A card only has history once it is owned, wished for or watched.",
    }),
  }),
});

// ── Value history ────────────────────────────────────────────────────────────────────────────

export const ValueBucketRef = builder.objectRef<ValueBucket>("ValueBucket").implement({
  description: "One line of a value history.",
  fields: (t) => ({
    key: t.exposeString("key", {
      description:
        "The bucket's word. `type`: lowercase card type (`creature` … `land`) or `other`. `color`: `W` `U` `B` `R` `G`, `c` (colorless) or `multi`. `set`: the set code, or `other`.",
    }),
    name: t.exposeString("name", {
      nullable: true,
      description: "The set's name under the `set` split; null otherwise.",
    }),
  }),
});

export const ValuePointRef = builder.objectRef<ValuePoint>("ValuePoint").implement({
  description: "One point of a value history.",
  fields: (t) => ({
    day: t.exposeFloat("day", {
      description:
        "The period's UTC midnight, in Unix seconds. Daily for recent history, weekly further back (a weekly point answers its latest day).",
    }),
    total: t.exposeFloat("total", {
      description: "Σ copies × price over the priced copies; an unpriced copy adds 0.",
    }),
    values: t.exposeFloatList("values", {
      description:
        "One value per bucket of the history, in the same order; empty under the `total` split.",
    }),
    moved: t.exposeFloat("moved", {
      nullable: true,
      description:
        "How much of `total - previous total` came from price changes alone; the rest is copies added or removed. Null on the first point.",
    }),
    live: t.exposeBoolean("live", {
      description: "True on the last point only: today's value, computed live.",
    }),
  }),
});

export const ValueHistoryRef = builder.objectRef<ValueHistory>("ValueHistory").implement({
  description:
    "A value over time: every kept snapshot period before today, oldest first, plus a live point for today. No points at all when there is nothing to value.",
  fields: (t) => ({
    buckets: t.expose("buckets", {
      type: [ValueBucketRef],
      description:
        "The lines the split cuts the value into; empty for `total`. At most eight named buckets plus `other` for `type` and `set`.",
    }),
    points: t.expose("points", { type: [ValuePointRef] }),
    today: t.exposeFloat("today", {
      description: "Today's UTC midnight according to the database, in Unix seconds.",
    }),
  }),
});

// ── Sticky notes ─────────────────────────────────────────────────────────────────────────────

export const StickyNoteRef = builder.objectRef<StickyNote>("StickyNote").implement({
  description:
    "One of the reader's sticky notes on the home page — free prose attached to no deck and no card (not a deck note).",
  fields: (t) => ({
    id: t.exposeInt("id"),
    title: t.exposeString("title", {
      description: "May be empty; the app then derives a heading from the body.",
    }),
    body: t.exposeString("body", { description: "The note's text, as CommonMark Markdown." }),
    color: t.exposeString("color", {
      description:
        "The note's colour word. Open-ended: a word the app does not know is drawn as `slate`.",
    }),
    pinned: t.exposeBoolean("pinned"),
    sortOrder: t.exposeInt("sortOrder", {
      description: "The reader's own arrangement, ascending.",
    }),
    createdAt: t.exposeFloat("createdAt", { description: "Unix seconds." }),
    updatedAt: t.exposeFloat("updatedAt", { description: "Unix seconds." }),
  }),
});

// ── New printings ────────────────────────────────────────────────────────────────────────────

/** A JSON array of strings stored as text, read leniently: anything else is `null`. */
function stringList(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

export const NewPrintingDeckRef = builder.objectRef<NewPrintingDeck>("NewPrintingDeck").implement({
  description: "A deck holding the card a new printing reprints.",
  fields: (t) => ({
    deckId: t.exposeInt("deckId"),
    name: t.exposeString("name"),
    quantity: t.exposeInt("quantity", {
      description: "Copies across the deck's categories, live and theory summed.",
    }),
    variant: t.expose("variant", {
      type: DeckVariantEnum,
      description: "`live` if the live list holds it at all, else `theory`.",
    }),
    virtualOnly: t.exposeBoolean("virtualOnly", {
      description: "Whether the deck is virtual (not built from owned copies).",
    }),
  }),
});

export const NewPrintingRef = builder.objectRef<NewPrinting>("NewPrinting").implement({
  description: "A recently released printing of a card the watched decks already hold.",
  fields: (t) => ({
    printingId: t.exposeString("printingId", { description: "The printing's Scryfall id." }),
    oracleId: t.exposeString("oracleId"),
    name: t.exposeString("name"),
    setCode: t.exposeString("setCode"),
    setName: t.exposeString("setName", { nullable: true }),
    collectorNumber: t.exposeString("collectorNumber"),
    releasedAt: t.exposeString("releasedAt", { description: "Release date, `YYYY-MM-DD`." }),
    rarity: t.exposeString("rarity", { nullable: true }),
    promoTypes: t.stringList({
      nullable: true,
      description: "Scryfall's `promo_types` for the printing, e.g. `showcase`, `borderless`.",
      resolve: (printing) => stringList(printing.promoTypes),
    }),
    finishes: t.stringList({
      nullable: true,
      description: "The finishes the printing exists in: `nonfoil`, `foil`, `etched`.",
      resolve: (printing) => stringList(printing.finishes),
    }),
    lang: t.exposeString("lang", { description: "The printing's language code, e.g. `en`." }),
    decks: t.field({
      type: [NewPrintingDeckRef],
      description: "The decks holding the card.",
      resolve: (printing) => [...printing.decks],
    }),
  }),
});

export const NewPrintingsRef = builder.objectRef<NewPrintings>("NewPrintings").implement({
  description:
    "Recent reprints of cards in the watched decks, newest first, and the facts that tell an empty feed's three causes apart (no deck watched, nothing reprinted, card data too short).",
  fields: (t) => ({
    printings: t.field({
      type: [NewPrintingRef],
      resolve: (feed) => [...feed.printings],
    }),
    decksWatched: t.exposeInt("decksWatched", {
      description: "How many decks the scope resolved to; 0 is a real answer.",
    }),
    since: t.exposeString("since", { description: "The window's far edge, `YYYY-MM-DD`." }),
    oldest: t.exposeString("oldest", {
      nullable: true,
      description: "The oldest release date in the answer, `YYYY-MM-DD`; null when empty.",
    }),
    seenAt: t.exposeFloat("seenAt", {
      nullable: true,
      description:
        "When this device last saw a non-empty feed, in Unix seconds; null for never. A printing released after it is unseen.",
    }),
  }),
});

// ── Deck completion ──────────────────────────────────────────────────────────────────────────

export const DeckCompletionRef = builder.objectRef<DeckCompletion>("DeckCompletion").implement({
  description:
    "How far one deck is along, counted exactly as the deck editor counts: every active pile (sideboard and companion included), a copy matching on exact printing and finish.",
  fields: (t) => ({
    deckId: t.exposeInt("deckId"),
    list: t.expose("list", {
      type: DeckVariantEnum,
      description:
        "Which list the figures are a fraction of: `live` under `collection`, `theory` under `theory`.",
    }),
    wanted: t.exposeInt("wanted", { description: "Copies the measured list asks for." }),
    owned: t.exposeInt("owned", {
      description: "Of those, copies already covered. Never more than `wanted`.",
    }),
    missing: t.exposeInt("missing", { description: "`wanted - owned`; never negative." }),
    missingCost: t.exposeFloat("missingCost", {
      nullable: true,
      description:
        "What the missing copies cost. Null when nothing in the list is priced at this marketplace (draw a dash, not 0).",
    }),
    unpricedMissing: t.exposeInt("unpricedMissing", {
      description: "Missing copies this marketplace has no price for, left out of `missingCost`.",
    }),
  }),
});

// ── Upcoming sets ────────────────────────────────────────────────────────────────────────────

export const UpcomingSetRef = builder.objectRef<UpcomingSet>("UpcomingSet").implement({
  description: "A set with paper printings still to be released.",
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    releasedAt: t.exposeString("releasedAt", {
      description: "The set's earliest card date in the window, `YYYY-MM-DD`.",
    }),
    previewed: t.exposeInt("previewed", {
      description: "Cards previewed so far (one per card, whatever its printings).",
    }),
    inDecks: t.exposeInt("inDecks", {
      description:
        "Distinct cards in it that the reader's non-virtual decks hold (live or theory), basic lands left out.",
    }),
  }),
});

export const UpcomingSetsRef = builder.objectRef<UpcomingSets>("UpcomingSets").implement({
  description: "The sets still to come, and the day they were counted from.",
  fields: (t) => ({
    today: t.exposeString("today", {
      description: "Today's date according to the database (UTC), `YYYY-MM-DD`.",
    }),
    sets: t.expose("sets", { type: [UpcomingSetRef], description: "Soonest first, then by code." }),
  }),
});

// ── Root fields ──────────────────────────────────────────────────────────────────────────────

builder.queryFields((t) => ({
  homeLayout: t.field({
    // `useHomeLayout`'s `HOME_LAYOUT_KEY`; `crossWindow.ts` follows it across windows.
    ...invalidatedBy("homeLayout"),
    description:
      "The home page's tiles and where they sit. A version-1 document's tiles are placed on the grid as the page places them.",
    type: HomeLayoutRef,
    resolve: async () => parseLayout(await ipc.homeLayout()),
  }),
  recentCards: t.field({
    ...invalidatedBy("recentCards"),
    description: "The cards this device opened most recently, newest first.",
    type: [RecentCardRef],
    args: {
      limit: t.arg.int({
        required: false,
        defaultValue: 8,
        description: "At most this many, clamped to 1–24.",
      }),
    },
    resolve: (_root, { limit }) => ipc.recentCards(limit ?? 8),
  }),
  setCompletion: t.field({
    ...invalidatedBy("collection"),
    description: "Every set the collection holds a card from, with how much of it is owned.",
    type: [SetCompletionRef],
    resolve: () => ipc.setCompletion(),
  }),
  priceMovers: t.field({
    // A scope can name wishlist folders, whose writes the app's own reader leaves to the next read.
    ...invalidatedBy("collection", "wishlist"),
    description:
      "The owned printings whose price moved most since the window's baseline snapshot, largest move first — or, given a `scope`, the printings it names.",
    type: PriceMoversRef,
    args: {
      window: t.arg({ type: PriceMoverWindowEnum, required: false, defaultValue: "7d" }),
      direction: t.arg({ type: PriceMoverDirectionEnum, required: false, defaultValue: "both" }),
      limit: t.arg.int({
        required: false,
        defaultValue: 100,
        description: "At most this many movers, clamped to 1–100.",
      }),
      scope: t.arg({
        type: PriceMoverScopeInput,
        required: false,
        description: "Absent for every owned printing.",
      }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx: GraphQLContext) => {
      const market = marketplaceOf(args, ctx);
      const window = args.window ?? "7d";
      const direction = args.direction ?? "both";
      const limit = args.limit ?? 100;
      if (args.scope == null) return ipc.priceMovers(window, direction, market, limit);
      const scope: PriceMoverScope = {
        collectionFolders: args.scope.collectionFolders ?? [],
        wishlistFolders: args.scope.wishlistFolders ?? [],
        cards: args.scope.cards ?? [],
      };
      return ipc.priceMovers(window, direction, market, limit, scope);
    },
  }),
  priceHistory: t.field({
    ...invalidatedBy("collection"),
    description: "One printing's daily price in one finish, before today, beside today's price.",
    type: PriceHistoryRef,
    args: {
      cardId: t.arg.string({ required: true, description: "The printing's Scryfall id." }),
      finish: t.arg({ type: FinishEnum, required: false, defaultValue: "nonfoil" }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx: GraphQLContext) =>
      ipc.priceHistory(args.cardId, args.finish ?? "nonfoil", marketplaceOf(args, ctx)),
  }),
  collectionValueHistory: t.field({
    ...invalidatedBy("collection"),
    description: "The collection's value over time, cut by `split`.",
    type: ValueHistoryRef,
    args: {
      split: t.arg({ type: ValueSplitEnum, required: false, defaultValue: "type" }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx: GraphQLContext) =>
      ipc.collectionValueHistory(args.split ?? "type", marketplaceOf(args, ctx)),
  }),
  wishlistValueHistory: t.field({
    ...invalidatedBy("wishlist"),
    description:
      "The wishlist's value (what the wishes would cost) over time, cut by `split`. A step not explained by `moved` is wishes added, bought or removed.",
    type: ValueHistoryRef,
    args: {
      split: t.arg({ type: ValueSplitEnum, required: false, defaultValue: "type" }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx: GraphQLContext) =>
      ipc.wishlistValueHistory(args.split ?? "type", marketplaceOf(args, ctx)),
  }),
  stickyNotes: t.field({
    ...invalidatedBy("stickyNotes"),
    description: "Every sticky note, in the reader's arrangement.",
    type: [StickyNoteRef],
    resolve: () => ipc.stickyNotes(),
  }),
  newPrintings: t.field({
    // Its own root, which the sync names; a deck write changes which cards are watched as well.
    ...invalidatedBy("newPrintings", "decks"),
    description: "Recent reprints of cards the watched decks hold, newest first.",
    type: NewPrintingsRef,
    args: {
      deckIds: t.arg.intList({
        required: false,
        description: "Watch only these decks. Absent watches every deck.",
      }),
      days: t.arg.int({
        required: false,
        defaultValue: 90,
        description: "How far back to look, in days, clamped to 1–365.",
      }),
      langs: t.arg.stringList({
        required: false,
        defaultValue: ["en"],
        description:
          "Language codes to answer in; an empty list is every language (one row per language of a reprint).",
      }),
      includeVirtual: t.arg.boolean({
        required: false,
        defaultValue: false,
        description: "Watch virtual decks too.",
      }),
      includeTheory: t.arg.boolean({
        required: false,
        defaultValue: true,
        description: "Count cards that are only on a deck's theory list.",
      }),
      includeBasics: t.arg.boolean({
        required: false,
        defaultValue: false,
        description: "Include basic lands.",
      }),
      limit: t.arg.int({
        required: false,
        defaultValue: 100,
        description: "At most this many printings, clamped to 1–100.",
      }),
    },
    resolve: (_root, args) =>
      ipc.newPrintings(
        args.deckIds == null ? "all" : "chosen",
        args.deckIds ?? [],
        args.days ?? 90,
        args.langs ?? ["en"],
        args.includeVirtual ?? false,
        args.includeTheory ?? true,
        args.includeBasics ?? false,
        args.limit ?? 100,
      ),
  }),
  deckCompletion: t.field({
    // Owned copies are collection rows: a binder write moves the answer with no deck write.
    ...invalidatedBy("decks", "collection"),
    description:
      "How far every deck the comparison applies to is along (archived decks included), one row per deck. Join on `deckId` for the deck's name.",
    type: [DeckCompletionRef],
    args: {
      compare: t.arg({
        type: DeckCompletionCompareEnum,
        required: false,
        defaultValue: "collection",
      }),
      theoryMatch: t.arg({ type: DeckCompletionMatchEnum, required: false, defaultValue: "exact" }),
      marketplace: t.arg({ type: MarketplaceEnum, required: false }),
    },
    resolve: (_root, args, ctx: GraphQLContext) =>
      ipc.deckCompletion(
        marketplaceOf(args, ctx),
        args.compare ?? "collection",
        args.theoryMatch ?? "exact",
      ),
  }),
  deckCardsToReviewCount: t.field({
    ...invalidatedBy("decks"),
    description:
      "How many deck card rows are flagged for review (rows, not copies) — e.g. after an import or sync could not settle them.",
    type: "Int",
    resolve: () => ipc.deckReviewCount(),
  }),
  upcomingSets: t.field({
    ...invalidatedBy("decks"),
    description: "Sets with paper printings releasing after today and within `days`.",
    type: UpcomingSetsRef,
    args: {
      days: t.arg.int({
        required: false,
        defaultValue: 90,
        description: "How far ahead to look, in days, clamped to 1–365.",
      }),
    },
    resolve: (_root, { days }) => ipc.upcomingSets(days ?? 90),
  }),
}));
