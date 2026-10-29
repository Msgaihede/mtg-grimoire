/**
 * The graph's half of `lib/ipc/decks.ts`: the decks themselves and what hangs off them — their
 * values and colour bars, the cards in one, its categories, the deck labels its cards wear, the
 * folders decks are filed in, deck notes and deck to-do lists, a deck's history, the formats a
 * deck is checked against, and the home page's activity feed (whose wrapper lives in that file).
 *
 * **The words are the app's, and they are not interchangeable.** A *deck label* is the coloured
 * mark on one card inside a deck; a *deck tag* is free text describing a whole deck; neither is a
 * Scryfall tag. A *deck note* is prose about one deck that can name cards; a *card note* is the
 * same rows read from a card's side; a *deck to-do list* is not a note at all.
 *
 * **Edges on a deck read the gallery-wide command once.** `deck_values`, `deck_pip_costs`,
 * `deck_list`, `deck_folder_list` and `format_specs_list` answer every row at once, so a document
 * asking for fifty decks' values reads `deck_values` once through `ctx.once` and picks each row out
 * of that answer. The per-deck reads (notes, to-do lists, labels, categories, history) have no
 * such command, so each is one read per deck per execution.
 */
import type {
  ActivityEntry,
  CardNote,
  CategoryKind,
  CategoryOrigin,
  DeckAuditEntry,
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckFolder,
  DeckGame,
  DeckLabel,
  DeckNote,
  DeckNoteCard,
  DeckPipCosts,
  DeckRow,
  DeckTodoList,
  DeckTodoListEntry,
  DeckValue,
  DeckVariant,
  FormatSpec,
  Game,
  GlobalLabel,
  ManagedWishlistMode,
  PipCost,
  TokenMode,
} from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import type { GraphQLContext } from "../builder";
import { builder, invalidatedBy, MarketplaceEnum, marketplaceOf } from "../builder";
import { DeckVariantEnum, FinishEnum } from "./enums";

// ---------------------------------------------------------------------------------------------
// Shared reads: one per execution, keyed by the Rust command they call.
// ---------------------------------------------------------------------------------------------

/** Every deck, read once per execution — for any domain file that needs to name a deck. */
export function loadDeckList(ctx: GraphQLContext): Promise<DeckRow[]> {
  return ctx.once("deck_list", () => ipc.deckList());
}

function loadDeckValues(ctx: GraphQLContext, marketplace: MarketplaceId): Promise<DeckValue[]> {
  return ctx.once(`deck_values:${marketplace}`, () => ipc.deckValues(marketplace));
}

function loadDeckPipCosts(ctx: GraphQLContext): Promise<DeckPipCosts[]> {
  return ctx.once("deck_pip_costs", () => ipc.deckPipCosts());
}

function loadDeckFolders(ctx: GraphQLContext): Promise<DeckFolder[]> {
  return ctx.once("deck_folder_list", () => ipc.deckFolderList());
}

function loadFormats(ctx: GraphQLContext): Promise<FormatSpec[]> {
  return ctx.once("format_specs_list", () => ipc.formatSpecs());
}

async function deckById(ctx: GraphQLContext, id: number | null): Promise<DeckRow | null> {
  if (id === null) return null;
  return (await loadDeckList(ctx)).find((d) => d.id === id) ?? null;
}

/** JSON text the backend hands over unread, parsed for the reader; the text itself if it does
 *  not parse, so a malformed cell is still visible rather than an error. */
