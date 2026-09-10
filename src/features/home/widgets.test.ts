import { describe, expect, it } from "vitest";

import { compareLabels, sortOptions } from "@/lib/options";

import {
  BREAKDOWN_DIMENSIONS,
  DEFAULT_LAYOUT,
  WIDGETS,
  isWidgetKind,
  type BreakdownDimension,
  type WidgetKind,
} from "./widgets";

/**
 * Every kind, written out once so the assertions below can be *about* the union.
 *
 * A `Record<WidgetKind, true>` is the exhaustiveness trick: widening `WidgetKind` without
 * touching this object is a compile error here, so "every kind has a meta" is checked by `tsc`
 * as well as by the assertion that reads it. The runtime half still earns its keep — it is what
 * catches a meta added to the record and then removed from `WIDGETS` by a bad merge.
 */
const EVERY_KIND: Record<WidgetKind, true> = {
  summary: true,
  decks: true,
  folders: true,
  collectionValue: true,
  wishlistValue: true,
  activity: true,
};

const EVERY_DIMENSION: Record<BreakdownDimension, true> = {
  rarity: true,
  color: true,
  set: true,
  finish: true,
};

describe("WIDGETS", () => {
  it("carries exactly one meta for every widget kind", () => {
    const kinds = Object.keys(EVERY_KIND).sort();
    expect(WIDGETS.map((widget) => widget.kind).sort()).toEqual(kinds);
  });

  it("gives every kind words and a width the grid has a column for", () => {
    for (const widget of WIDGETS) {
      expect(widget.label.length, widget.kind).toBeGreaterThan(0);
      expect(widget.description.length, widget.kind).toBeGreaterThan(0);
      expect([1, 2], widget.kind).toContain(widget.defaultSpan);
    }
  });

  // The Add widget menu is an option list like every other in this app, so it is drawn through
  // `sortOptions` rather than in the order the record happens to be written in. What this asserts
  // is that the list survives that trip whole — six rows in, six rows out, alphabetical by the
  // words on screen — because a label the collator cannot compare would reorder the menu on a
  // reader's machine and nothing else would say so.
  it("offers every label as a list through sortOptions", () => {
    const sorted = sortOptions(WIDGETS, (widget) => widget.label);
    expect(sorted).toHaveLength(WIDGETS.length);
    const labels = sorted.map((widget) => widget.label);
    expect([...labels].sort(compareLabels)).toEqual(labels);
  });

  it("does not sort the array it was handed", () => {
    const before = WIDGETS.map((widget) => widget.kind);
    sortOptions(WIDGETS, (widget) => widget.label);
    expect(WIDGETS.map((widget) => widget.kind)).toEqual(before);
  });
});

describe("isWidgetKind", () => {
  it("answers yes for every kind this build draws", () => {
    for (const kind of Object.keys(EVERY_KIND)) {
      expect(isWidgetKind(kind), kind).toBe(true);
    }
  });

  // A kind a newer build invented. It answers `false` here and is still *kept* by `parseLayout` —
  // this predicate is how a renderer decides what to draw, never how a parser decides what to
  // keep. `layout.test.ts` holds the other half.
  it("answers no for a kind this build has never heard of", () => {
    expect(isWidgetKind("somethingFromTheFuture")).toBe(false);
    expect(isWidgetKind("")).toBe(false);
    expect(isWidgetKind("Summary")).toBe(false);
  });

  // The reason it is a `Set` and not `value in WIDGET_META`: `in` walks the prototype, so the
  // object-literal version answers `true` for both of these and a stored `kind: "toString"` would
  // be handed to a renderer that has no component for it.
  it("answers no for a prototype key", () => {
    expect(isWidgetKind("toString")).toBe(false);
    expect(isWidgetKind("constructor")).toBe(false);
    expect(isWidgetKind("__proto__")).toBe(false);
  });
});

describe("DEFAULT_LAYOUT", () => {
  /**
   * ⚠️ **The literal below is `src-tauri/src/home.rs`'s `DEFAULT_LAYOUT` table, transcribed.**
   * The two are one fact in two places and the Rust one is what a first launch gets, so this
   * test's job is to make changing the TypeScript half alone impossible to do quietly. If it
   * goes red, the question is which of the two moved — not how to make the assertion pass.
   */
  it("is home.rs's table, id for id and span for span", () => {
    expect(DEFAULT_LAYOUT).toEqual({
      version: 1,
      widgets: [
        { id: "summary", kind: "summary", span: 2, config: null },
        { id: "decks", kind: "decks", span: 1, config: null },
        { id: "activity", kind: "activity", span: 1, config: null },
        { id: "collectionValue", kind: "collectionValue", span: 1, config: null },
        { id: "wishlistValue", kind: "wishlistValue", span: 1, config: null },
        { id: "folders", kind: "folders", span: 2, config: null },
      ],
    });
  });

  // The id is what identifies a widget — `removeWidget`, `moveWidget`, `setSpan` and `setConfig`
  // all key on it — so two widgets sharing one would be a card the reader could not remove
  // without removing the other.
  it("mints a unique id for every widget in it", () => {
    const ids = DEFAULT_LAYOUT.widgets.map((widget) => widget.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("seeds only kinds this build can draw", () => {
    for (const widget of DEFAULT_LAYOUT.widgets) {
      expect(isWidgetKind(widget.kind), widget.kind).toBe(true);
    }
  });

  // `home.rs` refuses a span outside `MIN_SPAN..=MAX_SPAN` on the write side, so a seed that
  // carried one would be a default layout this app could not save back.
  it("seeds no span the grid has no column for", () => {
    for (const widget of DEFAULT_LAYOUT.widgets) {
      expect([1, 2], widget.id).toContain(widget.span);
    }
  });
});

describe("BREAKDOWN_DIMENSIONS", () => {
  it("offers exactly the four dimensions the breakdown commands accept", () => {
    const ids = Object.keys(EVERY_DIMENSION).sort();
    expect(BREAKDOWN_DIMENSIONS.map((dimension) => dimension.id).sort()).toEqual(ids);
  });

  it("gives every dimension words", () => {
    for (const dimension of BREAKDOWN_DIMENSIONS) {
      expect(dimension.label.length, dimension.id).toBeGreaterThan(0);
    }
  });

  it("offers every label as a list through sortOptions", () => {
    const sorted = sortOptions(BREAKDOWN_DIMENSIONS, (dimension) => dimension.label);
    expect(sorted).toHaveLength(BREAKDOWN_DIMENSIONS.length);
    const labels = sorted.map((dimension) => dimension.label);
    expect([...labels].sort(compareLabels)).toEqual(labels);
  });
});
