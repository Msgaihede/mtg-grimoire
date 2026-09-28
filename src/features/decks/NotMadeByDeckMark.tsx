/**
 * The mark a token wears when **nothing in the deck makes it** — a token the reader added by hand
 * (managed tokens spec §3.5, the reader's own ask: *"an outline and a badge"*).
 *
 * ## Drawn like a rule-break card, on purpose
 *
 * The reader asked for such a token to be marked the way a card breaking a rule is: the card's
 * own edge in the destructive colour, and a boxed word in the corner the `RULE BREAK` mark takes.
 * A token can never break a rule — it is not a `deck_cards` row, so validation never reads it —
 * so the corner is always free, and the badge takes **that mark's place and that mark's style**:
 * bottom-left over the art, 9px of the data face in the destructive colour, on the felt at 85%
 * behind a hairline, all of it scaled by the card's own `--mark-scale`. The edge is the caller's,
 * because the two surfaces own their outline differently (`DeckCardFace`'s body in the pile,
 * `CardArt`'s wrapper on the band).
 *
 * **The box is `CardMarks.tsx`'s `WordMark`, the one `RuleBreakMark` draws too.** It landed here
 * as that mark's classes repeated rather than shared, because `CardMarks.tsx` belonged to another
 * change that day; that debt is paid, and a change to the rule-break box is now a change to this
 * one by construction rather than by somebody remembering.
 *
 * ## `aria-hidden`, with the words in the name
 *
 * Every mark on a card is decoration to a screen reader, because the button the card is carries
 * the facts in its own name — `deckTokens.ts`' `tokenArtName` folds *not made by deck* into the
 * art press's name for exactly this token. The sentence is one hover away for a pointer, through
 * `WordMark`'s `useTooltip` (never a `title`), `describes: false` because the name already says it.
 */
import { cn } from "@/lib/utils";
import { WordMark } from "./CardMarks";
import { NOT_MADE_BY_DECK, notMadeByDeckHint } from "./deckTokens";

/**
 * `NOT MADE BY DECK`, boxed in the destructive colour, with the reason one hover away.
 *
 * `name` is the token's, and it is what the sentence names: *Nothing in this deck makes
 * Treasure. It was added by hand.* Placement is the caller's `className` — `DeckCardFace` and the
 * band's tile both put it where the rule-break mark goes.
 *
 * `whitespace-nowrap` is this mark's one addition to the shared box: three words where the rule
 * break has two, and a badge that broke onto a second line would climb the art it sits on.
 */
export function NotMadeByDeckMark({ name, className }: { name: string; className?: string }) {
  return (
    <WordMark
      word={NOT_MADE_BY_DECK}
      hint={notMadeByDeckHint(name)}
      className={cn("whitespace-nowrap", className)}
    />
  );
}