function parseJsonText(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A JSON-text array of strings (`finishes`, `promo_types`), or `null` when it is not one. */
function parseStringArray(text: string | null): string[] | null {
  const value = parseJsonText(text);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

// ---------------------------------------------------------------------------------------------
// Enums only this domain speaks.
// ---------------------------------------------------------------------------------------------

const CATEGORY_KINDS = [
  "main",
  "side",
  "commander",
  "companion",
  "maybe",
] as const satisfies readonly CategoryKind[];

export const CategoryKindEnum = builder.enumType("CategoryKind", {
  description:
    "What a deck category is for, which is what the rules read (its name is the reader's and can be anything). `main` is every pile the reader makes; `side` is the Sideboard, `commander` the Commander zone, `companion` the Companion zone, `maybe` the Maybeboard. A deck's size counts active `main`, `commander` and `maybe` piles; `side` and `companion` are played beside the deck.",
  values: CATEGORY_KINDS,
});

const CATEGORY_ORIGINS = ["user", "auto"] as const satisfies readonly CategoryOrigin[];

const CategoryOriginEnum = builder.enumType("CategoryOrigin", {
  description:
    "Who made a deck category: `user` (the reader, including the four predefined piles), or `auto` (the app, while filing a card — such a pile is drawn only while it holds a card).",
  values: CATEGORY_ORIGINS,
});

const GAMES = ["paper", "arena", "mtgo"] as const satisfies readonly Game[];

export const GameEnum = builder.enumType("Game", {
  description:
    "Where Magic is played, in Scryfall's words: `paper`, `arena` (MTG Arena) or `mtgo` (Magic Online).",
  values: GAMES,
});

const DECK_GAMES = [...GAMES, "any"] as const satisfies readonly DeckGame[];

const DeckGameEnum = builder.enumType("DeckGame", {
  description:
    "The platform a deck is built for: one of the `Game` values, or `any` for a deck not pinned to one (the default).",
  values: DECK_GAMES,
});

const MANAGED_WISHLIST_MODES = [
  "off",
  "all",
  "missing",
  "other",
] as const satisfies readonly ManagedWishlistMode[];

const ManagedWishlistModeEnum = builder.enumType("ManagedWishlistMode", {
  description:
    "What a deck's managed wishlist folder holds, kept up to date by the app: `off` (no folder), `all` (every card the deck's theory list plans), `missing` (the planned cards the live list lacks) or `other` (planned cards held in a different printing). Only a deck with a theory list beside its live one uses it.",
  values: MANAGED_WISHLIST_MODES,
});

const TOKEN_MODES = ["managed", "collection", "hidden"] as const satisfies readonly TokenMode[];

const TokenModeEnum = builder.enumType("TokenMode", {
  description:
    "How a deck keeps the tokens and emblems its cards make: `managed` and `collection` draw a Tokens & Emblems pile in the deck editor, `hidden` leaves it out. The pile never counts toward the deck's size or legality.",
  values: TOKEN_MODES,
});

type CommanderRule = NonNullable<FormatSpec["commanderRule"]>;
const COMMANDER_RULES = [
  "edh",
  "brawl",
  "oathbreaker",
  "pdh",
  "duel",
  "tlr",
] as const satisfies readonly CommanderRule[];

const CommanderRuleEnum = builder.enumType("CommanderRule", {
  description:
    "Which rule a format judges its commander by. A rule name, not a format name: two formats may share one (`predh` uses `edh`).",
  values: COMMANDER_RULES,
});

const RESTRICTED_MEANINGS = [
  "max_one",
  "banned_as_commander",
] as const satisfies readonly FormatSpec["restrictedSemantic"][];

const RestrictedMeaningEnum = builder.enumType("RestrictedMeaning", {
  description:
    "What a card Scryfall marks `restricted` means in a format: `max_one` (one copy at most, as in Vintage) or `banned_as_commander` (in the singleton formats that use the word).",
  values: RESTRICTED_MEANINGS,
});

// ---------------------------------------------------------------------------------------------
// Object types.
// ---------------------------------------------------------------------------------------------

export const FormatSpecRef = builder.objectRef<FormatSpec>("Format").implement({
  description:
    "One deck format and its rules as data — what a deck's legality is checked against. Seeded with the app; changes only with an app update.",
  fields: (t) => ({
    key: t.exposeString("key", {
      description: "The format's id, as a deck's `formatKey` names it (`commander`, `modern`, …).",
    }),
    displayName: t.exposeString("displayName"),
    enabledInPicker: t.exposeBoolean("enabledInPicker", {
      description: "Whether a new deck can be made in this format.",
    }),
    deckMin: t.exposeInt("deckMin", { description: "The fewest cards a deck may hold." }),
    deckMax: t.exposeInt("deckMax", {
      nullable: true,
      description: "The most cards a deck may hold; absent when there is no maximum.",
    }),
    maxCopies: t.exposeInt("maxCopies", {
      nullable: true,
      description: "The most copies of one card (basic lands aside); absent when unlimited.",
    }),
    sideboardMax: t.exposeInt("sideboardMax", {
      nullable: true,
      description: "The largest sideboard: `0` means none allowed, absent means uncapped.",
    }),
    singleton: t.exposeBoolean("singleton"),
    requiresCommander: t.exposeBoolean("requiresCommander"),
    commanderRule: t.expose("commanderRule", {
      type: CommanderRuleEnum,
      nullable: true,
      description: "How the commander is judged; absent for a format with no command zone.",
    }),
    life: t.exposeInt("life", { description: "Starting life total." }),
    restrictedMeaning: t.expose("restrictedSemantic", {
      type: RestrictedMeaningEnum,
    }),
    hasLegalityData: t.exposeBoolean("hasLegalityData", {
      description: "Whether cards carry a legality for this format (false for Casual and Limited).",
    }),
    maxManaValue: t.exposeInt("maxManaValue", {
      nullable: true,
      description: "A per-card mana value ceiling, when the format has one.",
    }),
    allowsCompanion: t.exposeBoolean("allowsCompanion"),
    sortOrder: t.exposeInt("sortOrder", { description: "Where a format picker lists it." }),
    games: t.expose("games", {
      type: [GameEnum],
      description: "The platforms the format is playable on. Never empty.",
    }),
    validates: t.exposeBoolean("validates", {
      description:
        "Whether a deck in this format is checked at all — false only for a deck whose format nobody has chosen yet.",
    }),
  }),
});

export const DeckFolderRef = builder.objectRef<DeckFolder>("DeckFolder");

/** Declared ahead and implemented below, because notes, to-do lists and the activity feed all
 *  point back at the deck they belong to. */
export const DeckRowRef = builder.objectRef<DeckRow>("Deck");

export const DeckValueRef = builder.objectRef<DeckValue>("DeckValue").implement({
  description:
    "What one deck's cards are worth at one marketplace: the live list's copies in active categories of kind `main`, `commander` or `maybe` — the same cards a deck's `cardCount` counts. Sideboard, companion, switched-off categories and the theory list are not included.",
  fields: (t) => ({
    deckId: t.exposeInt("deckId"),
    value: t.exposeFloat("value", {
      nullable: true,
      description:
        "The total, as a decimal amount in the marketplace's currency (`12.5` is $12.50 or €12.50 — see `marketplace.currency`). Summed over the copies that have a price; absent when none do, which is not the same as zero.",
    }),
    unpriced: t.exposeInt("unpriced", {
      description: "Copies in that pile with no price at this marketplace, left out of `value`.",
    }),
  }),
});

const PipCostRef = builder.objectRef<PipCost>("PipCost").implement({
  description: "One distinct printed mana cost in a deck, and how many copies pay it.",
  fields: (t) => ({
    cost: t.exposeString("cost", {
      description:
        'The printed cost in Scryfall\'s symbol form — `"{1}{R}"`, `"{2/W}"`, and `"{1}{R} // {1}{U}"` for a card with two faces. Never empty: lands and other costless cards are left out.',
    }),
    copies: t.exposeInt("copies", { description: "Copies in the deck with this cost." }),
  }),
});

export const DeckPipCostsRef = builder.objectRef<DeckPipCosts>("DeckPipCosts").implement({
  description:
    "Every printed mana cost in one deck's live list (active `main`, `commander` and `maybe` categories) — what the deck gallery's colour bar is drawn from. Count the coloured symbols in each `cost`, weighted by `copies`.",
  fields: (t) => ({
    deckId: t.exposeInt("deckId"),
    costs: t.expose("costs", {
      type: [PipCostRef],
      description: "Each cost once, in no particular order.",
    }),
  }),
});

export const DeckLabelRef = builder.objectRef<DeckLabel>("DeckLabelUsage").implement({
  description:
    "A deck label as worn in one list (live or theory) of one deck, with how many copies there wear it. A deck label is the reader's coloured mark on one card inside a deck — not a deck tag and not a Scryfall tag.",
  fields: (t) => ({
    id: t.exposeInt("id", { description: "The label's id — the same as `DeckLabel.id`." }),
    name: t.exposeString("name"),
    color: t.exposeString("color", {
      description: "The label's colour, normally `#rrggbb`; older rows may hold a palette word.",
    }),
    cardCount: t.exposeInt("cardCount", {
      description: "Copies wearing it in this deck's list. Never zero.",
    }),
  }),
});

export const GlobalLabelRef = builder.objectRef<GlobalLabel>("DeckLabel").implement({
  description:
    "A deck label: the reader's coloured mark for a card inside a deck (`Cut candidate`, `Upgrade`). One label is shared by every deck — renaming or recolouring it changes it everywhere — and a card in a deck wears at most one. Not a deck tag and not a Scryfall tag.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    name: t.exposeString("name"),
    color: t.exposeString("color", {
      description: "The label's colour, normally `#rrggbb`; older rows may hold a palette word.",
    }),
    cardCount: t.exposeInt("cardCount", {
      description: "Copies wearing it across every deck and both lists. `0` when unused.",
    }),
    deckCount: t.exposeInt("deckCount", {
      description: "Decks with at least one card wearing it.",
    }),
  }),
});

