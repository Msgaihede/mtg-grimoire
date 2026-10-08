import { describe, expect, it } from "vitest";
import { choose, handOdds, type OddsMode } from "./openingHand";

/** One reading, with the four numbers a deck actually has as the defaults, so a case says only
 *  what it is about. */
const odds = (over: {
  deck?: number;
  successes?: number;
  hand?: number;
  want?: number;
  mode?: OddsMode;
}) =>
  handOdds({
    deck: over.deck ?? 60,
    successes: over.successes ?? 4,
    hand: over.hand ?? 7,
    want: over.want ?? 1,
    mode: over.mode ?? "atLeast",
  });

describe("choose", () => {
  it("answers zero for a k outside [0, n], which is the arithmetic every caller wants", () => {
    // The chance of drawing four copies of a card the deck holds three of is not an error.
    expect(choose(3, 4)).toBe(0);
    expect(choose(5, -1)).toBe(0);
    expect(choose(0, 1)).toBe(0);
    /**
     * **The `k > n` half of that guard is only observable for a negative `n`, and it is
     * reachable**: `handOdds` computes `choose(deck − successes, …)`, which is negative the
     * moment a caller asks about more successes than the deck holds. Without the guard the
     * running product runs zero times and answers `1`, and for `k` above zero it answers a
     * *negative* count. It has to be asserted here rather than through `handOdds`, whose own
     * `Math.max(0, …)` clamps the wreckage back to zero — the damage is real and invisible one
     * function up, which is the shape of thing a unit test is for.
     */
    expect(choose(-5, 0)).toBe(0);
    expect(choose(-1, 1)).toBe(0);
  });

  it("answers one for k of zero, and for k of n", () => {
    expect(choose(0, 0)).toBe(1);
    expect(choose(60, 0)).toBe(1);
    expect(choose(5, 5)).toBe(1);
  });

  it("counts the small cases", () => {
    expect(choose(5, 2)).toBe(10);
    expect(choose(52, 5)).toBe(2598960);
  });

  /**
   * **The exact integer, at deck scale, and it is the whole reason this is a running product.**
   *
   * `C(100, 7)` is 16 007 560 800 — comfortably inside 2^53 and therefore exactly representable.
   * The three-factorial spelling cannot reach it: `100!` is ~9.3e157 and every intermediate is
   * far past the point a double stops counting integers, so `100! / (7! * 93!)` answers
   * **16007560800.000002** — near enough to read right and no longer a whole number. The last
   * assertion is what makes this case non-vacuous: it says the trap is real rather than only
   * that the running form happens to be right.
   */
  it("stays exact at deck scale, where the factorial spelling does not", () => {
    expect(choose(100, 7)).toBe(16007560800);
    expect(Number.isInteger(choose(100, 7))).toBe(true);
    /**
     * **And the running product has to multiply _before_ it divides**, which is the second trap
     * and a much earlier one: `out * ((n - i) / (i + 1))` divides by a number that does not
     * divide the factor, so the intermediate stops being a whole number and the error survives
     * to the answer. The first `n` it goes wrong at is **11** — `C(11, 5)` comes back
     * 461.99999999999994 — which is well inside the range a 40-card limited deck reaches.
     */
    expect(choose(11, 5)).toBe(462);
    expect(choose(11, 8)).toBe(165);

    const factorial = (n: number) => {
      let out = 1;
      for (let i = 2; i <= n; i++) out *= i;
      return out;
    };
    expect(factorial(100) / (factorial(7) * factorial(93))).not.toBe(16007560800);
  });
});

