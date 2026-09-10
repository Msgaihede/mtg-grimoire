import { describe, expect, it } from "vitest";

import type { HomeLayout } from "@/lib/ipc";

import {
  addWidget,
  moveWidget,
  newWidgetId,
  parseLayout,
  removeWidget,
  setConfig,
  setSpan,
  widgetConfig,
} from "./layout";
import { DEFAULT_LAYOUT } from "./widgets";

/** A layout of three widgets whose ids are `a`, `b`, `c` — enough to say which one moved. */
function three(): HomeLayout {
  return {
    version: 1,
    widgets: [
      { id: "a", kind: "summary", span: 2, config: null },
      { id: "b", kind: "decks", span: 1, config: null },
      { id: "c", kind: "activity", span: 1, config: null },
    ],
  };
}

const ids = (layout: HomeLayout): string[] => layout.widgets.map((widget) => widget.id);

describe("parseLayout", () => {
  it("hands back the default for anything that is not a layout", () => {
    for (const junk of [null, undefined, 7, "x", "", true, [], {}, { widgets: 7 }, { version: 1 }]) {
      expect(parseLayout(junk), JSON.stringify(junk) ?? "undefined").toEqual(DEFAULT_LAYOUT);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [Symbol("x"), () => 1, new Map(), NaN, { widgets: [Symbol("y")] }]) {
      expect(() => parseLayout(junk)).not.toThrow();
    }
  });

  // The rule the whole file is shaped around, and `home.rs` pins the same one in Rust. An older
  // build reading a newer build's row rearranges the widgets it knows and does not quietly empty
  // the row of the ones it does not.
  it("keeps a widget kind this build has never heard of", () => {
    const parsed = parseLayout({
      version: 1,
      widgets: [{ id: "a", kind: "fromTheFuture", span: 1, config: { x: 1 } }],
    });
    expect(parsed.widgets).toHaveLength(1);
    expect(parsed.widgets[0].kind).toBe("fromTheFuture");
    expect(parsed.widgets[0].config).toEqual({ x: 1 });
  });

  // `home::stored` deliberately does not check the version on read, because defaulting over a
  // newer document loses the reader's widgets on every older build. This is that rule on the near
  // side: the version is kept as it stands, and so are the widgets under it.
  it("keeps a newer document's version and its widgets", () => {
    const parsed = parseLayout({
      version: 2,
      widgets: [{ id: "a", kind: "summary", span: 1, config: null }],
    });
    expect(parsed.version).toBe(2);
    expect(parsed.widgets).toHaveLength(1);
  });

  it("reads a document with no usable version at this build's own", () => {
    expect(parseLayout({ widgets: [] }).version).toBe(DEFAULT_LAYOUT.version);
    expect(parseLayout({ version: "2", widgets: [] }).version).toBe(DEFAULT_LAYOUT.version);
  });

  it("drops an entry that is not a widget rather than the whole document", () => {
    const parsed = parseLayout({
      version: 1,
      widgets: [{ id: "a", kind: "summary", span: 1 }, 7, null, "x", []],
    });
    expect(parsed.widgets).toHaveLength(1);
    expect(parsed.widgets[0].id).toBe("a");
  });

  // A blank cannot identify a widget and a blank kind cannot draw one; stored, either would be a
  // card the reader could neither see nor remove. `home::store` refuses both on the write side.
  it("drops an entry with a blank id or a blank kind", () => {
    const parsed = parseLayout({
      version: 1,
      widgets: [
        { id: "", kind: "summary", span: 1, config: null },
        { id: "  ", kind: "summary", span: 1, config: null },
        { id: "a", kind: "  ", span: 1, config: null },
        { id: 7, kind: "summary", span: 1, config: null },
        { id: "keep", kind: "summary", span: 1, config: null },
      ],
    });
    expect(ids(parsed)).toEqual(["keep"]);
  });

  // Clamped rather than dropped: a read has nobody to tell, and a widget removed for being one
  // column too wide is a widget that vanished.
  it("clamps a span into the grid rather than dropping the widget", () => {
    const parsed = parseLayout({
      version: 1,
      widgets: [
        { id: "zero", kind: "summary", span: 0, config: null },
        { id: "wide", kind: "summary", span: 3, config: null },
        { id: "words", kind: "summary", span: "2", config: null },
        { id: "absent", kind: "summary", config: null },
        { id: "half", kind: "summary", span: 1.6, config: null },
      ],
    });
    expect(parsed.widgets.map((widget) => widget.span)).toEqual([1, 2, 1, 1, 2]);
  });

  it("reads an absent config as null rather than dropping the widget", () => {
    const parsed = parseLayout({ version: 1, widgets: [{ id: "a", kind: "summary", span: 1 }] });
    expect(parsed.widgets[0].config).toBeNull();
  });

  // The read rule's edge, and the one a naive implementation gets wrong: "no widgets" and "no
  // document" are one value to a `?? DEFAULT_LAYOUT`, so a reader who cleared their home page
  // would be handed the six defaults back on every launch, for ever. `home.rs` has the matching
  // Rust test.
  it("keeps an empty widget list rather than restoring the default", () => {
    expect(parseLayout({ version: 1, widgets: [] }).widgets).toHaveLength(0);
  });

  it("does not hand out the shared default object", () => {
    const parsed = parseLayout(null);
    parsed.widgets.push({ id: "scribble", kind: "summary", span: 1, config: null });
    expect(DEFAULT_LAYOUT.widgets).toHaveLength(6);
    expect(parseLayout(null).widgets).toHaveLength(6);
  });
});

