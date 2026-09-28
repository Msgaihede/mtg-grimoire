/**
 * A decklist as text, read into lines this app can act on.
 *
 * One parser for every shape people paste — plain lists, Moxfield, Archidekt, Arena, MTGO —
 * because they overlap almost entirely and a format *detector* would be a second thing to be
 * wrong: it would have to choose a reader before it had read anything, and it would be wrong
 * about exactly the lists that have been edited by hand. Every rule here is a **per-line**
 * rule for that reason, so an unfamiliar mixture is read line by line rather than refused
 * whole, and no line's reading depends on a verdict about the file — **with one exception.** A
 * CSV header is the single file-level judgement this parser makes ({@link csvHeaderOf}), and it
 * is made on the header row alone, checked against the row after it for shape
 * ({@link csvShapeAgrees}) before anything is trusted. Every other file is still read line by
 * line exactly as before, and a first row that turns out not to be a header — by content or by
 * shape — changes nothing about how the rest of the file is read.
 *
 * It knows nothing about cards. A name is a string, and whether any card bears it is
 * `import_resolve`'s question — which is what keeps this file pure TypeScript with no
 * IPC in it, and what stops it rejecting a card printed after the last sync.
 *
 * **Nothing is ever silently dropped.** A line this cannot read becomes a {@link ParseIssue}
 * carrying its number and its raw text so the preview can quote it back, and one bad line
 * never aborts the parse. The only lines that leave no trace are the ones making no claim —
 * blanks and comments.
 */
// `readCsv` is a value import — the only non-type one here — and it is still text in, data
// out: no React, no hook, no IPC, which is what lets `parse.test.ts` drive every rule as a pure
// function.
import type { DeckFinish } from "@/lib/ipc";
import { readCsv, type CsvDelimiter, type CsvRecord } from "../csv";
import { TRANSFER_FIELDS, TRANSFER_FIELD_IDS, type TransferFieldId } from "../fields";

/**
 * How strongly a header claims its field. **Lower wins** when two columns of one file name the
 * same field, and the loser is read by nothing and listed in {@link CsvShape.ignoredColumns}.
 *
 * * `SPECIFIC` — a header that can only mean the one thing, and outranks even this app's own
 *   spelling because that spelling is the ambiguous one. `Set` is a set **code** in this app's
 *   CSV and in MTGO's, and a set **name** in TCGplayer's, which writes the code beside it as `Set
 *   Code`; `Name` is TCGplayer's product title, `Accursed Marauder (Retro Frame)` on 111 of one
 *   real export's 1,010 rows, where `Simple Name` beside it is the card.
 * * `REGISTRY` — the registry's own `csvHeader`, and the legacy aliases, which are what an older
 *   build of this app wrote. A file this app wrote says these words.
 * * `ALIAS` — a vendor's word for a field it names outright (`Count`, `Card Name`, `Foil`).
 * * `FALLBACK` — a vendor's word that names the field in one export and something else in the
 *   next. There is one: `Edition`, a set code in Moxfield's export and a set **name** in
 *   Deckbox's — which writes the code beside it as `Edition Code`, so the fallback is only ever
 *   read in a file with no better column.
 */
const SPECIFIC = 0;
const REGISTRY = 1;
const ALIAS = 2;
const FALLBACK = 3;

/** One header, read: the field it names and how strongly. */
interface HeaderCell {
  field: TransferFieldId;
  rank: number;
}

/**
 * What an **older build** called two of these columns. A read path and nothing else.
 *
 * The deck's label column was `Tag`, and its colour `Tag colour`, until the rename — so every
 * deck CSV written before it says those words. With the registry's own header now `Label` those
 * columns would map to nothing at all, and the reader would get their cards back with the
 * labels quietly stripped: a round trip that drops a fact and says nothing, which is the one
 * failure `decklists.test.ts`' fixed point exists to make impossible.
 *
 * **Nothing writes `Tag` any more**, so this table can only ever grow by another rename, never
 * by a format gaining a channel — which is what keeps it from becoming a second registry.
 *
 * **It cannot shadow the collection's `Tags`**, which is a different fact and keeps its name.
 * {@link normalizeHeader} lowercases and collapses runs of whitespace and does nothing else, so
 * `tag` and `tags` are two keys and always were — and the aliases are laid down *first* below,
 * so a real header would win the key even if one ever spelled itself the same way.
 */
const LEGACY_CSV_HEADERS: readonly (readonly [string, TransferFieldId])[] = [
  ["Tag", "label"],
  ["Tag colour", "labelColor"],
];

/**
 * What **other apps** call the columns this one reads (issue #555) — the reason a Moxfield,
 * Deckbox or ManaBox export is a restore and not a refusal.
 *
 * Every spelling here was read off a real export or the vendor's own list, never guessed from
 * the field's name: the research doc's verbatim headers
 * (`docs/superpowers/research/2026-08-04-mtg-domain-rules.md`, "Collection CSV headers"), checked
 * on 2026-09-28 against real exports of Moxfield, Deckbox, ManaBox, Archidekt, Dragon Shield,
 * TCGplayer, MTGO, MTGGoldfish and TopDecked. `Qty`, `Number` and `CN` are the three generic
 * spellings with no vendor behind them — a hand-made sheet's words for the same columns.
 *
 * **What is deliberately absent, and why.** A column left out here is not dropped: it is named in
 * the preview's "Not read" line ({@link CsvShape.ignoredColumns}).
 *
 * * **Deckbox's `My Price` is not a purchase price.** Deckbox's own CSV instructions call it
 *   "only used for seller accounts": it is the asking price a Deckbox Market seller lists a
 *   tradelist card at, set relative to Deckbox's market price — what the reader wants for the
 *   card, not what they paid. Filing it under `Purchase price` would put a sale price into the
 *   one column this app keeps for cost, where it would read as a fact about the past.
 * * **Archidekt's `Date Added` is not `Acquired`.** It is the day the row entered Archidekt,
 *   which for anybody who imported a collection is one date on every row.
 * * **`Scryfall ID`** is the most exact column any of these files carries and the resolver has
 *   no channel for it yet; it is listed like any other.
 * * **Cardmarket's export names no card at all** (`idProduct;groupCount;…`) — it is the file the
 *   "no column names the card" sentence is for.
 */
