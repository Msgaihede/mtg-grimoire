/**
 * **Example specs over the catalogue** — what a generated widget looks like, each with the state a
 * GraphQL answer would hand it. The stories draw them, `catalog.test.tsx` validates and renders
 * them, and they are the worked examples a model can be shown beside `catalog.prompt()`.
 */
import type { Spec } from "@json-render/core";

/** Deck values as figures and a list of decks, each opening its deck — `repeat` over state. */
export const DECKS_EXAMPLE: Spec = {
  root: "body",
  elements: {
    body: {
      type: "Stack",
      props: { direction: null, gap: "md", align: null, justify: null, wrap: null },
      children: ["figures", "list", "footer"],
    },
    figures: {
      type: "Figures",
      children: [],
      props: {
        figures: [
          { label: "Decks", value: { $state: "/deckCount" }, money: null, note: null },
          { label: "Value", value: { $state: "/totalValue" }, money: true, note: null },
        ],
        fill: null,
        divided: true,
      },
    },
    list: {
      type: "RowList",
      props: { label: "Decks" },
      repeat: { statePath: "/decks", key: "id" },
      children: ["deck"],
    },
    deck: {
      type: "Row",
      children: [],
      props: {
        name: { $item: "name" },
        caption: { $item: "formatName" },
        value: { $item: "value" },
        money: true,
        delta: null,
        rarity: null,
        setCode: null,
        track: { $item: "completion" },
      },
      on: { press: { action: "openDeck", params: { deckId: { $item: "id" } } } },
    },
    footer: {
      type: "Footer",
      children: [],
      props: {
        line: {
          $template: "${/deckCount} decks · ${/completeCount} complete",
        },
        said: null,
      },
    },
  },
  state: {
    deckCount: 3,
    completeCount: 1,
    totalValue: 1234.5,
    decks: [
      { id: 7, name: "Atraxa Superfriends", formatName: "Commander", value: 812.4, completion: 1 },
      { id: 9, name: "Mono-Red Burn", formatName: "Modern", value: 301.1, completion: 0.8 },
      { id: 12, name: "Elves", formatName: "Legacy", value: 121, completion: 0.35 },
    ],
  },
};

/** A breakdown as bars, and a switch that hides it — an input writing the widget's own state. */
export const RARITY_EXAMPLE: Spec = {
  root: "body",
  elements: {
    body: {
      type: "Stack",
      props: { direction: null, gap: "sm", align: null, justify: null, wrap: null },
      children: ["toggle", "bars", "total"],
    },
    toggle: {
      type: "Switch",
      children: [],
      props: { label: "Show breakdown", checked: { $bindState: "/show" } },
    },
    bars: {
      type: "Bars",
      children: [],
      props: {
        bars: [
          { label: "Mythic", value: { $state: "/byRarity/mythic" }, color: "R" },
          { label: "Rare", value: { $state: "/byRarity/rare" }, color: "accent" },
          { label: "Uncommon", value: { $state: "/byRarity/uncommon" }, color: "U" },
          { label: "Common", value: { $state: "/byRarity/common" }, color: "dim" },
        ],
        money: true,
        fill: null,
      },
      visible: { $state: "/show", eq: true },
    },
    total: {
      type: "Text",
      children: [],
      props: {
        text: { $computed: "formatPrice", args: { value: { $state: "/total" } } },
        tone: "accent",
        size: "lg",
        mono: true,
        truncate: null,
      },
    },
  },
  state: {
    show: true,
    total: 1534.2,
    byRarity: { mythic: 820, rare: 540.2, uncommon: 120, common: 54 },
  },
};

/** A wall of card tiles, each opening its card. */
export const CARDS_EXAMPLE: Spec = {
  root: "wall",
  elements: {
    wall: {
      type: "Grid",
      props: { columns: 3, gap: "sm" },
      repeat: { statePath: "/cards", key: "id" },
      children: ["tile"],
    },
    tile: {
      type: "CardTile",
      children: [],
      props: {
        cardId: { $item: "id" },
        name: { $item: "name" },
        setCode: { $item: "setCode" },
        collectorNumber: { $item: "collectorNumber" },
        rarity: { $item: "rarity" },
        finish: null,
        price: { $item: "price" },
      },
      on: { press: { action: "openCard", params: { cardId: { $item: "id" } } } },
    },
  },
  state: {
    cards: [
      {
        id: "bolt-lea",
        name: "Lightning Bolt",
        setCode: "lea",
        collectorNumber: "161",
        rarity: "common",
        price: 412.5,
      },
      {
        id: "sol-ring-cmm",
        name: "Sol Ring",
        setCode: "cmm",
        collectorNumber: "400",
        rarity: "uncommon",
        price: 1.2,
      },
      {
        id: "ragavan-mh2",
        name: "Ragavan, Nimble Pilferer",
        setCode: "mh2",
        collectorNumber: "138",
        rarity: "mythic",
        price: null,
      },
    ],
  },
};