describe("addWidget", () => {
  it("appends a widget at the kind's own default width", () => {
    const added = addWidget({ version: 1, widgets: [] }, "summary");
    expect(added.widgets).toHaveLength(1);
    expect(added.widgets[0]).toEqual({ id: "summary", kind: "summary", span: 2, config: null });
  });

  it("leaves the layout it was handed alone", () => {
    const before = three();
    addWidget(before, "decks");
    expect(ids(before)).toEqual(["a", "b", "c"]);
  });

  // A reader may pin two sets of decks in two `decks` widgets — the id identifies a widget, so a
  // second one of a kind is a layout to build rather than a case to refuse.
  it("mints an id that does not collide with one already placed", () => {
    const once = addWidget({ version: 1, widgets: [] }, "decks");
    const twice = addWidget(once, "decks");
    const thrice = addWidget(twice, "decks");
    expect(ids(thrice)).toEqual(["decks", "decks-2", "decks-3"]);
    expect(new Set(ids(thrice)).size).toBe(3);
  });
});

describe("newWidgetId", () => {
  it("takes the kind itself when nothing has it", () => {
    expect(newWidgetId("folders", three())).toBe("folders");
  });

  it("steps past every id already placed, however they were minted", () => {
    const layout: HomeLayout = {
      version: 1,
      widgets: [
        { id: "decks", kind: "decks", span: 1, config: null },
        { id: "decks-2", kind: "decks", span: 1, config: null },
        { id: "decks-4", kind: "decks", span: 1, config: null },
      ],
    };
    expect(newWidgetId("decks", layout)).toBe("decks-3");
  });
});

describe("removeWidget", () => {
  it("removes the widget carrying the id and leaves the order alone", () => {
    expect(ids(removeWidget(three(), "b"))).toEqual(["a", "c"]);
  });

  it("removes nothing for an id nothing carries", () => {
    expect(ids(removeWidget(three(), "nope"))).toEqual(["a", "b", "c"]);
  });

  it("leaves the layout it was handed alone", () => {
    const before = three();
    removeWidget(before, "a");
    expect(ids(before)).toEqual(["a", "b", "c"]);
  });
});

describe("moveWidget", () => {
  it("moves a widget before another and leaves every other order alone", () => {
    expect(ids(moveWidget(three(), "c", "a", "before"))).toEqual(["c", "a", "b"]);
    expect(ids(moveWidget(three(), "a", "c", "before"))).toEqual(["b", "a", "c"]);
  });

  it("moves a widget after the last one", () => {
    expect(ids(moveWidget(three(), "a", "c", "after"))).toEqual(["b", "c", "a"]);
  });

  it("moves a widget after one that stands behind it", () => {
    expect(ids(moveWidget(three(), "c", "a", "after"))).toEqual(["a", "c", "b"]);
  });

  // The commonest drag there is, and the one a naive remove-then-insert loses: the target is the
  // widget that has just been lifted out, so the index it is found at is the wrong one — or, with
  // `findIndex` answering `-1`, the front of the list.
  it("moving a widget onto itself is a no-op rather than a loss", () => {
    expect(ids(moveWidget(three(), "b", "b", "before"))).toEqual(["a", "b", "c"]);
    expect(ids(moveWidget(three(), "b", "b", "after"))).toEqual(["a", "b", "c"]);
    expect(moveWidget(three(), "a", "a", "after")).toEqual(three());
  });

  it("changes nothing when either id names no widget", () => {
    expect(ids(moveWidget(three(), "ghost", "a", "before"))).toEqual(["a", "b", "c"]);
    expect(ids(moveWidget(three(), "a", "ghost", "after"))).toEqual(["a", "b", "c"]);
  });

  it("carries the moved widget whole", () => {
    const moved = moveWidget(three(), "a", "c", "after");
    expect(moved.widgets[2]).toEqual({ id: "a", kind: "summary", span: 2, config: null });
  });

  it("leaves the layout it was handed alone", () => {
    const before = three();
    moveWidget(before, "a", "c", "after");
    expect(ids(before)).toEqual(["a", "b", "c"]);
  });
});