describe("handOdds", () => {
  /**
   * **The figure every deckbuilding conversation quotes**: four copies in a sixty-card deck,
   * at least one in the opening seven.
   *
   * `1 − C(56,7)/C(60,7)` = `1 − 231 917 400 / 386 206 920` = **0.3994996…**, which is the
   * hypergeometric answer — a deck is drawn **without replacement**, so the second card is drawn
   * from a deck of 59. The with-replacement kernel answers `1 − (56/60)^7` = 0.3830394…, and the
   * second assertion is what says the distinction is load-bearing rather than decorative: the two
   * are 1.6 percentage points apart on the most-quoted figure in deckbuilding.
   */
  it("answers the classic 60-card, four-copy, seven-card figure", () => {
    expect(odds({})).toBeCloseTo(0.3995, 4);
    // Not the binomial answer, which is what a with-replacement kernel would give.
    expect(odds({})).not.toBeCloseTo(1 - (56 / 60) ** 7, 2);
  });

  it("is certain of at least none, and of at most a whole hand", () => {
    expect(odds({ want: 0, mode: "atLeast" })).toBeCloseTo(1, 12);
    expect(odds({ want: 7, mode: "atMost" })).toBeCloseTo(1, 12);
  });

  it("sums to one across every reachable exact count", () => {
    // The ceiling is `min(hand, successes)`; past it every term is zero, so the sum over the
    // reachable counts is the whole distribution.
    let total = 0;
    for (let i = 0; i <= 4; i++) total += odds({ want: i, mode: "exactly" });

    expect(total).toBeCloseTo(1, 12);
  });

  it("splits the distribution at every k: at least k and at most k-1 are the two halves", () => {
    for (let k = 1; k <= 5; k++) {
      expect(odds({ want: k, mode: "atLeast" }) + odds({ want: k - 1, mode: "atMost" })).toBeCloseTo(
        1,
        12,
      );
    }
  });

  /**
   * **The ceiling is `min(hand, successes)` and both halves of it are stated** — but what
   * *enforces* them is `choose`'s out-of-range guard one function down, not `top` itself.
   * Measured by mutation (2026-09-10): replacing `top` with either `drawn` or `successes` alone
   * changes no answer this file can produce, because every term past the ceiling asks `choose`
   * for a `k` outside `[0, n]` and gets a `0`. So `handOdds`' own doc overstates it slightly —
   * `top` is a statement rather than a guard. These two cases pin the **behaviour**, which is
   * what a reader can ask for by typing a number into the odds table.
   */
  it("cannot draw more copies than it drew cards", () => {
    expect(odds({ successes: 4, hand: 2, want: 4, mode: "exactly" })).toBe(0);
    expect(odds({ successes: 4, hand: 2, want: 3, mode: "atLeast" })).toBe(0);
  });

  it("cannot draw more copies than the deck holds", () => {
    expect(odds({ successes: 3, hand: 7, want: 4, mode: "exactly" })).toBe(0);
    expect(odds({ successes: 3, hand: 7, want: 4, mode: "atLeast" })).toBe(0);
    // And `atMost` past the ceiling is the whole distribution rather than a truncated one.
    expect(odds({ successes: 3, hand: 7, want: 4, mode: "atMost" })).toBeCloseTo(1, 12);
  });

  /**
   * **A deck of nothing answers zero rather than dividing by zero.** `choose(0, 0)` is `1`, so
   * without the guard an empty deck drawing an empty hand reports **certainty** about a card it
   * does not hold — the one wrong answer here that looks like a right one.
   */
  it("answers zero for a deck of nothing and for a hand of nothing", () => {
    for (const mode of ["atLeast", "exactly", "atMost"] as const) {
      expect(handOdds({ deck: 0, successes: 0, hand: 0, want: 0, mode })).toBe(0);
      expect(handOdds({ deck: 0, successes: 4, hand: 7, want: 1, mode })).toBe(0);
      expect(handOdds({ deck: 60, successes: 4, hand: 0, want: 0, mode })).toBe(0);
      expect(handOdds({ deck: -3, successes: 4, hand: 7, want: 1, mode })).toBe(0);
    }
  });

  /**
   * A hand larger than the deck is a reader asking about drawing the **whole** deck — so it is
   * clamped rather than answered with zeroes. Unclamped, `choose(deck − successes, hand − i)`
   * asks for more cards than the non-successes can supply, every term is `0`, and a deck holding
   * two copies reports **no chance** of drawing one while being emptied onto the table.
   */
  it("clamps a hand larger than the deck to the deck", () => {
    expect(odds({ deck: 5, successes: 2, hand: 9, want: 2, mode: "atLeast" })).toBe(1);
    expect(odds({ deck: 5, successes: 2, hand: 9, want: 1, mode: "atLeast" })).toBe(1);
    expect(odds({ deck: 5, successes: 2, hand: 9, want: 1, mode: "exactly" })).toBe(0);

    for (const mode of ["atLeast", "exactly", "atMost"] as const) {
      expect(handOdds({ deck: 5, successes: 2, hand: 9, want: 1, mode })).toBe(
        handOdds({ deck: 5, successes: 2, hand: 5, want: 1, mode }),
      );
    }
  });

  it("reads a negative want as none asked for, and refuses to be exactly a negative count", () => {
    expect(odds({ want: -1, mode: "atLeast" })).toBeCloseTo(1, 12);
    expect(odds({ want: -1, mode: "exactly" })).toBe(0);
  });

  /**
   * **A long sum of doubles really does land outside the interval, and this is a deck that
   * does it.** 11 successes in 83 cards over an 11-card draw, at least none of them: the twelve
   * terms sum to **1.0000000000000004**, which without the clamp is the odds table drawing
   * `100.00000000000001%`. Found by sweeping every `(deck ≤ 120, successes ≤ 40, hand ≤ 12,
   * want ≤ hand)` in all three modes — it is the only shape that overflows, which is why the
   * case is written out rather than left to the sweep below to stumble on.
   */
  it("clamps a sum that lands a hair over one", () => {
    expect(handOdds({ deck: 83, successes: 11, hand: 11, want: 0, mode: "atLeast" })).toBe(1);
  });

  /** The other end of the same guarantee, over every mode and count a reader can reach. */
  it("stays inside [0, 1] across every mode and count", () => {
    for (const mode of ["atLeast", "exactly", "atMost"] as const) {
      for (const deck of [17, 40, 60, 99]) {
        for (const successes of [0, 1, 4, 12]) {
          for (let want = 0; want <= 8; want++) {
            const p = handOdds({ deck, successes, hand: 7, want, mode });
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  /** A land count a reader would actually type, at a mode they would actually pick — so the
   *  three modes are pinned against a figure and not only against each other. */
  it("answers a Commander manabase's at-least-three-lands question", () => {
    // 38 lands in 99, seven cards: 1 − P(0) − P(1) − P(2). The mean is 7 × 38/99 = 2.69, so a
    // little over half — which is the sanity check that keeps this figure from being a number
    // copied out of the implementation it is testing.
    const p = handOdds({ deck: 99, successes: 38, hand: 7, want: 3, mode: "atLeast" });
    const below = handOdds({ deck: 99, successes: 38, hand: 7, want: 2, mode: "atMost" });

    expect(p).toBeCloseTo(0.548, 3);
    expect(p + below).toBeCloseTo(1, 12);
  });
});
