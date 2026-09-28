import { describe, expect, it } from "vitest";
import type { DeckTokenView } from "./deckTokens";
import { caretEntryAfterRemove, removalShown } from "./tokenCaret";

/** An entry as the caret reads one: its token, its key, and whether it is stored. */
function view(oracleId: string, entryKey: string, implicit = false): DeckTokenView {
  return { oracleId, entryKey, implicit } as DeckTokenView;
}

// Soldier (two entries), Treasure (three), Wurm (one) — the wall's order.
const WALL = [
  view("soldier", "s1"),
  view("soldier", "s2"),
  view("treasure", "t1"),
  view("treasure", "t2"),
  view("treasure", "t3"),
  view("wurm", "w1"),
];
const without = (key: string) => WALL.filter((entry) => entry.entryKey !== key);

describe("caretEntryAfterRemove", () => {
  it("hands on to the same token's next entry, the one now in the removed one's place", () => {
    expect(caretEntryAfterRemove(WALL, without("t2"), "t2")).toBe("t3");
    expect(caretEntryAfterRemove(WALL, without("t1"), "t1")).toBe("t2");
  });

  it("hands back to the same token's previous entry when the removed one was its last", () => {
    expect(caretEntryAfterRemove(WALL, without("t3"), "t3")).toBe("t2");
  });

  it("hands on to the same token's implicit entry, which is what a derived token falls back to", () => {
    const after = [...without("w1"), view("wurm", "w1", true)];
    expect(caretEntryAfterRemove(WALL, after, "w1")).toBe("w1");
  });

  it("hands on to the next token's first entry when the token has gone", () => {
    const before = WALL.slice(1); // a Soldier with one entry left
    expect(caretEntryAfterRemove(before, before.slice(1), "s2")).toBe("t1");
  });

  it("hands back to the previous token's last entry when the last token has gone", () => {
    expect(caretEntryAfterRemove(WALL, without("w1"), "w1")).toBe("t3");
  });

  it("answers null when nothing is left", () => {
    expect(caretEntryAfterRemove([view("wurm", "w1")], [], "w1")).toBeNull();
  });
});

describe("removalShown", () => {
  it("counts an implicit entry at the removed key as gone, and a stored one as not yet", () => {
    expect(removalShown([view("wurm", "w1", true)], "w1")).toBe(true);
    expect(removalShown([view("wurm", "w1")], "w1")).toBe(false);
    expect(removalShown([], "w1")).toBe(true);
  });
});
