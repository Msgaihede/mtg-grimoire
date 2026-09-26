/**
 * What a home-page widget *is* — the vocabulary, one meta row per kind, and the layout a
 * database nobody has customised answers with.
 *
 * **This is the whole of the widget vocabulary and it appears in no Rust file.**
 * `src-tauri/src/home.rs` validates the *shape* of a layout document — a non-empty `id`, a
 * non-empty `kind`, a footprint inside its bounds, a size cap — and refuses a kind never, because
 * a kind it has never heard of is the case that module is built around rather than an error. So
 * `HomeWidget.kind` is a free `string` on the wire and this file is the only place that says
 * which strings this build can draw. Rust supplies the row; the page draws the conclusion.
 *
 * Two things follow, and both are somewhere the tempting shortcut is wrong:
 *
 * * **{@link isWidgetKind} is how a *renderer* decides what to draw, and never how a *parser*
 *   decides what to keep.** `layout.ts`'s `parseLayout` keeps a kind this build has never heard
 *   of, exactly as `home.rs` does, so that an older build pointed at a newer build's row
 *   rearranges the widgets it knows and does not quietly empty the row of the ones it does not.
 * * **Adding a kind without a meta must not compile**, which is what {@link WIDGET_META} being a
 *   `Record<WidgetKind, …>` buys: widening the union alone is a type error at the record rather
 *   than an `undefined` discovered when somebody opens the catalogue.
 *
 * ## Every kind declares what a reader can change about it
 *
 * **A kind grows a setting by adding a row here, never by the settings panel learning a special
 * case.** `picks` are one-of-several choices and `toggles` are on/off switches, and both are
 * stored in the widget's own `config` under the key named on the row — `config` is opaque to Rust
 * and survives every build, where a field beside it would be dropped by any build that predates
 * it. Three settings every kind has are not rows, because the panel draws them for every card:
 * the footprint (the two size steppers), the density, and the title.
 */

import type { HomeLayout } from "@/lib/ipc";

/**
 * The kinds this build can draw.
 *
 * Adding one means a member here, a row in {@link WIDGET_META} (which will not compile without
 * one) and a component — and it means nothing at all to Rust, which stores whatever string it is
 * handed. **How many there are is `WIDGET_META`'s to answer and is not written down here**: this
 * comment said *eleven* while it was true and would have been wrong the day round two landed.
 */
export type WidgetKind =
  | "summary"
  | "decks"
  | "folders"
  | "collectionValue"
  | "wishlistValue"
  | "activity"
  | "recentCards"
  | "setCompletion"
  | "priceMovers"
  | "newPrintings"
  | "stickyNotes"
  | "deckCompletion"
  | "toReview"
  | "wishlistSavings"
  | "comingSoon";

/**
 * Which column the two value widgets group their bars over.
 *
 * **The one word in this file that also exists in Rust**, as four `match` arms on a `&str` in
 * each breakdown command, refusing anything else. That is a fact about which SQL columns can be
 * grouped, not a vocabulary about widgets, so the duplication is not the kind {@link WidgetKind}
 * exists to avoid.
 */
export type BreakdownDimension = "rarity" | "color" | "set" | "finish";

/** One choice a pick offers: the stored value and the words on screen. A value is a string or a
 *  number because one stored config already holds a number (`activity`'s `limit`). */
export interface PickOption {
  id: string | number;
  label: string;
}

/**
 * A one-of-several setting, stored as `config[key]`.
 *
 * `options[0]` is the default a widget that has never been configured reads — **unless `dflt`
 * names another**, which is how `activity` defaults to fifty changes while listing twenty-five
 * first. A stored value no option carries reads as the default too, so a word a newer build wrote
 * cannot reach a widget that has no branch for it.
 */
export interface WidgetPick {
  key: string;
  label: string;
  options: readonly PickOption[];
  dflt?: string | number;
}

/**
 * An on/off setting, stored as `config[key]`. **The default is stored as absence, whichever way
 * round the default runs** — a reader who has changed nothing stores nothing, so an upgrade that
 * moves a default moves it for them too.
 *
 * `dflt` is `true` when absent, which is every toggle shipped before this field existed: a reader
 * who has changed nothing sees the widget's whole face, which is the one the catalogue showed
 * them. A kind names `dflt: false` where the *off* state is the honest starting point — a switch
 * whose subject the reader has to ask for, and which would read as a double negative if spelled
 * as a `hide…` key on the panel.
 */
