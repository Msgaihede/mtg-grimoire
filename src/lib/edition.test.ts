import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";
import {
  GROUP_ORDER,
  PANELS,
  PANEL_ORDER,
  groupsOf,
  panelsOf,
  visiblePanels,
} from "@/features/settings/nav";
import {
  editionHas,
  FULL_EDITION,
  isLightView,
  LIGHT_EDITION,
  LIGHT_SETTINGS,
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

  it("lets the full edition publish a share and not the light one", () => {
    // No light host registers the `share_*` commands (`grimoire_core::commands` has none).
    expect(FULL_EDITION.publishes).toBe(true);
    expect(LIGHT_EDITION.publishes).toBe(false);
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

describe("the editions' Settings entries", () => {
  it("lets the full edition draw every panel, in the page's order, under every group", () => {
    expect(FULL_EDITION.settings).toBeNull();
    expect(panelsOf(FULL_EDITION.settings)).toEqual(PANEL_ORDER);
    expect(groupsOf(panelsOf(FULL_EDITION.settings))).toEqual(GROUP_ORDER);
  });

  it("gives the light edition spec §4's reduced Settings, and nothing the spec leaves out", () => {
    expect(LIGHT_EDITION.settings).toBe(LIGHT_SETTINGS);
    expect(panelsOf(LIGHT_EDITION.settings)).toEqual([
      "prices",
      "sync",
      "review",
      "hidden-tags",
      "theory-marks",
      "labels",
      "cache",
      "errors",
      "danger",
    ]);
    // Backup (the mirror) and Updates (the portable swap) by the spec's name; the folder's path
    // and the stored start view because a light install has neither to offer.
    for (const gone of ["updates", "backup", "data-folder", "start-view"] as const) {
      expect(panelsOf(LIGHT_EDITION.settings)).not.toContain(gone);
    }
  });

  it("drops the light rail's entries with nothing left in them, and only those", () => {
    const groups = groupsOf(panelsOf(LIGHT_EDITION.settings));
    expect(groups).toEqual(["carddata", "sync", "tags", "appearance", "storage", "errors"]);
    for (const group of groups) {
      expect(visiblePanels(group, "", panelsOf(LIGHT_EDITION.settings)).length).toBeGreaterThan(0);
    }
  });

  it("finds by search only a panel the edition draws", () => {
    const light = panelsOf(LIGHT_EDITION.settings);
    expect(visiblePanels("carddata", "dropbox", light)).toEqual([]);
    expect(visiblePanels("carddata", "dropbox")).toEqual(["backup"]);
    expect(visiblePanels("carddata", "patreon", light)).toEqual(["sync"]);
  });

  it("lists a panel once and orders it by the page, not by the list", () => {
    expect(new Set(LIGHT_SETTINGS).size).toBe(LIGHT_SETTINGS.length);
    expect(panelsOf(["danger", "prices"])).toEqual(["prices", "danger"]);
    for (const id of LIGHT_SETTINGS) expect(PANELS[id]).toBeDefined();
  });
});
