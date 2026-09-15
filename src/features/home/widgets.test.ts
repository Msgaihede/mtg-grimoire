import { describe, expect, it } from "vitest";

import { normalise, overlaps, sameGeometry, spanFor, toStored } from "./layout";
import {
  boundsOf,
  BREAKDOWN_DIMENSIONS,
  DEFAULT_LAYOUT,
  isWidgetKind,
  UNKNOWN_BOUNDS,
  widgetMeta,
  WIDGETS,
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
  recentCards: true,
  setCompletion: true,
  priceMovers: true,
};

const EVERY_DIMENSION: Record<BreakdownDimension, true> = {
  rarity: true,
  color: true,
  set: true,
  finish: true,
};

/** The keys the settings panel draws for every kind itself. A pick or a toggle stored under one
 *  of these would be two controls writing one field. */
const RESERVED_KEYS = ["title", "density"];

/** The grid the page is never narrower than. Written out, not imported: `layout.ts`'s constant is
 *  one of the things this file is checking the registry against. */
const NARROWEST = 8;

describe("WIDGETS", () => {
  it("carries exactly one meta for every widget kind, keyed by its own kind", () => {
    const kinds = Object.keys(EVERY_KIND).sort();
    expect(WIDGETS.map((widget) => widget.kind).sort()).toEqual(kinds);
    for (const kind of Object.keys(EVERY_KIND) as WidgetKind[]) {
      expect(widgetMeta(kind).kind).toBe(kind);
    }
  });

  it("gives every kind words", () => {
    for (const widget of WIDGETS) {
      expect(widget.label.trim().length, widget.kind).toBeGreaterThan(0);
      expect(widget.description.trim().length, widget.kind).toBeGreaterThan(0);
    }
  });

  // `bounded` and every resize step clamp *into* `min..max`; a `def` outside it would be a widget
  // that changed size the first time anybody touched it, and a `min` of zero one that could be
  // resized out of existence.
  it("gives every kind whole footprints with def inside min..max and min at least one", () => {
    for (const { kind, def, min, max } of WIDGETS) {
      for (const axis of [0, 1]) {
        for (const value of [def[axis], min[axis], max[axis]]) {
          expect(Number.isInteger(value), `${kind} axis ${axis}`).toBe(true);
        }
        expect(min[axis], `${kind} min axis ${axis}`).toBeGreaterThanOrEqual(1);
        expect(def[axis], `${kind} def axis ${axis}`).toBeGreaterThanOrEqual(min[axis]);
        expect(def[axis], `${kind} def axis ${axis}`).toBeLessThanOrEqual(max[axis]);
      }
    }
  });

  // A new widget arrives at `def`. A default wider than the narrowest grid is clamped on arrival,
  // which makes the catalogue's preview a size no page will ever draw.
  it("gives every kind a default that fits the narrowest grid", () => {
    for (const { kind, def, min } of WIDGETS) {
      expect(def[0], kind).toBeLessThanOrEqual(NARROWEST);
      expect(min[0], kind).toBeLessThanOrEqual(NARROWEST);
    }
  });

  it("gives every pick options, a default it offers, and no key another setting uses", () => {
    for (const { kind, picks, toggles } of WIDGETS) {
      const keys = [...picks.map((pick) => pick.key), ...toggles.map((toggle) => toggle.key)];
      expect(new Set(keys).size, `${kind} keys`).toBe(keys.length);
      for (const key of keys) expect(RESERVED_KEYS, `${kind}.${key}`).not.toContain(key);
      for (const pick of picks) {
        const where = `${kind}.${pick.key}`;
        expect(pick.options.length, where).toBeGreaterThanOrEqual(1);
        expect(pick.label.trim().length, where).toBeGreaterThan(0);
        const ids = pick.options.map((option) => option.id);
        expect(new Set(ids).size, where).toBe(ids.length);
        for (const option of pick.options) {
          expect(option.label.trim().length, `${where}=${option.id}`).toBeGreaterThan(0);
        }
        if (pick.dflt !== undefined) expect(ids, where).toContain(pick.dflt);
      }
      for (const toggle of toggles) {
        expect(toggle.label.trim().length, `${kind}.${toggle.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("names a real pick of its own for every chip", () => {
    for (const { kind, chip, picks } of WIDGETS) {
      if (chip === undefined) continue;
      expect(
        picks.map((pick) => pick.key),
        kind,
      ).toContain(chip);
    }
  });

  /**
   * ⚠️ **The stored vocabulary, pinned.** Every key and option id below is a word already written
   * into readers' `config` rows (`dimension` and `limit` predate the grid), so renaming one is a
   * migration, not a tidy-up: a stored word no option carries reads as the default, silently. The
   * defaults are pinned for the same reason — a reader who never touched a pick is reading one.
   */
  it("stores every setting under the key and words the widgets read", () => {
    const vocabulary = Object.fromEntries(
      WIDGETS.map(({ kind, picks, toggles, chip }) => [
        kind,
        {
          picks: Object.fromEntries(
            picks.map((pick) => [
              pick.key,
              { ids: pick.options.map((option) => option.id), dflt: pick.dflt },
            ]),
          ),
          toggles: toggles.map((toggle) => toggle.key),
          chip,
        },
      ]),
    );
    const dimension = { ids: ["rarity", "color", "set", "finish"], dflt: undefined };
    const chart = { ids: ["bars", "list"], dflt: undefined };
    expect(vocabulary).toEqual({
      summary: { picks: {}, toggles: [], chip: undefined },
      collectionValue: { picks: { dimension, chart }, toggles: ["figures"], chip: "dimension" },
      wishlistValue: { picks: { dimension, chart }, toggles: ["figures"], chip: "dimension" },
      decks: {
        picks: { scope: { ids: ["recent", "pinned", "archived"], dflt: undefined } },
        toggles: ["art"],
        chip: "scope",
      },
      folders: {
        picks: { cabinets: { ids: ["both", "collection", "wishlist"], dflt: undefined } },
        toggles: ["captions"],
        chip: "cabinets",
      },
      activity: {
        picks: { limit: { ids: [25, 50, 100], dflt: 50 } },
        toggles: ["times"],
        chip: undefined,
      },
      priceMovers: {
        picks: {
          window: { ids: ["7d", "30d", "all"], dflt: undefined },
          direction: { ids: ["both", "up", "down"], dflt: undefined },
        },
        toggles: [],
        chip: "window",
      },
      setCompletion: {
        picks: { sort: { ids: ["complete", "cards", "name"], dflt: undefined } },
        toggles: ["bars"],
        chip: "sort",
      },
      recentCards: {
        picks: { count: { ids: [4, 6, 8], dflt: 8 } },
        toggles: ["names"],
        chip: undefined,
      },
    });
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
    expect(isWidgetKind("syncStatus")).toBe(false);
  });

  // The reason it is a `Set` and not `value in WIDGET_META`: `in` walks the prototype, so the
  // object-literal version answers `true` for all of these and a stored `kind: "toString"` would
  // be handed to a renderer that has no component for it.
  it("answers no for a prototype key", () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(isWidgetKind(key), key).toBe(false);
    }
  });
});

describe("boundsOf", () => {
  it("answers a known kind's own bounds", () => {
    expect(boundsOf("summary")).toMatchObject({ def: [4, 2], min: [2, 1], max: [8, 3] });
    expect(boundsOf("activity")).toMatchObject({ def: [3, 3], min: [2, 2], max: [4, 8] });
  });

  // Written out: the placeholder a newer build's widget is drawn as has to be movable, and a
  // `min` over one cell would stop it fitting wherever a reader has a one-cell gap.
  it("answers the unknown bounds for a kind this build cannot draw, prototype keys included", () => {
    expect(UNKNOWN_BOUNDS).toEqual({ def: [2, 2], min: [1, 1], max: [8, 8] });
    for (const kind of ["fromTheFuture", "toString", "__proto__", ""]) {
      expect(boundsOf(kind), kind).toEqual({ def: [2, 2], min: [1, 1], max: [8, 8] });
    }
  });
});

describe("DEFAULT_LAYOUT", () => {
  /**
   * ⚠️ **The literal below is `src-tauri/src/home.rs`'s `DEFAULT_LAYOUT` table, transcribed.**
   * The two are one fact in two places and the Rust one is what a first launch gets, so this
   * test's job is to make changing the TypeScript half alone impossible to do quietly. If it
   * goes red, the question is which of the two moved — not how to make the assertion pass.
   * `home.rs`'s own test pins the same ids, kinds and cells in the same order.
   */
  it("is home.rs's table, id for id and cell for cell", () => {
    expect(DEFAULT_LAYOUT).toEqual({
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
        {
          id: "setCompletion",
          kind: "setCompletion",
          x: 6,
          y: 5,
          w: 2,
          h: 2,
          span: 1,
          config: null,
        },
      ],
    });
  });

  // The id is what identifies a widget — every edit in `layout.ts` keys on it — so two widgets
  // sharing one would be a card the reader could not remove without removing the other.
  it("mints a unique id for every widget in it", () => {
    const ids = DEFAULT_LAYOUT.widgets.map((widget) => widget.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("seeds only kinds this build can draw, each inside its own bounds", () => {
    for (const { kind, w, h } of DEFAULT_LAYOUT.widgets) {
      expect(isWidgetKind(kind), kind).toBe(true);
      const { min, max } = boundsOf(kind);
      expect(w, kind).toBeGreaterThanOrEqual(min[0]);
      expect(w, kind).toBeLessThanOrEqual(max[0]);
      expect(h, kind).toBeGreaterThanOrEqual(min[1]);
      expect(h, kind).toBeLessThanOrEqual(max[1]);
    }
  });

  // No overlaps, inside eight by seven, and cells adding to fifty-six: together that is the
  // rectangle filled exactly — a first launch with no hole in it.
  it("fills eight columns by seven rows exactly, with nothing overlapping", () => {
    const widgets = DEFAULT_LAYOUT.widgets;
    for (let i = 0; i < widgets.length; i += 1) {
      const { id, x, y, w, h } = widgets[i];
      expect(x + w, id).toBeLessThanOrEqual(NARROWEST);
      expect(y + h, id).toBeLessThanOrEqual(7);
      expect(Math.min(x, y), id).toBeGreaterThanOrEqual(0);
      for (let j = i + 1; j < widgets.length; j += 1) {
        expect(overlaps(widgets[i], widgets[j]), `${id} × ${widgets[j].id}`).toBe(false);
      }
    }
    expect(widgets.reduce((cells, { w, h }) => cells + w * h, 0)).toBe(56);
  });

  it("is already normal on the narrowest grid, so a first launch moves nothing", () => {
    expect(sameGeometry(normalise(DEFAULT_LAYOUT.widgets, NARROWEST), DEFAULT_LAYOUT.widgets)).toBe(
      true,
    );
  });

  // Reset writes this through `toStored`; a seed whose `span` disagreed with its width would be a
  // default that changed the moment it was saved.
  it("carries the span toStored would write", () => {
    for (const { id, w, span } of DEFAULT_LAYOUT.widgets) expect(span, id).toBe(spanFor(w));
    expect(toStored(DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
  });
});

describe("BREAKDOWN_DIMENSIONS", () => {
  // The one word here that Rust also matches on, as four arms in each breakdown command.
  it("offers exactly the four dimensions the breakdown commands accept", () => {
    const ids = Object.keys(EVERY_DIMENSION).sort();
    expect(BREAKDOWN_DIMENSIONS.map((dimension) => dimension.id).sort()).toEqual(ids);
  });

  it("gives every dimension words", () => {
    for (const dimension of BREAKDOWN_DIMENSIONS) {
      expect(dimension.label.trim().length, dimension.id).toBeGreaterThan(0);
    }
  });
});
