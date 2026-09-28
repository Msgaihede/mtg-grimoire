import { describe, expect, it } from "vitest";
import type { ManagedWishlistMode } from "@/lib/ipc";
import { MANAGED_EMPTY, MANAGED_EMPTY_UNKNOWN, managedEmptySentence } from "./managed";

/**
 * **An empty managed folder speaks for the Compare view its deck follows** (live pass §13). The page
 * had one sentence — `missing`'s — and drew it under a folder following `all`. Each view's emptiness
 * is a different fact about the deck, so each has its own words, and a folder whose view this page
 * cannot read says only what every managed folder is.
 */
describe("managedEmptySentence", () => {
  it("says a different sentence for each view a deck's folder can follow", () => {
    const said = (["all", "missing", "other"] as const).map(managedEmptySentence);
    expect(said).toEqual([MANAGED_EMPTY.all, MANAGED_EMPTY.missing, MANAGED_EMPTY.other]);
    expect(new Set(said).size).toBe(3);
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
