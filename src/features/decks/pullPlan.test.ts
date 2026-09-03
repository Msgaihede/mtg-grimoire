import { describe, expect, it } from "vitest";
import type { DeckFinish, DeckPullCandidate, DeckPullRow } from "@/lib/ipc";
import { NO_CHOICE, planPull, preferSource, pullKey, toggleRow } from "./pullPlan";

/**
 * One collection row that could fill a hole. Only `entryId` and `quantity` are ever read — the
 * condition, the language and the folder are what let a reader tell two candidates apart on
 * screen and are not terms in any arithmetic here — so they are filled once with something
 * plausible rather than varied per test, where varying them would suggest they mattered.
 */
const candidate = (entryId: number, quantity: number): DeckPullCandidate => ({
  entryId,
  quantity,
  folderId: null,
  folderName: null,
  folderKind: null,
  condition: "near_mint",
  lang: "en",
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  serialNumber: null,
});

/** One printing the live list is short of. `candidates` arrive in the backend's own preference
 *  order and nothing here may re-sort them, so every test writes them in the order it means. */
const row = (
  cardId: string,
  short: number,
  candidates: DeckPullCandidate[],
  finish: DeckFinish = null,
): DeckPullRow => ({
  cardId,
  name: cardId,
  setCode: "lea",
  collectorNumber: "161",
  finish,
  short,
  categories: ["Main deck"],
  candidates,
});

/** Deep-frozen, so a write to the query cache's own rows throws rather than passing quietly.
 *  ESM is strict mode, so a mutation of a frozen object is a `TypeError` and not a silent no-op. */
const frozen = (rows: DeckPullRow[]): readonly DeckPullRow[] => {
  for (const r of rows) {
    r.candidates.forEach(Object.freeze);
    Object.freeze(r.candidates);
    Object.freeze(r.categories);
    Object.freeze(r);
  }
  return Object.freeze(rows);
};

/** The choice a dialog is in after one press, spelled through the writers so the tests exercise
 *  the same path the UI does. */
const withOff = (...keys: string[]) =>
  keys.reduce((choice, key) => toggleRow(choice, key, false), NO_CHOICE);