/** One of everything the catalogue has, for the gallery story — and a check that each draws. */
export const GALLERY_EXAMPLE: Spec = {
  root: "body",
  elements: {
    body: {
      type: "Stack",
      props: { direction: null, gap: "lg", align: null, justify: null, wrap: null },
      children: ["heading", "texts", "divider", "marks", "chart", "art", "inputs", "message"],
    },
    heading: { type: "Heading", props: { text: "Everything", level: 2 }, children: [] },
    texts: {
      type: "Stack",
      props: { direction: "horizontal", gap: "md", align: "center", justify: null, wrap: true },
      children: ["text", "dim", "mana", "price", "noPrice"],
    },
    text: {
      type: "Text",
      props: { text: "A line of text", tone: null, size: null, mono: null, truncate: null },
      children: [],
    },
    dim: {
      type: "Text",
      props: { text: "a quieter one", tone: "dim", size: "xs", mono: null, truncate: null },
      children: [],
    },
    mana: { type: "ManaText", props: { text: "{2}{R}{R} · {T}: Add {G}." }, children: [] },
    price: { type: "Price", props: { value: 18.4, tone: null }, children: [] },
    noPrice: { type: "Price", props: { value: null, tone: "dim" }, children: [] },
    divider: { type: "Divider", props: {}, children: [] },
    marks: {
      type: "Stack",
      props: { direction: "horizontal", gap: "md", align: "center", justify: null, wrap: true },
      children: ["gem", "finish", "set", "count"],
    },
    gem: { type: "RarityGem", props: { rarity: "mythic", withLabel: true }, children: [] },
    finish: { type: "FinishMark", props: { finish: "foil" }, children: [] },
    set: { type: "SetSymbol", props: { setCode: "mh3", size: "lg" }, children: [] },
    count: { type: "CountTag", props: { count: 4, title: "4 copies" }, children: [] },
    chart: {
      type: "PriceChart",
      props: {
        points: { $state: "/history" },
        summary: "Rising from 2.10 to 3.40 over a month",
      },
      children: [],
    },
    art: {
      type: "Stack",
      props: { direction: "horizontal", gap: "md", align: "start", justify: null, wrap: true },
      children: ["artSm", "artMd"],
    },
    artSm: {
      type: "CardArt",
      props: {
        cardId: { $state: "/cardId" },
        name: "A card",
        face: null,
        finish: null,
        size: "sm",
      },
      children: [],
    },
    artMd: {
      type: "CardArt",
      props: {
        cardId: { $state: "/cardId" },
        name: "A card",
        face: null,
        finish: "foil",
        size: "md",
      },
      children: [],
    },
    inputs: {
      type: "Stack",
      props: { direction: "horizontal", gap: "md", align: "center", justify: null, wrap: true },
      children: ["search", "sort", "switch", "button", "primary", "quiet"],
    },
    search: {
      type: "TextInput",
      props: { label: "Filter", value: { $bindState: "/filter" }, placeholder: "Filter rows" },
      children: [],
    },
    sort: {
      type: "Select",
      props: {
        label: "Sort",
        value: { $bindState: "/sort" },
        options: [
          { value: "value", label: "By value" },
          { value: "name", label: "By name" },
        ],
      },
      children: [],
    },
    switch: {
      type: "Switch",
      props: { label: "Foils only", checked: { $bindState: "/foils" } },
      children: [],
    },
    button: {
      type: "Button",
      props: { label: "Open Decks", variant: null },
      on: { press: { action: "openView", params: { view: "decks" } } },
      children: [],
    },
    primary: { type: "Button", props: { label: "Primary", variant: "primary" }, children: [] },
    quiet: { type: "Button", props: { label: "Quiet", variant: "quiet" }, children: [] },
    message: { type: "Message", props: { text: "No decks yet.", tone: null }, children: [] },
  },
  state: {
    cardId: "",
    filter: "",
    sort: "value",
    foils: false,
    history: Array.from({ length: 30 }, (_, i) => ({
      day: 1_790_000_000 + i * 86_400,
      value: 2.1 + (i / 29) * 1.3 + Math.sin(i / 3) * 0.15,
    })),
  },
};

export const EXAMPLES = {
  decks: DECKS_EXAMPLE,
  rarity: RARITY_EXAMPLE,
  cards: CARDS_EXAMPLE,
  gallery: GALLERY_EXAMPLE,
} as const;
