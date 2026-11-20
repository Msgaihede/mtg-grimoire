import { describe, expect, it } from "vitest";
import {
  ALWAYS,
  availableFields,
  defaultFields,
  SURFACE_FIELDS,
  TRANSFER_FIELDS,
  type TransferSurface,
} from "../fields";
import { EXPORT_FORMATS } from "../formats";
import { EXAMPLE_CARDS, exampleText } from "./example";
import { formatExport, isActivePile } from "./format";

const SURFACES = Object.keys(SURFACE_FIELDS) as TransferSurface[];
const lineCount = (text: string) => text.trimEnd().split("\n").length;

describe("exampleText", () => {
  it("is formatExport over the surface's made-up pile — the writer's own output", () => {
    for (const surface of SURFACES) {
      for (const format of EXPORT_FORMATS) {
        const fields = defaultFields(format, surface);
        expect(exampleText(surface, format, fields)).toBe(
          formatExport(EXAMPLE_CARDS[surface], format, fields),
        );
      }
    }
  });

  it("writes the deck's Archidekt line the way the issue's screenshot shows it", () => {
    const text = exampleText("deck", "archidekt", defaultFields("archidekt", "deck"));
    expect(text).toBe(
      [
        "Commander",
        "1x Example Commander (set) 1 [Commander]",
        "",
        "Example category",
        "4x Example Card (set) 123 [Example category] *F* ^Buy,#0066ff^",
        "1x Another Card (set) 45 [Example category]",
        "",
      ].join("\n"),
    );
  });

  it("shows each format's structure on a deck", () => {
    // MTGO's `SB:` on the commander (issue #1180), and Moxfield's fixed section headings.
    expect(exampleText("deck", "mtgo", defaultFields("mtgo", "deck"))).toBe(
      "SB: 1 Example Commander\n4 Example Card\n1 Another Card\n",
    );
    expect(exampleText("deck", "moxfield", defaultFields("moxfield", "deck"))).toBe(
      [
        "Commander",
        "1 Example Commander (SET) 1",
        "",
        "Deck",
        "4 Example Card (SET) 123 *F*",
        "1 Another Card (SET) 45",
        "",
      ].join("\n"),
    );
  });

  it("follows the field choice — a field switched off leaves the example", () => {
    const fields = defaultFields("archidekt", "deck").filter((id) => id !== "label");
    const text = exampleText("deck", "archidekt", fields);
    expect(text).not.toContain("^Buy");
    expect(text).toContain("4x Example Card (set) 123 [Example category] *F*\n");
  });

  it("stays a few lines long in every format, on every surface", () => {
    for (const surface of SURFACES) {
      for (const format of EXPORT_FORMATS) {
        const n = lineCount(exampleText(surface, format, defaultFields(format, surface)));
        expect(n, `${surface} ${format}`).toBeGreaterThanOrEqual(3);
        expect(n, `${surface} ${format}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it("never loses a card to the fold or a filter, whatever the reader ticks", () => {
    for (const surface of SURFACES) {
      const cards = EXAMPLE_CARDS[surface];
      // Every card has a name of its own, so even `quantity` and `name` alone keep three rows.
      expect(new Set(cards.map((c) => c.name)).size).toBe(cards.length);
      expect(lineCount(exampleText(surface, "plain", ALWAYS))).toBe(cards.length);
      // In switched-on piles only, so neither the reader's box nor Arena's and MTGO's own rule
      // holds a line back.
      expect(cards.every(isActivePile)).toBe(true);
    }
  });

  it("fills every column the surface can write, so no example column is blank throughout", () => {
    for (const surface of SURFACES) {
      for (const id of availableFields("csv", surface)) {
        const filled = EXAMPLE_CARDS[surface].some((c) => TRANSFER_FIELDS[id].read(c) !== "");
        expect(filled, `${surface} ${id}`).toBe(true);
      }
    }
  });

  it("holds only the facts its surface holds, as the real adapters do", () => {
    // A wish row carries no set name (`fromWishRow`), and only a deck has piles or labels.
    expect(EXAMPLE_CARDS.wishlist.every((c) => c.setName === null)).toBe(true);
    for (const surface of SURFACES) {
      if (surface === "deck") continue;
      for (const c of EXAMPLE_CARDS[surface]) {
        expect(c.categoryKind, surface).toBeNull();
        expect(c.labelName, surface).toBeNull();
      }
    }
    for (const surface of ["deck", "wishlist", "trade"] as const) {
      expect(
        EXAMPLE_CARDS[surface].every((c) => c.condition === null),
        surface,
      ).toBe(true);
    }
  });
});
