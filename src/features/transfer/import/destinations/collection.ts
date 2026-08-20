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

/**
 * A line whose `extra.condition` this app does not recognise — the design spec's third per-row
 * warning (spec §7: "unknown conditions"), beside the unmatched-card and fuzzy-set-match rows
 * the deck's own planner already draws. `normalizeCondition`'s own doc says why this cannot be
 * silent: *"`matched: false` is not an error — it is what an import preview shows as a warning
 * row"* — dropping the flag here would be the one destination that reads conditions at all
 * quietly filing every unreadable grade as if the reader had chosen the app's own NM default.
 */
export interface UnknownCondition {
  lineNumber: number;
  name: string;
  /** What the file actually said, verbatim — trimmed, never empty (an empty or absent cell is
   *  silence, not an unknown grade, and never reaches this list). */
  said: string;
}

export interface CollectionPlan {
  items: CollectionImportItem[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  unknownConditions: UnknownCondition[];
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
  const unknownConditions: UnknownCondition[] = [];
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
    // `matched: false` is a grade this app does not recognise — flagged for the reader rather
    // than silently taking `normalizeCondition`'s own NM fallback, which is the *best* grade on
    // the scale and the one answer least likely to be what the file meant. An unreadable grade
    // is treated the same as silence and falls back to the reader's own chosen default: "the
    // condition when the file doesn't say" is exactly what an unreadable one amounts to.
    if (normalized !== null && !normalized.matched) {
      unknownConditions.push({
        lineNumber: line.lineNumber,
        name: line.name,
        said: normalized.original ?? "",
      });
    }
    const condition =
      normalized !== null && normalized.matched ? normalized.condition : options.condition;
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
    unknownConditions,
    parseIssues: list.issues,
    totalCards: items.reduce((n, i) => n + i.quantity, 0),
  };
}

/**
 * A price cell, read the way a spreadsheet actually writes one — a currency symbol in front, a
 * thousands separator inside — rather than the bare number `Number.parseFloat` alone can read.
 *
 * `Number.parseFloat("$4.50")` is `NaN`: it stops at the first character that cannot start a
 * number, and `$` cannot. Both TCGplayer's and Deckbox's own CSV exports write a symbol prefix,
 * so a purchase price coming back from either was dropped on every row rather than a rare one.
 * Only `$`, `€`, `£` and a comma are stripped — the currencies this app's own `formatPrice`
 * knows — so a cell this cannot make sense of still falls through to `NaN` rather than being
 * guessed at.
 */
function numberOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.trim().replace(/[$€£,]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** The printing a line was answered with, as a card prints it — `deck.ts`'s own `printingOf`,
 *  copied rather than imported: it is one line, and importing it would reach into a file whose
 *  own doc says it decides deck questions and nothing past that. */
function printingOf(match: { setCode: string; collectorNumber: string }): string {
  return `${match.setCode.toUpperCase()} ${match.collectorNumber}`;
}
