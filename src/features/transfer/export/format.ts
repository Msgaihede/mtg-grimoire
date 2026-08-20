/**
 * A pile of cards as text.
 *
 * The mirror of `../import/parse.ts`, and bound by that file's rules read backwards: **`//` is
 * part of a card name** (`Branchloft Pathway // Boulderloft Pathway` is one card, and seven
 * such names are in the importer's own reference list), so nothing here may cut one; and what
 * this writes has to be something that parser reads, which is what the round-trip test pins.
 *
 * LF and a trailing newline, always. The parser takes CRLF, a lone LF and a lone CR, so it
 * would read any of them — but a file this app wrote should have one answer, and `\n` is the
 * one every other tool in this space emits.
 *
 * **A format is a whole file rather than a row of lines**, which is why there is no
 * `Record<ExportFormat, (card) => string>` here any more: three of them write *headings* as
 * well as lines, and two of those decide which headings exist by grouping the input. What is
 * left of that record is the per-line writers — {@link plainLine}, {@link printedLine},
 * {@link archidektLine}, {@link tcgplayerLine} — assembled by {@link formatExport}'s one switch,
 * which is also the only place that knows a format writes sections at all.
 *
 * An empty list is an empty string in every format, **CSV included**. A header row over no
 * rows is a file that claims to be a decklist and is not one. **That now covers a list a
 * format empties for itself**: Arena and MTGO write only switched-on piles, so a deck that is
 * entirely maybeboard is an empty file in those two rather than a heading over nothing —
 * {@link omittedCount} is what says so out loud.
 */
import type { CategoryKind, DeckCard } from "@/lib/ipc";
import type { ExportFormat } from "../formats";

export {
  EXPORT_FORMATS,
  EXPORT_FORMAT_LABEL,
  EXPORT_FORMAT_EXTENSION,
  type ExportFormat,
} from "../formats";

/**
 * What a card needs to be exported — a `Pick` of `DeckCard`, so a whole one satisfies it.
 *
 * The three category fields are what a *deck* export needs and a category export never did: a
 * pile has one name, one kind and one switch, so a single-pile caller passes rows that all agree
 * and every grouped format writes it as one section.
 */
export type ExportCard = Pick<
  DeckCard,
  | "name"
  | "quantity"
  | "setCode"
  | "collectorNumber"
  | "categoryName"
  | "categoryKind"
  | "categoryActive"
  | "finish"
>;

/** The maybeboard's heading, spelled once — it is `SECTION_CATEGORY.maybeboard`'s word read
 *  backwards, and the importer's `SECTIONS` map is what reads it. */
const MAYBEBOARD = "Maybeboard";

/**
 * What a kind is called in a format whose section vocabulary is fixed.
 *
 * **Total over {@link CategoryKind}, with no arm for `maybe` in the sense the word suggests** —
 * nothing anywhere may branch on a kind being `maybe`, and this does not: a pile whose kind is
 * `maybe` but which the reader has switched **on** counts toward the deck like any other, so it
 * writes under `Deck`. {@link sectionOf} is where a switched-*off* pile becomes a maybeboard, and
 * it asks `categoryActive` rather than the kind, which is the whole of what `is_active = 0`
 * means. Rewriting this entry to `Maybeboard` "because that is what it is called" is the bug
 * that rule exists to keep out — it would file a switched-on Maybeboard out of the deck it
 * counts toward, and leave a reader's own switched-off `Ramp` under `Deck` beside it.
 */
const KIND_SECTION: Record<CategoryKind, string> = {
  commander: "Commander",
  companion: "Companion",
  main: "Deck",
  side: "Sideboard",
  maybe: "Deck",
};

/**
 * The order sections come out in.
 *
 * **Deliberately not `sortOptions` — one of the exceptions `lib/options.ts` names, the kind
 * whose order *is* the information.** It is the order a decklist is read in, from the zone the
 * game starts with down to the cards that are not in the deck at all; alphabetically it would
 * open on `Commander`, then `Companion`, `Deck`, `Maybeboard`, `Sideboard`, which puts the cards
 * that count toward nothing in the middle of the ones that do.
 */
const SECTION_ORDER: readonly string[] = [
  "Commander",
  "Companion",
  "Deck",
  "Sideboard",
  MAYBEBOARD,
];

/** The section a card writes under in a fixed-vocabulary format. */
function sectionOf(card: ExportCard): string {
  return card.categoryActive ? KIND_SECTION[card.categoryKind] : MAYBEBOARD;
}

/**
 * The formats with no maybeboard, which therefore write **only** the piles that are switched on.
 *
 * One set rather than the same two-name test written at each of its two readers: {@link written}
 * and {@link omittedCount} are the two halves of one rule — what is left out, and how much of it
 * — and a drift between them is a number on screen that quietly stops describing the file.
 *
 * The test is `categoryActive` and never the kind: `is_active = 0` is the whole of what a
 * maybeboard is, and a reader's own switched-off pile behaves the same way.
 */
const ACTIVE_ONLY: ReadonlySet<ExportFormat> = new Set<ExportFormat>(["arena", "mtgo"]);

