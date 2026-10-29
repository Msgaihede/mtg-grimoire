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

/** Rows a reader narrows with the widget's own inputs: chips and a price range, read by each
 *  row's `visible` condition. */
export const FILTER_EXAMPLE: Spec = {
  root: "body",
  elements: {
    body: {
      type: "Stack",
      props: { direction: null, gap: "md", align: null, justify: null, wrap: null },
      children: ["filters", "list"],
    },
    filters: {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", align: "center", justify: null, wrap: true },
      children: ["foil", "range"],
    },
    foil: {
      type: "ToggleChip",
      props: { label: "Foil", pressed: { $bindState: "/foilOnly" }, hint: null },
      children: [],
    },
    range: {
      type: "PriceRange",
      props: { min: { $bindState: "/min" }, max: { $bindState: "/max" } },
      children: [],
    },
    list: {
      type: "RowList",
      props: { label: null },
      repeat: { statePath: "/cards", key: "id" },
      children: ["card"],
    },
    card: {
      type: "Row",
      props: {
        name: { $item: "name" },
        caption: { $item: "finish" },
        value: { $item: "price" },
        money: true,
        delta: null,
        rarity: { $item: "rarity" },
        setCode: null,
        track: null,
      },
      visible: {
        $and: [
          { $item: "price", lte: { $state: "/max" } },
          {
            $or: [
              { $state: "/foilOnly", not: true },
              { $item: "foil", eq: true },
            ],
          },
        ],
      },
      children: [],
    },
  },
  state: {
    foilOnly: false,
    min: null,
    max: 100,
    cards: [
      {
        id: "a",
        name: "Lightning Bolt",
        finish: "nonfoil",
        foil: false,
        price: 2.1,
        rarity: "common",
      },
      { id: "b", name: "Sol Ring", finish: "foil", foil: true, price: 4.8, rarity: "uncommon" },
      { id: "c", name: "The One Ring", finish: "foil", foil: true, price: 140, rarity: "mythic" },
    ],
  },
};

/** The widgets' own settings controls, as a generated widget's settings face would draw them. */
export const SETTINGS_EXAMPLE: Spec = {
  root: "body",
  elements: {
    body: {
      type: "Stack",
      props: { direction: null, gap: "md", align: null, justify: null, wrap: null },
      children: ["size", "sort", "show", "figures", "decks", "cards"],
    },
    size: { type: "FieldGroup", props: { label: "Size" }, children: ["sizes"] },
    sizes: {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", align: null, justify: null, wrap: null },
      children: ["wide", "tall"],
    },
    wide: {
      type: "CompactStepper",
      props: { label: "Wide", value: { $bindState: "/w" }, min: 2, max: 12 },
      children: [],
    },
    tall: {
      type: "CompactStepper",
      props: { label: "Tall", value: { $bindState: "/h" }, min: 2, max: 8 },
      children: [],
    },
    sort: {
      type: "ChoiceChips",
      props: {
        label: "Sort",
        value: { $bindState: "/sort" },
        options: [
          { value: "recent", label: "Most recent" },
          { value: "value", label: "Value" },
          { value: "name", label: "Name" },
        ],
      },
      children: [],
    },
    show: { type: "FieldGroup", props: { label: "Show" }, children: ["art", "prices"] },
    art: {
      type: "Checkbox",
      props: { label: "Card art", checked: { $bindState: "/art" } },
      children: [],
    },
    prices: {
      type: "Checkbox",
      props: { label: "Prices", checked: { $bindState: "/prices" } },
      children: [],
    },
    figures: {
      type: "Checklist",
      props: {
        label: "Figures",
        options: [
          { value: "value", label: "Collection value" },
          { value: "cards", label: "Cards" },
          { value: "decks", label: "Decks" },
        ],
        selected: { $bindState: "/figures" },
      },
      children: [],
    },
    decks: {
      type: "Picker",
      props: {
        label: "Decks to track",
        options: [
          { value: "7", label: "Atraxa Superfriends", hint: "Commander" },
          { value: "9", label: "Mono-Red Burn", hint: "Modern" },
          { value: "12", label: "Elves", hint: null },
        ],
        selected: { $bindState: "/deckIds" },
        triggerLabel: { $template: "${/deckCount}" },
      },
      children: [],
    },
    cards: {
      type: "CardSearch",
      props: { label: "Cards to follow", cards: { $bindState: "/cards" }, max: 10 },
      children: [],
    },
  },
  state: {
    w: 4,
    h: 3,
    sort: "recent",
    art: true,
    prices: false,
    figures: ["value", "cards"],
    deckIds: ["9"],
    deckCount: "1 deck",
    cards: [],
  },
};

