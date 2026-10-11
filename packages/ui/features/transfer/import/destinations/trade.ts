/**
 * One side of a trade's planner (issue #903).
 *
 * **A trade line is a printing, a finish and a count, and nothing else** — so a decklist becomes
 * one by dropping everything a line cannot hold. The pile a line was filed under, its label, its
 * notes and its condition say nothing a trade can keep, and a sideboard is cards like any other
 * here: the reader pasted the list to say *these cards are on the table*.
 *
 * **The printing is always pinned**, unlike the wishlist's planner: a trade line names one
 * printing (`trade_lines.card_id` is `NOT NULL`), so a line that named only a card takes whichever
 * printing `import_resolve` answered — the one the reader owns first, then the newest — exactly as
 * the deck's does. The finish is the line's own marker or the regular copy.
 */
import type { Finish } from "@/lib/finish";
import type { ImportResolveRow, TradeLineInput } from "@/lib/ipc";
import type { ParsedList } from "../parse";
import type { HintMiss, UnmatchedLine } from "./deck";

export interface TradePlan {
  /** One per printing and finish, in the order the list first named each. */
  items: TradeLineInput[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  parseIssues: ParsedList["issues"];
  totalCards: number;
}

export function planTradeImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
): TradePlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  // Folded here although `trade_add_lines` folds too: the preview's count of lines is then the
  // count of lines the side will gain, and a list naming one card twice reads as one line.
  const folded = new Map<string, TradeLineInput>();

  list.lines.forEach((line, index) => {
    const row = byIndex.get(index);
    const matched = row?.matched ?? null;
    if (matched === null) {
      unmatched.push({ lineNumber: line.lineNumber, raw: line.raw, name: line.name });
      return;
    }
    if (row?.hintMissed === true) {
      hintMisses.push({ lineNumber: line.lineNumber, name: line.name, used: printingOf(matched) });
    }

    const finish: Finish = line.finish ?? "nonfoil";
    const key = `${matched.cardId} ${finish}`;
    const seen = folded.get(key);
    if (seen !== undefined) {
      seen.quantity += line.quantity;
      return;
    }
    // `search`: the line was named by text and answered from the card database, which is what
    // the side's own search field does. Not `collection` — that word is the page's mark for a
    // card picked from what the reader owns, and a list names a card whether they own it or not.
    folded.set(key, { cardId: matched.cardId, finish, quantity: line.quantity, source: "search" });
  });

  const items = [...folded.values()];
  return {
    items,
    unmatched,
    hintMisses,
    parseIssues: list.issues,
    totalCards: items.reduce((n, i) => n + i.quantity, 0),
  };
}

/** The printing a line was answered with, as a card prints it — the other planners' own copy,
 *  kept local for their reason: one line is not worth an import across destinations. */
function printingOf(match: { setCode: string; collectorNumber: string }): string {
  return `${match.setCode.toUpperCase()} ${match.collectorNumber}`;
}