const THIRD_PARTY_CSV_HEADERS: readonly (readonly [string, TransferFieldId, number])[] = [
  // Moxfield and Deckbox; the generic spelling.
  ["Count", "quantity", ALIAS],
  ["Qty", "quantity", ALIAS],
  // Dragon Shield and MTGO; MTGGoldfish; TCGplayer (see SPECIFIC above).
  ["Card Name", "name", ALIAS],
  ["Card", "name", ALIAS],
  ["Simple Name", "name", SPECIFIC],
  // ManaBox, Dragon Shield, TCGplayer; Deckbox and Archidekt; MTGGoldfish; TopDecked.
  ["Set Code", "setCode", SPECIFIC],
  ["Edition Code", "setCode", SPECIFIC],
  ["Set ID", "setCode", SPECIFIC],
  ["Setcode", "setCode", SPECIFIC],
  ["Edition", "setCode", FALLBACK],
  // Archidekt; TopDecked. A set name is a set hint only in a file with no code column at all —
  // see `setHintColumn`.
  ["Edition Name", "setName", ALIAS],
  ["Setname", "setName", ALIAS],
  // Deckbox, Dragon Shield, TCGplayer; MTGO; the two generic spellings.
  ["Card Number", "collectorNumber", ALIAS],
  ["Collector #", "collectorNumber", ALIAS],
  ["Number", "collectorNumber", ALIAS],
  ["CN", "collectorNumber", ALIAS],
  // Moxfield, Deckbox, ManaBox, MTGGoldfish; TCGplayer and Dragon Shield; MTGO. Their values are
  // read by `csvFinish`, which is what makes `Double Rainbow Foil` and MTGO's `Yes` a finish.
  ["Foil", "finish", ALIAS],
  ["Printing", "finish", ALIAS],
  ["Premium", "finish", ALIAS],
  // TopDecked.
  ["Lang", "lang", ALIAS],
  // Moxfield and Deckbox; Dragon Shield.
  ["Tradelist Count", "tradelistQuantity", ALIAS],
  ["Trade Quantity", "tradelistQuantity", ALIAS],
  // Moxfield; Deckbox.
  ["Alter", "altered", ALIAS],
  ["Altered Art", "altered", ALIAS],
  // Dragon Shield; TopDecked.
  ["Price Bought", "purchasePrice", ALIAS],
  ["Acquired price", "purchasePrice", ALIAS],
  ["Date Bought", "acquiredAt", ALIAS],
  ["Acquired date", "acquiredAt", ALIAS],
  // ManaBox.
  ["Purchase price currency", "purchaseCurrency", ALIAS],
];

/**
 * A CSV header maps to field ids by `csvHeader`, case- and space-insensitively.
 *
 * Built from the registry rather than written out, so a field added there is readable back
 * without a second edit here — which is the whole reason the registry carries a `csvHeader` at
 * all rather than the writer spelling one inline. {@link LEGACY_CSV_HEADERS} is laid over it for
 * the one thing a table derived from today's names cannot say: what yesterday's called a column,
 * and {@link THIRD_PARTY_CSV_HEADERS} for what everybody else calls one.
 *
 * **The aliases go in first on purpose.** `Map`'s constructor keeps the *last* entry for a
 * repeated key, so a registry header always beats an alias spelled the same way — a third-party
 * spelling can add a key and can never take one this app writes.
 */
const HEADER_TO_FIELD = new Map<string, HeaderCell>([
  ...THIRD_PARTY_CSV_HEADERS.map(
    ([header, field, rank]) => [normalizeHeader(header), { field, rank }] as const,
  ),
  ...LEGACY_CSV_HEADERS.map(
    ([header, field]) => [normalizeHeader(header), { field, rank: REGISTRY }] as const,
  ),
  ...TRANSFER_FIELD_IDS.map(
    (field) =>
      [normalizeHeader(TRANSFER_FIELDS[field].csvHeader), { field, rank: REGISTRY }] as const,
  ),
]);

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Is the first row a header?
 *
 * **Two known columns, one of which is the name.** One is not enough: a plain list whose first
 * card happens to be called `Name` would otherwise be read as a header over a nameless file.
 *
 * `null` entries are kept rather than filtered — the caller needs each field's **position**, not
 * just which fields were found, to read every later row by column.
 *
 * **This test alone is not sufficient**, and the caller does not treat a match here as the whole
 * verdict — see {@link csvShapeAgrees}. `"Quantity, Name\n1 Sol Ring\n"` matches this test on its
 * own: `parseCsv` splits the first line into two cells that both name a known column. It is not a
 * CSV, and what tells the two apart is not this function's business — it answers only "does the
 * first row's *content* look like a header", the same question it always asked.
 */
function csvHeaderOf(row: readonly string[]): (HeaderCell | null)[] | null {
  if (row.length < 2) return null;
  const mapped = row.map((cell) => HEADER_TO_FIELD.get(normalizeHeader(cell)) ?? null);
  const known = mapped.filter((cell) => cell !== null).map((cell) => cell.field);
  if (known.length < 2) return null;
  if (!known.includes("name")) return null;
  return mapped;
}

/**
 * Fields a column can name that **no importer reads**, so a file carrying one is told so.
 *
 * All four are facts about the *card*, which the resolver answers from the corpus rather than
 * from the file: `Rarity`, `Type line` and `Price` are columns this app writes for a reader's
 * spreadsheet and never takes back, and `Set name` is read only when it is standing in for a set
 * code (see {@link setHintColumn}) — beside a code column it says nothing the code does not.
 * Every other field in the registry is read by at least one of the four destinations.
 */
const UNREAD_FIELDS: ReadonlySet<TransferFieldId> = new Set([
  "rarity",
  "typeLine",
  "unitPrice",
  "setName",
]);

/**
 * Which column each field is read from: **the lowest {@link HeaderCell.rank}**, and the leftmost
 * of equals. A Deckbox export names the set twice — `Edition` (`The Lord of the Rings: Tales of
 * Middle-earth`) and `Edition Code` (`ltr`) — and reading the first column that happened to map
 * would hand the resolver a set name where the file had a code two cells over.
 */
function columnsOf(header: readonly (HeaderCell | null)[]): Map<TransferFieldId, number> {
  const at = new Map<TransferFieldId, number>();
  header.forEach((cell, index) => {
    if (cell === null) return;
    const held = at.get(cell.field);
    if (held === undefined || cell.rank < header[held]!.rank) at.set(cell.field, index);
  });
  return at;
}

/**
 * The column a row's set hint is read from, and whether it holds a **name** rather than a code.
 *
 * A code column wins whenever the file has one, whatever a given row holds in it. Only a file
 * with **no code column at all** — no `Set`, `Set Code`, `Edition Code`, `Set ID`, `Setcode` or
 * `Edition` — lends its `Set name` column to the hint, and `import_resolve` answers a hint that
 * names no set code by reading it as a set's name. A per-row fallback was the alternative and is
 * not taken: a file that has a code column and leaves a cell of it blank has said "no printing"
 * for that row, and a name in the next column over is decoration it never meant as a hint.
 */
function setHintColumn(
  at: ReadonlyMap<TransferFieldId, number>,
): { column: number; isName: boolean } | null {
  const code = at.get("setCode");
  if (code !== undefined) return { column: code, isName: false };
  const name = at.get("setName");
  return name === undefined ? null : { column: name, isName: true };
}

/**
 * What a CSV import did **not** read, for the preview to say so (issue #555).
 *
 * `null` or absent on a {@link ParsedList} that was not read as a CSV — optional rather than
 * required so that every hand-built `ParsedList` in the suite and the workbench is still one.
 */
