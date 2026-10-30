/**
 * **The component catalogue** — what a generated home widget may be built from, for json-render.
 *
 * A generated widget is two declarative parts and no code: a GraphQL document over the read graph
 * (`crates/grimoire-graph`) and a json-render spec drawn from this catalogue, whose props read the
 * document's answer by path (`{ "$state": "/decks/0/name" }`, `repeat` over a list). This file is
 * the vocabulary half: every component a spec may name, its props as a zod schema, and a
 * description written for the model that writes the spec. `./registry.tsx` is the other half —
 * each name mapped onto this app's own components, so a generated widget is drawn exactly as a
 * hand-written one is. (Not `../WidgetCatalogue.tsx`, the dialog a reader adds a widget kind
 * from.)
 *
 * **What is in it, and why those.** The home widgets' own parts (`WidgetParts.tsx`: figures, bars,
 * rows, a message, a footer line), the card visuals (`CardArt`, `CardTile`, the rarity gem, the
 * finish mark, the set symbol, the count tag, mana symbols in text), the price chart, layout and
 * text, the app's inputs and the widgets' own settings controls. Nothing here fetches but the card
 * search: data arrives through the spec's `$state` expressions, so a component is a picture of
 * facts it is handed.
 *
 * **The inputs write only the widget's own state** (`$bindState`). The graph is read-only and so
 * is a widget: an input filters, sorts or switches what the widget draws, and never changes the
 * reader's data. The **actions** navigate — open a card, a deck, a folder, a view — through the
 * same store hand-offs the hand-written widgets use.
 *
 * **Conclusions TypeScript owns are functions**, called with `$computed`: money is formatted at the
 * reader's marketplace (`formatPrice`), never by a spec spelling a currency.
 *
 * **Optional props are `.nullable()`**, json-render's convention: a model sends `null` for a prop
 * it leaves out, and the prompt says so.
 */
// First: zod is told it may not eval before json-render or any schema here meets it.
import "./zodConfig";
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import { PANELS, type PanelId } from "@/features/settings/nav";

/** The gap scale every layout component shares. */
const GAP = z.enum(["none", "sm", "md", "lg"]).nullable();

const FINISH = z.enum(["nonfoil", "foil", "etched"]);

/** A colour a bar or a figure may take: the app's accent, rising and falling, and the five mana
 *  colours plus colourless. Never a free colour — the widget wears the app's palette. */
const PAINT = z.enum(["accent", "up", "down", "dim", "W", "U", "B", "R", "G", "C"]);

/** A choice an input offers: the value it writes, and the words it shows. */
const OPTIONS = z.array(z.object({ value: z.string(), label: z.string() }));

/** Where the app can take the reader, for `openView`. */
export const VIEWS = [
  "home",
  "search",
  "collection",
  "wishlist",
  "decks",
  "scanner",
  "trade",
  "playtesting",
  "draft",
] as const;

/** The Settings panels `openSettings` can bring into view — Settings' own list, so a renamed
 *  panel is a new word here too. */
const PANEL_IDS = Object.keys(PANELS) as [PanelId, ...PanelId[]];

const SCOPE = z.enum(["collection", "wishlist"]);