describe("pullKey", () => {
  it("names the printing and the finish", () => {
    expect(pullKey(row("bolt-lea", 1, [candidate(1, 1)]))).toBe("bolt-lea|");
    expect(pullKey(row("bolt-lea", 1, [candidate(1, 1)], "foil"))).toBe("bolt-lea|foil");
    expect(pullKey(row("bolt-lea", 1, [candidate(1, 1)], "etched"))).toBe("bolt-lea|etched");
  });

  /**
   * The whole reason the finish is in the key: the backend folds at `(card_id, finish)`, so these
   * are two shortfalls filled from two different piles of cardboard. One key would switch both
   * off with one press and pool their preferred sources.
   */
  it("tells the two finishes of one printing apart", () => {
    const regular = pullKey(row("ring-c21", 1, [candidate(1, 1)]));
    const foil = pullKey(row("ring-c21", 1, [candidate(1, 1)], "foil"));

    expect(regular).not.toBe(foil);
  });

  it("gives two regular copies of one printing the same key", () => {
    expect(pullKey({ cardId: "ring-c21", finish: null })).toBe(
      pullKey({ cardId: "ring-c21", finish: null }),
    );
  });

  /** `null` is the empty half, which no finish spells, and a Scryfall id cannot contain the
   *  separator — so no two pairs can collide however they are combined. */
  it("cannot be spelled by another pair", () => {
    const keys = [
      pullKey({ cardId: "a", finish: null }),
      pullKey({ cardId: "a", finish: "foil" }),
      pullKey({ cardId: "a|foil", finish: null }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("planPull", () => {
  it("takes the whole shortfall from one candidate that covers it", () => {
    const plan = planPull(frozen([row("bolt-lea", 3, [candidate(11, 4)])]), NO_CHOICE);

    expect(plan.rows[0]?.takes).toEqual([{ entryId: 11, quantity: 3 }]);
    expect(plan.rows[0]?.taking).toBe(3);
    expect(plan.rows[0]?.unfilled).toBe(0);
    expect(plan.copies).toBe(3);
    expect(plan.cards).toBe(1);
    expect(plan.picks).toEqual([{ entryId: 11, quantity: 3 }]);
  });

  /** The backend's order ranks by how little of the reader's filing a pull disturbs, so the walk
   *  is first-to-last and never sorted by how much a row holds. */
  it("walks several candidates in the order they arrived", () => {
    const plan = planPull(
      frozen([row("bolt-lea", 4, [candidate(11, 1), candidate(12, 2), candidate(13, 5)])]),
      NO_CHOICE,
    );

    expect(plan.rows[0]?.takes).toEqual([
      { entryId: 11, quantity: 1 },
      { entryId: 12, quantity: 2 },
      { entryId: 13, quantity: 1 },
    ]);
    expect(plan.rows[0]?.taking).toBe(4);
    expect(plan.rows[0]?.unfilled).toBe(0);
  });

  /** The reader owns two of the four Bolts the deck lists. Filling two holes is worth doing, so
   *  everything offered is taken and the rest is reported rather than swallowed. */
  it("takes everything offered when the desk holds less than the deck is short of", () => {
    const plan = planPull(
      frozen([row("bolt-lea", 4, [candidate(11, 1), candidate(12, 1)])]),
      NO_CHOICE,
    );

    expect(plan.rows[0]?.takes).toEqual([
      { entryId: 11, quantity: 1 },
      { entryId: 12, quantity: 1 },
    ]);
    expect(plan.rows[0]?.taking).toBe(2);
    expect(plan.rows[0]?.unfilled).toBe(2);
    expect(plan.copies).toBe(2);
    expect(plan.cards).toBe(1);
  });

  it("fills exactly across two candidates with nothing left unfilled", () => {
    const plan = planPull(
      frozen([row("bolt-lea", 3, [candidate(11, 1), candidate(12, 2)])]),
      NO_CHOICE,
    );

    expect(plan.rows[0]?.taking).toBe(3);
    expect(plan.rows[0]?.unfilled).toBe(0);
    expect(plan.picks).toHaveLength(2);
  });

  /** The reachable zero: the shortfall was met by the candidates before this one. It is not a
   *  take of nothing, it is not a take at all — the backend refuses a batch it disagrees with. */
  it("emits no pick for a candidate the shortfall never reaches", () => {
    const plan = planPull(
      frozen([row("bolt-lea", 1, [candidate(11, 4), candidate(12, 4)])]),
      NO_CHOICE,
    );

    expect(plan.picks).toEqual([{ entryId: 11, quantity: 1 }]);
  });

  /** The other zero: a row holding no copies. `set_quantity(id, 0)` deletes, so this is out of
   *  contract through the front door and would still be a pick asking for none of something. */
  it("skips a candidate holding no copies", () => {
    const plan = planPull(
      frozen([row("bolt-lea", 2, [candidate(11, 0), candidate(12, 2)])]),
      NO_CHOICE,
    );

    expect(plan.picks).toEqual([{ entryId: 12, quantity: 2 }]);
    expect(plan.picks.every((pick) => pick.quantity > 0)).toBe(true);
  });

  it("never takes more copies than a candidate holds", () => {
    const plan = planPull(frozen([row("bolt-lea", 10, [candidate(11, 2)])]), NO_CHOICE);

    expect(plan.rows[0]?.takes).toEqual([{ entryId: 11, quantity: 2 }]);
    expect(plan.rows[0]?.unfilled).toBe(8);
  });

  it("shows the first entry taken from as the row's source", () => {
    const plan = planPull(
      frozen([row("bolt-lea", 4, [candidate(11, 1), candidate(12, 9)])]),
      NO_CHOICE,
    );

    expect(plan.rows[0]?.source).toBe(11);
  });

  it("keys each row and marks an untouched plan entirely on", () => {
    const plan = planPull(
      frozen([
        row("ring-c21", 1, [candidate(11, 1)]),
        row("ring-c21", 1, [candidate(12, 1)], "foil"),
      ]),
      NO_CHOICE,
    );

    expect(plan.rows.map((r) => r.key)).toEqual(["ring-c21|", "ring-c21|foil"]);
    expect(plan.rows.every((r) => r.on)).toBe(true);
  });
});

describe("planPull's preferred source", () => {
  it("draws the named entry first and the rest in the backend's order", () => {
    const rows = frozen([
      row("bolt-lea", 4, [candidate(11, 1), candidate(12, 1), candidate(13, 5)]),
    ]);
    const plan = planPull(rows, preferSource(NO_CHOICE, "bolt-lea|", 13));

    expect(plan.rows[0]?.takes).toEqual([
      { entryId: 13, quantity: 4 },
      // 11 and 12 are untouched behind it: the shortfall was met by the preferred row alone.
    ]);
    expect(plan.rows[0]?.source).toBe(13);
  });

  it("takes the leftover from the others in their own order", () => {
    const rows = frozen([
      row("bolt-lea", 4, [candidate(11, 1), candidate(12, 1), candidate(13, 2)]),
    ]);
    const plan = planPull(rows, preferSource(NO_CHOICE, "bolt-lea|", 13));

    expect(plan.rows[0]?.takes).toEqual([
      { entryId: 13, quantity: 2 },
      { entryId: 11, quantity: 1 },
      { entryId: 12, quantity: 1 },
    ]);
  });

  it("changes nothing when it names the candidate that was already first", () => {
    const rows = frozen([row("bolt-lea", 3, [candidate(11, 1), candidate(12, 5)])]);

    expect(planPull(rows, preferSource(NO_CHOICE, "bolt-lea|", 11))).toEqual(
      planPull(rows, NO_CHOICE),
    );
  });

  /** A stale choice: the copy was folded away or spent by another window between the read that
   *  populated the picker and this one. The row falls back rather than emptying or throwing. */
  it("falls back to the default order for an entry no candidate carries", () => {
    const rows = frozen([row("bolt-lea", 3, [candidate(11, 1), candidate(12, 5)])]);
    const plan = planPull(rows, preferSource(NO_CHOICE, "bolt-lea|", 999));

    expect(plan.rows[0]?.takes).toEqual([
      { entryId: 11, quantity: 1 },
      { entryId: 12, quantity: 2 },
    ]);
    expect(plan.rows[0]?.source).toBe(11);
    expect(plan.copies).toBe(3);
  });

  /** The preferred candidate is moved, never copied — the id it names may be spent once. */
  it("never takes the preferred entry twice", () => {
    const rows = frozen([row("bolt-lea", 9, [candidate(11, 2), candidate(12, 2)])]);
    const plan = planPull(rows, preferSource(NO_CHOICE, "bolt-lea|", 12));

    expect(plan.rows[0]?.takes).toEqual([
      { entryId: 12, quantity: 2 },
      { entryId: 11, quantity: 2 },
    ]);
  });

  /** A choice is a key and an id, so one naming a row this read no longer holds reaches nothing. */
  it("ignores a preference for a row the plan does not carry", () => {
    const rows = frozen([row("bolt-lea", 1, [candidate(11, 1)])]);

    expect(planPull(rows, preferSource(NO_CHOICE, "ring-c21|", 99))).toEqual(
      planPull(rows, NO_CHOICE),
    );
  });
});

describe("planPull's switched-off rows", () => {
  it("draws an off row and takes nothing for it", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 3, [candidate(11, 4)]),
        row("ring-c21", 2, [candidate(12, 2)]),
      ]),
      withOff("bolt-lea|"),
    );

    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]?.on).toBe(false);
    expect(plan.rows[0]?.takes).toEqual([]);
    expect(plan.rows[0]?.taking).toBe(0);
    expect(plan.copies).toBe(2);
    expect(plan.cards).toBe(1);
    expect(plan.picks).toEqual([{ entryId: 12, quantity: 2 }]);
  });

  /** `max(0, short − taking)` is unconditional, so an off row reads its whole shortfall as
   *  unfilled — which is what the press as it stands would leave unfilled. */
  it("counts an off row's whole shortfall as unfilled", () => {
    const plan = planPull(frozen([row("bolt-lea", 3, [candidate(11, 4)])]), withOff("bolt-lea|"));

    expect(plan.rows[0]?.unfilled).toBe(3);
  });

  /** The picker on an unticked row keeps showing what the reader picked, so ticking it back does
   *  not read as the app having forgotten. */
  it("keeps showing the source the reader chose", () => {
    const off = toggleRow(preferSource(NO_CHOICE, "bolt-lea|", 12), "bolt-lea|", false);
    const plan = planPull(
      frozen([row("bolt-lea", 3, [candidate(11, 4), candidate(12, 4)])]),
      off,
    );

    expect(plan.rows[0]?.source).toBe(12);
  });

  it("switches only the row that was named, finish and all", () => {
    const plan = planPull(
      frozen([
        row("ring-c21", 1, [candidate(11, 1)]),
        row("ring-c21", 1, [candidate(12, 1)], "foil"),
      ]),
      withOff("ring-c21|foil"),
    );

    expect(plan.rows.map((r) => r.on)).toEqual([true, false]);
    expect(plan.picks).toEqual([{ entryId: 11, quantity: 1 }]);
  });

  it("sends nothing when every row is off", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 3, [candidate(11, 4)]),
        row("ring-c21", 2, [candidate(12, 2)]),
      ]),
      withOff("bolt-lea|", "ring-c21|"),
    );

    expect(plan.picks).toEqual([]);
    expect(plan.copies).toBe(0);
    expect(plan.cards).toBe(0);
    expect(plan.rows).toHaveLength(2);
  });

  it("sends nothing for a plan of no rows", () => {
    expect(planPull([], NO_CHOICE)).toEqual({ rows: [], copies: 0, cards: 0, picks: [] });
  });
});

