import { describe, expect, it } from "vitest";
import deckRs from "../../../../apps/desktop/src-tauri/src/share/deck.rs?raw";
import { DECK_SHARE_PREFIX, deckShareTarget } from "./deckShare";

describe("deckShareTarget", () => {
  it("keys a deck on its synced uid", () => {
    expect(deckShareTarget({ name: "Krenko", syncUid: "abc" })).toEqual({
      kind: "deck",
      uid: "deck:abc",
      title: "Krenko",
    });
  });

  it("offers no control for a deck with no uid, rather than a fallback key", () => {
    expect(deckShareTarget({ name: "Krenko", syncUid: null })).toBeNull();
    expect(deckShareTarget({ name: "Krenko", syncUid: "" })).toBeNull();
    expect(deckShareTarget(null)).toBeNull();
  });

  // One string in three languages: the crate's reader, this builder and the Worker's card.
  it("spells the prefix the crate's reader does", () => {
    expect(deckRs).toContain(`pub const PREFIX: &str = "${DECK_SHARE_PREFIX}";`);
  });
});
