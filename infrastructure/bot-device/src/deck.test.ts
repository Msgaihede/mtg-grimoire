import { describe, expect, it } from "vitest";
import type { TransferCard } from "@grimoire/ui/features/transfer/TransferCard";
import { deckFormat, deckReply, fileName, writeDeck } from "./deck";
import type { DeckSummary } from "./types";

/** A deck card as the engine answers it: `queries::TransferCard`, every absent fact `null`. */
const card = (over: Partial<TransferCard>): TransferCard => ({
  name: "Sol Ring",
  quantity: 1,
  setCode: "c21",
  collectorNumber: "263",
  finish: null,
  lang: "en",
  categoryName: "Main deck",
  categoryKind: "main",
  categoryActive: true,
  condition: null,
  tradelistQuantity: null,
  purchasePrice: null,
  purchaseCurrency: null,
  acquiredAt: null,
  acquisitionSource: null,
  serialNumber: null,
  grading: null,
  altered: null,
  signed: null,
  proxy: null,
  misprint: null,
  tags: null,
  notes: null,
  setName: "Commander 2021",
  rarity: "uncommon",
  typeLine: "Artifact",
  unitPrice: 1.5,
  labelName: null,
  labelColor: null,
  legalities: '{"historic":"legal"}',
  ...over,
});

const DECK: DeckSummary = { uid: "deck-1", name: "Artifact Storm", format: "commander", cards: 3 };

describe("a deck's list", () => {
  it("is the export writer's text: plain carries the finish", () => {
    const written = writeDeck(
      [card({ finish: "foil" }), card({ name: "Lightning Bolt", quantity: 2 })],
      "plain",
    );
    expect(written.text).toBe("1 Sol Ring *F*\n2 Lightning Bolt\n");
  });

  it("in Arena, leaves out a switched-off pile and what Arena does not have, and counts both", () => {
    const written = writeDeck(
      [
        card({}),
        card({ name: "Mox Diamond", legalities: '{"legacy":"legal"}', quantity: 2 }),
        card({
          name: "Island",
          categoryName: "Maybeboard",
          categoryKind: "maybe",
          categoryActive: false,
          quantity: 3,
        }),
      ],
      "arena",
    );
    expect(written.text).toBe("Deck\n1 Sol Ring (C21) 263\n");
    expect(written.notInArena).toBe(2);
    expect(written.inactive).toBe(3);
  });

  it("takes plain when no format, or an unknown one, is named", () => {
    expect(deckFormat(null)).toBe("plain");
    expect(deckFormat("csv")).toBe("plain");
    expect(deckFormat("moxfield")).toBe("moxfield");
  });
});

describe("a deck's answer", () => {
  it("is a code block when it fits a message", () => {
    const reply = deckReply(DECK, [card({})], "plain", "b");
    const sent = JSON.parse(reply.body);
    expect(reply.contentType).toBe("application/json");
    expect(sent.data.content).toBe("**Artifact Storm** · Plain text\n```\n1 Sol Ring\n```");
    expect(sent.data.flags).toBeUndefined();
  });

  it("is a text file attached to the message when it does not", () => {
    const cards = Array.from({ length: 120 }, (_, i) =>
      card({ name: `A Card With A Long Name Number ${i}` }),
    );
    const reply = deckReply(DECK, cards, "moxfield", "BOUNDARY");
    expect(reply.contentType).toBe("multipart/form-data; boundary=BOUNDARY");
    const parts = reply.body.split("--BOUNDARY");
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe("--\r\n");
    const payload = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
    expect(payload.type).toBe(4);
    expect(payload.data.attachments).toEqual([{ id: 0, filename: "Artifact-Storm.txt" }]);
    expect(payload.data.content).toBe("**Artifact Storm** · Moxfield");
    expect(parts[2]).toContain('name="files[0]"; filename="Artifact-Storm.txt"');
    expect(parts[2]).toContain("1 A Card With A Long Name Number 119 (C21) 263\n");
  });

  it("is a sentence for the reader alone when the format leaves nothing", () => {
    const sent = JSON.parse(
      deckReply(DECK, [card({ categoryActive: false, categoryKind: "maybe" })], "mtgo", "b").body,
    );
    expect(sent.data.flags).toBe(64);
  });

  it("names its file after the deck", () => {
    expect(fileName("Éowyn's  Riders!")).toBe("Eowyns-Riders.txt");
    expect(fileName("???")).toBe("deck.txt");
  });
});