/**
 * A CSV field, quoted when it carries a comma, a quote or a newline — and never otherwise, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 * An inner quote doubles, which is the escape RFC 4180 (and every spreadsheet reading this
 * file) agrees on.
 */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const CSV_HEADER = "Quantity,Name,Set,Collector number,Category,Finish";

/**
 * The `*F*` / `*E*` marker a line ends with, or `""` for the regular copy.
 *
 * The one thing every text format here can say about a finish, and the channel `parse.ts` reads
 * back — a leading space included, so a caller appends it and nothing has to remember not to
 * emit a trailing one on a plain row.
 *
 * **Not written by `arena` or `mtgo`**, which have no marker in the format; the finish is lost
 * on a round trip through either, which is the same thing already true of a category there.
 */
function finishMark(card: ExportCard): string {
  if (card.finish === "foil") return " *F*";
  if (card.finish === "etched") return " *E*";
  return "";
}

/** `quantity name`, with nothing about the printing — the shape a plain paste and MTGO share.
 *  MTGO adds no finish mark; see {@link finishMark}. */
function plainLine(card: ExportCard): string {
  return `${card.quantity} ${card.name}`;
}

/**
 * `quantity name (SET) collectorNumber` — the shape Moxfield and Arena share, and the one that
 * names a printing rather than just a card. The set code is uppercased for the same reason the
 * importer uppercases the one it reads: `(ltc)` and `(LTC)` are the same set and a decklist
 * should pick one spelling rather than echo whatever case this row happened to store.
 */
function printedLine(card: ExportCard): string {
  return `${card.quantity} ${card.name} (${card.setCode.toUpperCase()}) ${card.collectorNumber}`;
}

/** {@link printedLine} with the finish marker — Moxfield's shape. Arena shares the line and not
 *  the marker, which is why the two formats no longer share one writer. */
function moxfieldLine(card: ExportCard): string {
  return printedLine(card) + finishMark(card);
}

/**
 * Archidekt's line: `1x`, a **lowercase** set code, and the pile in brackets.
 *
 * Lowercase against every other writer here on purpose — it is what Archidekt itself emits, and
 * the point of a format named for a site is that the site reads it back. Our own parser
 * uppercases what it reads, so the round trip is unaffected either way.
 *
 * `{noDeck}` on a switched-off pile is what makes an export and a re-import keep a maybeboard.
 * It is the only format here that can say it — which is why Archidekt is the one format that
 * writes an inactive pile *and* leaves nothing out.
 */
function archidektLine(card: ExportCard): string {
  const flag = card.categoryActive ? "" : "{noDeck}";
  const set = card.setCode.toLowerCase();
  // The marker goes **after** the bracket, which is where `stripDecorations` peels it from: its
  // loop takes the bracket off first and that is the only thing that puts `*F*` at the end.
  // Writing it before the bracket would still round-trip — the loop runs to a fixed point — but
  // it would not be the shape this app's own parser documents, and a file this app wrote should
  // be the canonical one.
  return `${card.quantity}x ${card.name} (${set}) ${card.collectorNumber} [${card.categoryName}${flag}]${finishMark(card)}`;
}

/**
 * TCGplayer Mass Entry's line: `2 Lightning Bolt [2X2] 117`.
 *
 * **A cart rather than a decklist, which decides all three of the ways it differs from the
 * writers above it.** Mass Entry reads every line as one item and has no section vocabulary at
 * all, so this format writes a flat list — a heading would be read as a card nobody sells. It
 * therefore has nowhere to put a maybeboard either, and unlike Arena and MTGO it does not *lose*
 * one: a switched-off pile is usually the half a reader still has to buy, so every row is
 * written and {@link omittedCount} stays 0 here. And there is no finish marker, because a
 * printing's foil is chosen in the cart rather than named in the text.
 *
 * The set code goes in **square brackets** and the collector number bare after it — the most
 * specific of the three shapes TCGplayer documents, so the cart lands on the printing the deck
 * names rather than on whatever art is cheapest. Uppercased for `printedLine`'s reason: `[2x2]`
 * and `[2X2]` are the same set and a file this app writes should pick one spelling.
 *
 * **Write-only, and the second such format after CSV** — verified against `parse.ts` rather than
 * assumed. Our own `BRACKET` is anchored to the end of the line, so a bracket with a collector
 * number after it is not a bracket to that parser at all, and the whole tail lands in the name:
 * `2 Lightning Bolt [2X2] 117` comes back as a card *called* `Lightning Bolt [2X2] 117`. The
 * copies survive and the name does not, which is why `decklists.test.ts` excludes this format
 * from the round trip by name beside CSV rather than leaving it to fail there.
 */
function tcgplayerLine(card: ExportCard): string {
  return `${card.quantity} ${card.name} [${card.setCode.toUpperCase()}] ${card.collectorNumber}`;
}

