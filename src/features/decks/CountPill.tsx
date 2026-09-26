/**
 * How many copies a pile holds, as a bare number in a pill — the figure beside every pile's name
 * in all four deck views (`GroupHeader`), on the token pile those views draw, and on the
 * `Tokens & Emblems` band, so every heading says its count in one shape (token stacks spec §3.1).
 *
 * **The number is copies, on every pile — the token pile and the band included.** A deck is
 * counted in cards, so a pile of four Lightning Bolts is `4` rather than `1`, and a Treasure stepped
 * to 6 is six tokens to find in the box. This reverses the rule `TokenCountPill` shipped with
 * (issue #507), which counted **distinct** tokens and never copies, on the argument that a count
 * of copies would move under the pointer of a reader nudging a stepper. The reader's answer was
 * copies: the number is what they sleeve and put on the table, and a deck pile's count has always
 * moved when its stepper did. One number for the band and the pile is kept by construction —
 * both sum the same effective quantities.
 *
 * **What is being counted is the caller's to say**, through `words`: a deck pile is
 * {@link cardCountWords}, the token pile and the band {@link tokenCountWords}. The pill draws
 * whatever phrase it is handed and knows no noun of its own.
 *
 * **A bare number is honest here for the app's own rule** (`src/CLAUDE.md`, `CountTag`): the
 * heading set in type immediately beside it says what is being counted. The words still have to
 * reach a screen reader, and the visible digits alone would announce "3" with no noun — so the
 * digits are `aria-hidden` and an `sr-only` twin spells the whole phrase.
 *
 * **One element for the phrase, never two siblings assembled.** Name computation trims each
 * element's contribution before joining (`src/CLAUDE.md`'s `Missing2` rule), so the digits and a
 * trailing "cards" in two spans would compute to "3cards". The twin is one string built by
 * `plural`, and the pill's whole accessible text is that string.
 */
import type { JSX } from "react";
import { plural } from "@/lib/counts";

/** A deck pile's phrase — `1 card`, `4 cards`. Exported so a test or a story addresses the pill
 *  by the words rather than by re-deriving the plural. */
export function cardCountWords(count: number): string {
  return plural(count, "card");
}

/**
 * The token pile's and the band's phrase — `1 token or emblem`, `6 tokens and emblems`.
 *
 * **No `to bring` any more.** That suffix belonged to the band's old header line, which counted
 * distinct tokens; the pill now counts copies beside the `Tokens & Emblems` heading, which already
 * says what the pile is, so the phrase is the count and its noun and nothing else.
 */
export function tokenCountWords(count: number): string {
  return plural(count, "token or emblem", "tokens and emblems");
}

export function CountPill({ count, words }: { count: number; words: string }): JSX.Element {
  return (
    <span
      // The data face at the pile heading's own count size (`GroupHeader`'s `text-[0.625rem]`),
      // so this reads as the heading's figure rather than as a badge stuck on beside it. A pill
      // rather than a slanted `CountTag`: that shape is a mark laid *on* a card, and this sits in
      // a line of type.
      className="relative inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface px-1.5 font-mono text-[0.625rem] leading-none tabular-nums text-dim"
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}
