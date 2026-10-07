import { describe, expect, it } from "vitest";
import type { CollectionFolder } from "@/lib/ipc";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "../fixtures";
import { isUserFolder, withoutCommitted } from "./trayCommit";

const BINDER: CollectionFolder = {
  id: 7,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "f7",
};
const DECK_GROUP: CollectionFolder = { ...BINDER, id: 9, name: "Burn", kind: "deck", deckId: 4, syncUid: "f9" };

describe("isUserFolder", () => {
  it("takes the root, whatever the list holds", () => {
    expect(isUserFolder([], null)).toBe(true);
    expect(isUserFolder([BINDER, DECK_GROUP], null)).toBe(true);
  });

  it("takes a drawer the reader made, and no other kind", () => {
    expect(isUserFolder([BINDER, DECK_GROUP], BINDER.id)).toBe(true);
    // A deck's group is a folder the import can file into, and the tray must not.
    expect(isUserFolder([BINDER, DECK_GROUP], DECK_GROUP.id)).toBe(false);
  });

  it("refuses an id the list does not hold", () => {
    expect(isUserFolder([BINDER], 404)).toBe(false);
  });
});

describe("withoutCommitted", () => {
  const [, saga, tomb, lotus] = TRAY_ROWS;
  const committed = [saga, tomb, lotus];

  it("drops every row the commit took and nothing has touched since", () => {
    expect(withoutCommitted(committed, committed)).toEqual([]);
  });

  it("keeps a card that landed while the commit was in flight", () => {
    const now = [NEEDS_A_FINISH_ROW, ...committed];
    expect(withoutCommitted(now, committed)).toEqual([NEEDS_A_FINISH_ROW]);
  });

  it("keeps only the copies a bump added after the snapshot", () => {
    const bumped = { ...saga, quantity: saga.quantity + 2, addedAt: saga.addedAt + 1 };
    expect(withoutCommitted([bumped, tomb, lotus], committed)).toEqual([{ ...bumped, quantity: 2 }]);
  });

  it("drops a taken row that was edited some other way — the commit filed the card it was", () => {
    // A finish change is a new object for the row, and not more copies of what was filed.
    const refinished = { ...tomb, finish: "nonfoil" as const, quantity: tomb.quantity + 1 };
    expect(withoutCommitted([saga, refinished, lotus], committed)).toEqual([]);
    // Fewer copies than were filed leaves nothing to keep either.
    const fewer = { ...saga, quantity: 1 };
    expect(withoutCommitted([fewer, tomb, lotus], committed)).toEqual([]);
  });

  it("tells an untouched row from a rebuilt one by identity, not by value", () => {
    // The same fields in a new object is a row something wrote; with no extra copies it goes.
    expect(withoutCommitted([{ ...saga }], [saga])).toEqual([]);
    expect(withoutCommitted([saga], [saga])).toEqual([]);
  });

  it("keeps the order the tray was in", () => {
    const fresh = { ...NEEDS_A_FINISH_ROW, key: "fresh" };
    const now = [fresh, saga, NEEDS_A_FINISH_ROW, tomb];
    expect(withoutCommitted(now, [saga, tomb]).map((row) => row.key)).toEqual([
      "fresh",
      NEEDS_A_FINISH_ROW.key,
    ]);
  });
});
