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
 * **The classes are `CardMarks.tsx`'s `RuleBreakMark`'s, repeated rather than shared, and that is
 * a debt rather than a design.** That component spells its one word inside itself, so it cannot
 * draw a second one, and the change that would let it — a word as a prop, or its classes as an
 * export — belongs to that file, which another change owned when this one landed. Folding the two
 * into one component is the next edit either file gets; until then {@link WORD_MARK} and
 * `RuleBreakMark` must change together.
 *
 * ## `aria-hidden`, with the words in the name
 *
 * Every mark on a card is decoration to a screen reader, because the button the card is carries
 * the facts in its own name — `deckTokens.ts`' `tokenArtName` folds *not made by deck* into the
 * art press's name for exactly this token. The sentence is one hover away for a pointer, through
 * `useTooltip` (never a `title`), `describes: false` because the name already says it.
 */
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";
import { NOT_MADE_BY_DECK, notMadeByDeckHint } from "./deckTokens";

/**
 * `RuleBreakMark`'s box, class for class — see this file's header for why it is repeated. The
 * border, the radius and the vertical padding do not scale, for that mark's reason: each is a
 * pixel or three, and a hairline is a hairline at every size.
 */
const WORD_MARK = cn(
  "rounded-[3px] border border-destructive/50 bg-bg/85 py-px",
  "px-[calc(0.25rem*var(--mark-scale,1))]",
  "font-mono text-[calc(0.5625rem*var(--mark-scale,1))] text-destructive",
);

/**
 * `NOT MADE BY DECK`, boxed in the destructive colour, with the reason one hover away.
 *
 * `name` is the token's, and it is what the sentence names: *Nothing in this deck makes
 * Treasure. It was added by hand.* Placement is the caller's `className` — `DeckCardFace` and the
 * band's tile both put it where the rule-break mark goes.
 */
export function NotMadeByDeckMark({ name, className }: { name: string; className?: string }) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      {...tip(notMadeByDeckHint(name), { describes: false })}
      className={cn(WORD_MARK, "whitespace-nowrap", className)}
    >
      {NOT_MADE_BY_DECK}
    </span>
  );
}