export const catalog = defineCatalog(schema, {
  components: {
    // --- layout -----------------------------------------------------------------------------
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal"]).nullable(),
        gap: GAP,
        align: z.enum(["start", "center", "end", "stretch"]).nullable(),
        justify: z.enum(["start", "center", "end", "between"]).nullable(),
        wrap: z.boolean().nullable(),
      }),
      slots: ["default"],
      description:
        "Lays its children out in a column (the default) or a row. The usual root of a widget.",
    },
    Grid: {
      props: z.object({
        columns: z.number().int().min(1).max(6),
        gap: GAP,
      }),
      slots: ["default"],
      description:
        "Lays its children out in equal columns, wrapping onto new rows — a wall of card tiles.",
    },
    Divider: {
      props: z.object({}),
      description: "A thin horizontal rule between two parts of a widget.",
    },
    Panel: {
      props: z.object({ title: z.string() }),
      slots: ["default"],
      description:
        "A bordered section with a small title — groups a chart or a few rows under a heading, as the deck editor's stats band does.",
    },

    // --- text -------------------------------------------------------------------------------
    Heading: {
      props: z.object({
        text: z.string(),
        level: z.number().int().min(1).max(3).nullable(),
      }),
      description: "A heading. Level 1 is the largest; widgets usually want 2 or 3.",
    },
    Text: {
      props: z.object({
        text: z.string(),
        tone: z.enum(["default", "dim", "accent", "up", "down", "destructive"]).nullable(),
        size: z.enum(["xs", "sm", "md", "lg"]).nullable(),
        mono: z.boolean().nullable(),
        truncate: z.boolean().nullable(),
      }),
      description:
        "A line of text. `dim` for secondary words, `accent` for money, `up`/`down` for a rise or a fall, `mono` for figures.",
    },
    ManaText: {
      props: z.object({ text: z.string() }),
      description:
        "Text with Magic symbols drawn as icons: a mana cost (`{2}{R}{R}`) or rules text (`{T}: Add {G}.`).",
    },
    Price: {
      props: z.object({
        value: z.number().nullable(),
        tone: z.enum(["accent", "default", "dim"]).nullable(),
      }),
      description:
        "An amount of money in the reader's marketplace currency, written the app's way. `null` draws an em dash — a price nobody quotes is not zero.",
    },
    Hint: {
      props: z.object({ text: z.string() }),
      slots: ["default"],
      description:
        "Shows `text` as the app's tooltip when its children are hovered or focused — an explanation that does not fit on the widget.",
    },

    // --- the home widgets' own parts ---------------------------------------------------------
    Figures: {
      props: z.object({
        figures: z.array(
          z.object({
            label: z.string(),
            value: z.union([z.number(), z.string()]),
            money: z.boolean().nullable(),
            note: z.string().nullable(),
          }),
        ),
        fill: z.boolean().nullable(),
        divided: z.boolean().nullable(),
      }),
      description:
        "Big numbers with a label each — totals, counts, values. A numeric `value` with `money: true` is written in the reader's currency. `fill` spreads them over the whole widget at the largest size that fits.",
    },
    Bars: {
      props: z.object({
        bars: z.array(
          z.object({
            label: z.string(),
            value: z.number(),
            color: PAINT.nullable(),
          }),
        ),
        money: z.boolean().nullable(),
        fill: z.boolean().nullable(),
      }),
      description:
        "Horizontal bars comparing values — a breakdown by rarity, colour or set. Each bar is drawn against the largest value. `money` writes values in the reader's currency.",
    },
    RowList: {
      props: z.object({ label: z.string().nullable() }),
      slots: ["default"],
      description:
        "A list of Row children, laid out in as many columns as the widget is wide. Use `repeat` on it to draw one Row per item of a list in state.",
    },
    Row: {
      props: z.object({
        name: z.string(),
        caption: z.string().nullable(),
        value: z.union([z.number(), z.string()]).nullable(),
        money: z.boolean().nullable(),
        delta: z.enum(["up", "down"]).nullable(),
        rarity: z.string().nullable(),
        setCode: z.string().nullable(),
        track: z.number().min(0).max(1).nullable(),
      }),
      description:
        "One line of a RowList: a name, a dim caption under it, a value on the right (`delta` tints it as a rise or a fall), an optional rarity gem or set symbol before it, and an optional progress track (0–1) under it. Pressable when its `press` event is bound.",
    },
    Message: {
      props: z.object({
        text: z.string(),
        tone: z.enum(["dim", "destructive"]).nullable(),
      }),
      description:
        "A sentence in place of the widget's content — an empty state (`No decks yet.`) or a failure.",
    },
    Footer: {
      props: z.object({
        line: z.string(),
        said: z.string().nullable(),
      }),
      description:
        "A one-line footer under the content: a summary (`3 decks · 2 complete`), with `said` as a quieter tail.",
    },

    // --- charts -----------------------------------------------------------------------------
    PriceChart: {
      props: z.object({
        points: z.array(z.object({ day: z.number(), value: z.number() })),
        summary: z.string(),
      }),
      description:
        "A line of money over time — a card's price or a collection's value. `day` is Unix seconds, oldest first; `value` is in the reader's currency. `summary` describes the line in words for screen readers.",
    },
    ColumnChart: {
      props: z.object({
        columns: z.array(
          z.object({ label: z.string(), count: z.number().int().min(0), said: z.string() }),
        ),
        color: PAINT.nullable(),
        height: z.number().int().min(40).max(240).nullable(),
        mana: z.boolean().nullable(),
      }),
      description:
        "Vertical columns of card counts, each count on its column and its word under it — a mana curve, cards per type, per colour. A screen reader hears `<count> cards <said>` (`said`: `at mana value 2`). `mana: true` draws the words as circled numerals, the deck editor's curve. `height` in px (default 120).",
    },
    PriceHistogram: {
      props: z.object({
        values: z.array(z.number()),
        unit: z.string(),
        marked: z.number().nullable(),
        markedLabel: z.string().nullable(),
        summary: z.string(),
      }),
      description:
        "How a list of prices spreads, as a histogram in the reader's currency — the app bins them. `unit` names what one value is (`cards`). `marked` draws a line at one value with `markedLabel` over it. `summary` describes the spread in words for screen readers.",
    },

    // --- cards and their marks --------------------------------------------------------------
    CardArt: {
      props: z.object({
        cardId: z.string(),
        name: z.string(),
        face: z.number().int().min(0).max(1).nullable(),
        finish: FINISH.nullable(),
        size: z.enum(["sm", "md", "lg"]).nullable(),
      }),
      description:
        "A card's picture, by its printing's Scryfall id (`cardId`). `face` 1 is a double-faced card's back. `finish: foil` draws the foil sheen.",
    },
    CardTile: {
      props: z.object({
        cardId: z.string(),
        name: z.string(),
        setCode: z.string(),
        collectorNumber: z.string(),
        rarity: z.string().nullable(),
        finish: FINISH.nullable(),
        price: z.number().nullable(),
      }),
      description:
        "A card as the app's walls draw it: its picture, and its set, number and rarity under it, with an optional price. Pressable when its `press` event is bound — usually to `openCard`.",
    },
    RarityGem: {
      props: z.object({
        rarity: z.string(),
        withLabel: z.boolean().nullable(),
      }),
      description:
        "A printing's rarity as a coloured gem (`common`, `uncommon`, `rare`, `mythic`).",
    },
    FinishMark: {
      props: z.object({ finish: FINISH }),
      description: "A copy's finish as the app's glyph — sparkles for foil, a gem for etched.",
    },
    SetSymbol: {
      props: z.object({
        setCode: z.string(),
        size: z.enum(["sm", "md", "lg"]).nullable(),
      }),
      description: "A set's expansion symbol, by its code (`mh3`, `lea`).",
    },
    CountTag: {
      props: z.object({
        count: z.number().int(),
        title: z.string(),
      }),
      description:
        "A small count badge, as drawn over card art (`4`). `title` says the count in words (`4 copies`).",
    },
    OwnedBadge: {
      props: z.object({
        owned: z.number().int().min(0),
        wishlisted: z.boolean().nullable(),
      }),
      description:
        "Whether the reader owns a card — a check with the count when `owned` is above 0, a heart when `wishlisted`, nothing otherwise. Drawn over a card's art or beside its name.",
    },
    GameChangerMark: {
      props: z.object({}),
      description:
        "The Commander Game Changer mark, for a card on that list (it counts toward a deck's bracket).",
    },

    // --- inputs: the widget's own state, never the reader's data ----------------------------
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["default", "primary", "quiet"]).nullable(),
      }),
      description:
        "A button. Bind its `press` event to an action (`openView`, `setState` to switch what the widget shows).",
    },
    TextInput: {
      props: z.object({
        label: z.string(),
        value: z.string().nullable(),
        placeholder: z.string().nullable(),
      }),
      description:
        "A one-line text box. Bind `value` with `$bindState` to a path of the widget's own state — e.g. a filter its rows' `visible` conditions read.",
    },
    Select: {
      props: z.object({
        label: z.string(),
        value: z.string().nullable(),
        options: OPTIONS,
      }),
      description:
        "A dropdown of options. Bind `value` with `$bindState` to the widget's own state.",
    },
    Switch: {
      props: z.object({
        label: z.string(),
        checked: z.boolean().nullable(),
      }),
      description: "An on/off switch. Bind `checked` with `$bindState` to the widget's own state.",
    },
    Combobox: {
      props: z.object({
        label: z.string(),
        value: z.string().nullable(),
        options: OPTIONS,
        placeholder: z.string().nullable(),
      }),
      description:
        "A dropdown with a search box that narrows its options as the reader types — for a long list (sets, decks, tags). Bind `value` with `$bindState`.",
    },
    MultiSelect: {
      props: z.object({
        label: z.string(),
        selected: z.array(z.string()).nullable(),
        options: OPTIONS,
        triggerLabel: z.string(),
      }),
      description:
        "A dropdown that stays open while the reader ticks several options. `triggerLabel` is what the closed box says (`Colours`). Bind `selected` (an array of values) with `$bindState`.",
    },
    Segmented: {
      props: z.object({
        label: z.string(),
        value: z.string().nullable(),
        options: OPTIONS,
      }),
      description:
        "A row of two to five segments, exactly one pressed — a short choice always in view (`Week`, `Month`, `Year`). Bind `value` with `$bindState`.",
    },
    RadioGroup: {
      props: z.object({
        label: z.string(),
        value: z.string().nullable(),
        options: z.array(
          z.object({ value: z.string(), label: z.string(), hint: z.string().nullable() }),
        ),
      }),
      description:
        "Radio buttons, one per line, each with an optional dim `hint` under it — a choice that needs a sentence of explanation. Bind `value` with `$bindState`.",
    },
    ToggleChip: {
      props: z.object({
        label: z.string(),
        pressed: z.boolean().nullable(),
        hint: z.string().nullable(),
      }),
      description:
        "A filter chip that is on or off — the Search page's chips. Several in a horizontal Stack make a filter row. `hint` expands a short label (`NM` → `Near mint`). Bind `pressed` with `$bindState`.",
    },
    NumberStepper: {
      props: z.object({
        label: z.string(),
        value: z.number().int().nullable(),
        min: z.number().int().nullable(),
        max: z.number().int().nullable(),
      }),
      description:
        "A whole number with minus and plus buttons — how many rows to show, a threshold. Bind `value` with `$bindState`.",
    },
    // --- the widgets' own settings controls (`WidgetSettingsPanel.tsx`) ------------------------
    FieldGroup: {
      props: z.object({ label: z.string() }),
      slots: ["default"],
      description:
        "A small dim caption over a run of controls, named for a screen reader — how a widget's settings group theirs (`Size`, `Show`).",
    },
    ChoiceChips: {
      props: z.object({
        label: z.string(),
        value: z.string().nullable(),
        options: OPTIONS,
      }),
      description:
        "A captioned row of small chips, exactly one pressed — how a widget's settings offer a pick (`Comfortable`/`Compact`). Wraps onto more lines; quieter than Segmented. Bind `value` with `$bindState`.",
    },
    Checkbox: {
      props: z.object({
        label: z.string(),
        checked: z.boolean().nullable(),
      }),
      description:
        "One line of words with a checkbox at its far end, the words dim while it is off — a widget's `Show` settings. Bind `checked` with `$bindState`.",
    },
    Checklist: {
      props: z.object({
        label: z.string(),
        options: OPTIONS,
        selected: z.array(z.string()).nullable(),
      }),
      description:
        "A captioned list of Checkbox lines, one per option — which of several things to show. Bind `selected` (the ticked values) with `$bindState`.",
    },
    CompactStepper: {
      props: z.object({
        label: z.string(),
        value: z.number().int().nullable(),
        min: z.number().int().nullable(),
        max: z.number().int().nullable(),
      }),
      description:
        "A small bordered box: the label in capitals, `−`, the number, `+` — a widget's `Wide`/`Tall` settings. Smaller than NumberStepper and not typeable. Bind `value` with `$bindState`.",
    },
    Picker: {
      props: z.object({
        label: z.string(),
        options: z.array(
          z.object({ value: z.string(), label: z.string(), hint: z.string().nullable() }),
        ),
        selected: z.array(z.string()).nullable(),
        triggerLabel: z.string(),
      }),
      description:
        "A captioned, compact multi-select — how a widget's settings pick decks, folders or wishlists. Each option may carry a dim `hint` (a deck's format). `triggerLabel` says how many are ticked (`2 decks`, or `None chosen`); searchable past eight options. Bind `selected` with `$bindState`.",
    },
    CardSearch: {
      props: z.object({
        label: z.string().nullable(),
        cards: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              setCode: z.string(),
              collectorNumber: z.string(),
            }),
          )
          .nullable(),
        max: z.number().int().min(1).nullable(),
      }),
      description:
        "A search box over the reader's card database that adds printings to a list, each removable — the Price movers widget's card picker. The one input that reads data of its own (the card search). Bind `cards` with `$bindState`; `max` caps the list (default 100).",
    },
    PriceRange: {
      props: z.object({
        min: z.number().nullable(),
        max: z.number().nullable(),
      }),
      description:
        "Two price boxes and a slider bounding a price in the reader's currency — the Search page's price filter. `null` is open-ended. Bind `min` and `max` with `$bindState`, and read them in `visible` conditions (`lte`/`gte`).",
    },
  },

  actions: {
    openCard: {
      params: z.object({ cardId: z.string() }),
      description: "Open a printing's card details, by its Scryfall id.",
    },
    openDeck: {
      params: z.object({ deckId: z.number().int() }),
      description: "Open a deck in the deck editor, by its id.",
    },
    openFolder: {
      params: z.object({
        scope: SCOPE,
        folderId: z.number().int(),
      }),
      description: "Open a collection or wishlist folder, by its id.",
    },
    openView: {
      params: z.object({ view: z.enum(VIEWS) }),
      description: "Go to one of the app's pages.",
    },
    showSet: {
      params: z.object({ setCode: z.string() }),
      description: "Show every card of a set in the Search page, by the set's code.",
    },
    openPriceHistory: {
      params: z.object({
        cardId: z.string(),
        finish: FINISH,
      }),
      description: "Open a printing's price history chart for one finish.",
    },
    openPrintings: {
      params: z.object({ cardId: z.string(), oracleId: z.string(), name: z.string() }),
      description:
        "Open the dialog of every printing of a card, marking the one `cardId` names. `oracleId` is the card's Oracle id; `name` captions the dialog.",
    },
    searchText: {
      params: z.object({ text: z.string() }),
      description:
        "Go to the Search page showing what `text` finds — a card's name, or the search box's own syntax (`t:creature otag:ramp`).",
    },
    showInCollection: {
      params: z.object({ query: z.string() }),
      description:
        'Go to the Collection page filtered by `query`, in the search box\'s syntax (`!"Lightning Bolt" e:lea`).',
    },
    revealCard: {
      params: z.object({ scope: SCOPE, folderId: z.number().int().nullable(), query: z.string() }),
      description:
        "Go to the Collection or Wishlist folder a card is filed in (`folderId` null: the cards filed in no folder), filtered by a `query` naming it.",
    },
    openDeckFolder: {
      params: z.object({ folderId: z.number().int() }),
      description: "Go to the Decks page standing in one deck folder.",
    },
    openReview: {
      params: z.object({ scope: SCOPE }),
      description: "Go to the Collection or Wishlist showing only the rows flagged for review.",
    },
    openSettings: {
      params: z.object({ panel: z.enum(PANEL_IDS) }),
      description: "Go to Settings with one of its panels in view.",
    },
    goldfish: {
      params: z.object({ deckId: z.number().int() }),
      description:
        "Open a deck and deal a solo practice game of it (goldfishing), on the deck as built. Desktop only.",
    },
    refresh: {
      params: z.object({}),
      description:
        "Read the widget's data again now. It already refreshes whenever the reader's data changes, so this is for an explicit Refresh button.",
    },
  },

  functions: {
    formatPrice: {
      description:
        "Money in the reader's marketplace currency: `{ value: number | null }` → `$2.18` / `2,18 €`; null → em dash.",
    },
    formatNumber: {
      description: "A count with thousands separators: `{ value: number }` → `12,480`.",
    },
    formatPercent: {
      description:
        "A ratio as a whole percentage: `{ value: number }` where 0.25 → `25%`; null → em dash.",
    },
    formatDate: {
      description: "A day in words: `{ seconds: number }` (Unix seconds) → `4 Jul 2026`.",
    },
  },
});

