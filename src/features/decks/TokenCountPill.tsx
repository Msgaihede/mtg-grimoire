/**
 * How many distinct tokens and emblems a deck brings, as a bare number in a pill — drawn beside
 * the `Tokens & Emblems` heading on the band **and** on the pile the four views draw, so the two
 * surfaces say one number in one shape (issue #507).
 *
 * **The number is distinct tokens, never copies.** It is the figure that read `N to bring` on the
 * band header: a Treasure stepped to 6 is still one thing to find in the token box, and a count of
 * copies would move every time a reader nudged a stepper — the pile's heading changing under the
 * pointer that changed it.
 *
 * **A bare number is honest here for the app's own rule** (`src/CLAUDE.md`, `CountTag`): the
 * heading set in type immediately beside it says what is being counted. The words still have to
 * reach a screen reader, and the visible digits alone would announce "3" with no noun — so the
 * digits are `aria-hidden` and an `sr-only` twin spells the whole phrase.
 *
 * **One element for the phrase, never two siblings assembled.** Name computation trims each
 * element's contribution before joining (`src/CLAUDE.md`'s `Missing2` rule), so the digits and a
 * trailing "tokens" in two spans would compute to "3tokens". The twin is one string built by
 * `plural`, and the pill's whole accessible text is that string.
 */
import type { JSX } from "react";
import { plural } from "@/lib/counts";

/** The phrase the pill stands for — exported so a test or a story addresses it by the words
 *  rather than by re-deriving the plural. */
export function tokenCountWords(count: number): string {
  return `${plural(count, "token or emblem", "tokens and emblems")} to bring`;
}

export function TokenCountPill({ count }: { count: number }): JSX.Element {
  return (
    <span
      // The data face at the pile heading's own count size (`GroupHeader`'s `text-[0.625rem]`),
      // so this reads as the heading's figure rather than as a badge stuck on beside it. A pill
      // rather than a slanted `CountTag`: that shape is a mark laid *on* a card, and this sits in
      // a line of type.
      className="relative inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface px-1.5 font-mono text-[0.625rem] leading-none tabular-nums text-dim"
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{tokenCountWords(count)}</span>
    </span>
  );
}
