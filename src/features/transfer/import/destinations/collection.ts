/**
 * Where every line of a list is going when the destination is the collection.
 *
 * Pure, like `buildImportPlan` beside it and for the same reason: which printing is Rust's
 * question, and what a reader owns is a decision about their collection. The one thing this
 * knows that the deck's planner does not is that a **CSV can carry a condition** — so `extra`
 * is read first and `options` only fills the silence.
 *
 * **It has three callers now, and the two deck arms are why it is worth saying it is pure.**
 * `CollectionPreview` is the destination this was written for; `DeckPreview` and
 * `NewDeckPreview` call it a **second time over the same `resolved` rows** when the reader ticks
 * "Add cards to collection", rather than adapting the deck's own items across. The grains do not
 * meet: a deck item is `(cardId, category, finish)` and one of these is the eleven-column
 * collection grain, carrying a condition, four flags, a serial number, a grading blob and a
 * whole acquisition story a deck row has nowhere to put. Two lists planned from one set of rows
 * is a fold; one list derived from the other would be a lossy translation in one direction and
 * an invented default in the other.
 *
 * **The collection CSV is described as a restore, and since issue #555 it reads like one.** Three
 * columns this app writes were never read back — `Tags`, `Tradelist quantity` and `Language` —
 * and the fold kept the first line's notes and price and dropped the second's without a word. A
 * backup that lost the reader's tags on the way back in was a backup of everything except the
 * part they had typed themselves. Every column is read now, and every place the planner cannot
 * carry what the file said is a list on the preview rather than a silence.
 */
import { normalizeCondition, type Condition } from "@/lib/conditions";
import type { CollectionImportItem, DeckFinish, ImportResolveRow } from "@/lib/ipc";
import { languageCode } from "@/lib/languages";
import { parsePurchasePrice } from "@/lib/prices";
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
 * quietly filing every unreadable grade as though the file had named no grade to begin with.
 */
export interface UnknownCondition {
  lineNumber: number;
  name: string;
  /** What the file actually said, verbatim — trimmed, never empty (an empty or absent cell is
   *  silence, not an unknown grade, and never reaches this list). */
  said: string;
}

/**
 * A line whose `Purchase price` cell said something {@link parsePurchasePrice} refused — the
 * {@link UnknownCondition} row's reasoning one column over. The copy still lands, with no price;
 * silence here would be indistinguishable from a file with no price column at all. `said` is the
 * cell verbatim and never empty: a blank cell never reaches `extra`.
 */
export type UnreadablePrice = UnknownCondition;

/**
 * A `Tradelist quantity` cell that is not a whole number of copies — `2.5`, `-1`, `some`. The
 * same row once more: the copy lands, the tradelist is left as the row already had it, and the
 * reader is told the cell was not empty. **Refused rather than rounded**, because `2.5` copies
 * offered for trade is not a number anybody meant, and a guess at which one they did mean is a
 * promise made to a trading partner on the reader's behalf.
 */
export type UnreadableTradelist = UnknownCondition;

/**
 * A `Language` cell {@link languageCode} does not recognise. The line still resolved — the
 * resolver was simply sent no preference — so what this row says is that the file named a
 * language and nothing here acted on it.
 */
export type UnknownLanguage = UnknownCondition;

/**
 * A line whose language this app read, and whose resolved printing is in another one.
 *
 * **The resolver is sent the file's language as a preference** (`ImportResolveLine.lang`), and a
 * preference only loses when the corpus holds no printing in that language — Scryfall's default
 * bulk data carries a non-English printing only where there is no English one. So a mismatch here
 * is not the resolver ignoring the file; it is this app's card data having nothing else to offer,
 * and the copy is recorded in the language it does have. `collection::add_entry` copies `lang`
 * off `cards` rather than taking it from the caller, so there is no way to file a Japanese copy
 * against an English printing, and this list is the reader's only notice that the row will say
 * English.
 */
export interface LanguageMismatch {
  lineNumber: number;
  name: string;
  /** The Scryfall code the file's cell read as — `ja`, never the cell's own `Japanese`. */
  said: string;
  /** The code of the printing the line resolved to. */
  used: string;
}

/**
 * A line that named the same copy an earlier line had already named, and was merged into it.
 *
 * The fold was always there (see {@link grainKey}); what was missing is the reader hearing about
 * it. A 300-line file that lands as 290 rows is a file the reader will count, and "ten of these
 * were the same copy twice" is the answer they would otherwise have to find by hand.
 */
export interface FoldedLine {
  lineNumber: number;
  /** The earlier line whose copy this one joined — the first line the file wrote at that grain. */
  into: number;
  name: string;
}

