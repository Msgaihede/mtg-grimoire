import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";
import {
  editionHas,
  FULL_EDITION,
  isLightView,
  LIGHT_EDITION,
  LIGHT_START,
  LIGHT_VIEWS,
} from "@/lib/edition";

describe("the two editions", () => {
  it("lets the full edition draw every destination", () => {
    for (const { id } of NAV) expect(editionHas(FULL_EDITION, id)).toBe(true);
  });

  it("gives the light edition six destinations, in the rail's own order", () => {
    // The rail filters `NAV`, so a list written in another order would be a list the rail
    // silently re-sorts — and the phone's tab bar reads this one directly.
    const railOrder = NAV.filter((n) => editionHas(LIGHT_EDITION, n.id)).map((n) => n.id);
    expect(railOrder).toEqual([...LIGHT_VIEWS]);
    expect(railOrder).toEqual(["search", "decks", "collection", "wishlist", "scanner", "settings"]);
  });

  it("keeps the caption for the full edition only", () => {
    expect(FULL_EDITION.caption).toBe(true);
    expect(LIGHT_EDITION.caption).toBe(false);
  });

  it("opens the light edition on a view it draws", () => {
    expect(LIGHT_EDITION.startView).toBe(LIGHT_START);
    expect(editionHas(LIGHT_EDITION, LIGHT_EDITION.startView)).toBe(true);
  });

  it("narrows a word to a light view without walking the prototype", () => {
    expect(isLightView("decks")).toBe(true);
    expect(isLightView("home")).toBe(false);
    expect(isLightView("toString")).toBe(false);
  });
});