export interface CsvShape {
  /** What separated the cells — a comma, or Excel's EU semicolon, or a tab. */
  delimiter: CsvDelimiter;
  /**
   * Header cells, **as the file spelled them**, whose columns nothing reads: a column no field
   * answers to (`Scryfall ID`, `My Price`), a column naming a field no importer reads
   * ({@link UNREAD_FIELDS}), and a column that lost its field to a more specific one
   * ({@link columnsOf} — Deckbox's `Edition`, beside `Edition Code`). In file order, each name
   * once, blanks left out — a column with no header has no name to list it by.
   */
  ignoredColumns: string[];
  /** Whether a column names the count. Without one every row is read as a single copy, which is
   *  right for a list of cards and wrong for an inventory — so the preview says so. */
  hasQuantity: boolean;
}

/** The {@link CsvShape} of a file whose header has been read. */
function shapeOf(
  header: readonly string[],
  mapped: readonly (HeaderCell | null)[],
  at: ReadonlyMap<TransferFieldId, number>,
  hint: { column: number; isName: boolean } | null,
  delimiter: CsvDelimiter,
): CsvShape {
  const ignored: string[] = [];
  header.forEach((raw, index) => {
    const name = raw.trim();
    if (name === "" || ignored.includes(name)) return;
    const cell = mapped[index];
    const read =
      cell !== null &&
      at.get(cell.field) === index &&
      (!UNREAD_FIELDS.has(cell.field) || (hint !== null && hint.isName && hint.column === index));
    if (!read) ignored.push(name);
  });
  return { delimiter, ignoredColumns: ignored, hasQuantity: at.has("quantity") };
}

/**
 * Cells in a finish column that are the **regular** copy — blank among them. Checked before any
 * foil word, because `nonfoil` and `non-foil` both contain one.
 */
const NOT_FOIL = /^(?:|normal|regular|non ?-?foil|not foil|no|n|false|0)$/;

/** Whole cells that mean "foil" in a column that is only asking whether a card is: MTGO's
 *  `Premium` writes `Yes`, a hand-made sheet a tick. */
const FOIL_WORDS = /^(?:foil|yes|y|true|1|x)$/;

/**
 * A finish-like cell — `Finish`, `Foil`, `Printing`, `Premium` — as the finish it names.
 *
 * **Anything containing `etched` is etched, and anything else containing `foil` is foil**,
 * which is the rule every real export agrees with: Dragon Shield's `Printing` writes the
 * treatment's own name (`Double Rainbow Foil`, `Gilded Foil`, `Rainbow Foil` on a real export),
 * MTGGoldfish writes `foil_etched`, and a treatment is a *printing* family while the finish is
 * what the copy is (`src/CLAUDE.md`: a Surge Foil is foil). Etched is asked first because
 * `Foil Etched` contains both words.
 *
 * **A word this reads as neither is the regular copy**, and that is the one cell in a CSV whose
 * unrecognised value lands as a default rather than an issue: refusing the whole row over a
 * finish word would cost the reader the card to save them a treatment, and the preview shows
 * every row's finish before anything is written.
 */
function csvFinish(raw: string): DeckFinish {
  const word = raw.trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (NOT_FOIL.test(word)) return null;
  if (word.includes("etched")) return "etched";
  if (FOIL_WORDS.test(word) || word.includes("foil")) return "foil";
  return null;
}

/** The ceiling on one row's count — the per-line reader's own, whose `qty` group is four digits.
 *  A CSV that could say more than a decklist can would be the one door a typo walks through. */
const MAX_COPIES = 9999;

/**
 * A quantity cell, **strictly**: a whole number from 1 to {@link MAX_COPIES}, or the sentence
 * that says why not.
 *
 * `Number.parseInt` was the reader until issue #555 and it reads a prefix — `1.5` was one copy,
 * `3 copies` three, and neither said anything. A count is the one cell whose misreading changes
 * how many cards the reader owns, so it is the one cell read this strictly; the price and date
 * columns are the planner's to read, and each has its own refusal there.
 *
 * A **blank** cell is one copy, as a file with no count column at all is — the same silence, in
 * a narrower place.
 */
function csvQuantity(cell: string): number | string {
  if (cell === "") return 1;
  if (!/^\d+$/.test(cell)) return `\`${cell}\` is not a whole number of copies`;
  const quantity = Number(cell);
  // The per-line reader's own sentence, so one refusal reads one way whichever reader made it.
  if (quantity === 0) return "A count of zero is not an import.";
  if (quantity > MAX_COPIES) {
    return `\`${cell}\` is more than the ${MAX_COPIES} copies one row can hold`;
  }
  return quantity;
}

/**
 * Does the grid's shape agree with treating its first row as a header?
 *
 * A header match by content is not enough, because a plain decklist line can satisfy it by
 * accident: `parseCsv("Quantity, Name")` splits on the one comma into two cells that both name a
 * known column, and `csvHeaderOf` cannot tell that line apart from a real header by content
 * alone. What actually distinguishes the two is **shape** — a real CSV's first data row has the
 * same field count as its header, because every row came off the same grid; a decklist line that
 * merely happens to contain a comma did not.
 *
 * A header with no data row at all (`grid.length === 1`) still counts as agreeing: an empty
 * spreadsheet is an empty import, which is the more sensible reading of a file that is one line
 * naming known columns and nothing else — the alternative is a card called `Quantity,Name`.
 */
function csvShapeAgrees(grid: readonly string[][]): boolean {
  return grid.length === 1 || grid[1].length === grid[0].length;
}

/** Two or more known column names, whatever they are — the test `csvHeaderOf` makes before it
 *  insists on a name. */
function nearlyAHeader(row: readonly string[]): boolean {
  if (row.length < 2) return false;
  return row.filter((cell) => HEADER_TO_FIELD.has(normalizeHeader(cell))).length >= 2;
}

/**
 * Which of the deck's four zones a line is in — **the fixed word the rules read**, beside
 * {@link ParsedLine.categoryName}, which is the name the user (or their exporter) gave a pile.
 *
 * That is `deck_categories`' own distinction — the name is the reader's and the kind is what the
 * engine sizes a deck by — applied to a parsed line, and the rename from `Section` is what says
 * so. The starting value is `deck`, which is what makes a list with no headings at all read as a
 * deck rather than as nothing.
 */
export type SectionKind = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";