/**
 * A folded line whose purchase price was in a different currency from the price the merged copy
 * kept, and was therefore left out of it.
 *
 * **A mean across currencies is a number in no currency**, and converting would need a rate and a
 * date this app does not have. So the first price the file wrote for a copy sets its currency, and
 * a later line's price in another one is listed rather than averaged in. `currency` and `kept`
 * are the cells as the file wrote them, `undefined` where a line named none — which counts as a
 * currency of its own, because a price whose currency nobody said is a price nobody can compare.
 */
export interface DroppedPrice {
  lineNumber: number;
  into: number;
  name: string;
  /** The `Purchase price` cell verbatim. */
  said: string;
  currency: string | undefined;
  kept: string | undefined;
}

export interface CollectionPlan {
  items: CollectionImportItem[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  unknownConditions: UnknownCondition[];
  unreadablePrices: UnreadablePrice[];
  unreadableTradelists: UnreadableTradelist[];
  unknownLanguages: UnknownLanguage[];
  languageMismatches: LanguageMismatch[];
  folded: FoldedLine[];
  droppedPrices: DroppedPrice[];
  parseIssues: ParsedList["issues"];
  /** Copies that will actually land — not `ParsedList.totalCards`, which counts lines
   *  nothing resolved. */
  totalCards: number;
}

/**
 * One copy while the file is still being read — the item, plus what a later line at the same
 * grain has to be merged into it.
 *
 * **The item is not finished until every line is read**, which is why this is a type of its own
 * rather than the item mutated in place. A mean price, a combined note and a union of tags are
 * each a fact about *all* the lines at a grain, and writing the first line's value onto the item
 * and patching it per line is how the fold came to keep the first line's notes and drop the
 * second's for as long as it did.
 */
interface Pending {
  /** The line number a later line is merged `into`. */
  into: number;
  item: CollectionImportItem;
  tradelist: number | undefined;
  tags: string[] | undefined;
  notes: string[];
  sources: string[];
  acquiredAt: string | undefined;
  price: PriceMean | undefined;
  /** The first currency any line named, for a copy no line priced — a currency with no price
   *  beside it is what the file said, so it is carried rather than dropped. */
  currency: string | undefined;
}

/** A quantity-weighted mean in the making, over the lines that carried a price in one currency. */
interface PriceMean {
  currency: string | undefined;
  /** Σ price × copies. */
  sum: number;
  /** Σ copies — only the priced lines' copies, because a line with no price says nothing about
   *  what the others cost. */
  copies: number;
  /** The most decimals any contributing price was written with — see {@link meanOf}. */
  decimals: number;
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
  const unreadablePrices: UnreadablePrice[] = [];
  const unreadableTradelists: UnreadableTradelist[] = [];
  const unknownLanguages: UnknownLanguage[] = [];
  const languageMismatches: LanguageMismatch[] = [];
  const folded: FoldedLine[] = [];
  const droppedPrices: DroppedPrice[] = [];
  // Keyed on the part of the collection's grain an import can produce — {@link grainKey}, which
  // is where the two terms it cannot produce are argued. A file naming the same grain twice is
  // one intention said twice: under `add` it would double-count, and under `set` the second line
  // would silently win.
  const pending = new Map<string, Pending>();

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

    // The file's language against the printing it got. Checked per line, before the fold, so a
    // second line merged into a first is still named by its own number.
    const saidLang = textOrUndefined(line.extra.lang);
    if (saidLang !== undefined) {
      const code = languageCode(saidLang);
      if (code === null) {
        unknownLanguages.push({ lineNumber: line.lineNumber, name: line.name, said: saidLang });
      } else if (code !== matched.lang) {
        languageMismatches.push({
          lineNumber: line.lineNumber,
          name: line.name,
          said: code,
          used: matched.lang,
        });
      }
    }

