import { describe, expect, it } from "vitest";
import type { DeckFinish, DeckMissingRow, DeckQuickAddWish } from "@/lib/ipc";
import {
  NO_MISSING_CHOICE,
  planAddMissing,
  setCopies,
  toggleRow,
  type MissingChoice,
} from "./addMissingPlan";
import { pullKey } from "./pullPlan";

/**
 * One wishlist line this printing and finish would take copies off.
 *
 * Only `quantity` and `folderName` are ever read — the id travels on no pick, because the wish
 * half acts on an unambiguous match and the backend chooses inside its own transaction — so the
 * id is filled with something plausible rather than varied per test.
 */
const wish = (quantity: number, folderName: string | null = null): DeckQuickAddWish => ({
  id: quantity * 100 + (folderName?.length ?? 0),
  quantity,
  folderId: folderName === null ? null : 7,
  folderName,
});

/** One printing-and-finish the live list is short of, as `deck_missing_plan` answers it. */
const row = (
  cardId: string,
  short: number,
  options: { finish?: DeckFinish; wishes?: DeckQuickAddWish[] } = {},
): DeckMissingRow => ({
  cardId,
  name: cardId,
  setCode: "lea",
  collectorNumber: "161",
  finish: options.finish ?? null,
  short,
  categories: ["Main deck"],
  wishes: options.wishes ?? [],
});

/** Deep-frozen, so a write to the query cache's own rows throws rather than passing quietly.
 *  ESM is strict mode, so a mutation of a frozen object is a `TypeError` and not a silent no-op. */
const frozen = (rows: DeckMissingRow[]): readonly DeckMissingRow[] => {
  for (const r of rows) {
    r.wishes.forEach(Object.freeze);
    Object.freeze(r.wishes);
    Object.freeze(r.categories);
    Object.freeze(r);
  }
  return Object.freeze(rows);
};

/** The choice a dialog is in after N presses, spelled through the writers so the tests exercise
 *  the same path the UI does. */
const withOff = (...keys: string[]): MissingChoice =>
  keys.reduce<MissingChoice>((choice, key) => toggleRow(choice, key, false), NO_MISSING_CHOICE);

describe("planAddMissing's default", () => {
  it("ticks every row at its full shortfall", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 3), row("ring-c21", 2)]),
      NO_MISSING_CHOICE,
      true,
    );

    expect(plan.rows.map((r) => r.on)).toEqual([true, true]);
    expect(plan.rows.map((r) => r.copies)).toEqual([3, 2]);
    expect(plan.copies).toBe(5);
    expect(plan.cards).toBe(2);
    expect(plan.cards).toBe(plan.rows.length);
  });

  /**
   * The one structural difference from `DeckPullPick`: the collection row does not exist yet, so
   * a pick names the cardboard rather than an entry id — and it is one pick per row, because a
   * row *is* a `(cardId, finish)` and the backend sums duplicates for one key before it checks.
   */
  it("is one pick per row, addressed by cardId and finish", () => {
    const plan = planAddMissing(
      frozen([row("ring-c21", 1), row("ring-c21", 2, { finish: "foil" })]),
      NO_MISSING_CHOICE,
      true,
    );

    expect(plan.picks).toEqual([
      { cardId: "ring-c21", finish: null, quantity: 1 },
      { cardId: "ring-c21", finish: "foil", quantity: 2 },
    ]);
    expect(plan.cards).toBe(2);
    expect(plan.copies).toBe(3);
  });
});

describe("planAddMissing's departures", () => {
  it("drops an unticked row from the picks and from both totals", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 3), row("ring-c21", 2)]),
      withOff("bolt-lea|"),
      true,
    );

    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]?.on).toBe(false);
    expect(plan.picks).toEqual([{ cardId: "ring-c21", finish: null, quantity: 2 }]);
    expect(plan.copies).toBe(2);
    expect(plan.cards).toBe(1);
  });

  /** The reader bought two of the four their deck wants. The row stays on and asks for two. */
  it("honours a lowered count and keeps the row", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 4)]),
      setCopies(NO_MISSING_CHOICE, "bolt-lea|", 2),
      true,
    );

    expect(plan.rows[0]?.on).toBe(true);
    expect(plan.rows[0]?.copies).toBe(2);
    expect(plan.picks).toEqual([{ cardId: "bolt-lea", finish: null, quantity: 2 }]);
    expect(plan.copies).toBe(2);
    expect(plan.cards).toBe(1);
  });

  /** An idempotent write from a controlled checkbox costs nothing, and a memo over the choice
   *  does not re-run for it. */
  it("returns the same choice reference when a toggle changes nothing", () => {
    expect(toggleRow(NO_MISSING_CHOICE, "bolt-lea|", true)).toBe(NO_MISSING_CHOICE);

    const off = withOff("bolt-lea|");
    expect(toggleRow(off, "bolt-lea|", false)).toBe(off);
  });

  /** A stepper held at its own value fires on every press of the same arrow at the ends of its
   *  range, so this is the ordinary case rather than a defensive one. */
  it("returns the same choice reference when setCopies repeats the current count", () => {
    const choice = setCopies(NO_MISSING_CHOICE, "bolt-lea|", 2);

    expect(setCopies(choice, "bolt-lea|", 2)).toBe(choice);
    expect(setCopies(NO_MISSING_CHOICE, "bolt-lea|", 2)).not.toBe(NO_MISSING_CHOICE);
  });
});

