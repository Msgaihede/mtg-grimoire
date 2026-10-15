import { describe, expect, it } from "vitest";
import type { CollectionFolder, WishRow } from "@/lib/ipc";
import { searchTerms } from "@/features/search/useCardSearch";
import { collectionQueryOf, ownedPlacesOf, preferredFinishOf, wallPrinting } from "./wish";

const wish = (over: Partial<WishRow> = {}): WishRow =>
  ({
    id: 1,
    cardId: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    collectorNumber: "161",
    preferredFinish: null,
    ...over,
  }) as WishRow;

describe("preferredFinishOf", () => {
  it("answers the finish a wish asks for, and nothing for no preference or an unknown word", () => {
    expect(preferredFinishOf(wish({ preferredFinish: "foil" }))).toBe("foil");
    expect(preferredFinishOf(wish())).toBeNull();
    expect(preferredFinishOf(wish({ preferredFinish: "glossy" }))).toBeNull();
  });
});

describe("wallPrinting", () => {
  it("drops the finish's word where the chin's glyph already says it", () => {
    expect(wallPrinting(wish({ preferredFinish: "foil" }))).toBe("LEA · 161");
  });

  it("keeps the word for a wish for the nonfoil, which draws no glyph", () => {
    expect(wallPrinting(wish({ preferredFinish: "nonfoil" }))).toBe("LEA · 161 · Nonfoil");
  });

  it("never names the printing a wish for any printing is drawn as", () => {
    expect(wallPrinting(wish({ cardId: null, setCode: null, collectorNumber: null }))).toBe(
      "Any printing",
    );
  });
});

/** Issue #988: the collection search an owned chip opens — in the box's own syntax. */
describe("collectionQueryOf", () => {
  const pinned = wish({ lang: "en" });

  it("names the card and the printing for the exact copies", () => {
    expect(collectionQueryOf(pinned, "exact")).toBe('!"Lightning Bolt" e:lea cn:161 lang:en');
  });

  it("names the card minus the printing for the other copies", () => {
    expect(collectionQueryOf(pinned, "other")).toBe('!"Lightning Bolt" -(e:lea cn:161 lang:en)');
  });

  it("names the card alone for a wish for any printing", () => {
    const any = wish({ cardId: null, setCode: null, collectorNumber: null, lang: null });
    expect(collectionQueryOf(any, "exact")).toBe('!"Lightning Bolt"');
  });

  it("quotes a name around the quotes it holds", () => {
    const name = 'Kongming, "Sleeping Dragon"';
    expect(collectionQueryOf(wish({ name, cardId: null }), "exact")).toBe(`!'${name}'`);
  });

  /** The box reads every term as a predicate, so nothing falls through to free text — which would
   *  be an FTS search for `e:lea` rather than a filter. */
  it("reads back as predicates and no free text", () => {
    for (const side of ["exact", "other"] as const) {
      const terms = searchTerms(collectionQueryOf(pinned, side));
      expect(terms.text).toBeUndefined();
      expect(terms.predicates?.length).toBeGreaterThan(0);
    }
    expect(searchTerms(collectionQueryOf(pinned, "other")).predicates).toHaveLength(2);
  });
});

/** Issue #1055: where an owned chip's copies are filed, named from the collection's folders. */
describe("ownedPlacesOf", () => {
  const folder = (id: number, name: string, over: Partial<CollectionFolder> = {}) =>
    ({
      id,
      parentId: null,
      name,
      kind: "user",
      deckId: null,
      sortOrder: 0,
      ...over,
    }) as CollectionFolder;
  const FOLDERS = [
    folder(1, "Binder"),
    folder(2, "Staples", { parentId: 1 }),
    folder(3, "Burn", { kind: "deck", deckId: 9 }),
    folder(4, "Recently removed", { kind: "removed" }),
  ];
  const owned = wish({
    ownedPlaces: [
      { folderId: null, exact: 1, other: 0 },
      { folderId: 2, exact: 3, other: 1 },
      { folderId: 3, exact: 0, other: 2 },
      { folderId: 4, exact: 1, other: 0 },
    ],
  });

  it("names each folder's whole path, the most copies first, for the side asked about", () => {
    expect(ownedPlacesOf(owned, "exact", FOLDERS)).toEqual([
      { folderId: 2, kind: "folder", path: ["Binder", "Staples"], count: 3 },
      { folderId: null, kind: "unfiled", path: ["Not sorted"], count: 1 },
      { folderId: 4, kind: "removed", path: ["Recently removed"], count: 1 },
    ]);
    expect(ownedPlacesOf(owned, "other", FOLDERS)).toEqual([
      { folderId: 3, kind: "deck", path: ["Burn"], count: 2 },
      { folderId: 2, kind: "folder", path: ["Binder", "Staples"], count: 1 },
    ]);
  });

  it("leaves out a folder the list does not know rather than guess its name", () => {
    expect(ownedPlacesOf(owned, "other", [])).toEqual([]);
    expect(ownedPlacesOf(owned, "exact", [])).toEqual([
      { folderId: null, kind: "unfiled", path: ["Not sorted"], count: 1 },
    ]);
  });
});
