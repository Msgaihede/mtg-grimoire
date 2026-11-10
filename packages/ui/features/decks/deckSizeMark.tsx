/**
 * The card count on a gallery tile, and whether it fits the deck's format (issue #1524).
 *
 * A reader browsing a wall of Commander decks wants to see at a glance which ones are
 * playable — 100 cards — and which are still being built. The count is already on every tile's
 * caption (`Commander · Paper · 73 cards`), so the answer is that number drawn in the
 * destructive red the editor's validation panel marks a broken rule with, rather than a new
 * mark competing with the badge and the bracket on the art.
 *
 * **The rule is the engine's, not this file's.** {@link deckSizeIssue} is the very function
 * `validateDeck` sizes a deck with, and `DeckRow.cardCount` counts the same cards it does
 * (`SIZE_KINDS`, active categories, the live list) — so the tile goes red exactly when the
 * editor's panel would say the deck is the wrong size, in the same sentence. A format that
 * judges nothing (`unspecified`) and a format the seed no longer carries both draw a plain
 * count: no verdict about rules the reader never picked.
 */
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { DeckRow, FormatSpec } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { deckSizeIssue } from "./validation/engine";

/**
 * The editor's deck-size sentence for this deck, or `null` when its size fits — or when there is
 * no spec to judge it by (still loading, or a key the table no longer carries).
 */
export function deckSizeProblem(deck: DeckRow, spec: FormatSpec | null): string | null {
  if (spec === null) return null;
  return deckSizeIssue(deck.cardCount, spec)?.message ?? null;
}

/**
 * `73 cards`, with the number in red and the reason on hover when the count does not fit.
 *
 * The colour is never the only signal: the sentence is also in the accessible name, so a screen
 * reader hears why the count is marked, and the hover says it to a pointer. Only the digits take
 * the colour, so the caption's other terms keep the dim they share with every tile.
 */
export function DeckCardCount({ count, problem }: { count: number; problem: string | null }) {
  const tip = useTooltip();
  return (
    <>
      <span
        data-size-problem={problem === null ? undefined : ""}
        className={cn("font-mono tabular-nums", problem !== null && "text-destructive")}
        {...tip(problem, { describes: false })}
      >
        {count}
      </span>{" "}
      {count === 1 ? "card" : "cards"}
      {/* Behind a sibling space: a name computation trims each element's part before joining
          them, so only a text node between the two keeps the words apart. */}
      {problem !== null && (
        <>
          {" "}
          <span className="sr-only">{problem}</span>
        </>
      )}
    </>
  );
}