/**
 * The reason this module exists. A stored count that reached the footer unclamped would preview
 * a press the backend refuses outright with `MORE_THAN_MISSING` — and the choice is not repaired
 * on the way in, because a re-read that lowers a shortfall can happen at any moment and the only
 * place that can be right about it is the derivation.
 */
describe("planAddMissing's clamp", () => {
  it("clamps a stored count above a re-read row's shortfall", () => {
    const choice = setCopies(NO_MISSING_CHOICE, "bolt-lea|", 4);
    const plan = planAddMissing(frozen([row("bolt-lea", 2)]), choice, true);

    expect(plan.rows[0]?.copies).toBe(2);
    expect(plan.picks).toEqual([{ cardId: "bolt-lea", finish: null, quantity: 2 }]);
    expect(plan.copies).toBe(2);
    // The choice is read, never written: the reader's 4 is still there for a re-read that
    // restores the shortfall.
    expect(choice.copies.get("bolt-lea|")).toBe(4);
  });

  /** Zero is how a stepper spells "none", and none is what the tick already says. A pick asking
   *  for no copies is what `collection::ZERO_ADD` refuses, so it may never be built. */
  it("clamps a stored count below one to one", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 3), row("ring-c21", 2)]),
      setCopies(setCopies(NO_MISSING_CHOICE, "bolt-lea|", 0), "ring-c21|", -2),
      true,
    );

    expect(plan.rows.map((r) => r.copies)).toEqual([1, 1]);
    expect(plan.picks).toEqual([
      { cardId: "bolt-lea", finish: null, quantity: 1 },
      { cardId: "ring-c21", finish: null, quantity: 1 },
    ]);
    expect(plan.copies).toBe(2);
  });

  /** A choice is a key and a number, so one naming a row this read no longer holds reaches
   *  nothing — ignored rather than repaired, `pullPlan`'s rule for a stale preferred source. */
  it("ignores a stored count for a key no row carries", () => {
    const rows = frozen([row("bolt-lea", 3)]);

    expect(planAddMissing(rows, setCopies(NO_MISSING_CHOICE, "ring-c21|", 9), true)).toEqual(
      planAddMissing(rows, NO_MISSING_CHOICE, true),
    );
  });
});

