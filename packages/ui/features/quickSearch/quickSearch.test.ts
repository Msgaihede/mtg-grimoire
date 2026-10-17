import { describe, expect, it } from "vitest";
import {
  GROUP_ORDER,
  cardItems,
  corpusItems,
  deckItems,
  folderItems,
  folderPath,
  groupsOf,
  printingQuery,
  rankName,
  settingItems,
  type CardRowLike,
  type DeckLike,
} from "./quickSearch";
import { PANEL_ORDER } from "@/features/settings/nav";

const deck = (id: number, name: string, over: Partial<DeckLike> = {}): DeckLike => ({
  id,
  name,
  formatName: "Commander",
  archived: false,
  folderId: null,
  ...over,
});

const row = (over: Partial<CardRowLike> & { name: string }): CardRowLike => ({
  cardId: `card-${over.name}`,
  folderId: null,
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  quantity: 1,
  ...over,
});

describe("rankName", () => {
  it("ranks the whole name over its start over a word's start over anywhere", () => {
    expect(rankName("Sol Ring", "sol ring")).toBe(0);
    expect(rankName("Sol Ring", "sol")).toBe(1);
    expect(rankName("Lightning Bolt", "bolt")).toBe(2);
    expect(rankName("Thunderbolt", "bolt")).toBe(3);
    expect(rankName("Sol Ring", "bolt")).toBeNull();
  });

  it("needs every word, in any order, and folds case and curly apostrophes", () => {
    expect(rankName("Lightning Bolt", "BOLT light")).not.toBeNull();
    expect(rankName("Lightning Bolt", "bolt shock")).toBeNull();
    expect(rankName("Urza’s Saga", "urza's")).toBe(1);
  });

  it("matches nothing on a blank query", () => {
    expect(rankName("Sol Ring", "   ")).toBeNull();
  });
});

describe("folderPath", () => {
  const folders = [
    { id: 1, parentId: null, name: "Binders" },
    { id: 2, parentId: 1, name: "Trade" },
    { id: 3, parentId: 9, name: "Orphan" },
    { id: 4, parentId: 5, name: "Loop A" },
    { id: 5, parentId: 4, name: "Loop B" },
  ];

  it("joins the names from the root", () => {
    expect(folderPath(folders, 2)).toBe("Binders › Trade");
  });

  it("ends the walk at a missing parent or a loop rather than throwing", () => {
    expect(folderPath(folders, 3)).toBe("Orphan");
    expect(folderPath(folders, 4)).toBe("Loop B › Loop A");
  });
});

describe("deckItems", () => {
  const decks = [
    deck(1, "Atraxa Superfriends"),
    deck(2, "Old Burn", { archived: true }),
    deck(3, "Mono Red Burn", { folderId: 10 }),
  ];
  const folders = [{ id: 10, parentId: null, name: "Burn decks" }];

  it("shows the recent decks, archived ones left out, with nothing typed", () => {
    expect(deckItems(decks, folders, "").map((i) => i.label)).toEqual([
      "Atraxa Superfriends",
      "Mono Red Burn",
    ]);
  });

  it("finds decks then deck folders, archived decks included and saying so", () => {
    const found = deckItems(decks, folders, "burn");
    expect(found.map((i) => [i.label, i.target])).toEqual([
      ["Old Burn", { kind: "deck", id: 2 }],
      ["Mono Red Burn", { kind: "deck", id: 3 }],
      ["Burn decks", { kind: "deckFolder", id: 10 }],
    ]);
    expect(found[0].detail).toBe("Commander · Archived");
    expect(found[1].detail).toBe("Commander · Burn decks");
  });
});

describe("folderItems", () => {
  it("draws a folder with the path it sits at", () => {
    const folders = [
      { id: 1, parentId: null, name: "Burn" },
      { id: 2, parentId: 1, name: "Tokens" },
    ];
    const found = folderItems(folders, "tokens", (f) => ({
      key: `w:${String(f.id)}`,
      target: { kind: "folder", scope: "wishlist", id: f.id },
    }));
    expect(found).toEqual([
      {
        key: "w:2",
        kind: "folder",
        label: "Tokens",
        detail: "Folder in Burn",
        target: { kind: "folder", scope: "wishlist", id: 2 },
      },
    ]);
  });

  it("finds no folder with nothing typed", () => {
    expect(
      folderItems([{ id: 1, parentId: null, name: "A" }], "", () => ({
        key: "x",
        target: { kind: "deckFolder", id: 1 },
      })),
    ).toEqual([]);
  });
});

