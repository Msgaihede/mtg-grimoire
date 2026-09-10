/**
 * What a home-page widget *is* — the vocabulary, one meta row per kind, and the layout a
 * database nobody has customised answers with.
 *
 * **This is the whole of the widget vocabulary and it appears in no Rust file.**
 * `src-tauri/src/home.rs` validates the *shape* of a layout document — a non-empty `id`, a
 * non-empty `kind`, a `span` inside the grid, a size cap — and refuses a kind never, because a
 * kind it has never heard of is the case that module is built around rather than an error. So
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
 *   than an `undefined` discovered when somebody opens the Add widget menu.
 */

import type { HomeLayout } from "@/lib/ipc";

/**
 * The six kinds this build can draw.
 *
 * Adding a seventh means a member here, a row in {@link WIDGET_META} (which will not compile
 * without one) and a component — and it means nothing at all to Rust, which stores whatever
 * string it is handed.
 */
export type WidgetKind =
  | "summary"
  | "decks"
  | "folders"
  | "collectionValue"
  | "wishlistValue"
  | "activity";

/**
 * Which column the two value widgets group their bars over.
 *
 * **The one word in this file that also exists in Rust**, as four `match` arms on a `&str` in
 * each breakdown command, refusing anything else. That is a fact about which SQL columns can be
 * grouped, not a vocabulary about widgets, so the duplication is not the kind {@link WidgetKind}
 * exists to avoid.
 */
export type BreakdownDimension = "rarity" | "color" | "set" | "finish";

/** One row of the Add widget menu, and what a newly-added widget of that kind starts as. */
export interface WidgetMeta {
  kind: WidgetKind;
  /** The words on screen — what the menu row says and what the card is titled. */
  label: string;
  /** One sentence under the label, saying what the widget draws. */
  description: string;
  /**
   * How wide a *newly added* widget of this kind is. {@link DEFAULT_LAYOUT} is a separate fact
   * and is allowed to disagree — that one mirrors Rust's seed table.
   */
  defaultSpan: 1 | 2;
}

/**
 * Every kind's meta, keyed by the kind.
 *
 * **A `Record<WidgetKind, …>` rather than an array, and that is the fence**: a seventh member on
 * {@link WidgetKind} with no row here is a compile error at this object, where an array would
 * hand the menu six rows and the seventh widget an `undefined` meta at the moment a reader
 * pressed it. The `Omit<WidgetMeta, "kind">` is what stops the key and the `kind` field
 * disagreeing — {@link WIDGETS} writes the field from the key.
 *
 * The insertion order below is the order the Add widget menu is *built* in; what it is *drawn*
 * in is `sortOptions`', like every other option list in this app.
 */
const WIDGET_META: Record<WidgetKind, Omit<WidgetMeta, "kind">> = {
  summary: {
    label: "Summary",
    description: "Copies and value across your collection, your decks and your wishlist.",
    defaultSpan: 2,
  },
  decks: {
    label: "Decks",
    description: "Shortcuts to the decks you pin, or to the ones you changed most recently.",
    defaultSpan: 1,
  },
  folders: {
    label: "Folders",
    description: "Shortcuts to collection and wishlist folders, with their counts and value.",
    defaultSpan: 2,
  },
  collectionValue: {
    label: "Collection value",
    description: "What your collection is worth, split by rarity, color, set or finish.",
    defaultSpan: 1,
  },
  wishlistValue: {
    label: "Wishlist value",
    description: "What your wishlist would cost, split by rarity, color, set or finish.",
    defaultSpan: 1,
  },
  activity: {
    label: "Activity",
    description: "What you have added, moved and removed, grouped by day.",
    defaultSpan: 1,
  },
};

/**
 * The metas as a list, `kind` filled in from the key.
 *
 * Built rather than written out a second time, so a label can only ever be edited in one place
 * and the key and the `kind` field cannot drift apart.
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

/**
 * The layout a reader who has never customised anything gets.
 *
 * ⚠️ **This and `home.rs`'s `DEFAULT_LAYOUT` are one fact written in two places, and the Rust
 * one is what a first launch actually gets** — `home::stored` answers it for a missing row and
 * for a row it cannot parse, long before this file is loaded. This copy is what `parseLayout`
 * falls back to when the *webview* is handed something that is not a layout, and what `Reset`
 * writes. **Changing one means changing the other**, id for id, kind for kind, span for span and
 * in the same order; `widgets.test.ts` pins this half against a literal so the change cannot be
 * made here by accident, and `home.rs`'s table is the one to copy from.
 *
 * **The ids are the kinds** because a default layout holds each widget once — `home.rs` says the
 * same. A reader who adds a second `decks` widget gets a minted id from `newWidgetId`, and the
 * id is what identifies a widget, so two `decks` widgets pinning two sets of decks is a layout
 * to build rather than a case to refuse.
 *
 * `config` is `null` throughout, which is what `serde_json::Value::Null` serialises to: every
 * kind's default behaviour is what an absent config means, so a seed carrying settings would be
 * this file deciding something the widget already decides for itself.
 */
export const DEFAULT_LAYOUT: HomeLayout = {
  version: 1,
  widgets: [
    { id: "summary", kind: "summary", span: 2, config: null },
    { id: "decks", kind: "decks", span: 1, config: null },
    { id: "activity", kind: "activity", span: 1, config: null },
    { id: "collectionValue", kind: "collectionValue", span: 1, config: null },
    { id: "wishlistValue", kind: "wishlistValue", span: 1, config: null },
    { id: "folders", kind: "folders", span: 2, config: null },
  ],
};

/** What each dimension is called on screen. A `Record` for {@link WIDGET_META}'s reason. */
const DIMENSION_LABEL: Record<BreakdownDimension, string> = {
  rarity: "Rarity",
  color: "Color",
  set: "Set",
  finish: "Finish",
};

/**
 * The four ways the two value widgets can slice a total, as an option list.
 *
 * Offered through `sortOptions` like every other option list in this app — the order here is the
 * order the record was written in and is not the order a reader sees.
 */
export const BREAKDOWN_DIMENSIONS: readonly { id: BreakdownDimension; label: string }[] =
  Object.entries(DIMENSION_LABEL).map(([id, label]) => ({
    id: id as BreakdownDimension,
    label,
  }));
