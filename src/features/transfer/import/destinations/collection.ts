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
  // Keyed on the part of the collection's grain an import can produce — {@link grainKey}, which
  // is where the two terms it cannot produce are argued. A file naming the same grain twice is
  // one intention said twice: under `add` it would double-count, and under `set` the second line
  // would silently win.
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
    // The six columns that are part of what *identifies* a collection row rather than
    // decoration on one. A CSV this app wrote carries all six (`SURFACE_FIELDS.collection`),
    // and until 2026-08-23 none of them was read back — see the fold key below.
    const altered = flagOf(line.extra.altered);
    const signed = flagOf(line.extra.signed);
    const proxy = flagOf(line.extra.proxy);
    const misprint = flagOf(line.extra.misprint);
    const serialNumber = textOrUndefined(line.extra.serialNumber);
    const grading = textOrUndefined(line.extra.grading);
    const key = grainKey({
      cardId: matched.cardId,
      finish,
      condition,
      altered,
      signed,
      proxy,
      misprint,
      serialNumber,
      grading,
    });
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
      altered,
      signed,
      proxy,
      misprint,
      serialNumber,
      grading,
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
 * `schema::COLLECTION_GRAIN` as a key, as far as an *importer* can spell it.
 *
 * **Eleven columns identify a collection row and this used to fold on three of them**
 * (`cardId, finish, condition`). Two exported rows differing only in `Altered` folded into one
 * item, `commit_import` hard-coded all six flag/identity columns to their defaults, and
 * `ON CONFLICT(COLLECTION_GRAIN)` could therefore never match the reader's altered or graded
 * row — the import wrote a **second, all-defaults entry beside it**, in `add` mode summing the
 * quantities of both. `docs/reference/import-export.md` works the arithmetic through and called
 * it latent, because nothing let a reader set one of the six; PR 4's import toggle is what makes
 * it live, so it is fixed with the grain change rather than after it.
 *
 * **Two of the eleven terms are absent from this key, and each for a reason that makes it
 * complete rather than short:**
 *
 * - **`lang` is a function of `cardId`**, not of the file. `collection::add_entry` copies
 *   `lang`, `set_code` and `collector_number` off `cards` at write time and never takes them
 *   from the caller — "letting a caller supply these would let a caller disagree with the card
 *   it named" — so two lines resolving to one printing can never differ in it. A CSV *has* a
 *   `Lang` column; it is a fact the export writes and the import cannot act on.
 * - **`folderId` is a constant here, and the constant is the root.** An importer names no
 *   folder — there is no control for one and `CollectionImportItem` has no field — so every
 *   imported row lands with `folder_id` NULL, which is where every unfiled row is and is a real
 *   destination rather than an omission. A constant term partitions nothing, so leaving it out
 *   costs the key nothing. What it *does* mean is that an import can never land on a row the
 *   reader has filed into a binder: that row's grain has an eleventh term this one does not
 *   share, so it is a different row, exactly as an altered copy is. That is the folder grain
 *   working, not this fold failing.
 *
 * `grading` is compared **verbatim**, where `collection::canonical_grading` would re-serialise
 * it into `GRADING_FIELDS` order first. Two spellings of one slab therefore survive as two items
 * and are folded by the commit's `ON CONFLICT` instead — which is the right end for it, because
 * a second reading of that parser over here is a second thing to drift. This fold's own job is
 * narrower: a file naming one intention twice must not be sent twice.
 *
 * `JSON.stringify` rather than a joined template, because a serial number and a grading blob are
 * free text and a space-separated key cannot tell `"a b"` from `"a" "b"`.
 */
function grainKey(terms: {
  cardId: string;
  finish: DeckFinish;
  condition: Condition;
  altered: boolean;
  signed: boolean;
  proxy: boolean;
  misprint: boolean;
  serialNumber: string | undefined;
  grading: string | undefined;
}): string {
  return JSON.stringify([
    terms.cardId,
    terms.finish ?? "",
    terms.condition,
    terms.altered,
    terms.signed,
    terms.proxy,
    terms.misprint,
    // The crate's `coalesce(serial_number, '')` and `coalesce(grading, '')`: a NULL in a UNIQUE
    // index is distinct from every other NULL, so both terms have to be flattened to a value.
    terms.serialNumber ?? "",
    terms.grading ?? "",
  ]);
}

/**
 * One of the four boolean grain columns, read out of a cell.
 *
 * `TRANSFER_FIELDS`' own writer emits `yes`/`no`/`""`, so `yes` is the answer this has to know;
 * the rest of the vocabulary is here because **import is permissive and export is canonical** —
 * a file a reader edited in a spreadsheet says `TRUE`, and one another tool wrote says `1`.
 *
 * **Anything else is `false`, and silence is `false`.** The column is `INTEGER NOT NULL DEFAULT
 * 0`: a card is altered or it is not, so there is no third state to carry and nothing for an
 * `unknownConditions`-style warning row to be about. That is the one place this is looser than
 * the condition reader beside it, and the difference is the column's rather than a choice —
 * a grade this app cannot read could have been any of five, and a flag it cannot read is a
 * card nobody said anything true about.
 */
function flagOf(raw: string | undefined): boolean {
  const cleaned = (raw ?? "").trim().toLowerCase();
  return cleaned === "yes" || cleaned === "y" || cleaned === "true" || cleaned === "t" ||
    cleaned === "1";
}

/** A free-text grain cell — trimmed, and blank read as absent. An empty `Serial number` column
 *  is a card with no serial, which is the same row as one whose file had no such column at all;
 *  `""` and `undefined` must not be two grains. */
function textOrUndefined(raw: string | undefined): string | undefined {
  const cleaned = (raw ?? "").trim();
  return cleaned === "" ? undefined : cleaned;
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
