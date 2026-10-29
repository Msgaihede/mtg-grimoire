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
 * text, and four inputs. Nothing here fetches: data arrives through the spec's `$state`
 * expressions, so a component is a picture of facts it is handed.
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
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/** The gap scale every layout component shares. */
const GAP = z.enum(["none", "sm", "md", "lg"]).nullable();

const FINISH = z.enum(["nonfoil", "foil", "etched"]);

/** A colour a bar or a figure may take: the app's accent, rising and falling, and the five mana
 *  colours plus colourless. Never a free colour — the widget wears the app's palette. */
const PAINT = z.enum(["accent", "up", "down", "dim", "W", "U", "B", "R", "G", "C"]);

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
        options: z.array(z.object({ value: z.string(), label: z.string() })),
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
        scope: z.enum(["collection", "wishlist"]),
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
