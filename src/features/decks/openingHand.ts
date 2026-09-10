/**
 * The chance of meeting a card in an opening hand.
 *
 * A deck is a bag drawn from **without replacement**, which is the whole of why this is
 * hypergeometric rather than binomial: the second card you draw is drawn from a deck of 59.
 * Getting that wrong is not a rounding error — over a 60-card deck at four copies it moves
 * "at least one in seven" from 39.9% to 40.0%, and over a 40-card limited deck the two answers
 * part company by whole percentage points.
 *
 * **Nothing here knows what a deck is.** It takes four numbers and a mode; which rows were
 * counted, and which of a deck's several piles they came from, is `deckBuckets.ts`' question and
 * the caller's. That separation is what lets the same arithmetic answer "a land in my opening
 * seven" and "two copies of Sol Ring in a Commander mulligan" without either one having an
 * opinion about the other.
 */

/**
 * How the reader is reading the number: the chance of drawing **at least**, **exactly**, or **at
 * most** the copies they asked for.
 *
 * Three modes rather than one, because the same deck answers three genuinely different questions
 * with them. *At least one land* is the question a mana base is built to pass; *exactly one* is
 * the question a deck with a single combo piece asks; *at most* is how a reader checks they are
 * not flooding. The default is `atLeast`, which is the one nearly every deckbuilding
 * conversation is actually about.
 *
 * **Stored as a key, drawn as a word**, so the label can be reworded without invalidating a
 * reader's state — and so a switch over the union is exhaustive.
 */
export type OddsMode = "atLeast" | "exactly" | "atMost";

/**
 * The three modes, in the order the control offers them.
 *
 * **Not through `sortOptions`, and it is the same exemption the grade scale takes: the order _is_
 * the information.** `At least` → `Exactly` → `At most` is one axis read from its inclusive end
 * to its other, the way `Near Mint → Damaged` is, and alphabetising it to
 * `At least · At most · Exactly` would interleave the two ends of a range around its middle.
 * `At least` also happens to be the default and the question nearly every deckbuilding
 * conversation is about, so the ladder and the pin want the same first row.
 *
 * `src/CLAUDE.md` asks that an exempt list say at its own site which of the two kinds it is
 * rather than trusting a census written elsewhere. This is that sentence.
 */
export const ODDS_MODES: readonly { value: OddsMode; label: string }[] = [
  { value: "atLeast", label: "At least" },
  { value: "exactly", label: "Exactly" },
  { value: "atMost", label: "At most" },
];

/** The default hand — seven cards, which is every format's opening hand before a mulligan. */
export const DEFAULT_HAND_SIZE = 7;

/**
 * `n choose k`, built up as a running product rather than from three factorials.
 *
 * **The factorial spelling overflows on a deck.** `100!` is ~9.3e157, which is a finite `number`
 * — but `C(100, 50)` computed as `100! / (50! * 50!)` divides two values around 3e64 out of one
 * around 9e157, and every one of those is far past 2^53 where a double stops counting integers
 * exactly. The running form never holds a value larger than the answer, so `C(100, 7)` is
 * computed through numbers of the order of the result itself.
 *
 * The alternating multiply-then-divide keeps every intermediate an exact integer where the maths
 * allows it: after `i` steps the product is `C(n, i+1)`, which is a whole number, so the division
 * is exact for as long as the answer fits. A deck large enough to lose the last bits of precision
 * is a deck whose odds are being read to the nearest percent anyway.
 *
 * Answers `0` for a `k` outside `[0, n]`, which is the arithmetic every caller wants: the chance
 * of drawing four copies of a card the deck holds three of is not an error, it is zero.
 */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return out;
}

/** The four numbers and the mode one odds reading is made of. */
export interface HandOdds {
  /** Copies in the deck being drawn from — the population. Not the deck's *rows*: four Bolts are
   *  four cards, which is the only reading under which any of this arithmetic is true. */
  deck: number;
  /** Copies of the thing being asked about — the successes in the population. */
  successes: number;
  /** How many cards are drawn. */
  hand: number;
  /** How many copies the reader is asking about. */
  want: number;
  mode: OddsMode;
}

/**
 * The probability, in `[0, 1]`.
 *
 * The kernel is one term of the hypergeometric distribution — the chance of drawing **exactly**
 * `i` of the `successes` in a hand of `hand` from a deck of `deck` — and the three modes are
 * three sums over it. `atLeast` runs from `want` up to the most that can be drawn, `atMost` from
 * zero up to `want`, and `exactly` is the single term.
 *
 * **The ceiling is `min(hand, successes)`, and it is a statement rather than a guard.** You cannot
 * draw more copies than you drew cards, and you cannot draw more copies than the deck holds — but
 * what actually keeps `exactly` from claiming a nonzero chance of drawing four copies out of a
 * hand of two is {@link choose}'s own `k < 0 || k > n`, one function down: every term past the
 * ceiling asks for a `k` outside its bag and gets `0` back. Both `exactly` guards and both
 * `Math.min`/`Math.max` clamps here are therefore **defensive redundancy**, and that was measured
 * rather than assumed — deleting any one of the six changes no answer this module can produce, so
 * no test can be written that fails on it (2026-09-10). They stay because the arithmetic is
 * clearer read with its own bounds in front of it, and because a `choose` that ever grew a
 * different out-of-range answer would otherwise silently take these three sums with it.
 *
 * **A deck of nothing answers `0` rather than dividing by zero.** `choose(0, 0)` is `1`, so an
 * empty deck with an empty hand would otherwise report certainty about a card it does not hold;
 * the guard is on `deck` because that is the denominator, and an empty deck has no opening hand
 * to have odds about. The result is clamped at both ends because a long sum of doubles can land
 * a hair outside the interval, and `100.00000000000001%` is a number no reader should be shown.
 */
export function handOdds({ deck, successes, hand, want, mode }: HandOdds): number {
  if (deck <= 0 || hand <= 0) return 0;
  // A hand cannot be larger than the deck it is drawn from — a reader asking for a nine-card
  // hand out of a seven-card theory list is asking about drawing the whole deck.
  const drawn = Math.min(hand, deck);
  const exact = (i: number) =>
    (choose(successes, i) * choose(deck - successes, drawn - i)) / choose(deck, drawn);

  const top = Math.min(drawn, successes);
  let p = 0;
  if (mode === "exactly") {
    p = want > top || want < 0 ? 0 : exact(want);
  } else if (mode === "atMost") {
    for (let i = 0; i <= Math.min(want, top); i++) p += exact(i);
  } else {
    for (let i = Math.max(0, want); i <= top; i++) p += exact(i);
  }
  return Math.max(0, Math.min(1, p));
}
