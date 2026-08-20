/**
 * Everything a bulk import will not do, quoted back with the line it came from — the collection's
 * and the wishlist's own version of `DeckPreview.tsx`'s `Problems`.
 *
 * **Not that component itself.** `Problems` takes a whole `ImportPlan` and a `blameSync` flag
 * derived from `plan.cards` and the sync status — a fact only a *deck* plan carries, because only
 * the deck's planner tries to file a card by type line while the corpus is still filling. A
 * collection or a wishlist import has no piles to file into and therefore no such flag to
 * compute; three lists is what both planners' own `unmatched`/`hintMisses`/`parseIssues` already
 * give, so this draws exactly that — `DeckPreview.tsx`'s `ProblemList` leaf, reused rather than
 * copied, because the leaf owes nothing to the deck's own shape.
 */
import type { JSX } from "react";
import { plural } from "@/lib/counts";
import type { HintMiss, UnmatchedLine } from "../destinations/deck";
import { ProblemList } from "../destinations/DeckPreview";
import type { ParseIssue } from "../parse";

export function ImportProblems({
  unmatched,
  hintMisses,
  parseIssues,
}: {
  unmatched: readonly UnmatchedLine[];
  hintMisses: readonly HintMiss[];
  parseIssues: readonly ParseIssue[];
}): JSX.Element | null {
  if (unmatched.length === 0 && hintMisses.length === 0 && parseIssues.length === 0) return null;

  return (
    <div className="space-y-3">
      {unmatched.length > 0 && (
        <ProblemList
          caption={`${plural(unmatched.length, "line")} named a card this app has not got`}
          lines={unmatched.map((line) => `line ${line.lineNumber} · "${line.raw.trim()}"`)}
        />
      )}
      {hintMisses.length > 0 && (
        <ProblemList
          caption={`${plural(hintMisses.length, "printing")} could not be found, so another was used`}
          lines={hintMisses.map(
            (miss) => `line ${miss.lineNumber} · ${miss.name} — used ${miss.used} instead`,
          )}
        />
      )}
      {parseIssues.length > 0 && (
        <ProblemList
          caption={`${plural(parseIssues.length, "line")} could not be read`}
          lines={parseIssues.map(
            (issue) => `line ${issue.lineNumber} · "${issue.raw.trim()}" — ${issue.reason}`,
          )}
        />
      )}
    </div>
  );
}
