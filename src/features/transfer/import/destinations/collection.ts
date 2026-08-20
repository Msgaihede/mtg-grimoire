/**
 * Where every line of a list is going when the destination is the collection.
 *
 * Pure, like `buildImportPlan` beside it and for the same reason: which printing is Rust's
 * question, and what a reader owns is a decision about their collection. The one thing this
 * knows that the deck's planner does not is that a **CSV can carry a condition** — so `extra`
 * is read first and `options` only fills the silence.
 */
import { normalizeCondition, type Condition } from "@/lib/conditions";
import type { CollectionImportItem, DeckFinish, ImportResolveRow } from "@/lib/ipc";
import type { ParsedList } from "../parse";
import type { HintMiss, UnmatchedLine } from "./deck";

export interface CollectionOptions {
  /** What a line that says nothing becomes. Chosen in the preview; never defaulted twice. */
  condition: Condition;
  finish: DeckFinish;
}

export interface CollectionPlan {
  items: CollectionImportItem[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  parseIssues: ParsedList["issues"];
  /** Copies that will actually land — not `ParsedList.totalCards`, which counts lines
   *  nothing resolved. */
  totalCards: number;
}

export function planCollectionImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
  options: CollectionOptions,
): CollectionPlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  // Keyed on the part of the collection's grain an import can produce. A file naming the same
  // grain twice is one intention said twice: under `add` it would double-count, and under
  // `set` the second line would silently win.
  const folded = new Map<string, CollectionImportItem>();

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

    // The file's own word wins; `options` fills the silence. `normalizeCondition` folds the
    // EU scale into the NA one and hands back what the file actually said, which is exactly
    // what `conditionOriginal` is for — and it answers `original: null` for silence, where
    // `CollectionImportItem`'s optional fields answer `undefined`, so the `?? undefined` below
    // is the one seam between the two.
    const said = line.extra.condition;
    const normalized = said === undefined ? null : normalizeCondition(said);
    const condition = normalized?.condition ?? options.condition;
    const finish = line.finish ?? options.finish;
    const key = `${matched.cardId} ${finish ?? ""} ${condition}`;
    const seen = folded.get(key);
    if (seen !== undefined) {
      seen.quantity += line.quantity;
      return;
    }
    folded.set(key, {
      cardId: matched.cardId,
      quantity: line.quantity,
      // `nonfoil` is what Rust's CHECK takes for the regular copy; `null` is this app's word.
      finish: finish ?? "nonfoil",
      condition,
      conditionOriginal: normalized?.original ?? undefined,
      purchasePrice: numberOrUndefined(line.extra.purchasePrice),
      purchaseCurrency: line.extra.purchaseCurrency,
      acquiredAt: line.extra.acquiredAt,
      acquisitionSource: line.extra.acquisitionSource,
      notes: line.extra.notes,
    });
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

function numberOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The printing a line was answered with, as a card prints it — `deck.ts`'s own `printingOf`,
 *  copied rather than imported: it is one line, and importing it would reach into a file whose
 *  own doc says it decides deck questions and nothing past that. */
function printingOf(match: { setCode: string; collectorNumber: string }): string {
  return `${match.setCode.toUpperCase()} ${match.collectorNumber}`;
}