describe("printingQuery", () => {
  it("names the printing in the box's own syntax, quoting a name with spaces", () => {
    expect(printingQuery(row({ name: "Lightning Bolt" }))).toBe(
      '!"Lightning Bolt" e:lea cn:161 lang:en',
    );
  });

  it("names the card alone when the row has no printing", () => {
    expect(printingQuery(row({ name: "Shock", setCode: null, collectorNumber: null }))).toBe(
      "!Shock",
    );
  });
});

describe("cardItems", () => {
  const where = (id: number | null) => (id === null ? "Not sorted" : `Folder ${String(id)}`);

  it("merges a printing's copies in one folder and reveals it there", () => {
    const found = cardItems(
      "collection",
      [
        row({ name: "Lightning Bolt", folderId: 4, quantity: 2 }),
        row({ name: "Lightning Bolt", folderId: 4, quantity: 1 }),
        row({ name: "Lightning Bolt", folderId: null, quantity: 1 }),
      ],
      "bolt",
      where,
    );
    expect(found.map((i) => i.detail)).toEqual([
      "LEA #161 · Folder 4 · ×3",
      "LEA #161 · Not sorted · ×1",
    ]);
    expect(found[0].target).toEqual({
      kind: "reveal",
      scope: "collection",
      folderId: 4,
      query: '!"Lightning Bolt" e:lea cn:161 lang:en',
    });
  });

  it("puts the cards called what was typed above the ones that only mention it", () => {
    const found = cardItems(
      "collection",
      [row({ name: "Fireblast" }), row({ name: "Bolt Bend" })],
      "bolt",
      where,
    );
    expect(found.map((i) => i.label)).toEqual(["Bolt Bend", "Fireblast"]);
  });

  it("says an any-printing wish is one", () => {
    const [wish] = cardItems(
      "wishlist",
      [row({ name: "Shock", cardId: null, setCode: null, collectorNumber: null })],
      "shock",
      () => "Wishlist",
    );
    expect(wish.detail).toBe("Any printing · Wishlist · ×1");
  });
});

describe("corpusItems", () => {
  const cards = [
    { cardId: "a", name: "Boltwave", setCode: "m19" },
    { cardId: "b", name: "Lightning Bolt", setCode: "lea" },
  ];

  it("leads with a search of the whole text, then each card on its exact name", () => {
    const found = corpusItems(cards, "lightning bolt");
    expect(found.map((i) => i.target)).toEqual([
      { kind: "search", text: "lightning bolt" },
      { kind: "search", text: '!"Lightning Bolt"' },
      { kind: "search", text: "!Boltwave" },
    ]);
    expect(found[0].label).toBe("Search all cards for “lightning bolt”");
  });

  it("is the recent cards alone with nothing typed", () => {
    expect(corpusItems(cards, "").map((i) => i.label)).toEqual(["Boltwave", "Lightning Bolt"]);
  });
});

describe("settingItems", () => {
  it("finds a panel by the Settings page's own words", () => {
    expect(settingItems(PANEL_ORDER, "currency").map((i) => i.target)).toEqual([
      { kind: "setting", panel: "prices" },
    ]);
  });

  it("finds only the panels it is given", () => {
    expect(settingItems(["updates"], "currency")).toEqual([]);
  });

  it("finds nothing with nothing typed", () => {
    expect(settingItems(PANEL_ORDER, "")).toEqual([]);
  });
});

describe("groupsOf", () => {
  it("orders the groups by the issue's rule whatever order they are handed in, empty ones dropped", () => {
    const item = (key: string) => ({
      key,
      kind: "card" as const,
      label: key,
      target: { kind: "search" as const, text: key },
    });
    const groups = groupsOf({
      settings: [item("s")],
      cards: [item("c")],
      wishlist: [],
      collection: [item("o")],
      decks: [item("d")],
    });
    expect(groups.map((g) => g.id)).toEqual(["decks", "collection", "cards", "settings"]);
    expect(GROUP_ORDER.indexOf("cards")).toBeGreaterThan(GROUP_ORDER.indexOf("collection"));
    expect(GROUP_ORDER.indexOf("cards")).toBeGreaterThan(GROUP_ORDER.indexOf("wishlist"));
  });
});
