import { count } from "@/lib/counts";

/**
 * How many matches there are, in words.
 *
 * The backend stops counting at 5 000 rather than scanning 116 k rows for a number nobody
 * reads precisely, so past that this says `5,000+ cards` — a floor, which is true —
 * instead of `5,000 cards`, which would not be.
 *
 * **Its own module since 2026-10-03**, out of `SearchPage.tsx`, because that page reads the
 * desktop's store and the phone face's search page says the same count under its own box. One
 * function, so the two faces cannot come to disagree about the capped case.
 */
export function countOf(total: number, capped: boolean): string {
  const n = `${count(total)}${capped ? "+" : ""}`;
  // **Not `plural`.** The condition is `total === 1 && !capped`, because a capped count of one
  // is `5,000+`, and `5,000+ card` must never print. Only the numeral is shared.
  return `${n} ${total === 1 && !capped ? "card" : "cards"}`;
}
