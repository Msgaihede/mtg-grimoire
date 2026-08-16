/**
 * How long ago something happened, in words — one rule, for the one page that draws it.
 *
 * `formatWhen` (`ErrorLogPanel`), `formatChecked` (`useUpdate`) and `agoText`
 * (`MarketplacePanel`) all render on the **Settings page**, and until 2026-08-16 all three
 * rounded differently. Not two-against-one: **three rules, one each.**
 *
 * - `agoText` floored throughout, and was the one this file was built from.
 * - `formatChecked` **rounded at every rung** — `round(seconds/60)`, then `round(minutes/60)`,
 *   then `round(hours/24)` — so ninety minutes read `2 hours ago`, and seven and a half days
 *   rounded to eight and printed a date.
 * - `formatWhen` rounded **once**, converting to seconds (`round(now/1000 - unixSeconds)`),
 *   and floored every rung after. So it agreed with `agoText` on ninety minutes and disagreed
 *   with it in a **half-second window at each boundary**: an elapsed 3 599.6s rounded up to
 *   3 600 and read `1 hour ago`, where flooring reads `59 minutes ago`.
 *
 * **That last one did move, and the new answer is the wanted one**: 3 599.6 seconds have not
 * been an hour, and the rule this file states is the coarsest unit that is *still true*. It
 * is a narrow window and no test could see it — `ErrorLogPanel.test.tsx` passes whole-second
 * boundaries, where round and floor agree — which is exactly why it is written down here
 * rather than left to a reader to rediscover from the diff.
 *
 * The unit mismatch went with it: two took `now` in **milliseconds** and the third took
 * **seconds**, with nothing in the types to tell them apart. The three names survive where
 * they are and delegate here — each has a sentence of its own to build — but the arithmetic
 * is this file's.
 */
import { plural } from "@/lib/counts";

/**
 * Seconds in a day, so {@link ago}'s day arm and {@link daysSince} read off one number.
 *
 * Module-private: nothing outside needs it, because a caller that wants a cut-off wants
 * `daysSince` rather than the constant it divides by.
 */
const DAY_SECONDS = 86_400;

/**
 * `just now`, `2 hours ago`, `3 days ago` — **the coarsest unit that is still true**.
 *
 * `floor`, at every rung, which is what "still true" means: ninety minutes have not been two
 * hours, and a line read to answer "are these prices current?" must not round up towards
 * being fresher or staler than the fact. `MarketplacePanel` already argued this at `agoText`;
 * the other two each rounded somewhere, which is how ninety minutes came to read as two hours
 * on the same page an hour-and-a-half old error was reported as one. Which of them rounded
 * where, and what that cost, is on the module comment above.
 *
 * The day arm divides `elapsed` by {@link DAY_SECONDS} rather than the hours it just
 * computed. Identical arithmetic — nested floor division collapses for positive divisors, and
 * this arm is only reached at `elapsed >= DAY_SECONDS` — and it makes the count literally the
 * one {@link daysSince} returns rather than a second derivation that happens to agree.
 *
 * Below a minute it is `just now`, which is also the answer for a **negative** elapsed time: a
 * clock that moved backwards, or a stamp from the future, and `in -3 minutes` helps nobody.
 * No arm above days — past a week the caller wants a date, and that is `formatChecked`'s
 * decision to make rather than this function's.
 *
 * @param unixSeconds when it happened, in **seconds** (what SQLite and every feed store).
 * @param nowMs the clock, in **milliseconds** (what `Date.now()` answers).
 */
export function ago(unixSeconds: number, nowMs: number): string {
  const elapsed = Math.floor(nowMs / 1000 - unixSeconds);
  if (elapsed < 60) return "just now";
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(elapsed / DAY_SECONDS), "day")} ago`;
}

/**
 * Whole days elapsed, floored — the number a caller compares against its own cut-off.
 *
 * It is the same expression {@link ago}'s day arm prints — both are
 * `Math.floor(elapsed / DAY_SECONDS)` — exported so that a cut-off and the sentence it gates
 * cannot disagree: `formatChecked` becomes a date exactly when this would have said
 * `8 days ago` or more.
 */
export function daysSince(unixSeconds: number, nowMs: number): number {
  return Math.floor((nowMs / 1000 - unixSeconds) / DAY_SECONDS);
}
