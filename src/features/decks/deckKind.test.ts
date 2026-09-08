import { describe, expect, it } from "vitest";

import {
  DECK_KINDS,
  DECK_KIND_HINT,
  DECK_KIND_LABEL,
  deckKind,
  deckKindPatch,
  rowKind,
  tracksCollection,
  type DeckKind,
} from "./deckKind";

describe("deckKind", () => {
  it("reads the three kinds off the two columns", () => {
    expect(deckKind({ theoryEnabled: false, virtualOnly: false })).toBe("regular");
    expect(deckKind({ theoryEnabled: true, virtualOnly: false })).toBe("theory");
    expect(deckKind({ theoryEnabled: false, virtualOnly: true })).toBe("virtual");
  });

  // The row Rust makes unrepresentable, read anyway: a database from another build or a peer
  // could carry it, and the module doc argues which way it must fall — toward showing the
  // reader *less* of their collection, never more.
  it("reads the impossible pair as virtual", () => {
    expect(deckKind({ theoryEnabled: true, virtualOnly: true })).toBe("virtual");
  });

  it("answers for a whole row through rowKind", () => {
    expect(rowKind({ theoryEnabled: true, virtualOnly: false })).toBe("theory");
    expect(rowKind({ theoryEnabled: false, virtualOnly: true })).toBe("virtual");
  });
});

describe("deckKindPatch", () => {
  // The point of the function: it names *both* columns whichever kind it was handed, so a
  // `theory` deck patched to `virtual` cannot leave `theoryEnabled` standing.
  it("always writes both columns", () => {
    expect(deckKindPatch("regular")).toEqual({ theoryEnabled: false, virtualOnly: false });
    expect(deckKindPatch("theory")).toEqual({ theoryEnabled: true, virtualOnly: false });
    expect(deckKindPatch("virtual")).toEqual({ theoryEnabled: false, virtualOnly: true });
  });

  it("round-trips every kind through deckKind", () => {
    for (const kind of DECK_KINDS) {
      expect(deckKind(deckKindPatch(kind))).toBe(kind);
    }
  });

  it("never produces the pair both set", () => {
    for (const kind of DECK_KINDS) {
      const flags = deckKindPatch(kind);
      expect(flags.theoryEnabled && flags.virtualOnly).toBe(false);
    }
  });
});

describe("tracksCollection", () => {
  it("is false for a virtual deck and true for the other two", () => {
    expect(tracksCollection(deckKindPatch("regular"))).toBe(true);
    expect(tracksCollection(deckKindPatch("theory"))).toBe(true);
    expect(tracksCollection(deckKindPatch("virtual"))).toBe(false);
  });
});

describe("the kind vocabulary", () => {
  it("lists the three kinds in the order the group paints them", () => {
    expect(DECK_KINDS).toEqual(["regular", "theory", "virtual"]);
  });

  // Both records are `Record<DeckKind, …>`, so a fourth kind is a red build rather than a
  // button with `undefined` on it. This asserts the third thing the type cannot: that no label
  // or hint was left blank.
  it("gives every kind a label and a hint", () => {
    for (const kind of DECK_KINDS) {
      expect(DECK_KIND_LABEL[kind]).toBeTruthy();
      expect(DECK_KIND_HINT[kind]).toBeTruthy();
    }
  });

  it("names the virtual kind's hint after what it switches off", () => {
    expect(DECK_KIND_HINT.virtual).toContain("collection");
    expect(DECK_KIND_HINT.virtual).toContain("wishlist");
  });

  /**
   * **The half that was lost once already.** The switch this group replaced warned what a press
   * *cost* — "makes the deck you have the plan and starts the actual list empty" — and the first
   * draft of these hints said only what each kind *is*, which left the one press that refiles the
   * reader's cardboard describing itself as a preference.
   *
   * Pinned on the two presses that move something and deliberately not on `regular`, which moves
   * nothing and would be promising a consequence it does not have.
   */
  it("says what the two moving presses cost", () => {
    expect(DECK_KIND_HINT.virtual).toContain("Recently removed");
    expect(DECK_KIND_HINT.theory).toContain("actual list empty");
  });

  it("has three distinct labels", () => {
    const labels = new Set(DECK_KINDS.map((kind: DeckKind) => DECK_KIND_LABEL[kind]));
    expect(labels.size).toBe(3);
  });
});
