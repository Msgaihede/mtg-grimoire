/**
 * How long ago something happened, in words — one rule, for the one page that draws it.
 *
 * `formatWhen` (`ErrorLogPanel`), `formatChecked` (`useUpdate`) and `agoText`
 * (`MarketplacePanel`) all render on the **Settings page**, and until 2026-08-16 no two of
 * them agreed: two floored and one rounded, so the error log said `1 hour ago` about the same
 * ninety minutes the update line called `2 hours ago`; and two took `now` in **milliseconds**
 * while the third took **seconds**, with nothing in the types to tell them apart. The three
 * names survive where they are and delegate here — each has a sentence of its own to build —
 * but the arithmetic is this file's.
 */
import { plural } from "@/lib/counts";

/** Seconds in a day, so the day arm and its callers' cut-offs read off one number. */
export const DAY_SECONDS = 86_400;

/**
 * `just now`, `2 hours ago`, `3 days ago` — **the coarsest unit that is still true**.
 *
 * `floor`, at every rung, which is what "still true" means: ninety minutes have not been two
 * hours, and a line read to answer "are these prices current?" must not round up towards
 * being fresher or staler than the fact. `MarketplacePanel` already argued this at `agoText`;
 * the other two rounded, and rounding is what made ninety minutes read as two hours on the
 * same page an hour-and-a-half old error was reported as one.
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
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/**
 * Whole days elapsed, floored — the number a caller compares against its own cut-off.
 *
 * It is the same count {@link ago}'s day arm prints, exported so that a cut-off and the
 * sentence it gates cannot disagree: `formatChecked` becomes a date exactly when this would
 * have said `8 days ago` or more.
 */
export function daysSince(unixSeconds: number, nowMs: number): number {
  return Math.floor((nowMs / 1000 - unixSeconds) / DAY_SECONDS);
}