    // The file's own word wins; `options` fills the silence. `normalizeCondition` folds the
    // EU scale into the NA one and hands back what the file actually said, which is exactly
    // what `conditionOriginal` is for — and it answers `original: null` for silence, where
    // `CollectionImportItem`'s optional fields answer `undefined`, so the `?? undefined` below
    // is the one seam between the two.
    //
    // **A blank cell is the dialog's answer, not the function's, and the two agree by accident
    // rather than by construction.** `normalizeCondition("")` answers `NONE` with
    // `matched: true`, so if a blank ever reached it the *function's* fallback would win and
    // `options.condition` would be skipped — but one never does: `parseCsvGrid` trims every cell
    // and only puts a non-empty one into `extra`, so silence arrives here as `undefined` and
    // takes the `null` branch below. Since schema v35 both roads end at `NONE` when the reader
    // has not touched the dropdown, which is exactly why this is worth writing down: the
    // difference is invisible today and is one edit to `parse.ts` away from being visible again.
    // **The dropdown wins.**
    const said = line.extra.condition;
    const normalized = said === undefined ? null : normalizeCondition(said);
    // `matched: false` is a grade this app does not recognise — flagged for the reader rather
    // than filed as though the file had said nothing. An unreadable grade then falls back to the
    // reader's own chosen default, the same as silence does: "the condition when the file
    // doesn't say" is exactly what an unreadable one amounts to, and a reader who set that
    // dropdown to `LP` meant it for these lines too.
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
    const altered = flagOf(line.extra.altered, ["altered", "alter"]);
    const signed = flagOf(line.extra.signed, ["signed"]);
    const proxy = flagOf(line.extra.proxy, ["proxy"]);
    const misprint = flagOf(line.extra.misprint, ["misprint"]);
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

    // Every refusal is read before the fold, so a refused cell is said whichever line of a
    // folded pair it sat on.
    const saidPrice = textOrUndefined(line.extra.purchasePrice);
    const purchasePrice = saidPrice === undefined ? undefined : parsePurchasePrice(saidPrice);
    if (saidPrice !== undefined && purchasePrice === undefined) {
      unreadablePrices.push({ lineNumber: line.lineNumber, name: line.name, said: saidPrice });
    }
    const saidTradelist = textOrUndefined(line.extra.tradelistQuantity);
    const tradelist = saidTradelist === undefined ? undefined : wholeNumber(saidTradelist);
    if (saidTradelist !== undefined && tradelist === undefined) {
      unreadableTradelists.push({
        lineNumber: line.lineNumber,
        name: line.name,
        said: saidTradelist,
      });
    }
    const currency = textOrUndefined(line.extra.purchaseCurrency);
    const tags = tagsOf(line.extra.tags);
    const notes = textOrUndefined(line.extra.notes);
    const source = textOrUndefined(line.extra.acquisitionSource);
    const acquiredAt = textOrUndefined(line.extra.acquiredAt);

    const seen = pending.get(key);
    if (seen === undefined) {
      pending.set(key, {
        into: line.lineNumber,
        item: {
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
        },
        tradelist,
        tags,
        notes: notes === undefined ? [] : [notes],
        sources: source === undefined ? [] : [source],
        acquiredAt,
        price:
          purchasePrice === undefined
            ? undefined
            : {
                currency,
                sum: purchasePrice * line.quantity,
                copies: line.quantity,
                decimals: decimalsOf(purchasePrice),
              },
        currency,
      });
      return;
    }

    // **A second line at one grain is the same copy described twice, and every column of it is
    // merged rather than the first line's kept.** Counts add; words that are about the copy
    // (notes, where it came from, its tags) are combined without repeating themselves; the date
    // is the earliest, because a copy acquired in two batches was first acquired at the first;
    // and the price is what the copies cost on average — a mean weighted by how many each line
    // bought, over the lines that said, which is the one figure that keeps the row's total
    // spend what the file's lines add up to.
    folded.push({ lineNumber: line.lineNumber, into: seen.into, name: line.name });
    seen.item.quantity += line.quantity;
    if (tradelist !== undefined) seen.tradelist = (seen.tradelist ?? 0) + tradelist;
    if (tags !== undefined) seen.tags = distinct([...(seen.tags ?? []), ...tags]);
    if (notes !== undefined && !seen.notes.includes(notes)) seen.notes.push(notes);
    if (source !== undefined && !seen.sources.includes(source)) seen.sources.push(source);
    seen.acquiredAt = earlier(seen.acquiredAt, acquiredAt);
    seen.currency ??= currency;
    if (purchasePrice !== undefined) {
      if (seen.price === undefined) {
        seen.price = {
          currency,
          sum: purchasePrice * line.quantity,
          copies: line.quantity,
          decimals: decimalsOf(purchasePrice),
        };
      } else if (sameCurrency(seen.price.currency, currency)) {
        seen.price.sum += purchasePrice * line.quantity;
        seen.price.copies += line.quantity;
        seen.price.decimals = Math.max(seen.price.decimals, decimalsOf(purchasePrice));
      } else {
        droppedPrices.push({
          lineNumber: line.lineNumber,
          into: seen.into,
          name: line.name,
          said: saidPrice ?? "",
          currency,
          kept: seen.price.currency,
        });
      }
    }
  });

  const items = [...pending.values()].map(settle);
  return {
    items,
    unmatched,
    hintMisses,
    unknownConditions,
    unreadablePrices,
    unreadableTradelists,
    unknownLanguages,
    languageMismatches,
    folded,
    droppedPrices,
    parseIssues: list.issues,
    totalCards: items.reduce((n, i) => n + i.quantity, 0),
  };
}

