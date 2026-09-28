import { describe, expect, it } from "vitest";
import type { ManagedWishlistMode, WishlistFolder } from "@/lib/ipc";
import {
  MANAGED_EMPTY,
  MANAGED_EMPTY_UNKNOWN,
  MANAGED_TOKENS_EMPTY,
  managedEmptySentence,
  managedIds,
  managedWishFolders,
  userWishFolders,
} from "./managed";

const folder = (over: Partial<WishlistFolder> & Pick<WishlistFolder, "id" | "name">): WishlistFolder => ({
  parentId: null,
  sortOrder: 0,
  managedDeckId: null,
  managedTokens: false,
  ...over,
});

/**
 * **A managed wishlist's Tokens child** (user schema v55) — the deck's like its parent, so no
 * destination offers it and every wish in it is the deck's; but **not** a managed folder of its own
 * in a list of them by name, where every deck's would read `Tokens` and nothing would tell them
 * apart. Its parent is what names it.
 */
describe("a managed wishlist's Tokens child", () => {
  const TESTBED = folder({ id: 9, name: "Rhystic Testbed", managedDeckId: 4 });
  const TESTBED_TOKENS = folder({
    id: 10,
    parentId: 9,
    name: "Tokens",
    managedDeckId: 4,
    managedTokens: true,
  });
  const KENRITH = folder({ id: 11, name: "Kenrith", managedDeckId: 2 });
  const KENRITH_TOKENS = folder({
    id: 12,
    parentId: 11,
    name: "Tokens",
    managedDeckId: 2,
    managedTokens: true,
  });
  const WANTS = folder({ id: 1, name: "Wants" });
  const ALL = [TESTBED_TOKENS, WANTS, KENRITH_TOKENS, TESTBED, KENRITH];

  it("is left out of the managed folders listed by name", () => {
    expect(managedWishFolders(ALL).map((f) => f.id)).toEqual([KENRITH.id, TESTBED.id]);
  });

  it("is still the deck's: never a destination, and its wishes are the deck's", () => {
    expect(userWishFolders(ALL)).toEqual([WANTS]);
    expect([...managedIds(ALL)].sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
  });

  it("says its own sentence when empty, under either view that fills it", () => {
    expect(managedEmptySentence("all", true)).toBe(MANAGED_TOKENS_EMPTY);
    expect(managedEmptySentence("tokens", true)).toBe(MANAGED_TOKENS_EMPTY);
    // Where the view cannot be read, the child claims nothing either.
    expect(managedEmptySentence(undefined, true)).toBe(MANAGED_EMPTY_UNKNOWN);
    // And the parent's sentence is unchanged by the child existing.
    expect(managedEmptySentence("tokens")).toBe(MANAGED_EMPTY.tokens);
    expect(Object.values(MANAGED_EMPTY)).not.toContain(MANAGED_TOKENS_EMPTY);
  });
});

/**
 * **An empty managed folder speaks for the Compare view its deck follows** (live pass §13). The page
 * had one sentence — `missing`'s — and drew it under a folder following `all`. Each view's emptiness
 * is a different fact about the deck, so each has its own words, and a folder whose view this page
 * cannot read says only what every managed folder is.
 */
describe("managedEmptySentence", () => {
  it("says a different sentence for each view a deck's folder can follow", () => {
    // An arrow, not the function itself: `map`'s index would arrive as the Tokens-child flag.
    const said = (["all", "missing", "other", "tokens"] as const).map((mode) =>
      managedEmptySentence(mode),
    );
    expect(said).toEqual([
      MANAGED_EMPTY.all,
      MANAGED_EMPTY.missing,
      MANAGED_EMPTY.other,
      MANAGED_EMPTY.tokens,
    ]);
    expect(new Set(said).size).toBe(4);
  });

  /** The settle drops the Tokens child when the deck is short of no token, so the parent's
   *  sentence must not point at *the* folder as though it were always there. */
  it("names no Tokens folder under `tokens` that may not exist", () => {
    expect(MANAGED_EMPTY.tokens).not.toMatch(/the Tokens folder/);
    expect(MANAGED_EMPTY.tokens).toMatch(/a Tokens folder inside it/);
  });

  it("keeps the words this page already said for `missing`", () => {
    expect(managedEmptySentence("missing")).toBe(
      "Nothing missing. The deck includes every card in the plan.",
    );
  });

  it("claims no view where it cannot read one", () => {
    expect(managedEmptySentence(undefined)).toBe(MANAGED_EMPTY_UNKNOWN);
    // `off` keeps no folder, so it cannot be the folder on screen — the same honest answer.
    expect(managedEmptySentence("off")).toBe(MANAGED_EMPTY_UNKNOWN);
    expect(Object.values(MANAGED_EMPTY)).not.toContain(MANAGED_EMPTY_UNKNOWN);
  });

  /** The type is `ipc.ts`'s hand-written promise, not the wire's: a mode a later schema adds — or
   *  a name `Object.prototype` carries — must still come back as words, never `undefined`. */
  it("says the unknown sentence for a mode this build has never heard of", () => {
    for (const mode of ["subset", "toString", ""]) {
      expect(managedEmptySentence(mode as ManagedWishlistMode)).toBe(MANAGED_EMPTY_UNKNOWN);
    }
  });
});
