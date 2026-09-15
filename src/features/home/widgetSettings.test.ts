import { describe, expect, it } from "vitest";

import type { HomeWidget } from "@/lib/ipc";

import {
  chipLabel,
  customTitle,
  defaultTitle,
  pickDefault,
  pickOf,
  pickValue,
  toggleOn,
  widgetDensity,
  widgetTitle,
} from "./widgetSettings";
import { widgetMeta, type WidgetPick } from "./widgets";

function widget(kind: string, config: unknown = null): HomeWidget {
  return { id: kind, kind, x: 0, y: 0, w: 3, h: 3, config };
}

/** A registry pick by key — read off the registry so a test is about *this* build's rows, whose
 *  vocabulary `widgets.test.ts` pins. */
function pickFor(kind: Parameters<typeof widgetMeta>[0], key: string): WidgetPick {
  const pick = widgetMeta(kind).picks.find((entry) => entry.key === key);
  if (pick === undefined) throw new Error(`${kind} has no ${key} pick`);
  return pick;
}

/** Configs that are not a config: never configured, or a row somebody broke. */
const NOT_A_CONFIG = [null, undefined, 7, "limit", [], [25], true];

describe("pickDefault", () => {
  // `activity` lists twenty-five first and defaults to fifty; a default read off `options[0]`
  // alone would halve every unconfigured Activity widget.
  it("answers the pick's dflt where it names one, and its first option otherwise", () => {
    expect(pickDefault(pickFor("activity", "limit"))).toBe(50);
    expect(pickDefault(pickFor("recentCards", "count"))).toBe(8);
    expect(pickDefault(pickFor("decks", "scope"))).toBe("recent");
    expect(pickDefault(pickFor("priceMovers", "direction"))).toBe("both");
  });
});

describe("pickValue", () => {
  const limit = pickFor("activity", "limit");

  it("answers a stored value an option carries", () => {
    expect(pickValue(widget("activity", { limit: 25 }), limit)).toBe(25);
    expect(pickValue(widget("activity", { limit: 100 }), limit)).toBe(100);
    expect(pickValue(widget("decks", { scope: "archived" }), pickFor("decks", "scope"))).toBe(
      "archived",
    );
  });

  it("answers the default for a config that is not one", () => {
    for (const config of NOT_A_CONFIG) {
      expect(pickValue(widget("activity", config), limit), String(config)).toBe(50);
    }
  });

  // A word a newer build wrote cannot reach a widget that has no branch for it.
  it("answers the default for a stored word no option carries", () => {
    expect(pickValue(widget("activity", { limit: 75 }), limit)).toBe(50);
    expect(pickValue(widget("decks", { scope: "favourites" }), pickFor("decks", "scope"))).toBe(
      "recent",
    );
  });

  // `"25"` is stored where the option is `25`, and `25` is not the default — so a loose `==` reads
  // twenty-five and the strict comparison reads fifty.
  it("answers the default for a value of the option's words in the wrong type", () => {
    expect(pickValue(widget("activity", { limit: "25" }), limit)).toBe(50);
    expect(pickValue(widget("recentCards", { count: "4" }), pickFor("recentCards", "count"))).toBe(
      8,
    );
  });
});

describe("pickOf", () => {
  it("reads a kind's pick by its key", () => {
    expect(pickOf(widget("priceMovers", { window: "30d" }), "window")).toBe("30d");
    expect(pickOf(widget("priceMovers", { window: "30d" }), "direction")).toBe("both");
    expect(pickOf(widget("recentCards", { count: 4 }), "count")).toBe(4);
  });

  it("answers undefined for a key the kind declares no pick for", () => {
    expect(pickOf(widget("decks", { limit: 25 }), "limit")).toBeUndefined();
    expect(pickOf(widget("summary", { title: "x" }), "title")).toBeUndefined();
  });

  it("answers undefined for a kind this build cannot draw, whatever it stored", () => {
    expect(pickOf(widget("fromTheFuture", { limit: 25 }), "limit")).toBeUndefined();
    expect(pickOf(widget("toString", { limit: 25 }), "limit")).toBeUndefined();
  });
});