describe("planPull's totals", () => {
  /** Rows *considered* is three. Printings that get a copy is one — the off row and the row whose
   *  candidates hold nothing are both zero, and neither is a card this press moves. */
  it("counts printings that get a copy rather than rows considered", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 2, [candidate(11, 2)]),
        row("ring-c21", 2, [candidate(12, 2)]),
        row("sol-c21", 2, [candidate(13, 0)]),
      ]),
      withOff("ring-c21|"),
    );

    expect(plan.cards).toBe(1);
    expect(plan.copies).toBe(2);
  });

  /** Two finishes of one printing are two shortfalls filled from two piles of cardboard, so they
   *  count as two — the same grain the key is spelled at. */
  it("counts the two finishes of one printing as two cards", () => {
    const plan = planPull(
      frozen([
        row("ring-c21", 1, [candidate(11, 1)]),
        row("ring-c21", 1, [candidate(12, 1)], "foil"),
      ]),
      NO_CHOICE,
    );

    expect(plan.cards).toBe(2);
    expect(plan.copies).toBe(2);
  });

  it("sums copies over every take of every row", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 4, [candidate(11, 1), candidate(12, 2)]),
        row("ring-c21", 2, [candidate(13, 5)]),
      ]),
      NO_CHOICE,
    );

    expect(plan.copies).toBe(5);
    expect(plan.copies).toBe(plan.picks.reduce((n, pick) => n + pick.quantity, 0));
  });
});

