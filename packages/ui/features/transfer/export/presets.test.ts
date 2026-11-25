import { describe, expect, it } from "vitest";
import { ALWAYS, availableFields, type TransferSurface } from "../fields";
import { EXPORT_FORMAT_PLACE, EXPORT_FORMATS } from "../formats";
import {
  EXPORT_PRESET_IDS,
  EXPORT_PRESET_ORDER,
  EXPORT_PRESETS,
  presetFields,
  presetIdOf,
} from "./presets";

const SURFACES: readonly TransferSurface[] = ["deck", "collection", "wishlist", "trade"];

/** Issue #1726: site presets, each a format and a field set decided for the reader. */
describe("export presets", () => {
  it("holds the issue's sites and the three More formats rows they replaced", () => {
    expect(EXPORT_PRESET_ORDER.map((id) => EXPORT_PRESETS[id].label)).toEqual([
      "Card Kingdom",
      "Cardmarket",
      "Mana Pool",
      "Moxfield",
      "MTG Print",
      "MTG Proxy",
      "MTGO",
      "Proxxied",
      "Proxy Print",
      "TCGplayer",
    ]);
  });

  it("reaches every format the radio row leaves off", () => {
    const reached = new Set(EXPORT_PRESET_IDS.map((id) => EXPORT_PRESETS[id].format));
    for (const format of EXPORT_FORMATS) {
      if (EXPORT_FORMAT_PLACE[format] === "preset") expect(reached, format).toContain(format);
    }
  });

  it("names only fields its format can carry, and always the count and the name", () => {
    for (const id of EXPORT_PRESET_IDS) {
      const { format, fields } = EXPORT_PRESETS[id];
      const offered = availableFields(format, "deck");
      for (const field of fields) expect(offered, `${id}: ${field}`).toContain(field);
      for (const field of ALWAYS) expect(fields, id).toContain(field);
    }
  });

  it("narrows its fields to what each surface holds, in the field order", () => {
    for (const surface of SURFACES) {
      for (const id of EXPORT_PRESET_IDS) {
        const written = presetFields(id, surface);
        const offered = availableFields(EXPORT_PRESETS[id].format, surface);
        expect(written, `${id} on ${surface}`).toEqual(offered.filter((f) => written.includes(f)));
        for (const field of ALWAYS) expect(written).toContain(field);
      }
    }
  });

  it("pins the printing where the site documents it: Mana Pool's `[SET] 123`", () => {
    expect(EXPORT_PRESETS.manapool.format).toBe("tcgplayer");
    expect(presetFields("manapool", "deck")).toEqual([
      "quantity",
      "name",
      "setCode",
      "collectorNumber",
    ]);
  });

  it("writes a bare `1 Name` for the sites that document no paste format", () => {
    for (const id of [
      "cardkingdom",
      "cardmarket",
      "mtgprint",
      "mtgproxy",
      "proxxied",
      "proxyprint",
    ] as const) {
      expect(EXPORT_PRESETS[id].format, id).toBe("plain");
      expect(presetFields(id, "deck"), id).toEqual(["quantity", "name"]);
    }
  });

  it("reads a stored value back to an id, and nothing else", () => {
    expect(presetIdOf("manapool")).toBe("manapool");
    expect(presetIdOf("plain")).toBeNull();
    expect(presetIdOf("")).toBeNull();
  });
});
