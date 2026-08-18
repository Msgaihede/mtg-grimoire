import { describe, expect, it } from "vitest";
import type { Printing } from "@/lib/ipc";
import {
  EMPTY_PRINTING_FILTER,
  filterPrintings,
  isFilterActive,
  langOptions,
  setOptions,
  treatmentOptions,
  type PrintingFilter,
} from "./printingFilters";

/** One printing, with every field the filters read and sane defaults for the rest. */
function printing(over: Partial<Printing> = {}): Printing {
  return {
    id: "p1",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "233",
    releasedAt: "1993-08-05",
    rarity: "common",
    illustrationId: "i1",
    artist: "Christopher Rush",
    lang: "en",
    finishes: '["nonfoil"]',
    finishPrices: { nonfoil: null, foil: null, etched: null },
    promo: false,
    fullArt: false,
    frameEffects: null,
    borderColor: "black",
    layout: "normal",
    ...over,
  };
}

const all = (over: Partial<PrintingFilter> = {}) => ({ ...EMPTY_PRINTING_FILTER, ...over });

describe("filterPrintings", () => {
  it("passes everything through an empty filter", () => {
    const rows = [printing(), printing({ id: "p2", setCode: "leb" })];
    expect(filterPrintings(rows, EMPTY_PRINTING_FILTER)).toEqual(rows);
  });

  it("matches text against the set name, the set code, the number and the artist", () => {
    const rows = [
      printing({ id: "name", setName: "Ravnica: City of Guilds" }),
      printing({ id: "code", setName: null, setCode: "rav" }),
      printing({ id: "number", setName: null, setCode: "xxx", collectorNumber: "rav-7" }),
      printing({ id: "artist", setName: null, setCode: "xxx", artist: "Ravi Kumar" }),
      printing({ id: "miss", setName: "Alpha", setCode: "lea", artist: "Someone" }),
    ];
    const kept = filterPrintings(rows, all({ text: "rav" })).map((p) => p.id);
    expect(kept).toEqual(["name", "code", "number", "artist"]);
  });

  it("ignores case and surrounding whitespace in the text", () => {
    const rows = [printing({ setName: "Modern Horizons" })];
    expect(filterPrintings(rows, all({ text: "  MODERN  " }))).toHaveLength(1);
  });

  it("keeps only the chosen sets", () => {
    const rows = [printing({ id: "a", setCode: "lea" }), printing({ id: "b", setCode: "leb" })];
    expect(filterPrintings(rows, all({ sets: ["leb"] })).map((p) => p.id)).toEqual(["b"]);
  });

  it("keeps only the chosen languages", () => {
    const rows = [printing({ id: "en" }), printing({ id: "ja", lang: "ja" })];
    expect(filterPrintings(rows, all({ langs: ["ja"] })).map((p) => p.id)).toEqual(["ja"]);
  });

  it("reads a treatment off the field that carries it", () => {
    const rows = [
      printing({ id: "foil", finishes: '["nonfoil","foil"]' }),
      printing({ id: "etched", finishes: '["etched"]' }),
      printing({ id: "promo", promo: true }),
      printing({ id: "fullart", fullArt: true }),
      printing({ id: "borderless", borderColor: "borderless" }),
      printing({ id: "showcase", frameEffects: '["showcase"]' }),
      printing({ id: "extended", frameEffects: '["extendedart"]' }),
      printing({ id: "plain" }),
    ];
    const only = (t: string) =>
      filterPrintings(rows, all({ treatments: [t as never] })).map((p) => p.id);
    expect(only("foil")).toEqual(["foil"]);
    expect(only("etched")).toEqual(["etched"]);
    expect(only("promo")).toEqual(["promo"]);
    expect(only("fullart")).toEqual(["fullart"]);
    expect(only("borderless")).toEqual(["borderless"]);
    expect(only("showcase")).toEqual(["showcase"]);
    expect(only("extendedart")).toEqual(["extended"]);
  });

  it("ORs the treatments with each other and ANDs them with the rest", () => {
    const rows = [
      printing({ id: "promo-lea", promo: true, setCode: "lea" }),
      printing({ id: "fullart-leb", fullArt: true, setCode: "leb" }),
      printing({ id: "plain-lea", setCode: "lea" }),
    ];
    // Two treatments: either one qualifies a row.
    expect(
      filterPrintings(rows, all({ treatments: ["promo", "fullart"] })).map((p) => p.id),
    ).toEqual(["promo-lea", "fullart-leb"]);
    // A set narrows the same list further.
    expect(
      filterPrintings(rows, all({ treatments: ["promo", "fullart"], sets: ["lea"] })).map(
        (p) => p.id,
      ),
    ).toEqual(["promo-lea"]);
  });

  it("preserves the order it was given", () => {
    const rows = [printing({ id: "c" }), printing({ id: "a" }), printing({ id: "b" })];
    expect(filterPrintings(rows, all({ text: "alpha" })).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("narrows nothing on a malformed finishes or frameEffects string", () => {
    const rows = [printing({ id: "junk", finishes: "not json", frameEffects: "{" })];
    expect(filterPrintings(rows, all({ treatments: ["foil"] }))).toHaveLength(0);
    expect(filterPrintings(rows, EMPTY_PRINTING_FILTER)).toHaveLength(1);
  });
});

describe("the option lists", () => {
  it("counts sets and orders them by the printings' own order", () => {
    const rows = [
      printing({ setCode: "leb", setName: "Beta" }),
      printing({ setCode: "lea", setName: "Alpha" }),
      printing({ setCode: "leb", setName: "Beta" }),
    ];
    expect(setOptions(rows)).toEqual([
      { code: "leb", name: "Beta", count: 2 },
      { code: "lea", name: "Alpha", count: 1 },
    ]);
  });

  it("names a set by its code when no row carries its name", () => {
    expect(setOptions([printing({ setCode: "pmei", setName: null })])).toEqual([
      { code: "pmei", name: "PMEI", count: 1 },
    ]);
  });

  it("puts English first and the rest by count", () => {
    const rows = [
      printing({ lang: "ja" }),
      printing({ lang: "de" }),
      printing({ lang: "ja" }),
      printing({ lang: "en" }),
    ];
    expect(langOptions(rows).map((o) => o.lang)).toEqual(["en", "ja", "de"]);
  });

  it("counts every treatment, including the ones with none", () => {
    const rows = [printing({ promo: true }), printing({ fullArt: true }), printing()];
    const counts = Object.fromEntries(treatmentOptions(rows).map((o) => [o.id, o.count]));
    expect(counts.promo).toBe(1);
    expect(counts.fullart).toBe(1);
    expect(counts.showcase).toBe(0);
  });
});

describe("isFilterActive", () => {
  it("is false for the empty filter and true for any narrowed one", () => {
    expect(isFilterActive(EMPTY_PRINTING_FILTER)).toBe(false);
    expect(isFilterActive(all({ text: " " }))).toBe(false);
    expect(isFilterActive(all({ text: "a" }))).toBe(true);
    expect(isFilterActive(all({ sets: ["lea"] }))).toBe(true);
    expect(isFilterActive(all({ langs: ["ja"] }))).toBe(true);
    expect(isFilterActive(all({ treatments: ["promo"] }))).toBe(true);
  });
});
