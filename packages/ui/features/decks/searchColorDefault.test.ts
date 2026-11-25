import { beforeEach, describe, expect, it } from "vitest";
import { searchColorDefault } from "./searchColorDefault";
import { card, resetRowIds, spec } from "./validation/fixtures";

/**
 * Issue #1725: the docked search's colour row opens on the commander's colour identity. These
 * pin the rule the editor hands the panel — the validator's own identity, read off the active
 * command zone, and nothing where there is no commander to read.
 */
beforeEach(resetRowIds);

/** Captain Kirk, Boldly Going — the issue's own screenshot: a Bant commander. */
const KIRK = card({
  name: "Captain Kirk, Boldly Going",
  categoryKind: "commander",
  typeLine: "Legendary Creature — Human Officer",
  colorIdentity: "GUW",
});

const MAIN_RED = card({ name: "Lightning Bolt", colorIdentity: "R" });

describe("searchColorDefault", () => {
  it("answers the commander's identity in WUBRG order", () => {
    expect(searchColorDefault([KIRK, MAIN_RED], spec("commander"))).toEqual(["W", "U", "G"]);
  });

  it("unions a partner pair, as CR 702.124c does", () => {
    const tymna = card({
      name: "Tymna the Weaver",
      categoryKind: "commander",
      typeLine: "Legendary Creature — Human Cleric",
      colorIdentity: "BW",
    });
    const thrasios = card({
      name: "Thrasios, Triton Hero",
      categoryKind: "commander",
      typeLine: "Legendary Creature — Merfolk Wizard",
      colorIdentity: "GU",
    });
    expect(searchColorDefault([tymna, thrasios], spec("commander"))).toEqual(["W", "U", "B", "G"]);
  });

  it("answers the colourless-only chip for a colourless commander", () => {
    const karn = card({
      name: "Karn, Legacy Reforged",
      categoryKind: "commander",
      typeLine: "Legendary Planeswalker — Karn",
      colorIdentity: "",
    });
    expect(searchColorDefault([karn], spec("commander"))).toEqual(["C"]);
  });

  it("answers nothing while the command zone is empty", () => {
    expect(searchColorDefault([MAIN_RED], spec("commander"))).toBeNull();
  });

  it("answers nothing for a format with no command zone, whatever the piles hold", () => {
    expect(searchColorDefault([KIRK, MAIN_RED], spec("modern"))).toBeNull();
    expect(searchColorDefault([KIRK, MAIN_RED], spec("casual"))).toBeNull();
    expect(searchColorDefault([KIRK], null)).toBeNull();
  });

  it("ignores a commander parked in a switched-off pile", () => {
    const parked = { ...KIRK, categoryActive: false };
    expect(searchColorDefault([parked, MAIN_RED], spec("commander"))).toBeNull();
  });

  it("reads the oathbreaker alone, not the signature spell beside it", () => {
    const wrenn = card({
      name: "Wrenn and Six",
      categoryKind: "commander",
      typeLine: "Legendary Planeswalker — Wrenn",
      colorIdentity: "GR",
    });
    const spell = card({
      name: "Swords to Plowshares",
      categoryKind: "commander",
      typeLine: "Instant",
      colorIdentity: "W",
    });
    expect(searchColorDefault([wrenn, spell], spec("oathbreaker"))).toEqual(["R", "G"]);
  });
});