export const DeckCategoryRef = builder.objectRef<DeckCategory>("DeckCategory").implement({
  description:
    "One category of one list (live or theory) of a deck: a named pile of cards, drawn as a column in the deck editor.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    deckId: t.exposeInt("deckId"),
    variant: t.expose("variant", { type: DeckVariantEnum }),
    name: t.exposeString("name", { description: "As the reader named it." }),
    kind: t.expose("kind", { type: CategoryKindEnum }),
    origin: t.expose("origin", { type: CategoryOriginEnum }),
    isActive: t.exposeBoolean("isActive", {
      description:
        "Whether the pile counts. A switched-off pile counts toward no deck size, copy limit or legality check; the Maybeboard starts switched off.",
    }),
    sortOrder: t.exposeInt("sortOrder"),
    cardCount: t.exposeInt("cardCount", { description: "Copies in the pile, not rows." }),
    totalPrice: t.exposeFloat("totalPrice", {
      nullable: true,
      description:
        "Unit price × copies over the pile, as a decimal amount in the marketplace's currency; a partial sum over the copies that have a price, absent when none do.",
    }),
  }),
});

export const DeckCardRef = builder.objectRef<DeckCard>("DeckCard").implement({
  description:
    "One card row in one category of one deck list: the printing, how many copies, the deck label it wears, the card's facts, its price, and how many of it the reader owns for this deck. Card facts are absent when the printing has left the card database.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    cardId: t.exposeString("cardId", { description: "The Scryfall id of the printing." }),
    oracleId: t.exposeString("oracleId", {
      nullable: true,
      description: "The card across all its printings (Scryfall's oracle id).",
    }),
    name: t.exposeString("name"),
    quantity: t.exposeInt("quantity", { description: "Copies in this row." }),
    variant: t.expose("variant", { type: DeckVariantEnum }),
    categoryId: t.exposeInt("categoryId"),
    categoryName: t.exposeString("categoryName"),
    categoryKind: t.expose("categoryKind", { type: CategoryKindEnum }),
    categoryActive: t.exposeBoolean("categoryActive", {
      description: "False when the row's category is switched off, so it counts toward nothing.",
    }),
    labelId: t.exposeInt("labelId", {
      nullable: true,
      description: "The deck label this card wears, if any. The three label fields go together.",
    }),
    labelName: t.exposeString("labelName", { nullable: true }),
    labelColor: t.exposeString("labelColor", { nullable: true }),
    setCode: t.exposeString("setCode", { description: "Lowercase, as Scryfall stores it." }),
    setName: t.exposeString("setName", { nullable: true }),
    collectorNumber: t.exposeString("collectorNumber"),
    lang: t.exposeString("lang"),
    finish: t.expose("finish", {
      type: FinishEnum,
      nullable: true,
      description:
        "The finish the deck plays: `foil` or `etched`, or absent for the regular (nonfoil) copy.",
    }),
    needsReview: t.exposeString("needsReview", {
      nullable: true,
      description: "A sentence when a sync could not keep this row's printing.",
    }),
    manaCost: t.exposeString("manaCost", {
      nullable: true,
      description: 'In Scryfall\'s symbol form, e.g. `"{2}{G}{G}"`.',
    }),
    cmc: t.exposeFloat("cmc", { nullable: true, description: "Mana value." }),
    typeLine: t.exposeString("typeLine", { nullable: true }),
    oracleText: t.exposeString("oracleText", { nullable: true }),
    colors: t.exposeString("colors", {
      nullable: true,
      description: 'Colour letters run together (`"WU"`), not a list. `""` is colourless.',
    }),
    colorIdentity: t.exposeString("colorIdentity", {
      nullable: true,
      description: 'Colour identity letters run together (`"WU"`).',
    }),
    producedMana: t.exposeString("producedMana", {
      nullable: true,
      description:
        'The colours of mana the card can make, letters run together (`"C"` for colourless); `""` when it makes none, absent when unknown.',
    }),
    legalities: t.field({
      type: "JSON",
      nullable: true,
      description:
        "This printing's legality per format, as Scryfall gives it: an object of format key → `legal` | `not_legal` | `restricted` | `banned`.",
      resolve: (card) => parseJsonText(card.legalities),
    }),
    power: t.exposeString("power", { nullable: true, description: 'As printed — may be `"*"`.' }),
    toughness: t.exposeString("toughness", { nullable: true }),
    layout: t.exposeString("layout", { nullable: true }),
    rarity: t.exposeString("rarity", { nullable: true }),
    faces: t.field({
      type: "JSON",
      nullable: true,
      description:
        "Scryfall's `card_faces` array for a card with more than one face, verbatim; absent for a one-faced card.",
      resolve: (card) => parseJsonText(card.faces),
    }),
    gameChanger: t.exposeBoolean("gameChanger", {
      nullable: true,
      description: "On the Commander Game Changers list.",
    }),
    printingFinishes: t.stringList({
      nullable: true,
      description:
        "Every finish this printing exists in (`nonfoil`, `foil`, `etched`) — not the finish the deck plays, which is `finish`.",
      resolve: (card) => parseStringArray(card.finishes),
    }),
    promoTypes: t.stringList({
      nullable: true,
      description:
        "Scryfall's `promo_types` (`surgefoil`, `halofoil`, …), which name a foil's kind.",
      resolve: (card) => parseStringArray(card.promoTypes),
    }),
    everUncommon: t.exposeBoolean("everUncommon", {
      description: "Printed at uncommon on any printing — what makes a Pauper Commander commander.",
    }),
    unitPrice: t.exposeFloat("unitPrice", {
      nullable: true,
      description:
        "One copy's price at the marketplace asked for, at the row's finish, as a decimal amount in that marketplace's currency; absent when it has none.",
    }),
    ownedQuantity: t.exposeInt("ownedQuantity", {
      description:
        "Copies of this printing and finish the reader owns for this row: on the live list, the copies filed in the deck's own collection group; on the theory list, every copy the deck could use. Always 0 in a switched-off category.",
    }),
  }),
});