/** One line that named a card. */
export interface ParsedLine {
  /**
   * 1-based, counted over **every** line including the blanks — it is what the preview quotes.
   * A CSV row's is the physical line it **starts** on (`csv.ts`' `CsvRecord.line`), so a note
   * cell written in two paragraphs does not push every later row's number one line short.
   */
  lineNumber: number;
  /** The line exactly as it arrived, untrimmed, so a quoted line looks like what was pasted. A
   *  CSV row's is the row's own text, quotes and separators included — every line of it. */
  raw: string;
  /** Always ≥ 1. A count of zero is a {@link ParseIssue}, never a line. */
  quantity: number;
  name: string;
  /**
   * Uppercased — `(ltc)` and `(LTC)` are the same set and only one of them is a set code.
   *
   * **The one exception is a CSV with no code column**, whose `Set name` column is lent to this
   * hint verbatim (`Throne of Eldraine`): a name is not a code, capitals and all, and the
   * resolver reads a hint that names no set code as a set's name.
   */
  setCode: string | null;
  /** Verbatim. Collector numbers are TEXT (`123★`, `A-45`, `285`), so nothing is parsed out. */
  collectorNumber: string | null;
  section: SectionKind;
  /**
   * The pile the **file** named for this line, or `null` when it named none.
   *
   * A bracket's first entry, else the name of an unknown section heading. It is `null` whenever
   * `section` is not `"deck"`, and that invariant is the whole of what keeps `plan.ts`'s
   * precedence chain three rungs rather than four: a heading or a bracket naming one of the four
   * seeded zones sets the *section*, and only a name the section vocabulary has never heard of
   * lands here.
   */
  categoryName: string | null;
  /**
   * Which object the file said this line is — the `*F*` / `*E*` marker, `null` for the regular
   * copy. Carried since 2026-08-17; it used to be stripped and discarded.
   *
   * **`[Foil]` in a bracket is still decoration and never reaches this**, which looks like an
   * inconsistency and is not. A bracket is the *category* channel: a finish that arrived there
   * is an exporter being loose with a field, while `*F*` is the channel every format that says
   * anything about a finish agrees on. Reading the bracket would also mean deciding, for every
   * word in it, whether it is a pile or a treatment — which is the format detector this file
   * exists without.
   */
  finish: DeckFinish;
  /** The file said this card counts toward nothing — Archidekt's `{noDeck}`, which is this app's
   *  `is_active = 0`. */
  excluded: boolean;
  /**
   * The label the file put on this card — Archidekt's `^Keeper,#4aab08^`, name half. `null` for a
   * line carrying none, which is every line of every other format this reads.
   *
   * **Verbatim, including its capitals**, because `deck_labels.name` keeps whatever capitals the
   * reader chose and this is a reader's word arriving from somewhere else. Whether it is the
   * *same* label as one they already have is `labelNameKey`'s question, asked in the planner and
   * again — authoritatively — by the UNIQUE index behind `deck_labels.name_key`.
   */
  labelName: string | null;
  /**
   * That label's colour as `#rrggbb` lowercase, or `null` when the group carried none.
   *
   * **It is a suggestion and not a fact about the card**, which is the whole of what separates
   * this field from {@link finish}: the colour is used only if this app has never heard of the
   * name, and a label the reader already owns keeps the colour they gave it. That rule is
   * enforced in `commit_import`, where the find-or-create is, and it is the same rule
   * {@link excluded} obeys one channel over.
   */
  labelColor: string | null;
  /** Every column a CSV named that this app recognises, verbatim. `{}` for every other format —
   *  a decklist line has no channel for a condition or a purchase price. */
  extra: Partial<Record<TransferFieldId, string>>;
}

/** A line that named nothing this could import, kept so the preview can show it. */
export interface ParseIssue {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface ParsedList {
  lines: ParsedLine[];
  issues: ParseIssue[];
  /** The sum of every line's `quantity` — cards, not lines. */
  totalCards: number;
  /** Arena's `Name <x>` from under its `About` block, and nothing else names a deck. */
  suggestedName: string | null;
  /**
   * How a CSV was read — its separator, the columns nothing read, whether it counted copies —
   * for `shared/CsvNotes` to say in a line or two. **Absent or `null` means the text was not
   * read as a CSV**, which is every decklist and every file whose header this did not trust.
   */
  csv?: CsvShape | null;
}

/**
 * Every spelling of a section heading this reads, lowercased and already stripped of a
 * trailing count or colon by {@link sectionFor}.
 *
 * A `Map` and not an object literal, which is not taste: a plain object answers `toString`
 * and `constructor` off `Object.prototype`, so a lookup of either would come back truthy and
 * switch the current section to a function — after which every remaining line is filed
 * somewhere no reader can name and nothing on screen says why.
 *
 * `deck` has five spellings because the sites that export decklists have never agreed on one.
 * They are listed rather than normalised: a rule that folded `main deck` into `maindeck` by
 * deleting spaces would be a rule about every heading, including the ones added later.
 */
const SECTIONS = new Map<string, SectionKind>([
  ["deck", "deck"],
  ["main", "deck"],
  ["maindeck", "deck"],
  ["mainboard", "deck"],
  ["main deck", "deck"],
  ["commander", "commander"],
  ["commanders", "commander"],
  ["sideboard", "sideboard"],
  ["sb", "sideboard"],
  ["companion", "companion"],
  ["maybeboard", "maybeboard"],
  ["maybe", "maybeboard"],
  ["considering", "maybeboard"],
]);

/**
 * A count, a name and an optional printing, in one pass. Groups: `qty`, `name`, `set`, `cn`.
 *
 * `name` is **lazy** and the printing hint is anchored to the end of the line, which is the
 * whole reason `Erase (Not the Urza's Legacy One)` keeps its parentheses: a set code is 1–10
 * word characters closed by `)`, followed by either the end of the line or one unspaced
 * collector number — so a parenthesised phrase containing spaces can never satisfy it and the
 * lazy name simply grows past it. A hint is recognised or the text is part of the name; there
 * is no third answer and no guessing.
 *
 * **The `x` must touch the digits, and that is load-bearing.** `4x Shock` is a count and
 * `2 X Marks the Spot` is a card. Allowing whitespace between `\d{1,4}` and `[xX]?` eats that
 * card's first word as a multiplier and imports a card called "Marks the Spot" — silently,
 * because the line still parses and the count still reads 2.
 *
 * What that costs, stated as measured rather than as intended: `4 x Shock` gives
 * `{ quantity: 4, name: "x Shock" }`. The **count is still taken** — only the stray `x`
 * migrates into the name — so the reader gets four copies of a name nothing will resolve,
 * not one copy of `"4 x Shock"`. That is the losing side of the trade and it is a loud
 * failure: an unresolvable name is a row the preview asks about, where "Marks the Spot"
 * would have imported quietly and correctly-looking.
 *
 * **The set may be empty, and that is a real export rather than a tolerance.** `1 Aerith, Last
 * Ancient () 76` is 33 of one reference export's 88 lines: the exporter had a collector number
 * and no set, and wrote the parentheses anyway. `\w{0,10}` reads it, and an empty match is
 * `setCode: null` below. Widening the count to zero cannot cost `Erase (Not the Urza's Legacy
 * One)` its parentheses — the hint is still anchored to the end and a set code still holds no
 * spaces, so a parenthesised *phrase* can never satisfy it.
 *
 * What it costs is honest and worth stating: `resolve_lines` reads a collector number with no
 * set as a hint it cannot use (a number is not unique across sets) and sets `hint_missed`. So
 * such a list previews 33 missed hints where it used to preview 33 unresolved cards.
 */
const LINE =
  /^(?:(?<qty>\d{1,4})[xX]?\s+)?(?<name>.+?)(?:\s+\((?<set>\w{0,10})\)(?:\s+(?<cn>\S+))?)?$/;

/**
 * Trailing decoration that belongs to the exporter rather than to the card: the `*F*`/`*E*`
 * finish markers, an Archidekt `^Label,#colour^`, and a trailing `#tag` (somebody else's
 * hashtag convention, and not this app's label — that one arrives in the caret group).
 *
 * Every one is anchored to the **end** and requires whitespace in front of it. Both halves of
 * that matter: a `#` in the middle of a line is part of a name, and a marker regex that
 * matched anywhere would cut one out of the middle of one.
 *
 * **The `^…^` arm is not the `#` arm widened.** Archidekt writes `^Keeper,#4aab08^`, where the
 * hash follows a comma rather than whitespace, so the `#` arm never saw it and the whole tail
 * stayed inside the card's name. `[^^]*` rather than `\S*` because a label's text has spaces and
 * parentheses in it — `^Fence (flavor),#fa890d^` is one of them.
 *
 * **The bracket is no longer here**, because it is read rather than discarded: see
 * {@link stripDecorations}. The `^…^` arm is still here for {@link FINISH_MARKER}'s reason: it
 * is {@link LABEL_MARKER} that reads one, and this is what takes off a shape that one cannot
 * read.
 */
const MARKERS = [/\s+\*[A-Z]\*$/, /\s+\^[^^]*\^$/, /\s+#\S+$/];

/**
 * Archidekt's label, **read** rather than merely stripped (2026-08-24) — `^Keeper,#4aab08^`.
 *
 * It was thrown away for as long as this app had nowhere to put it. `deck_cards.label_id` is
 * that somewhere, and `deck_labels` has been one app-wide row per name since schema v21, so a
 * label in a file is a label this app can find or make.
 *
 * **The colour is the last comma-separated field, not the second**, and that is the whole of why
 * this is a split rather than a two-group regex. A label's text may itself contain a comma —
 * nothing in Archidekt forbids one, and `Fence (flavor)` shows the field is free text — so
 * `/^(.+),(#.+)$/` would be right by accident and `/^([^,]+),(#.+)$/` wrong on the first label
 * somebody names `Cut, maybe`. Splitting at the **last** comma and checking the tail is a colour
 * is right either way.
 *
 * **A group with no colour in it is still a label.** `^Keeper^` is not a shape any export in
 * scope writes, but a hand-edited list is exactly what this parser exists to keep reading; the
 * name is the half that matters and {@link ParsedLine.labelColor} answering `null` is what the
 * planner reads as "pick a colour for me".
 */
const LABEL_MARKER = /\s+\^([^^]*)\^$/;

/**
 * A colour Archidekt wrote, as `#rrggbb` lowercase, or `null` for a tail that is not one.
 *
 * **Deliberately not `normalizeLabelColor` from `features/decks/labelColors.ts`**, which this
 * could import and must not: that function also reads the six retired palette *tokens*, so a
 * label literally called `gold` would have its own name read as its colour. This is the narrower
 * question — did the exporter write a hex here — and the two answers must not be the same
 * function.
 */
const LABEL_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A `Label colour` **cell**, as `#rrggbb` lowercase, or `null` for anything else.
 *
 * **The `#` is optional here and required in {@link LABEL_COLOR}, and that is not an
 * inconsistency.** Inside `^…^` the hash is what tells the colour from the name — the split is
 * on a comma, and a label really called `Cut, abc` would otherwise have `abc` read as `#aabbcc`
 * and lose half its own name. A dedicated column has nothing to disambiguate from, and a reader
 * typing `4aab08` into a spreadsheet means the colour, so this arm takes it.
 */
function csvLabelColor(raw: string): string | null {
  const found = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (found === null) return null;
  const digits = found[1].toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits}`;
}

/** One `^…^` group, read. `null` when the group was empty — a label with no name is no label. */
function readLabelMarker(inside: string): { name: string; color: string | null } | null {
  const comma = inside.lastIndexOf(",");
  const tail = comma === -1 ? "" : inside.slice(comma + 1).trim();
  const found = LABEL_COLOR.exec(tail);
  const name = (found === null ? inside : inside.slice(0, comma)).trim();
  if (name === "") return null;
  const digits = found === null ? null : found[1].toLowerCase();
  return {
    name,
    // `#f00` and `#ff0000` are the same colour, and `deck_labels.color` holds one shape of it —
    // `labelColors.ts` expands the shorthand exactly this way for exactly this reason.
    color:
      digits === null
        ? null
        : `#${digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits}`,
  };
}