/**
 * The write is all-or-nothing and the backend refuses a batch it disagrees with, so these two are
 * about the payload rather than about the screen: a doubled entry or a pick asking for none of
 * something would refuse the whole pull and move nothing.
 */
describe("planPull's payload", () => {
  it("never names one entry twice across the whole payload", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 9, [candidate(11, 2), candidate(12, 2), candidate(13, 2)]),
        row("ring-c21", 3, [candidate(21, 1), candidate(22, 1)]),
      ]),
      preferSource(preferSource(NO_CHOICE, "bolt-lea|", 13), "ring-c21|", 22),
    );

    const ids = plan.picks.map((pick) => pick.entryId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it("never asks for none of something", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 1, [candidate(11, 0), candidate(12, 5), candidate(13, 5)]),
        row("ring-c21", 0, [candidate(21, 5)]),
      ]),
      NO_CHOICE,
    );

    expect(plan.picks).toEqual([{ entryId: 12, quantity: 1 }]);
  });

  it("puts the picks in the order the takes are drawn", () => {
    const plan = planPull(
      frozen([
        row("bolt-lea", 3, [candidate(11, 1), candidate(12, 5)]),
        row("ring-c21", 1, [candidate(13, 1)]),
      ]),
      NO_CHOICE,
    );

    expect(plan.picks).toEqual([
      { entryId: 11, quantity: 1 },
      { entryId: 12, quantity: 2 },
      { entryId: 13, quantity: 1 },
    ]);
  });
});

