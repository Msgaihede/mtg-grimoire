import { describe, expect, it } from "vitest";
import type { DeckFinish, TheorySlot } from "@/lib/ipc";
import {
  theoryMatchMark,
  theoryMatchPlan,
  theoryNameKey,
  theorySlot,
  type TheoryMarkSwitches,
} from "./theoryMatch";

/**
 * A live row, at the four fields the two functions read between them — the address, what it
 * holds, whether the pile it is in counts, and (since the mark grew a second tier) its name.
 *
 * Both signatures take a `Pick`, so a test that built a whole `DeckCard` would be asserting about
 * columns no code path touches. `name` defaults to the id rather than to a constant: a fixture
 * whose rows all shared one name would make every miss on the loose tier a hit by accident.
 */
const card = (over: {
  cardId: string;
  finish?: DeckFinish;
  name?: string;
  quantity?: number;
  categoryActive?: boolean;
}) => ({
  cardId: over.cardId,
  finish: over.finish ?? null,
  name: over.name ?? over.cardId,
  quantity: over.quantity ?? 1,
  categoryActive: over.categoryActive ?? true,
});

/** A slot as `deck_theory_slots` answers one — see the note on the literals below. */
const slot = (key: string, nameKey: string | null, quantity = 1): TheorySlot => ({
  key,
  nameKey,
  quantity,
});

/** Both marks on, which is what every deck is born with and what everything but the switch block
 *  asks about. */
const BOTH: TheoryMarkSwitches = { exact: true, name: true };

/**
 * **The slots are hand-spelled rather than built with {@link theorySlot}, and that is the point.**
 *
 * They come off the wire from `deck_theory_slots`, which answers `deck_theory.rs`'s own
 * `group_key` strings — so a test that generated both sides here would pass whatever separator
 * this file happened to use and prove only that it agrees with itself. These are the same
 * literals `deck_theory.rs`'s own tests assert (`"bolt-lea|"`, `"bolt-lea|foil"`), written out on
 * both sides of the boundary so a change to `GROUP_SEPARATOR` fails one suite or the other rather
 * than silently unlighting every mark in the app.
 */
describe("theorySlot", () => {
  it("spells a live row the way the backend spells a planned one", () => {
    expect(theorySlot(card({ cardId: "bolt-lea" }))).toBe("bolt-lea|");
    expect(theorySlot(card({ cardId: "bolt-lea", finish: "foil" }))).toBe("bolt-lea|foil");
    expect(theorySlot(card({ cardId: "bolt-lea", finish: "etched" }))).toBe("bolt-lea|etched");
  });

  it("gives two regular copies of one printing the same address", () => {
    expect(theorySlot(card({ cardId: "bolt-lea" }))).toBe(
      theorySlot(card({ cardId: "bolt-lea", finish: null })),
    );
  });
});

describe("theoryNameKey", () => {
  it("folds case and trims, and does nothing else", () => {
    expect(theoryNameKey("  Lightning Bolt ")).toBe("lightning bolt");
    expect(theoryNameKey("LIGHTNING BOLT")).toBe("lightning bolt");
  });

  /** The whole reason the fold is written here and not in SQL: SQLite's `lower()` is ASCII-only
   *  and this one is not, so folding on the Rust side would spell two keys for these two names. */
  it("folds the letters SQLite's own lower() would not", () => {
    expect(theoryNameKey("Lim-Dûl's Vault")).toBe("lim-dûl's vault");
    expect(theoryNameKey("Æther Vial")).toBe("æther vial");
  });
});

describe("the two tiers", () => {
  it("draws the exact tier for the printing the plan names", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })),
    ).toEqual({ tier: "exact", delta: 0 });
  });

  it("draws the loose tier for another printing of the same card", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt" })),
    ).toEqual({ tier: "name", delta: 0 });
  });

  it("draws the loose tier for the same printing in the wrong finish", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|foil", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })),
    ).toEqual({ tier: "name", delta: 0 });
  });

  it("draws nothing for a card the plan does not ask for at all", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "ring-c11", finish: null, name: "Sol Ring", quantity: 1 })],
      BOTH,
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "ring-c11", finish: null, name: "Sol Ring" })),
    ).toBeNull();
  });
});