/**
 * The cards a format will not write, in **copies**.
 *
 * Only `arena` and `mtgo` leave anything out, and only a pile the reader has switched off:
 * neither format has a maybeboard, and writing one into an Arena deck produces an illegal import
 * at the other end. The dialog draws this number, so the omission is never silent.
 *
 * Copies rather than rows because that is the sentence the reader is owed — six basic lands on
 * one row are six cards missing from the file, and "1 card" would be a true statement about the
 * array and a false one about the deck.
 */
export function omittedCount(cards: readonly ExportCard[], format: ExportFormat): number {
  if (!ACTIVE_ONLY.has(format)) return 0;
  return cards.reduce((n, card) => (card.categoryActive ? n : n + card.quantity), 0);
}

/** The cards a format writes, in the caller's own order. */
function written(cards: readonly ExportCard[], format: ExportFormat): readonly ExportCard[] {
  if (!ACTIVE_ONLY.has(format)) return cards;
  return cards.filter((card) => card.categoryActive);
}

/**
 * Cards under headings: one group per key, **in first-appearance order** unless an order is
 * given.
 *
 * First appearance is what keeps this file pure — the caller's array order is the file's order,
 * so a deck's own category order needs no second argument and no `DeckCategory` here.
 */
function grouped(
  cards: readonly ExportCard[],
  keyOf: (card: ExportCard) => string,
  order?: readonly string[],
): [string, ExportCard[]][] {
  const groups = new Map<string, ExportCard[]>();
  for (const card of cards) {
    const key = keyOf(card);
    const existing = groups.get(key);
    if (existing) existing.push(card);
    else groups.set(key, [card]);
  }
  const entries = [...groups];
  if (order === undefined) return entries;
  return entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

/** Sections joined the way every export in scope writes them: a heading, its lines, a blank. */
function sections(groups: [string, ExportCard[]][], write: (card: ExportCard) => string): string {
  return groups.map(([name, cards]) => [name, ...cards.map(write)].join("\n")).join("\n\n");
}

/**
 * Render a pile of cards as decklist text in one of {@link EXPORT_FORMATS}.
 *
 * An empty list is `""` in every format, CSV's header included — a header with nothing under
 * it is a file that claims to be a decklist and is not one. **A list a format empties for
 * itself answers the same way**: the filter runs first, so an Arena export of a deck that is
 * entirely maybeboard is `""` rather than a `Deck` heading over nothing. Every non-empty result
 * ends in a single trailing `\n`.
 */
export function formatExport(cards: readonly ExportCard[], format: ExportFormat): string {
  const rows = written(cards, format);
  if (rows.length === 0) return "";

  let text: string;
  switch (format) {
    case "plain":
      text = rows.map((card) => plainLine(card) + finishMark(card)).join("\n");
      break;
    case "mtgo":
      // MTGO's own export omits the printing entirely — it resolves a name against whatever
      // copies a player owns rather than pinning one, so naming a set here would be a promise
      // this format was never in a position to keep. `SB:` is a one-line override rather than a
      // heading, which is exactly how the importer reads it back.
      text = rows
        .map((card) => {
          const section = sectionOf(card);
          const prefix = section === "Sideboard" || section === "Companion" ? "SB: " : "";
          return prefix + plainLine(card);
        })
        .join("\n");
      break;
    case "arena":
      // Arena's line is `printedLine` and nothing else: the format has no finish marker, so a
      // foil row exports plain and comes back plain. `written` has already taken the
      // switched-off piles out, so a `Maybeboard` section can never be produced here.
      text = sections(grouped(rows, sectionOf, SECTION_ORDER), printedLine);
      break;
    case "moxfield":
      // Arena's headings and lines **plus the finish marker**, which is the whole of what
      // separates the two arms — they shared one until 2026-08-17, and the split is the price of
      // Arena not having a marker rather than a difference anybody wanted.
      text = sections(grouped(rows, sectionOf, SECTION_ORDER), moxfieldLine);
      break;
    case "archidekt":
      // Grouped by the pile's own name rather than by a section word, because this is one of the
      // two formats with somewhere to put it. No order argument: the caller's array order is a
      // deck's category order, and imposing one here would re-file somebody's deck on the way
      // out.
      text = sections(
        grouped(rows, (card) => card.categoryName),
        archidektLine,
      );
      break;
    case "tcgplayer":
      // Flat, and grouped by nothing: Mass Entry reads every line as one item, so a heading here
      // would be read as a card. `written` has left the switched-off piles in — see the writer.
      text = rows.map(tcgplayerLine).join("\n");
      break;
    case "csv":
      text = [
        CSV_HEADER,
        ...rows.map((card) =>
          [
            String(card.quantity),
            csvField(card.name),
            csvField(card.setCode),
            csvField(card.collectorNumber),
            csvField(card.categoryName),
            // A column rather than a marker, because CSV has somewhere to put it — and the
            // word rather than the letter, since nothing reads this back (`decklists.test.ts`
            // excludes `csv` by name) and a column a person opens in a spreadsheet should say
            // `foil`. Empty for the regular copy, which is what an empty cell means.
            csvField(card.finish ?? ""),
          ].join(","),
        ),
      ].join("\n");
      break;
  }
  return text + "\n";
}