/**
 * A copy's lines, read to the end, as the one item the commit takes.
 *
 * **Every merged field is `undefined` when no line said anything**, never an empty string or an
 * empty list: `CollectionImportItem`'s optional fields read absent as "the file said nothing",
 * which an `add` leaves the row's own value alone for. The one exception is an explicit `[]` in
 * the `Tags` column — see {@link tagsOf}.
 */
function settle(p: Pending): CollectionImportItem {
  return {
    ...p.item,
    tradelistQuantity: p.tradelist,
    tags: p.tags === undefined ? undefined : JSON.stringify(p.tags),
    notes: joined(p.notes),
    acquisitionSource: joined(p.sources),
    acquiredAt: p.acquiredAt,
    purchasePrice: p.price === undefined ? undefined : meanOf(p.price),
    // A priced copy's currency is its price's, full stop — a currency some *unpriced* line named
    // is not allowed to relabel a price another line wrote without one.
    purchaseCurrency: p.price === undefined ? p.currency : p.price.currency,
  };
}

/**
 * The weighted mean, rounded to the most decimals any contributing price was written with — and
 * never fewer than cents.
 *
 * **Rounded, because the mean of three prices is usually a repeating decimal**, and
 * `1.6666666666666667` stored as what the reader paid is a figure nobody wrote and every later
 * export would carry. **To the file's own precision rather than to cents**, because this app's
 * CSV writes a recorded `1.2345` as `1.2345` (`priceText`) and a restore that rounded it to
 * `1.23` would be the restore losing something. A single line's price, or two lines at one
 * price, therefore come back exactly as written: rounding at a precision at least the input's
 * own undoes the float noise `sum / copies` adds and nothing else.
 */
function meanOf(price: PriceMean): number {
  const scale = 10 ** Math.max(2, price.decimals);
  return Math.round((price.sum / price.copies) * scale) / scale;
}

/** How many decimals a parsed price carries, capped — a price that prints in exponent form is
 *  either vanishingly small or absurd, and ten places covers every figure a file can mean. */
function decimalsOf(n: number): number {
  const text = String(n);
  if (text.includes("e")) return 10;
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : Math.min(10, text.length - dot - 1);
}

/** Currencies compare as codes, so `eur` and `EUR` are one; an absent one only matches another
 *  absent one — see {@link DroppedPrice}. */
function sameCurrency(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toUpperCase() === (b ?? "").toUpperCase();
}

/**
 * The earlier of two `Acquired` cells.
 *
 * **Compared as text when both are ISO dates**, which is what this app writes and what sorts
 * correctly as a string (and keeps `2024-03-01` and `2024-03-01T12:00` in their honest order);
 * as `Date.parse` values when both parse otherwise; and **the first one kept when either will
 * not parse**. Another app's `03/04/2024` is a date whose day and month nobody can tell apart,
 * and picking one of two unreadable dates by guessing is worse than keeping the one the file
 * wrote first.
 */
function earlier(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (ISO_DATE.test(a) && ISO_DATE.test(b)) return b < a ? b : a;
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isFinite(at) && Number.isFinite(bt)) return bt < at ? b : a;
  return a;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Distinct texts joined the way two notes read as one — `undefined` for none. */
function joined(texts: readonly string[]): string | undefined {
  return texts.length === 0 ? undefined : texts.join("; ");
}

/**
 * A `Tags` cell as a list — trimmed, non-empty, distinct, in the file's order.
 *
 * **Two spellings arrive, and both are read.** This app's own export writes the column's JSON
 * verbatim (`["cube","trade"]`, since `collection_entries.tags` is `CHECK (json_valid(tags))`);
 * every other app writes words, `cube, trade` or `cube; trade`. A cell that opens with `[` and
 * parses as a JSON array is the first; anything else — including a `[` that does not parse — is
 * split on commas and semicolons. A JSON tag with a comma in it therefore survives this app's
 * own round trip, which is the one that has to be lossless.
 *
 * **A blank cell is `undefined` and an explicit `[]` is an empty list**, and the difference is
 * deliberate. A blank is another app with nothing in the column — silence, which never touches a
 * row's tags. `[]` is this app's own export saying *this row has no tags*, which under `set` is
 * what a restore should make true and under `add` unions to nothing. A cell of bare separators
 * (`,`) names no tag and no list either, so it is silence too.
 *
 * Distinct **exactly**, not case-folded: the backend's union is over the JSON strings, and two
 * rules for what counts as one tag would be a preview that disagrees with the write.
 */