describe("the number's grain follows the tier", () => {
  /**
   * The reader's own example, 2026-09-07. The plan asks for eight Forests of one printing; the
   * list holds eight over four printings, two of each.
   *
   * **Every one of the eight is marked** — the maps are built once and read, never consumed, so
   * this is not "the last Forest wins" — and the numbers differ by tier on purpose: the green
   * rows report the *printing* they are two of against the eight planned (six to add, `+6`), and
   * the blue rows report the *card*, which is exactly right at eight against eight.
   */
  it("marks all eight Forests, green ones by printing and blue ones by card", () => {
    const printings = ["forest-a", "forest-b", "forest-c", "forest-d"];
    const live = printings.map((cardId) =>
      card({ cardId, finish: null, name: "Forest", quantity: 2 }),
    );
    const plan = theoryMatchPlan([{ key: "forest-a|", nameKey: "Forest", quantity: 8 }], live, BOTH);
    const marks = printings.map((cardId) =>
      theoryMatchMark(plan, card({ cardId, finish: null, name: "Forest" })),
    );
    expect(marks[0]).toEqual({ tier: "exact", delta: 6 });
    expect(marks.slice(1)).toEqual([
      { tier: "name", delta: 0 },
      { tier: "name", delta: 0 },
      { tier: "name", delta: 0 },
    ]);
    expect(marks.every((m) => m !== null)).toBe(true);
  });

  it("counts every finish of every printing on the loose tier", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [
        card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt", quantity: 1 }),
        card({ cardId: "bolt-m10", finish: "foil", name: "Lightning Bolt", quantity: 1 }),
      ],
      BOTH,
    );
    // Two live, four planned, at the card's grain: two to add.
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: "foil", name: "Lightning Bolt" })),
    ).toEqual({ tier: "name", delta: 2 });
  });

  /** The plan's own half of the loose sum: two printings of one card in the plan are one order
   *  for that card, however many rows the wire carries them on. */
  it("sums the plan's own printings of one card on the loose tier", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 2), slot("bolt-m10|", "Lightning Bolt", 2)],
      [card({ cardId: "bolt-2xm", name: "Lightning Bolt", quantity: 1 })],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-2xm", name: "Lightning Bolt" }))).toEqual({
      tier: "name",
      delta: 3,
    });
  });
});

describe("the switches", () => {
  it("re-resolves an exact row as a loose one when the exact mark is off", () => {
    const plan = theoryMatchPlan(
      [{ key: "forest-a|", nameKey: "Forest", quantity: 8 }],
      [
        card({ cardId: "forest-a", finish: null, name: "Forest", quantity: 2 }),
        card({ cardId: "forest-b", finish: null, name: "Forest", quantity: 6 }),
      ],
      { exact: false, name: true },
    );
    // Blue, and blue's number: eight live against eight planned, not two against eight.
    expect(
      theoryMatchMark(plan, card({ cardId: "forest-a", finish: null, name: "Forest" })),
    ).toEqual({ tier: "name", delta: 0 });
  });

  it("draws nothing for a loose row when the loose mark is off, and keeps the exact one", () => {
    const live = [
      card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 }),
      card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt", quantity: 4 }),
    ];
    const plan = theoryMatchPlan([{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }], live, {
      exact: true,
      name: false,
    });
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })),
    ).toEqual({ tier: "exact", delta: 0 });
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt" })),
    ).toBeNull();
  });

  it("draws nothing at all with both switches off", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 })],
      { exact: false, name: false },
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })),
    ).toBeNull();
  });
});

describe("the name key", () => {
  it("folds case on both sides", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 1 }],
      [card({ cardId: "bolt-m10", finish: null, name: "LIGHTNING BOLT", quantity: 1 })],
      BOTH,
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "LIGHTNING BOLT" })),
    ).toEqual({ tier: "name", delta: 0 });
  });

  /** A slot with no name is an orphan: it can still be matched exactly and can match nothing
   *  loosely. A `null` that fell into the map as a key would make every unnamed live row match
   *  every orphan. */
  it("gives an orphan slot no loose tier", () => {
    const plan = theoryMatchPlan(
      [{ key: "gone|", nameKey: null, quantity: 1 }],
      [card({ cardId: "other", finish: null, name: "Forest", quantity: 1 })],
      BOTH,
    );
    expect(plan?.byName.size).toBe(0);
    expect(theoryMatchMark(plan, card({ cardId: "other", finish: null, name: "Forest" }))).toBeNull();
  });

  /** An orphan is still a *planned printing*, so the exact tier is untouched by its having no
   *  name at all. */
  it("still matches an orphan slot exactly", () => {
    const plan = theoryMatchPlan(
      [{ key: "gone|", nameKey: null, quantity: 1 }],
      [card({ cardId: "gone", finish: null, name: "Whatever the row remembers", quantity: 1 })],
      BOTH,
    );

    expect(
      theoryMatchMark(
        plan,
        card({ cardId: "gone", finish: null, name: "Whatever the row remembers" }),
      ),
    ).toEqual({ tier: "exact", delta: 0 });
  });
});