export const DeckNoteCardRef = builder.objectRef<DeckNoteCard>("DeckNoteCard").implement({
  description: "A card a deck note names.",
  fields: (t) => ({
    oracleId: t.exposeString("oracleId", {
      description: "The card across all its printings — what the note attaches by.",
    }),
    name: t.exposeString("name", {
      description: "The card's name, or its oracle id when the card database has no row for it.",
    }),
    cardId: t.exposeString("cardId", {
      nullable: true,
      description:
        "A printing to draw a picture of — the deck's own where it holds one. Absent when none is known.",
    }),
  }),
});

export const DeckNoteRef = builder.objectRef<DeckNote>("DeckNote").implement({
  description:
    "A deck note: the reader's prose about one deck, optionally naming cards in it. Not a sticky note (the home page's), not an entry note (on a collection or wishlist row), and not a deck to-do list.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    deckId: t.exposeInt("deckId"),
    title: t.exposeString("title", {
      description:
        "The heading as typed; may be empty, in which case the app shows the body's first line or `Untitled note`.",
    }),
    body: t.exposeString("body", { description: "The note, as Markdown (CommonMark) source." }),
    sortOrder: t.exposeInt("sortOrder", { description: "The reader's order within the deck." }),
    cards: t.expose("cards", {
      type: [DeckNoteCardRef],
      description: "The cards the note names. Often empty.",
    }),
    createdAt: t.exposeFloat("createdAt", { description: "Unix seconds." }),
    updatedAt: t.exposeFloat("updatedAt", { description: "Unix seconds." }),
  }),
});

export const CardNoteRef = builder.objectRef<CardNote>("CardNote").implement({
  description:
    "A deck note seen from one card it names: the same note as `DeckNote`, carrying the deck it was written in instead of its cards.",
  fields: (t) => ({
    id: t.exposeInt("id", { description: "The deck note's id." }),
    deckId: t.exposeInt("deckId"),
    deckName: t.exposeString("deckName"),
    title: t.exposeString("title", { description: "The heading as typed; may be empty." }),
    body: t.exposeString("body", { description: "The note, as Markdown (CommonMark) source." }),
    deck: t.field({
      type: DeckRowRef,
      nullable: true,
      description: "The deck the note is in.",
      resolve: (note, _args, ctx) => deckById(ctx, note.deckId),
    }),
  }),
});