export interface WidgetToggle {
  key: string;
  label: string;
  dflt?: boolean;
}

/** A footprint in grid cells: `[wide, tall]`. */
export type Footprint = readonly [number, number];

/** One row of the catalogue, and what a newly-added widget of that kind starts as. */
export interface WidgetMeta {
  kind: WidgetKind;
  /** The words on screen — the catalogue entry, and the card's title until the reader renames it. */
  label: string;
  /** One sentence under the label, saying what the widget draws. */
  description: string;
  /** The footprint a widget of this kind arrives at. */
  def: Footprint;
  /** The smallest it may be pulled to. */
  min: Footprint;
  /** The largest. A width past the grid's own column count is clamped to the grid. */
  max: Footprint;
  picks: readonly WidgetPick[];
  toggles: readonly WidgetToggle[];
  /**
   * Which pick's current label is drawn beside the card's title — the small uppercase word that
   * says *Rarity* over a value chart — once the card is wide enough to carry one. Absent for a kind
   * whose picks say nothing a glance at the card needs.
   */
  chip?: string;
}

/** The four ways a value widget can slice a total, as pick options. `Colour` is the design's
 *  spelling and this app's: every other colour word on screen is British. */
const DIMENSION_OPTIONS: readonly PickOption[] = [
  { id: "rarity", label: "Rarity" },
  { id: "color", label: "Colour" },
  { id: "set", label: "Set" },
  { id: "finish", label: "Finish" },
];

/** The two value widgets' three shared rows. `dimension` rather than the design's `scope`,
 *  because that is the key every value widget configured before the grid already stores. */
const VALUE_PICKS: readonly WidgetPick[] = [
  { key: "dimension", label: "Split by", options: DIMENSION_OPTIONS },
  {
    key: "chart",
    label: "Chart",
    options: [
      { id: "bars", label: "Bars" },
      { id: "list", label: "List" },
    ],
  },
];

/**
 * Every kind's meta, keyed by the kind.
 *
 * **A `Record<WidgetKind, …>` rather than an array, and that is the fence**: a new member on
 * {@link WidgetKind} with no row here is a compile error at this object. The `Omit` is what stops
 * the key and the `kind` field disagreeing — {@link WIDGETS} writes the field from the key.
 */