/** Issue #212 — the number the mark draws when the two lists disagree about a card they both
 *  hold. Every case here is about `planned − live` at the exact grain, which the second tier
 *  leaves exactly as it was. **The sign is the action** (issue #400, 2026-09-08): positive is
 *  copies to add, negative is copies to remove — the reverse of the `live − planned` these cases
 *  asserted until then, so a flipped subtraction fails the two signed cases below rather than
 *  passing them. */
describe("the exact tier's arithmetic", () => {
  it("marks a live row the plan asks for", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt"), slot("ring-c21|", "Sol Ring")],
      [
        card({ cardId: "bolt-lea", name: "Lightning Bolt" }),
        card({ cardId: "ring-c21", name: "Sol Ring" }),
      ],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
    expect(theoryMatchMark(plan, card({ cardId: "ring-c21", name: "Sol Ring" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
  });

  /** The finish is part of the address, so the planned foil takes the exact tier and the regular
   *  copy beside it falls through to the loose one. */
  it("keeps the exact tier for the finish the plan named", () => {
    const plan = theoryMatchPlan(
      [slot("ring-c21|foil", "Sol Ring")],
      [
        card({ cardId: "ring-c21", name: "Sol Ring" }),
        card({ cardId: "ring-c21", name: "Sol Ring", finish: "foil" }),
      ],
      BOTH,
    );

    expect(
      theoryMatchMark(plan, card({ cardId: "ring-c21", name: "Sol Ring", finish: "foil" })),
    ).toEqual({ tier: "exact", delta: 0 });
    expect(theoryMatchMark(plan, card({ cardId: "ring-c21", name: "Sol Ring" }))?.tier).toBe("name");
  });

  /**
   * The one field of the row's stored grain this deliberately drops — the backend drops it too,
   * so a card planned as Ramp and sleeved into Main deck is one planned card at both ends.
   */
  it("marks a row the reader has since filed under a different pile", () => {
    const plan = theoryMatchPlan(
      [slot("ring-c21|", "Sol Ring")],
      [card({ cardId: "ring-c21", name: "Sol Ring" })],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "ring-c21", name: "Sol Ring" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
  });

  it("marks nothing against a plan that is empty", () => {
    const plan = theoryMatchPlan([], [card({ cardId: "bolt-lea", name: "Lightning Bolt" })], BOTH);

    expect(plan?.exact.size).toBe(0);
    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toBeNull();
  });

  /** One card the plan files in two of its piles should arrive folded — the command groups — but
   *  a `Vec` is what crosses the boundary, so the map sums rather than letting the last row win. */
  it("sums a card the plan files twice into one address", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 2), slot("bolt-lea|", "Lightning Bolt", 2)],
      [card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );

    expect(plan?.exact.size).toBe(1);
    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
  });

  /** Two sleeved against four planned: the reader has two to **add**, so the number is `+2`. */
  it("counts a live list short of the plan as a positive — the copies to add", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 4)],
      [card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 2 })],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toEqual({
      tier: "exact",
      delta: 2,
    });
  });

  /** Four sleeved against two planned: two to **remove**, so `-2` — a cut the reader has not
   *  made yet, and the sign says which way the cut goes. */
  it("counts a live list over the plan as a negative — the copies to remove", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 2)],
      [card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toEqual({
      tier: "exact",
      delta: -2,
    });
  });

  /** The whole reason both sides are summed before they are subtracted: a plan and a deck that
   *  agree exactly, filed differently, must read as agreeing. Per-row arithmetic would draw two
   *  numbers here, both false. */
  it("sums both sides across their piles before subtracting", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 5)],
      [
        card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 4 }),
        card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 1 }),
      ],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
  });

  /** The finishes are two planned cards, so their counts never pool on this tier. */
  it("counts the finishes apart", () => {
    const plan = theoryMatchPlan(
      [slot("ring-c21|", "Sol Ring", 3), slot("ring-c21|foil", "Sol Ring", 1)],
      [
        card({ cardId: "ring-c21", name: "Sol Ring", quantity: 1 }),
        card({ cardId: "ring-c21", name: "Sol Ring", finish: "foil", quantity: 1 }),
      ],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "ring-c21", name: "Sol Ring" }))).toEqual({
      tier: "exact",
      delta: 2,
    });
    expect(
      theoryMatchMark(plan, card({ cardId: "ring-c21", name: "Sol Ring", finish: "foil" })),
    ).toEqual({ tier: "exact", delta: 0 });
  });
});