/** One of everything the catalogue has, for the gallery story — and a check that each draws. */
export const GALLERY_EXAMPLE: Spec = {
  root: "body",
  elements: {
    body: {
      type: "Stack",
      props: { direction: null, gap: "lg", align: null, justify: null, wrap: null },
      children: [
        "heading",
        "texts",
        "divider",
        "marks",
        "chart",
        "stats",
        "art",
        "inputs",
        "moreInputs",
        "message",
      ],
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
      children: ["gem", "finish", "set", "count", "owned", "gameChanger", "hint"],
    },
    owned: { type: "OwnedBadge", props: { owned: 3, wishlisted: null }, children: [] },
    gameChanger: { type: "GameChangerMark", props: {}, children: [] },
    hint: {
      type: "Hint",
      props: { text: "Counted across every folder" },
      children: ["hinted"],
    },
    hinted: {
      type: "Text",
      props: { text: "Hover me", tone: "dim", size: "xs", mono: null, truncate: null },
      children: [],
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
    stats: {
      type: "Grid",
      props: { columns: 2, gap: "md" },
      children: ["curvePanel", "spreadPanel"],
    },
    curvePanel: { type: "Panel", props: { title: "Mana curve" }, children: ["curve"] },
    curve: {
      type: "ColumnChart",
      props: {
        columns: [
          { label: "1", count: 6, said: "at mana value 1" },
          { label: "2", count: 11, said: "at mana value 2" },
          { label: "3", count: 9, said: "at mana value 3" },
          { label: "4", count: 5, said: "at mana value 4" },
          { label: "5", count: 3, said: "at mana value 5" },
          { label: "6", count: 1, said: "at mana value 6" },
        ],
        color: null,
        height: 96,
        mana: true,
      },
      children: [],
    },
    spreadPanel: { type: "Panel", props: { title: "Price spread" }, children: ["spread"] },
    spread: {
      type: "PriceHistogram",
      props: {
        values: { $state: "/prices" },
        unit: "cards",
        marked: 12,
        markedLabel: "Median",
        summary: "40 cards from 0.10 to 80.00",
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
    moreInputs: {
      type: "Grid",
      props: { columns: 2, gap: "md" },
      children: ["combo", "multi", "segmented", "radios", "chip", "stepper", "range"],
    },
    combo: {
      type: "Combobox",
      props: {
        label: "Set",
        value: { $bindState: "/set" },
        options: [
          { value: "mh3", label: "Modern Horizons 3" },
          { value: "lea", label: "Limited Edition Alpha" },
          { value: "cmm", label: "Commander Masters" },
        ],
        placeholder: "Any set",
      },
      children: [],
    },
    multi: {
      type: "MultiSelect",
      props: {
        label: "Colours",
        selected: { $bindState: "/colors" },
        options: [
          { value: "W", label: "White" },
          { value: "U", label: "Blue" },
          { value: "B", label: "Black" },
          { value: "R", label: "Red" },
          { value: "G", label: "Green" },
        ],
        triggerLabel: "Colours",
      },
      children: [],
    },
    segmented: {
      type: "Segmented",
      props: {
        label: "Window",
        value: { $bindState: "/window" },
        options: [
          { value: "7d", label: "Week" },
          { value: "30d", label: "Month" },
          { value: "365d", label: "Year" },
        ],
      },
      children: [],
    },
    radios: {
      type: "RadioGroup",
      props: {
        label: "Count",
        value: { $bindState: "/count" },
        options: [
          { value: "copies", label: "Copies", hint: "Every copy, foils and all" },
          { value: "cards", label: "Cards", hint: null },
        ],
      },
      children: [],
    },
    chip: {
      type: "ToggleChip",
      props: { label: "NM", pressed: { $bindState: "/nearMint" }, hint: "Near mint" },
      children: [],
    },
    stepper: {
      type: "NumberStepper",
      props: { label: "Rows", value: { $bindState: "/rows" }, min: 1, max: 20 },
      children: [],
    },
    range: {
      type: "PriceRange",
      props: { min: { $bindState: "/min" }, max: { $bindState: "/max" } },
      children: [],
    },
    message: { type: "Message", props: { text: "No decks yet.", tone: null }, children: [] },
  },
  state: {
    cardId: "",
    filter: "",
    sort: "value",
    foils: false,
    set: "",
    colors: ["R"],
    window: "30d",
    count: "copies",
    nearMint: false,
    rows: 5,
    min: null,
    max: null,
    prices: Array.from({ length: 40 }, (_, i) => Math.round(0.1 * 1.2 ** i * 100) / 100),
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
  filter: FILTER_EXAMPLE,
  settings: SETTINGS_EXAMPLE,
  gallery: GALLERY_EXAMPLE,
} as const;