export const DeckTodoListRef = builder.objectRef<DeckTodoList>("DeckTodoList").implement({
  description:
    "One of a deck's to-do lists: a titled Markdown document of headings, text and `- [ ]` / `- [x]` to-dos. A deck can have many. Not a deck note.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    deckId: t.exposeInt("deckId"),
    title: t.exposeString("title", {
      description: "The heading as typed; may be empty (shown as `Untitled list`).",
    }),
    body: t.exposeString("body", {
      description:
        "The list as Markdown: headings, paragraphs and task lines `- [ ] open` / `- [x] done`. Empty for a list with nothing in it yet.",
    }),
    sortOrder: t.exposeInt("sortOrder"),
    createdAt: t.exposeFloat("createdAt", { description: "Unix seconds." }),
    updatedAt: t.exposeFloat("updatedAt", { description: "Unix seconds." }),
  }),
});

export const DeckTodoListEntryRef = builder
  .objectRef<DeckTodoListEntry>("DeckTodoListEntry")
  .implement({
    description:
      "A deck to-do list as read across every deck, with the deck it belongs to — only lists whose body is not empty.",
    fields: (t) => ({
      id: t.exposeInt("id", { description: "The to-do list's id." }),
      deckId: t.exposeInt("deckId"),
      deckName: t.exposeString("deckName"),
      archived: t.exposeBoolean("archived", { description: "Whether the deck is archived." }),
      todosOpen: t.exposeBoolean("todosOpen", {
        description: "Whether the deck editor's To-do band is expanded for this deck.",
      }),
      title: t.exposeString("title", { description: "The heading as typed; may be empty." }),
      body: t.exposeString("body", {
        description:
          "The list as Markdown: headings, paragraphs and task lines `- [ ] open` / `- [x] done`. Never empty here.",
      }),
      sortOrder: t.exposeInt("sortOrder", { description: "The list's order within its deck." }),
      updatedAt: t.exposeFloat("updatedAt", { description: "Unix seconds of the last edit." }),
      deck: t.field({
        type: DeckRowRef,
        nullable: true,
        resolve: (entry, _args, ctx) => deckById(ctx, entry.deckId),
      }),
    }),
  });

export const DeckAuditEntryRef = builder.objectRef<DeckAuditEntry>("DeckHistoryEntry").implement({
  description:
    "One line of a deck's history: what changed, as facts rather than a sentence. Newest first.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    deckId: t.exposeInt("deckId"),
    at: t.exposeFloat("at", { description: "Unix seconds." }),
    variant: t.expose("variant", {
      type: DeckVariantEnum,
      description:
        "The list changed — meaningful only for card changes; deck-level lines always say `live`. Do not filter history by it.",
    }),
    // A string and never an enum: a row written by a newer build carries a kind this one has
    // never heard of, and `DeckHistoryDialog` draws it rather than dropping it (the starter
    // seed holds one) — an enum would turn that row into an error and null the whole list.
    kind: t.exposeString("kind", {
      description:
        "What the line is about. Known kinds: `add`, `remove` and `quantity` change how many copies a deck holds; `move` moves cards between categories; `swap` changes a card's printing; `label` puts a deck label on a card or creates, renames or deletes one; `category`, `folder` and `deck` change a category, the deck's folder, or a setting of the deck itself. A history written by a newer version of the app can hold other kinds: show them, do not drop them.",
    }),
    cardId: t.exposeString("cardId", {
      nullable: true,
      description: "The printing the change was about; absent for changes about no card.",
    }),
    cardName: t.exposeString("cardName", { nullable: true }),
    payload: t.field({
      type: "JSON",
      description:
        "The change's details; the shape depends on `kind`, and every key may be missing. Roughly: add `{category, quantity}`; remove `{category, quantity, reason}`; quantity `{category, from, to}`; move `{from, to}` (category names); swap `{category, fromSet, toSet, folded}`; label `{label, previous}` or `{action, label, previous}`; category `{action, name, previousName, cards}`; folder `{action, folder}`; deck `{field, from, to}`.",
      resolve: (entry) => parseJsonText(entry.payload),
    }),
    delta: t.exposeInt("delta", {
      description: "Signed change in copies (+n added, −n removed); 0 when no count changed.",
    }),
  }),
});

export const ActivityEntryRef = builder.objectRef<ActivityEntry>("ActivityEntry").implement({
  description:
    "One line of the home page's activity feed: a recent change to the collection, the wishlist or a deck, as facts rather than a sentence. `id` is unique only within a `scope`.",
  fields: (t) => ({
    id: t.exposeInt("id", { description: "Unique within its scope only; key by scope and id." }),
    at: t.exposeFloat("at", { description: "Unix seconds." }),
    scope: t.exposeString("scope", {
      description:
        "Where the change was made: `collection`, `wishlist` or `deck` (a newer app may write another word).",
    }),
    kind: t.exposeString("kind", {
      description:
        "What was done; the words depend on `scope`. Collection and wishlist: `add`, `remove`, `quantity`, `move`, `edit`, `folder`, `import`, `clear`. Deck: the `DeckHistoryKind` words.",
    }),
    deckId: t.exposeInt("deckId", {
      nullable: true,
      description: "The deck changed; present only when `scope` is `deck`.",
    }),
    cardId: t.exposeString("cardId", {
      nullable: true,
      description: "The printing the change was about; absent when it was about no one card.",
    }),
    cardName: t.exposeString("cardName", { nullable: true }),
    payload: t.field({
      type: "JSON",
      description:
        "The change's details; the shape depends on `scope` and `kind`, and every key may be missing. Deck lines carry `DeckHistoryEntry.payload`'s shapes.",
      resolve: (entry) => parseJsonText(entry.payload),
    }),
    delta: t.exposeInt("delta", {
      description: "Signed change in copies (+n added, −n removed); 0 when no count changed.",
    }),
    deck: t.field({
      type: DeckRowRef,
      nullable: true,
      description: "The deck changed, when `scope` is `deck` and the deck still exists.",
      resolve: (entry, _args, ctx) => deckById(ctx, entry.deckId),
    }),
  }),
});

