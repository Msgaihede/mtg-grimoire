import { describe, expect, it } from "vitest";
import {
  CHOICE_CHARS,
  DESCRIPTION_CHARS,
  MAX_CHOICES,
  choices,
  description,
  holdingReply,
  lineText,
  moreText,
} from "./render";
import type { Holding, Line } from "./types";

const line = (over: Partial<Line> = {}): Line => ({
  quantity: 2,
  setName: "Commander 2021",
  setCode: "c21",
  collectorNumber: "263",
  finish: "foil",
  folder: "Binder/Artifacts",
  priceUsd: 4,
  ...over,
});

const holding = (lines: Line[], more = 0): Holding => ({
  name: "Sol Ring",
  image: "https://cards.scryfall.io/normal/sol.jpg",
  typeLine: "Artifact",
  total: lines.reduce((n, l) => n + l.quantity, 0),
  lines,
  more,
});

describe("a held printing's line", () => {
  it("is the count, the set, the number, the finish and the folder", () => {
    expect(lineText(line())).toBe("2× Commander 2021 (C21) #263 · Foil · Binder/Artifacts");
  });
  it("says nothing of the regular finish or the root folder", () => {
    expect(lineText(line({ finish: "nonfoil", folder: null, quantity: 1 }))).toBe(
      "1× Commander 2021 (C21) #263",
    );
    expect(lineText(line({ finish: "etched", folder: "" }))).toBe(
      "2× Commander 2021 (C21) #263 · Etched",
    );
  });
  it("names a wish for any printing as such", () => {
    expect(
      lineText(
        line({
          setCode: null,
          setName: null,
          collectorNumber: null,
          finish: null,
          folder: "Upgrades",
        }),
      ),
    ).toBe("2× Any printing · Upgrades");
  });
  it("escapes what a reader typed into a folder's name", () => {
    expect(lineText(line({ folder: "*Foils*_box" }))).toBe(
      "2× Commander 2021 (C21) #263 · Foil · \\*Foils\\*\\_box",
    );
  });
});

describe("a description", () => {
  it("is every line when they fit", () => {
    expect(description(["a", "b"], 0)).toBe("a\nb");
  });
  it("counts what the engine left out", () => {
    expect(description(["a"], 3)).toBe(`a\n${moreText(3)}`);
  });
  it("stays inside Discord's 4 096 characters and says how many it dropped", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i}× ${"x".repeat(60)}`);
    const text = description(lines, 5);
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_CHARS);
    const kept = text.split("\n").length - 1;
    expect(text.endsWith(moreText(200 - kept + 5))).toBe(true);
  });
});

describe("a holding's answer", () => {
  it("is a public embed with the picture and every line", () => {
    const reply = holdingReply(
      "collection",
      "sol ring",
      holding([line(), line({ quantity: 1, finish: "nonfoil", folder: null })]),
    );
    const sent = JSON.parse(reply.body);
    expect(reply.status).toBe(200);
    expect(sent.type).toBe(4);
    expect(sent.data.flags).toBeUndefined();
    expect(sent.data.allowed_mentions).toEqual({ parse: [] });
    const [embed] = sent.data.embeds;
    expect(embed.title).toBe("Sol Ring");
    expect(embed.thumbnail).toEqual({ url: "https://cards.scryfall.io/normal/sol.jpg" });
    expect(embed.description).toBe(
      "2× Commander 2021 (C21) #263 · Foil · Binder/Artifacts\n1× Commander 2021 (C21) #263",
    );
    expect(embed.footer.text).toBe("3 copies in the collection · Artifact");
  });
  it("is a sentence for the reader alone when the card is not there", () => {
    const sent = JSON.parse(holdingReply("wishlist", " Black Lotus ", null).body);
    expect(sent.data.flags).toBe(64);
    expect(sent.data.content).toBe("**Black Lotus** is not in your wishlist.");
  });
});

describe("an autocomplete's answer", () => {
  it("keeps to 25 choices of at most 100 characters, and drops an empty one", () => {
    const long = "y".repeat(150);
    const list = [
      { name: "", value: "x" },
      ...Array.from({ length: 40 }, (_, i) => ({ name: `${long}${i}`, value: `${long}${i}` })),
    ];
    const sent = JSON.parse(choices(list).body);
    expect(sent.type).toBe(8);
    expect(sent.data.choices).toHaveLength(MAX_CHOICES);
    for (const c of sent.data.choices) {
      expect([...c.name].length).toBeLessThanOrEqual(CHOICE_CHARS);
      expect([...c.value].length).toBeLessThanOrEqual(CHOICE_CHARS);
      expect(c.name).not.toBe("");
    }
  });
});