/** `diff_select`'s rule read from the live side: a card parked in a switched-off pile is not
 *  something the deck has, so it may not fill the plan's order — on **either** tier. */
describe("an inactive pile counts on neither side of either tier", () => {
  it("does not count a copy sitting in a switched-off pile", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 4)],
      [
        card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 1 }),
        card({ cardId: "bolt-lea", name: "Lightning Bolt", quantity: 3, categoryActive: false }),
      ],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", name: "Lightning Bolt" }))).toEqual({
      tier: "exact",
      delta: 3,
    });
  });

  it("does not count a switched-off copy on the loose tier either", () => {
    const plan = theoryMatchPlan(
      [slot("bolt-lea|", "Lightning Bolt", 4)],
      [
        card({ cardId: "bolt-m10", name: "Lightning Bolt", quantity: 1 }),
        card({ cardId: "bolt-2xm", name: "Lightning Bolt", quantity: 3, categoryActive: false }),
      ],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "bolt-m10", name: "Lightning Bolt" }))).toEqual({
      tier: "name",
      delta: 3,
    });
  });
});

describe("the difference floor", () => {
  /** Commander: every row a 1-of, so no reader there ever meets a number. This case is the
   *  **name** tier's half of that — the plan names one printing, the live row is another — and the
   *  exact tier's own singleton is the case directly below, which asserts `tier: "exact"`. The
   *  title read "on both tiers" until 2026-09-07 while the body asserted one of them; coverage was
   *  never the gap, the sentence was. */
  it("draws a tick rather than a number for a singleton on the name tier", () => {
    const plan = theoryMatchPlan(
      [{ key: "ring-c11|", nameKey: "Sol Ring", quantity: 1 }],
      [card({ cardId: "ring-ltr", finish: null, name: "Sol Ring", quantity: 1 })],
      BOTH,
    );
    expect(
      theoryMatchMark(plan, card({ cardId: "ring-ltr", finish: null, name: "Sol Ring" })),
    ).toEqual({ tier: "name", delta: 0 });
  });

  /** The issue's own exclusion, on the exact tier: never a difference where neither side is
   *  above one. */
  it("draws no difference where neither side is above one", () => {
    // The only reachable shape of it: the plan asks for one and the copy is parked in a pile
    // that counts toward nothing, so the live side sums to zero.
    const plan = theoryMatchPlan(
      [slot("sol-c21|", "Sol Ring", 1)],
      [card({ cardId: "sol-c21", name: "Sol Ring", categoryActive: false })],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "sol-c21", name: "Sol Ring" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
  });

  /** ...and the floor is `> 1` on **either** side rather than on both, so a 2-of the reader has
   *  not started acquiring still says how many are missing. */
  it("draws the difference as soon as one side is above one", () => {
    const plan = theoryMatchPlan(
      [slot("sol-c21|", "Sol Ring", 2)],
      [card({ cardId: "sol-c21", name: "Sol Ring", categoryActive: false })],
      BOTH,
    );

    expect(theoryMatchMark(plan, card({ cardId: "sol-c21", name: "Sol Ring" }))).toEqual({
      tier: "exact",
      delta: 2,
    });
  });

  /** The floor is applied **per tier at that tier's own sums**, so one tier can draw a number
   *  while the other, over the same cards, draws the tick. */
  it("applies the floor at each tier's own sums", () => {
    const plan = theoryMatchPlan(
      [slot("forest-a|", "Forest", 1), slot("forest-b|", "Forest", 1)],
      [card({ cardId: "forest-a", name: "Forest", quantity: 1 })],
      BOTH,
    );

    // Exact: one planned against one live — neither above one, so the tick.
    expect(theoryMatchMark(plan, card({ cardId: "forest-a", name: "Forest" }))).toEqual({
      tier: "exact",
      delta: 0,
    });
    // Loose: two planned against one live — above one, so the number: one to add.
    expect(theoryMatchMark(plan, card({ cardId: "forest-c", name: "Forest" }))).toEqual({
      tier: "name",
      delta: 1,
    });
  });
});

describe("no plan", () => {
  it("answers undefined for a deck that keeps no theory list", () => {
    expect(theoryMatchPlan(undefined, [], BOTH)).toBeUndefined();
    expect(theoryMatchMark(undefined, card({ cardId: "x", finish: null, name: "X" }))).toBeNull();
  });
});
