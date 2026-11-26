import { describe, expect, it } from "vitest";

import type {
  DeckCommanderIdentity,
  DeckFolder,
  DeckPipCosts,
  DeckRow,
  HomeWidget,
} from "@/lib/ipc";
import {
  COMBOS,
  WUBRG,
  arranged,
  colorSources,
  comboGroups,
  comboKey,
  comboOf,
  deckColorsView,
  deckCombo,
  deckOrder,
  decksInScope,
  folderWhitelist,
  rearranged,
} from "./deckColors";

/** A deck, typed against the mirror so a field the row grows is a compile error here. */
function deck(over: Partial<DeckRow> & { id: number; name: string }): DeckRow {
  return {
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    theoryCardCount: 0,
    managedWishlist: "off",
    managedWishlistTokens: false,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tags: [],
    tokensOpen: false,
    tokenMode: "managed",
    tokenRailIndex: -1,
    statsOpen: true,
    curveCreatures: false,
    todosOpen: false,
    syncUid: null,
    draft: false,
    ...over,
  };
}

function widget(config: unknown = null): HomeWidget {
  return { id: "deckColors", kind: "deckColors", x: 0, y: 0, w: 4, h: 4, config };
}

function identity(
  deckId: number,
  live: string | null,
  theory: string | null = null,
): DeckCommanderIdentity {
  return { deckId, identity: live, theoryIdentity: theory };
}

function pips(deckId: number, costs: string[], theoryCosts: string[] = []): DeckPipCosts {
  return {
    deckId,
    costs: costs.map((cost) => ({ cost, copies: 1 })),
    theoryCosts: theoryCosts.map((cost) => ({ cost, copies: 1 })),
  };
}

function folder(id: number, parentId: number | null, name = `Folder ${id}`): DeckFolder {
  return { id, parentId, name, sortOrder: id };
}

describe("COMBOS", () => {
  it("is every subset of the five colours exactly once, keyed in WUBRG order", () => {
    const subsets = Array.from({ length: 32 }, (_, mask) =>
      WUBRG.filter((_, bit) => mask & (1 << bit)).join(""),
    );
    expect(COMBOS.map((combo) => combo.key).sort()).toEqual(subsets.sort());
    for (const combo of COMBOS) {
      expect(comboKey(combo.key)).toBe(combo.key);
      expect(combo.size).toBe(combo.key.length);
    }
  });

  it("calls the combinations what players call them", () => {
    expect(comboOf("WU").name).toBe("Azorius");
    expect(comboOf("WR").name).toBe("Boros");
    expect(comboOf("WBR").name).toBe("Mardu");
    expect(comboOf("UBRG").name).toBe("Glint-Eye");
    expect(comboOf("WUBR").name).toBe("Yore-Tiller");
    expect(comboOf("").name).toBe("Colorless");
  });
});

describe("comboKey", () => {
  it("folds any spelling of a set of colours to one key", () => {
    expect(comboKey("UW")).toBe("WU");
    expect(comboKey("gw")).toBe("WG");
    expect(comboKey("BGRUW")).toBe("WUBRG");
    expect(comboKey("RRR")).toBe("R");
    expect(comboKey("C")).toBe("");
    expect(comboKey("")).toBe("");
  });
});

describe("comboGroups", () => {
  it("keeps the mono colours in WUBRG order with colourless at their foot, in either order", () => {
    for (const order of ["alpha", "pie"] as const) {
      expect(comboGroups(order)[0].combos.map((combo) => combo.key)).toEqual([
        "W",
        "U",
        "B",
        "R",
        "G",
        "",
      ]);
    }
  });

  it("lists the guilds by name, as a hand-kept sheet does, or in colour-pie order", () => {
    const names = (order: "alpha" | "pie") =>
      comboGroups(order)[1].combos.map((combo) => combo.name);
    expect(names("alpha")).toEqual([
      "Azorius",
      "Boros",
      "Dimir",
      "Golgari",
      "Gruul",
      "Izzet",
      "Orzhov",
      "Rakdos",
      "Selesnya",
      "Simic",
    ]);
    expect(names("pie")).toEqual([
      "Azorius",
      "Dimir",
      "Rakdos",
      "Gruul",
      "Selesnya",
      "Orzhov",
      "Izzet",
      "Golgari",
      "Boros",
      "Simic",
    ]);
  });

  it("puts every combination in exactly one section", () => {
    const keys = comboGroups("alpha").flatMap((group) => group.combos.map((combo) => combo.key));
    expect(keys).toHaveLength(32);
    expect(new Set(keys).size).toBe(32);
  });
});