const marketplaceArg = {
  type: MarketplaceEnum,
  required: false,
  description: "The marketplace to price at. Defaults to the reader's.",
} as const;

DeckRowRef.implement({
  description:
    "One deck, as the deck gallery lists it. Every deck has a live list (the cards as built); a deck with `theoryEnabled` also has a theory list (the version being planned).",
  fields: (t) => ({
    id: t.exposeInt("id"),
    name: t.exposeString("name"),
    formatKey: t.exposeString("formatKey", {
      description: "The format's id (`commander`, `modern`, `casual`, …).",
    }),
    formatName: t.exposeString("formatName", {
      nullable: true,
      description: "The format's display name; absent for a format this app no longer knows.",
    }),
    gameKey: t.expose("gameKey", { type: DeckGameEnum }),
    description: t.exposeString("description", { nullable: true }),
    coverCardId: t.exposeString("coverCardId", {
      nullable: true,
      description: "The printing whose art crop is the deck's cover.",
    }),
    coverArtist: t.exposeString("coverArtist", {
      nullable: true,
      description:
        "The cover's illustrator. Credit them wherever the cover is shown; when absent, do not draw the cover.",
    }),
    archived: t.exposeBoolean("archived"),
    cardCount: t.exposeInt("cardCount", {
      description:
        "Copies in the live list's active `main`, `commander` and `maybe` categories — what “a 60-card deck” means.",
    }),
    updatedAt: t.exposeFloat("updatedAt", {
      description: "Unix seconds of the last change to the deck or its cards.",
    }),
    folderId: t.exposeInt("folderId", {
      nullable: true,
      description: "The deck folder it is filed in; absent at the root.",
    }),
    theoryEnabled: t.exposeBoolean("theoryEnabled", {
      description: "Whether the deck keeps a theory list (a plan) beside its live one.",
    }),
    virtualOnly: t.exposeBoolean("virtualOnly", {
      description:
        "Whether the deck is tracked without owning the cards (an Arena or MTGO list, a proxy pile). Such a deck reads nothing from the collection.",
    }),
    lastVariant: t.expose("lastVariant", {
      type: DeckVariantEnum,
      description: "The list the deck editor was last showing.",
    }),
    managedWishlist: t.expose("managedWishlist", { type: ManagedWishlistModeEnum }),
    tokenMode: t.expose("tokenMode", { type: TokenModeEnum }),
    bracket: t.exposeInt("bracket", {
      description:
        "The Commander bracket (1–5) the reader declared for the deck, or 0 when they have not (the app then estimates one).",
    }),
    tags: t.exposeStringList("tags", {
      description:
        "Deck tags: the reader's free-text words for the whole deck (`Budget`, `Meme`), in the order added. Not deck labels and not Scryfall tags.",
    }),
    notesOpen: t.exposeBoolean("notesOpen", {
      description: "Whether the deck editor's Notes band is expanded.",
    }),
    todosOpen: t.exposeBoolean("todosOpen", {
      description: "Whether the deck editor's To-do band is expanded.",
    }),
    value: t.field({
      type: DeckValueRef,
      nullable: true,
      description: "What the deck's live cards are worth at a marketplace.",
      args: { marketplace: t.arg(marketplaceArg) },
      resolve: async (deck, args, ctx) =>
        (await loadDeckValues(ctx, marketplaceOf(args, ctx))).find((v) => v.deckId === deck.id) ??
        null,
    }),
    pipCosts: t.field({
      type: [PipCostRef],
      description:
        "The live list's printed mana costs, for a colour bar. Empty for a deck of lands or no cards.",
      resolve: async (deck, _args, ctx) =>
        (await loadDeckPipCosts(ctx)).find((p) => p.deckId === deck.id)?.costs ?? [],
    }),
    folder: t.field({
      type: DeckFolderRef,
      nullable: true,
      description: "The deck folder it is filed in; absent at the root.",
      resolve: async (deck, _args, ctx) =>
        deck.folderId === null
          ? null
          : ((await loadDeckFolders(ctx)).find((f) => f.id === deck.folderId) ?? null),
    }),
    format: t.field({
      type: FormatSpecRef,
      nullable: true,
      description: "The deck's format and its rules; absent for a format this app no longer knows.",
      resolve: async (deck, _args, ctx) =>
        (await loadFormats(ctx)).find((f) => f.key === deck.formatKey) ?? null,
    }),
    notes: t.field({
      type: [DeckNoteRef],
      description: "The deck's notes, in the reader's order.",
      resolve: (deck, _args, ctx) =>
        ctx.once(`deck_notes:${deck.id}`, () => ipc.deckNotes(deck.id)),
    }),
    todoLists: t.field({
      type: [DeckTodoListRef],
      description: "The deck's to-do lists, in the reader's order — empty ones included.",
      resolve: (deck, _args, ctx) =>
        ctx.once(`deck_todo_lists:${deck.id}`, () => ipc.deckTodoLists(deck.id)),
    }),
    labels: t.field({
      type: [DeckLabelRef],
      description: "The deck labels this deck's cards wear in one list, most-used first.",
      args: {
        variant: t.arg({ type: DeckVariantEnum, required: false, defaultValue: "live" }),
      },
      resolve: (deck, args, ctx) => {
        const variant: DeckVariant = args.variant ?? "live";
        return ctx.once(`deck_label_list:${deck.id}:${variant}`, () =>
          ipc.deckLabelList(deck.id, variant),
        );
      },
    }),
    categories: t.field({
      type: [DeckCategoryRef],
      description: "The categories of one of the deck's lists, in order, empty ones included.",
      args: {
        variant: t.arg({ type: DeckVariantEnum, required: false, defaultValue: "live" }),
        marketplace: t.arg(marketplaceArg),
      },
      resolve: (deck, args, ctx) => {
        const variant: DeckVariant = args.variant ?? "live";
        const marketplace = marketplaceOf(args, ctx);
        return ctx.once(`deck_category_list:${deck.id}:${variant}:${marketplace}`, () =>
          ipc.deckCategoryList(deck.id, variant, marketplace),
        );
      },
    }),
    history: t.field({
      type: [DeckAuditEntryRef],
      description: "The deck's history, newest first.",
      args: {
        limit: t.arg.int({
          required: false,
          defaultValue: 50,
          description: "At most this many lines (1–500).",
        }),
      },
      resolve: (deck, args, ctx) => {
        const limit = args.limit ?? 50;
        return ctx.once(`deck_audit_list:${deck.id}:${limit}`, () =>
          ipc.deckAuditList(deck.id, limit),
        );
      },
    }),
  }),
});