/**
 * The `*F*` / `*E*` marker, **read** rather than merely stripped (2026-08-17).
 *
 * It was thrown away for as long as a deck named a printing and never a finish. Schema v18 gave
 * `deck_cards` a `finish`, so the line has somewhere to put it, and this is the channel every
 * format that says anything about a finish agrees on.
 *
 * The letter is the whole of it: `*F*` is foil and `*E*` is etched, and any other letter is a
 * marker this app does not read — which is why {@link MARKERS} still strips the general shape
 * and this only recognises two. `null` for a line carrying neither, which is the regular copy.
 */
const FINISH_MARKER = /\s+\*([FE])\*$/;

/** A trailing `[…]`, anchored like every {@link MARKERS} pattern. */
const BRACKET = /\s+\[([^\]]+)\]$/;

/**
 * Bracket contents that are a *finish* rather than a pile.
 *
 * Reading one as a category would put a pile called "Foil" in somebody's deck. Matched whole and
 * case-insensitively; anything else in a bracket is a category, because guessing which words are
 * "really" categories is the format detector this file exists without.
 *
 * **It is decoration and not a finish either**, which is the half that stopped being obvious
 * when {@link FINISH_MARKER} started being read (2026-08-17). A bracket is the *category*
 * channel: a finish that arrived there is an exporter being loose with a field, while `*F*` is
 * the channel every format that says anything about a finish agrees on. Reading the bracket
 * would also mean deciding, for every word in it, whether it names a pile or a treatment —
 * which is that same detector one step further in.
 */
const FINISH_WORDS = /^(?:foil|etched|non-?foil)$/i;

/**
 * What ends a line. CRLF first so a Windows paste splits once and not twice.
 *
 * The lone `\r` arm is not decoration: `/\r?\n/` — the obvious spelling — does not treat a
 * carriage return on its own as anything, and `.` inside {@link LINE} does not cross one
 * either. So a CR-only paste used to arrive as **one** row that matched nothing, and the whole
 * decklist came back as a single issue reading "No card name on this line." Measured on
 * `"1 Sol Ring\r2 Shock"`: 0 lines, 1 issue.
 *
 * U+2028 and U+2029 are deliberately **not** here. A decklist comes from a text editor, a
 * site's copy button or a `.txt` file and none of them emit one; handling a separator nobody
 * produces is grammar nobody can check. A paste containing one is still not swallowed — it
 * lands in the empty-name fence below and is quoted back.
 */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * The section a line announces, or `null` if it announces nothing.
 *
 * A trailing `:` and a trailing `(15)` both come off first, because `Sideboard`, `Sideboard:`
 * and `Sideboard (15)` are one heading spelled three ways. The colon comes off first so that
 * `Sideboard (15):` — both at once — is reached by the count strip afterwards.
 */
