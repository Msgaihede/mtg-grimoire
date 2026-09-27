import { describe, expect, it } from "vitest";
import { UNFILED_SHELF } from "./shelves";
import { tileKeyOf } from "./tileKey";

/** A Scryfall id, because that is the shape every real key starts with. */
const BOLT = "e3285e6b-3e79-4d7c-bf96-d920f973b80f";

describe("tileKeyOf", () => {
  /**
   * The deck editor's docked collection column and the shelved wall's ring both still call the
   * two-argument form, and both depend on it spelling exactly what it spelled before the folder
   * argument existed.
   */
  it("spells the key it always has when no folder is named", () => {
    expect(tileKeyOf(BOLT, "foil")).toBe(`${BOLT}:foil`);
    expect(tileKeyOf(BOLT, null)).toBe(`${BOLT}:nonfoil`);
    expect(tileKeyOf(BOLT, "etched", undefined)).toBe(`${BOLT}:etched`);
  });

  it("names the folder, so one printing in two folders is two tiles", () => {
    expect(tileKeyOf(BOLT, "foil", 12)).toBe(`${BOLT}:foil@12`);
    expect(tileKeyOf(BOLT, "foil", 12)).not.toBe(tileKeyOf(BOLT, "foil", 13));
    expect(tileKeyOf(BOLT, "foil", 12)).not.toBe(tileKeyOf(BOLT, "foil"));
  });

  it("keys a copy filed nowhere apart from every folder, under either spelling of nowhere", () => {
    expect(tileKeyOf(BOLT, null, null)).toBe(`${BOLT}:nonfoil@unfiled`);
    expect(tileKeyOf(BOLT, null, UNFILED_SHELF)).toBe(tileKeyOf(BOLT, null, null));
    for (const folderId of [1, 2, 12, 120]) {
      expect(tileKeyOf(BOLT, null, folderId)).not.toBe(tileKeyOf(BOLT, null, null));
    }
  });

  it("never spells two different tiles alike", () => {
    const cards = [BOLT, "0000579f-7b35-4ed3-b44c-db2a538066fe"];
    const finishes = [null, "foil", "etched"];
    const folders = [undefined, null, 1, 12, 120];
    const keys = cards.flatMap((card) =>
      finishes.flatMap((finish) => folders.map((folder) => tileKeyOf(card, finish, folder))),
    );
    expect(new Set(keys).size).toBe(cards.length * finishes.length * folders.length);
  });
});