DeckFolderRef.implement({
  description:
    "A folder of the deck gallery's tree. Folders nest through `parentId`; a folder files decks and belongs to none.",
  fields: (t) => ({
    id: t.exposeInt("id"),
    parentId: t.exposeInt("parentId", {
      nullable: true,
      description: "The folder this one is inside; absent at the root.",
    }),
    name: t.exposeString("name"),
    sortOrder: t.exposeInt("sortOrder", { description: "Its place among its siblings." }),
    parent: t.field({
      type: DeckFolderRef,
      nullable: true,
      resolve: async (folder, _args, ctx) =>
        folder.parentId === null
          ? null
          : ((await loadDeckFolders(ctx)).find((f) => f.id === folder.parentId) ?? null),
    }),
    subfolders: t.field({
      type: [DeckFolderRef],
      description: "The folders directly inside this one, in order.",
      resolve: async (folder, _args, ctx) =>
        (await loadDeckFolders(ctx))
          .filter((f) => f.parentId === folder.id)
          .sort((a, b) => a.sortOrder - b.sortOrder),
    }),
    decks: t.field({
      type: [DeckRowRef],
      description: "The decks filed directly in this folder (not in its subfolders).",
      resolve: async (folder, _args, ctx) =>
        (await loadDeckList(ctx)).filter((d) => d.folderId === folder.id),
    }),
  }),
});

export const DeckDetailRef = builder.objectRef<DeckDetail>("DeckDetail").implement({
  description: "One list (live or theory) of one deck, with everything in it.",
  fields: (t) => ({
    deck: t.expose("deck", { type: DeckRowRef }),
    cards: t.expose("cards", {
      type: [DeckCardRef],
      description: "Every card row of the list, by category order then name.",
    }),
    categories: t.expose("categories", {
      type: [DeckCategoryRef],
      description: "Every category of the list, in order — empty and switched-off ones included.",
    }),
    labels: t.expose("labels", {
      type: [DeckLabelRef],
      description: "The deck labels the list's cards wear.",
    }),
  }),
});

// ---------------------------------------------------------------------------------------------
// Root fields.
// ---------------------------------------------------------------------------------------------