/**
 * `planPull` is called in a render body with rows that belong to a query cache, so a write to
 * either argument is a write to somebody else's state. The rows are frozen, which makes a
 * mutation throw rather than pass quietly; the choice's `Set` and `Map` cannot be frozen
 * meaningfully, so they are read back instead.
 */
describe("purity", () => {
  it("writes to neither the rows nor the choice", () => {
    const rows = frozen([row("bolt-lea", 4, [candidate(11, 1), candidate(12, 5)])]);
    const choice = preferSource(withOff("ring-c21|"), "bolt-lea|", 12);

    expect(() => planPull(rows, choice)).not.toThrow();
    expect(rows[0]?.candidates.map((c) => c.entryId)).toEqual([11, 12]);
    expect([...choice.off]).toEqual(["ring-c21|"]);
    expect([...choice.preferred]).toEqual([["bolt-lea|", 12]]);
  });

  it("answers the same plan twice for the same input", () => {
    const rows = frozen([row("bolt-lea", 4, [candidate(11, 1), candidate(12, 5)])]);

    expect(planPull(rows, NO_CHOICE)).toEqual(planPull(rows, NO_CHOICE));
  });

  it("leaves NO_CHOICE empty however many choices are built from it", () => {
    preferSource(toggleRow(NO_CHOICE, "bolt-lea|", false), "ring-c21|", 4);

    expect(NO_CHOICE.off.size).toBe(0);
    expect(NO_CHOICE.preferred.size).toBe(0);
  });
});

describe("toggleRow", () => {
  it("switches a row off without touching the choice it was given", () => {
    const before = NO_CHOICE;
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

  /** An idempotent write from a controlled checkbox costs nothing, and a memo over the choice
   *  does not re-run for it. */
  it("hands the same choice back when the row is already in that state", () => {
    expect(toggleRow(NO_CHOICE, "bolt-lea|", true)).toBe(NO_CHOICE);

    const off = withOff("bolt-lea|");
    expect(toggleRow(off, "bolt-lea|", false)).toBe(off);
  });

  /** A reader who unticks a line and ticks it back has not changed their mind about which binder
   *  the card comes out of. */
  it("keeps a row's preferred source across a switch", () => {
    const choice = preferSource(NO_CHOICE, "bolt-lea|", 12);
    const back = toggleRow(toggleRow(choice, "bolt-lea|", false), "bolt-lea|", true);

    expect(back.preferred.get("bolt-lea|")).toBe(12);
    expect(back.off.size).toBe(0);
  });
});

describe("preferSource", () => {
  it("names a source without touching the choice it was given", () => {
    const before = NO_CHOICE;
    const after = preferSource(before, "bolt-lea|", 12);

    expect(after).not.toBe(before);
    expect(after.preferred.get("bolt-lea|")).toBe(12);
    expect(before.preferred.size).toBe(0);
  });

  it("replaces one row's source and leaves the others alone", () => {
    const choice = preferSource(preferSource(NO_CHOICE, "bolt-lea|", 12), "ring-c21|", 21);
    const moved = preferSource(choice, "bolt-lea|", 13);

    expect([...moved.preferred]).toEqual([
      ["bolt-lea|", 13],
      ["ring-c21|", 21],
    ]);
    expect(choice.preferred.get("bolt-lea|")).toBe(12);
  });

  it("hands the same choice back when that entry is already preferred", () => {
    const choice = preferSource(NO_CHOICE, "bolt-lea|", 12);

    expect(preferSource(choice, "bolt-lea|", 12)).toBe(choice);
  });

  it("says nothing about whether the row is on", () => {
    const choice = preferSource(withOff("bolt-lea|"), "bolt-lea|", 12);

    expect(choice.off.has("bolt-lea|")).toBe(true);
  });
});