export type Catalog = typeof catalog;

/**
 * **The rules this app adds to json-render's prompt.** Its own rules are written for a page that
 * invents its data; a widget reads the reader's, so the first three replace that half, and the
 * rest are this catalogue's conventions a model would otherwise only meet as a failed validation.
 */
export const CATALOG_RULES: readonly string[] = [
  "This spec draws a widget on the home page of a Magic: The Gathering collection app. A widget is a small tile, a few hundred pixels each way: show one idea, and prefer Figures, Bars and a RowList over long text.",
  "The widget's data is the answer to a GraphQL query written alongside the spec: the answer's `data` object is the state root, so `{ \"$state\": \"/decks/0/name\" }` reads the query's `decks` field. Never write sample data into state for the query's fields — the answer supplies them — and never hardcode a value the query answers.",
  "Seed state only for the widget's own inputs, under `/ui` (what the reader filters, sorts or switches now) and `/settings` (what they configure and keep). Inputs bind only those paths, never a query field: the reader's data is read-only.",
  "Settings go in the widget's settings popover, never on the widget: add a top-level `settingsRoot` to the spec, beside `root`, naming the element the settings face starts from (a Stack of FieldGroup, ChoiceChips, Checkbox, Checklist, CompactStepper, Picker and the like). Its inputs bind `/settings/...`; the app keeps every change as the reader makes it, so there is no Save button. The widget under `root` reads the same `/settings` paths, and no element under `root` is under `settingsRoot`.",
  "Actions only navigate. There is no action that adds, edits or removes the reader's cards, decks, folders or wishlists.",
  'Inside a repeat, `{ "$item": "id" }` in an action\'s params passes the item\'s state path; the navigation actions read it back as the value.',
  "Colours are palette words (`accent`, `up`, `down`, `dim`, `W`, `U`, `B`, `R`, `G`, `C`), never CSS colours or class names.",
  'Money: a numeric value with `money: true`, a Price, or `{ "$computed": "formatPrice", "args": { "value": ... } }` — never a currency symbol written into text. A missing price is null, never 0.',
  "Timestamps are Unix seconds unless a field's description says milliseconds; write them with the `formatDate` function.",
  "Text holding mana or tap symbols (`{2}{R}`, `{T}`) is a ManaText, which draws them as icons.",
  "Optional props take null when not used — never omit them.",
];