describe("deckCombo", () => {
  const decks = [
    deck({ id: 1, name: "Alesha" }),
    deck({ id: 2, name: "Burn" }),
    deck({ id: 3, name: "Eldrazi" }),
    deck({ id: 4, name: "Empty" }),
    deck({ id: 5, name: "Karn" }),
    // A theory deck whose tile is turned to its plan: the tile reads the plan, and so does the sheet.
    deck({
      id: 6,
      name: "Plan",
      theoryEnabled: true,
      cardCount: 0,
      theoryCardCount: 99,
      lastVariant: "theory",
    }),
  ];
  const sources = colorSources(
    decks,
    [identity(1, "RWB"), identity(5, ""), identity(6, null, "UG")],
    [
      // Alesha's cards so far are all red — the commander still files the deck as Mardu.
      pips(1, ["{2}{R}", "{R}"]),
      pips(2, ["{R}", "{1}{R}"]),
      pips(3, ["{3}{C}", "{W}"]),
      pips(5, ["{2}{U}"]),
      pips(6, [], ["{G}{U}"]),
    ],
  );
  const byId = (id: number) => decks.find((d) => d.id === id)!;

  it("files a deck with a commander by the command zone's identity", () => {
    expect(deckCombo(byId(1), sources)).toBe("WBR");
  });

  it("files a colourless commander as colourless whatever its cards cost", () => {
    expect(deckCombo(byId(5), sources)).toBe("");
  });

  it("files a deck with no commander by its cards' colours, leaving {C} out", () => {
    expect(deckCombo(byId(2), sources)).toBe("R");
    expect(deckCombo(byId(3), sources)).toBe("W");
  });

  it("reads the plan of a deck whose tile is turned to it", () => {
    expect(deckCombo(byId(6), sources)).toBe("UG");
  });

  it("files nothing for a deck that has said nothing about its colours", () => {
    expect(deckCombo(byId(4), sources)).toBeNull();
  });
});

describe("decksInScope", () => {
  const folders = [folder(1, null, "Commander"), folder(2, 1, "Retired"), folder(3, null, "Cube")];
  const decks = [
    deck({ id: 1, name: "Root deck", folderId: null }),
    deck({ id: 2, name: "Commander deck", folderId: 1 }),
    deck({ id: 3, name: "Retired deck", folderId: 2 }),
    deck({ id: 4, name: "Cube deck", folderId: 3 }),
    deck({ id: 5, name: "Shelved", folderId: 1, archived: true }),
  ];
  const ids = (config: unknown) => decksInScope(decks, folders, widget(config)).map((d) => d.id);

  it("counts every live deck by default, and archived ones only when asked", () => {
    expect(ids(null)).toEqual([1, 2, 3, 4]);
    expect(ids({ archived: true })).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a ticked folder and everything under it", () => {
    expect(ids({ scope: "chosen", folderIds: [1] })).toEqual([2, 3]);
  });

  it("counts only the ticked folders themselves once subfolders are off", () => {
    expect(ids({ scope: "chosen", folderIds: [1], subfolders: false })).toEqual([2]);
  });

  it("counts the decks in no folder when the root is ticked", () => {
    expect(ids({ scope: "chosen", folderIds: [3], unfiled: true })).toEqual([1, 4]);
  });

  it("counts nothing for a whitelist naming only a deleted folder", () => {
    expect(ids({ scope: "chosen", folderIds: [99] })).toEqual([]);
  });

  it("reads a malformed whitelist as the default", () => {
    expect(folderWhitelist(widget({ folderIds: "1", unfiled: "yes", subfolders: 0 }))).toEqual({
      folderIds: [],
      unfiled: false,
      subfolders: true,
    });
  });
});

describe("arranging decks inside a combination", () => {
  const a = deck({ id: 1, name: "Alpha" });
  const b = deck({ id: 2, name: "Bravo" });
  const c = deck({ id: 3, name: "Charlie" });

  it("draws placed decks in the reader's order, then the rest by name", () => {
    expect(arranged([a, b, c], [3]).map((d) => d.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(arranged([c, b, a], []).map((d) => d.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("stores a row by appending it, keeping other rows and dropping deleted decks", () => {
    expect(rearranged([7, 2, 9, 1], [3, 1, 2], new Set([1, 2, 3, 7]))).toEqual([7, 3, 1, 2]);
  });

  it("reads only whole-number ids from the stored order", () => {
    expect(deckOrder(widget({ deckOrder: [3, "4", 1.5, 2] }))).toEqual([3, 2]);
  });
});

describe("deckColorsView", () => {
  it("files every deck, counts the covered combinations and sets aside the uncoloured", () => {
    const decks = [
      deck({ id: 1, name: "Azorius A" }),
      deck({ id: 2, name: "Azorius B" }),
      deck({ id: 3, name: "Mono Red" }),
      deck({ id: 4, name: "Nothing yet" }),
    ];
    const sources = colorSources(decks, [identity(1, "WU"), identity(2, "UW")], [pips(3, ["{R}"])]);
    const view = deckColorsView(decks, sources, [2], "alpha");
    const row = (key: string) =>
      view.groups.flatMap((g) => g.rows).find((r) => r.combo.key === key)!;

    expect(view.covered).toBe(2);
    expect(view.placed).toBe(3);
    expect(view.uncoloured.map((d) => d.name)).toEqual(["Nothing yet"]);
    expect(row("WU").decks.map((d) => d.name)).toEqual(["Azorius B", "Azorius A"]);
    expect(row("R").decks.map((d) => d.name)).toEqual(["Mono Red"]);
    expect(row("WUBRG").decks).toEqual([]);
    expect(view.groups.map((g) => g.covered)).toEqual([1, 1, 0, 0, 0]);
  });
});