const WIDGET_META: Record<WidgetKind, Omit<WidgetMeta, "kind">> = {
  summary: {
    label: "Summary",
    description: "Copies and value across your collection, your decks and your wishlist.",
    def: [4, 2],
    min: [2, 1],
    max: [8, 3],
    picks: [],
    toggles: [],
  },
  collectionValue: {
    label: "Collection value",
    description: "What your collection is worth, split by rarity, colour, set or finish.",
    def: [2, 3],
    min: [2, 2],
    max: [4, 6],
    picks: VALUE_PICKS,
    toggles: [{ key: "figures", label: "Show totals" }],
    chip: "dimension",
  },
  wishlistValue: {
    label: "Wishlist value",
    description: "What your wishlist would cost, split the same four ways.",
    def: [2, 3],
    min: [2, 2],
    max: [4, 6],
    picks: VALUE_PICKS,
    toggles: [{ key: "figures", label: "Show totals" }],
    chip: "dimension",
  },
  decks: {
    label: "Decks",
    description: "Shortcuts to the decks you pin, or the ones you changed most recently.",
    def: [3, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [
      {
        key: "scope",
        label: "Which decks",
        options: [
          { id: "recent", label: "Most recent" },
          { id: "pinned", label: "Pinned" },
          { id: "archived", label: "Archived too" },
        ],
      },
    ],
    toggles: [{ key: "art", label: "Cover art" }],
    chip: "scope",
  },
  folders: {
    label: "Folders",
    description: "Collection and wishlist folders, with their counts and value.",
    def: [4, 2],
    min: [2, 2],
    max: [8, 4],
    picks: [
      {
        key: "cabinets",
        label: "Cabinets",
        options: [
          { id: "both", label: "Both" },
          { id: "collection", label: "Collection" },
          { id: "wishlist", label: "Wishlist" },
        ],
      },
    ],
    toggles: [{ key: "captions", label: "Show which cabinet" }],
    chip: "cabinets",
  },
  activity: {
    label: "Activity",
    description: "What you have added, moved and removed, grouped by day.",
    def: [3, 3],
    min: [2, 2],
    max: [4, 8],
    picks: [
      {
        key: "limit",
        label: "Changes to show",
        dflt: 50,
        options: [
          { id: 25, label: "25" },
          { id: 50, label: "50" },
          { id: 100, label: "100" },
        ],
      },
    ],
    toggles: [{ key: "times", label: "Show times" }],
  },
  priceMovers: {
    label: "Price movers",
    description: "The biggest gainers and losers in your collection over a week, a month or ever.",
    def: [2, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [
      {
        key: "window",
        label: "Window",
        options: [
          { id: "7d", label: "7 days" },
          { id: "30d", label: "30 days" },
          { id: "all", label: "All time" },
        ],
      },
      {
        key: "direction",
        label: "Direction",
        options: [
          { id: "both", label: "Both" },
          { id: "up", label: "Gainers" },
          { id: "down", label: "Losers" },
        ],
      },
    ],
    toggles: [],
    chip: "window",
  },
  setCompletion: {
    label: "Set completion",
    description: "How close each set you collect is to being complete.",
    def: [2, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [
      {
        key: "sort",
        label: "Order",
        options: [
          { id: "complete", label: "Nearest complete" },
          { id: "cards", label: "Most cards" },
          { id: "name", label: "Alphabetical" },
        ],
      },
    ],
    toggles: [{ key: "bars", label: "Progress bars" }],
    chip: "sort",
  },
  recentCards: {
    label: "Recently viewed",
    description: "The last cards you opened, as art you can press.",
    def: [4, 2],
    min: [2, 2],
    max: [8, 3],
    picks: [
      {
        key: "count",
        label: "Cards to show",
        dflt: 8,
        options: [
          { id: 4, label: "4" },
          { id: 6, label: "6" },
          { id: 8, label: "8" },
        ],
      },
    ],
    toggles: [{ key: "names", label: "Show names" }],
  },
  /**
   * The reader's own prose. Insertion order is the catalogue's order, and this and
   * `newPrintings` directly below are its newest pair — that one landed on `main` while this was
   * being written, so which of the two is last is an accident of merge order and nothing reads it.
   *
   * `min` is `[3, 2]` where every other kind's is `[2, 2]` or smaller, and that is the one figure
   * here doing real work rather than copying a neighbour: at a two-cell width the Board's tiles are
   * about 96px across and every note's name truncates, so the size is made unreachable rather than
   * drawn badly. `boundsOf` is what enforces it, against the steppers, the resize corner and the
   * arrow keys alike.
   *
   * All three toggles read correctly **on**, and that is now a choice rather than the only
   * shape available: `dflt` landed on {@link WidgetToggle} with `newPrintings`, which starts two
   * of its three off. These three stay on because each names something a reader would miss if it
   * were hidden, not something they have to ask for.
   */
  stickyNotes: {
    label: "Notes",
    description: "Sticky notes you write yourself, in the editor deck notes already use.",
    def: [4, 3],
    min: [3, 2],
    max: [8, 6],
    picks: [
      {
        key: "layout",
        label: "Layout",
        options: [
          { id: "board", label: "Board" },
          { id: "pad", label: "Pad" },
        ],
      },
    ],
    toggles: [
      { key: "dates", label: "Show edited date" },
      { key: "strip", label: "Show colour strip" },
      { key: "pinned", label: "Pinned note first" },
    ],
    chip: "layout",
  },
  newPrintings: {
    label: "New printings",
    description: "Reprints of cards your decks already hold, newest first.",
    def: [3, 3],
    min: [2, 2],
    max: [8, 12],
    picks: [
      {
        key: "scope",
        label: "Which decks",
        // Two options, not three: there is no `decks.pinned`, and on the Decks widget `Pinned`
        // *is* the checklist — so a third option would be this one under a second name.
        options: [
          { id: "all", label: "All decks" },
          { id: "chosen", label: "Chosen…" },
        ],
      },
      {
        key: "window",
        label: "Window",
        dflt: 90,
        options: [
          { id: 30, label: "30 days" },
          { id: 90, label: "90 days" },
          { id: 365, label: "A year" },
        ],
      },
      {
        // **English is `options[0]` and therefore the default**, which is what keeps one reprint
        // to one row for a reader who changes nothing — `cards.id` is one printing *in one
        // language*, so an unfiltered feed answers a ten-language set as ten rows of one reprint.
        // The other two options are that reader changing their mind on purpose.
        key: "langs",
        label: "Languages",
        options: [
          { id: "en", label: "English" },
          { id: "all", label: "Every language" },
          { id: "chosen", label: "Chosen…" },
        ],
      },
    ],
    // Two of the three start off, which is what {@link WidgetToggle.dflt} was added for: a
    // virtual deck is a pile the reader does not own and a basic land is reprinted in every set,
    // so both are subjects to be asked for rather than face to be hidden. `theory` keeps the
    // shipped default — a theory card is one the reader intends to own, which is precisely the
    // reader who wants to know it was reprinted.
    toggles: [
      { key: "virtual", label: "Virtual decks", dflt: false },
      { key: "theory", label: "Theory cards" },
      { key: "basics", label: "Basic lands", dflt: false },
    ],
    chip: "window",
  },
  /**
   * **Round two (2026-09-26), the catalogue's newest four** — the spec is
   * `docs/superpowers/specs/2026-09-26-home-widgets-round-two-design.md` §2.1 and the footprints
   * are the design canvas's. `DEFAULT_LAYOUT` moves for none of them: it fills an eight-by-seven
   * rectangle exactly, and a new kind in it would break the rectangle.
   *
   * **`scope`'s label and its two options are the `decks` row's words, and that is load-bearing.**
   * A `Pinned` card draws `DecksWidget`'s own checklist through `extraSettings`, and that component
   * words its hint off the *decks* row (`Choose Pinned under Which decks…`) — so this row says the
   * same words or the reused sentence names a control this card does not have. `widgets.test.ts`
   * pins the pair. No `Archived too`: a deck put away is not one a reader is finishing.
   *
   * `complete` starts off, `newPrintings`' `dflt: false` precedent: a finished deck is counted in
   * the footer rather than listed, and a reader who wants the finished ones listed asks for them.
   */
  deckCompletion: {
    label: "Deck completion",
    description: "How much of each deck you own, and what the rest would cost.",
    def: [3, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [
      {
        key: "scope",
        label: "Which decks",
        options: [
          { id: "recent", label: "Most recent" },
          { id: "pinned", label: "Pinned" },
        ],
      },
      {
        key: "order",
        label: "Order",
        options: [
          { id: "done", label: "Nearest done" },
          { id: "cheapest", label: "Cheapest to finish" },
          { id: "name", label: "Name" },
        ],
      },
    ],
    toggles: [{ key: "complete", label: "Complete decks", dflt: false }],
    chip: "order",
  },
  /**
   * One row per place something is waiting, each drawn only when its count is above zero. `removed`
   * stays on by default and exists because Recently removed is a holding area rather than a
   * problem: a reader who uses it as an archive can take the row away.
   */
  toReview: {
    label: "To review",
    description: "Scanned cards, flagged rows and recently removed copies waiting for you.",
    def: [2, 3],
    min: [2, 2],
    max: [4, 4],
    picks: [],
    toggles: [{ key: "removed", label: "Recently removed" }],
  },
  /** The price sweep's own plan over the whole wishlist, read and never written. No settings:
   *  the question is fixed, which is what lets its press open the same sweep. */
  wishlistSavings: {
    label: "Wishlist savings",
    description: "What your pinned wishes would save on the cheapest printing of each card.",
    def: [3, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [],
    toggles: [],
  },
  /**
   * Sets not released yet, soonest first. `window`'s options, words and `dflt: 90` are
   * `newPrintings`' exactly, so a reader who has set one has learnt the other.
   */
  comingSoon: {
    label: "Coming soon",
    description: "Unreleased sets, how much of each is previewed, and reprints of your deck cards.",
    def: [4, 2],
    min: [2, 2],
    max: [8, 4],
    picks: [
      {
        key: "window",
        label: "Window",
        dflt: 90,
        options: [
          { id: 30, label: "30 days" },
          { id: 90, label: "90 days" },
          { id: 365, label: "A year" },
        ],
      },
    ],
    toggles: [],
    chip: "window",
  },
};

/**
 * The metas as a list, `kind` filled in from the key.
 *
 * Built rather than written out a second time, so a label can only ever be edited in one place
 * and the key and the `kind` field cannot drift apart. The insertion order above is the
 * catalogue's order.
 */
export const WIDGETS: readonly WidgetMeta[] = Object.entries(WIDGET_META).map(([kind, meta]) => ({
  kind: kind as WidgetKind,
  ...meta,
}));

/** The kinds this build knows, as a set, for {@link isWidgetKind}. */
const KNOWN_KINDS = new Set<string>(Object.keys(WIDGET_META));

/**
 * Can this build draw a widget of this kind?
 *
 * **A renderer's question, never a parser's.** A stored kind that answers `false` here is a
 * widget a newer build wrote; it is kept in the document and drawn as a placeholder, and nothing
 * about that is an error. See the module doc.
 *
 * A `Set` rather than `value in WIDGET_META`, because `in` walks the prototype and would answer
 * `true` for `"toString"` and `"constructor"`.
 */
export function isWidgetKind(value: string): value is WidgetKind {
  return KNOWN_KINDS.has(value);
}

/** The meta for a kind this build knows. */
export function widgetMeta(kind: WidgetKind): WidgetMeta {
  return { kind, ...WIDGET_META[kind] };
}

/**
 * The bounds a widget of a kind this build **cannot** draw is held to.
 *
 * Wide enough to carry its placeholder's sentence and nothing more opinionated: a newer build
 * decided that kind's real bounds, and this one's only job is to keep it on the page and movable.
 */
export const UNKNOWN_BOUNDS: Pick<WidgetMeta, "def" | "min" | "max"> = {
  def: [2, 2],
  min: [1, 1],
  max: [8, 8],
};

/** A kind's footprint bounds, for any stored kind string. */
export function boundsOf(kind: string): Pick<WidgetMeta, "def" | "min" | "max"> {
  return isWidgetKind(kind) ? WIDGET_META[kind] : UNKNOWN_BOUNDS;
}

/**
 * The layout a reader who has never customised anything gets.
 *
 * ⚠️ **This and `home.rs`'s `DEFAULT_LAYOUT` are one fact written in two places, and the Rust
 * one is what a first launch actually gets** — `home::stored` answers it for a missing row and
 * for a row it cannot parse, long before this file is loaded. This copy is what `parseLayout`
 * falls back to when the *webview* is handed something that is not a layout, and what `Reset`
 * writes. **Changing one means changing the other**, id for id, kind for kind, cell for cell and
 * in the same order; `widgets.test.ts` pins this half against a literal.
 *
 * Eight columns is the narrowest grid the page draws, so a default that fits eight fits every
 * window. The arrangement is the design's: two half-width bands, three tall tiles, and a closing
 * row of three — which fills the eight-by-seven rectangle exactly, so a first launch shows no hole.
 *
 * `span` is the version-1 width an **older** build reads — see `HomeWidget.span`.
 * `config` is `null` throughout: every kind's default behaviour is what an absent config means.
 */
export const DEFAULT_LAYOUT: HomeLayout = {
  version: 2,
  widgets: [
    { id: "summary", kind: "summary", x: 0, y: 0, w: 4, h: 2, span: 1, config: null },
    { id: "recentCards", kind: "recentCards", x: 4, y: 0, w: 4, h: 2, span: 1, config: null },
    { id: "decks", kind: "decks", x: 0, y: 2, w: 3, h: 3, span: 1, config: null },
    { id: "activity", kind: "activity", x: 3, y: 2, w: 3, h: 3, span: 1, config: null },
    {
      id: "collectionValue",
      kind: "collectionValue",
      x: 6,
      y: 2,
      w: 2,
      h: 3,
      span: 1,
      config: null,
    },
    { id: "folders", kind: "folders", x: 0, y: 5, w: 4, h: 2, span: 1, config: null },
    { id: "priceMovers", kind: "priceMovers", x: 4, y: 5, w: 2, h: 2, span: 1, config: null },
    { id: "setCompletion", kind: "setCompletion", x: 6, y: 5, w: 2, h: 2, span: 1, config: null },
  ],
};

/** What each dimension is called on screen, read off the pick so the chip and the settings row
 *  cannot come to disagree. */
export const BREAKDOWN_DIMENSIONS: readonly { id: BreakdownDimension; label: string }[] =
  DIMENSION_OPTIONS.map((option) => ({
    id: option.id as BreakdownDimension,
    label: option.label,
  }));