/** The prompt a model writes a widget's spec from: json-render's, with {@link CATALOG_RULES}. */
export function catalogPrompt(): string {
  return catalog.prompt({ customRules: [...CATALOG_RULES] });
}

/**
 * **The catalogue as data**, for a reader with no TypeScript — the desktop's MCP server, which hands
 * a model the vocabulary and checks a spec against it. json-render's own `jsonSchema()` is the
 * spec's envelope only (props an open object); this is every component's props and every action's
 * params as JSON Schema, with the slots and the descriptions. **Any prop or param value may instead
 * be an expression object** (`$state`, `$item`, `$index`, `$bindState`, `$bindItem`, `$template`,
 * `$computed`, `$cond`) — a checker accepts one wherever a value goes.
 */
export function catalogContract(): object {
  const { components, actions, functions } = catalog.data;
  return {
    components: Object.fromEntries(
      Object.entries(components).map(([name, def]) => [
        name,
        {
          description: def.description,
          slots: "slots" in def ? def.slots : [],
          props: z.toJSONSchema(def.props),
        },
      ]),
    ),
    actions: Object.fromEntries(
      Object.entries(actions).map(([name, def]) => [
        name,
        { description: def.description, params: z.toJSONSchema(def.params) },
      ]),
    ),
    functions: Object.fromEntries(
      Object.entries(functions).map(([name, def]) => [name, { description: def.description }]),
    ),
  };
}