describe("toggleOn", () => {
  it("is on when nothing is stored", () => {
    for (const config of NOT_A_CONFIG) {
      expect(toggleOn(widget("decks", config), "art"), String(config)).toBe(true);
    }
    expect(toggleOn(widget("decks", { scope: "pinned" }), "art")).toBe(true);
  });

  it("is off only for a stored false", () => {
    expect(toggleOn(widget("decks", { art: false }), "art")).toBe(false);
    for (const stored of [true, "false", 0, null, "", "off"]) {
      expect(toggleOn(widget("decks", { art: stored }), "art"), JSON.stringify(stored)).toBe(true);
    }
  });

  it("reads only its own key", () => {
    expect(toggleOn(widget("folders", { art: false }), "captions")).toBe(true);
  });
});

describe("widgetDensity", () => {
  it("is compact only for the stored word compact", () => {
    expect(widgetDensity(widget("decks", { density: "compact" }))).toBe("compact");
    for (const stored of [undefined, "comfortable", "COMPACT", " compact", true, 1]) {
      expect(widgetDensity(widget("decks", { density: stored })), String(stored)).toBe(
        "comfortable",
      );
    }
    for (const config of NOT_A_CONFIG) {
      expect(widgetDensity(widget("decks", config)), String(config)).toBe("comfortable");
    }
  });
});

describe("titles", () => {
  it("reads the reader's own name for a card", () => {
    expect(customTitle(widget("decks", { title: "Brews" }))).toBe("Brews");
    expect(widgetTitle(widget("decks", { title: "Brews" }))).toBe("Brews");
  });

  // A cleared field is not a name, and a card named nothing is a card with no accessible name.
  it("does not count a blank, or a title that is not a string, as a name", () => {
    for (const title of ["", "   ", 7, null, ["Brews"]]) {
      expect(customTitle(widget("decks", { title })), JSON.stringify(title)).toBeNull();
      expect(widgetTitle(widget("decks", { title })), JSON.stringify(title)).toBe("Decks");
    }
    for (const config of NOT_A_CONFIG) {
      expect(customTitle(widget("decks", config)), String(config)).toBeNull();
    }
  });

  it("names an unrenamed card by its kind", () => {
    expect(defaultTitle(widget("recentCards"))).toBe("Recently viewed");
    expect(widgetTitle(widget("collectionValue"))).toBe("Collection value");
  });

  it("says so for a kind this build cannot draw, and still honours a name", () => {
    expect(defaultTitle(widget("fromTheFuture"))).toBe("Unknown widget (fromTheFuture)");
    expect(widgetTitle(widget("fromTheFuture"))).toBe("Unknown widget (fromTheFuture)");
    expect(widgetTitle(widget("fromTheFuture", { title: "Sync" }))).toBe("Sync");
  });
});

describe("chipLabel", () => {
  it("answers the words of the chip pick's current value", () => {
    expect(chipLabel(widget("collectionValue"))).toBe("Rarity");
    expect(chipLabel(widget("collectionValue", { dimension: "color" }))).toBe("Colour");
    expect(chipLabel(widget("decks", { scope: "pinned" }))).toBe("Pinned");
    expect(chipLabel(widget("priceMovers", { window: "all", direction: "up" }))).toBe("All time");
    expect(chipLabel(widget("setCompletion"))).toBe("Nearest complete");
  });

  it("answers the default's words for a stored word no option carries", () => {
    expect(chipLabel(widget("folders", { cabinets: "attic" }))).toBe("Both");
  });

  // `activity` has a pick and no chip: a chip read off the first pick would draw `50` beside the
  // title of every Activity card.
  it("answers nothing for a kind with no chip, or one this build cannot draw", () => {
    expect(chipLabel(widget("activity", { limit: 25 }))).toBe("");
    expect(chipLabel(widget("recentCards"))).toBe("");
    expect(chipLabel(widget("summary"))).toBe("");
    expect(chipLabel(widget("fromTheFuture", { dimension: "set" }))).toBe("");
  });
});
