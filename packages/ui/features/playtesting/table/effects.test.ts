import { describe, expect, it } from "vitest";
import type { CardEffect } from "@/lib/ipc";
import { effectChip, effectLabel, effectLine } from "./effects";

function effect(over: Partial<CardEffect>): CardEffect {
  return {
    kind: "ability",
    source: "Clavileño, First of the Blessed",
    gained: [],
    lost: [],
    losesAbilities: false,
    abilities: [],
    power: null,
    toughness: null,
    ...over,
  };
}

describe("effectLabel", () => {
  it("writes a P/T raise signed, and one worked out in play as X", () => {
    expect(effectLabel(effect({ kind: "modifyPt", power: 3, toughness: 3 }))).toBe("+3/+3");
    expect(effectLabel(effect({ kind: "modifyPt", power: -2, toughness: 0 }))).toBe("-2/+0");
    expect(effectLabel(effect({ kind: "modifyPt", power: null, toughness: null }))).toBe("+X/+X");
  });

  it("writes a P/T set as the base it sets, and a switch as one", () => {
    expect(effectLabel(effect({ kind: "setPt", power: 0, toughness: 1 }))).toBe("Base 0/1");
    expect(effectLabel(effect({ kind: "switchPt" }))).toBe("P/T switched");
  });

  it("writes the types and colors given and taken, or the kind when the engine names none", () => {
    expect(effectLabel(effect({ kind: "type", gained: ["Demon"] }))).toBe("+Demon");
    expect(effectLabel(effect({ kind: "type", gained: ["Creature"], lost: ["Artifact"] }))).toBe(
      "+Creature −Artifact",
    );
    expect(effectLabel(effect({ kind: "type" }))).toBe("Type changed");
    expect(effectLabel(effect({ kind: "color", gained: ["Black"] }))).toBe("+Black");
  });

  it("names a granted dies trigger, any other trigger and any other ability", () => {
    expect(effectLabel(effect({ abilities: ["When ~ dies, draw a card."] }))).toBe("+Dies trigger");
    expect(effectLabel(effect({ abilities: ["Whenever ~ attacks, scry 1."] }))).toBe("+Trigger");
    expect(effectLabel(effect({ abilities: ["{T}: Add {B}."] }))).toBe("+Ability");
    expect(effectLabel(effect({ gained: ["Flying"], abilities: ["{T}: Add {B}."] }))).toBe(
      "+Flying +Ability",
    );
  });

  it("says a card stripped of its abilities has none", () => {
    expect(effectLabel(effect({ losesAbilities: true }))).toBe("No abilities");
    expect(effectLabel(effect({}))).toBe("Abilities changed");
  });

  it("names the rest by their kind", () => {
    expect(effectLabel(effect({ kind: "control" }))).toBe("Control");
    expect(effectLabel(effect({ kind: "copy" }))).toBe("Copy");
    expect(effectLabel(effect({ kind: "text" }))).toBe("Text changed");
  });
});

describe("effectChip and effectLine", () => {
  it("puts the source after what happened", () => {
    const demon = effect({ kind: "type", gained: ["Demon"] });
    expect(effectChip(demon)).toBe("+Demon · Clavileño, First of the Blessed");
    expect(effectLine(demon, "Bloodghast")).toBe("+Demon from Clavileño, First of the Blessed");
  });

  it("quotes a granted ability's text with the card's own name for ~", () => {
    const dies = effect({ abilities: ["When ~ dies, draw a card."] });
    expect(effectLine(dies, "Bloodghast")).toBe(
      "+Dies trigger from Clavileño, First of the Blessed: “When Bloodghast dies, draw a card.”",
    );
  });
});