describe("planAddMissing's wishes", () => {
  it("reports a lone wish as the copies it will clear, capped by the wish's quantity", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 4, { wishes: [wish(2, "Buy soon")] })]),
      NO_MISSING_CHOICE,
      true,
    );

    expect(plan.rows[0]?.wish).toEqual({ kind: "one", clears: 2, folderName: "Buy soon" });
    expect(plan.wishesCleared).toBe(2);
  });

  it("clears no more than the copies the row is recording", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 4, { wishes: [wish(9)] })]),
      setCopies(NO_MISSING_CHOICE, "bolt-lea|", 1),
      true,
    );

    expect(plan.rows[0]?.wish).toEqual({ kind: "one", clears: 1, folderName: null });
    expect(plan.wishesCleared).toBe(1);
  });

  /** None and two-or-more are left alone by the backend, which is why no wish id travels on a
   *  pick — the dialog says so beside the row so the reader is not surprised by what did not
   *  happen. */
  it("reports two or more matches as ambiguous and clears nothing", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 4, { wishes: [wish(1, "Buy soon"), wish(3)] })]),
      NO_MISSING_CHOICE,
      true,
    );

    expect(plan.rows[0]?.wish).toEqual({ kind: "ambiguous", matches: 2 });
    expect(plan.wishesCleared).toBe(0);
  });

  it("reports no wish at all when the row has none", () => {
    const plan = planAddMissing(frozen([row("bolt-lea", 4)]), NO_MISSING_CHOICE, true);

    expect(plan.rows[0]?.wish).toBeNull();
    expect(plan.wishesCleared).toBe(0);
  });

  /**
   * The `!clearWishes` arm comes first and collapses every row, ambiguous ones included: *"2
   * wishlist lines match — left alone"* over a press that was never going to touch a wish is a
   * fact about the wrong world.
   */
  it("reports no wish and clears nothing when clearWishes is false", () => {
    const plan = planAddMissing(
      frozen([
        row("bolt-lea", 4, { wishes: [wish(2, "Buy soon")] }),
        row("ring-c21", 1, { wishes: [wish(1), wish(1)] }),
      ]),
      NO_MISSING_CHOICE,
      false,
    );

    expect(plan.rows.map((r) => r.wish)).toEqual([null, null]);
    expect(plan.wishesCleared).toBe(0);
    // The rest of the press is untouched by the checkbox.
    expect(plan.copies).toBe(5);
    expect(plan.cards).toBe(2);
  });

  it("counts wishesCleared only over ticked rows", () => {
    const plan = planAddMissing(
      frozen([
        row("bolt-lea", 4, { wishes: [wish(2, "Buy soon")] }),
        row("ring-c21", 1, { wishes: [wish(1)] }),
      ]),
      withOff("bolt-lea|"),
      true,
    );

    expect(plan.wishesCleared).toBe(1);
    // The unticked row still says what its own line would do — the dialog dims the row whole.
    expect(plan.rows[0]?.wish).toEqual({ kind: "one", clears: 2, folderName: "Buy soon" });
  });
});

describe("planAddMissing's keys and totals", () => {
  /** Imported from `pullPlan`, never respelled: a `DeckMissingRow` satisfies its
   *  `Pick<DeckPullRow, "cardId" | "finish">` structurally and the grain is identical. */
  it("keys a row exactly as the pull does", () => {
    const plan = planAddMissing(
      frozen([row("ring-c21", 1), row("ring-c21", 1, { finish: "foil" })]),
      NO_MISSING_CHOICE,
      true,
    );

    expect(plan.rows.map((r) => r.key)).toEqual(["ring-c21|", "ring-c21|foil"]);
    expect(plan.rows[1]?.key).toBe(pullKey({ cardId: "ring-c21", finish: "foil" }));
  });

  it("switches only the row that was named, finish and all", () => {
    const plan = planAddMissing(
      frozen([row("ring-c21", 1), row("ring-c21", 1, { finish: "foil" })]),
      withOff("ring-c21|foil"),
      true,
    );

    expect(plan.rows.map((r) => r.on)).toEqual([true, false]);
    expect(plan.picks).toEqual([{ cardId: "ring-c21", finish: null, quantity: 1 }]);
  });

  it("sends nothing when every row is off", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 3), row("ring-c21", 2)]),
      withOff("bolt-lea|", "ring-c21|"),
      true,
    );

    expect(plan.picks).toEqual([]);
    expect(plan.copies).toBe(0);
    expect(plan.cards).toBe(0);
    expect(plan.rows).toHaveLength(2);
  });

  it("sends nothing for a plan of no rows", () => {
    expect(planAddMissing([], NO_MISSING_CHOICE, true)).toEqual({
      rows: [],
      picks: [],
      copies: 0,
      cards: 0,
      wishesCleared: 0,
    });
  });

  it("sums copies over the picks it built", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 4), row("ring-c21", 2), row("sol-c21", 1)]),
      setCopies(NO_MISSING_CHOICE, "bolt-lea|", 3),
      true,
    );

    expect(plan.copies).toBe(6);
    expect(plan.copies).toBe(plan.picks.reduce((n, pick) => n + pick.quantity, 0));
  });

  /** Out of contract through the front door — the backend never answers a row it is short of
   *  nothing of — and still not a pick asking for none of something. */
  it("never asks for none of something", () => {
    const plan = planAddMissing(
      frozen([row("bolt-lea", 0), row("ring-c21", 2)]),
      NO_MISSING_CHOICE,
      true,
    );

    expect(plan.picks).toEqual([{ cardId: "ring-c21", finish: null, quantity: 2 }]);
    expect(plan.cards).toBe(1);
    expect(plan.copies).toBe(2);
  });
});

/**
 * `planAddMissing` is called in a render body with rows that belong to a query cache, so a write
 * to either argument is a write to somebody else's state. The rows are frozen, which makes a
 * mutation throw rather than pass quietly; the choice's `Set` and `Map` cannot be frozen
 * meaningfully, so they are read back instead.
 */
