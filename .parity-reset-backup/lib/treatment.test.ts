import { describe, expect, it } from "vitest";
import {
  CARD_TREATMENTS,
  cardTreatments,
  finishTreatments,
  treatmentName,
  treatmentTitle,
} from "./treatment";

/** Real `promo_types` payloads, copied off the rows they name in the synced database. */
const MUL_133 = `["halofoil"]`; // Elesh Norn, the card in issue #160's screenshot
const MUL_133Z = `["serialized","doublerainbow"]`; // its serialized sibling on the same wall
const SLD_811 = `["sldbonus"]`; // a foil the app names nothing — every member is unknown here
const ONE_360 = `["oilslick","raisedfoil"]`; // Jace, the Perfected Mind: one treatment, two words
const LTR_462 = `["silverfoil","scroll","universesbeyond","boosterfun"]`; // a word and a trait
const DSK_367 = `["doubleexposure","boosterfun"]`; // a showcase frame, not a treatment

describe("cardTreatments", () => {
  it("names the treatment a printing carries", () => {
    expect(cardTreatments(MUL_133).map((t) => t.label)).toEqual(["Halo Foil"]);
  });

  /**
   * The reason the table is ordered rather than a lookup map: a printing carrying both kinds
   * leads with the foil word, because the mark stands where a *finish* glyph stood. 718
   * printings carry both, so this is the common case.
   */
  it("returns foil words before traits, whatever order Scryfall wrote them in", () => {
    // `serialized` is written first in the real column and must still come second.
    expect(cardTreatments(MUL_133Z).map((t) => t.label)).toEqual([
      "Double Rainbow Foil",
      "Serialized",
    ]);
    expect(cardTreatments(LTR_462).map((t) => t.label)).toEqual(["Silver Foil", "Scroll"]);
  });

  /**
   * **The pair, and that it consumes both members.** Without this ONE 360 would read "Oil Slick
   * Foil · Raised Foil" — one card described as two things — and an assertion that only checked
   * the first entry would pass while the second still leaked into the tooltip.
   */
  it("collapses oilslick + raisedfoil into the one name a player says", () => {
    expect(cardTreatments(ONE_360).map((t) => t.label)).toEqual(["Oil Slick Raised Foil"]);
  });

  /** Each pair member still stands alone on the 42 printings that carry only one of them. */
  it("still names each pair member on its own", () => {
    expect(cardTreatments(`["raisedfoil"]`).map((t) => t.label)).toEqual(["Raised Foil"]);
    expect(cardTreatments(`["oilslick"]`).map((t) => t.label)).toEqual(["Oil Slick Foil"]);
  });

  /**
   * Scryfall publishes 113 distinct promo types and adds more without asking. An unrecognised
   * one is dropped rather than guessed at or shown raw — `sldbonus` is a Secret Lair bonus
   * slot, not a treatment, and `doubleexposure` is a showcase frame the app already reads
   * through `frame_effects`.
   */
  it("drops every promo type it does not name", () => {
    expect(cardTreatments(SLD_811)).toEqual([]);
    expect(cardTreatments(DSK_367)).toEqual([]);
    expect(cardTreatments(`["universesbeyond","boosterfun","prerelease"]`)).toEqual([]);
  });

  /** The column is nullable and unvalidated; an unreadable one carries no treatment. */
  it("answers empty for null, junk and a payload that is not an array of strings", () => {
    expect(cardTreatments(null)).toEqual([]);
    expect(cardTreatments("")).toEqual([]);
    expect(cardTreatments("not json")).toEqual([]);
    expect(cardTreatments(`{"surgefoil":true}`)).toEqual([]);
    expect(cardTreatments(`[1,2,3]`)).toEqual([]);
  });

  /** Every id is spelt once, or one of them would be unreachable behind the other. */
  it("has no duplicate ids", () => {
    const ids = CARD_TREATMENTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("finishTreatments", () => {
  /**
   * **The fence, and the whole reason a treatment carries a kind.** 1 434 printings with a foil
   * word are also sold in plain nonfoil; calling the plain copy "Silver Foil" would be the claim
   * `soleFinish` already refuses to make about a printing merely sold in foil.
   */
  it("withholds a foil word from a plain copy", () => {
    expect(finishTreatments(LTR_462, "nonfoil").map((t) => t.label)).toEqual(["Scroll"]);
    expect(finishTreatments(MUL_133, "nonfoil")).toEqual([]);
  });

  /** A finish the app has not been told is read the same way — traits only, never a foil. */
  it("treats an unknown finish like a plain one", () => {
    expect(finishTreatments(LTR_462, null).map((t) => t.label)).toEqual(["Scroll"]);
    expect(finishTreatments(MUL_133, null)).toEqual([]);
  });

  /** A trait outlives the finish: the cardboard is serialized whichever copy you hold. */
  it("keeps a trait in every finish", () => {
    for (const finish of ["nonfoil", "foil", "etched", null] as const) {
      expect(finishTreatments(`["serialized"]`, finish).map((t) => t.label)).toEqual([
        "Serialized",
      ]);
    }
  });

  it("names the whole treatment on a foil or etched copy", () => {
    expect(finishTreatments(LTR_462, "foil").map((t) => t.label)).toEqual([
      "Silver Foil",
      "Scroll",
    ]);
    expect(finishTreatments(`["ripplefoil"]`, "etched").map((t) => t.label)).toEqual([
      "Ripple Foil",
    ]);
  });
});

describe("treatmentName and treatmentTitle", () => {
  /** One column's worth for a price row; the whole sentence for a tooltip that has the room. */
  it("says one word where there is room for one and all of them where there is not", () => {
    const both = finishTreatments(MUL_133Z, "foil");
    expect(treatmentName(both)).toBe("Double Rainbow Foil");
    expect(treatmentTitle(both)).toBe("Double Rainbow Foil · Serialized");
  });

  it("answers null for a printing with no treatment", () => {
    expect(treatmentName([])).toBeNull();
    expect(treatmentTitle([])).toBeNull();
  });
});