function tagsOf(raw: string | undefined): string[] | undefined {
  const cleaned = (raw ?? "").trim();
  if (cleaned === "") return undefined;
  if (cleaned.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return distinct(parsed.filter((tag): tag is string => typeof tag === "string"));
      }
    } catch {
      // Not JSON after all — read as words, below.
    }
  }
  const words = distinct(cleaned.split(/[,;]/));
  return words.length === 0 ? undefined : words;
}

function distinct(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    const tag = word.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** A whole number of copies, or `undefined` — digits only, so `2.0`, `-1` and `1e3` are all
 *  refused rather than read as something the file did not write. */
function wholeNumber(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
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
 *   it named" — so two lines resolving to one printing can never differ in it. A CSV's
 *   `Language` column acts **before** this runs, as the resolver's preference for which printing
 *   a line gets (issue #555); by the time a line reaches the key its language is its printing's,
 *   and where the two disagree the plan's `languageMismatches` says so.
 * - **`folderId` is a constant *per commit*, and it is never a property of an item.**
 *   `CollectionImportItem` has no such field; `collection_import_commit` takes the folder as an
 *   argument of its own and files the whole file into it. So the term is constant across every
 *   item this planner folds, and a constant term partitions nothing — leaving it out costs the
 *   key nothing, whichever folder the press names. What it *does* mean is that an import can
 *   never land on a row filed somewhere else: that row's grain has an eleventh term this one
 *   does not share, so it is a different row, exactly as an altered copy is. That is the folder
 *   grain working, not this fold failing — and since issue #555 a `set` counts those filed
 *   copies toward the file's number anyway (`ImportCommitOutcome.leftInFolders`).
 *
 *   **Which folder is the caller's decision and is made after this runs.** A file says nothing
 *   about a reader's filing, so the collection's own import step names none and its rows land at
 *   the root. The **deck** arms' "Add cards to collection" box says *these copies are in this
 *   deck*, so `useImport` sends that deck's `collection_folders` group — the decklist and the
 *   group agree the moment the dialog closes, and no other deck can claim the copies.
 *   `DeckPreview`'s `OWN_COPIES_HINT` is where the reader is told the second half.
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

/** What `TRANSFER_FIELDS`' own writer and a spreadsheet's hand both mean by yes. */
const YES = new Set(["yes", "y", "true", "t", "1"]);

/**
 * One of the four boolean grain columns, read out of a cell.
 *
 * `TRANSFER_FIELDS`' own writer emits `yes`/`no`/`""`, so `yes` is the answer this has to know;
 * the rest of the vocabulary is here because **import is permissive and export is canonical** —
 * a file a reader edited in a spreadsheet says `TRUE`, and one another tool wrote says `1`.
 *
 * **`own` is the column's own word, and a cell that says it is a yes** (issue #555). Deckbox
 * writes `signed` in its Signed column, `altered` in Altered and `misprint` in Misprint — a flag
 * column whose only non-empty value is its own name — and every such copy used to import as the
 * plain one, which on the grain is a different row. Only the column's *own* word counts: `signed`
 * in the Altered column is nothing anybody said about an alteration.
 *
 * **Anything else is `false`, and silence is `false`.** The column is `INTEGER NOT NULL DEFAULT
 * 0`: a card is altered or it is not, so there is no third state to carry and nothing for an
 * `unknownConditions`-style warning row to be about. That is the one place this is looser than
 * the condition reader beside it, and the difference is the column's rather than a choice —
 * a grade this app cannot read could have been any of five, and a flag it cannot read is a
 * card nobody said anything true about.
 */
function flagOf(raw: string | undefined, own: readonly string[]): boolean {
  const cleaned = (raw ?? "").trim().toLowerCase();
  return YES.has(cleaned) || own.includes(cleaned);
}

/** A free-text cell — trimmed, and blank read as absent. An empty `Serial number` column
 *  is a card with no serial, which is the same row as one whose file had no such column at all;
 *  `""` and `undefined` must not be two grains. */
function textOrUndefined(raw: string | undefined): string | undefined {
  const cleaned = (raw ?? "").trim();
  return cleaned === "" ? undefined : cleaned;
}

/** The printing a line was answered with, as a card prints it — `deck.ts`'s own `printingOf`,
 *  copied rather than imported: it is one line, and importing it would reach into a file whose
 *  own doc says it decides deck questions and nothing past that. */
function printingOf(match: { setCode: string; collectorNumber: string }): string {
  return `${match.setCode.toUpperCase()} ${match.collectorNumber}`;
}