describe("purity", () => {
  it("writes to neither the rows nor the choice", () => {
    const rows = frozen([row("bolt-lea", 4, { wishes: [wish(2, "Buy soon")] })]);
    const choice = setCopies(withOff("ring-c21|"), "bolt-lea|", 9);

    expect(() => planAddMissing(rows, choice, true)).not.toThrow();
    expect(rows[0]?.short).toBe(4);
    expect([...choice.off]).toEqual(["ring-c21|"]);
    expect([...choice.copies]).toEqual([["bolt-lea|", 9]]);
  });

  it("answers the same plan twice for the same input", () => {
    const rows = frozen([row("bolt-lea", 4, { wishes: [wish(2)] })]);

    expect(planAddMissing(rows, NO_MISSING_CHOICE, true)).toEqual(
      planAddMissing(rows, NO_MISSING_CHOICE, true),
    );
  });

  it("leaves NO_MISSING_CHOICE empty however many choices are built from it", () => {
    setCopies(toggleRow(NO_MISSING_CHOICE, "bolt-lea|", false), "ring-c21|", 4);

    expect(NO_MISSING_CHOICE.off.size).toBe(0);
    expect(NO_MISSING_CHOICE.copies.size).toBe(0);
  });

  /**
   * The backend's row is passed through by identity — never copied, never re-sorted — so the
   * dialog draws the object the query cache holds. The pick beside it is a fresh literal,
   * because `DeckMissingPick`'s fields are mutable (it is the wire type) and a caller tidying
   * the payload must not be able to reach into the rows a component is already drawing.
   */
  it("carries the backend's row through by identity and hands out its own picks", () => {
    const rows = frozen([row("bolt-lea", 3)]);
    const plan = planAddMissing(rows, NO_MISSING_CHOICE, true);

    expect(plan.rows[0]?.row).toBe(rows[0]);
    expect(() => {
      plan.picks[0].quantity = 99;
    }).not.toThrow();
    expect(rows[0]?.short).toBe(3);
  });
});

describe("toggleRow", () => {
  it("switches a row off without touching the choice it was given", () => {
    const before = NO_MISSING_CHOICE;
    const after = toggleRow(before, "bolt-lea|", false);

    expect(after).not.toBe(before);
    expect(after.off.has("bolt-lea|")).toBe(true);
    expect(before.off.has("bolt-lea|")).toBe(false);
  });

  it("switches a row back on", () => {
    const off = withOff("bolt-lea|", "ring-c21|");
    const on = toggleRow(off, "bolt-lea|", true);

    expect([...on.off]).toEqual(["ring-c21|"]);
    expect([...off.off]).toEqual(["bolt-lea|", "ring-c21|"]);
  });

  /** A reader who unticks a line and ticks it back has not changed their mind about how many
   *  copies they bought. */
  it("keeps a row's count across a switch", () => {
    const choice = setCopies(NO_MISSING_CHOICE, "bolt-lea|", 2);
    const back = toggleRow(toggleRow(choice, "bolt-lea|", false), "bolt-lea|", true);

    expect(back.copies.get("bolt-lea|")).toBe(2);
    expect(back.off.size).toBe(0);
  });
});

describe("setCopies", () => {
  it("names a count without touching the choice it was given", () => {
    const before = NO_MISSING_CHOICE;
    const after = setCopies(before, "bolt-lea|", 2);

    expect(after).not.toBe(before);
    expect(after.copies.get("bolt-lea|")).toBe(2);
    expect(before.copies.size).toBe(0);
  });

  it("replaces one row's count and leaves the others alone", () => {
    const choice = setCopies(setCopies(NO_MISSING_CHOICE, "bolt-lea|", 2), "ring-c21|", 1);
    const moved = setCopies(choice, "bolt-lea|", 3);

    expect([...moved.copies]).toEqual([
      ["bolt-lea|", 3],
      ["ring-c21|", 1],
    ]);
    expect(choice.copies.get("bolt-lea|")).toBe(2);
  });

  /** Stored verbatim, because the clamp is the derivation's and writing a repaired number here
   *  would be a second place that has an opinion about a shortfall it cannot see. */
  it("stores a count the current rows could not honour", () => {
    expect(setCopies(NO_MISSING_CHOICE, "bolt-lea|", 40).copies.get("bolt-lea|")).toBe(40);
  });

  it("says nothing about whether the row is on", () => {
    const choice = setCopies(withOff("bolt-lea|"), "bolt-lea|", 2);

    expect(choice.off.has("bolt-lea|")).toBe(true);
  });
});