function sectionFor(line: string): SectionKind | null {
  const word = line
    .replace(/\s*:\s*$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim()
    .toLowerCase();
  return SECTIONS.get(word) ?? null;
}

/** What a line carries besides its card: the text with every decoration peeled off, and the
 *  bracket if it had one. */
interface Decorations {
  body: string;
  /** Verbatim, flags and all — {@link bracketCategory} is what reads it. */
  bracket: string | null;
  /** The `*F*` / `*E*` marker as a finish, or `null` for the regular copy. */
  finish: DeckFinish;
  /** Archidekt's `^Name,#rrggbb^`, read — `null` for a line carrying none. */
  label: { name: string; color: string | null } | null;
}

/**
 * The line with its trailing decoration removed, and its bracket kept.
 *
 * Repeatedly, to a fixed point, because each pattern is anchored to the end and a line can carry
 * three. `1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^` is the case: the
 * label comes off first, which is the only thing that puts the bracket at the end, which is the
 * only thing that puts `*F*` there. The same loop is what `1 Sol Ring *F* #Ramp` has always
 * needed — one pass takes `#Ramp` off the tail and a single pass would import `Sol Ring *F*`.
 *
 * **The first bracket peeled wins**, which is the rightmost one on the line. No export in scope
 * writes two; a line that did would be naming a pile twice and the nearer one is the later word.
 */
function stripDecorations(line: string): Decorations {
  let body = line;
  let bracket: string | null = null;
  let finish: DeckFinish = null;
  let label: { name: string; color: string | null } | null = null;
  for (;;) {
    const before = body;
    const found = BRACKET.exec(body);
    if (found !== null) {
      bracket ??= found[1];
      body = body.slice(0, found.index);
    }
    // Read before the general strip below takes it off, and **first wins** like the bracket —
    // which is the rightmost marker on the line, for the same reason: no export in scope writes
    // two, and a line that did would be naming a finish twice.
    const marked = FINISH_MARKER.exec(body);
    if (marked !== null) finish ??= marked[1] === "F" ? "foil" : "etched";
    // The same discipline one channel over, and the `??=` is doing more work here than it does
    // for the finish: a card can wear several labels in Archidekt and `deck_cards.label_id`
    // holds exactly one, so a line writing two `^…^` groups keeps the **rightmost**, which is
    // the one nearest what it labels. That is a choice rather than a fact about the format, and
    // it is stated here because nothing else in the pipeline can see that a second group existed.
    const labelled = LABEL_MARKER.exec(body);
    if (labelled !== null) label ??= readLabelMarker(labelled[1]);
    for (const marker of MARKERS) body = body.replace(marker, "");
    if (body === before) return { body, bracket, finish, label };
  }
}

/**
 * A bracket's first entry, as a pile name and a flag.
 *
 * **The first entry is the pile.** Verified against a real Archidekt export: in all 105 of its
 * lines the first entry is the heading the line is printed under. The rest are the card's other
 * categories, which this app's grain could hold but an import item cannot name.
 *
 * `{flag}` suffixes come off every entry — `{top}`, `{noDeck}`, `{noPrice}` are Archidekt's, and
 * anything in braces is a flag rather than part of a name. **`{noDeck}` on the first entry is the
 * only one that means anything here**: it says this pile counts toward nothing, which is this
 * app's `is_active = 0`. On a later entry it says only that the card is *also* filed in some
 * maybeboard, and the card is still in the deck.
 */
function bracketCategory(bracket: string): { name: string; excluded: boolean } {
  const first = bracket.split(",")[0] ?? "";
  return {
    name: first.replace(/\{[^}]*\}/g, "").trim(),
    excluded: /\{noDeck\}/i.test(first),
  };
}

/** A count at the head of a line — the strongest signal that a line is a card and not a
 *  heading, and the same shape {@link LINE}'s `qty` group reads. */
const QUANTITY = /^\d{1,4}[xX]?\s/;

/** A trailing `(SET) 123`, `(SET)` or `() 123` — {@link LINE}'s hint, on its own, so a heading
 *  candidate can be refused for carrying one unless the bracket below names it
 *  ({@link bracketPileOf}). */
const HINT_TAIL = /\s+\(\w{0,10}\)(?:\s+\S+)?$/;

/**
 * The pile a line's bracket names, flags off — `null` for a line with no bracket.
 *
 * {@link namesASection} asks this of the line *below* a candidate, and only about a candidate
 * ending in a {@link HINT_TAIL} shape: `Removal (cheap)` is a real pile name and a printing hint
 * at once, and the one thing that tells the two apart is Archidekt printing the same name in the
 * bracket of every card under it (105 of 105 lines of the reference export). **Equality, never
 * mere presence**, because Deckbox and MTGGoldfish write `[SET]` in the same place: a set code
 * holds no parenthesis, so it can never be a hint-shaped line and never admits one.
 */
function bracketPileOf(line: string): string | null {
  const { bracket } = stripDecorations(line);
  return bracket === null ? null : bracketCategory(bracket).name;
}

/**
 * The first row after `index` that makes a claim — not blank, not a comment.
 *
 * `null` at the end of the text, which is one of the things that stops a trailing word being
 * read as a heading over nothing.
 */
