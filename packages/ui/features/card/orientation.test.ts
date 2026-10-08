import { describe, expect, it } from "vitest";
import type { CardFace } from "@/lib/ipc";
import { cardTurn, meldPartsOf, meldResultOf } from "./orientation";

const face = (over: Partial<CardFace> = {}): CardFace => ({
  name: "Assault",
  typeLine: "Sorcery",
  oracleText: "Assault deals 2 damage to any target.",
  manaCost: "{R}",
  artist: "Jeff Miracola",
  ...over,
});

/** A meld relation as `cardMeldParts` answers it. */
const relation = (name: string, component: string) => ({
  id: name.toLowerCase(),
  name,
  component,
  artist: "Clint Cearley",
});

describe("cardTurn: split", () => {
  it("turns a classic split card clockwise", () => {
    expect(cardTurn("split", [face({ name: "Assault" }), face({ name: "Battery" })])).toBe(90);
  });

  it("turns an Aftermath card counter-clockwise", () => {
    const turn = cardTurn("split", [
      face({ name: "Dusk", oracleText: "Destroy all creatures with power 3 or greater." }),
      face({
        name: "Dawn",
        oracleText:
          "Aftermath (Cast this spell only from your graveyard. Then exile it.)\nReturn all creature cards with power 2 or less from your graveyard to your hand.",
      }),
    ]);

    expect(turn).toBe(-90);
  });

  /**
   * Pins `startsWith` on face 1 rather than a substring search over the card. "Aftermath" is
   * a keyword ability and therefore the first word of the bottom half's box; a rules text
   * that merely *mentions* the word — reminder text, a card that talks about the mechanic —
   * is a classic split and must still turn clockwise.
   */
  it("is not fooled by the word Aftermath anywhere but the start of the second face", () => {
    const turn = cardTurn("split", [
      face({ name: "Boom", oracleText: "Unlike Aftermath cards, this one is cast normally." }),
      face({ name: "Bust", oracleText: "Destroy all lands. (Not Aftermath.)" }),
    ]);

    expect(turn).toBe(90);
  });

  it("treats a split whose second face has no oracle text as classic", () => {
    expect(cardTurn("split", [face(), face({ oracleText: null })])).toBe(90);
  });

  it("treats a split that arrived with fewer than two faces as classic, without throwing", () => {
    expect(cardTurn("split", [face()])).toBe(90);
    expect(cardTurn("split", [])).toBe(90);
  });
});

describe("cardTurn: the other sideways layouts", () => {
  it("turns a plane clockwise", () => {
    expect(cardTurn("planar", [])).toBe(90);
  });

  /** The layout the control exists for: `faceCount` says 1, so nothing else can read it. */
  it("turns a flip card a half turn", () => {
    expect(
      cardTurn("flip", [
        face({ name: "Akki Lavarunner" }),
        face({ name: "Tok-Tok, Volcano Born" }),
      ]),
    ).toBe(180);
  });
});

describe("cardTurn: upright layouts", () => {
  it.each(["transform", "modal_dfc", "reversible_card", "adventure", "normal", "meld"])(
    "leaves %s upright",
    (layout) => {
      expect(cardTurn(layout, [face(), face({ name: "back" })])).toBeNull();
    },
  );
});

/**
 * Both shapes are the live answers measured on 2026-08-21: `Bruna, the Fading Light`
 * (`emn 15`) is a half and names its sibling as a `meld_part` too; `Brisela, Voice of
 * Nightmares` (`emn 15b`) is the melded card and names both halves.
 */
const BRUNA = [
  relation("Brisela, Voice of Nightmares", "meld_result"),
  relation("Gisela, the Broken Blade", "meld_part"),
];
const BRISELA = [
  relation("Bruna, the Fading Light", "meld_part"),
  relation("Gisela, the Broken Blade", "meld_part"),
];

describe("meldResultOf", () => {
  it("names the melded card a half melds into", () => {
    expect(meldResultOf(BRUNA)?.name).toBe("Brisela, Voice of Nightmares");
  });

  it("answers null for the melded card itself", () => {
    expect(meldResultOf(BRISELA)).toBeNull();
  });

  it("answers null for a card with no relations", () => {
    expect(meldResultOf([])).toBeNull();
  });

  it("ignores a component it does not recognise", () => {
    expect(meldResultOf([relation("Something New", "meld_something")])).toBeNull();
  });
});

describe("meldPartsOf", () => {
  /** The asymmetry these two functions exist for: Gisela is Bruna's sibling, not her half. */
  it("offers nothing from a half, even though its sibling is a meld_part", () => {
    expect(meldPartsOf(BRUNA)).toEqual([]);
  });

  it("offers both halves from the melded card", () => {
    expect(meldPartsOf(BRISELA).map((part) => part.name)).toEqual([
      "Bruna, the Fading Light",
      "Gisela, the Broken Blade",
    ]);
  });

  it("answers empty for a card with no relations", () => {
    expect(meldPartsOf([])).toEqual([]);
  });

  it("ignores a component it does not recognise", () => {
    expect(
      meldPartsOf([
        relation("Gisela, the Broken Blade", "meld_part"),
        relation("Something New", "meld_something"),
      ]).map((part) => part.name),
    ).toEqual(["Gisela, the Broken Blade"]);
  });
});