describe("setSpan", () => {
  it("changes one widget's width and no other", () => {
    const wide = setSpan(three(), "b", 2);
    expect(wide.widgets.map((widget) => widget.span)).toEqual([2, 2, 1]);
  });

  it("changes nothing for an id nothing carries", () => {
    expect(setSpan(three(), "ghost", 2)).toEqual(three());
  });

  it("leaves the layout it was handed alone", () => {
    const before = three();
    setSpan(before, "b", 2);
    expect(before.widgets[1].span).toBe(1);
  });
});

describe("setConfig", () => {
  it("replaces one widget's config and no other's", () => {
    const set = setConfig(three(), "b", { deckIds: [4, 9] });
    expect(set.widgets[1].config).toEqual({ deckIds: [4, 9] });
    expect(set.widgets[0].config).toBeNull();
  });

  it("replaces rather than merges", () => {
    const first = setConfig(three(), "b", { deckIds: [4], stale: true });
    const second = setConfig(first, "b", { deckIds: [9] });
    expect(second.widgets[1].config).toEqual({ deckIds: [9] });
  });

  it("leaves the layout it was handed alone", () => {
    const before = three();
    setConfig(before, "b", { deckIds: [1] });
    expect(before.widgets[1].config).toBeNull();
  });
});

describe("widgetConfig", () => {
  const widget = (config: unknown) => ({ id: "a", kind: "decks", span: 1, config });

  it("hands back the fallback for a widget that was never configured", () => {
    expect(widgetConfig(widget(null), { deckIds: [] })).toEqual({ deckIds: [] });
    expect(widgetConfig(widget(undefined), { limit: 50 })).toEqual({ limit: 50 });
  });

  it("hands back the fallback for a config of the wrong shape", () => {
    for (const junk of [7, "x", true, [], [1, 2]]) {
      expect(widgetConfig(widget(junk), { limit: 50 })).toEqual({ limit: 50 });
    }
  });

  it("hands back the stored config when it matches", () => {
    expect(widgetConfig(widget({ limit: 20 }), { limit: 50 })).toEqual({ limit: 20 });
    expect(widgetConfig(widget({ deckIds: [4, 9] }), { deckIds: [] as number[] })).toEqual({
      deckIds: [4, 9],
    });
  });

  // The half that means a widget never has to guard: one bad field costs that field its stored
  // value and nothing else, so a config written by a build that spelled `limit` as a string still
  // yields a usable object rather than taking the whole widget back to its defaults.
  it("keeps the fallback's value for a field of the wrong type", () => {
    expect(widgetConfig(widget({ limit: "20" }), { limit: 50 })).toEqual({ limit: 50 });
    expect(
      widgetConfig(widget({ collectionFolderIds: [1], wishlistFolderIds: "no" }), {
        collectionFolderIds: [] as number[],
        wishlistFolderIds: [] as number[],
      }),
    ).toEqual({ collectionFolderIds: [1], wishlistFolderIds: [] });
  });

  it("fills a field the stored config does not carry", () => {
    expect(widgetConfig(widget({ deckIds: [4] }), { deckIds: [] as number[], limit: 6 })).toEqual({
      deckIds: [4],
      limit: 6,
    });
  });

  it("checks an array's elements against the one the fallback names", () => {
    expect(widgetConfig(widget({ deckIds: ["4"] }), { deckIds: [0] })).toEqual({ deckIds: [0] });
    expect(widgetConfig(widget({ deckIds: [4, 9] }), { deckIds: [0] })).toEqual({ deckIds: [4, 9] });
  });

  // What lets a newer build's settings survive a round trip through an older one: the widget can
  // spread this straight back into `setConfig` without deleting a key it has no reader for.
  it("carries through a stored key the fallback does not name", () => {
    expect(widgetConfig(widget({ limit: 20, fromTheFuture: "keep" }), { limit: 50 })).toEqual({
      limit: 20,
      fromTheFuture: "keep",
    });
  });

  it("does not reach into the fallback it was handed", () => {
    const fallback = { deckIds: [] as number[] };
    widgetConfig(widget({ deckIds: [4] }), fallback);
    expect(fallback.deckIds).toEqual([]);
  });
});