builder.queryFields((t) => ({
  decks: t.field({
    ...invalidatedBy("decks"),
    description:
      "Every deck, as the deck gallery lists them: archived decks last, then most recently changed first.",
    type: [DeckRowRef],
    args: {
      archived: t.arg.boolean({
        required: false,
        description: "Only archived decks (`true`) or only active ones (`false`). Omit for both.",
      }),
    },
    resolve: async (_root, { archived }, ctx) => {
      const decks = await loadDeckList(ctx);
      return archived == null ? decks : decks.filter((d) => d.archived === archived);
    },
  }),
  deck: t.field({
    // Owned counts on the cards are collection rows, so a binder write changes this answer too.
    ...invalidatedBy("decks", "collection"),
    description:
      "One list of one deck, with its cards, categories and the deck labels its cards wear. Absent when no deck has that id.",
    type: DeckDetailRef,
    nullable: true,
    args: {
      id: t.arg.int({ required: true }),
      variant: t.arg({ type: DeckVariantEnum, required: false, defaultValue: "live" }),
      marketplace: t.arg(marketplaceArg),
    },
    resolve: (_root, args, ctx) =>
      ipc.deckGet(args.id, args.variant ?? "live", marketplaceOf(args, ctx)),
  }),
  deckValues: t.field({
    ...invalidatedBy("decks"),
    description: "What every deck's live cards are worth at a marketplace, one row per deck.",
    type: [DeckValueRef],
    args: { marketplace: t.arg(marketplaceArg) },
    resolve: (_root, args, ctx) => loadDeckValues(ctx, marketplaceOf(args, ctx)),
  }),
  deckPipCosts: t.field({
    ...invalidatedBy("decks"),
    description:
      "Every deck's printed mana costs, for colour bars. A deck with no costed cards is absent.",
    type: [DeckPipCostsRef],
    resolve: (_root, _args, ctx) => loadDeckPipCosts(ctx),
  }),
  deckNotes: t.field({
    ...invalidatedBy("decks"),
    description: "One deck's deck notes, in the reader's order. Empty when it has none.",
    type: [DeckNoteRef],
    args: { deckId: t.arg.int({ required: true }) },
    resolve: (_root, { deckId }, ctx) =>
      ctx.once(`deck_notes:${deckId}`, () => ipc.deckNotes(deckId)),
  }),
  cardNotes: t.field({
    ...invalidatedBy("decks"),
    description: "Every deck note, in any deck, that names a card.",
    type: [CardNoteRef],
    args: {
      oracleId: t.arg.string({
        required: true,
        description: "The card across all its printings (Scryfall's oracle id).",
      }),
    },
    resolve: (_root, { oracleId }) => ipc.cardNotes(oracleId),
  }),
  deckTodoLists: t.field({
    ...invalidatedBy("decks"),
    description:
      "Every deck to-do list with something in it, across all decks (archived ones included), most recently edited first.",
    type: [DeckTodoListEntryRef],
    resolve: () => ipc.everyDeckTodoList(),
  }),
  deckTodoListsForDeck: t.field({
    ...invalidatedBy("decks"),
    description: "One deck's to-do lists, in the reader's order — empty ones included.",
    type: [DeckTodoListRef],
    args: { deckId: t.arg.int({ required: true }) },
    resolve: (_root, { deckId }, ctx) =>
      ctx.once(`deck_todo_lists:${deckId}`, () => ipc.deckTodoLists(deckId)),
  }),
  deckLabels: t.field({
    ...invalidatedBy("decks"),
    description: "Every deck label there is, worn or not, most-used first.",
    type: [GlobalLabelRef],
    resolve: () => ipc.deckLabelAll(),
  }),
  deckLabelsInDeck: t.field({
    ...invalidatedBy("decks"),
    description:
      "The deck labels one list of one deck is wearing, with how many copies wear each, most-used first.",
    type: [DeckLabelRef],
    args: {
      deckId: t.arg.int({ required: true }),
      variant: t.arg({ type: DeckVariantEnum, required: false, defaultValue: "live" }),
    },
    resolve: (_root, args, ctx) => {
      const variant: DeckVariant = args.variant ?? "live";
      return ctx.once(`deck_label_list:${args.deckId}:${variant}`, () =>
        ipc.deckLabelList(args.deckId, variant),
      );
    },
  }),
  deckFolders: t.field({
    ...invalidatedBy("decks"),
    description:
      "Every deck folder, flat; build the tree from `parentId` (or walk `subfolders` from the ones with none).",
    type: [DeckFolderRef],
    resolve: (_root, _args, ctx) => loadDeckFolders(ctx),
  }),
  deckCategories: t.field({
    ...invalidatedBy("decks"),
    description: "The categories of one list of one deck, in order, empty ones included.",
    type: [DeckCategoryRef],
    args: {
      deckId: t.arg.int({ required: true }),
      variant: t.arg({ type: DeckVariantEnum, required: false, defaultValue: "live" }),
      marketplace: t.arg(marketplaceArg),
    },
    resolve: (_root, args, ctx) => {
      const variant: DeckVariant = args.variant ?? "live";
      const marketplace = marketplaceOf(args, ctx);
      return ctx.once(`deck_category_list:${args.deckId}:${variant}:${marketplace}`, () =>
        ipc.deckCategoryList(args.deckId, variant, marketplace),
      );
    },
  }),
  deckHistory: t.field({
    ...invalidatedBy("decks"),
    description: "One deck's history, newest first. Empty for a deck that does not exist.",
    type: [DeckAuditEntryRef],
    args: {
      deckId: t.arg.int({ required: true }),
      limit: t.arg.int({
        required: false,
        defaultValue: 50,
        description: "At most this many lines (1–500).",
      }),
    },
    resolve: (_root, args, ctx) => {
      const limit = args.limit ?? 50;
      return ctx.once(`deck_audit_list:${args.deckId}:${limit}`, () =>
        ipc.deckAuditList(args.deckId, limit),
      );
    },
  }),
  formats: t.field({
    ...invalidatedBy("formatSpecs"),
    description: "Every deck format and its rules, in picker order.",
    type: [FormatSpecRef],
    resolve: (_root, _args, ctx) => loadFormats(ctx),
  }),
  activity: t.field({
    // The feed's own root is invalidated by nothing; it is a record of these three roots' writes.
    ...invalidatedBy("collection", "wishlist", "decks"),
    description:
      "Recent changes to the collection, the wishlist and every deck, newest first — the home page's activity feed.",
    type: [ActivityEntryRef],
    args: {
      limit: t.arg.int({
        required: false,
        defaultValue: 50,
        description: "At most this many lines (1–500).",
      }),
    },
    resolve: (_root, { limit }) => ipc.activityRecent(limit ?? 50),
  }),
}));