function nextClaim(rows: readonly string[], index: number): string | null {
  for (let at = index + 1; at < rows.length; at += 1) {
    const trimmed = rows[at].trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

/**
 * Is this line a section heading whose name is a pile?
 *
 * `Anthem`, `Creature` and `Land` are indistinguishable from card lines to a per-line reader, and
 * a custom category name can be a real card (`Fog`, `Wrath`, `Duress`). This is the one rule in
 * the file that reads past the line in front of it, and each clause pays for itself:
 *
 * * **No quantity, no printing hint, no bracket.** A heading is a bare word; every card line in
 *   an export that writes headings carries at least one of the three. **The hint alone gives way
 *   when the next claim's bracket names this very line** ({@link bracketPileOf}) — a pile called
 *   `Removal (cheap)` ends in a hint shape, and read as a card it left every card under it in
 *   whatever zone came before, the command zone after `Commander`. The count never gives way:
 *   `1 Sol Ring` above a bracketed line is a card, and so — the failure it keeps — is a pile
 *   called `2 Drops`, whose cards reach the deck through their own bracket instead.
 * * **The next line that makes a claim carries a count.** This is what leaves a list of bare
 *   names alone — `Sol Ring` followed by `Arcane Signet` fails it — and it is *also* what makes
 *   a heading over an empty section impossible, which is how "nothing is ever silently dropped"
 *   stays true: a line consumed as a heading always opened at least one card.
 * * **Preceded by a blank line.** Without it `Sol Ring` / `4 Shock` — a hand-written list mixing
 *   bare names with counted ones — loses its first card.
 * * **Or the first line of the file, when that next line carries a bracket.** An Archidekt deck
 *   with no commander opens on a category heading with nothing above it, and Archidekt writes a
 *   bracket on every one of its lines while a hand-written list writes none.
 *
 * **The failure it keeps**, named rather than hidden: a hand-written list with a blank line, then
 * a bare card name, then a counted line, loses that name. No exporter in scope emits that shape.
 */
function namesASection(rows: readonly string[], index: number, trimmed: string): boolean {
  if (QUANTITY.test(trimmed) || trimmed.includes("[")) return false;
  const next = nextClaim(rows, index);
  if (next === null || !QUANTITY.test(next)) return false;
  if (HINT_TAIL.test(trimmed) && bracketPileOf(next) !== trimmed) return false;
  return index === 0 ? next.includes("[") : rows[index - 1].trim() === "";
}

/**
 * A CSV grid into the same lines every other format produces.
 *
 * `extra` carries every recognised column verbatim — including the ones no decklist format has
 * a channel for. The deck planner never looks at it; the collection's reads condition, purchase
 * price and the rest out of it. Keeping them on the line rather than in a second return value is
 * what lets one `ParsedList` serve four destinations.
 */
function parseCsvGrid(
  records: readonly CsvRecord[],
  header: readonly (HeaderCell | null)[],
  delimiter: CsvDelimiter,
): ParsedList {
  const lines: ParsedLine[] = [];
  const issues: ParseIssue[] = [];
  const at = columnsOf(header);
  const hint = setHintColumn(at);

  for (let r = 1; r < records.length; r += 1) {
    const row = records[r].cells;
    // The line the row *starts* on — `r + 1` until issue #555, which was right for every row
    // above the first multi-line cell and short, by every extra line that cell spanned, below it.
    const lineNumber = records[r].line;
    const raw = records[r].raw;
    const cell = (id: TransferFieldId): string => {
      const column = at.get(id);
      return column === undefined ? "" : (row[column] ?? "").trim();
    };

    const name = cell("name");
    if (name === "") {
      // A wholly blank row is a spreadsheet's trailing line, not a claim about a card.
      if (row.every((v) => v.trim() === "")) continue;
      issues.push({ lineNumber, raw, reason: "this row names no card" });
      continue;
    }
    const quantity = csvQuantity(cell("quantity"));
    if (typeof quantity === "string") {
      issues.push({ lineNumber, raw, reason: quantity });
      continue;
    }

    // One value per field — the column `columnsOf` chose — so a Deckbox row's `extra.setCode`
    // is its `Edition Code` and not whichever of its two set columns came first.
    const extra: Partial<Record<TransferFieldId, string>> = {};
    for (const id of at.keys()) {
      const value = cell(id);
      if (value !== "") extra[id] = value;
    }

    const setHint = hint === null ? "" : (row[hint.column] ?? "").trim();
    const categoryCell = cell("category") === "" ? null : cell("category");
    // **A Category cell goes through the same section vocabulary a bracket does** — parse.ts
    // already does exactly this for a bracket's first entry. `Sideboard` names one of the four
    // seeded zones, so it must set the SECTION rather than becoming a category called
    // "Sideboard" that `category_for_name` would then find-or-create by name anyway.
    const knownSection =
      categoryCell === null ? null : (SECTIONS.get(categoryCell.toLowerCase()) ?? null);
    lines.push({
      lineNumber,
      raw,
      quantity,
      name,
      setCode: setHint === "" ? null : hint?.isName === true ? setHint : setHint.toUpperCase(),
      collectorNumber: cell("collectorNumber") === "" ? null : cell("collectorNumber"),
      section: knownSection ?? "deck",
      // Null whenever the section is not `deck` — `ParsedLine`'s stated invariant, and what
      // keeps plan.ts's precedence chain three rungs rather than four. Only a word the section
      // vocabulary has never heard of lands here.
      categoryName: knownSection === null ? categoryCell : null,
      finish: csvFinish(cell("finish")),
      excluded: false,
      // A CSV says a label in two columns where Archidekt says it in one group, because a cell
      // holds one value. Both are read — a column this app writes and cannot read back is a
      // round trip that loses something silently, which is what `decklists.test.ts`' fixed point
      // exists to make impossible.
      labelName: cell("label") === "" ? null : cell("label"),
      labelColor: csvLabelColor(cell("labelColor")),
      extra,
    });
  }
  // `ParsedList` carries five fields, not two. `totalCards` is copies rather than rows,
  // `suggestedName` is Arena's `About` block — a CSV has no such thing and answers null — and
  // `csv` is what the preview says about the columns this read and the ones it did not.
  return {
    lines,
    issues,
    totalCards: lines.reduce((n, l) => n + l.quantity, 0),
    suggestedName: null,
    csv: shapeOf(records[0].cells, header, at, hint, delimiter),
  };
}

/**
 * Read a pasted decklist.
 *
 * Never throws and never returns partial nonsense: every line ends up in `lines`, in
 * `issues`, or was blank or a comment.
 */
export function parseDecklist(text: string): ParsedList {
  // The one file-level judgement this parser makes, and it is made on the header alone: a CSV
  // is detected before any per-line rule runs, and every line after that header is still read
  // by column rather than by the per-line grammar below. Content is not the whole test —
  // `csvShapeAgrees` is what stops a plain line like "Quantity, Name" (two cells off its one
  // comma, both naming a known column) from being mistaken for a header over a file that is not
  // a CSV at all: its next row is one field against the header's two, so the shapes disagree and
  // this falls through to the per-line reader below, exactly as if `csvHeaderOf` had found
  // nothing.
  //
  // `readCsv` measures the separator off the first line, so a semicolon or tab file reaches this
  // test already split into its cells — and a decklist, whose first line carries none of the
  // three or a comma at most, is split on the comma exactly as it always was.
  const { delimiter, records } = readCsv(text);
  const grid = records.map((record) => record.cells);
  const header = grid.length > 0 ? csvHeaderOf(grid[0]) : null;
  if (header !== null && csvShapeAgrees(grid)) return parseCsvGrid(records, header, delimiter);

  // A header this app *nearly* recognises — two or more known columns but no name — is a CSV
  // somebody exported from somewhere else, and reading it line by line would produce one issue
  // per row saying nothing useful. One sentence is the honest answer.
  //
  // Gated on `header === null` rather than reached whenever the CSV arm above did not return: a
  // header whose *content* named a column but whose *shape* disagreed already found a name, and
  // saying "no column names the card" about it would be false. That case falls all the way
  // through to the per-line reader instead, which is what the comment above this one describes.
  if (header === null && grid.length > 0 && nearlyAHeader(grid[0])) {
    return {
      lines: [],
      issues: [
        {
          // The header's own line — line 2 in a file that opens on `sep=,`.
          lineNumber: records[0].line,
          raw: records[0].raw,
          reason: "this looks like a spreadsheet, but no column names the card",
        },
      ],
      totalCards: 0,
      suggestedName: null,
    };
  }

  const lines: ParsedLine[] = [];
  const issues: ParseIssue[] = [];
  let section: SectionKind = "deck";
  let sectionCategory: string | null = null;
  // Whether a bracket under the open heading has named that heading's own zone — Archidekt's
  // `[Commander{top}]` under `Commander`. It is what lets a bracket naming a *pile* move its line
  // out of the zone (see the bracket arm below), and a `[SET]` list never sets it: no set code is
  // a zone word. Cleared by every heading, because it is a fact about the one that is open.
  let zoneBracketed = false;
  let suggestedName: string | null = null;
  let inAbout = false;

  // Stripped from the whole text rather than per line, because that is where a pasted BOM
  // actually is — a file has one, at the front. A per-line strip would be a rule about every
  // line for the sake of the first.
  const rows = text.replace(/^\uFEFF/, "").split(LINE_BREAK);

  // Indexed rather than `rows.entries()` because {@link namesASection} reads the row before the
  // candidate and the rows after it — the one lookahead in this file. `lineNumber` is still
  // `index + 1`, counted over every row including the blanks, because it is what the preview
  // quotes back.
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index];
    const lineNumber = index + 1;
    const trimmed = raw.trim();

    // Skipped whole, and note what is *not* here: a blank line does not end a section.
    // Moxfield separates its commander from its deck with a blank line **and** a header, and
    // a hand-written list uses blank lines decoratively — so treating one as an end would
    // file the deck under whatever came before the paragraph break.
    if (trimmed === "") continue;

    // A comment is `//` **at the start of a line**. `1 Branchloft Pathway // Boulderloft
    // Pathway` is one card and there are seven such names in the reference list alone, so a
    // `//` found anywhere else is part of the name and must never be cut.
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    // Checked before the `About` block below, because a header is how that block ends: Arena
    // writes `About`, `Name …`, then `Deck`, and that `Deck` has to both close the block and
    // switch the section. Reading the block first would swallow it.
    const header = sectionFor(trimmed);
    if (header !== null) {
      section = header;
      sectionCategory = null;
      zoneBracketed = false;
      inAbout = false;
      continue;
    }

    // A heading whose name is not one of the section words is a **pile**, and it puts the reader
    // back in the deck proper: after `Commander`, a `Ramp` heading is not still the command zone.
    if (namesASection(rows, index, trimmed)) {
      section = "deck";
      sectionCategory = trimmed;
      zoneBracketed = false;
      inAbout = false;
      continue;
    }

    if (/^about$/i.test(trimmed)) {
      inAbout = true;
      continue;
    }
    if (inAbout) {
      // The first `Name` wins, so the answer does not depend on how much was pasted after it.
      // Arena writes exactly one; a second is malformed input, and last-wins would let a
      // second list appended to the first quietly rename the deck.
      const named = /^name\s+(.+)$/i.exec(trimmed);
      if (named && suggestedName === null) suggestedName = named[1].trim();
      continue;
    }

    // MTGO's `SB:` is a **one-line** override, not a heading. It travels on the line it marks
    // and can sit anywhere in the file, so consuming it must not move `section`: the next
    // unprefixed line is still whatever the last heading said, not the sideboard.
    let body = trimmed;
    let lineSection = section;
    const sideboardPrefix = /^sb:\s*/i.exec(body);
    if (sideboardPrefix) {
      body = body.slice(sideboardPrefix[0].length);
      lineSection = "sideboard";
    }

    const decorated = stripDecorations(body);
    body = decorated.body;

    // The pile the file named for this line: the open heading, which a bracket then overrides
    // rather than replaces — Archidekt writes both and they agree, and a list that disagreed
    // with itself is naming the pile twice, where the nearer naming is the one on the line. A
    // bracket naming one of the section words is the *section* — `[Commander{top}]` has to reach
    // the command zone through the one mechanism the seeded piles already use — and only an
    // unknown name is a category.
    //
    // **An unknown name is a pile, and a pile is in the deck proper** — the bracket's half of what
    // a pile heading does to `section`. It is what files a card back out of the command zone when
    // the heading above it was missed (a pile called `2 Drops` reads as a card), and it is gated
    // twice. On `zoneBracketed`, because Deckbox and MTGGoldfish write `[SET]` in this place: an
    // ungated rule would move `Sideboard` / `2 Duress [M19]` into the main deck, and a `[SET]` line
    // never names a zone to open the gate. And on the line's own `SB:`, because a zone is a rules
    // fact and a pile is filing — a bracket moves a card out of the *open heading's* zone, never
    // out of one the line names itself.
    let categoryName: string | null = sectionCategory;
    let excluded = false;
    if (decorated.bracket !== null && !FINISH_WORDS.test(decorated.bracket.trim())) {
      const read = bracketCategory(decorated.bracket);
      excluded = read.excluded;
      const known = read.name === "" ? undefined : SECTIONS.get(read.name.toLowerCase());
      if (known !== undefined) {
        lineSection = known;
        if (known === section) zoneBracketed = true;
      } else if (read.name !== "") {
        categoryName = read.name;
        if (zoneBracketed && sideboardPrefix === null) lineSection = "deck";
      }
    }
    // The invariant `ParsedLine.categoryName` documents: a card in one of the four zones is
    // filed by that zone, so a free-form name only ever applies inside the deck proper.
    if (lineSection !== "deck") categoryName = null;

    // `RegExpExecArray["groups"]` types every named group as `string`, optional ones included,
    // and at runtime an unmatched one is `undefined`. Widening here rather than trusting that
    // type is what lets `qty === undefined` mean "no count on this line" — the tempting `!qty`
    // is the same question with a different, wrong answer for `"0"`.
    const groups: Record<string, string | undefined> = LINE.exec(body)?.groups ?? {};
    const name = groups.name?.trim() ?? "";
    if (name === "") {
      // Reachable, and this is the one thing that reaches it: a line terminator `LINE_BREAK`
      // does not split on. `.` never crosses U+2028 or U+2029, so a paste using one arrives
      // as a single row that `LINE` cannot match at all — and this is what quotes the whole
      // text back rather than dropping it. Measured: `"1 Sol Ring\u20282 Shock"` is 0 lines
      // and 1 issue.
      //
      // What does **not** reach it, having been checked rather than assumed: a line of only
      // decoration. Every {@link MARKERS} pattern and {@link BRACKET} needs `\s+` in front of
      // it and `body` is already trimmed, so `stripDecorations` cannot empty a string — `*F*`
      // alone parses as a card named `*F*`, and `[Ramp]` alone as one named `[Ramp]`, both of
      // which resolution refuses. There is no path here through an empty name after a strip.
      issues.push({ lineNumber, raw, reason: "No card name on this line." });
      continue;
    }

    const quantity = groups.qty === undefined ? 1 : Number(groups.qty);
    if (quantity === 0) {
      // Refused rather than corrected, and this is the one line the parser judges. Every other
      // reading here defaults *towards* an import; `0 Shock` is the one where a default would
      // add a card the list explicitly counted to none. Quoted back instead, so the reader
      // decides.
      issues.push({ lineNumber, raw, reason: "A count of zero is not an import." });
      continue;
    }

    lines.push({
      lineNumber,
      raw,
      quantity,
      name,
      // `""` is what an empty `()` matches and it is not a set code. `?? null` alone would put
      // an empty string in the field, which `resolve_lines` trims to absent anyway — but a DTO
      // that says `""` where it means "none" is a field two readers will disagree about.
      setCode: groups.set ? groups.set.toUpperCase() : null,
      collectorNumber: groups.cn ?? null,
      section: lineSection,
      categoryName,
      finish: decorated.finish,
      excluded,
      labelName: decorated.label?.name ?? null,
      labelColor: decorated.label?.color ?? null,
      // A decklist line has no channel for a condition or a purchase price — only a CSV's
      // column reader ever fills this.
      extra: {},
    });
  }

  return {
    lines,
    issues,
    totalCards: lines.reduce((sum, line) => sum + line.quantity, 0),
    suggestedName,
  };
}
